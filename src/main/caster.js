'use strict';
// Thin promise wrapper around castv2-client: one connection, one Default Media Receiver session.
const { EventEmitter } = require('events');
const { Client, DefaultMediaReceiver } = require('castv2-client');

const CONNECT_TIMEOUT_MS = 10000;
const POLL_MS = 1000;

function callback(fn) {
  return new Promise((resolve, reject) => fn((err, result) => (err ? reject(err) : resolve(result))));
}

class Caster extends EventEmitter {
  constructor(log) {
    super();
    this.log = log || (() => {});
    this.client = null;
    this.player = null;
    this.device = null;
    this.pollTimer = null;
    this.lastStatus = null;
    this.receiverVolume = null;
  }

  get connected() { return !!this.client; }

  state() {
    return {
      connected: this.connected,
      device: this.device,
      hasPlayer: !!this.player,
      volume: this.receiverVolume,
    };
  }

  async connect(device) {
    if (this.client && this.device && this.device.host === device.host) return;
    this.disconnect();
    this.device = device;
    const client = new Client();
    await new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { client.close(); } catch (_) { /* ignore */ }
        reject(new Error(`Connection to ${device.host} timed out`));
      }, CONNECT_TIMEOUT_MS);
      client.on('error', (err) => {
        this.log(`cast error: ${err.message}`);
        if (!settled) { settled = true; clearTimeout(timer); reject(err); return; }
        this.emit('error', err);
        if (this.client === client) this.disconnect();
      });
      client.connect({ host: device.host, port: device.port || 8009 }, () => {
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });
    this.client = client;
    client.client.once('close', () => {
      if (this.client !== client) return;
      this.log('cast connection closed');
      this.teardown();
      this.emit('state', this.state());
    });
    client.on('status', (st) => {
      if (st && st.volume) this.receiverVolume = st.volume;
      this.emit('state', this.state());
    });
    try {
      const st = await callback((cb) => client.getStatus(cb));
      if (st && st.volume) this.receiverVolume = st.volume;
    } catch (_) { /* ignore */ }
    this.log(`connected to ${device.name} (${device.host})`);
    this.emit('state', this.state());
  }

  disconnect() {
    if (this.client) { try { this.client.close(); } catch (_) { /* ignore */ } }
    this.teardown();
    this.device = null;
    this.emit('state', this.state());
  }

  teardown() {
    this.stopPolling();
    this.player = null;
    this.client = null;
    this.lastStatus = null;
    this.emit('status', null);
  }

  async ensurePlayer() {
    if (!this.client) throw new Error('Not connected to a device');
    if (this.player) return this.player;
    const player = await callback((cb) => this.client.launch(DefaultMediaReceiver, cb));
    this.player = player;
    player.on('status', (s) => this.onStatus(s));
    player.on('close', () => {
      if (this.player !== player) return;
      this.log('receiver app closed');
      this.player = null;
      this.stopPolling();
      this.onStatus(null);
      this.emit('state', this.state());
    });
    this.startPolling();
    this.emit('state', this.state());
    return player;
  }

  async load(media, options = {}) {
    let player = await this.ensurePlayer();
    const doLoad = () => callback((cb) => player.load(media, { autoplay: true, ...options }, cb));
    let status;
    try {
      status = await doLoad();
    } catch (err) {
      // The app may have died on the TV since we launched it: relaunch once.
      this.log(`load failed (${err.message}); relaunching receiver`);
      this.player = null;
      player = await this.ensurePlayer();
      status = await doLoad();
    }
    this.onStatus(status);
    return status;
  }

  requirePlayer() {
    if (!this.player) throw new Error('Nothing is being cast');
    return this.player;
  }

  play() { return callback((cb) => this.requirePlayer().play(cb)).then((s) => this.onStatus(s)); }
  pause() { return callback((cb) => this.requirePlayer().pause(cb)).then((s) => this.onStatus(s)); }
  stop() { return callback((cb) => this.requirePlayer().stop(cb)).then((s) => this.onStatus(s)); }
  seek(t) { return callback((cb) => this.requirePlayer().seek(t, cb)).then((s) => this.onStatus(s)); }
  setPlaybackRate(rate) {
    const p = this.requirePlayer();
    return callback((cb) => p.media.sessionRequest({ type: 'SET_PLAYBACK_RATE', playbackRate: rate }, cb)).then((s) => this.onStatus(s));
  }

  async setVolume(level) {
    if (!this.client) throw new Error('Not connected');
    const v = await callback((cb) => this.client.setVolume({ level: Math.max(0, Math.min(1, level)) }, cb));
    this.receiverVolume = v;
    this.emit('state', this.state());
  }

  async setMuted(muted) {
    if (!this.client) throw new Error('Not connected');
    const v = await callback((cb) => this.client.setVolume({ muted: !!muted }, cb));
    this.receiverVolume = v;
    this.emit('state', this.state());
  }

  async stopApp() {
    if (!this.client || !this.player) return;
    try { await callback((cb) => this.client.stop(this.player, cb)); } catch (_) { /* ignore */ }
    this.player = null;
    this.stopPolling();
    this.onStatus(null);
    this.emit('state', this.state());
  }

  startPolling() {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      const p = this.player;
      if (!p) return;
      try { p.getStatus((err, s) => { if (!err && this.player === p) this.onStatus(s || null); }); } catch (_) { /* ignore */ }
    }, POLL_MS);
  }

  stopPolling() {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  onStatus(s) {
    this.lastStatus = s || null;
    this.emit('status', s ? summarizeStatus(s) : null);
    return s;
  }
}

function summarizeStatus(s) {
  const media = s.media || {};
  const meta = media.metadata || {};
  return {
    state: s.playerState || 'IDLE',
    idleReason: s.idleReason || null,
    currentTime: s.currentTime || 0,
    duration: media.duration || null,
    title: meta.title || '',
    contentId: media.contentId || '',
    contentType: media.contentType || '',
    streamType: media.streamType || '',
    mediaSessionId: s.mediaSessionId || null,
    volume: s.volume || null,
    customData: media.customData || null,
    playbackRate: s.playbackRate || 1,
    supportedMediaCommands: s.supportedMediaCommands || 0,
  };
}

module.exports = { Caster };
