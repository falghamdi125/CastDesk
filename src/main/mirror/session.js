'use strict';
// A Cast mirroring session: launches the Chrome Mirroring receiver app on the TV,
// negotiates a video stream over the webrtc namespace (OFFER/ANSWER), then streams
// gdigrab-captured VP8 over UDP via MirrorSender. This is the protocol Chrome
// itself uses to cast a desktop, so there is no receiver-side player buffer.
const util = require('util');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { Application } = require('castv2-client');
const JsonController = require('castv2-client/lib/controllers/json');
const p = require('./protocol');
const { MirrorSender } = require('./sender');
const { WebmVp8Demuxer } = require('./webm');
const ff = require('../ffmpeg');

function MirrorApp(client, session) {
  Application.apply(this, arguments);
  this.webrtc = this.createController(JsonController, p.WEBRTC_NS);
  const self = this;
  this.webrtc.on('message', (data) => self.emit('webrtc', data));
}
util.inherits(MirrorApp, Application);
MirrorApp.APP_ID = p.APP_ID;

const ANSWER_TIMEOUT_MS = 5000;
const PLI_RESPAWN_COOLDOWN_MS = 3000;

class MirrorSession extends EventEmitter {
  constructor({ caster, log }) {
    super();
    this.caster = caster;
    this.log = log || (() => {});
    this.app = null;
    this.sender = null;
    this.child = null;
    this.seqNum = Math.floor(Math.random() * 100) + 1;
    this.stopped = false;
    this.lastRespawnAt = 0;
    this.captureOpts = null;
    this.encoderRuns = 0;
    this.on('error', () => {});  // errors may fire before the owner attaches its handler
  }

  // opts: { host, target, region, fps, maxWidth, maxHeight, bitrateKbps, width, height }
  async start(opts) {
    this.captureOpts = opts;
    const ssrc = 50001 + Math.floor(Math.random() * 49999);   // "normal priority" (video) range
    const aesKey = crypto.randomBytes(16);
    const aesIvMask = crypto.randomBytes(16);

    this.app = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('mirroring app launch timed out')), 10000);
      this.caster.client.launch(MirrorApp, (err, app) => {
        clearTimeout(timer);
        if (err) reject(new Error(`mirroring app launch failed: ${err.message || err}`));
        else resolve(app);
      });
    });
    if (this.stopped) { this.teardownApp(); throw new Error('cancelled'); }
    this.app.on('close', () => { if (!this.stopped) { this.log('mirror: receiver closed the session'); this.emit('stopped'); } });

    const offer = p.buildVideoOffer({
      ssrc,
      aesKey,
      aesIvMask,
      fps: opts.fps,
      maxBitRate: Math.max(300000, (opts.bitrateKbps || 4000) * 1000),
      width: opts.width,
      height: opts.height,
    });
    const answer = await this.negotiate(offer);
    if (this.stopped) { this.teardownApp(); throw new Error('cancelled'); }
    this.log(`mirror: ANSWER ok (udpPort ${answer.udpPort}, ssrcs ${JSON.stringify(answer.ssrcs)})`);

    this.sender = new MirrorSender({
      host: opts.host,
      port: answer.udpPort,
      ssrc,
      receiverSsrc: (answer.ssrcs && answer.ssrcs[0]) || ssrc + 1,
      aesKey,
      aesIvMask,
      log: this.log,
    });
    this.sender.on('pli', () => this.onPictureLoss());
    this.sender.on('error', (err) => this.fail(err));
    await this.sender.start();
    if (opts.engine === 'chromium') this.attachChromiumSource(opts.fps);
    else this.spawnEncoder();
    return { udpPort: answer.udpPort };
  }

  // Chromium (WGC) capture: the renderer records the capture as VP8/WebM — the same
  // pipeline Chrome's own mirroring uses, so colors and window capture match Chrome —
  // and pushes chunks over IPC into chunk(); frames are lifted out of the WebM here.
  attachChromiumSource(fps) {
    this.tsBase = 0;
    this.lastFrameMs = 0;
    let frames = 0;
    this.demuxer = new WebmVp8Demuxer(
      (frame) => {
        if (this.stopped || !this.sender) return;
        frames++;
        if (frames === 1) this.log(`mirror: first VP8 frame (${frame.data.length} bytes, ${frame.key ? 'key' : 'delta'})`);
        this.lastFrameMs = frame.timeMs;
        this.sender.sendFrame(frame.data, frame.key, this.tsBase + Math.round(frame.timeMs * 90));
      },
      () => {  // recorder restarted (e.g. after a keyframe request): keep the RTP clock monotonic
        this.tsBase += Math.round(this.lastFrameMs * 90) + Math.round(p.RTP_VIDEO_TIMEBASE / (fps || 30));
        this.lastFrameMs = 0;
      }
    );
  }

  chunk(buf) {
    if (this.stopped || !this.demuxer) return;
    try { this.demuxer.push(buf); } catch (err) { this.fail(err); }
  }

  negotiate(offer) {
    return new Promise((resolve, reject) => {
      const seq = this.seqNum++;
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('no ANSWER from the receiver (it may not accept third-party mirroring)'));
      }, ANSWER_TIMEOUT_MS);
      const onMessage = (msg) => {
        if (!msg || msg.seqNum !== seq) return;
        if (msg.type !== 'ANSWER') return;
        cleanup();
        if (msg.result !== 'ok' || !msg.answer || !msg.answer.udpPort) {
          const detail = msg.error ? `${msg.error.code || ''} ${msg.error.description || ''}`.trim() : 'rejected';
          reject(new Error(`receiver rejected the OFFER: ${detail}`));
          return;
        }
        resolve(msg.answer);
      };
      const cleanup = () => { clearTimeout(timer); this.app.removeListener('webrtc', onMessage); };
      this.app.on('webrtc', onMessage);
      this.log(`mirror: sending OFFER (seq ${seq})`);
      this.app.webrtc.send({ type: 'OFFER', seqNum: seq, offer });
    });
  }

  spawnEncoder() {
    if (this.stopped) return;
    const o = this.captureOpts;
    this.encoderRuns++;
    const child = ff.spawnVp8Capture({
      target: o.target,
      region: o.region,
      fps: o.fps,
      maxHeight: o.maxHeight,
      maxWidth: o.maxWidth,
      bitrateKbps: o.bitrateKbps,
    }, this.log);
    this.child = child;
    // Each encoder run restarts its clock; keep the RTP timeline monotonic across runs.
    const tsBase = this.sender.lastRtpTimestamp + (this.encoderRuns > 1 ? Math.round(p.RTP_VIDEO_TIMEBASE / (o.fps || 30)) : 0);
    let frames = 0;
    const parser = new p.IvfParser((frame) => {
      frames++;
      if (frames === 1) this.log(`mirror: first VP8 frame (${frame.data.length} bytes, ${frame.key ? 'key' : 'delta'})`);
      this.sender.sendFrame(frame.data, frame.key, tsBase + Math.round(frame.seconds * p.RTP_VIDEO_TIMEBASE));
    });
    child.stdout.on('data', (b) => {
      try { parser.push(b); } catch (err) { this.fail(err); }
    });
    child.on('exit', (code) => {
      if (this.stopped || this.child !== child) return;
      const tail = (child.stderrTail || []).slice(-3).join(' | ');
      this.fail(new Error(`capture encoder exited (${code})${tail ? ': ' + tail : ''}`));
    });
  }

  // The receiver lost the picture: get a fresh keyframe out to it.
  onPictureLoss() {
    if (this.stopped || Date.now() - this.lastRespawnAt < PLI_RESPAWN_COOLDOWN_MS) return;
    this.lastRespawnAt = Date.now();
    if (this.demuxer) {
      this.log('mirror: receiver reported picture loss, requesting a keyframe');
      this.emit('keyframe-request');       // the renderer restarts its recorder
      return;
    }
    this.log('mirror: receiver reported picture loss, restarting encoder for a keyframe');
    const old = this.child;
    this.child = null;
    if (old) { try { old.kill(); } catch (_) { /* ignore */ } }
    this.spawnEncoder();
  }

  fail(err) {
    if (this.stopped) return;
    this.log(`mirror: ${err.message}`);
    this.emit('error', err);
  }

  stats() {
    return this.sender ? this.sender.stats() : null;
  }

  teardownApp() {
    const app = this.app;
    this.app = null;
    if (!app) return;
    try {
      const client = this.caster.client;
      if (client) client.stop(app, () => {});
      else app.close();
    } catch (_) { /* ignore */ }
  }

  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.child) { try { this.child.kill(); } catch (_) { /* ignore */ } this.child = null; }
    if (this.sender) this.sender.stop();
    this.teardownApp();
  }
}

module.exports = { MirrorSession, MirrorApp };
