'use strict';
/* A stand-in for PeerJS: a signalling registry plus ordered, delayed data channels.
 * hub.freeze(peerId) drops everything to and from a phone (asleep in a pocket);
 * hub.signalling(false) takes the signalling server down without touching open channels. */

class Emitter {
  constructor() { this._h = {}; }
  on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); return this; }
  emit(ev, ...args) { (this._h[ev] || []).slice().forEach((fn) => fn(...args)); }
}

class Hub {
  constructor(opts = {}) {
    this.min = opts.minLatency ?? 1;
    this.max = opts.maxLatency ?? 6;
    this.peers = new Map();
    this.all = new Set();
    this.frozen = new Set();
    this.up = true;
    this.sendHooks = [];
    const hub = this;
    this.Peer = class FakePeer extends Emitter {
      constructor(id) {
        super();
        this.id = id || 'anon-' + Math.random().toString(36).slice(2, 10);
        this.open = false;
        this.destroyed = false;
        this.disconnected = true;
        this.connections = [];
        hub.all.add(this);
        setTimeout(() => this._register(), hub.ms());
      }
      _register() {
        if (this.destroyed) return;
        if (!hub.up || hub.frozen.has(this.id)) { this.emit('error', { type: 'network', message: 'Lost connection to server.' }); return; }
        const holder = hub.peers.get(this.id);
        if (holder && holder !== this && !holder.destroyed) { this.emit('error', { type: 'unavailable-id', message: 'ID "' + this.id + '" is taken' }); return; }
        hub.peers.set(this.id, this);
        this.open = true;
        this.disconnected = false;
        this.emit('open', this.id);
      }
      connect(targetId, options) {
        const conn = new FakeConn(hub, this, targetId, options);
        this.connections.push(conn);
        setTimeout(() => {
          if (this.destroyed || conn.dead) return;
          if (this.disconnected) { this.emit('error', { type: 'disconnected', message: 'Cannot connect while disconnected' }); return; }
          const target = hub.peers.get(targetId);
          if (!target || target.destroyed || target.disconnected) {
            this.emit('error', { type: 'peer-unavailable', message: 'Could not connect to peer ' + targetId });
            return;
          }
          if (hub.frozen.has(this.id) || hub.frozen.has(targetId)) return; // never opens
          const remote = new FakeConn(hub, target, this.id, options);
          conn.other = remote;
          remote.other = conn;
          target.connections.push(remote);
          target.emit('connection', remote);
          setTimeout(() => {
            if (conn.dead || remote.dead) return;
            conn.open = remote.open = true;
            remote.emit('open');
            conn.emit('open');
          }, hub.ms());
        }, hub.ms());
        return conn;
      }
      disconnect() {
        if (this.destroyed || this.disconnected) return;
        this.disconnected = true;
        this.open = false;
        if (hub.peers.get(this.id) === this) hub.peers.delete(this.id);
        this.emit('disconnected', this.id);
      }
      reconnect() {
        if (this.destroyed) throw new Error('This peer cannot reconnect: it was destroyed.');
        if (!this.disconnected) return;
        setTimeout(() => this._register(), hub.ms());
      }
      destroy() {
        if (this.destroyed) return;
        this.destroyed = true;
        this.disconnected = true;
        this.open = false;
        if (hub.peers.get(this.id) === this) hub.peers.delete(this.id);
        this.connections.forEach((c) => c.close());
        hub.all.delete(this);
        this.emit('close');
      }
    };
  }
  ms() { return this.min + Math.random() * (this.max - this.min); }
  freeze(id) { this.frozen.add(id); }
  thaw(id) { this.frozen.delete(id); }
  /** Take the signalling server down (true = up). Open data channels keep working. */
  signalling(up) {
    this.up = up;
    if (!up) for (const p of [...this.all]) if (!p.destroyed) p.disconnect();
  }
  livePeers() { return [...this.all].filter((p) => !p.destroyed); }
}

class FakeConn extends Emitter {
  constructor(hub, owner, peerId, options) {
    super();
    this.hub = hub;
    this.owner = owner;
    this.peer = peerId;
    this.options = options || {};
    this.open = false;
    this.dead = false;
    this.other = null;
    this.chain = Promise.resolve();
  }
  send(data) {
    if (!this.open || this.dead) return;
    const json = JSON.stringify(data);
    for (const h of this.hub.sendHooks) h(this.owner.id, this.peer, JSON.parse(json));
    const other = this.other;
    if (this.hub.frozen.has(this.owner.id) || this.hub.frozen.has(other.owner.id)) return;
    this.chain = this.chain.then(() => new Promise((r) => setTimeout(r, this.hub.ms()))).then(() => {
      if (other.dead || !other.open || this.hub.frozen.has(other.owner.id)) return;
      other.emit('data', JSON.parse(json));
    });
  }
  close() {
    if (this.dead) return;
    this.dead = true;
    this.open = false;
    this.emit('close');
    const o = this.other;
    if (o && !o.dead) {
      setTimeout(() => {
        if (o.dead || this.hub.frozen.has(o.owner.id) || this.hub.frozen.has(this.owner.id)) return;
        o.dead = true;
        o.open = false;
        o.emit('close');
      }, this.hub.ms());
    }
  }
}

function memoryStorage() {
  const m = new Map();
  return {
    get: (k) => (m.has(k) ? JSON.parse(m.get(k)) : null),
    set: (k, v) => m.set(k, JSON.stringify(v)),
    remove: (k) => m.delete(k),
    _map: m
  };
}

module.exports = { Hub, memoryStorage };
