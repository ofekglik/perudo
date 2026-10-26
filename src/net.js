/* Peer-to-peer Perudo table.
 *
 *   Host phone   HostCore (rules engine + the table)  <->  HostLink (PeerJS: accepts friends)
 *   Guest phone  GuestLink (PeerJS: connects to the host by table code)
 *   Every phone  TableSession (what the screen shows, its own hidden dice, sending moves)
 *
 * The table state holds no dice. Each phone rolls and keeps its own dice and sends them
 * to the host only when that round's dice are revealed. */
(function (root) {
  'use strict';
  var P = root.Perudo || (typeof require !== 'undefined' ? require('./engine.js') : null);

  var PROTOCOL = 1;
  var PEER_PREFIX = 'perudo-v1-';
  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  var CODE_LEN = 5;
  var ID_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';
  var KEEP_MS = 24 * 3600 * 1000;

  function noop() {}
  function cryptoUint32() {
    var a = new Uint32Array(1);
    (root.crypto || (typeof globalThis !== 'undefined' && globalThis.crypto)).getRandomValues(a);
    return a[0];
  }
  function makeRandom(uint32) {
    return {
      below: function (n) {
        var limit = Math.floor(4294967296 / n) * n;
        var r;
        do { r = uint32(); } while (r >= limit);
        return r % n;
      },
      id: function (len, chars) {
        chars = chars || ID_CHARS;
        var s = '';
        for (var i = 0; i < len; i++) s += chars[this.below(chars.length)];
        return s;
      }
    };
  }
  function normalizeCode(raw) {
    return String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z]/g, '');
  }
  function validCode(code) {
    if (typeof code !== 'string' || code.length !== CODE_LEN) return false;
    for (var i = 0; i < code.length; i++) if (CODE_CHARS.indexOf(code[i]) < 0) return false;
    return true;
  }
  function validTable(d) {
    return !!d && d.v === 1 && typeof d.gid === 'string' && Array.isArray(d.seats) &&
      Array.isArray(d.bids) && typeof d.status === 'string';
  }
  function safeSend(conn, msg) {
    try { if (conn && conn.open) { conn.send(msg); return true; } } catch (e) { /* closed under us */ }
    return false;
  }

  // ======================================================================
  // HostCore: the table itself, on the host's phone. Transport-agnostic.
  // ======================================================================
  function HostCore(opts) {
    this.gid = opts.gid;
    this.hostPid = opts.hostPid;
    this.state = opts.state || null;
    this.hands = opts.hands || {};
    this.rand = opts.rand;
    this.now = opts.now;
    this.onSave = opts.onSave || noop;
    this.onBroadcast = opts.onBroadcast || noop;
    this.online = {};
    this.closed = false;
    this.rev = 0;
    var self = this;
    this.ctx = {
      roll: function () { return self.rand.below(6) + 1; },
      id: function () { return self.rand.id(10); }
    };
  }

  HostCore.prototype.snapshot = function () {
    return { v: 1, gid: this.gid, hostPid: this.hostPid, state: this.state, hands: this.hands, savedAt: this.now() };
  };

  /** Dice are shared only for the round being revealed right now. */
  HostCore.prototype.publicHands = function () {
    var s = this.state;
    var out = {};
    if (!s || s.status !== 'playing' || s.phase !== 'reveal') return out;
    for (var sid in this.hands) {
      if (Object.prototype.hasOwnProperty.call(this.hands, sid) && this.hands[sid].roundId === s.roundId) out[sid] = this.hands[sid];
    }
    return out;
  };

  HostCore.prototype.onlineList = function () {
    var out = [this.hostPid];
    for (var pid in this.online) if (this.online[pid] > 0 && pid !== this.hostPid) out.push(pid);
    return out;
  };

  HostCore.prototype.view = function () {
    return { t: 'state', rev: this.rev, state: this.state, hands: this.publicHands(), online: this.onlineList() };
  };

  HostCore.prototype.changed = function (save) {
    if (save !== false) this.onSave(this.snapshot());
    this.rev++;
    this.onBroadcast(this.view());
  };

  HostCore.prototype.setOnline = function (pid, delta) {
    this.online[pid] = Math.max(0, (this.online[pid] || 0) + delta);
    if (!this.closed) this.changed(false);
  };

  HostCore.prototype.handle = function (pid, msg) {
    if (this.closed || !msg || typeof msg !== 'object') return null;
    if (msg.t === 'act') return this._act(pid, msg);
    if (msg.t === 'reveal') { this._reveal(pid, msg); return null; }
    if (msg.t === 'ping') return { t: 'pong' };
    if (msg.t === 'sync') return this.view();
    return null;
  };

  HostCore.prototype._act = function (pid, msg) {
    var res = { t: 'result', id: msg.id, ok: true };
    try {
      var next = this._apply(pid, String(msg.kind), msg.args && typeof msg.args === 'object' ? msg.args : {}, msg.expect || null);
      if (next === 'close') {
        this.closed = true;
        this.state = null;
        this.hands = {};
        this.onSave(null);
        this.onBroadcast({ t: 'closed' });
        return res;
      }
      if (next) {
        next.seq = ((this.state && this.state.seq) || 0) + 1;
        next.updatedAt = this.now();
        this.state = next;
        this.changed();
      }
    } catch (e) {
      res.ok = false;
      res.error = e && e.isRuleError
        ? { message: e.message, code: e.code }
        : { message: 'The host’s phone could not apply that move.', code: 'host_error' };
      if (!(e && e.isRuleError) && typeof console !== 'undefined') console.error(e);
    }
    return res;
  };

  HostCore.prototype._apply = function (pid, kind, a, expect) {
    var s = this.state;
    var ctx = this.ctx;
    if (kind === 'create') {
      if (s) throw P.RuleError('This table already exists.', 'exists');
      if (pid !== this.hostPid) throw P.RuleError('Only the host can set up the table.', 'not_host');
      return P.newTable({ gid: this.gid, sid: this.rand.id(8), owner: pid, name: a.name, calza: a.calza !== false, now: this.now() });
    }
    if (!s) throw P.RuleError('This table is not set up yet.', 'gone');
    if (expect && (s.roundId !== expect.roundId || s.bids.length !== expect.bids || s.phase !== expect.phase)) {
      throw P.RuleError('The table changed just before your move. Check it and try again.', 'stale');
    }
    var hostSeat = P.seatOfOwner(s, this.hostPid);
    switch (kind) {
      case 'join': return P.addPlayer(s, pid, this.rand.id(8), a.name);
      case 'leaveLobby':
        if (pid === this.hostPid) throw P.RuleError('The table runs on your phone. Close the table instead.', 'host_stays');
        return P.leaveLobby(s, pid, null);
      case 'setCalza': return P.setCalza(s, pid, !!a.on);
      case 'start': return P.startGame(s, pid, ctx);
      case 'bid': return P.placeBid(s, pid, Number(a.q), Number(a.f));
      case 'dudo': return P.callDudo(s, pid);
      case 'calza': return P.callCalza(s, pid);
      case 'next': return P.advance(s, pid, this.hands, ctx);
      case 'remove': {
        var mine = P.seatOfOwner(s, pid);
        var target = a.sid || (mine && mine.sid);
        if (hostSeat && target === hostSeat.sid) {
          throw P.RuleError('This phone runs the table. To stop, end the game for everyone.', 'host_stays');
        }
        return P.removePlayer(s, pid, a.sid || null, ctx);
      }
      case 'claim':
        if (hostSeat && a.sid === hostSeat.sid) throw P.RuleError('That seat belongs to the phone running the table.', 'host_stays');
        return P.claimSeat(s, pid, a.sid);
      case 'again': return P.playAgain(s, pid);
      case 'close':
        if (pid !== this.hostPid) throw P.RuleError('Only the host can close the table.', 'not_host');
        return 'close';
    }
    throw P.RuleError('Unknown move.', 'unknown');
  };

  HostCore.prototype._reveal = function (pid, msg) {
    var s = this.state;
    if (!s || s.status !== 'playing' || s.phase !== 'reveal' || msg.roundId !== s.roundId) return;
    var seat = P.seatOf(s, msg.sid);
    if (!seat || seat.owner !== pid || seat.out || !P.validHand(msg.dice, seat.dice)) return;
    var cur = this.hands[msg.sid];
    if (cur && cur.roundId === s.roundId) return; // first reveal stands
    this.hands[msg.sid] = { roundId: s.roundId, sid: seat.sid, dice: msg.dice.slice() };
    this.changed();
  };

  // ======================================================================
  // HostLink: lets friends' phones connect to this phone.
  // ======================================================================
  function HostLink(opts) {
    this.Peer = opts.Peer;
    this.peerOptions = opts.peerOptions || {};
    this.code = opts.code;
    this.core = opts.core;
    this.onStatus = opts.onStatus || noop;
    this.now = opts.now;
    this.heartbeatMs = opts.heartbeatMs;
    this.timeoutMs = opts.timeoutMs;
    this.entries = [];
    this.peer = null;
    this.status = 'connecting';
    this.destroyed = false;
    this._timer = null;
    this._retry = null;
    this._attempts = 0;
  }

  HostLink.prototype._setStatus = function (s) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s);
  };

  /** Register the table code with the signalling server. `resuming`: keep retrying if the code is still held. */
  HostLink.prototype.start = function (resuming) {
    var self = this;
    this._boot(!!resuming);
    this._timer = setInterval(function () { self._beat(); }, this.heartbeatMs);
  };

  HostLink.prototype._scheduleBoot = function (resuming) {
    var self = this;
    if (this.destroyed || this._retry) return;
    this._attempts++;
    var wait = Math.min(1000 * this._attempts, 6000);
    this._retry = setTimeout(function () { self._retry = null; self._boot(resuming); }, wait);
  };

  HostLink.prototype._boot = function (resuming) {
    var self = this;
    if (this.destroyed) return;
    var peer;
    try {
      peer = new this.Peer(PEER_PREFIX + this.code, this.peerOptions);
    } catch (e) {
      this._setStatus('unsupported');
      return;
    }
    this.peer = peer;
    var everOpen = false;
    var rejoinTimer = null;
    function rejoinSignalling(wait) {
      // Lost the signalling server only: friends already connected keep playing; re-register for newcomers.
      if (rejoinTimer) return;
      rejoinTimer = setTimeout(function () {
        rejoinTimer = null;
        if (self.destroyed || self.peer !== peer || peer.destroyed || !peer.disconnected) return;
        try { peer.reconnect(); } catch (e) { rejoinSignalling(4000); }
      }, wait);
    }
    peer.on('open', function () {
      if (self.peer !== peer) return;
      everOpen = true;
      self._attempts = 0;
      self._setStatus('open');
    });
    peer.on('connection', function (conn) { if (self.peer === peer) self._accept(conn); });
    peer.on('disconnected', function () {
      if (self.destroyed || self.peer !== peer || peer.destroyed) return;
      self._setStatus('reconnecting');
      rejoinSignalling(1500);
    });
    peer.on('error', function (err) {
      if (self.destroyed || self.peer !== peer) return;
      var type = err && err.type;
      if (type === 'peer-unavailable' || type === 'webrtc') return;
      if (type === 'browser-incompatible') { self._setStatus('unsupported'); return; }
      if (everOpen && type !== 'unavailable-id' && !peer.destroyed) {
        self._setStatus('reconnecting');
        rejoinSignalling(3000);
        return;
      }
      if (type === 'unavailable-id' && !resuming) {
        self._setStatus('taken');
        try { peer.destroy(); } catch (e) { /* gone */ }
        return;
      }
      // never registered: the code is still held by our previous page, or the server is unreachable
      self._setStatus('reconnecting');
      try { peer.destroy(); } catch (e) { /* gone */ }
      self.peer = null;
      self._scheduleBoot(resuming || type === 'unavailable-id');
    });
  };

  HostLink.prototype._accept = function (conn) {
    var self = this;
    var entry = { conn: conn, pid: null, last: this.now(), dead: false };
    this.entries.push(entry);
    function drop() {
      if (entry.dead) return;
      entry.dead = true;
      self.entries = self.entries.filter(function (e) { return e !== entry; });
      if (entry.pid) self.core.setOnline(entry.pid, -1);
    }
    conn.on('data', function (data) {
      if (entry.dead) return;
      entry.last = self.now();
      if (!data || typeof data !== 'object') return;
      if (data.t === 'hello') {
        if (data.v !== PROTOCOL) { safeSend(conn, { t: 'version', v: PROTOCOL }); return; }
        if (typeof data.pid !== 'string' || !data.pid || data.pid.length > 80) return;
        if (!entry.pid) {
          entry.pid = data.pid;
          self.core.setOnline(entry.pid, +1);
        }
        safeSend(conn, self.core.closed ? { t: 'closed' } : self.core.view());
        return;
      }
      if (data.t === 'pong' || !entry.pid) return;
      var reply = self.core.handle(entry.pid, data);
      if (reply) safeSend(conn, reply);
    });
    conn.on('close', drop);
    conn.on('error', function () { try { conn.close(); } catch (e) { /* closed */ } drop(); });
  };

  HostLink.prototype._beat = function () {
    var now = this.now();
    var self = this;
    this.entries.slice().forEach(function (e) {
      if (now - e.last > self.timeoutMs) {
        try { e.conn.close(); } catch (err) { /* closed */ }
        if (!e.dead) {
          e.dead = true;
          self.entries = self.entries.filter(function (x) { return x !== e; });
          if (e.pid) self.core.setOnline(e.pid, -1);
        }
      } else {
        safeSend(e.conn, { t: 'ping', rev: self.core.rev });
      }
    });
  };

  HostLink.prototype.broadcast = function (msg) {
    this.entries.forEach(function (e) { if (e.pid) safeSend(e.conn, msg); });
  };

  HostLink.prototype.stop = function () {
    this.destroyed = true;
    clearInterval(this._timer);
    clearTimeout(this._retry);
    this.entries.forEach(function (e) { try { e.conn.close(); } catch (err) { /* closed */ } });
    this.entries = [];
    if (this.peer) { try { this.peer.destroy(); } catch (e) { /* gone */ } }
    this.peer = null;
  };

  // ======================================================================
  // GuestLink: this phone's connection to the host's phone.
  // ======================================================================
  function GuestLink(opts) {
    this.Peer = opts.Peer;
    this.peerOptions = opts.peerOptions || {};
    this.code = opts.code;
    this.pid = opts.pid;
    this.onMessage = opts.onMessage || noop;
    this.onStatus = opts.onStatus || noop;
    this.onPing = opts.onPing || noop;
    this.now = opts.now;
    this.heartbeatMs = opts.heartbeatMs;
    this.timeoutMs = opts.timeoutMs;
    this.openTimeoutMs = opts.openTimeoutMs || 10000;
    this.peer = null;
    this.conn = null;
    this.status = 'connecting';
    this.destroyed = false;
    this.last = 0;
    this._retry = null;
    this._attempts = 0;
    this._timer = null;
    this._pokeTimer = null;
  }

  GuestLink.prototype._setStatus = function (s) {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s);
  };

  GuestLink.prototype.start = function () {
    var self = this;
    this._bootPeer();
    this._timer = setInterval(function () { self._beat(); }, this.heartbeatMs);
  };

  GuestLink.prototype._schedule = function (fn, wait) {
    var self = this;
    if (this.destroyed || this._retry) return;
    this._retry = setTimeout(function () { self._retry = null; if (!self.destroyed) fn.call(self); }, wait);
  };

  GuestLink.prototype._bootPeer = function () {
    var self = this;
    if (this.destroyed) return;
    var peer;
    try {
      peer = new this.Peer(undefined, this.peerOptions);
    } catch (e) {
      this._setStatus('unsupported');
      return;
    }
    this.peer = peer;
    var rejoinTimer = null;
    function rejoinSignalling(wait) {
      if (rejoinTimer) return;
      rejoinTimer = setTimeout(function () {
        rejoinTimer = null;
        if (self.destroyed || self.peer !== peer || peer.destroyed || !peer.disconnected) return;
        try { peer.reconnect(); } catch (e) { rejoinSignalling(4000); }
      }, wait);
    }
    peer.on('open', function () {
      if (self.peer !== peer) return;
      if (!(self.conn && self.conn.open)) self._connect();
    });
    peer.on('disconnected', function () {
      if (self.destroyed || self.peer !== peer || peer.destroyed) return;
      rejoinSignalling(1500);
    });
    peer.on('error', function (err) {
      if (self.destroyed || self.peer !== peer) return;
      var type = err && err.type;
      if (type === 'browser-incompatible') { self._setStatus('unsupported'); return; }
      if (type === 'webrtc') return; // reported on the connection itself
      if (type !== 'peer-unavailable' && self.conn && self.conn.open && !peer.destroyed) {
        // Lost only the signalling server; the line to the host is still up.
        rejoinSignalling(3000);
        return;
      }
      if (type === 'peer-unavailable') {
        // nobody is hosting this code right now
        self._dropConn();
        self._setStatus('no-host');
        self._schedule(self._connect, 3000);
        return;
      }
      self._dropConn();
      self._setStatus('reconnecting');
      try { peer.destroy(); } catch (e) { /* gone */ }
      self.peer = null;
      self._attempts++;
      self._schedule(self._bootPeer, Math.min(1000 * self._attempts, 6000));
    });
  };

  GuestLink.prototype._dropConn = function () {
    var c = this.conn;
    this.conn = null;
    if (c) { try { c.close(); } catch (e) { /* closed */ } }
  };

  GuestLink.prototype._connect = function () {
    var self = this;
    if (this.destroyed) return;
    var peer = this.peer;
    if (!peer || peer.destroyed) { this._bootPeer(); return; }
    if (peer.disconnected) { try { peer.reconnect(); } catch (e) { /* rebooted by error */ } this._schedule(this._connect, 2000); return; }
    if (this.conn && this.conn.open) return;
    this._dropConn();
    var conn;
    try {
      conn = peer.connect(PEER_PREFIX + this.code, { reliable: true, serialization: 'json' });
    } catch (e) {
      this._schedule(this._connect, 2000);
      return;
    }
    if (!conn) { this._schedule(this._connect, 2000); return; }
    this.conn = conn;
    var opened = false;
    var openTimer = setTimeout(function () {
      if (opened || self.conn !== conn) return;
      self._dropConn();
      if (self.status !== 'no-host') self._setStatus('reconnecting');
      self._attempts++;
      self._schedule(self._connect, Math.min(1000 * self._attempts, 5000));
    }, this.openTimeoutMs);
    conn.on('open', function () {
      if (self.conn !== conn || self.destroyed) { try { conn.close(); } catch (e) { /* stale */ } return; }
      opened = true;
      clearTimeout(openTimer);
      self._attempts = 0;
      self.last = self.now();
      safeSend(conn, { t: 'hello', v: PROTOCOL, pid: self.pid });
      self._setStatus('open');
    });
    conn.on('data', function (data) {
      if (self.conn !== conn) return;
      self.last = self.now();
      if (!data || typeof data !== 'object') return;
      if (data.t === 'ping') { safeSend(conn, { t: 'pong' }); self.onPing(data); return; }
      if (data.t === 'pong') return;
      self.onMessage(data);
    });
    function lost() {
      clearTimeout(openTimer);
      if (self.conn !== conn || self.destroyed) return;
      self.conn = null;
      self._setStatus('reconnecting');
      self._attempts++;
      self._schedule(self._connect, Math.min(800 * self._attempts, 5000));
    }
    conn.on('close', lost);
    conn.on('error', lost);
  };

  GuestLink.prototype._beat = function () {
    if (this.destroyed || !this.conn || !this.conn.open) return;
    if (this.now() - this.last > this.timeoutMs) {
      var c = this.conn;
      this.conn = null;
      try { c.close(); } catch (e) { /* closed */ }
      this._setStatus('reconnecting');
      this._schedule(this._connect, 300);
      return;
    }
    safeSend(this.conn, { t: 'ping' });
  };

  /** Called when the phone wakes up: check the line quickly instead of waiting for the heartbeat. */
  GuestLink.prototype.poke = function () {
    var self = this;
    if (this.destroyed) return;
    if (!this.conn || !this.conn.open) {
      clearTimeout(this._retry);
      this._retry = null;
      if (!this.peer || this.peer.destroyed) this._bootPeer(); else this._connect();
      return;
    }
    var sent = this.now();
    safeSend(this.conn, { t: 'ping' });
    clearTimeout(this._pokeTimer);
    this._pokeTimer = setTimeout(function () {
      if (self.destroyed || self.last >= sent) return;
      self._dropConn();
      self._setStatus('reconnecting');
      self._connect();
    }, 3500);
  };

  GuestLink.prototype.send = function (msg) { return safeSend(this.conn, msg); };

  GuestLink.prototype.stop = function () {
    this.destroyed = true;
    clearInterval(this._timer);
    clearTimeout(this._retry);
    clearTimeout(this._pokeTimer);
    this._dropConn();
    if (this.peer) { try { this.peer.destroy(); } catch (e) { /* gone */ } }
    this.peer = null;
  };

  // ======================================================================
  // TableSession: everything one phone's screen needs.
  // ======================================================================
  function TableSession(opts) {
    this.pid = opts.pid;
    this.store = opts.storage;
    this.rand = makeRandom(opts.uint32 || cryptoUint32);
    this.now = opts.now || function () { return Date.now(); };
    this.Peer = opts.Peer;
    this.peerOptions = opts.peerOptions || {};
    this.onChange = opts.onChange || noop;
    this.onEvent = opts.onEvent || noop;
    this.onError = opts.onError || noop;
    var t = opts.timing || {};
    this.timing = {
      heartbeatMs: t.heartbeatMs || 4000,
      timeoutMs: t.timeoutMs || 15000,
      actTimeoutMs: t.actTimeoutMs || 12000,
      joinTimeoutMs: t.joinTimeoutMs || 20000,
      openTimeoutMs: t.openTimeoutMs || 10000
    };
    this.readOnly = false;
    this._reset();
  }

  TableSession.prototype._reset = function () {
    this.role = null;
    this.code = null;
    this.gid = null;
    this.game = null;
    this.hands = {};
    this.online = [];
    this.hand = null;
    this.link = 'idle';
    this.core = null;
    this.hostLink = null;
    this.guestLink = null;
    this._pending = {};
    this._epoch = 0;
    this._revealSent = null;
    this._rev = -1;
    this._syncAt = 0;
  };

  TableSession.prototype.makeCode = function () { return this.rand.id(CODE_LEN, CODE_CHARS); };

  TableSession.prototype._hostSnapshot = function (code) {
    var snap = this.store.get('perudo.host.' + code);
    if (!snap || snap.v !== 1 || snap.gid !== code || snap.hostPid !== this.pid || !validTable(snap.state)) return null;
    if (this.now() - (snap.savedAt || 0) > KEEP_MS) return null;
    return snap;
  };

  /** On page load: pick up the table this phone hosts or last joined, or the one in the link. */
  TableSession.prototype.resume = function (linkCode) {
    linkCode = linkCode ? normalizeCode(linkCode) : null;
    if (linkCode && !validCode(linkCode)) linkCode = null;
    var hosting = this.store.get('perudo.hosting');
    if (hosting && (!linkCode || linkCode === hosting)) {
      var snap = this._hostSnapshot(hosting);
      if (snap) { this._becomeHost(hosting, snap); return 'host'; }
      this.store.remove('perudo.hosting');
      this.store.remove('perudo.host.' + hosting);
    }
    var code = linkCode || this.store.get('perudo.joined');
    if (code && validCode(code)) { this.open(code); return 'guest'; }
    return null;
  };

  TableSession.prototype._becomeHost = function (code, snap) {
    var self = this;
    this._reset();
    this.role = 'host';
    this.code = this.gid = code;
    this.link = 'connecting';
    this.core = new HostCore({
      gid: code,
      hostPid: this.pid,
      state: snap ? snap.state : null,
      hands: snap ? snap.hands : null,
      rand: this.rand,
      now: this.now,
      onSave: function (s) {
        if (s) { self.store.set('perudo.host.' + code, s); self.store.set('perudo.hosting', code); }
        else { self.store.remove('perudo.host.' + code); self.store.remove('perudo.hosting'); }
      },
      onBroadcast: function (msg) {
        if (self.hostLink) self.hostLink.broadcast(msg);
        self._onMessage(msg);
      }
    });
    var link = new HostLink({
      Peer: this.Peer, peerOptions: this.peerOptions, code: code, core: this.core, now: this.now,
      heartbeatMs: this.timing.heartbeatMs, timeoutMs: this.timing.timeoutMs,
      onStatus: function (s) { if (self.hostLink === link) { self.link = s; self.onChange(); } }
    });
    this.hostLink = link;
    link.start(!!snap);
    if (snap) this._onMessage(this.core.view());
    this.onChange();
  };

  TableSession.prototype.create = function (name, calza) {
    var n = P.cleanName(name);
    if (!n) return Promise.reject(P.RuleError('Type your name first.', 'name'));
    if (this.role) this.closeView();
    var code = this.makeCode();
    this._becomeHost(code, null);
    var r = this.core.handle(this.pid, { t: 'act', id: 'create', kind: 'create', args: { name: n, calza: calza !== false } });
    if (!r.ok) return Promise.reject(P.RuleError(r.error.message, r.error.code));
    this.store.set('perudo.hosting', code);
    return Promise.resolve(code);
  };

  /** Connect to a table as a guest (watching until you join). */
  TableSession.prototype.open = function (raw) {
    var self = this;
    var code = normalizeCode(raw);
    if (!validCode(code)) throw P.RuleError('Table codes are ' + CODE_LEN + ' letters, like KQTMA.', 'bad_code');
    if (this.code === code && this.role) return;
    if (this.store.get('perudo.hosting') === code && this._hostSnapshot(code)) {
      if (this.role) this.closeView();
      this._becomeHost(code, this._hostSnapshot(code));
      return;
    }
    if (this.role) this.closeView();
    this.role = 'guest';
    this.code = this.gid = code;
    this.link = 'connecting';
    this.store.set('perudo.joined', code);
    var link = new GuestLink({
      Peer: this.Peer, peerOptions: this.peerOptions, code: code, pid: this.pid, now: this.now,
      heartbeatMs: this.timing.heartbeatMs, timeoutMs: this.timing.timeoutMs, openTimeoutMs: this.timing.openTimeoutMs,
      onMessage: function (m) { if (self.guestLink === link) self._onMessage(m); },
      onPing: function (d) {
        if (self.guestLink !== link) return;
        self.runEffects();
        if (typeof d.rev !== 'number' || d.rev === self._rev) return;
        var now = self.now();
        if (now - self._syncAt < self.timing.heartbeatMs) return;
        self._syncAt = now;
        link.send({ t: 'sync' });
      },
      onStatus: function (s) {
        if (self.guestLink !== link) return;
        self.link = s;
        if (s === 'open') { self._epoch++; self.runEffects(); }
        self.onChange();
      }
    });
    this.guestLink = link;
    link.start();
    this.onChange();
  };

  TableSession.prototype.poke = function () { if (this.guestLink) this.guestLink.poke(); };

  TableSession.prototype.join = function (raw, name) {
    var self = this;
    var n = P.cleanName(name);
    if (!n) return Promise.reject(P.RuleError('Type your name first.', 'name'));
    try { this.open(raw); } catch (e) { return Promise.reject(e); }
    var code = this.code;
    return this._waitForTable(code).then(function () {
      if (self.code !== code) throw P.RuleError('You opened a different table.', 'moved');
      if (self.mySeat()) return;
      return self._act('join', { name: n });
    });
  };

  TableSession.prototype._waitForTable = function (code) {
    var self = this;
    var t0 = this.now();
    return new Promise(function (resolve, reject) {
      (function check() {
        if (self.code !== code) return reject(P.RuleError('You opened a different table.', 'moved'));
        if (self.game && self.game.gid === code) return resolve();
        if (self.closedCode === code) return reject(P.RuleError('That table was closed.', 'gone'));
        if (self.now() - t0 > self.timing.joinTimeoutMs) {
          return reject(P.RuleError(self.link === 'no-host'
            ? 'No table ' + code + ' is open right now. Check the code, and ask the host to keep their page open.'
            : 'Can’t reach table ' + code + ' yet. Check your connection and try again.', 'unreachable'));
        }
        setTimeout(check, 100);
      })();
    });
  };

  TableSession.prototype.closeView = function () {
    var role = this.role;
    if (this.guestLink) this.guestLink.stop();
    if (this.hostLink) this.hostLink.stop();
    Object.keys(this._pending).forEach(function (id) { clearTimeout(this._pending[id].timer); }, this);
    if (role === 'guest') this.store.remove('perudo.joined');
    this._reset();
    this.onChange();
  };

  TableSession.prototype._act = function (kind, args, expect) {
    var self = this;
    if (this.role === 'host') {
      var r = this.core.handle(this.pid, { t: 'act', id: 'local', kind: kind, args: args || {}, expect: expect || null });
      if (!r || !r.ok) return Promise.reject(P.RuleError(r ? r.error.message : 'The table is closed.', r ? r.error.code : 'gone'));
      return Promise.resolve();
    }
    if (this.role !== 'guest') return Promise.reject(P.RuleError('Open a table first.', 'no_table'));
    return new Promise(function (resolve, reject) {
      var id = self.rand.id(12);
      var sent = self.guestLink && self.guestLink.send({ t: 'act', id: id, kind: kind, args: args || {}, expect: expect || null });
      if (!sent) return reject(P.RuleError('Not connected to the host’s phone. Wait until it reconnects, then try again.', 'offline'));
      var timer = setTimeout(function () {
        delete self._pending[id];
        reject(P.RuleError('No answer from the host’s phone. Check the table and try again.', 'timeout'));
      }, self.timing.actTimeoutMs);
      self._pending[id] = { resolve: resolve, reject: reject, timer: timer };
    });
  };

  TableSession.prototype._onMessage = function (m) {
    if (!m || typeof m !== 'object') return;
    if (m.t === 'state') {
      var d = m.state;
      if (!validTable(d) || d.gid !== this.code) return;
      var cur = this.game;
      if (cur && cur.gid === d.gid && cur.createdAt === d.createdAt && typeof d.seq === 'number' && d.seq < cur.seq) return;
      if (typeof m.rev === 'number') this._rev = m.rev;
      var prev = cur;
      this.game = d;
      this.hands = m.hands && typeof m.hands === 'object' ? m.hands : {};
      this.online = Array.isArray(m.online) ? m.online : [];
      this._notice(prev, d);
      this.onChange();
      this.runEffects();
      return;
    }
    if (m.t === 'result') {
      var p = this._pending[m.id];
      if (!p) return;
      clearTimeout(p.timer);
      delete this._pending[m.id];
      if (m.ok) p.resolve();
      else p.reject(P.RuleError((m.error && m.error.message) || 'That move was refused.', (m.error && m.error.code) || 'refused'));
      return;
    }
    if (m.t === 'closed') {
      var code = this.code;
      var wasHost = this.role === 'host';
      if (this.guestLink) this.guestLink.stop();
      var hl = this.hostLink;
      if (hl) setTimeout(function () { hl.stop(); }, 1500);
      this.store.remove('perudo.joined');
      this.store.remove('perudo.hand.' + code);
      this._reset();
      this.closedCode = wasHost ? null : code;
      this.onEvent('closed');
      this.onChange();
      return;
    }
    if (m.t === 'version') {
      this.link = 'outdated';
      this.onChange();
    }
  };

  TableSession.prototype.mySeat = function () {
    return this.game ? P.seatOfOwner(this.game, this.pid) : null;
  };

  TableSession.prototype.isOnline = function (pid) { return this.online.indexOf(pid) >= 0; };

  TableSession.prototype._notice = function (prev, d) {
    var me = P.seatOfOwner(d, this.pid);
    if (!me || d.status !== 'playing') return;
    if (d.phase === 'bidding' && d.turn === me.sid) {
      if (!prev || prev.turn !== d.turn || prev.roundId !== d.roundId || prev.bids.length !== d.bids.length) this.onEvent('my_turn');
    }
    if (d.phase === 'reveal' && (!prev || prev.phase !== 'reveal' || prev.roundId !== d.roundId)) this.onEvent('reveal');
  };

  // ---- this phone's dice ---------------------------------------------------

  TableSession.prototype._handValid = function (h, g, me) {
    return !!h && !!g && !!me && h.gid === g.gid && h.roundId === g.roundId && h.sid === me.sid && P.validHand(h.dice, me.dice);
  };

  TableSession.prototype.runEffects = function () {
    try {
      this._ensureHand();
      this._maybeReveal();
    } catch (e) {
      this.onError(e);
    }
  };

  TableSession.prototype._ensureHand = function () {
    var g = this.game;
    var me = this.mySeat();
    if (!g || g.status !== 'playing' || !g.roundId || !me || me.out) return;
    if (this._handValid(this.hand, g, me)) return;
    var key = 'perudo.hand.' + g.gid;
    var h = this.store.get(key);
    if (!this._handValid(h, g, me)) {
      var dice = [];
      for (var i = 0; i < me.dice; i++) dice.push(this.rand.below(6) + 1);
      h = { gid: g.gid, roundId: g.roundId, sid: me.sid, dice: dice };
      this.store.set(key, h);
    }
    this.hand = { gid: h.gid, roundId: h.roundId, sid: h.sid, dice: h.dice.slice() };
    this.onChange();
  };

  TableSession.prototype._maybeReveal = function () {
    var g = this.game;
    var me = this.mySeat();
    if (!g || g.status !== 'playing' || g.phase !== 'reveal' || !me || me.out) return;
    var cur = this.hands[me.sid];
    if (cur && cur.roundId === g.roundId && P.validHand(cur.dice, me.dice)) return;
    if (!this._handValid(this.hand, g, me)) return;
    var key = g.roundId + ':' + this._epoch;
    // resend if the host still hasn't shown our dice a few heartbeats later (the host keeps the first copy)
    if (this._revealSent === key && this.now() - this._revealSentAt < this.timing.heartbeatMs * 3) return;
    var msg = { t: 'reveal', roundId: g.roundId, sid: me.sid, dice: this.hand.dice.slice() };
    if (this.role === 'host') {
      this._revealSent = key;
      this._revealSentAt = this.now();
      this.core.handle(this.pid, msg);
    } else if (this.guestLink && this.guestLink.send(msg)) {
      this._revealSent = key;
      this._revealSentAt = this.now();
    }
  };

  // ---- moves -----------------------------------------------------------------

  TableSession.prototype._expectNow = function () {
    var g = this.game;
    return g ? { roundId: g.roundId, bids: g.bids.length, phase: g.phase } : null;
  };
  TableSession.prototype._precheck = function (fn) {
    if (!this.game) return Promise.reject(P.RuleError('Open a table first.', 'no_table'));
    try { fn(this.game); } catch (e) { return Promise.reject(e); }
    return null;
  };

  TableSession.prototype.leaveLobby = function () { return this._act('leaveLobby'); };
  TableSession.prototype.setCalza = function (on) { return this._act('setCalza', { on: !!on }); };
  TableSession.prototype.startGame = function () { return this._act('start'); };
  TableSession.prototype.bid = function (q, f) {
    var self = this;
    return this._precheck(function (g) { P.placeBid(g, self.pid, q, f); }) || this._act('bid', { q: q, f: f }, this._expectNow());
  };
  TableSession.prototype.dudo = function () {
    var self = this;
    return this._precheck(function (g) { P.callDudo(g, self.pid); }) || this._act('dudo', {}, this._expectNow());
  };
  TableSession.prototype.calza = function () {
    var self = this;
    return this._precheck(function (g) { P.callCalza(g, self.pid); }) || this._act('calza', {}, this._expectNow());
  };
  TableSession.prototype.nextRound = function () {
    var self = this;
    return this._precheck(function (g) { P.advance(g, self.pid, self.hands, { roll: function () { return 1; }, id: function () { return 'x'; } }); }) ||
      this._act('next', {}, this._expectNow());
  };
  TableSession.prototype.removePlayer = function (sid) { return this._act('remove', { sid: sid || null }); };
  TableSession.prototype.claimSeat = function (sid) { return this._act('claim', { sid: sid }); };
  TableSession.prototype.playAgain = function () { return this._act('again'); };
  TableSession.prototype.closeTable = function () { return this._act('close'); };

  TableSession.prototype.revealView = function () {
    var g = this.game;
    if (!g || g.phase !== 'reveal') return null;
    var missing = P.missingHands(g, this.hands);
    var result = null;
    if (!missing.length) {
      try { result = P.resolve(g, this.hands); } catch (e) { result = null; }
    }
    return { missing: missing, result: result };
  };

  var api = {
    PROTOCOL: PROTOCOL, PEER_PREFIX: PEER_PREFIX, CODE_LEN: CODE_LEN,
    normalizeCode: normalizeCode, validCode: validCode, validTable: validTable, makeRandom: makeRandom,
    HostCore: HostCore, HostLink: HostLink, GuestLink: GuestLink, TableSession: TableSession
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.PerudoNet = api;
})(typeof window !== 'undefined' ? window : this);
