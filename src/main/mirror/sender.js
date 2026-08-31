'use strict';
// Cast Streaming media sender: transmits encrypted VP8 frames as Cast RTP packets
// over UDP, keeps a retransmission window, and reacts to the receiver's RTCP
// feedback (ACK checkpoints, per-packet NACKs, picture-loss indications).
const dgram = require('dgram');
const { EventEmitter } = require('events');
const p = require('./protocol');

class MirrorSender extends EventEmitter {
  constructor({ host, port, ssrc, receiverSsrc, aesKey, aesIvMask, log }) {
    super();
    this.host = host;
    this.port = port;
    this.ssrc = ssrc;
    this.receiverSsrc = receiverSsrc;
    this.aesKey = aesKey;
    this.aesIvMask = aesIvMask;
    this.log = log || (() => {});
    this.packetizer = new p.RtpPacketizer(p.VIDEO_PAYLOAD_TYPE, ssrc);
    this.frames = new Map();          // frameId -> { cipher, frameId, refFrameId, key, rtpTimestamp }
    this.nextFrameId = 0;
    this.latestFrameId = -1;
    this.checkpoint = -1;             // all frames <= checkpoint fully received
    this.packetCount = 0;
    this.octetCount = 0;
    this.resentPackets = 0;
    this.lastRtpTimestamp = 0;
    this.lastFeedbackAt = 0;
    this.lastSendAt = 0;
    this.playoutDelayMs = null;
    this.stopped = false;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket('udp4');
      this.socket.on('error', (err) => { this.log(`mirror: udp error ${err.message}`); this.emit('error', err); });
      this.socket.on('message', (msg) => this.onRtcp(msg));
      this.socket.bind(0, () => {
        this.srTimer = setInterval(() => this.sendSenderReport(), p.RTCP_REPORT_INTERVAL_MS);
        this.kickTimer = setInterval(() => this.kickstart(), 250);
        this.sendSenderReport();
        resolve(this.socket.address().port);
      });
      this.socket.once('error', reject);
    });
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.srTimer);
    clearInterval(this.kickTimer);
    try { this.socket.close(); } catch (_) { /* ignore */ }
    this.frames.clear();
  }

  // data: raw VP8 frame; key: is keyframe; rtpTimestamp: 90kHz ticks.
  sendFrame(data, key, rtpTimestamp) {
    if (this.stopped) return;
    const frameId = this.nextFrameId++;
    const frame = {
      frameId,
      refFrameId: key ? frameId : frameId - 1,
      key,
      rtpTimestamp,
      cipher: p.encryptFrame(this.aesKey, this.aesIvMask, frameId, data),
    };
    this.frames.set(frameId, frame);
    this.latestFrameId = frameId;
    this.lastRtpTimestamp = rtpTimestamp;
    // Bound the window even if the receiver stops acking: mirroring cares about
    // the latest content, and 8-bit frame ids can only span so much history.
    while (this.frames.size > p.MAX_UNACKED_FRAMES) {
      const oldest = this.frames.keys().next().value;
      this.frames.delete(oldest);
    }
    const numPackets = p.packetCountFor(frame.cipher.length);
    for (let i = 0; i < numPackets; i++) this.transmit(frame, i);
  }

  transmit(frame, packetId, isResend) {
    const packet = this.packetizer.buildPacket(frame, packetId);
    this.packetCount++;
    this.octetCount += packet.length - p.BASE_RTP_HEADER;
    if (isResend) this.resentPackets++;
    this.lastSendAt = Date.now();
    try { this.socket.send(packet, this.port, this.host); } catch (_) { /* ignore */ }
  }

  // Re-send the last packet of the newest frame when idle, so a receiver that
  // missed the tail of a burst notices the gap and NACKs promptly.
  kickstart() {
    if (this.stopped || this.latestFrameId < 0) return;
    if (Date.now() - this.lastSendAt < 200) return;
    const frame = this.frames.get(this.latestFrameId);
    if (frame) this.transmit(frame, p.packetCountFor(frame.cipher.length) - 1, true);
  }

  sendSenderReport() {
    if (this.stopped) return;
    const sr = p.buildSenderReport({
      ssrc: this.ssrc,
      rtpTimestamp: this.lastRtpTimestamp,
      packetCount: this.packetCount,
      octetCount: this.octetCount,
    });
    try { this.socket.send(sr, this.port, this.host); } catch (_) { /* ignore */ }
  }

  onRtcp(msg) {
    let parsed;
    try { parsed = p.parseRtcp(msg); } catch (_) { return; }
    if (parsed.pli) this.emit('pli');
    const fb = parsed.feedback;
    if (!fb) return;
    this.lastFeedbackAt = Date.now();
    this.playoutDelayMs = fb.playoutDelayMs;
    // Checkpoint: everything at or below it is fully received; free those frames.
    const checkpoint = Math.min(p.expandFrameId(fb.checkpoint8, Math.max(this.checkpoint, 0)), this.latestFrameId);
    if (checkpoint > this.checkpoint) {
      this.checkpoint = checkpoint;
      for (const id of this.frames.keys()) if (id <= checkpoint) this.frames.delete(id);
      this.emit('checkpoint', checkpoint);
    }
    // NACKs: retransmit the named packets (or a whole frame).
    for (const loss of fb.losses) {
      const frameId = p.expandFrameIdAbove(loss.frameId8, this.checkpoint);
      const frame = this.frames.get(frameId);
      if (!frame) continue;
      const numPackets = p.packetCountFor(frame.cipher.length);
      if (loss.packetId === p.ALL_PACKETS_LOST) {
        for (let i = 0; i < numPackets; i++) this.transmit(frame, i, true);
      } else if (loss.packetId < numPackets) {
        this.transmit(frame, loss.packetId, true);
        for (let b = 0; b < 8; b++) {
          if ((loss.bitmask & (1 << b)) && loss.packetId + 1 + b < numPackets) {
            this.transmit(frame, loss.packetId + 1 + b, true);
          }
        }
      }
    }
  }

  stats() {
    return {
      frames: this.nextFrameId,
      packets: this.packetCount,
      bytes: this.octetCount,
      resent: this.resentPackets,
      unacked: this.latestFrameId - this.checkpoint,
      playoutDelayMs: this.playoutDelayMs,
      feedbackAgoMs: this.lastFeedbackAt ? Date.now() - this.lastFeedbackAt : null,
    };
  }
}

module.exports = { MirrorSender };
