'use strict';
// Google Cast Streaming ("mirroring") protocol primitives, ported from Chromium's
// open-source openscreen library (cast/streaming): the Cast RTP packet format,
// AES-128-CTR frame encryption, RTCP sender reports, Cast Feedback (ACK/NACK)
// parsing, OFFER message construction, and an IVF (VP8) stream parser.
const crypto = require('crypto');

const APP_ID = '0F5096E8';                       // Chrome Mirroring receiver app
const WEBRTC_NS = 'urn:x-cast:com.google.cast.webrtc';
const RTP_VIDEO_TIMEBASE = 90000;
const MAX_PACKET_SIZE = 1472;                    // Ethernet MTU 1500 - IPv4 20 - UDP 8
const BASE_RTP_HEADER = 19;                      // 12 RTP + 7 Cast (ref frame id always sent)
const MAX_PAYLOAD = MAX_PACKET_SIZE - (BASE_RTP_HEADER + 4);  // reserve adaptive-latency space
const VIDEO_PAYLOAD_TYPE = 96;                   // Android TV receivers require 96 for video
const MAX_UNACKED_FRAMES = 120;                  // frame ids are 8-bit truncated on the wire
const ALL_PACKETS_LOST = 0xffff;
const NTP_EPOCH_DELTA = 2208988800;              // seconds from NTP epoch (1900) to unix epoch
const RTCP_REPORT_INTERVAL_MS = 500;
const DEFAULT_TARGET_DELAY_MS = 400;

// ---- OFFER -------------------------------------------------------------------------------

// Video-only mirroring offer, mirroring openscreen's Offer/Stream::ToJson().
function buildVideoOffer({ ssrc, aesKey, aesIvMask, fps, maxBitRate, width, height, targetDelay }) {
  return {
    castMode: 'mirroring',
    supportedStreams: [{
      index: 0,
      type: 'video_source',
      channels: 1,
      codecName: 'vp8',
      rtpProfile: 'cast',
      rtpPayloadType: VIDEO_PAYLOAD_TYPE,
      ssrc,
      targetDelay: targetDelay || DEFAULT_TARGET_DELAY_MS,
      aesKey: aesKey.toString('hex'),
      aesIvMask: aesIvMask.toString('hex'),
      receiverRtcpEventLog: false,
      timeBase: '1/' + RTP_VIDEO_TIMEBASE,
      codecParameter: '',
      maxFrameRate: String(fps),
      maxBitRate,
      protection: '',
      profile: '',
      level: '',
      errorRecoveryMode: '',
      resolutions: [{ width, height }],
    }],
  };
}

// ---- frame crypto ------------------------------------------------------------------------

// AES-128-CTR whole-frame encryption. The nonce is the frame id (lower 32 bits,
// big-endian at offset 8) XORed into the 16-byte IV mask from the OFFER.
function encryptFrame(aesKey, aesIvMask, frameId, data) {
  const iv = Buffer.from(aesIvMask);
  iv[8] ^= (frameId >>> 24) & 0xff;
  iv[9] ^= (frameId >>> 16) & 0xff;
  iv[10] ^= (frameId >>> 8) & 0xff;
  iv[11] ^= frameId & 0xff;
  const cipher = crypto.createCipheriv('aes-128-ctr', aesKey, iv);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}
const decryptFrame = encryptFrame;  // CTR mode is symmetric

// ---- RTP packetization -------------------------------------------------------------------

function packetCountFor(cipherLength) {
  return Math.max(1, Math.ceil(cipherLength / MAX_PAYLOAD));
}

// Stateful packetizer: sequence numbers increment on every generated packet,
// including retransmits, per the RTP spec.
class RtpPacketizer {
  constructor(payloadType, ssrc) {
    this.payloadType = payloadType & 0x7f;
    this.ssrc = ssrc >>> 0;
    this.seq = crypto.randomBytes(2).readUInt16BE(0);
  }

  // frame: { cipher, frameId, refFrameId, key, rtpTimestamp }
  buildPacket(frame, packetId) {
    const numPackets = packetCountFor(frame.cipher.length);
    const last = packetId === numPackets - 1;
    const start = packetId * MAX_PAYLOAD;
    const chunk = frame.cipher.subarray(start, last ? frame.cipher.length : start + MAX_PAYLOAD);
    const buf = Buffer.allocUnsafe(BASE_RTP_HEADER + chunk.length);
    buf[0] = 0x80;                                            // V=2, no padding/ext/CSRC
    buf[1] = (last ? 0x80 : 0) | this.payloadType;            // marker on last packet
    buf.writeUInt16BE(this.seq, 2);
    this.seq = (this.seq + 1) & 0xffff;
    buf.writeUInt32BE(frame.rtpTimestamp >>> 0, 4);
    buf.writeUInt32BE(this.ssrc, 8);
    buf[12] = (frame.key ? 0x80 : 0) | 0x40;                  // key | has-ref-frame-id, 0 exts
    buf[13] = frame.frameId & 0xff;
    buf.writeUInt16BE(packetId, 14);
    buf.writeUInt16BE(numPackets - 1, 16);
    buf[18] = frame.refFrameId & 0xff;
    chunk.copy(buf, BASE_RTP_HEADER);
    return buf;
  }
}

// Parse one Cast RTP packet (used by tests / loopback verification).
function parseRtpPacket(buf) {
  if (buf.length < BASE_RTP_HEADER || buf[0] !== 0x80) return null;
  return {
    last: !!(buf[1] & 0x80),
    payloadType: buf[1] & 0x7f,
    seq: buf.readUInt16BE(2),
    rtpTimestamp: buf.readUInt32BE(4),
    ssrc: buf.readUInt32BE(8),
    key: !!(buf[12] & 0x80),
    frameId8: buf[13],
    packetId: buf.readUInt16BE(14),
    maxPacketId: buf.readUInt16BE(16),
    refFrameId8: buf[18],
    payload: buf.subarray(19),
  };
}

// ---- frame id expansion ------------------------------------------------------------------

// Frame ids travel truncated to 8 bits; expand to the full value closest to `reference`.
function expandFrameId(truncated, reference) {
  let v = (reference & ~0xff) | (truncated & 0xff);
  if (v > reference + 128) v -= 256;
  else if (v < reference - 127) v += 256;
  return v;
}

// Loss-field frame ids must always expand to a value greater than the checkpoint.
function expandFrameIdAbove(truncated, above) {
  let v = (above & ~0xff) | (truncated & 0xff);
  while (v <= above) v += 256;
  return v;
}

// ---- RTCP --------------------------------------------------------------------------------

function ntpNow() {
  const ms = Date.now();
  const sec = Math.floor(ms / 1000) + NTP_EPOCH_DELTA;
  const frac = Math.round(((ms % 1000) / 1000) * 0x100000000);
  return { sec: sec >>> 0, frac: frac >>> 0 };
}

// RTCP Sender Report (no report blocks): 28 bytes.
function buildSenderReport({ ssrc, rtpTimestamp, packetCount, octetCount }) {
  const buf = Buffer.allocUnsafe(28);
  buf[0] = 0x80;                       // V=2, P=0, RC=0
  buf[1] = 200;                        // sender report
  buf.writeUInt16BE(6, 2);             // length in words minus one
  buf.writeUInt32BE(ssrc >>> 0, 4);
  const ntp = ntpNow();
  buf.writeUInt32BE(ntp.sec, 8);
  buf.writeUInt32BE(ntp.frac, 12);
  buf.writeUInt32BE(rtpTimestamp >>> 0, 16);
  buf.writeUInt32BE(packetCount >>> 0, 20);
  buf.writeUInt32BE(octetCount >>> 0, 24);
  return buf;
}

// Parse a compound RTCP packet from the receiver. Returns Cast Feedback and PLI
// events; everything else (receiver reports, XR, event logs) is skipped.
function parseRtcp(buf) {
  const out = { feedback: null, pli: false };
  let off = 0;
  while (off + 4 <= buf.length) {
    const version = buf[off] >> 6;
    const subtype = buf[off] & 0x1f;
    const pt = buf[off + 1];
    const len = (buf.readUInt16BE(off + 2) + 1) * 4;
    if (version !== 2 || off + len > buf.length) break;
    if (pt === 206 && subtype === 1) out.pli = true;
    if (pt === 206 && subtype === 15 && len >= 20 && buf.readUInt32BE(off + 12) === 0x43415354 /* CAST */) {
      const fb = {
        receiverSsrc: buf.readUInt32BE(off + 4),
        senderSsrc: buf.readUInt32BE(off + 8),
        checkpoint8: buf[off + 16],
        playoutDelayMs: buf.readUInt16BE(off + 18),
        losses: [],
        acks8: [],                     // frame ids (8-bit, checkpoint+2+i) from the CST2 vector
      };
      const numLoss = buf[off + 17];
      let p = off + 20;
      for (let i = 0; i < numLoss && p + 4 <= off + len; i++, p += 4) {
        fb.losses.push({ frameId8: buf[p], packetId: buf.readUInt16BE(p + 1), bitmask: buf[p + 3] });
      }
      // Optional CST2 frame-level ACK bit vector; first bit = checkpoint + 2.
      if (p + 6 <= off + len && buf.readUInt32BE(p) === 0x43535432 /* CST2 */) {
        const octets = buf[p + 5];
        for (let i = 0; i < octets && p + 6 + i < off + len; i++) {
          const bits = buf[p + 6 + i];
          for (let b = 0; b < 8; b++) if (bits & (1 << b)) fb.acks8.push((fb.checkpoint8 + 2 + i * 8 + b) & 0xff);
        }
      }
      out.feedback = fb;
    }
    off += len;
  }
  return out;
}

// Build a Cast Feedback packet (receiver → sender); used by the loopback tests.
function buildFeedback({ receiverSsrc, senderSsrc, checkpoint8, playoutDelayMs = 400, losses = [] }) {
  const buf = Buffer.alloc(20 + losses.length * 4);
  buf[0] = 0x80 | 15;
  buf[1] = 206;
  buf.writeUInt16BE(buf.length / 4 - 1, 2);
  buf.writeUInt32BE(receiverSsrc >>> 0, 4);
  buf.writeUInt32BE(senderSsrc >>> 0, 8);
  buf.writeUInt32BE(0x43415354, 12);
  buf[16] = checkpoint8 & 0xff;
  buf[17] = losses.length;
  buf.writeUInt16BE(playoutDelayMs, 18);
  losses.forEach((l, i) => {
    buf[20 + i * 4] = l.frameId8 & 0xff;
    buf.writeUInt16BE(l.packetId, 20 + i * 4 + 1);
    buf[20 + i * 4 + 3] = l.bitmask || 0;
  });
  return buf;
}

// ---- IVF (VP8 elementary stream) ---------------------------------------------------------

// Incremental parser for ffmpeg's IVF output: 32-byte file header, then frames of
// [u32le size][u64le pts][payload]. Emits { data, pts, key, seconds } via onFrame.
class IvfParser {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.pending = Buffer.alloc(0);
    this.header = null;
  }

  push(chunk) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    if (!this.header) {
      if (this.pending.length < 32) return;
      if (this.pending.toString('latin1', 0, 4) !== 'DKIF') throw new Error('Not an IVF stream');
      this.header = {
        fourcc: this.pending.toString('latin1', 8, 12),
        width: this.pending.readUInt16LE(12),
        height: this.pending.readUInt16LE(14),
        timebaseDen: this.pending.readUInt32LE(16),
        timebaseNum: this.pending.readUInt32LE(20),
      };
      this.pending = this.pending.subarray(32);
    }
    for (;;) {
      if (this.pending.length < 12) break;
      const size = this.pending.readUInt32LE(0);
      if (this.pending.length < 12 + size) break;
      const pts = Number(this.pending.readBigUInt64LE(4));
      const data = Buffer.from(this.pending.subarray(12, 12 + size));
      this.pending = this.pending.subarray(12 + size);
      const seconds = (pts * this.header.timebaseNum) / (this.header.timebaseDen || 1);
      this.onFrame({ data, pts, seconds, key: (data[0] & 0x01) === 0 });
    }
  }
}

module.exports = {
  APP_ID, WEBRTC_NS, RTP_VIDEO_TIMEBASE, MAX_PACKET_SIZE, BASE_RTP_HEADER, MAX_PAYLOAD,
  VIDEO_PAYLOAD_TYPE, MAX_UNACKED_FRAMES, ALL_PACKETS_LOST, RTCP_REPORT_INTERVAL_MS,
  DEFAULT_TARGET_DELAY_MS,
  buildVideoOffer, encryptFrame, decryptFrame, packetCountFor, RtpPacketizer, parseRtpPacket,
  expandFrameId, expandFrameIdAbove, buildSenderReport, parseRtcp, buildFeedback, IvfParser,
};
