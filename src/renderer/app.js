/* global castdesk */
'use strict';
const api = window.castdesk;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  settings: {},
  devices: [],
  cast: { connected: false, device: null, volume: null },
  status: null,
  image: null,            // { file, name, size }
  video: null,            // inspect result
  audio: null,            // inspect result for an audio file
  sources: { screen: [], window: [] },
  selected: { screen: null, window: null },
  live: null,             // { active, phase, title, url, plan, error }
  seeking: false,
};

// ---------------------------------------------------------------- helpers
const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;
// Redaction for documentation screenshots (CASTDESK_SMOKE_REDACT): generic names, synthetic thumbnails.
let REDACT = false;
const FAKE_THUMB = (hue) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},35%,28%)"/><stop offset="1" stop-color="hsl(${hue + 40},30%,14%)"/></linearGradient></defs><rect width="160" height="90" fill="url(#g)"/><rect x="18" y="16" width="124" height="58" rx="4" fill="rgba(255,255,255,.08)"/><rect x="26" y="24" width="70" height="6" rx="3" fill="rgba(255,255,255,.35)"/><rect x="26" y="36" width="100" height="4" rx="2" fill="rgba(255,255,255,.18)"/><rect x="26" y="46" width="84" height="4" rx="2" fill="rgba(255,255,255,.18)"/></svg>`)}`;
const redactDevice = (d) => (REDACT && d ? { ...d, name: 'Living Room TV', model: 'Google TV', host: '192.168.1.20' } : d);
const redactSource = (s, i) => (REDACT ? { ...s, name: s.kind === 'screen' ? s.name : `Window ${i + 1}`, icon: null, thumbnail: FAKE_THUMB(200 + i * 37) } : s);
function toast(text, type = 'info', ms = 4500) {
  if (REDACT) return; // toasts may carry real device names
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = text;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
function fmtBytes(n) { if (!n && n !== 0) return ''; const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return `${n.toFixed(i ? 1 : 0)} ${u[i]}`; }
function fmtTime(s) { if (!isFinite(s) || s < 0) s = 0; s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60; return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + `:${String(x).padStart(2, '0')}`; }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
async function guard(fn, label) {
  try { return await fn(); } catch (err) { console.error(label, err); toast(`${label ? label + ': ' : ''}${err.message || err}`, 'error', 7000); return undefined; }
}

// ---------------------------------------------------------------- navigation
function showPane(name) {
  $$('.nav').forEach((b) => b.classList.toggle('active', b.dataset.pane === name));
  $$('.pane').forEach((p) => p.classList.toggle('active', p.id === `pane-${name}`));
  if (name === 'screen' || name === 'window') loadSources(name);
  if (name === 'settings') loadAbout();
}
$$('.nav').forEach((b) => b.addEventListener('click', () => showPane(b.dataset.pane)));

// ---------------------------------------------------------------- settings binding
function bindSettings() {
  $$('[data-setting]').forEach((el) => {
    el.addEventListener('change', async () => {
      const key = el.dataset.setting;
      if (el.dataset.type === 'resolution') {
        // "WxH" presets cap both dimensions; plain numbers cap only the height.
        const m = /^(\d+)x(\d+)$/.exec(el.value);
        state.settings = await api.setSettings(m ? { maxWidth: Number(m[1]), maxHeight: Number(m[2]) } : { maxWidth: 0, maxHeight: Number(el.value) });
        renderSettings();
        return;
      }
      let value = el.type === 'checkbox' ? el.checked : el.value;
      if (el.dataset.type === 'number') value = Number(value);
      state.settings = await api.setSettings({ [key]: value });
      renderSettings();
      if (key === 'videoMode' && state.video) reinspectVideo();
    });
  });
}
function renderSettings() {
  $$('[data-setting]').forEach((el) => {
    if (el.dataset.type === 'resolution') {
      const s = state.settings;
      el.value = s.maxWidth ? `${s.maxWidth}x${s.maxHeight}` : String(s.maxHeight == null ? '' : s.maxHeight);
      return;
    }
    const v = state.settings[el.dataset.setting];
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v == null ? '' : String(v);
  });
  $('#videoMode').value = state.settings.videoMode || 'auto';
}

// ---------------------------------------------------------------- devices
function renderDevices() {
  const sel = $('#deviceSelect');
  const prev = sel.value || state.settings.lastDevice;
  sel.innerHTML = '';
  if (!state.devices.length) {
    sel.innerHTML = '<option value="">Searching for Cast devices…</option>';
  } else {
    for (const d of state.devices.map(redactDevice)) {
      const o = document.createElement('option');
      o.value = d.id;
      o.textContent = `${d.name} — ${d.model} (${d.host})`;
      sel.appendChild(o);
    }
  }
  if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
  renderCastState();
}
function renderCastState() {
  const c = state.cast;
  const pill = $('#connState');
  const btn = $('#btnConnect');
  if (c.connected && c.device) {
    pill.textContent = `Connected to ${redactDevice(c.device).name}`;
    pill.className = 'pill ok';
    btn.textContent = 'Disconnect';
    btn.classList.remove('primary');
    $('#deviceSelect').value = c.device.id;
  } else {
    pill.textContent = 'Not connected';
    pill.className = 'pill';
    btn.textContent = 'Connect';
    btn.classList.add('primary');
  }
  $('#deviceSelect').disabled = !!c.connected;
  const vol = c.volume;
  $('#volumeBar').disabled = !c.connected;
  $('#btnMute').disabled = !c.connected;
  if (vol && !state.seeking) {
    $('#volumeBar').value = Math.round((vol.level || 0) * 100);
    $('#btnMute').innerHTML = icon(vol.muted ? 'mute' : 'volume');
  }
}
$('#btnConnect').addEventListener('click', async () => {
  const btn = $('#btnConnect');
  if (state.cast.connected) { await guard(() => api.disconnectDevice(), 'Disconnect'); return; }
  const id = $('#deviceSelect').value;
  if (!id) { toast('No device selected. Wait for discovery or add one by IP.', 'error'); return; }
  btn.disabled = true; btn.textContent = 'Connecting…';
  const st = await guard(() => api.connectDevice(id), 'Connect');
  btn.disabled = false;
  if (st) { state.cast = st; renderCastState(); toast(`Connected to ${st.device.name}`, 'ok'); }
  else renderCastState();
});
$('#btnRefresh').addEventListener('click', async () => { state.devices = await api.refreshDevices(); renderDevices(); toast('Rescanning the network…'); });
$('#btnAddIp').addEventListener('click', () => { $('#addIpForm').classList.toggle('hidden'); $('#addIpHost').focus(); });
$('#addIpCancel').addEventListener('click', () => $('#addIpForm').classList.add('hidden'));
$('#addIpForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dev = await guard(() => api.addDevice($('#addIpHost').value, $('#addIpName').value), 'Add device');
  if (dev) { $('#addIpForm').classList.add('hidden'); state.devices = await api.listDevices(); renderDevices(); $('#deviceSelect').value = dev.id; }
});

// ---------------------------------------------------------------- files (image / video)
async function handleFile(kind, file) {
  if (!file) return;
  const info = await guard(() => api.inspectFile(file, { mode: $(kind === 'audio' ? '#audioMode' : '#videoMode').value }), 'Open file');
  if (!info) return;
  if (info.kind === 'image') {
    state.image = info;
    $('#imagePreview').src = 'file:///' + file.replace(/\\/g, '/');
    $('#imageName').textContent = info.name;
    $('#imageMeta').textContent = `${info.type} · ${fmtBytes(info.size)}`;
    $('#imageCard').classList.remove('hidden');
    $('#imageDrop').classList.add('hidden');
    showPane('image');
  } else if (info.kind === 'audio') {
    state.audio = info;
    renderAudio();
    showPane('audio');
  } else {
    state.video = info;
    renderVideo();
    showPane('video');
  }
}
function renderAudio() {
  const a = state.audio;
  if (!a) return;
  const s = a.summary;
  const tags = (s && s.tags) || {};
  $('#audioName').textContent = tags.title ? `${tags.title}${tags.artist ? ' — ' + tags.artist : ''}` : a.name;
  const rows = [['File', a.name], ['Size', fmtBytes(a.size)]];
  if (s) {
    if (tags.album) rows.push(['Album', tags.album]);
    if (s.duration) rows.push(['Duration', fmtTime(s.duration)]);
    const t = s.audio[0];
    if (t) rows.push(['Codec', `${t.codec} · ${t.channels}ch · ${t.sampleRate} Hz`]);
    if (s.bitrate) rows.push(['Bitrate', `${Math.round(s.bitrate / 1000)} kbps`]);
    rows.push(['Cover art', s.cover ? 'embedded (shown on TV)' : 'none']);
  } else if (a.probeError) rows.push(['Analysis', 'failed: ' + a.probeError]);
  $('#audioInfo').innerHTML = rows.map(([k, val]) => `<tr><td>${esc(k)}</td><td>${esc(val)}</td></tr>`).join('');
  const plan = a.plan || {};
  const pe = $('#audioPlan');
  pe.className = 'plan ' + (plan.direct ? 'direct' : 'transcode');
  pe.textContent = plan.direct ? `Direct play — ${plan.reason}` : `Convert — ${plan.reason}`;
  $('#audioCard').classList.remove('hidden');
  $('#audioDrop').classList.add('hidden');
}
async function reinspectAudio() {
  if (!state.audio) return;
  const info = await guard(() => api.inspectFile(state.audio.file, { mode: $('#audioMode').value }), 'Analyze');
  if (info) { state.audio = info; renderAudio(); }
}
$('#audioMode').addEventListener('change', reinspectAudio);
$('#btnCastAudio').addEventListener('click', async () => {
  if (!state.audio) return;
  const btn = $('#btnCastAudio');
  btn.disabled = true;
  const r = await guard(() => api.castFile(state.audio.file, { mode: $('#audioMode').value }), 'Cast audio');
  btn.disabled = false;
  if (r) toast(`Casting ${state.audio.name} (${r.mode === 'direct' ? 'direct play' : 'converting'})`, 'ok');
});
function renderVideo() {
  const v = state.video;
  if (!v) return;
  $('#videoName').textContent = v.name;
  const s = v.summary;
  const rows = [['Size', fmtBytes(v.size)], ['Type', v.type]];
  if (s) {
    if (s.duration) rows.push(['Duration', fmtTime(s.duration)]);
    if (s.video) rows.push(['Video', `${s.video.codec}${s.video.profile ? ' ' + s.video.profile : ''} · ${s.video.width}×${s.video.height}${s.video.fps ? ' @ ' + s.video.fps + ' fps' : ''}${s.video.pixFmt ? ' · ' + s.video.pixFmt : ''}`]);
    if (s.audio.length) rows.push(['Audio', s.audio.map((a) => `${a.codec} ${a.channels}ch${a.lang ? ' (' + a.lang + ')' : ''}`).join(', ')]);
    if (s.subtitles) rows.push(['Subtitles', `${s.subtitles} track(s) (not cast)`]);
    if (s.bitrate) rows.push(['Bitrate', `${Math.round(s.bitrate / 1000)} kbps`]);
  } else if (v.probeError) rows.push(['Analysis', 'failed: ' + v.probeError]);
  $('#videoInfo').innerHTML = rows.map(([k, val]) => `<tr><td>${esc(k)}</td><td>${esc(val)}</td></tr>`).join('');
  const at = $('#audioTrack');
  at.innerHTML = '';
  const tracks = (s && s.audio) || [];
  $('#audioTrackField').classList.toggle('hidden', tracks.length < 2);
  tracks.forEach((a, i) => { const o = document.createElement('option'); o.value = String(i); o.textContent = `${i + 1}: ${a.codec} ${a.channels}ch ${a.lang || ''} ${a.title || ''}`.trim(); at.appendChild(o); });
  const plan = v.plan || {};
  const pe = $('#videoPlan');
  pe.className = 'plan ' + (plan.direct ? 'direct' : 'transcode');
  pe.textContent = plan.direct ? `Direct play — ${plan.reason}` : `Transcode — ${plan.reason}`;
  $('#videoCard').classList.remove('hidden');
  $('#videoDrop').classList.add('hidden');
}
async function reinspectVideo() {
  if (!state.video) return;
  const info = await guard(() => api.inspectFile(state.video.file, { mode: $('#videoMode').value, audioIndex: Number($('#audioTrack').value || 0) }), 'Analyze');
  if (info) { state.video = info; renderVideo(); }
}
$('#videoMode').addEventListener('change', reinspectVideo);
$('#audioTrack').addEventListener('change', reinspectVideo);
$$('[data-open]').forEach((b) => b.addEventListener('click', async () => {
  const kind = b.dataset.open;
  const file = await api.openFile(kind);
  if (file) handleFile(kind, file);
}));
for (const zone of $$('.dropzone')) {
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) handleFile(zone.dataset.kind, api.pathFor(f)); });
}
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f && !e.target.closest('.dropzone')) handleFile(/^image\//.test(f.type) ? 'image' : /^audio\//.test(f.type) ? 'audio' : 'video', api.pathFor(f));
});
$('#btnCastImage').addEventListener('click', async () => {
  if (!state.image) return;
  const r = await guard(() => api.castFile(state.image.file, {}), 'Cast image');
  if (r) toast(`Casting ${state.image.name}`, 'ok');
});
$('#btnCastVideo').addEventListener('click', async () => {
  if (!state.video) return;
  const btn = $('#btnCastVideo');
  btn.disabled = true;
  const r = await guard(() => api.castFile(state.video.file, { mode: $('#videoMode').value, audioIndex: Number($('#audioTrack').value || 0) }), 'Cast video');
  btn.disabled = false;
  if (r) toast(`Casting ${state.video.name} (${r.mode === 'direct' ? 'direct play' : 'transcoding'})`, 'ok');
});

// ---------------------------------------------------------------- sources
async function loadSources(kind) {
  const grid = $(kind === 'screen' ? '#screenGrid' : '#windowGrid');
  if (!grid.children.length) grid.innerHTML = '<div class="empty">Loading…</div>';
  const list = await guard(() => api.listSources([kind]), 'List sources');
  if (!list) return;
  state.sources[kind] = list.filter((s) => s.kind === kind).map(redactSource);
  if (state.selected[kind] && !state.sources[kind].some((s) => s.id === state.selected[kind].id)) state.selected[kind] = null;
  if (!state.selected[kind] && kind === 'screen' && state.sources.screen.length) state.selected.screen = state.sources.screen.find((s) => s.display && s.display.primary) || state.sources.screen[0];
  renderSources(kind);
}
function renderSources(kind) {
  const grid = $(kind === 'screen' ? '#screenGrid' : '#windowGrid');
  const filter = kind === 'window' ? $('#windowFilter').value.trim().toLowerCase() : '';
  const list = state.sources[kind].filter((s) => !filter || s.name.toLowerCase().includes(filter));
  grid.innerHTML = '';
  if (!list.length) { grid.innerHTML = `<div class="empty">No ${kind === 'screen' ? 'displays' : 'windows'} found</div>`; return; }
  list.forEach((s, i) => {
    const el = document.createElement('div');
    el.className = 'source' + (state.selected[kind] && state.selected[kind].id === s.id ? ' selected' : '');
    const sub = s.display ? `${s.display.width}×${s.display.height}${s.display.primary ? ' · primary' : ''}` : '';
    el.innerHTML = `<div class="thumb">${s.thumbnail ? `<img src="${s.thumbnail}" alt="">` : 'no preview'}</div>
      <div class="label">${s.icon ? `<img src="${s.icon}" alt="">` : ''}<span title="${esc(s.name)}">${esc(kind === 'screen' ? `Display ${i + 1}` + (s.name && !/^screen/i.test(s.name) ? ` — ${s.name}` : '') : s.name)}</span></div>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ''}`;
    el.addEventListener('click', () => { state.selected[kind] = s; renderSources(kind); });
    el.addEventListener('dblclick', () => startMirror(kind));
    grid.appendChild(el);
  });
}
$('#windowFilter').addEventListener('input', () => renderSources('window'));
$$('[data-reload]').forEach((b) => b.addEventListener('click', () => loadSources(b.dataset.reload)));
$$('[data-start]').forEach((b) => b.addEventListener('click', () => startMirror(b.dataset.start)));
setInterval(() => {
  const active = $('.pane.active');
  if (!active || document.hidden) return;
  if (active.id === 'pane-screen') loadSources('screen');
  if (active.id === 'pane-window') loadSources('window');
}, 6000);

// ---------------------------------------------------------------- live mirroring (renderer side)
const capture = { stream: null, recorder: null, timer: null, canvasStream: null };

function pickMime(withAudio) {
  const list = withAudio
    ? ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2',
      'video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/mp4;codecs=avc1.640028', 'video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1',
      'video/webm;codecs=h264', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
  return list.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch (_) { return false; } }) || '';
}

async function getCaptureStream(sourceId, audio, fps) {
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: fps, max: fps } }, audio: !!audio });
  } catch (err) {
    console.warn('getDisplayMedia failed, using legacy desktop capture', err);
    return navigator.mediaDevices.getUserMedia({
      audio: audio ? { mandatory: { chromeMediaSource: 'desktop' } } : false,
      video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId, maxFrameRate: fps } },
    });
  }
}

async function startMirror(kind) {
  if (kind === 'audio') return startAudioStream();
  const src = state.selected[kind];
  if (!src) { toast(`Select a ${kind} first`, 'error'); return; }
  if (!state.cast.connected) { toast('Connect to a Cast device first', 'error'); return; }
  if (state.live && state.live.active) await stopMirror(false);
  const s = state.settings;
  const fps = Number(s.fps) || 30;
  const maxHeight = Number(s.maxHeight) || 0;
  const maxWidth = Number(s.maxWidth) || 0;
  const base = { engine: s.engine, sourceId: src.id, sourceName: src.name, kind, displayId: src.displayId, hwnd: src.hwnd, fps, maxHeight, maxWidth, audio: !!s.audio };
  const btns = $$('[data-start]');
  btns.forEach((b) => { b.disabled = true; });
  try {
    if (s.engine === 'gdigrab') {
      await api.liveStart(base);
      setLive({ active: true, phase: 'starting', title: `${kind === 'window' ? 'Window' : 'Screen'}: ${src.name}` });
      return;
    }
    await api.liveSelect({ sourceId: src.id, audio: !!s.audio });
    const stream = await getCaptureStream(src.id, !!s.audio, fps);
    capture.stream = stream;
    const vTrack = stream.getVideoTracks()[0];
    const aTrack = stream.getAudioTracks()[0] || null;
    if (!vTrack) throw new Error('No video track from capture');
    if (s.audio && !aTrack) toast('System audio was not available for this source; streaming video only', 'info');

    // Draw the captured frames onto a canvas at a fixed rate: MediaRecorder then always gets a
    // steady frame cadence (even on a static screen) and a fixed, even-sized resolution.
    const video = $('#livePreview');
    video.srcObject = stream;
    await video.play();
    await new Promise((r) => { if (video.videoWidth) r(); else video.onloadedmetadata = () => r(); });
    const vw = video.videoWidth || 1280, vh = video.videoHeight || 720;
    const scale = Math.min(1, maxHeight ? maxHeight / vh : 1, maxWidth ? maxWidth / vw : 1);
    const cw = Math.max(2, Math.round((vw * scale) / 2) * 2), ch = Math.max(2, Math.round((vh * scale) / 2) * 2);
    const canvas = $('#liveCanvas');
    canvas.width = cw; canvas.height = ch;
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    ctx.fillStyle = '#000';
    const draw = () => {
      const w = video.videoWidth || vw, h = video.videoHeight || vh;
      const f = Math.min(cw / w, ch / h);
      const dw = Math.round(w * f), dh = Math.round(h * f);
      if (dw !== cw || dh !== ch) ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(video, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
    };
    const cstream = canvas.captureStream(0);
    const cTrack = cstream.getVideoTracks()[0];
    if (aTrack) cstream.addTrack(aTrack);
    capture.canvasStream = cstream;
    capture.timer = setInterval(() => { draw(); cTrack.requestFrame(); }, 1000 / fps);

    const mime = pickMime(!!aTrack);
    if (!mime) throw new Error('MediaRecorder has no usable codec');
    // Auto bitrate follows the actual output height (ch), so box presets like 1024×768 that
    // end up width-limited (e.g. 1024×576 for a 16:9 screen) get a matching budget.
    const bitrate = (Number(s.bitrateKbps) || (ch <= 600 ? 3500 : ch <= 720 ? 4000 : ch <= 800 ? 5000 : ch <= 1080 ? 8000 : 12000) * (fps > 30 ? 1.4 : 1)) * 1000;
    const opts = { mimeType: mime, videoBitsPerSecond: bitrate, audioBitsPerSecond: 160000, videoKeyFrameIntervalDuration: 1000 };
    const rec = new MediaRecorder(cstream, opts);
    capture.recorder = rec;
    rec.ondataavailable = async (e) => { if (e.data && e.data.size && capture.recorder === rec) api.liveChunk(new Uint8Array(await e.data.arrayBuffer())); };
    rec.onerror = (e) => { toast(`Recorder error: ${(e.error && e.error.message) || e.message || 'unknown'}`, 'error'); stopMirror(); };
    vTrack.onended = () => { toast('The captured source was closed', 'info'); stopMirror(); };

    const res = await api.liveStart({ ...base, mime, hasAudio: !!aTrack, bitrateKbps: bitrate / 1000 });
    const title = `${kind === 'window' ? 'Window' : 'Screen'}: ${src.name}`;
    if (res.plan && res.plan.mode === 'mirror') {
      // Native Cast mirroring (the protocol Chrome uses). With the chromium engine this
      // same WGC capture feeds the TV: record it as VP8/WebM and pipe chunks to main,
      // which lifts out the frames and sends them over RTP.
      if (res.plan.engine === 'chromium') startMirrorRecorder(res.plan);
      setLive({ active: true, phase: 'mirroring', title, plan: res.plan, mime: 'vp8' });
    } else {
      rec.start(100);
      setLive({ active: true, phase: 'starting', title, plan: res.plan, mime });
    }
  } catch (err) {
    console.error(err);
    toast(`Mirroring failed: ${err.message || err}`, 'error', 8000);
    releaseCapture();
    await api.liveStop().catch(() => {});
    setLive(null);
  } finally {
    btns.forEach((b) => { b.disabled = false; });
  }
}

function pickAudioMime() {
  const list = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'];
  return list.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch (_) { return false; } }) || '';
}

// Stream the PC's system audio (WASAPI loopback via Chromium) without any video.
async function startAudioStream() {
  if (!state.cast.connected) { toast('Connect to a Cast device first', 'error'); return; }
  if (state.live && state.live.active) await stopMirror(false);
  const btns = $$('[data-start]');
  btns.forEach((b) => { b.disabled = true; });
  try {
    const screens = (await api.listSources(['screen'])) || [];
    const src = screens[0];
    if (!src) throw new Error('No screen source available for audio capture');
    await api.liveSelect({ sourceId: src.id, audio: true });
    const stream = await getCaptureStream(src.id, true, 1);
    capture.stream = stream;
    const aTrack = stream.getAudioTracks()[0];
    if (!aTrack) throw new Error('System audio capture is not available on this PC');
    const mime = pickAudioMime();
    if (!mime) throw new Error('MediaRecorder has no usable audio codec');
    const astream = new MediaStream([aTrack]);
    capture.canvasStream = astream;
    const rec = new MediaRecorder(astream, { mimeType: mime, audioBitsPerSecond: 192000 });
    capture.recorder = rec;
    rec.ondataavailable = async (e) => { if (e.data && e.data.size && capture.recorder === rec) api.liveChunk(new Uint8Array(await e.data.arrayBuffer())); };
    rec.onerror = (e) => { toast(`Recorder error: ${(e.error && e.error.message) || e.message || 'unknown'}`, 'error'); stopMirror(); };
    aTrack.onended = () => { toast('System audio capture ended', 'info'); stopMirror(); };
    const res = await api.liveStart({ engine: 'chromium', audioOnly: true, sourceId: src.id, sourceName: 'PC audio', kind: 'audio', mime, hasAudio: true });
    rec.start(250);
    setLive({ active: true, phase: 'starting', title: 'PC audio', plan: res.plan, mime, audioOnly: true });
  } catch (err) {
    console.error(err);
    toast(`Audio streaming failed: ${err.message || err}`, 'error', 8000);
    releaseCapture();
    await api.liveStop().catch(() => {});
    setLive(null);
  } finally {
    btns.forEach((b) => { b.disabled = false; });
  }
}

// VP8/WebM recorder feeding a Cast mirroring session. Long keyframe interval: the
// Cast transport NACKs lost packets, and main asks for a restart on picture loss.
function startMirrorRecorder(plan) {
  const track = capture.canvasStream && capture.canvasStream.getVideoTracks()[0];
  if (!track) { toast('Mirroring capture is not available', 'error'); stopMirror(); return; }
  capture.mirrorPlan = plan;
  const rec = new MediaRecorder(new MediaStream([track]), {
    mimeType: 'video/webm;codecs=vp8',
    videoBitsPerSecond: (plan.bitrateKbps || 4000) * 1000,
    videoKeyFrameIntervalDuration: 4000,
  });
  capture.recorder = rec;
  rec.ondataavailable = async (e) => { if (e.data && e.data.size && capture.recorder === rec) api.liveChunk(new Uint8Array(await e.data.arrayBuffer())); };
  rec.onerror = (e) => { toast(`Recorder error: ${(e.error && e.error.message) || e.message || 'unknown'}`, 'error'); stopMirror(); };
  rec.start(100);
}

api.on('live:keyframe', () => {
  const plan = capture.mirrorPlan;
  const rec = capture.recorder;
  if (!plan || !rec || !state.live || !state.live.active) return;
  capture.recorder = null;
  try { if (rec.state !== 'inactive') rec.stop(); } catch (_) { /* ignore */ }
  startMirrorRecorder(plan);
});

function releaseCapture() {
  if (capture.timer) clearInterval(capture.timer);
  capture.timer = null;
  const rec = capture.recorder;
  capture.recorder = null;
  try { if (rec && rec.state !== 'inactive') rec.stop(); } catch (_) { /* ignore */ }
  for (const st of [capture.stream, capture.canvasStream]) { if (st) st.getTracks().forEach((t) => { try { t.stop(); } catch (_) { /* ignore */ } }); }
  capture.stream = null; capture.canvasStream = null; capture.mirrorPlan = null;
  const video = $('#livePreview');
  video.srcObject = null;
}

async function stopMirror(notifyMain = true) {
  releaseCapture();
  if (notifyMain) await api.liveStop().catch(() => {});
  setLive(null);
}
$('#btnStopLive').addEventListener('click', () => stopMirror());

function setLive(live) {
  state.live = live;
  const bar = $('#liveBar');
  if (!live || !live.active) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  $('#liveTitle').textContent = live.title || 'Casting';
  $('#livePreview').classList.toggle('hidden', !!live.audioOnly);
  renderLiveStats(null);
}
function renderLiveStats(stats) {
  const l = state.live;
  if (!l || !l.active) return;
  const parts = [];
  parts.push(l.phase === 'playing' ? 'Playing on TV' : l.phase === 'mirroring' ? 'Mirroring to TV' : 'Starting…');
  if (l.plan && l.plan.mode === 'mirror') parts.push(`Cast mirroring · VP8 ${l.plan.width}×${l.plan.height}@${l.plan.fps}`);
  else if (l.plan && l.plan.audioOnly) parts.push(l.plan.mode === 'direct' ? 'AAC passthrough (no ffmpeg)' : 'audio → AAC via ffmpeg');
  else if (l.plan) parts.push(l.plan.mode === 'direct' ? 'H.264 passthrough (no ffmpeg)' : l.plan.mode === 'gdigrab' ? `GDI capture → ${l.plan.encoder}` : l.plan.videoCopy ? 'H.264 passthrough via ffmpeg' : `encode ${l.plan.encoder}`);
  if (stats && l.plan && l.plan.mode === 'mirror') {
    parts.push(`${stats.frames} frames · ${stats.resent} resent`);
    if (stats.playoutDelayMs != null) parts.push(`TV delay ${stats.playoutDelayMs}ms`);
    if (stats.feedbackAgoMs == null || stats.feedbackAgoMs > 3000) parts.push('waiting for TV feedback');
  } else if (stats) {
    const secs = Math.max(1, stats.uptimeMs / 1000);
    parts.push(`${fmtBytes(stats.bytes / secs)}/s · ${stats.fragments} fragments · ${fmtTime(secs)}`);
    parts.push(stats.clients ? `${stats.clients} viewer${stats.clients > 1 ? 's' : ''}` : 'waiting for the TV to connect');
  }
  $('#liveStats').textContent = parts.join(' · ');
}
setInterval(async () => {
  if (!state.live || !state.live.active) return;
  const st = await api.liveStats().catch(() => null);
  if (st) renderLiveStats(st);
}, 2000);

// ---------------------------------------------------------------- now playing
function renderStatus() {
  const st = state.status;
  const npState = $('#npState');
  const play = $('#btnPlayPause');
  const stop = $('#btnStop');
  const seek = $('#seekBar');
  if (!st || st.state === 'IDLE') {
    npState.textContent = st && st.idleReason ? `IDLE · ${st.idleReason}` : 'IDLE';
    npState.className = 'np-state';
    $('#npTitle').textContent = state.cast.connected ? 'Nothing is playing' : 'Not connected';
    play.disabled = true; stop.disabled = !state.live || !state.live.active; seek.disabled = true;
    play.innerHTML = icon('play');
    $('#npTime').textContent = '0:00'; $('#npDuration').textContent = '0:00';
    if (!state.seeking) seek.value = 0;
    return;
  }
  npState.textContent = st.state + (st.kind === 'live' ? ' · LIVE' : '') + (st.kind === 'audio' ? ' · AUDIO' : '');
  npState.className = 'np-state ' + (st.state === 'PLAYING' ? 'playing' : st.state === 'BUFFERING' ? 'buffering' : '');
  $('#npTitle').textContent = st.title || st.contentId;
  play.disabled = false;
  play.innerHTML = icon(st.state === 'PLAYING' || st.state === 'BUFFERING' ? 'pause' : 'play');
  stop.disabled = false;
  const pos = (st.offset || 0) + (st.currentTime || 0);
  const dur = st.knownDuration || st.duration || 0;
  const seekable = st.seekable && dur > 0;
  seek.disabled = !seekable;
  if (!state.seeking) seek.value = seekable ? Math.round((pos / dur) * 1000) : 0;
  $('#npTime').textContent = fmtTime(pos);
  $('#npDuration').textContent = dur ? fmtTime(dur) : (st.kind === 'live' ? 'LIVE' : '--:--');
}
$('#btnPlayPause').addEventListener('click', () => {
  const st = state.status;
  if (!st) return;
  guard(() => api.player(st.state === 'PLAYING' || st.state === 'BUFFERING' ? 'pause' : 'play'), 'Player');
});
$('#btnStop').addEventListener('click', async () => {
  if (state.live && state.live.active) await stopMirror();
  else await guard(() => api.player('stop'), 'Stop');
});
const seekBar = $('#seekBar');
seekBar.addEventListener('pointerdown', () => { state.seeking = true; });
seekBar.addEventListener('input', () => {
  const st = state.status;
  const dur = st ? (st.knownDuration || st.duration || 0) : 0;
  $('#npTime').textContent = fmtTime((seekBar.value / 1000) * dur);
});
seekBar.addEventListener('change', async () => {
  const st = state.status;
  const dur = st ? (st.knownDuration || st.duration || 0) : 0;
  state.seeking = false;
  if (dur) await guard(() => api.player('seek', (seekBar.value / 1000) * dur), 'Seek');
});
$('#volumeBar').addEventListener('change', () => guard(() => api.player('volume', $('#volumeBar').value / 100), 'Volume'));
$('#btnMute').addEventListener('click', () => guard(() => api.player('mute', !(state.cast.volume && state.cast.volume.muted)), 'Mute'));

// ---------------------------------------------------------------- log & about
function appendLog(line) {
  const el = $('#log');
  el.textContent += line + '\n';
  if (el.textContent.length > 200000) el.textContent = el.textContent.slice(-150000);
  el.scrollTop = el.scrollHeight;
}
$('#btnClearLog').addEventListener('click', () => { $('#log').textContent = ''; });
async function loadAbout() {
  const info = await api.appInfo();
  const rows = [
    ['Version', `${info.version} (Electron ${info.electron}, Chromium ${info.chrome})`],
    ['Media server port', String(info.port)],
    ['Local IPv4', info.interfaces.map((i) => `${i.address} (${i.name})`).join(', ') || 'none'],
    ['ffmpeg', info.ffmpeg],
  ];
  $('#aboutInfo').innerHTML = rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
}

// ---------------------------------------------------------------- events from main
api.on('devices:update', (list) => { state.devices = list; renderDevices(); });
api.on('cast:state', (st) => { state.cast = st; renderCastState(); renderStatus(); });
api.on('player:status', (st) => { state.status = st; renderStatus(); });
api.on('toast', (t) => toast(t.text, t.type || 'info'));
api.on('log', appendLog);
api.on('live:status', (ls) => {
  if (ls.error) { toast(ls.error, 'error', 9000); releaseCapture(); setLive(null); return; }
  if (!ls.active) { if (state.live && state.live.active) { releaseCapture(); setLive(null); } return; }
  setLive({ ...(state.live || {}), ...ls });
});
api.on('live:stats', renderLiveStats);

// ---------------------------------------------------------------- init
(async function init() {
  state.settings = await api.getSettings();
  bindSettings();
  renderSettings();
  const info = await api.appInfo();
  REDACT = !!info.redact;
  for (const line of info.logs || []) appendLog(line);
  state.cast = info.castState || state.cast;
  state.devices = await api.listDevices();
  renderDevices();
  renderCastState();
  renderStatus();
  showPane('screen');
  window.addEventListener('beforeunload', () => releaseCapture());
})();
