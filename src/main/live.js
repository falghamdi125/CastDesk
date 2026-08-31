'use strict';
// Live mirroring session: turns either Chromium MediaRecorder chunks (pushed over IPC) or an
// ffmpeg gdigrab capture into a fragmented-MP4 broadcast that the Cast device streams.
const { EventEmitter } = require('events');
const { Mp4Broadcaster } = require('./mp4');
const ff = require('./ffmpeg');

function parseMime(mime) {
  const m = /^(video|audio)\/([\w.+-]+)(?:;\s*codecs="?([^"]*)"?)?/i.exec(mime || '');
  const container = m ? m[2].toLowerCase() : '';
  const codecs = m && m[3] ? m[3].toLowerCase().split(',').map((s) => s.trim()) : [];
  let video = null;
  let audio = null;
  for (const c of codecs) {
    if (/^(avc1|avc3|h264)/.test(c)) video = 'h264';
    else if (/^vp8/.test(c)) video = 'vp8';
    else if (/^vp0?9/.test(c)) video = 'vp9';
    else if (/^(av01|av1)/.test(c)) video = 'av1';
    else if (/^(mp4a|aac)/.test(c)) audio = 'aac';
    else if (/^opus/.test(c)) audio = 'opus';
    else if (/^vorbis/.test(c)) audio = 'vorbis';
  }
  return { container: /mp4/.test(container) ? 'mp4' : 'matroska', video, audio, raw: mime };
}

class LiveManager extends EventEmitter {
  constructor({ server, log }) {
    super();
    this.server = server;
    this.log = log || (() => {});
    this.session = null;
  }

  get active() { return !!this.session; }

  async start(opts) {
    this.stop();
    const bc = new Mp4Broadcaster(this.log);
    const token = this.server.registerLive(bc);
    const session = { token, bc, child: null, input: null, opts, startedAt: Date.now(), plan: null, stopped: false, chunks: 0, inBytes: 0 };
    this.session = session;
    bc.on('clients', () => this.emit('stats', this.stats()));
    bc.on('fragment', (_f, key) => { if (session.bc.fragments === 1) this.log(`live: first fragment (${key ? 'keyframe' : 'non-key'})`); });

    const fps = opts.fps || 30;
    const maxHeight = opts.maxHeight == null ? 1080 : opts.maxHeight;
    const maxWidth = opts.maxWidth || 0;
    const bitrateKbps = opts.bitrateKbps || 8000;

    try {
      if (opts.engine === 'gdigrab') {
        const encoder = await ff.resolveEncoder(opts.encoder, this.log);
        const child = ff.spawnGdigrab({ target: opts.target, region: opts.region, fps, encoder, maxHeight, maxWidth, bitrateKbps }, this.log);
        session.child = child;
        session.plan = { mode: 'gdigrab', encoder, target: opts.target };
        bc.attach(child.stdout);
        child.on('exit', (code) => this.onChildExit(session, code));
      } else if (opts.audioOnly) {
        const m = parseMime(opts.mime);
        if (m.container === 'mp4' && m.audio === 'aac') {
          session.plan = { mode: 'direct', audioOnly: true, encoder: 'none', input: m.raw };
          session.input = (buf) => bc.push(buf);
        } else {
          const child = ff.spawnLiveFromPipe({ inputFormat: m.container, audioOnly: true }, this.log);
          session.child = child;
          session.plan = { mode: 'ffmpeg', audioOnly: true, encoder: 'aac', input: m.raw };
          bc.attach(child.stdout);
          child.on('exit', (code) => this.onChildExit(session, code));
          session.input = (buf) => { if (child.stdin.writable) child.stdin.write(buf); };
        }
      } else {
        const m = parseMime(opts.mime);
        const videoCopy = m.video === 'h264' && opts.passthrough !== false;
        // Even a Cast-compatible recorder stream goes through an ffmpeg remux (-c copy, no
        // re-encode): Chromium's MP4 muxer cuts one fragment per keyframe, which holds up to
        // a second of video back, while ffmpeg re-fragments on every frame.
        const audioCopy = videoCopy && m.container === 'mp4' && m.audio === 'aac';
        const encoder = videoCopy ? 'copy' : await ff.resolveEncoder(opts.encoder, this.log);
        const child = ff.spawnLiveFromPipe({ inputFormat: m.container, videoCopy, audioCopy, encoder, fps, maxHeight, maxWidth, bitrateKbps }, this.log);
        session.child = child;
        session.plan = { mode: 'ffmpeg', videoCopy, audioCopy, encoder, input: m.raw };
        bc.attach(child.stdout);
        child.on('exit', (code) => this.onChildExit(session, code));
        session.input = (buf) => { if (child.stdin.writable) child.stdin.write(buf); };
      }
    } catch (err) {
      this.stop();
      throw err;
    }
    if (this.session !== session) throw new Error('Live session was cancelled');
    this.log(`live: started (${JSON.stringify(session.plan)})`);
    return { token, plan: session.plan };
  }

  chunk(buf) {
    const s = this.session;
    if (!s || !s.input) return;
    s.chunks++;
    s.inBytes += buf.length;
    s.input(buf);
  }

  waitForFirstFragment(timeoutMs = 15000) {
    const s = this.session;
    if (!s) return Promise.reject(new Error('No live session'));
    if (s.bc.fragments > 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('No video produced within ' + Math.round(timeoutMs / 1000) + 's')); }, timeoutMs);
      const onFrag = () => { cleanup(); resolve(); };
      const onEnd = () => { cleanup(); reject(new Error('Live stream ended before producing video')); };
      const cleanup = () => { clearTimeout(timer); s.bc.removeListener('fragment', onFrag); s.bc.removeListener('end', onEnd); };
      s.bc.once('fragment', onFrag);
      s.bc.once('end', onEnd);
    });
  }

  stop() {
    const s = this.session;
    if (!s) return;
    this.session = null;
    s.stopped = true;
    if (s.child) {
      try { s.child.stdin.end(); } catch (_) { /* ignore */ }
      try { s.child.kill(); } catch (_) { /* ignore */ }
    }
    s.bc.end();
    this.server.unregister(s.token);
    this.log('live: stopped');
    this.emit('stopped');
  }

  onChildExit(session, code) {
    if (session.stopped) return;
    const tail = (session.child && session.child.stderrTail || []).slice(-4).join(' | ');
    const err = new Error(`ffmpeg exited with code ${code}${tail ? ': ' + tail : ''}`);
    this.log(`live: ${err.message}`);
    this.stop();
    this.emit('error', err);
  }

  stats() {
    const s = this.session;
    if (!s) return null;
    return { ...s.bc.stats(), plan: s.plan, chunks: s.chunks, inBytes: s.inBytes, uptimeMs: Date.now() - s.startedAt };
  }

  // Timing inputs for the live-edge catch-up controller (null when idle or untimed).
  latency() {
    const s = this.session;
    if (!s || !s.bc.init) return null;
    return { mediaTime: s.bc.mediaTimeSec, clientBase: s.bc.clientBaseSec, clientGen: s.bc.clientGen, fragGapMs: s.bc.fragGapEmaMs };
  }
}

module.exports = { LiveManager, parseMime };
