'use strict';
// ffmpeg / ffprobe helpers: probing, direct-play decisions, encoder detection and
// argument builders for the three pipelines (file transcode, live-from-pipe, gdigrab).
const { spawn, execFile } = require('child_process');
const path = require('path');
const crypto = require('crypto');

function unpacked(p) { return p && p.includes('app.asar') ? p.replace('app.asar', 'app.asar.unpacked') : p; }
let ffmpegPath = 'ffmpeg';
let ffprobePath = 'ffprobe';
try { ffmpegPath = unpacked(require('ffmpeg-static')); } catch (_) { /* fall back to PATH */ }
try { ffprobePath = unpacked(require('ffprobe-static').path); } catch (_) { /* fall back to PATH */ }

// Codecs the Google Cast default receiver plays natively.
const DIRECT_VIDEO = new Set(['h264', 'vp8', 'vp9']);
const OPTIONAL_VIDEO = new Set(['hevc', 'av1']);            // Google TV / Chromecast Ultra only
const DIRECT_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const MP4_COPY_AUDIO = new Set(['aac', 'mp3']);              // safe to copy into an MP4 container
const DIRECT_CONTAINERS = new Set(['.mp4', '.m4v', '.mov', '.webm']);

const FRAG_FLAGS = ['-movflags', '+frag_keyframe+empty_moov+default_base_moof'];
// Live pipelines fragment on every frame: the muxer never sits on up to a GOP of latency.
const LIVE_FRAG_FLAGS = ['-movflags', '+frag_every_frame+empty_moov+default_base_moof'];

function probe(file) {
  return new Promise((resolve, reject) => {
    execFile(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        if (err) return reject(new Error('ffprobe failed: ' + (err.message || err)));
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('ffprobe output unreadable')); }
      });
  });
}

function summarize(info) {
  const streams = info.streams || [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const subs = streams.filter((s) => s.codec_type === 'subtitle');
  const fps = v && v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? (() => { const [n, d] = v.avg_frame_rate.split('/').map(Number); return d ? +(n / d).toFixed(2) : null; })() : null;
  const tags = (info.format && info.format.tags) || {};
  const tag = (k) => { const key = Object.keys(tags).find((x) => x.toLowerCase() === k); return key ? String(tags[key]) : ''; };
  const cover = streams.find((s) => s.codec_type === 'video' && s.disposition && s.disposition.attached_pic);
  return {
    tags: { title: tag('title'), artist: tag('artist') || tag('album_artist'), album: tag('album') },
    cover: cover ? { codec: cover.codec_name, index: cover.index } : null,
    duration: parseFloat((info.format && info.format.duration) || (v && v.duration) || 0) || 0,
    size: parseInt((info.format && info.format.size) || 0, 10),
    bitrate: parseInt((info.format && info.format.bit_rate) || 0, 10),
    formatName: (info.format && info.format.format_name) || '',
    video: v ? { codec: v.codec_name, profile: v.profile, level: v.level, width: v.width, height: v.height, pixFmt: v.pix_fmt, fps } : null,
    audio: audio.map((a, i) => ({ index: i, codec: a.codec_name, channels: a.channels, sampleRate: a.sample_rate, lang: (a.tags && (a.tags.language || a.tags.LANGUAGE)) || '', title: (a.tags && a.tags.title) || '' })),
    subtitles: subs.length,
  };
}

// Decide how to play a video file. mode: 'auto' | 'direct' | 'transcode'.
function planFile(summary, file, { mode = 'auto', allowHevc = false, audioIndex = 0 } = {}) {
  const ext = path.extname(file).toLowerCase();
  const v = summary.video;
  const a = summary.audio[audioIndex] || summary.audio[0] || null;
  const vOk = !!v && (DIRECT_VIDEO.has(v.codec) || (allowHevc && OPTIONAL_VIDEO.has(v.codec)))
    && (!v.pixFmt || /yuv420p$/.test(v.pixFmt)) && !(v.codec === 'h264' && v.level > 51);
  const aOk = !a || DIRECT_AUDIO.has(a.codec);
  const reasons = [];
  if (!v) reasons.push('no video stream');
  else if (!vOk) reasons.push(`video ${v.codec}${v.pixFmt ? '/' + v.pixFmt : ''} not supported by the receiver`);
  if (a && !aOk) reasons.push(`audio ${a.codec} not supported`);
  if (!DIRECT_CONTAINERS.has(ext)) reasons.push(`container ${ext || '?'} needs remuxing`);

  if (mode === 'direct') return { direct: true, reason: 'forced direct play' };
  if (mode === 'auto' && vOk && aOk && DIRECT_CONTAINERS.has(ext) && audioIndex === 0) return { direct: true, reason: 'codecs supported natively' };
  const videoCopy = mode !== 'transcode' && vOk && v && v.codec !== 'vp8';
  const audioCopy = mode !== 'transcode' && !!a && MP4_COPY_AUDIO.has(a.codec) && (a.channels || 2) <= 6;
  const what = [videoCopy ? 'copy video' : 'encode video', a ? (audioCopy ? 'copy audio' : 'encode audio') : 'no audio'].join(', ');
  return { direct: false, videoCopy, audioCopy, audioIndex, reason: (reasons.length ? reasons.join('; ') : 'forced transcode') + ` → ${what}` };
}

// ---- audio files -------------------------------------------------------------------------
const DIRECT_AUDIO_FILE = new Set(['mp3', 'aac', 'flac', 'opus', 'vorbis', 'pcm_s16le', 'pcm_s24le']);
const DIRECT_AUDIO_CONTAINERS = new Set(['.mp3', '.m4a', '.mp4', '.flac', '.wav', '.ogg', '.oga', '.opus']);

// Decide how to play an audio file. mode: 'auto' | 'direct' | 'transcode'.
function planAudioFile(summary, file, { mode = 'auto', audioIndex = 0 } = {}) {
  const ext = path.extname(file).toLowerCase();
  const a = summary.audio[audioIndex] || summary.audio[0] || null;
  if (!a) return { direct: false, audioCopy: false, audioIndex, reason: 'no audio stream found' };
  const ok = DIRECT_AUDIO_FILE.has(a.codec) && DIRECT_AUDIO_CONTAINERS.has(ext) && audioIndex === 0
    && !(a.codec.startsWith('pcm') && parseInt(a.sampleRate, 10) > 48000);
  if (mode === 'direct') return { direct: true, reason: 'forced direct play' };
  if (mode === 'auto' && ok) return { direct: true, reason: `${a.codec} plays natively` };
  const audioCopy = mode !== 'transcode' && a.codec === 'aac';
  const why = ok ? 'forced transcode' : `${a.codec}${ext ? ' in ' + ext : ''} is not supported natively`;
  return { direct: false, audioCopy, audioIndex, reason: `${why} → ${audioCopy ? 'remux to MP4' : 'encode AAC'}` };
}

// Audio file → audio-only fragmented MP4 on stdout, starting at `ss` seconds.
function spawnAudioTranscode({ file, ss = 0, audioCopy, audioIndex = 0 }, log) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (ss > 0) args.push('-ss', String(ss));
  args.push('-i', file, '-map', `0:a:${audioIndex}`, '-vn', '-sn', '-dn');
  if (audioCopy) args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-b:a', '256k', '-ar', '48000', '-ac', '2');
  args.push('-f', 'mp4', ...FRAG_FLAGS, '-frag_duration', '1000000', 'pipe:1');
  return spawnFfmpeg(args, log, 'audio');
}

// Extract embedded cover art (from summarize().cover) to outDir; resolves to the file path or null.
function extractCoverArt(file, cover, outDir) {
  return new Promise((resolve) => {
    if (!cover) return resolve(null);
    const copy = cover.codec === 'mjpeg' || cover.codec === 'png';
    const ext = cover.codec === 'png' ? '.png' : '.jpg';
    const out = path.join(outDir, `castdesk-cover-${crypto.createHash('md5').update(file).digest('hex')}${ext}`);
    const args = ['-y', '-v', 'error', '-i', file, '-map', `0:${cover.index}`, '-an', ...(copy ? ['-c:v', 'copy'] : ['-c:v', 'mjpeg', '-q:v', '3']), '-frames:v', '1', '-f', 'image2', out];
    execFile(ffmpegPath, args, { windowsHide: true }, (err) => resolve(err ? null : out));
  });
}

// ---- encoders ----------------------------------------------------------------------------
const HW_CANDIDATES = ['h264_nvenc', 'h264_qsv', 'h264_amf'];
const encoderCache = new Map();

function testEncoder(enc) {
  if (encoderCache.has(enc)) return encoderCache.get(enc);
  const p = new Promise((resolve) => {
    const args = ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=320x240:d=0.2:r=30', '-frames:v', '3',
      ...encoderArgs(enc, { mode: 'live', gop: 30, bitrateKbps: 1000 }), '-f', 'null', '-'];
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    const t = setTimeout(() => { try { child.kill(); } catch (_) { /* ignore */ } resolve(false); }, 20000);
    child.on('error', () => { clearTimeout(t); resolve(false); });
    child.on('exit', (code) => { clearTimeout(t); resolve(code === 0); });
  });
  encoderCache.set(enc, p);
  return p;
}

// preference: 'auto' | 'software' | one of HW_CANDIDATES
async function resolveEncoder(preference, log) {
  if (preference === 'software') return 'libx264';
  const list = preference && preference !== 'auto' ? [preference] : HW_CANDIDATES;
  for (const enc of list) {
    if (await testEncoder(enc)) return enc;
    if (log) log(`encoder ${enc} unavailable`);
  }
  return 'libx264';
}

function encoderArgs(enc, { mode, gop, bitrateKbps }) {
  const live = mode === 'live';
  const b = Math.max(500, Math.round(bitrateKbps || 6000));
  const g = String(gop || 30);
  const rate = live
    ? ['-b:v', `${b}k`, '-maxrate', `${b}k`, '-bufsize', `${b * 2}k`]
    : ['-b:v', `${b}k`, '-maxrate', `${Math.round(b * 1.5)}k`, '-bufsize', `${b * 3}k`];
  switch (enc) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', live ? 'p3' : 'p4', '-tune', live ? 'll' : 'hq', '-rc', live ? 'cbr' : 'vbr',
        ...rate, '-g', g, '-bf', '0', '-profile:v', 'high', '-pix_fmt', 'yuv420p', ...(live ? ['-zerolatency', '1', '-delay', '0'] : [])];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', live ? 'veryfast' : 'medium', ...rate, '-g', g, '-bf', '0', '-pix_fmt', 'nv12',
        ...(live ? ['-async_depth', '1'] : [])];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-usage', live ? 'lowlatency' : 'transcoding', '-quality', live ? 'speed' : 'balanced', '-rc', 'cbr',
        ...rate, '-g', g, '-bf', '0', '-pix_fmt', 'yuv420p'];
    default:
      return ['-c:v', 'libx264', '-preset', live ? 'ultrafast' : 'veryfast', ...(live ? ['-tune', 'zerolatency'] : []),
        '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p', '-g', g, '-keyint_min', g, '-sc_threshold', '0', ...rate];
  }
}

// Even dimensions are mandatory for yuv420p; cap height (and optionally width) when requested.
function scaleFilter(maxHeight, maxWidth) {
  if (maxWidth) return `scale=w='min(${maxWidth},iw)':h='min(${maxHeight || 4320},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`;
  if (!maxHeight || maxHeight >= 4320) return 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
  return `scale=-2:'trunc(min(${maxHeight},ih)/2)*2'`;
}

function spawnFfmpeg(args, log, tag) {
  const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderrTail = [];
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => {
    for (const line of d.split(/\r?\n/)) {
      if (!line.trim()) continue;
      child.stderrTail.push(line);
      if (child.stderrTail.length > 40) child.stderrTail.shift();
      if (log) log(`[ffmpeg ${tag}] ${line}`);
    }
  });
  child.on('error', (e) => log && log(`[ffmpeg ${tag}] spawn error: ${e.message}`));
  child.stdin.on('error', () => {});
  return child;
}

// File → fragmented MP4 on stdout, starting at `ss` seconds.
function spawnFileTranscode({ file, ss = 0, videoCopy, audioCopy, audioIndex = 0, encoder = 'libx264', bitrateKbps = 8000, hasAudio = true }, log) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (ss > 0) args.push('-ss', String(ss));
  args.push('-i', file, '-map', '0:v:0');
  if (hasAudio) args.push('-map', `0:a:${audioIndex}?`);
  args.push('-sn', '-dn');
  if (videoCopy) args.push('-c:v', 'copy');
  else args.push('-vf', scaleFilter(0), ...encoderArgs(encoder, { mode: 'file', gop: 48, bitrateKbps }));
  if (hasAudio) {
    if (audioCopy) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000');
  }
  args.push('-f', 'mp4', ...FRAG_FLAGS, '-frag_duration', '1000000', 'pipe:1');
  return spawnFfmpeg(args, log, 'file');
}

// MediaRecorder stream on stdin (webm/mp4) → fragmented MP4 on stdout.
function spawnLiveFromPipe({ inputFormat = 'matroska', videoCopy, audioCopy, encoder = 'libx264', fps = 30, maxHeight = 1080, maxWidth = 0, bitrateKbps = 8000, audioOnly = false }, log) {
  // error level: copy-remuxing recorder streams spews benign per-packet pts/duration warnings
  const args = ['-hide_banner', '-loglevel', 'error',
    '-fflags', '+genpts+nobuffer', '-flags', 'low_delay', '-analyzeduration', '1000000', '-probesize', '1000000',
    '-f', inputFormat, '-i', 'pipe:0'];
  if (audioOnly) {
    args.push('-map', '0:a:0', '-vn');
  } else {
    args.push('-map', '0:v:0', '-map', '0:a?');
    if (videoCopy) args.push('-c:v', 'copy');
    else args.push('-vf', scaleFilter(maxHeight, maxWidth), '-fps_mode', 'passthrough', ...encoderArgs(encoder, { mode: 'live', gop: fps, bitrateKbps }));
  }
  if (audioCopy) args.push('-c:a', 'copy');
  else args.push('-c:a', 'aac', '-b:a', audioOnly ? '256k' : '160k', '-ar', '48000', '-ac', '2');
  if (audioOnly) args.push('-f', 'mp4', ...FRAG_FLAGS, '-frag_duration', '250000', '-flush_packets', '1', 'pipe:1');
  else args.push('-f', 'mp4', ...LIVE_FRAG_FLAGS, '-flush_packets', '1', 'pipe:1');
  return spawnFfmpeg(args, log, 'live');
}

// GDI screen grab → low-latency VP8 IVF stream on stdout, for Cast mirroring.
// libvpx in realtime mode holds no frames back; the long GOP is fine because the
// Cast Streaming receiver ACKs frames and NACKs lost packets instead of seeking.
function spawnVp8Capture({ target = 'desktop', region = null, fps = 30, maxHeight = 1080, maxWidth = 0, bitrateKbps = 4000 }, log) {
  const b = Math.max(300, Math.round(bitrateKbps));
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '1'];
  if (region) args.push('-offset_x', String(region.x), '-offset_y', String(region.y), '-video_size', `${region.width}x${region.height}`);
  args.push('-i', target, '-vf', scaleFilter(maxHeight, maxWidth),
    '-c:v', 'libvpx', '-deadline', 'realtime', '-cpu-used', '8', '-lag-in-frames', '0',
    '-error-resilient', '1', '-auto-alt-ref', '0', '-qmin', '4', '-qmax', '52',
    '-b:v', `${b}k`, '-maxrate', `${b}k`, '-bufsize', `${b}k`,
    '-g', String(fps * 4), '-pix_fmt', 'yuv420p', '-an', '-f', 'ivf', 'pipe:1');
  return spawnFfmpeg(args, log, 'mirror');
}

// GDI screen/window grab → fragmented MP4 on stdout (no audio).
function spawnGdigrab({ target = 'desktop', region = null, fps = 30, encoder = 'libx264', maxHeight = 1080, maxWidth = 0, bitrateKbps = 8000 }, log) {
  const args = ['-hide_banner', '-loglevel', 'warning', '-nostdin', '-f', 'gdigrab', '-framerate', String(fps), '-draw_mouse', '1'];
  if (region) args.push('-offset_x', String(region.x), '-offset_y', String(region.y), '-video_size', `${region.width}x${region.height}`);
  args.push('-i', target, '-vf', scaleFilter(maxHeight, maxWidth), ...encoderArgs(encoder, { mode: 'live', gop: fps, bitrateKbps }), '-an');
  args.push('-f', 'mp4', ...LIVE_FRAG_FLAGS, '-flush_packets', '1', 'pipe:1');
  return spawnFfmpeg(args, log, 'gdigrab');
}

module.exports = { ffmpegPath, ffprobePath, probe, summarize, planFile, planAudioFile, resolveEncoder, encoderArgs, scaleFilter, spawnFileTranscode, spawnAudioTranscode, extractCoverArt, spawnLiveFromPipe, spawnGdigrab, spawnVp8Capture };
