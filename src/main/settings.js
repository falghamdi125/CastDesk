'use strict';
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  engine: 'chromium',      // 'chromium' (WGC capture + system audio) | 'gdigrab' (ffmpeg GDI capture, video only)
  encoder: 'auto',         // 'auto' | 'software' | 'h264_nvenc' | 'h264_qsv' | 'h264_amf'
  fps: 30,
  maxHeight: 1080,         // 720 | 1080 | 1440 | 0 (native)
  maxWidth: 0,             // 0 = no width cap; set with maxHeight by box presets like 1024×768
  bitrateKbps: 0,          // 0 = auto
  audio: true,             // capture system audio when mirroring
  mirror: true,            // screen casting uses the Cast Streaming (Chrome mirroring) protocol
  passthrough: true,       // allow H.264 from MediaRecorder to be passed through without re-encoding
  videoMode: 'auto',       // 'auto' | 'direct' | 'transcode'
  allowHevc: false,        // treat HEVC/AV1 as directly playable (Google TV / Chromecast Ultra)
  autoConnect: true,       // reconnect to lastDevice automatically when it is discovered
  lastDevice: null,
  manualDevices: [],       // [{host, name}]
};

class Settings {
  constructor(dir) {
    this.file = path.join(dir, 'settings.json');
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { /* first run */ }
    this.data = { ...DEFAULTS, ...saved };
  }

  all() { return { ...this.data }; }
  get(key) { return this.data[key]; }

  update(patch) {
    for (const [k, v] of Object.entries(patch || {})) {
      if (k in DEFAULTS) this.data[k] = v;
    }
    this.save();
    return this.all();
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) { console.error('settings save failed', err); }
  }
}

module.exports = { Settings, DEFAULTS };
