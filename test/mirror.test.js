'use strict';
// Protocol-level tests for the Cast Streaming (mirroring) implementation. Runs in
// plain Node (no Electron): wire-format round-trips, the VP8/IVF capture pipeline,
// and a loopback UDP "receiver" that exercises ACK pruning, NACK retransmission
// and PLI signalling end to end. Run: node test/mirror.test.js
const assert = require('assert');
const crypto = require('crypto');
const dgram = require('dgram');
const { spawn } = require('child_process');
const p = require('../src/main/mirror/protocol');
const { MirrorSender } = require('../src/main/mirror/sender');
const { WebmVp8Demuxer } = require('../src/main/mirror/webm');
const ff = require('../src/main/ffmpeg');

const results = [];
function record(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { results.push([name, true]); console.log(`PASS ${name}`); },
    (err) => { results.push([name, false]); console.log(`FAIL ${name} :: ${err.message}`); }
  );
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reassembles Cast RTP packets back into decrypted frames, like a receiver would.
function makeCollector(aesKey, aesIvMask) {
  const frames = new Map();  // frameId8 -> { parts: Map(packetId -> payload), maxPacketId, key, rtpTimestamp }
  return {
    frames,
    push(buf) {
      const pkt = p.parseRtpPacket(buf);
      if (!pkt) return null;
      let f = frames.get(pkt.frameId8);
      if (!f) { f = { parts: new Map(), maxPacketId: pkt.maxPacketId, key: pkt.key, rtpTimestamp: pkt.rtpTimestamp }; frames.set(pkt.frameId8, f); }
      f.parts.set(pkt.packetId, pkt.payload);
      return pkt;
    },
    complete(frameId8) {
      const f = frames.get(frameId8);
      if (!f || f.parts.size !== f.maxPacketId + 1) return null;
      const cipher = Buffer.concat([...Array(f.maxPacketId + 1).keys()].map((i) => f.parts.get(i)));
      return { ...f, data: p.decryptFrame(aesKey, aesIvMask, frameId8, cipher) };
    },
  };
}

async function main() {
  // 1: RTP packetization + AES-CTR round trip
  await record('rtp packetize/parse/decrypt round trip', () => {
    const aesKey = crypto.randomBytes(16), ivMask = crypto.randomBytes(16);
    const data = crypto.randomBytes(40000);
    const cipher = p.encryptFrame(aesKey, ivMask, 7, data);
    assert.notStrictEqual(cipher.compare(data), 0);
    const pk = new p.RtpPacketizer(p.VIDEO_PAYLOAD_TYPE, 60001);
    const frame = { cipher, frameId: 7, refFrameId: 7, key: true, rtpTimestamp: 123456 };
    const n = p.packetCountFor(cipher.length);
    assert.strictEqual(n, Math.ceil(40000 / p.MAX_PAYLOAD));
    const col = makeCollector(aesKey, ivMask);
    let prevSeq = null;
    for (let i = 0; i < n; i++) {
      const buf = pk.buildPacket(frame, i);
      assert.ok(buf.length <= p.MAX_PACKET_SIZE);
      const pkt = col.push(buf);
      assert.strictEqual(pkt.payloadType, 96);
      assert.strictEqual(pkt.ssrc, 60001);
      assert.strictEqual(pkt.frameId8, 7);
      assert.strictEqual(pkt.refFrameId8, 7);
      assert.strictEqual(pkt.key, true);
      assert.strictEqual(pkt.packetId, i);
      assert.strictEqual(pkt.maxPacketId, n - 1);
      assert.strictEqual(pkt.last, i === n - 1);
      assert.strictEqual(pkt.rtpTimestamp, 123456);
      if (prevSeq != null) assert.strictEqual(pkt.seq, (prevSeq + 1) & 0xffff);
      prevSeq = pkt.seq;
    }
    const out = col.complete(7);
    assert.ok(out, 'frame did not reassemble');
    assert.strictEqual(out.data.compare(data), 0, 'decrypted frame differs');
  });

  // 2: RTCP sender report + feedback + expansion
  await record('rtcp build/parse and frame id expansion', () => {
    const sr = p.buildSenderReport({ ssrc: 60001, rtpTimestamp: 999, packetCount: 5, octetCount: 100 });
    assert.strictEqual(sr.length, 28);
    assert.strictEqual(sr[1], 200);
    assert.strictEqual(sr.readUInt32BE(4), 60001);
    assert.strictEqual(sr.readUInt32BE(16), 999);
    const ntpSec = sr.readUInt32BE(8) - 2208988800;
    assert.ok(Math.abs(ntpSec - Date.now() / 1000) < 5, 'NTP seconds off');

    const fb = p.buildFeedback({
      receiverSsrc: 123, senderSsrc: 60001, checkpoint8: 9, playoutDelayMs: 400,
      losses: [{ frameId8: 11, packetId: 3, bitmask: 0b101 }, { frameId8: 12, packetId: 0xffff, bitmask: 0 }],
    });
    const parsed = p.parseRtcp(fb);
    assert.ok(parsed.feedback);
    assert.strictEqual(parsed.feedback.checkpoint8, 9);
    assert.strictEqual(parsed.feedback.playoutDelayMs, 400);
    assert.strictEqual(parsed.feedback.losses.length, 2);
    assert.deepStrictEqual(parsed.feedback.losses[0], { frameId8: 11, packetId: 3, bitmask: 5 });

    // PLI packet (pt 206, subtype 1)
    const pli = Buffer.alloc(12);
    pli[0] = 0x81; pli[1] = 206; pli.writeUInt16BE(2, 2);
    assert.strictEqual(p.parseRtcp(pli).pli, true);

    // compound: receiver report then feedback still parses
    const rr = Buffer.alloc(8); rr[0] = 0x80; rr[1] = 201; rr.writeUInt16BE(1, 2);
    assert.ok(p.parseRtcp(Buffer.concat([rr, fb])).feedback);

    assert.strictEqual(p.expandFrameId(0x05, 0x105), 0x105);
    assert.strictEqual(p.expandFrameId(0x05, 0x1ff), 0x205);
    assert.strictEqual(p.expandFrameId(0xff, 0x200), 0x1ff);
    assert.strictEqual(p.expandFrameIdAbove(0x05, 0x105), 0x205);
    assert.strictEqual(p.expandFrameIdAbove(0x06, 0x105), 0x106);
  });

  // 3: VP8/IVF pipeline from the real encoder
  await record('vp8 ivf capture pipeline', async () => {
    const frames = [];
    const parser = new p.IvfParser((f) => frames.push(f));
    await new Promise((resolve, reject) => {
      const child = spawn(ff.ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30', '-t', '2',
        '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-lag-in-frames', '0',
        '-b:v', '1000k', '-g', '30', '-pix_fmt', 'yuv420p', '-f', 'ivf', 'pipe:1'], { windowsHide: true });
      child.stdout.on('data', (b) => { try { parser.push(b); } catch (e) { reject(e); } });
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code))));
      child.on('error', reject);
    });
    assert.ok(frames.length >= 50, `only ${frames.length} frames`);
    assert.strictEqual(parser.header.fourcc, 'VP80');
    assert.strictEqual(parser.header.width, 640);
    assert.ok(frames[0].key, 'first frame not a keyframe');
    assert.ok(frames.filter((f) => f.key).length >= 2, 'expected periodic keyframes');
    assert.ok(!frames[1].key, 'second frame should be a delta');
    const last = frames[frames.length - 1];
    assert.ok(last.seconds > 1.5 && last.seconds < 2.5, `bad timestamps: ${last.seconds}s`);
  });

  // 4: loopback sender <-> fake receiver (ACK prune, NACK retransmit, PLI)
  await record('loopback sender: ack, nack retransmit, pli', async () => {
    const aesKey = crypto.randomBytes(16), ivMask = crypto.randomBytes(16);
    const col = makeCollector(aesKey, ivMask);
    const rtcpSeen = [];
    let senderAddr = null;
    const receiver = dgram.createSocket('udp4');
    const received = [];
    receiver.on('message', (msg, rinfo) => {
      senderAddr = rinfo;
      if (msg.length >= 2 && (msg[1] === 200 || msg[1] === 201)) { rtcpSeen.push(msg[1]); return; }
      const pkt = col.push(msg);
      if (pkt) received.push(pkt);
    });
    await new Promise((r) => receiver.bind(0, r));
    const port = receiver.address().port;

    const sender = new MirrorSender({ host: '127.0.0.1', port, ssrc: 60002, receiverSsrc: 123, aesKey, aesIvMask: ivMask, log: () => {} });
    let gotPli = false;
    sender.on('pli', () => { gotPli = true; });
    await sender.start();

    const frameA = crypto.randomBytes(30000);
    sender.sendFrame(frameA, true, 0);
    sender.sendFrame(crypto.randomBytes(20000), false, 3000);
    await sleep(300);
    assert.ok(rtcpSeen.includes(200), 'no sender report seen');
    assert.ok(col.complete(0), 'frame 0 incomplete');
    assert.ok(col.complete(1), 'frame 1 incomplete');
    assert.strictEqual(col.complete(0).data.compare(frameA), 0, 'frame 0 corrupt');
    assert.strictEqual(sender.frames.size, 2);

    // ACK frame 0 via checkpoint; sender must prune it.
    const sendRtcp = (buf) => receiver.send(buf, senderAddr.port, senderAddr.address);
    sendRtcp(p.buildFeedback({ receiverSsrc: 123, senderSsrc: 60002, checkpoint8: 0 }));
    await sleep(200);
    assert.strictEqual(sender.checkpoint, 0, 'checkpoint not advanced');
    assert.ok(!sender.frames.has(0), 'acked frame not pruned');

    // NACK packet 2 of frame 1: a retransmit (same packetId, fresh seq) must arrive.
    const before = received.filter((x) => x.frameId8 === 1 && x.packetId === 2).length;
    sendRtcp(p.buildFeedback({ receiverSsrc: 123, senderSsrc: 60002, checkpoint8: 0, losses: [{ frameId8: 1, packetId: 2, bitmask: 0 }] }));
    await sleep(300);
    const after = received.filter((x) => x.frameId8 === 1 && x.packetId === 2).length;
    assert.ok(after > before, 'no retransmission observed');

    // Whole-frame NACK
    const wholeBefore = received.filter((x) => x.frameId8 === 1).length;
    sendRtcp(p.buildFeedback({ receiverSsrc: 123, senderSsrc: 60002, checkpoint8: 0, losses: [{ frameId8: 1, packetId: 0xffff, bitmask: 0 }] }));
    await sleep(300);
    assert.ok(received.filter((x) => x.frameId8 === 1).length >= wholeBefore + p.packetCountFor(sender.frames.get(1).cipher.length), 'whole-frame retransmit missing');

    // PLI
    const pli = Buffer.alloc(12); pli[0] = 0x81; pli[1] = 206; pli.writeUInt16BE(2, 2);
    pli.writeUInt32BE(123, 4); pli.writeUInt32BE(60002, 8);
    sendRtcp(pli);
    await sleep(200);
    assert.ok(gotPli, 'pli not surfaced');

    sender.stop();
    receiver.close();
  });

  // 5: WebM VP8 demuxer against real (piped, streaming-mode) encoder output
  await record('webm vp8 demuxer + reset detection', async () => {
    const chunks = [];
    await new Promise((resolve, reject) => {
      const child = spawn(ff.ffmpegPath, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30', '-t', '2',
        '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-lag-in-frames', '0',
        '-b:v', '500k', '-g', '30', '-pix_fmt', 'yuv420p', '-f', 'webm', 'pipe:1'], { windowsHide: true });
      child.stdout.on('data', (b) => chunks.push(Buffer.from(b)));
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error('ffmpeg exit ' + code))));
      child.on('error', reject);
    });
    const frames = [];
    let resets = 0;
    const d = new WebmVp8Demuxer((f) => frames.push(f), () => resets++);
    for (const c of chunks) d.push(c);           // incremental, chunk by chunk
    assert.ok(frames.length >= 50, `only ${frames.length} frames`);
    assert.ok(frames[0].key, 'first frame not key');
    assert.ok(!frames[1].key, 'second frame should be delta');
    assert.ok(frames.filter((f) => f.key).length >= 2, 'expected periodic keyframes');
    const last = frames[frames.length - 1];
    assert.ok(last.timeMs > 1500 && last.timeMs < 2500, `bad timestamps: ${last.timeMs}ms`);
    for (let i = 1; i < frames.length; i++) assert.ok(frames[i].timeMs >= frames[i - 1].timeMs, 'timestamps not monotonic');
    // A second stream on the same demuxer (renderer restarted its recorder) must reset cleanly.
    const count = frames.length;
    for (const c of chunks) d.push(c);
    assert.strictEqual(resets, 1, 'reset not detected');
    assert.ok(frames.length >= count * 2 - 2, 'second stream did not demux');
  });

  // 6: offer shape sanity
  await record('offer message shape', () => {
    const offer = p.buildVideoOffer({ ssrc: 60003, aesKey: Buffer.alloc(16, 1), aesIvMask: Buffer.alloc(16, 2), fps: 30, maxBitRate: 4000000, width: 1024, height: 576 });
    assert.strictEqual(offer.castMode, 'mirroring');
    const st = offer.supportedStreams[0];
    assert.strictEqual(st.type, 'video_source');
    assert.strictEqual(st.codecName, 'vp8');
    assert.strictEqual(st.rtpPayloadType, 96);
    assert.strictEqual(st.rtpProfile, 'cast');
    assert.strictEqual(st.aesKey.length, 32);
    assert.strictEqual(st.timeBase, '1/90000');
    assert.deepStrictEqual(st.resolutions, [{ width: 1024, height: 576 }]);
  });

  const failed = results.filter(([, ok]) => !ok);
  console.log(`---- ${results.length - failed.length}/${results.length} passed ----`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
