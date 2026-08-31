'use strict';
// Minimal incremental WebM (Matroska/EBML) demuxer for Chromium MediaRecorder
// output: extracts VP8 frames (with keyframe flag and millisecond timestamps)
// from SimpleBlocks. Containers (Segment/Cluster) stream with unknown sizes, so
// they are entered rather than buffered; everything else is skipped by size.
// A new EBML header mid-stream (the renderer restarted its recorder) resets state.

const ID_EBML = 0x1a45dfa3;
const ID_SEGMENT = 0x18538067;
const ID_CLUSTER = 0x1f43b675;
const ID_TIMECODE = 0xe7;
const ID_SIMPLEBLOCK = 0xa3;

class WebmVp8Demuxer {
  constructor(onFrame, onReset) {
    this.onFrame = onFrame;                  // ({ data, key, timeMs })
    this.onReset = onReset || (() => {});
    this.pending = Buffer.alloc(0);
    this.skip = 0;                           // bytes of an uninteresting element left to discard
    this.clusterTimecode = 0;
    this.started = false;
  }

  push(chunk) {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    for (;;) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, this.pending.length);
        this.pending = this.pending.subarray(n);
        this.skip -= n;
        if (this.skip > 0) return;
      }
      const el = this.readElementHeader();
      if (!el) return;                       // need more bytes
      if (el.id === ID_EBML) {
        if (this.started) { this.clusterTimecode = 0; this.onReset(); }
        this.started = true;
        this.consume(el.headerSize);
        this.skip = el.size;                 // EBML header always has a known size
        continue;
      }
      if (el.id === ID_SEGMENT || el.id === ID_CLUSTER) {
        this.consume(el.headerSize);         // enter containers, even with unknown size
        continue;
      }
      if (el.size == null) throw new Error(`webm: unknown size on non-container element 0x${el.id.toString(16)}`);
      if (el.id === ID_TIMECODE || el.id === ID_SIMPLEBLOCK) {
        if (this.pending.length < el.headerSize + el.size) return;   // wait for the full payload
        const payload = this.pending.subarray(el.headerSize, el.headerSize + el.size);
        if (el.id === ID_TIMECODE) this.clusterTimecode = readUInt(payload);
        else this.onSimpleBlock(payload);
        this.consume(el.headerSize + el.size);
        continue;
      }
      this.consume(el.headerSize);
      this.skip = el.size;
    }
  }

  onSimpleBlock(payload) {
    const track = readVintLength(payload[0]);
    if (!track || payload.length < track + 3) return;
    const rel = payload.readInt16BE(track);
    const flags = payload[track + 2];
    if (flags & 0x06) return;                // laced blocks are not produced for VP8 video
    this.onFrame({
      data: Buffer.from(payload.subarray(track + 3)),
      key: !!(flags & 0x80),
      timeMs: this.clusterTimecode + rel,    // MediaRecorder uses the default 1ms timecode scale
    });
  }

  consume(n) { this.pending = this.pending.subarray(n); }

  // Reads an EBML element id + size from the head of `pending` without consuming.
  // Returns null if more bytes are needed; size is null when "unknown" (streaming).
  readElementHeader() {
    const buf = this.pending;
    if (buf.length < 2) return null;
    const idLen = readVintLength(buf[0]);
    if (!idLen || idLen > 4) throw new Error('webm: bad element id');
    if (buf.length < idLen + 1) return null;
    let id = 0;
    for (let i = 0; i < idLen; i++) id = id * 256 + buf[i];
    const sizeLen = readVintLength(buf[idLen]);
    if (!sizeLen || sizeLen > 8) throw new Error('webm: bad element size');
    if (buf.length < idLen + sizeLen) return null;
    let size = buf[idLen] & (0xff >> sizeLen);
    let allOnes = size === (0xff >> sizeLen);
    for (let i = 1; i < sizeLen; i++) {
      size = size * 256 + buf[idLen + i];
      allOnes = allOnes && buf[idLen + i] === 0xff;
    }
    return { id, size: allOnes ? null : size, headerSize: idLen + sizeLen };
  }
}

function readVintLength(firstByte) {
  for (let i = 0; i < 8; i++) if (firstByte & (0x80 >> i)) return i + 1;
  return 0;
}

function readUInt(buf) {
  let v = 0;
  for (const b of buf) v = v * 256 + b;
  return v;
}

module.exports = { WebmVp8Demuxer };
