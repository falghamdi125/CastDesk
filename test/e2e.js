'use strict';
// End-to-end pipeline test that does not need a Cast device:
//   producer window (Chromium capture + MediaRecorder) → LiveManager → HTTP → consumer window <video>
// plus gdigrab live, file transcode and direct-play-with-ranges. Run: npx electron test/e2e.js
const { app, BrowserWindow, ipcMain, session, desktopCapturer } = require('electron');
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { MediaServer } = require('../src/main/server');
const { LiveManager } = require('../src/main/live');
const ff = require('../src/main/ffmpeg');

const FIX = path.join(__dirname, 'fixtures');
const log = (m) => console.log(`[e2e] ${m}`);
const server = new MediaServer((m) => console.log('  [server] ' + m));
const live = new LiveManager({ server, log: (m) => console.log('  [live] ' + m) });
const results = [];
function record(name, ok, detail) { results.push({ name, ok }); log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' :: ' + detail : ''}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ensureFixtures() {
  fs.mkdirSync(FIX, { recursive: true });
  const mp4 = path.join(FIX, 'test.mp4');
  const mkv = path.join(FIX, 'test.mkv');
  const png = path.join(FIX, 'test.png');
  if (!fs.existsSync(mp4)) execFileSync(ff.ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30', '-f', 'lavfi', '-i', 'sine=f=440', '-t', '12', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', mp4]);
  if (!fs.existsSync(mkv)) execFileSync(ff.ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=30', '-f', 'lavfi', '-i', 'sine=f=440', '-t', '12', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', mkv]);
  if (!fs.existsSync(png)) execFileSync(ff.ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=800x600', '-frames:v', '1', png]);
  const mp3 = path.join(FIX, 'test.mp3');
  const alac = path.join(FIX, 'test-alac.m4a');
  if (!fs.existsSync(mp3)) execFileSync(ff.ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440', '-t', '12', '-c:a', 'libmp3lame', '-b:a', '128k', '-metadata', 'title=Sine Test', '-metadata', 'artist=CastDesk', mp3]);
  if (!fs.existsSync(alac)) execFileSync(ff.ffmpegPath, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=f=440', '-t', '12', '-c:a', 'alac', alac]);
  return { mp4, mkv, png, mp3, alac };
}

async function playInConsumer(url, seconds) {
  const w = new BrowserWindow({ show: true, width: 480, height: 300, title: 'CastDesk e2e consumer', webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  const done = new Promise((resolve) => {
    const t = setTimeout(() => resolve({ timeout: true }), (seconds + 15) * 1000);
    ipcMain.once('consumer:done', (_e, r) => { clearTimeout(t); resolve(r); });
  });
  await w.loadFile(path.join(__dirname, 'consumer.html'), { query: { src: url, secs: String(seconds) } });
  const r = await done;
  w.destroy();
  return r;
}

let producer;
async function liveChromiumTest(name, { mime, passthrough, audio, sourceId }) {
  const { token, plan } = await live.start({ engine: 'chromium', mime, passthrough, fps: 30, maxHeight: 720, bitrateKbps: 4000, encoder: 'auto' });
  let cap;
  try {
    cap = await producer.webContents.executeJavaScript(`window.startCapture(${JSON.stringify({ mime, fps: 30, maxHeight: 720, audio, sourceId })})`);
    log(`${name}: capture ${JSON.stringify(cap)} plan=${JSON.stringify(plan)}`);
    await live.waitForFirstFragment(25000);
    const r = await playInConsumer(server.urlFor('live', token, '127.0.0.1'), 8);
    const st = live.stats();
    const capStats = await producer.webContents.executeJavaScript('window.captureStats()');
    const lag = st.mediaTime - (r.currentTime || 0);
    record(name, !r.timeout && !r.error && r.maxCurrentTime >= 3 && r.videoWidth > 0,
      `plan=${plan.mode}/${plan.encoder} played=${r.maxCurrentTime && r.maxCurrentTime.toFixed(1)}s ${r.videoWidth}x${r.videoHeight} frag=${st.fragments} key=${st.keyFragments} gap=${st.fragGapMs}ms first=${r.firstFrameMs}ms lag=${lag.toFixed(1)}s out=${(st.bytes / 1024) | 0}KB in=${(capStats.bytes / 1024) | 0}KB err=${r.error || '-'} events=${r.events}`);
  } catch (err) {
    record(name, false, err.message);
  } finally {
    try { await producer.webContents.executeJavaScript('window.stopCapture()'); } catch (_) { /* ignore */ }
    live.stop();
    await sleep(500);
  }
}

// The Cast device connects seconds after the stream started: the retained backlog must give it
// an instant keyframe-aligned start, and the stream-time anchor (clientBase) must line up with
// the element's clock so the lag estimate the catch-up controller uses is sane.
async function liveLateJoinTest(name, { mime, sourceId }) {
  const { token } = await live.start({ engine: 'chromium', mime, passthrough: true, fps: 30, maxHeight: 720, bitrateKbps: 4000, encoder: 'auto' });
  try {
    await producer.webContents.executeJavaScript(`window.startCapture(${JSON.stringify({ mime, fps: 30, maxHeight: 720, audio: false, sourceId })})`);
    await live.waitForFirstFragment(25000);
    await sleep(4000);
    const r = await playInConsumer(server.urlFor('live', token, '127.0.0.1'), 6);
    const st = live.stats();
    const lag = st.mediaTime - (r.currentTime || 0);   // Chromium reports absolute stream time
    record(name, !r.timeout && !r.error && r.videoWidth > 0 && r.maxCurrentTime >= 2 && r.firstFrameMs != null && r.firstFrameMs < 3000 && lag > -1 && lag < 4.5,
      `first=${r.firstFrameMs}ms lag=${lag.toFixed(1)}s played=${r.maxCurrentTime && r.maxCurrentTime.toFixed(1)}s frag=${st.fragments} gap=${st.fragGapMs}ms backlog=${st.backlog} base=${st.clientBase != null ? st.clientBase.toFixed(1) : '-'} err=${r.error || '-'}`);
  } catch (err) {
    record(name, false, err.message);
  } finally {
    try { await producer.webContents.executeJavaScript('window.stopCapture()'); } catch (_) { /* ignore */ }
    live.stop();
    await sleep(500);
  }
}

app.whenReady().then(async () => {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).then((sources) => {
      const result = { video: sources[0] };
      if (request.audioRequested) result.audio = 'loopback';
      callback(result);
    });
  }, { useSystemPicker: false });

  const fixtures = ensureFixtures();
  await server.start();
  ipcMain.on('chunk', (_e, u8) => live.chunk(Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength)));

  producer = new BrowserWindow({ show: false, webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  await producer.loadFile(path.join(__dirname, 'producer.html'));
  const support = await producer.webContents.executeJavaScript('window.mimeSupport()');
  Object.assign(support, await producer.webContents.executeJavaScript('window.audioMimeSupport()'));
  log('MediaRecorder support: ' + JSON.stringify(support, null, 1));
  const screens = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const sourceId = screens[0] && screens[0].id;

  const best = (list) => list.find((m) => support[m]);
  const mp4Mime = best(['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2']);
  const webmH264 = best(['video/webm;codecs=h264,opus']);
  const webmVp8 = best(['video/webm;codecs=vp8,opus']);
  const anyMime = mp4Mime || webmH264 || best(['video/webm;codecs=vp9,opus']) || webmVp8;

  // A: best mime with passthrough (direct if mp4/h264/aac, otherwise ffmpeg copy or encode)
  await liveChromiumTest('live chromium (best mime, passthrough)', { mime: anyMime, passthrough: true, audio: true, sourceId });
  // A2: late joiner gets the backlog and starts near the live edge
  await liveLateJoinTest('live late join (backlog)', { mime: anyMime, sourceId });
  // B: force ffmpeg re-encode from the same mime
  await liveChromiumTest('live chromium (ffmpeg re-encode)', { mime: anyMime, passthrough: false, audio: true, sourceId });
  // C: webm/h264 passthrough through ffmpeg remux
  if (webmH264 && webmH264 !== anyMime) await liveChromiumTest('live chromium (webm h264 → ffmpeg copy)', { mime: webmH264, passthrough: true, audio: true, sourceId });
  // D: vp8 transcode
  if (webmVp8) await liveChromiumTest('live chromium (webm vp8 → ffmpeg encode)', { mime: webmVp8, passthrough: true, audio: false, sourceId });

  // E: gdigrab engine
  try {
    const { token, plan } = await live.start({ engine: 'gdigrab', target: 'desktop', region: null, fps: 30, maxHeight: 720, bitrateKbps: 4000, encoder: 'auto' });
    await live.waitForFirstFragment(25000);
    const r = await playInConsumer(server.urlFor('live', token, '127.0.0.1'), 6);
    const st = live.stats();
    record('live gdigrab', !r.timeout && !r.error && r.maxCurrentTime >= 2, `encoder=${plan.encoder} played=${r.maxCurrentTime && r.maxCurrentTime.toFixed(1)}s frag=${st.fragments} key=${st.keyFragments} err=${r.error || '-'}`);
  } catch (err) { record('live gdigrab', false, err.message); }
  live.stop();

  // F: file transcode (mkv + ac3 → copy video, encode audio) with seek offset
  try {
    const summary = ff.summarize(await ff.probe(fixtures.mkv));
    const plan = ff.planFile(summary, fixtures.mkv, { mode: 'auto' });
    const encoder = plan.videoCopy ? 'copy' : await ff.resolveEncoder('auto', log);
    const token = server.registerTranscode((ss) => ff.spawnFileTranscode({ file: fixtures.mkv, ss, videoCopy: plan.videoCopy, audioCopy: plan.audioCopy, encoder, bitrateKbps: 4000, hasAudio: true }, (m) => console.log('  [ffmpeg] ' + m)));
    const r = await playInConsumer(server.urlFor('tx', token, '127.0.0.1', 'ss=4'), 5);
    record('file transcode mkv/ac3 (ss=4)', !r.timeout && !r.error && r.maxCurrentTime >= 3, `plan=${JSON.stringify(plan)} played=${r.maxCurrentTime && r.maxCurrentTime.toFixed(1)}s err=${r.error || '-'}`);
    server.unregister(token);
    // full re-encode path
    const enc2 = await ff.resolveEncoder('auto', log);
    const token2 = server.registerTranscode((ss) => ff.spawnFileTranscode({ file: fixtures.mkv, ss, videoCopy: false, audioCopy: false, encoder: enc2, bitrateKbps: 4000, hasAudio: true }, (m) => console.log('  [ffmpeg] ' + m)));
    const r2 = await playInConsumer(server.urlFor('tx', token2, '127.0.0.1'), 5);
    record(`file transcode full re-encode (${enc2})`, !r2.timeout && !r2.error && r2.maxCurrentTime >= 3, `played=${r2.maxCurrentTime && r2.maxCurrentTime.toFixed(1)}s err=${r2.error || '-'}`);
    server.unregister(token2);
  } catch (err) { record('file transcode', false, err.message); }

  // G: direct play with range requests + seek
  try {
    const summary = ff.summarize(await ff.probe(fixtures.mp4));
    const plan = ff.planFile(summary, fixtures.mp4, { mode: 'auto' });
    const token = server.registerFile(fixtures.mp4);
    const r = await playInConsumer(server.urlFor('media', token, '127.0.0.1') + '#seek=6', 5);
    record('file direct play mp4 (+seek)', plan.direct && !r.timeout && !r.error && r.maxCurrentTime >= 8, `plan=${JSON.stringify(plan)} played=${r.maxCurrentTime && r.maxCurrentTime.toFixed(1)}s err=${r.error || '-'}`);
    server.unregister(token);
  } catch (err) { record('file direct', false, err.message); }

  // H: image served with correct type
  try {
    const token = server.registerFile(fixtures.png);
    const res = await fetch(server.urlFor('media', token, '127.0.0.1'));
    const buf = Buffer.from(await res.arrayBuffer());
    record('image serve', res.status === 200 && res.headers.get('content-type') === 'image/png' && buf.length > 1000, `${res.status} ${res.headers.get('content-type')} ${buf.length}B`);
    const part = await fetch(server.urlFor('media', token, '127.0.0.1'), { headers: { Range: 'bytes=0-99' } });
    record('range request', part.status === 206 && part.headers.get('content-range') === `bytes 0-99/${buf.length}`, `${part.status} ${part.headers.get('content-range')}`);
  } catch (err) { record('image serve', false, err.message); }

  // I: audio files — direct mp3 (plan + tags) and ALAC → AAC transcode with seek offset
  try {
    const s1 = ff.summarize(await ff.probe(fixtures.mp3));
    const p1 = ff.planAudioFile(s1, fixtures.mp3, { mode: 'auto' });
    const t1 = server.registerFile(fixtures.mp3);
    const r1 = await playInConsumer(server.urlFor('media', t1, '127.0.0.1'), 4);
    record('audio direct mp3', p1.direct && s1.tags.title === 'Sine Test' && !r1.timeout && !r1.error && r1.maxCurrentTime >= 3, `plan=${JSON.stringify(p1)} tags=${JSON.stringify(s1.tags)} played=${r1.maxCurrentTime && r1.maxCurrentTime.toFixed(1)}s err=${r1.error || '-'}`);
    server.unregister(t1);
    const s2 = ff.summarize(await ff.probe(fixtures.alac));
    const p2 = ff.planAudioFile(s2, fixtures.alac, { mode: 'auto' });
    const t2 = server.registerTranscode((ss) => ff.spawnAudioTranscode({ file: fixtures.alac, ss, audioCopy: p2.audioCopy }, (m) => console.log('  [ffmpeg] ' + m)), 'audio/mp4');
    const r2 = await playInConsumer(server.urlFor('tx', t2, '127.0.0.1', 'ss=5'), 4);
    record('audio transcode alac → aac (ss=5)', !p2.direct && !r2.timeout && !r2.error && r2.maxCurrentTime >= 3, `plan=${JSON.stringify(p2)} played=${r2.maxCurrentTime && r2.maxCurrentTime.toFixed(1)}s err=${r2.error || '-'}`);
    server.unregister(t2);
  } catch (err) { record('audio files', false, err.message); }

  // J: live system-audio-only stream
  try {
    const audioMime = best(['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm']);
    const { token, plan } = await live.start({ engine: 'chromium', audioOnly: true, mime: audioMime });
    const cap = await producer.webContents.executeJavaScript(`window.startAudioCapture(${JSON.stringify({ mime: audioMime, sourceId })})`);
    await live.waitForFirstFragment(25000);
    const r = await playInConsumer(server.urlFor('live', token, '127.0.0.1'), 6);
    const st = live.stats();
    record('live audio only', !r.timeout && !r.error && r.maxCurrentTime >= 3, `mime=${audioMime} cap=${JSON.stringify(cap)} plan=${JSON.stringify(plan)} played=${r.maxCurrentTime && r.maxCurrentTime.toFixed(1)}s frag=${st.fragments} err=${r.error || '-'}`);
    await producer.webContents.executeJavaScript('window.stopCapture()');
  } catch (err) { record('live audio only', false, err.message); }
  live.stop();

  const failed = results.filter((r) => !r.ok);
  log(`---- ${results.length - failed.length}/${results.length} passed ----`);
  producer.destroy();
  server.stop();
  app.exit(failed.length ? 1 : 0);
}).catch((err) => { console.error(err); app.exit(2); });
