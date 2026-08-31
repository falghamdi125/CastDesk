'use strict';
// Local HTTP server that the Cast device pulls media from:
//   /media/<token>          static file with HTTP Range support (images, direct-play video)
//   /tx/<token>?ss=<sec>    on-demand ffmpeg transcode of a file to fragmented MP4
//   /live/<token>           live fragmented-MP4 broadcast (screen / window mirroring)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const dgram = require('dgram');
const mime = require('mime-types');
const { ipv4Interfaces } = require('./discovery');

const MIME_OVERRIDES = {
  '.mkv': 'video/x-matroska', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.heic': 'image/heic',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
};

function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  return MIME_OVERRIDES[ext] || mime.lookup(file) || 'application/octet-stream';
}

class MediaServer {
  constructor(log) {
    this.log = log || (() => {});
    this.files = new Map();       // token -> { path, type }
    this.transcodes = new Map();  // token -> { spawn(ss) -> ChildProcess, children:Set }
    this.lives = new Map();       // token -> broadcaster
    this.server = null;
    this.port = 0;
  }

  start(preferredPort = 0) {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.on('error', reject);
      this.server.listen(preferredPort, '0.0.0.0', () => {
        this.port = this.server.address().port;
        this.log(`Media server listening on port ${this.port}`);
        resolve(this.port);
      });
    });
  }

  stop() {
    for (const t of this.transcodes.values()) for (const c of t.children) { try { c.kill(); } catch (_) { /* ignore */ } }
    if (this.server) this.server.close();
  }

  token() { return crypto.randomBytes(8).toString('hex'); }

  registerFile(filePath) {
    const t = this.token();
    this.files.set(t, { path: filePath, type: contentTypeFor(filePath) });
    return t;
  }

  registerTranscode(spawnFn, type = 'video/mp4') {
    const t = this.token();
    this.transcodes.set(t, { spawn: spawnFn, children: new Set(), type });
    return t;
  }

  registerLive(broadcaster) {
    const t = this.token();
    this.lives.set(t, broadcaster);
    return t;
  }

  unregister(token) {
    const tx = this.transcodes.get(token);
    if (tx) for (const c of tx.children) { try { c.kill(); } catch (_) { /* ignore */ } }
    this.files.delete(token);
    this.transcodes.delete(token);
    this.lives.delete(token);
  }

  urlFor(kind, token, host, query) {
    return `http://${host}:${this.port}/${kind}/${token}${query ? '?' + query : ''}`;
  }

  handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const [, kind, token] = url.pathname.split('/');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    this.log(`HTTP ${req.method} ${url.pathname}${url.search} range=${req.headers.range || '-'} ua=${(req.headers['user-agent'] || '').slice(0, 40)}`);
    try {
      if (kind === 'media' && this.files.has(token)) return this.serveFile(req, res, this.files.get(token));
      if (kind === 'tx' && this.transcodes.has(token)) return this.serveTranscode(req, res, this.transcodes.get(token), url);
      if (kind === 'live' && this.lives.has(token)) return this.serveLive(req, res, this.lives.get(token));
      if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return; }
      res.writeHead(404); res.end('not found');
    } catch (err) {
      this.log(`HTTP error: ${err.message}`);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    }
  }

  serveFile(req, res, entry) {
    const stat = fs.statSync(entry.path);
    const size = stat.size;
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', entry.type);
    res.setHeader('Last-Modified', stat.mtime.toUTCString());
    const range = req.headers.range;
    let start = 0, end = size - 1, status = 200;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - parseInt(m[2], 10)); }
        else {
          start = parseInt(m[1] || '0', 10);
          if (m[2] !== '') end = Math.min(parseInt(m[2], 10), size - 1);
        }
        if (start > end || start >= size) {
          res.writeHead(416, { 'Content-Range': `bytes */${size}` });
          res.end();
          return;
        }
        status = 206;
        res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      }
    }
    res.setHeader('Content-Length', end - start + 1);
    res.writeHead(status);
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(entry.path, { start, end });
    stream.on('error', () => res.destroy());
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  }

  serveTranscode(req, res, entry, url) {
    const ss = Math.max(0, parseFloat(url.searchParams.get('ss') || '0') || 0);
    res.writeHead(200, {
      'Content-Type': entry.type || 'video/mp4',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    const child = entry.spawn(ss);
    entry.children.add(child);
    const cleanup = () => { entry.children.delete(child); try { child.kill(); } catch (_) { /* ignore */ } };
    child.stdout.on('error', () => {});
    child.stdout.pipe(res);
    child.on('exit', () => { entry.children.delete(child); try { res.end(); } catch (_) { /* ignore */ } });
    res.on('close', cleanup);
  }

  serveLive(req, res, bc) {
    try { res.socket.setNoDelay(true); } catch (_) { /* ignore */ }
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-cache, no-store',
      'Connection': 'keep-alive',
    });
    if (req.method === 'HEAD') { res.end(); return; }
    bc.addClient(res);
    res.on('close', () => bc.removeClient(res));
  }
}

// Which local IPv4 address routes to `host`? (UDP connect trick: no packet is sent.)
function localAddressFor(host) {
  return new Promise((resolve) => {
    const fallback = () => { const i = ipv4Interfaces(); resolve(i.length ? i[0].address : '127.0.0.1'); };
    try {
      const s = dgram.createSocket('udp4');
      s.on('error', () => { try { s.close(); } catch (_) { /* ignore */ } fallback(); });
      s.connect(8009, host, (err) => {
        if (err) { try { s.close(); } catch (_) { /* ignore */ } return fallback(); }
        const a = s.address().address;
        try { s.close(); } catch (_) { /* ignore */ }
        resolve(a);
      });
    } catch (_) { fallback(); }
  });
}

module.exports = { MediaServer, localAddressFor, contentTypeFor };
