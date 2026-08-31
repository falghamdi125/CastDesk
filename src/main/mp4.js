'use strict';
// Minimal ISO-BMFF box parsing + a live fragmented-MP4 broadcaster.
// The broadcaster receives an fMP4 byte stream (from ffmpeg or from Chromium MediaRecorder),
// keeps the init segment (ftyp+moov), and fans out moof+mdat fragments to any number of
// HTTP clients. Late joiners get the init segment and then start at the next fragment that
// begins with a video keyframe, so playback is always decodable.
const { EventEmitter } = require('events');

function* boxes(buf, start = 0, end = buf.length) {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let hdr = 8;
    if (size === 1) { size = Number(buf.readBigUInt64BE(off + 8)); hdr = 16; }
    else if (size === 0) size = end - off;
    if (size < hdr || off + size > end) return;
    yield { type, start: off, size, hdr, payload: off + hdr, end: off + size };
    off += size;
  }
}

function findChild(buf, parent, type) {
  for (const b of boxes(buf, parent.payload, parent.end)) if (b.type === type) return b;
  return null;
}

// First video track id + per-track mdhd timescales from a moov box.
function parseMoovInfo(moovBuf) {
  const info = { videoTrackId: null, timescales: new Map() };
  const moov = [...boxes(moovBuf)].find((b) => b.type === 'moov');
  if (!moov) return info;
  for (const trak of boxes(moovBuf, moov.payload, moov.end)) {
    if (trak.type !== 'trak') continue;
    const tkhd = findChild(moovBuf, trak, 'tkhd');
    const mdia = findChild(moovBuf, trak, 'mdia');
    if (!tkhd || !mdia) continue;
    const trackId = moovBuf.readUInt32BE(tkhd.payload + (moovBuf[tkhd.payload] === 1 ? 20 : 12));
    const mdhd = findChild(moovBuf, mdia, 'mdhd');
    if (mdhd) info.timescales.set(trackId, moovBuf.readUInt32BE(mdhd.payload + (moovBuf[mdhd.payload] === 1 ? 20 : 12)));
    const hdlr = findChild(moovBuf, mdia, 'hdlr');
    if (info.videoTrackId == null && hdlr && moovBuf.toString('latin1', hdlr.payload + 8, hdlr.payload + 12) === 'vide') info.videoTrackId = trackId;
  }
  return info;
}

// Track ID of the first video track in a moov box (or null).
function findVideoTrackId(moovBuf) {
  return parseMoovInfo(moovBuf).videoTrackId;
}

// Media time span of a fragment in seconds — [start, end] from tfdt plus the sum of trun
// sample durations. Prefers the given track, falls back to the first timed traf; null when
// the moof carries no usable timing (no tfdt or unknown timescale).
function fragmentTimeSpan(moofBuf, preferTrackId, timescales) {
  const moof = [...boxes(moofBuf)].find((b) => b.type === 'moof');
  if (!moof) return null;
  let fallback = null;
  for (const traf of boxes(moofBuf, moof.payload, moof.end)) {
    if (traf.type !== 'traf') continue;
    const tfhd = findChild(moofBuf, traf, 'tfhd');
    const tfdt = findChild(moofBuf, traf, 'tfdt');
    if (!tfhd || !tfdt) continue;
    const trackId = moofBuf.readUInt32BE(tfhd.payload + 4);
    const scale = timescales.get(trackId);
    if (!scale) continue;
    const base = moofBuf[tfdt.payload] === 1 ? Number(moofBuf.readBigUInt64BE(tfdt.payload + 4)) : moofBuf.readUInt32BE(tfdt.payload + 4);
    const tfFlags = moofBuf.readUInt32BE(tfhd.payload) & 0xffffff;
    let p = tfhd.payload + 8;
    if (tfFlags & 0x1) p += 8;        // base_data_offset
    if (tfFlags & 0x2) p += 4;        // sample_description_index
    const defaultDuration = (tfFlags & 0x8) ? moofBuf.readUInt32BE(p) : null;
    let duration = 0;
    for (const trun of boxes(moofBuf, traf.payload, traf.end)) {
      if (trun.type !== 'trun') continue;
      const trFlags = moofBuf.readUInt32BE(trun.payload) & 0xffffff;
      const count = moofBuf.readUInt32BE(trun.payload + 4);
      let q = trun.payload + 8;
      if (trFlags & 0x1) q += 4;      // data_offset
      if (trFlags & 0x4) q += 4;      // first_sample_flags
      if (trFlags & 0x100) {          // per-sample durations (duration is the first field)
        const stride = 4 * (((trFlags >> 8) & 1) + ((trFlags >> 9) & 1) + ((trFlags >> 10) & 1) + ((trFlags >> 11) & 1));
        for (let i = 0; i < count && q + 4 <= trun.end; i++, q += stride) duration += moofBuf.readUInt32BE(q);
      } else if (defaultDuration != null) {
        duration += count * defaultDuration;
      }
    }
    const span = { start: base / scale, end: (base + duration) / scale };
    if (trackId === preferTrackId) return span;
    if (!fallback) fallback = span;
  }
  return fallback;
}

// Does the first video sample in this moof carry the sync-sample (keyframe) flag?
function fragmentStartsWithKeyframe(moofBuf, videoTrackId) {
  const moof = [...boxes(moofBuf)].find((b) => b.type === 'moof');
  if (!moof) return false;
  for (const traf of boxes(moofBuf, moof.payload, moof.end)) {
    if (traf.type !== 'traf') continue;
    const tfhd = findChild(moofBuf, traf, 'tfhd');
    const trun = findChild(moofBuf, traf, 'trun');
    if (!tfhd || !trun) continue;
    const tfFlags = moofBuf.readUInt32BE(tfhd.payload) & 0xffffff;
    const trackId = moofBuf.readUInt32BE(tfhd.payload + 4);
    if (videoTrackId != null && trackId !== videoTrackId) continue;
    let p = tfhd.payload + 8;
    if (tfFlags & 0x1) p += 8;        // base_data_offset
    if (tfFlags & 0x2) p += 4;        // sample_description_index
    if (tfFlags & 0x8) p += 4;        // default_sample_duration
    if (tfFlags & 0x10) p += 4;       // default_sample_size
    let defaultFlags = null;
    if (tfFlags & 0x20) defaultFlags = moofBuf.readUInt32BE(p);
    const trFlags = moofBuf.readUInt32BE(trun.payload) & 0xffffff;
    const sampleCount = moofBuf.readUInt32BE(trun.payload + 4);
    if (sampleCount === 0) continue;
    let q = trun.payload + 8;
    if (trFlags & 0x1) q += 4;        // data_offset
    let flags = defaultFlags;
    if (trFlags & 0x4) { flags = moofBuf.readUInt32BE(q); q += 4; } // first_sample_flags
    else if (trFlags & 0x400) {       // per-sample flags: skip duration/size of sample 0
      if (trFlags & 0x100) q += 4;
      if (trFlags & 0x200) q += 4;
      flags = moofBuf.readUInt32BE(q);
    }
    if (flags == null) return true;   // no flag info at all: assume sync (trex default)
    return ((flags >>> 16) & 0x1) === 0; // sample_is_non_sync_sample == 0
  }
  return videoTrackId == null; // no video traf found
}

const MAX_CLIENT_BACKLOG = 32 * 1024 * 1024;

class Mp4Broadcaster extends EventEmitter {
  constructor(log, { backlogMs = 3000 } = {}) {
    super();
    this.log = log || (() => {});
    this.pending = Buffer.alloc(0);
    this.initParts = [];
    this.init = null;
    this.videoTrackId = null;
    this.timescales = new Map();
    this.lastMoof = null;
    this.clients = new Set();
    this.fragments = 0;
    this.keyFragments = 0;
    this.bytes = 0;
    this.lastFragmentAt = 0;
    this.startedAt = Date.now();
    this.ended = false;
    // Rolling keyframe-aligned window of recent fragments: dumped to a joining client so its
    // start buffer fills at network speed instead of one real-time second per second.
    this.backlogMs = backlogMs;
    this.backlog = [];                // { frag, key, t (arrival ms), start, end (media secs) }
    this.mediaTimeSec = 0;            // media time at the end of the newest fragment
    this.clientBaseSec = null;        // media time where the most recent client started
    this.clientGen = 0;               // bumped every time a client starts receiving media
    this.fragGapEmaMs = 0;            // smoothed interval between fragments
  }

  attach(readable) {
    readable.on('data', (b) => this.push(b));
    readable.on('end', () => this.end());
    readable.on('error', () => this.end());
  }

  push(chunk) {
    if (this.ended) return;
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    for (;;) {
      if (this.pending.length < 8) break;
      let size = this.pending.readUInt32BE(0);
      const type = this.pending.toString('latin1', 4, 8);
      let hdr = 8;
      if (size === 1) {
        if (this.pending.length < 16) break;
        size = Number(this.pending.readBigUInt64BE(8));
        hdr = 16;
      } else if (size === 0) {
        size = this.pending.length; // box extends to EOF (should not happen in fMP4)
      }
      if (size < hdr) { this.log(`mp4: corrupt box '${type}' size=${size}`); this.end(); return; }
      if (this.pending.length < size) break;
      const box = Buffer.from(this.pending.subarray(0, size));
      this.pending = this.pending.subarray(size);
      this.onBox(type, box);
    }
  }

  onBox(type, box) {
    if (!this.init) {
      if (type === 'moof') {
        this.init = Buffer.concat(this.initParts);
        this.initParts = null;
        const info = parseMoovInfo(this.init);
        this.videoTrackId = info.videoTrackId;
        this.timescales = info.timescales;
        this.log(`mp4: init segment ${this.init.length} bytes, video track ${this.videoTrackId}`);
        this.emit('init', this.init);
        this.lastMoof = box;
      } else {
        this.initParts.push(box);
      }
      return;
    }
    if (type === 'moof') { this.lastMoof = box; return; }
    if (type === 'mdat' && this.lastMoof) {
      const key = fragmentStartsWithKeyframe(this.lastMoof, this.videoTrackId);
      const span = fragmentTimeSpan(this.lastMoof, this.videoTrackId, this.timescales);
      const frag = Buffer.concat([this.lastMoof, box]);
      this.lastMoof = null;
      this.fragments++;
      if (key) this.keyFragments++;
      this.bytes += frag.length;
      const now = Date.now();
      if (this.lastFragmentAt) {
        const gap = now - this.lastFragmentAt;
        this.fragGapEmaMs = this.fragGapEmaMs ? this.fragGapEmaMs * 0.8 + gap * 0.2 : gap;
      }
      this.lastFragmentAt = now;
      if (span && span.end > this.mediaTimeSec) this.mediaTimeSec = span.end;
      this.backlog.push({ frag, key, t: now, start: span ? span.start : null, end: span ? span.end : null });
      const cutoff = now - this.backlogMs;
      while (this.backlog.length && this.backlog[0].t < cutoff) this.backlog.shift();
      while (this.backlog.length && !this.backlog[0].key) this.backlog.shift();
      this.broadcast(frag, key, span);
      this.emit('fragment', frag, key);
    }
  }

  broadcast(frag, key, span) {
    for (const c of this.clients) {
      if (!c.ready) continue;
      if (!c.started) {
        if (!key) continue;
        c.started = true;
        this.clientBaseSec = span ? span.start : null;
        this.clientGen++;
      }
      if (c.res.writableLength > MAX_CLIENT_BACKLOG) {
        this.log('mp4: client too slow, dropping');
        this.removeClient(c.res);
        try { c.res.destroy(); } catch (_) { /* ignore */ }
        continue;
      }
      c.res.write(frag);
    }
  }

  addClient(res) {
    const c = { res, ready: false, started: false };
    this.clients.add(c);
    const sendInit = (init) => {
      if (!this.clients.has(c)) return;
      res.write(init);
      c.ready = true;
      if (this.backlog.length) {
        // Instant start: hand over the retained window (it begins at a keyframe).
        for (const b of this.backlog) res.write(b.frag);
        c.started = true;
        this.clientBaseSec = this.backlog[0].start;
        this.clientGen++;
        this.log(`mp4: client joined with ${this.backlog.length} backlog fragments`);
      }
    };
    if (this.init) sendInit(this.init);
    else this.once('init', sendInit);
    if (this.ended) { try { res.end(); } catch (_) { /* ignore */ } }
    this.emit('clients', this.clients.size);
  }

  removeClient(res) {
    for (const c of this.clients) if (c.res === res) this.clients.delete(c);
    this.emit('clients', this.clients.size);
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    for (const c of this.clients) { try { c.res.end(); } catch (_) { /* ignore */ } }
    this.clients.clear();
    this.emit('end');
  }

  stats() {
    return {
      fragments: this.fragments,
      keyFragments: this.keyFragments,
      bytes: this.bytes,
      clients: this.clients.size,
      uptimeMs: Date.now() - this.startedAt,
      hasInit: !!this.init,
      lastFragmentAgoMs: this.lastFragmentAt ? Date.now() - this.lastFragmentAt : null,
      mediaTime: this.mediaTimeSec,
      clientBase: this.clientBaseSec,
      backlog: this.backlog.length,
      fragGapMs: Math.round(this.fragGapEmaMs),
    };
  }
}

module.exports = { Mp4Broadcaster, boxes, findVideoTrackId, parseMoovInfo, fragmentTimeSpan, fragmentStartsWithKeyframe };
