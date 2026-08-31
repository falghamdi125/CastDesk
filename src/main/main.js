'use strict';
const { app, BrowserWindow, ipcMain, dialog, desktopCapturer, session, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { Discovery, ipv4Interfaces } = require('./discovery');
const { MediaServer, localAddressFor, contentTypeFor } = require('./server');
const { Caster } = require('./caster');
const { LiveManager } = require('./live');
const { MirrorSession } = require('./mirror/session');
const { Settings } = require('./settings');
const ff = require('./ffmpeg');

const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);
const AUDIO_EXT = new Set(['.mp3', '.m4a', '.aac', '.flac', '.wav', '.ogg', '.oga', '.opus', '.wma', '.aiff', '.aif', '.ape', '.alac', '.mka', '.ac3', '.dts']);
const AUDIO_FILTERS = [
  { name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'ape', 'mka', 'ac3', 'dts'] },
  { name: 'All files', extensions: ['*'] },
];
const VIDEO_FILTERS = [
  { name: 'Video', extensions: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'wmv', 'flv', 'ts', 'm2ts', 'mpg', 'mpeg', '3gp', 'ogv'] },
  { name: 'All files', extensions: ['*'] },
];
const IMAGE_FILTERS = [
  { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp'] },
  { name: 'All files', extensions: ['*'] },
];

let win = null;
const logBuffer = [];
function send(channel, ...args) { if (win && !win.isDestroyed()) win.webContents.send(channel, ...args); }

// Persist logs so playback issues can be diagnosed after the fact (userData/castdesk.log).
const logFile = path.join(app.getPath('userData'), 'castdesk.log');
try {
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 2 * 1024 * 1024) {
    try { fs.unlinkSync(logFile + '.old'); } catch (_) { /* ignore */ }
    fs.renameSync(logFile, logFile + '.old');
  }
} catch (_) { /* ignore */ }

function log(msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${msg}`;
  console.log(line);
  logBuffer.push(line);
  if (logBuffer.length > 400) logBuffer.shift();
  try { fs.appendFileSync(logFile, `${new Date().toISOString().slice(0, 10)} ${line}\n`); } catch (_) { /* ignore */ }
  send('log', line);
}

const settings = new Settings(app.getPath('userData'));
const discovery = new Discovery();
const server = new MediaServer(log);
const caster = new Caster(log);
const live = new LiveManager({ server, log });

let current = null;          // { kind: 'image'|'video'|'live', token, url, title, mode, summary, plan, offset, host }
let pendingCapture = null;   // { sourceId, audio } chosen by the renderer before it calls getDisplayMedia

// ---- wiring -----------------------------------------------------------------------------
discovery.on('update', (list) => { send('devices:update', list); maybeAutoConnect(list); });

let autoConnectSuppressed = false;   // set when the user disconnects manually
let autoConnectBusy = false;
let lastAutoConnectAt = 0;
async function maybeAutoConnect(list) {
  if (autoConnectSuppressed || autoConnectBusy || caster.connected || settings.get('autoConnect') === false) return;
  const id = settings.get('lastDevice');
  if (!id) return;
  const dev = (list || discovery.list()).find((d) => d.id === id);
  if (!dev || Date.now() - lastAutoConnectAt < 15000) return;
  lastAutoConnectAt = Date.now();
  autoConnectBusy = true;
  log(`auto-connecting to ${dev.name} (${dev.host})`);
  try {
    await caster.connect(dev);
    send('toast', { type: 'ok', text: `Connected to ${dev.name}` });
  } catch (err) {
    log(`auto-connect failed: ${err.message}`);
  } finally {
    autoConnectBusy = false;
  }
}
discovery.on('log', log);
caster.on('state', (st) => send('cast:state', st));
caster.on('error', (err) => send('toast', { type: 'error', text: `Cast: ${err.message}` }));
caster.on('status', (st) => send('player:status', decorateStatus(st)));
live.on('error', (err) => { send('live:status', { active: false, error: err.message }); clearCurrent('live'); });
live.on('stopped', () => send('live:status', { active: false }));
live.on('stats', () => send('live:stats', live.stats()));

function decorateStatus(st) {
  if (!st) return null;
  const mine = current && st.contentId && st.contentId === current.url;
  return {
    ...st,
    kind: mine ? current.kind : null,
    offset: mine && current.offset ? current.offset : 0,
    knownDuration: mine && current.summary ? current.summary.duration : null,
    seekable: mine ? (current.kind === 'video' || current.kind === 'audio') : false,
  };
}

function clearCurrent(kind) {
  if (!current) return;
  if (kind && current.kind !== kind) return;
  if (current.token && current.kind !== 'live') server.unregister(current.token);
  for (const t of current.extraTokens || []) server.unregister(t);
  current = null;
}

function stopCurrent() {
  if (current && current.mode === 'mirror') { stopLive(); return; }
  if (live.active) live.stop();
  clearCurrent();
}

function requireConnected() {
  if (!caster.connected || !caster.device) throw new Error('Connect to a Cast device first');
}

function autoBitrate(maxHeight, fps) {
  const h = maxHeight || 2160;
  let kbps = h <= 600 ? 3500 : h <= 720 ? 4000 : h <= 800 ? 5000 : h <= 1080 ? 8000 : h <= 1440 ? 12000 : 16000;
  if (fps > 30) kbps = Math.round(kbps * 1.4);
  return kbps;
}

// ---- casting files ---------------------------------------------------------------------
async function inspectFile(file, opts = {}) {
  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(file);
  const type = contentTypeFor(file);
  const base = { file, name: path.basename(file), size: stat.size, type };
  if (IMAGE_EXT.has(ext) || type.startsWith('image/')) return { ...base, kind: 'image' };
  const s = settings.all();
  const audioExt = AUDIO_EXT.has(ext) || type.startsWith('audio/');
  try {
    const summary = ff.summarize(await ff.probe(file));
    if (audioExt || (!summary.video && summary.audio.length)) {
      const plan = ff.planAudioFile(summary, file, { mode: opts.mode || 'auto', audioIndex: opts.audioIndex || 0 });
      return { ...base, kind: 'audio', summary, plan };
    }
    const plan = ff.planFile(summary, file, { mode: opts.mode || s.videoMode, allowHevc: s.allowHevc, audioIndex: opts.audioIndex || 0 });
    return { ...base, kind: 'video', summary, plan };
  } catch (err) {
    log(`probe failed for ${file}: ${err.message}`);
    return { ...base, kind: audioExt ? 'audio' : 'video', summary: null, plan: { direct: true, reason: 'could not analyze file; trying direct play' }, probeError: err.message };
  }
}

async function castFile(file, opts = {}) {
  requireConnected();
  if (!fs.existsSync(file)) throw new Error('File not found: ' + file);
  const host = await localAddressFor(caster.device.host);
  const info = await inspectFile(file, opts);
  stopCurrent();
  const title = info.name;

  if (info.kind === 'image') {
    const token = server.registerFile(file);
    const url = server.urlFor('media', token, host);
    current = { kind: 'image', token, url, title, host };
    log(`casting image ${title} → ${url}`);
    await caster.load({ contentId: url, contentType: info.type, streamType: 'BUFFERED', metadata: { type: 0, metadataType: 4, title } });
    return { kind: 'image', url, mode: 'direct' };
  }

  if (info.kind === 'audio') return castAudio(file, info, host, title);

  const s = settings.all();
  const plan = info.plan;
  if (plan.direct) {
    const token = server.registerFile(file);
    const url = server.urlFor('media', token, host);
    current = { kind: 'video', mode: 'direct', token, url, title, host, summary: info.summary, plan, offset: 0 };
    log(`casting video (direct: ${plan.reason}) ${title} → ${url}`);
    const media = { contentId: url, contentType: info.type, streamType: 'BUFFERED', metadata: { type: 0, metadataType: 0, title } };
    if (info.summary && info.summary.duration) media.duration = info.summary.duration;
    await caster.load(media);
    return { kind: 'video', url, mode: 'direct', plan };
  }

  const encoder = plan.videoCopy ? 'copy' : await ff.resolveEncoder(s.encoder, log);
  const hasAudio = !!(info.summary && info.summary.audio.length);
  const bitrateKbps = info.summary && info.summary.video ? autoBitrate(info.summary.video.height, info.summary.video.fps || 30) : 8000;
  const token = server.registerTranscode((ss) => ff.spawnFileTranscode({
    file, ss, videoCopy: plan.videoCopy, audioCopy: plan.audioCopy, audioIndex: plan.audioIndex || 0, encoder, bitrateKbps, hasAudio,
  }, log));
  current = { kind: 'video', mode: 'transcode', token, title, host, summary: info.summary, plan: { ...plan, encoder }, offset: 0 };
  log(`casting video (transcode: ${plan.reason}; encoder ${encoder}) ${title}`);
  await loadTranscode(0);
  return { kind: 'video', url: current.url, mode: 'transcode', plan: current.plan };
}

async function castAudio(file, info, host, title) {
  const plan = info.plan;
  const tags = (info.summary && info.summary.tags) || {};
  const metadata = { type: 3, metadataType: 3, title: tags.title || title };
  if (tags.artist) metadata.artist = tags.artist;
  if (tags.album) metadata.albumName = tags.album;
  const extraTokens = [];
  const coverPath = info.summary && info.summary.cover ? await ff.extractCoverArt(file, info.summary.cover, app.getPath('temp')) : null;
  if (coverPath) {
    const t = server.registerFile(coverPath);
    extraTokens.push(t);
    metadata.images = [{ url: server.urlFor('media', t, host) }];
  }
  const duration = info.summary && info.summary.duration ? info.summary.duration : 0;
  if (plan.direct) {
    const token = server.registerFile(file);
    const url = server.urlFor('media', token, host);
    current = { kind: 'audio', mode: 'direct', token, url, title, host, summary: info.summary, plan, offset: 0, extraTokens, contentType: info.type, metadata };
    log(`casting audio (direct: ${plan.reason}) ${title} → ${url}`);
    const media = { contentId: url, contentType: info.type, streamType: 'BUFFERED', metadata };
    if (duration) media.duration = duration;
    await caster.load(media);
    return { kind: 'audio', url, mode: 'direct', plan };
  }
  const token = server.registerTranscode((ss) => ff.spawnAudioTranscode({ file, ss, audioCopy: plan.audioCopy, audioIndex: plan.audioIndex || 0 }, log), 'audio/mp4');
  current = { kind: 'audio', mode: 'transcode', token, title, host, summary: info.summary, plan, offset: 0, extraTokens, contentType: 'audio/mp4', metadata };
  log(`casting audio (transcode: ${plan.reason}) ${title}`);
  await loadTranscode(0);
  return { kind: 'audio', url: current.url, mode: 'transcode', plan };
}

async function loadTranscode(ss) {
  const c = current;
  if (!c || c.mode !== 'transcode') throw new Error('No transcode session');
  c.offset = ss;
  c.url = server.urlFor('tx', c.token, c.host, ss > 0 ? `ss=${ss.toFixed(2)}` : '');
  const metadata = c.metadata || { type: 0, metadataType: 0, title: c.title };
  const media = { contentId: c.url, contentType: c.contentType || 'video/mp4', streamType: 'BUFFERED', metadata, customData: { offset: ss } };
  await caster.load(media);
}

// ---- live mirroring --------------------------------------------------------------------
function gdigrabTarget(opts) {
  if (opts.kind === 'screen') {
    const displays = screen.getAllDisplays();
    const d = displays.find((x) => String(x.id) === String(opts.displayId));
    if (!d || displays.length === 1) return { target: 'desktop', region: null };
    const sf = d.scaleFactor || 1;
    return {
      target: 'desktop',
      region: { x: Math.round(d.bounds.x * sf), y: Math.round(d.bounds.y * sf), width: Math.round(d.bounds.width * sf / 2) * 2, height: Math.round(d.bounds.height * sf / 2) * 2 },
    };
  }
  return { target: `title=${opts.sourceName}`, region: null };
}

// Dimensions the mirror stream will actually have: the capture source scaled to fit
// within the configured maxWidth/maxHeight box, with even values.
function mirrorDimensions(opts, maxHeight, maxWidth) {
  let w = 1920, h = 1080;
  const displays = screen.getAllDisplays();
  const d = displays.find((x) => String(x.id) === String(opts.displayId)) || screen.getPrimaryDisplay();
  if (d) {
    const sf = d.scaleFactor || 1;
    w = Math.round(d.bounds.width * sf);
    h = Math.round(d.bounds.height * sf);
  }
  const scale = Math.min(1, maxHeight ? maxHeight / h : 1, maxWidth ? maxWidth / w : 1);
  return { width: Math.max(2, Math.round((w * scale) / 2) * 2), height: Math.max(2, Math.round((h * scale) / 2) * 2) };
}

// True Chrome-style mirroring: Cast Streaming (RTP/UDP) to the Chrome Mirroring
// receiver app — no receiver-side player buffer, so latency is sub-second.
async function startMirror(opts, s) {
  const fps = opts.fps || s.fps || 30;
  const maxHeight = opts.maxHeight == null ? s.maxHeight : opts.maxHeight;
  const maxWidth = opts.maxWidth == null ? s.maxWidth : opts.maxWidth;
  const dims = mirrorDimensions(opts, maxHeight, maxWidth);
  const bitrateKbps = opts.bitrateKbps || s.bitrateKbps || autoBitrate(dims.height, fps);
  // Window mirroring always captures via Chromium (WGC): GDI can't grab occluded
  // windows, and WGC tone-maps HDR displays so colors match Chrome's own casting.
  const engine = opts.kind === 'window' ? 'chromium' : (opts.engine || s.engine) === 'gdigrab' ? 'gdigrab' : 'chromium';
  const title = `${opts.kind === 'window' ? 'Window' : 'Screen'}: ${opts.sourceName || ''}`;
  const session = new MirrorSession({ caster, log });
  const plan = { mode: 'mirror', engine, codec: 'vp8', width: dims.width, height: dims.height, fps, bitrateKbps };
  current = { kind: 'live', mode: 'mirror', session, url: `mirror://${caster.device.host}`, title, plan };
  try {
    const capture = engine === 'gdigrab' ? gdigrabTarget(opts) : { target: null, region: null };
    await session.start({ host: caster.device.host, engine, target: capture.target, region: capture.region, fps, maxHeight, maxWidth, bitrateKbps, width: dims.width, height: dims.height });
  } catch (err) {
    if (current && current.session === session) current = null;
    session.stop();
    throw err;
  }
  session.on('error', (err) => {
    if (!current || current.session !== session) return;
    send('live:status', { active: false, error: `Mirroring failed: ${err.message}` });
    stopLive();
  });
  session.on('keyframe-request', () => send('live:keyframe'));
  session.on('stopped', () => {
    if (!current || current.session !== session) return;
    current = null;
    clearInterval(session.statsTimer);
    session.stop();
    send('live:status', { active: false });
  });
  session.statsTimer = setInterval(() => {
    if (!current || current.session !== session) return;
    const st = session.stats();
    if (st) send('live:stats', { ...st, plan, uptimeMs: 0 });
  }, 1000);
  log(`mirror: streaming ${dims.width}x${dims.height}@${fps} vp8 ${bitrateKbps}kbps → ${caster.device.host}`);
  send('live:status', { active: true, phase: 'mirroring', url: current.url, plan, title });
  return { token: null, url: current.url, plan };
}

async function startLive(opts) {
  requireConnected();
  stopCurrent();
  const s = settings.all();
  if (!opts.audioOnly && (opts.kind === 'screen' || opts.kind === 'window') && s.mirror !== false) {
    try {
      return await startMirror(opts, s);
    } catch (err) {
      log(`mirror: ${err.message} — falling back to HTTP streaming`);
    }
  }
  const host = await localAddressFor(caster.device.host);
  const engine = opts.audioOnly ? 'chromium' : (opts.engine || s.engine);
  const fps = opts.fps || s.fps || 30;
  const maxHeight = opts.maxHeight == null ? s.maxHeight : opts.maxHeight;
  const maxWidth = opts.maxWidth == null ? s.maxWidth : opts.maxWidth;
  // A width cap usually decides the output height (16:9 source in a 4:3 box), so budget for that.
  const effHeight = maxWidth ? Math.min(maxHeight || 4320, Math.round((maxWidth * 9) / 16)) : maxHeight;
  const bitrateKbps = opts.bitrateKbps || s.bitrateKbps || autoBitrate(effHeight, fps);
  const liveOpts = { engine, mime: opts.mime, passthrough: s.passthrough !== false, fps, maxHeight, maxWidth, bitrateKbps, encoder: s.encoder, audioOnly: !!opts.audioOnly };
  if (engine === 'gdigrab') Object.assign(liveOpts, gdigrabTarget(opts));

  const { token, plan } = await live.start(liveOpts);
  const url = server.urlFor('live', token, host);
  const contentType = opts.audioOnly ? 'audio/mp4' : 'video/mp4';
  const title = opts.audioOnly ? 'PC audio' : `${opts.kind === 'window' ? 'Window' : 'Screen'}: ${opts.sourceName || ''}`;
  current = { kind: 'live', token, url, title, host, plan, offset: 0 };
  catchup = { anchor: null, boosting: false, busy: false, disabled: false, ignored: 0, noSeek: false, pendingSeek: 0, lastSeekAt: 0, lastLogAt: 0 };
  log(`live: ${title} → ${url}`);
  send('live:status', { active: true, phase: 'starting', url, plan, title });

  const fail = (err) => {
    if (!current || current.token !== token) return;
    log(`live: start failed: ${err.message}`);
    send('live:status', { active: false, error: `Could not start playback on the device: ${err.message}. If the TV shows nothing, check that Windows Firewall allows this app on private networks.` });
    stopCurrent();
    caster.stopApp().catch(() => {});
  };
  // Load right away — the TV connects while the recorder spins up (the server holds the
  // response until the init segment exists), so it joins closer to the live edge.
  caster.load({ contentId: url, contentType, streamType: 'LIVE', metadata: opts.audioOnly ? { type: 3, metadataType: 3, title, artist: 'CastDesk' } : { type: 0, metadataType: 0, title } })
    .then(() => { if (current && current.token === token) send('live:status', { active: true, phase: 'playing', url, plan, title }); })
    .catch(fail);
  live.waitForFirstFragment(20000).catch(fail);   // watchdog: capture never produced video
  return { token, url, plan };
}

function stopLive() {
  catchup = null;
  if (current && current.mode === 'mirror') {
    const c = current;
    current = null;
    clearInterval(c.session.statsTimer);
    c.session.stop();
    send('live:status', { active: false });
    log(`mirror: stopped ${c.title}`);
    return;
  }
  if (current && current.kind === 'live') {
    const c = current;
    stopCurrent();
    caster.stop().catch(() => {});
    log(`live: stopped ${c.title}`);
  } else if (live.active) {
    live.stop();
  }
}

// ---- live-edge catch-up ----------------------------------------------------------------
// The TV buffers a few seconds of the live stream before it starts playing, then stays that
// far behind forever. Once it is playing, speed it up (or seek forward, if the receiver has
// no rate control) until it hugs the live edge.
const CATCHUP_RATE = 1.5;
const PLAYBACK_RATE_CMD = 8192;  // supportedMediaCommands bit for SET_PLAYBACK_RATE
let catchup = null;              // per live session; see startLive()

caster.on('status', (st) => {
  const c = catchup;
  if (!c || c.busy || !st || !current || current.kind !== 'live' || st.contentId !== current.url) return;
  const t = live.latency();
  if (!t || t.mediaTime <= 0) return;
  if (st.state !== 'PLAYING') {
    if (c.boosting && st.state === 'BUFFERING') setLiveRate(1, null);  // ran out of buffer: back off
    return;
  }
  // Anchor on the first PLAYING status after each (re)connect. From then on only currentTime
  // *deltas* enter the lag estimate, so it works whether the receiver clock counts stream time
  // or restarts at zero where it joined. Playback began up to one poll before we saw PLAYING,
  // so split the difference with a fixed 0.5s correction.
  if (!c.anchor || c.anchor.gen !== t.clientGen) {
    c.anchor = { gen: t.clientGen, c0: st.currentTime };
    c.pendingSeek = 0;
    log(`live: receiver playing (commands=${st.supportedMediaCommands}${st.supportedMediaCommands & PLAYBACK_RATE_CMD ? '' : ', no rate control'})`);
    return;
  }
  const lag = t.mediaTime - (t.clientBase || 0) - (st.currentTime - c.anchor.c0) - 0.5;
  if (!c.lastLogAt || Date.now() - c.lastLogAt > 5000) {
    c.lastLogAt = Date.now();
    log(`live: lag ≈ ${lag.toFixed(1)}s (rate ${st.playbackRate})`);
  }
  if (c.disabled) return;
  if (c.boosting && st.playbackRate === 1) {
    // Receiver acknowledged but never applied the rate: stop trying for this session.
    if (++c.ignored >= 4) {
      c.disabled = true;
      log('live: receiver ignores SET_PLAYBACK_RATE, catch-up off');
      caster.setPlaybackRate(1).catch(() => {});  // in case it applied the rate without reporting it
    }
    return;
  }
  // Never chase closer than the stream's own burstiness allows, or we stall the player.
  const floor = Math.max(1.1, (2 * (t.fragGapMs || 0)) / 1000 + 0.5);
  if (st.supportedMediaCommands & PLAYBACK_RATE_CMD) {
    if (!c.boosting && lag > floor + 0.8) setLiveRate(CATCHUP_RATE, lag);
    else if (c.boosting && lag < floor) setLiveRate(1, lag);
  } else if (!c.noSeek) {
    // Fallback: jump to the live edge. Sustained lag only, at most one seek per 20s.
    if (lag < floor + 1.2) { c.pendingSeek = 0; return; }
    if (++c.pendingSeek < 3 || Date.now() - c.lastSeekAt < 20000) return;
    c.pendingSeek = 0;
    c.lastSeekAt = Date.now();
    c.busy = true;
    const ahead = lag - floor - 0.3;
    log(`live: no rate control, seeking +${ahead.toFixed(1)}s to the live edge`);
    caster.seek(st.currentTime + ahead)
      .catch((err) => { if (catchup === c) { c.noSeek = true; log(`live: catch-up seek failed (${err.message}), disabled`); } })
      .then(() => { c.busy = false; });
  }
});

function setLiveRate(rate, lag) {
  const c = catchup;
  c.busy = true;
  c.boosting = rate > 1;
  if (rate > 1) c.ignored = 0;
  log(`live: playbackRate → ${rate}${lag != null ? ` (lag ${lag.toFixed(1)}s)` : ''}`);
  caster.setPlaybackRate(rate)
    .catch((err) => { if (catchup === c) { c.disabled = true; log(`live: catch-up disabled: ${err.message}`); } })
    .then(() => { c.busy = false; });
}

// ---- IPC -------------------------------------------------------------------------------
ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  chrome: process.versions.chrome,
  port: server.port,
  ffmpeg: ff.ffmpegPath,
  interfaces: ipv4Interfaces(),
  logs: logBuffer.slice(-200),
  castState: caster.state(),
  live: live.stats(),
  redact: !!process.env.CASTDESK_SMOKE_REDACT,   // documentation screenshots: hide personal names/thumbnails
}));
ipcMain.handle('app:openExternal', (_e, url) => shell.openExternal(url));
ipcMain.handle('settings:get', () => settings.all());
ipcMain.handle('settings:set', (_e, patch) => settings.update(patch));

ipcMain.handle('devices:list', () => discovery.list());
ipcMain.handle('devices:refresh', () => { discovery.query(); return discovery.list(); });
ipcMain.handle('devices:add', (_e, host, name) => {
  host = String(host || '').trim();
  if (!/^[\w.-]+$/.test(host)) throw new Error('Enter a valid IP address or host name');
  const dev = discovery.addManual(host, name);
  const list = settings.get('manualDevices').filter((d) => d.host !== host);
  list.push({ host, name: dev.name });
  settings.update({ manualDevices: list });
  return dev;
});
ipcMain.handle('devices:remove', (_e, host) => {
  discovery.removeManual(host);
  settings.update({ manualDevices: settings.get('manualDevices').filter((d) => d.host !== host) });
  return discovery.list();
});
ipcMain.handle('device:connect', async (_e, id) => {
  const dev = discovery.get(id);
  if (!dev) throw new Error('Device not found');
  autoConnectSuppressed = false;
  await caster.connect(dev);
  settings.update({ lastDevice: id });
  return caster.state();
});
ipcMain.handle('device:disconnect', () => { autoConnectSuppressed = true; stopCurrent(); caster.disconnect(); return caster.state(); });
ipcMain.handle('cast:state', () => caster.state());

ipcMain.handle('sources:list', async (_e, types) => {
  const sources = await desktopCapturer.getSources({ types: types || ['screen', 'window'], thumbnailSize: { width: 400, height: 225 }, fetchWindowIcons: true });
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  return sources
    .filter((s) => s.name && s.name !== 'CastDesk')
    .map((s) => {
      const isScreen = s.id.startsWith('screen:');
      const display = isScreen ? displays.find((d) => String(d.id) === String(s.display_id)) : null;
      return {
        id: s.id,
        kind: isScreen ? 'screen' : 'window',
        name: s.name,
        displayId: s.display_id || null,
        hwnd: !isScreen ? s.id.split(':')[1] : null,
        thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : null,
        icon: s.appIcon && !s.appIcon.isEmpty() ? s.appIcon.toDataURL() : null,
        display: display ? { width: Math.round(display.size.width * display.scaleFactor), height: Math.round(display.size.height * display.scaleFactor), scale: display.scaleFactor, primary: display.id === primary.id } : null,
      };
    });
});

ipcMain.handle('file:open', async (_e, kind) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: kind === 'image' ? IMAGE_FILTERS : kind === 'audio' ? AUDIO_FILTERS : VIDEO_FILTERS });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('file:inspect', (_e, file, opts) => inspectFile(file, opts));
ipcMain.handle('cast:file', (_e, file, opts) => castFile(file, opts));

ipcMain.handle('live:select', (_e, sel) => { pendingCapture = sel; return true; });
ipcMain.handle('live:start', (_e, opts) => startLive(opts));
ipcMain.handle('live:stop', () => { stopLive(); return true; });
ipcMain.handle('live:stats', () => live.stats());
ipcMain.on('live:chunk', (_e, u8) => {
  if (!u8 || !u8.byteLength) return;
  const buf = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
  if (current && current.mode === 'mirror') current.session.chunk(buf);
  else live.chunk(buf);
});

ipcMain.handle('player:cmd', async (_e, cmd, value) => {
  switch (cmd) {
    case 'play': await caster.play(); break;
    case 'pause': await caster.pause(); break;
    case 'stop':
      if (current && current.kind === 'live') stopLive();
      else { await caster.stop().catch(() => {}); clearCurrent(); }
      break;
    case 'seek':
      if (current && (current.kind === 'video' || current.kind === 'audio') && current.mode === 'transcode') await loadTranscode(Math.max(0, Number(value) || 0));
      else await caster.seek(Math.max(0, Number(value) || 0));
      break;
    case 'volume': await caster.setVolume(Number(value)); break;
    case 'mute': await caster.setMuted(!!value); break;
    case 'stopApp': stopCurrent(); await caster.stopApp(); break;
    default: throw new Error('Unknown player command ' + cmd);
  }
  return true;
});

// ---- window ----------------------------------------------------------------------------
function createWindow() {
  win = new BrowserWindow({
    width: 420,
    height: 803,
    minWidth: 360,
    minHeight: 600,
    title: 'CastDesk',
    show: !process.env.CASTDESK_SMOKE_HIDDEN,
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '../../assets/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  win.on('closed', () => { win = null; });
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
  if (process.env.CASTDESK_SMOKE) runSmokeTest(process.env.CASTDESK_SMOKE);
}

// Headless UI smoke test (CASTDESK_SMOKE=<output dir>): cycles through the panes, screenshots
// each one and reports renderer console errors, then quits. Used by automation only.
function runSmokeTest(outDir) {
  const errors = [];
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) errors.push(e.message); });
  win.webContents.once('did-finish-load', async () => {
    const shot = async (name) => {
      await win.webContents.capturePage();                 // warm-up: a hidden window may hand back a stale frame first
      await new Promise((r) => setTimeout(r, 200));
      const img = await win.webContents.capturePage();
      if (!img.isEmpty()) fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG());
    };
    const js = (code) => win.webContents.executeJavaScript(code).catch((err) => errors.push(`${code}: ${err.message}`));
    try {
      await new Promise((r) => setTimeout(r, 4000));
      const fix = process.env.CASTDESK_SMOKE_FIXTURES;   // optional dir with test.png / test.mp4 / test.mp3
      const load = async (kind, name) => { if (fix && fs.existsSync(path.join(fix, name))) await js(`handleFile(${JSON.stringify(kind)}, ${JSON.stringify(path.join(fix, name))})`); };
      await load('image', 'test.png');
      await js('showPane("image")'); await new Promise((r) => setTimeout(r, 500)); await shot('01-image');
      await load('video', 'test.mp4');
      await js('showPane("video")'); await new Promise((r) => setTimeout(r, 500)); await shot('02-video');
      await js('showPane("screen")'); await new Promise((r) => setTimeout(r, 2500)); await shot('03-screen');
      await js('showPane("window")'); await new Promise((r) => setTimeout(r, 2500)); await shot('04-window');
      await load('audio', 'test.mp3');
      await js('showPane("audio")'); await new Promise((r) => setTimeout(r, 500)); await shot('07-audio');
      await js('showPane("settings")'); await new Promise((r) => setTimeout(r, 500)); await shot('05-settings');
      await js('showPane("log")'); await new Promise((r) => setTimeout(r, 300)); await shot('06-log');
      const summary = await js('JSON.stringify({ devices: state.devices.map(d => d.name + "@" + d.host), screens: state.sources.screen.length, windows: state.sources.window.length, settings: state.settings })');
      fs.writeFileSync(path.join(outDir, 'smoke.json'), JSON.stringify({ errors, summary: JSON.parse(summary || '{}') }, null, 2));
    } catch (err) {
      fs.writeFileSync(path.join(outDir, 'smoke.json'), JSON.stringify({ errors: [...errors, err.message] }, null, 2));
    }
    app.quit();
  });
}

app.setAppUserModelId('dev.fisal.castdesk');

app.whenReady().then(async () => {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const want = pendingCapture;
    desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
      const src = (want && sources.find((s) => s.id === want.sourceId)) || sources.find((s) => s.id.startsWith('screen:')) || sources[0];
      if (!src) { log('display media: no capture sources'); callback({}); return; }
      const result = { video: src };
      if (want && want.audio && request.audioRequested) result.audio = 'loopback';
      log(`display media: ${src.name} (${src.id})${result.audio ? ' + system audio' : ''}`);
      callback(result);
    }).catch((err) => { log('display media error: ' + err.message); callback({}); });
  }, { useSystemPicker: false });

  await server.start();
  discovery.start();
  for (const d of settings.get('manualDevices') || []) discovery.addManual(d.host, d.name);
  createWindow();
});

app.on('window-all-closed', () => {
  stopLive();
  live.stop();
  server.stop();
  caster.disconnect();
  discovery.stop();
  app.quit();
});

app.on('before-quit', () => { stopLive(); live.stop(); server.stop(); });
