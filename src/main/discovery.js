'use strict';
// mDNS discovery of Google Cast devices (_googlecast._tcp.local).
// One multicast-dns socket per IPv4 interface so multi-homed PCs (VPN, Hyper-V, WSL) still find devices.
const os = require('os');
const { EventEmitter } = require('events');
const createMdns = require('multicast-dns');

const SERVICE = '_googlecast._tcp.local';
const QUERY_INTERVAL_MS = 10000;
const STALE_MS = 3 * 60 * 1000;

function ipv4Interfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      const fam = a.family === 'IPv4' || a.family === 4;
      if (fam && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

function parseTxt(data) {
  const txt = {};
  for (const entry of data || []) {
    const s = Buffer.isBuffer(entry) ? entry.toString('utf8') : String(entry);
    const i = s.indexOf('=');
    if (i > 0) txt[s.slice(0, i)] = s.slice(i + 1);
  }
  return txt;
}

class Discovery extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map();   // id -> device
    this.manual = new Map();    // host -> device
    this.instances = [];
    this.srv = new Map();       // instance name -> {target, port}
    this.txt = new Map();       // instance name -> txt object
    this.addr = new Map();      // hostname -> ipv4
    this.timer = null;
  }

  start() {
    this.stop();
    const ifaces = ipv4Interfaces();
    const make = (opts, label) => {
      try {
        const m = createMdns(opts);
        m.on('response', (pkt) => this.onResponse(pkt));
        m.on('error', (err) => this.emit('log', `mdns(${label}): ${err.message}`));
        this.instances.push(m);
      } catch (err) {
        this.emit('log', `mdns(${label}) failed: ${err.message}`);
      }
    };
    if (ifaces.length === 0) make({}, 'default');
    for (const i of ifaces) make({ interface: i.address, bind: '0.0.0.0', reuseAddr: true }, i.address);
    // Also a catch-all instance in case per-interface sockets miss something.
    make({ reuseAddr: true }, 'all');
    // Burst a few queries at start-up (first answers are often missed), then poll slowly.
    this.query();
    this.burst = [1000, 3000, 6000].map((ms) => setTimeout(() => this.query(), ms));
    this.timer = setInterval(() => this.query(), QUERY_INTERVAL_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const t of this.burst || []) clearTimeout(t);
    this.burst = [];
    for (const m of this.instances) { try { m.destroy(); } catch (_) { /* ignore */ } }
    this.instances = [];
  }

  query() {
    for (const m of this.instances) {
      try { m.query({ questions: [{ name: SERVICE, type: 'PTR' }] }); } catch (_) { /* ignore */ }
    }
    // prune stale
    const now = Date.now();
    let changed = false;
    for (const [id, d] of this.devices) {
      if (now - d.lastSeen > STALE_MS) { this.devices.delete(id); changed = true; }
    }
    if (changed) this.emitUpdate();
  }

  onResponse(pkt) {
    const records = [...(pkt.answers || []), ...(pkt.additionals || [])];
    const instances = new Set();
    for (const r of records) {
      if (r.type === 'PTR' && r.name === SERVICE) instances.add(r.data);
      else if (r.type === 'SRV' && r.name.endsWith(SERVICE)) { this.srv.set(r.name, { target: r.data.target, port: r.data.port }); instances.add(r.name); }
      else if (r.type === 'TXT' && r.name.endsWith(SERVICE)) { this.txt.set(r.name, parseTxt(r.data)); instances.add(r.name); }
      else if (r.type === 'A') this.addr.set(r.name, r.data);
    }
    let changed = false;
    for (const name of instances) {
      const srv = this.srv.get(name);
      const txt = this.txt.get(name);
      if (!srv || !txt) continue;
      const host = this.addr.get(srv.target);
      if (!host) continue;
      const id = txt.id || name;
      const dev = {
        id,
        name: txt.fn || name.replace('.' + SERVICE, ''),
        model: txt.md || 'Google Cast',
        host,
        port: srv.port || 8009,
        manual: false,
        lastSeen: Date.now(),
      };
      const prev = this.devices.get(id);
      if (!prev) this.emit('log', `discovered ${dev.name} [${dev.model}] at ${dev.host}`);
      if (!prev || prev.host !== dev.host || prev.name !== dev.name || prev.model !== dev.model) changed = true;
      this.devices.set(id, dev);
    }
    if (changed) this.emitUpdate();
  }

  addManual(host, name) {
    const dev = { id: 'manual:' + host, name: name || host, model: 'Manual', host, port: 8009, manual: true, lastSeen: Date.now() };
    this.manual.set(host, dev);
    this.emitUpdate();
    return dev;
  }

  removeManual(host) {
    this.manual.delete(host);
    this.emitUpdate();
  }

  list() {
    const all = [...this.devices.values(), ...this.manual.values()];
    all.sort((a, b) => a.name.localeCompare(b.name));
    return all;
  }

  get(id) {
    return this.devices.get(id) || [...this.manual.values()].find((d) => d.id === id) || null;
  }

  emitUpdate() { this.emit('update', this.list()); }
}

module.exports = { Discovery, ipv4Interfaces };
