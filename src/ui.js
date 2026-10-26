(function () {
  'use strict';
  var P = window.Perudo;
  var Net = window.PerudoNet;
  var $app = document.getElementById('app');
  var $toast = document.getElementById('toast');

  // ---- storage: localStorage when it works, memory otherwise ------------
  var mem = {};
  var storage = {
    get: function (k) {
      if (Object.prototype.hasOwnProperty.call(mem, k)) return JSON.parse(mem[k]);
      try { var v = window.localStorage.getItem(k); return v == null ? null : JSON.parse(v); } catch (e) { return null; }
    },
    set: function (k, v) {
      var s = JSON.stringify(v);
      mem[k] = s;
      try { window.localStorage.setItem(k, s); } catch (e) { /* memory copy is enough for this visit */ }
    },
    remove: function (k) {
      delete mem[k];
      try { window.localStorage.removeItem(k); } catch (e) { /* ignore */ }
    }
  };

  var ui = {
    mode: 'loading',
    name: '',
    code: '',
    calza: true,
    cupOpen: false,
    q: 1, f: 2, pickKey: null,
    armed: null, armedAt: 0,
    busy: null,
    open: {}
  };
  var client = null;

  // ---- small helpers ----------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var PIPS = {
    1: [[50, 50]],
    2: [[30, 30], [70, 70]],
    3: [[27, 27], [50, 50], [73, 73]],
    4: [[30, 30], [70, 30], [30, 70], [70, 70]],
    5: [[28, 28], [72, 28], [50, 50], [28, 72], [72, 72]],
    6: [[30, 26], [70, 26], [30, 50], [70, 50], [30, 74], [70, 74]]
  };
  function die(f, cls) {
    var r = f === 1 ? 13 : 9;
    var pips = PIPS[f].map(function (p) {
      return '<circle class="pip' + (f === 1 ? ' pip-one' : '') + '" cx="' + p[0] + '" cy="' + p[1] + '" r="' + r + '"/>';
    }).join('');
    return '<svg class="die' + (cls ? ' ' + cls : '') + '" viewBox="0 0 100 100" aria-hidden="true" focusable="false">' +
      '<rect class="die-face" x="5" y="5" width="90" height="90" rx="20"/>' + pips + '</svg>';
  }
  function sortDice(d) { return d.slice().sort(function (a, b) { return a - b; }); }
  function isMe(g, sid) { var s = P.seatOf(g, sid); return !!s && s.owner === client.pid && !s.left; }
  function nameOf(g, sid) { var s = P.seatOf(g, sid); return s ? s.name : 'Someone'; }
  function Nm(g, sid) { return isMe(g, sid) ? 'You' : esc(nameOf(g, sid)); }
  function nmo(g, sid) { return isMe(g, sid) ? 'you' : esc(nameOf(g, sid)); }
  function Poss(g, sid) { return isMe(g, sid) ? 'Your' : esc(nameOf(g, sid)) + '’s'; }
  function vb(g, sid, you, other) { return isMe(g, sid) ? you : other; }
  function plural(n, one, many) { return n === 1 ? one : many; }
  function isArmed(key) { return ui.armed === key && Date.now() - ui.armedAt < 4000; }
  function dis() { return ui.busy ? ' disabled' : ''; }
  function isHost() { return !!client && client.role === 'host'; }
  function hostName(g) { var s = P.seatOfOwner(g, hostPid(g)); return s ? s.name : 'the host'; }
  function hostPid(g) { var s = P.seatOf(g, g.host); return s ? s.owner : null; }
  function joinUrl(code) { return location.origin + location.pathname + '?t=' + encodeURIComponent(code); }
  function clearLinkCode() {
    try { if (/[?&]t=/.test(location.search)) history.replaceState(null, '', location.pathname + location.hash); } catch (e) { /* not allowed here */ }
  }

  // ---- rendering: keyed regions so typing and focus survive live updates --
  var lastHtml = {};
  var renderQueued = false;
  function scheduleRender() {
    if (renderQueued) return;
    renderQueued = true;
    (window.requestAnimationFrame || setTimeout)(function () { renderQueued = false; render(); });
  }

  function captureFocus() {
    var a = document.activeElement;
    if (!a || !$app.contains(a)) return null;
    return {
      id: a.id || null,
      key: a.dataset && a.dataset.action ? a.dataset.action + '|' + (a.dataset.sid || a.dataset.f || '') : null,
      s: a.selectionStart, e: a.selectionEnd
    };
  }
  function restoreFocus(f) {
    if (!f) return;
    if (document.activeElement && $app.contains(document.activeElement) && document.activeElement !== document.body) return;
    var el = f.id ? document.getElementById(f.id) : null;
    if (!el && f.key) {
      var all = $app.querySelectorAll('[data-action]');
      for (var i = 0; i < all.length; i++) {
        var x = all[i];
        if (x.dataset.action + '|' + (x.dataset.sid || x.dataset.f || '') === f.key) { el = x; break; }
      }
    }
    if (el && !el.disabled) {
      try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
      if (f.id && typeof f.s === 'number' && el.setSelectionRange) { try { el.setSelectionRange(f.s, f.e); } catch (e2) { /* not a text field */ } }
    }
  }

  function mount(view, regions) {
    var focus = captureFocus();
    var fresh = $app.dataset.view !== view || $app.children.length !== regions.length;
    if (fresh) {
      $app.dataset.view = view;
      $app.innerHTML = regions.map(function (r) {
        return '<div class="region" data-region="' + r[0] + '" style="display:contents">' + r[1] + '</div>';
      }).join('');
      lastHtml = {};
      regions.forEach(function (r) { lastHtml[r[0]] = r[1]; });
    } else {
      regions.forEach(function (r, i) {
        if (lastHtml[r[0]] === r[1]) return;
        $app.children[i].innerHTML = r[1];
        lastHtml[r[0]] = r[1];
      });
    }
    var input = document.getElementById('name');
    if (input && document.activeElement !== input && input.value !== ui.name) input.value = ui.name;
    var codeIn = document.getElementById('code');
    if (codeIn && document.activeElement !== codeIn && codeIn.value !== ui.code) codeIn.value = ui.code;
    restoreFocus(focus);
  }

  function render() {
    if (ui.mode === 'loading') return mount('msg', [['m', '<p class="soft">Loading…</p>']]);
    if (ui.mode === 'nopeer') return mount('msg', [['m', viewNoPeer()]]);
    if (!client.role) return mount('lobby', viewLobby());
    var g = client.game;
    if (!g) return mount('connect', viewConnecting());
    if (g.status === 'lobby') return mount('wait', viewWaiting(g));
    if (g.status === 'over') return mount('over', viewOver(g));
    return mount('play', viewPlaying(g));
  }

  // ---- screens ------------------------------------------------------------
  function viewNoPeer() {
    return '<header><h1 class="wordmark">Perudo</h1></header>' +
      '<div class="conn bad"><b>The game couldn’t start on this browser.</b><p>Reload the page. If it still doesn’t work, open it in an up-to-date Safari or Chrome.</p></div>';
  }

  /** Connection status worth telling the player about, or ''. */
  function connBanner(g) {
    var s = client.link;
    if (isHost()) {
      if (s === 'connecting') return '<div class="conn"><b>Getting the table online…</b><p>Friends can join in a moment.</p></div>';
      if (s === 'reconnecting') return '<div class="conn"><b>Reconnecting to the internet…</b><p>Friends already at the table keep playing. New friends can join once this clears.</p></div>';
      if (s === 'taken') return '<div class="conn bad"><b>This table code is already in use.</b><p>Close this table and create a new one.</p></div>';
      if (s === 'unsupported') return '<div class="conn bad"><b>This browser can’t host a table.</b><p>Open the page in an up-to-date Safari or Chrome.</p></div>';
      return '';
    }
    var host = g ? esc(hostName(g)) : 'the host';
    if (s === 'connecting') return '<div class="conn"><b>Connecting to table ' + esc(client.code) + '…</b></div>';
    if (s === 'reconnecting') return '<div class="conn"><b>Lost the line to ' + host + '’s phone. Reconnecting…</b><p>Your dice are safe on this phone.</p></div>';
    if (s === 'no-host') return '<div class="conn bad"><b>Nobody is hosting table ' + esc(client.code) + ' right now.</b><p>Check the code. If it’s right, ask ' + host + ' to open the page and keep it open.</p></div>';
    if (s === 'outdated') return '<div class="conn bad"><b>' + (g ? host + '’s' : 'The host’s') + ' phone has a different version of the game.</b><p>Both of you: reload the page.</p></div>';
    if (s === 'unsupported') return '<div class="conn bad"><b>This browser can’t connect to the table.</b><p>Open the page in an up-to-date Safari or Chrome.</p></div>';
    return '';
  }

  function viewConnecting() {
    return [
      ['top', '<div class="topline"><span class="code">Table ' + esc(client.code) + '</span><button class="btn quiet" data-action="back">Back</button></div>'],
      ['conn', connBanner(null) || '<p class="soft">Connecting…</p>']
    ];
  }

  function nameField() {
    return '<div class="stack"><label class="label" for="name">Your name</label>' +
      '<input type="text" id="name" maxlength="16" autocomplete="nickname" autocapitalize="words" enterkeyhint="done" placeholder="What your friends call you"></div>';
  }

  function viewLobby() {
    var closed = client.closedCode
      ? '<p class="note">Table ' + esc(client.closedCode) + ' was closed by its host.</p>'
      : '';
    return [
      ['head', '<header><h1 class="wordmark">Perudo</h1><p class="lede">The bluffing dice game. Everyone in the room plays on their own phone.</p></header>'],
      ['closed', closed],
      ['name', nameField()],
      ['join', '<section class="panel" aria-labelledby="join-h"><h2 id="join-h">Join a table</h2>' +
        '<p class="soft small">Scan the QR code on the host’s phone, or type the table code.</p>' +
        '<div class="join-row"><label class="sr" for="code">Table code</label>' +
        '<input type="text" id="code" class="code-input" maxlength="5" autocomplete="off" autocapitalize="characters" spellcheck="false" enterkeyhint="go" placeholder="Code" inputmode="text">' +
        '<button class="btn primary" data-action="join"' + dis() + '>' + (ui.busy === 'join' ? 'Joining…' : 'Join') + '</button></div></section>'],
      ['new', '<section class="panel" aria-labelledby="new-h"><h2 id="new-h">New table</h2>' +
        '<p class="soft small">Your phone hosts the game. Keep this page open while you play.</p>' +
        '<label class="check"><input type="checkbox" id="calza"' + (ui.calza ? ' checked' : '') + '><span>Play with Calza<small>Anyone can claim the last bid is exactly right, to win a die back.</small></span></label>' +
        '<button class="btn primary wide" data-action="create"' + dis() + '>' + (ui.busy === 'create' ? 'Creating…' : 'Create table') + '</button></section>']
    ];
  }

  function topline(g, back) {
    return '<div class="topline"><span class="code">Table ' + esc(g.gid) + '</span>' +
      (back ? '<button class="btn quiet" data-action="back">Back</button>' : '') + '</div>';
  }

  function pips(s) {
    var out = '';
    for (var i = 0; i < P.MAX_DICE; i++) out += '<i' + (i < s.dice ? '' : ' class="lost"') + '></i>';
    return '<span class="pips" role="img" aria-label="' + s.dice + ' ' + plural(s.dice, 'die', 'dice') + '">' + out + '</span>';
  }

  function seatsList(g) {
    var me = P.seatOfOwner(g, client.pid);
    var amHost = isHost();
    var rows = g.seats.filter(function (s) { return g.status !== 'lobby' || !s.left; }).map(function (s) {
      var turn = g.status === 'playing' && g.phase === 'bidding' && g.turn === s.sid;
      var mine = isMe(g, s.sid);
      var offline = !s.left && !client.isOnline(s.owner);
      var tags = (mine ? '<span class="tag">you</span>' : '') + (s.sid === g.host ? '<span class="tag">host</span>' : '') +
        (s.left ? '<span class="tag">left</span>' : (s.out && g.status !== 'lobby' ? '<span class="tag">out</span>' : '')) +
        (offline ? '<span class="tag off">offline</span>' : '');
      var canRemove = amHost && !mine && !s.left && (g.status === 'lobby' || (g.status === 'playing' && !s.out));
      var key = 'remove:' + s.sid;
      var rm = canRemove
        ? '<button class="btn quiet' + (isArmed(key) ? ' armed' : '') + '" data-action="remove" data-sid="' + esc(s.sid) + '"' + dis() + '>' +
          (isArmed(key) ? 'Tap to remove' : 'Remove') + '</button>'
        : '';
      return '<li class="seat' + (turn ? ' is-turn' : '') + (s.out && g.status !== 'lobby' ? ' is-out' : '') + '">' +
        '<span class="seat-mark" aria-hidden="true"></span>' +
        '<span class="seat-name">' + esc(s.name) + tags + (turn ? '<span class="sr"> (bidding now)</span>' : '') + '</span>' +
        '<span class="seat-right">' + (g.status === 'lobby' ? '' : pips(s)) + rm + '</span></li>';
    }).join('');
    return '<section class="stack" aria-labelledby="seats-h"><h2 id="seats-h">' + (g.status === 'lobby' ? 'Who’s in' : 'Around the table') +
      '</h2><ol class="seats">' + rows + '</ol></section>';
  }

  function qrSvg(text) {
    try {
      var qr = window.qrcode(0, 'M');
      qr.addData(text);
      qr.make();
      return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    } catch (e) { return ''; }
  }

  function shareBlock(g) {
    var url = joinUrl(g.gid);
    var canShare = typeof navigator.share === 'function';
    return '<section class="share" aria-label="Invite friends"><div class="qr" role="img" aria-label="QR code that opens this table">' + qrSvg(url) + '</div>' +
      '<div class="stack"><p><b>Friends scan this</b> with their camera, or type the code on their phone.</p>' +
      '<p class="link">' + esc(url) + '</p><div class="row">' +
      '<button class="btn" data-action="copy">' + (ui.copied ? 'Copied' : 'Copy link') + '</button>' +
      (canShare ? '<button class="btn" data-action="share">Share</button>' : '') + '</div></div></section>';
  }

  // waiting room
  function viewWaiting(g) {
    var me = P.seatOfOwner(g, client.pid);
    var active = g.seats.filter(function (s) { return !s.left; });
    var amHost = isHost();
    var stageHtml = '<section class="stage"><p class="status">Waiting to start</p><div class="bid-big" aria-label="Table code ' + esc(g.gid).split('').join(' ') + '">' + esc(g.gid) + '</div></section>';
    var action;
    if (amHost) {
      var enough = active.length >= P.MIN_PLAYERS;
      action = '<section class="panel">' +
        '<label class="check"><input type="checkbox" id="calza-host"' + (g.calza ? ' checked' : '') + dis() + '><span>Play with Calza<small>Anyone can claim the last bid is exactly right, to win a die back.</small></span></label>' +
        '<button class="btn primary wide" data-action="start"' + (enough && !ui.busy ? '' : ' disabled') + '>' +
        (ui.busy === 'start' ? 'Rolling for first player…' : enough ? 'Start game with ' + active.length + ' players' : 'Start game') + '</button>' +
        (enough ? '' : '<p class="hint">Waiting for at least one more player.</p>') +
        '<p class="hint">This phone runs the table. Keep this page open with the screen on.</p></section>';
    } else if (me) {
      action = '<p class="note">Waiting for ' + esc(hostName(g)) + ' to start the game. Calza is ' + (g.calza ? 'on' : 'off') + ' at this table.</p>';
    } else if (active.length >= P.MAX_PLAYERS) {
      action = '<p class="note">This table is full (six players).</p>';
    } else {
      action = '<section class="panel">' + nameField() +
        '<button class="btn primary wide" data-action="join-here"' + dis() + '>' + (ui.busy === 'join' ? 'Joining…' : 'Join table') + '</button></section>';
    }
    var leave;
    if (amHost) {
      var ck = 'close';
      leave = '<div><button class="btn quiet' + (isArmed(ck) ? ' armed' : '') + '" data-action="close"' + dis() + '>' +
        (isArmed(ck) ? 'Tap again to close the table' : 'Close table') + '</button></div>';
    } else if (me) {
      var k = 'leave-lobby';
      leave = '<div><button class="btn quiet' + (isArmed(k) ? ' armed' : '') + '" data-action="leave-lobby"' + dis() + '>' +
        (isArmed(k) ? 'Tap again to leave' : 'Leave table') + '</button></div>';
    } else leave = '';
    return [
      ['top', topline(g, !me)],
      ['conn', connBanner(g)],
      ['stage', stageHtml],
      ['share', (amHost || me) ? shareBlock(g) : ''],
      ['action', action],
      ['seats', seatsList(g)],
      ['leave', leave]
    ];
  }

  // game in progress
  function ensurePick(g, hand) {
    var key = g.roundId + ':' + g.bids.length;
    var total = P.totalDice(g);
    if (ui.pickKey !== key) {
      ui.pickKey = key;
      var prev = P.currentBid(g);
      var f = null;
      var q = 1;
      if (prev) {
        f = prev.f;
        if (P.minQuantity(g, f) === null) f = null;
      } else if (g.palifico) {
        f = hand && hand.dice.length ? hand.dice[0] : 2;
        q = Math.max(1, Math.floor(total / 6));
      } else {
        var counts = [0, 0, 0, 0, 0, 0, 0];
        if (hand) hand.dice.forEach(function (d) { counts[d]++; });
        f = 2;
        for (var x = 3; x <= 6; x++) if (counts[x] >= counts[f]) f = x;
        if (!hand) f = 2;
        q = Math.max(1, Math.floor(total / 3));
      }
      if (f === null) {
        for (var y = 2; y <= 6 && f === null; y++) if (P.minQuantity(g, y) !== null) f = y;
        if (f === null && P.minQuantity(g, 1) !== null) f = 1;
      }
      ui.f = f || 2;
      var min = P.minQuantity(g, ui.f);
      ui.q = min === null ? q : Math.max(min, prev ? min : q);
    }
    var m = P.minQuantity(g, ui.f);
    if (m === null) {
      for (var z = 1; z <= 6; z++) if (P.minQuantity(g, z) !== null) { ui.f = z; m = P.minQuantity(g, z); break; }
    }
    if (m !== null && ui.q < m) ui.q = m;
    if (ui.q > total) ui.q = total;
    if (ui.q < 1) ui.q = 1;
  }

  function calzaAllowed(g, me) {
    var bid = P.currentBid(g);
    return !!g.calza && g.status === 'playing' && g.phase === 'bidding' && !!bid && !!me && !me.out && bid.by !== me.sid;
  }

  function stage(g, me) {
    var bid = P.currentBid(g);
    var total = P.totalDice(g);
    var myTurn = !!me && !me.out && g.phase === 'bidding' && g.turn === me.sid;
    var status = 'Round ' + g.round + '. <b>' + total + '</b> dice on the table. ' + (g.palifico ? '1s are <b>not</b> wild.' : '1s are wild.');
    var big = bid
      ? '<div class="bid-big" role="img" aria-label="Current bid: ' + P.bidWords(bid) + '">' + bid.q + '<span class="x">×</span>' + die(bid.f) + '</div>' +
        '<p class="bid-by">' + Poss(g, bid.by) + ' bid</p>'
      : '<div class="bid-big none">No bid yet</div>';
    var turn;
    if (g.phase === 'reveal') turn = '<span class="turn">Revealing dice</span>';
    else if (myTurn) turn = '<span class="turn mine">' + (bid ? 'Your turn' : 'Your turn to open') + '</span>';
    else turn = '<span class="turn">' + esc(nameOf(g, g.turn)) + (bid ? ' is thinking' : ' opens the round') + '</span>';
    var hist = '';
    if (g.phase === 'bidding' && g.bids.length > 1) {
      hist = '<ol class="history" aria-label="Earlier bids this round">' + g.bids.slice(0, -1).map(function (b) {
        return '<li>' + esc(isMe(g, b.by) ? 'You' : nameOf(g, b.by)) + ' <b>' + b.q + '</b>×' + die(b.f) + '<span class="sr">' + P.FACE_WORDS[b.f] + '</span></li>';
      }).join('') + '</ol>';
    }
    return '<section class="stage"><p class="status">' + status + '</p>' + big + turn + hist + '</section>';
  }

  function paliNote(g) {
    if (!g.palifico || g.phase !== 'bidding') return '';
    var lf = P.lockedFace(g);
    var who = g.starter;
    return '<div class="pali" role="note"><b>Palifico round</b><p>' + Nm(g, who) + ' ' + vb(g, who, 'are', 'is') +
      ' down to one die. 1s are not wild' + (lf ? ', and the face is locked to <b>' + P.FACE_PLURAL[lf] + '</b>: only the quantity can go up.' :
        '. The first bid can be any face, 1s included, and that face stays locked for the round.') + '</p></div>';
  }

  function cup(g, me) {
    var h = client.hand;
    var ready = h && h.roundId === g.roundId && h.sid === me.sid;
    var label, inner;
    if (!ready) {
      label = 'Rolling your dice';
      inner = '<span class="hand"><span>Rolling your dice…</span></span>';
    } else if (ui.cupOpen) {
      var d = sortDice(h.dice);
      label = 'Your dice: ' + d.join(', ') + '. Tap to hide.';
      inner = '<span class="hand">' + d.map(function (x) { return die(x); }).join('') + '</span>';
    } else {
      label = 'Your ' + h.dice.length + ' ' + plural(h.dice.length, 'die is', 'dice are') + ' hidden. Tap to look.';
      inner = '<span class="covered">' + h.dice.map(function () { return '<i></i>'; }).join('') + '</span>';
    }
    return '<button class="cup" data-action="cup" aria-pressed="' + (ui.cupOpen ? 'true' : 'false') + '" aria-label="' + esc(label) + '">' +
      '<span class="cup-head"><b>Your cup</b><span>' + (ready ? (ui.cupOpen ? 'Tap to hide' : 'Tap to look') : '') + '</span></span>' + inner + '</button>';
  }

  function dock(g, me) {
    ensurePick(g, client.hand && client.hand.roundId === g.roundId ? client.hand : null);
    var total = P.totalDice(g);
    var bid = P.currentBid(g);
    var minQ = P.minQuantity(g, ui.f);
    var problem = P.raiseProblem(g, ui.q, ui.f);
    var lf = P.lockedFace(g);
    var faces = [1, 2, 3, 4, 5, 6].map(function (f) {
      var m = P.minQuantity(g, f);
      return '<button class="face" data-action="face" data-f="' + f + '" aria-pressed="' + (ui.f === f ? 'true' : 'false') + '"' +
        (m === null ? ' disabled' : '') + ' aria-label="' + P.FACE_WORDS[f] + (m === null ? ', not allowed now' : ', at least ' + m) + '">' + die(f) + '</button>';
    }).join('');
    var hint;
    if (problem) hint = '<p class="hint bad">' + esc(problem) + '</p>';
    else if (!bid) hint = '<p class="hint">' + (g.palifico ? 'You open the palifico round. Pick any face; it stays locked.' : 'You open the round. Any face but 1s.') + '</p>';
    else if (lf) hint = '<p class="hint">Face locked to ' + P.FACE_PLURAL[lf] + '. Lowest raise: ' + minQ + '.</p>';
    else hint = '<p class="hint">Lowest raise on ' + P.FACE_PLURAL[ui.f] + ': ' + minQ + '.</p>';
    var calza = calzaAllowed(g, me);
    var moves = '<button class="btn primary' + (bid ? '' : ' only') + '" data-action="bid"' + (problem || ui.busy ? ' disabled' : '') + '>' +
      (ui.busy === 'bid' ? 'Bidding…' : 'Bid ' + ui.q + ' × ' + die(ui.f)) + '</button>';
    if (bid) {
      moves += '<button class="btn danger' + (isArmed('dudo') ? ' armed' : '') + '" data-action="dudo"' + dis() + '>' +
        (isArmed('dudo') ? 'Sure? Dudo!' : 'Dudo!') + '</button>';
    }
    if (calza) {
      moves += '<button class="btn gold only' + (isArmed('calza') ? ' armed' : '') + '" data-action="calza"' + dis() + '>' +
        (isArmed('calza') ? 'Sure? It’s exactly ' + P.bidWords(bid) + '!' : 'Calza! (exactly right)') + '</button>';
    }
    return '<section class="dock" aria-labelledby="move-h"><h2 id="move-h">Your move</h2>' +
      '<div class="qty"><button class="btn" data-action="qminus" aria-label="One fewer"' + (minQ === null || ui.q - 1 < minQ ? ' disabled' : '') + '>−</button>' +
      '<output id="qty" aria-live="polite" aria-label="Quantity">' + ui.q + '</output>' +
      '<button class="btn" data-action="qplus" aria-label="One more"' + (ui.q + 1 > total ? ' disabled' : '') + '>+</button></div>' +
      '<div class="faces" role="group" aria-label="Face">' + faces + '</div>' + hint +
      '<div class="moves">' + moves + '</div></section>';
  }

  function calzaRow(g) {
    var bid = P.currentBid(g);
    return '<section class="dock"><div class="calza-row"><p>Think ' + nmo(g, bid.by) + ' bid exactly right? You can call Calza any time.</p>' +
      '<button class="btn gold' + (isArmed('calza') ? ' armed' : '') + '" data-action="calza"' + dis() + '>' +
      (isArmed('calza') ? 'Sure? Calza!' : 'Calza!') + '</button></div></section>';
  }

  /** Outcome sentence. `done` = the change has already been applied to the seats. */
  function verdict(g, res, done) {
    var sid = res.change.sid;
    var seat = P.seatOf(g, sid);
    var after = done ? seat.dice : seat.dice + res.change.delta;
    var count = 'There ' + plural(res.actual, 'is', 'are') + ' ' + P.bidWords({ q: res.actual, f: res.bid.f }) +
      (res.wild && res.bid.f !== 1 ? ', counting wild 1s' : '') + '.';
    var head, detail;
    if (res.type === 'dudo') {
      head = res.bidHolds ? 'The bid holds' : 'It was a bluff';
      detail = Nm(g, sid) + ' ' + vb(g, sid, 'lose', 'loses') + ' a die.';
    } else if (res.exact) {
      head = 'Spot on';
      detail = res.change.delta > 0 ? Nm(g, sid) + ' ' + vb(g, sid, 'win', 'wins') + ' a die back.'
        : Nm(g, sid) + ' already ' + vb(g, sid, 'have', 'has') + ' five dice, so nothing changes.';
    } else {
      head = 'Not exact';
      detail = Nm(g, sid) + ' ' + vb(g, sid, 'lose', 'loses') + ' a die.';
    }
    if (after === 0) detail += ' ' + Nm(g, sid) + ' ' + vb(g, sid, 'are', 'is') + ' out.';
    var pali = done ? res.palificoNext === sid : (after === 1 && res.change.delta < 0 && !seat.palificoUsed);
    if (pali) detail += ' Next round is palifico.';
    return '<div class="verdict" role="status"><b>' + head + '</b><p>' + count + ' ' + detail + '</p></div>';
  }

  function handsList(g, bid, wild, handFor) {
    return '<ul class="hands">' + g.seats.filter(function (s) { return !s.out || handFor(s); }).map(function (seat) {
      var dice = handFor(seat);
      var who = Nm(g, seat.sid);
      if (!dice) {
        var off = !client.isOnline(seat.owner);
        return '<li><span class="who">' + who + '</span><span class="waiting">Waiting for ' + (isMe(g, seat.sid) ? 'your phone' : esc(seat.name) + '’s phone') +
          (off ? ' (offline)' : '') + '…</span></li>';
      }
      var hits = P.countMatches(dice, bid.f, wild);
      return '<li><span class="who">' + who + ': ' + hits + '</span><span class="dice" role="img" aria-label="' + sortDice(dice).join(', ') + '">' +
        sortDice(dice).map(function (d) { return die(d, P.matches(d, bid.f, wild) ? 'hit' : 'miss'); }).join('') + '</span></li>';
    }).join('') + '</ul>';
  }

  function revealLive(g, me) {
    var ch = g.challenge;
    var rv = client.revealView();
    var wild = P.onesWild(g);
    var head = '<h2 class="reveal-head">' + Nm(g, ch.by) + ' called ' + (ch.type === 'dudo' ? 'Dudo' : 'Calza') + ' on ' +
      ch.bid.q + ' × ' + die(ch.bid.f) + '<span class="sr">' + P.FACE_WORDS[ch.bid.f] + '</span></h2>';
    var list = handsList(g, ch.bid, wild, function (seat) {
      if (seat.out) return null;
      var h = client.hands[seat.sid];
      return h && h.roundId === g.roundId && P.validHand(h.dice, seat.dice) ? h.dice : null;
    });
    var res = rv && rv.result;
    var body;
    if (res) {
      var seat = P.seatOf(g, res.change.sid);
      var ends = seat.dice + res.change.delta === 0 && P.aliveSeats(g).length === 2;
      body = verdict(g, res, false) + (me
        ? '<button class="btn primary wide" data-action="next"' + dis() + '>' + (ui.busy === 'next' ? 'Starting…' : ends ? 'See who won' : 'Next round') + '</button>'
        : '');
    } else {
      body = '<p class="soft small">Each phone shows its dice here. A phone that is locked shows them as soon as it’s unlocked with this page open.</p>';
    }
    return '<section class="reveal">' + head + list + body + '</section>';
  }

  function lastRound(g) {
    var r = g.lastResult;
    if (!r || !r.bid) return '';
    var key = 'last-' + g.gid + '-' + r.round;
    var head = (r.type === 'dudo' ? 'Dudo' : 'Calza') + ' on ' + P.bidWords(r.bid) + ': ' +
      (r.type === 'dudo' ? (r.bidHolds ? 'the bid held' : 'a bluff') : (r.exact ? 'spot on' : 'not exact'));
    var list = handsList(g, r.bid, r.wild, function (seat) { return r.hands[seat.sid] || null; });
    return '<details class="last" data-key="' + key + '"' + (ui.open[key] ? ' open' : '') + '><summary>Last round: ' + esc(head) + '</summary>' +
      '<div class="stack">' + verdict(g, r, true) + list + '</div></details>';
  }

  function spectator(g) {
    var seats = g.seats.filter(function (s) { return !s.left && s.sid !== g.host; });
    if (!seats.length) return '<section class="panel"><h2>You’re watching</h2><p class="soft">This game already started. You can join the next one.</p></section>';
    var buttons = seats.map(function (s) {
      var k = 'claim:' + s.sid;
      return '<button class="btn' + (isArmed(k) ? ' armed' : '') + '" data-action="claim" data-sid="' + esc(s.sid) + '"' + dis() + '>' +
        (isArmed(k) ? 'Tap again: I’m ' + esc(s.name) : esc(s.name)) + '</button>';
    }).join('');
    return '<section class="panel"><h2>You’re watching</h2><p class="soft">Switched phones mid-game? Tap your name to take your seat back on this phone. Your dice for this round are rolled again.</p>' +
      '<div class="row">' + buttons + '</div></section>';
  }

  function viewPlaying(g) {
    var me = P.seatOfOwner(g, client.pid);
    var alive = !!me && !me.out;
    var myTurn = alive && g.phase === 'bidding' && g.turn === me.sid;
    var info = '';
    if (g.phase === 'bidding' && !g.bids.length) {
      if (g.note) info += '<p class="note">' + esc(g.note) + '</p>';
      if (g.lastResult) info += lastRound(g);
    }
    var main = '';
    var act = '';
    if (g.phase === 'reveal') {
      act = revealLive(g, me);
    } else {
      if (alive) main = cup(g, me);
      if (myTurn) act = dock(g, me);
      else if (alive && calzaAllowed(g, me)) act = calzaRow(g);
    }
    if (me && me.out) main = '<p class="note">You’re out of dice. Stay and watch who wins' + (isHost() ? ', and keep this page open: your phone runs the table.' : '.') + '</p>';
    var leave = '';
    if (isHost()) {
      leave = '<div class="stack"><div><button class="btn quiet' + (isArmed('close') ? ' armed' : '') + '" data-action="close"' + dis() + '>' +
        (isArmed('close') ? 'Tap again to end the game for everyone' : 'End game') + '</button></div>' +
        '<p class="hint">Your phone runs this table. Keep this page open with the screen on.</p></div>';
    } else if (me) {
      var k = 'leave-game';
      leave = '<div class="stack"><div><button class="btn quiet' + (isArmed(k) ? ' armed' : '') + '" data-action="leave-game"' + dis() + '>' +
        (isArmed(k) ? 'Tap again to leave the game' : 'Leave game') + '</button></div>' +
        (isArmed(k) ? '<p class="hint">' + (me.out ? 'You’ll be marked as left.' : 'You’ll lose your dice and the current round restarts for everyone.') + '</p>' : '') + '</div>';
    }
    return [
      ['top', topline(g, !me || (me.out && !isHost()))],
      ['conn', connBanner(g)],
      ['stage', stage(g, me)],
      ['pali', paliNote(g)],
      ['info', info],
      ['main', main],
      ['act', act],
      ['spect', me ? '' : spectator(g)],
      ['seats', seatsList(g)],
      ['leave', leave]
    ];
  }

  function viewOver(g) {
    var me = P.seatOfOwner(g, client.pid);
    var amHost = isHost();
    var w = g.winner ? P.seatOf(g, g.winner) : null;
    var title = w ? (isMe(g, w.sid) ? 'You win!' : esc(w.name) + ' wins') : 'Game over';
    var stageHtml = '<section class="stage"><p class="status">Game over after ' + g.round + ' ' + plural(g.round, 'round', 'rounds') + '</p>' +
      '<h1 class="winner-name">' + title + '</h1></section>';
    var final = '';
    if (g.note) final += '<p class="note">' + esc(g.note) + '</p>';
    var r = g.lastResult;
    if (r && r.bid) {
      final += '<section class="reveal"><h2 class="reveal-head">Final round: ' + Nm(g, r.by) + ' called ' + (r.type === 'dudo' ? 'Dudo' : 'Calza') +
        ' on ' + r.bid.q + ' × ' + die(r.bid.f) + '<span class="sr">' + P.FACE_WORDS[r.bid.f] + '</span></h2>' +
        handsList(g, r.bid, r.wild, function (seat) { return r.hands[seat.sid] || null; }) + verdict(g, r, true) + '</section>';
    }
    var act;
    if (amHost) {
      act = '<div class="stack"><button class="btn primary wide" data-action="again"' + dis() + '>' + (ui.busy === 'again' ? 'Setting up…' : 'Play again with this table') + '</button>' +
        '<div><button class="btn quiet' + (isArmed('close') ? ' armed' : '') + '" data-action="close"' + dis() + '>' + (isArmed('close') ? 'Tap again to close the table' : 'Close table') + '</button></div></div>';
    } else if (me) {
      var lk = 'leave-game';
      act = '<p class="note">Waiting for ' + esc(hostName(g)) + ' to start another game.</p>' +
        '<div><button class="btn quiet' + (isArmed(lk) ? ' armed' : '') + '" data-action="leave-game"' + dis() + '>' + (isArmed(lk) ? 'Tap again to leave' : 'Leave table') + '</button></div>';
    } else act = '';
    return [['top', topline(g, !me)], ['conn', connBanner(g)], ['stage', stageHtml], ['final', final], ['act', act], ['seats', seatsList(g)]];
  }

  // ---- actions -------------------------------------------------------------
  function toast(msg) {
    $toast.textContent = msg;
    $toast.hidden = false;
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { $toast.hidden = true; }, 4200);
  }

  function run(key, fn, opts) {
    if (ui.busy) return;
    ui.busy = key;
    ui.armed = null;
    render();
    Promise.resolve().then(fn).catch(function (e) {
      if (opts && opts.quietStale && e && e.code === 'stale') return;
      toast((e && e.message) || 'That didn’t work. Try again.');
    }).then(function () {
      ui.busy = null;
      render();
    });
  }

  function confirmThen(key, fn) {
    if (isArmed(key)) { ui.armed = null; fn(); return; }
    ui.armed = key;
    ui.armedAt = Date.now();
    render();
    setTimeout(function () { if (ui.armed === key && !isArmed(key)) { ui.armed = null; render(); } }, 4100);
  }

  function needName() {
    var n = P.cleanName(ui.name);
    if (!n) {
      toast('Type your name first.');
      var el = document.getElementById('name');
      if (el) el.focus();
      return null;
    }
    ui.name = n;
    storage.set('perudo.name', n);
    return n;
  }

  function copyLink() {
    var url = joinUrl(client.code);
    function done() { ui.copied = true; render(); setTimeout(function () { ui.copied = false; render(); }, 2000); }
    function fallback() {
      var el = document.querySelector('.share .link');
      if (el && window.getSelection) {
        var r = document.createRange();
        r.selectNodeContents(el);
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
      toast('Select the link above and copy it.');
    }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, fallback);
      else fallback();
    } catch (e) { fallback(); }
  }

  var wakeLock = null;
  function keepAwake() {
    if (!client || !client.role || wakeLock || !navigator.wakeLock || document.visibilityState !== 'visible') return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wakeLock = lock;
      lock.addEventListener('release', function () { wakeLock = null; });
    }).catch(function () { wakeLock = null; });
  }
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible' || !client) return;
    keepAwake();
    client.poke();
  });
  function buzz(pattern) { try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* not supported */ } }

  $app.addEventListener('click', function (e) {
    var b = e.target.closest('[data-action]');
    if (!b || b.disabled || !client) return;
    var a = b.dataset.action;
    var g = client.game;
    keepAwake();
    switch (a) {
      case 'create': {
        var n = needName();
        if (n) run('create', function () { client.closedCode = null; return client.create(n, ui.calza).then(function () { clearLinkCode(); }); });
        break;
      }
      case 'join': {
        var code = Net.normalizeCode(ui.code);
        if (!Net.validCode(code)) { toast('Type the 5-letter table code.'); var ci = document.getElementById('code'); if (ci) ci.focus(); break; }
        var n2 = needName();
        if (n2) run('join', function () { client.closedCode = null; return client.join(code, n2); });
        break;
      }
      case 'join-here': {
        var n3 = needName();
        var here = client.code;
        if (n3) run('join', function () { return client.join(here, n3); });
        break;
      }
      case 'back': client.closeView(); clearLinkCode(); break;
      case 'start': run('start', function () { return client.startGame(); }); break;
      case 'leave-lobby': confirmThen('leave-lobby', function () { run('leave', function () { return client.leaveLobby().then(function () { client.closeView(); clearLinkCode(); }); }); }); break;
      case 'remove': { var sid = b.dataset.sid; confirmThen('remove:' + sid, function () { run('remove', function () { return client.removePlayer(sid); }); }); break; }
      case 'leave-game': confirmThen('leave-game', function () { run('leave', function () { return client.removePlayer(null).then(function () { client.closeView(); clearLinkCode(); }); }); }); break;
      case 'claim': { var cs = b.dataset.sid; confirmThen('claim:' + cs, function () { run('claim', function () { return client.claimSeat(cs); }); }); break; }
      case 'cup': ui.cupOpen = !ui.cupOpen; storage.set('perudo.cupOpen', ui.cupOpen); render(); break;
      case 'qminus': ui.q = Math.max(1, ui.q - 1); render(); break;
      case 'qplus': ui.q = ui.q + 1; render(); break;
      case 'face': {
        var f = Number(b.dataset.f);
        var crossing = (f === 1) !== (ui.f === 1);
        ui.f = f;
        var m = g ? P.minQuantity(g, f) : null;
        if (m !== null && (crossing || ui.q < m)) ui.q = m;
        render();
        break;
      }
      case 'bid': { var q = ui.q, face = ui.f; run('bid', function () { return client.bid(q, face); }); break; }
      case 'dudo': confirmThen('dudo', function () { run('dudo', function () { return client.dudo(); }); }); break;
      case 'calza': confirmThen('calza', function () { run('calza', function () { return client.calza(); }); }); break;
      case 'next': run('next', function () { return client.nextRound(); }, { quietStale: true }); break;
      case 'again': run('again', function () { return client.playAgain(); }); break;
      case 'close': confirmThen('close', function () { run('close', function () { return client.closeTable().then(function () { clearLinkCode(); }); }); }); break;
      case 'copy': copyLink(); break;
      case 'share': {
        var url = joinUrl(client.code);
        try { navigator.share({ title: 'Perudo table ' + client.code, text: 'Join my Perudo table ' + client.code, url: url }).catch(function () { /* dismissed */ }); }
        catch (err) { copyLink(); }
        break;
      }
    }
  });
  $app.addEventListener('input', function (e) {
    if (e.target.id === 'name') ui.name = e.target.value;
    if (e.target.id === 'code') {
      var v = Net.normalizeCode(e.target.value).slice(0, 5);
      if (v !== e.target.value) e.target.value = v;
      ui.code = v;
    }
  });
  $app.addEventListener('change', function (e) {
    var t = e.target;
    if (t.id === 'name') { var n = P.cleanName(t.value); if (n) storage.set('perudo.name', n); }
    if (t.id === 'calza') ui.calza = t.checked;
    if (t.id === 'calza-host') { var on = t.checked; run('calza-host', function () { return client.setCalza(on); }); }
  });
  $app.addEventListener('keydown', function (e) {
    if (e.target.id === 'name' && e.key === 'Enter') e.target.blur();
    if (e.target.id === 'code' && e.key === 'Enter') { var btn = $app.querySelector('[data-action="join"]'); if (btn) btn.click(); }
  });
  $app.addEventListener('toggle', function (e) {
    var d = e.target;
    if (d && d.dataset && d.dataset.key) ui.open[d.dataset.key] = d.open;
  }, true);

  // ---- start ---------------------------------------------------------------
  function localId() {
    var a = new Uint32Array(4);
    crypto.getRandomValues(a);
    return 'p-' + Array.prototype.map.call(a, function (x) { return x.toString(36); }).join('');
  }

  function start() {
    if (!window.Peer || !Net || !window.crypto || !window.crypto.getRandomValues) { ui.mode = 'nopeer'; render(); return; }
    var pid = storage.get('perudo.pid');
    if (!pid) { pid = localId(); storage.set('perudo.pid', pid); }
    ui.name = storage.get('perudo.name') || '';
    ui.cupOpen = storage.get('perudo.cupOpen') === true;
    var peerOptions = window.PERUDO_PEER_OPTIONS || {
      debug: 0,
      config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] }
    };
    client = new Net.TableSession({
      pid: pid,
      storage: storage,
      Peer: window.Peer,
      peerOptions: peerOptions,
      onChange: scheduleRender,
      onEvent: function (kind) {
        if (kind === 'my_turn') buzz(70);
        if (kind === 'reveal') buzz([40, 60, 40]);
      },
      onError: function (e) { if (window.console) console.warn('[perudo]', e && (e.code || e.message || e)); }
    });
    var linkCode = null;
    try { linkCode = new URLSearchParams(location.search).get('t'); } catch (e) { linkCode = null; }
    if (linkCode) ui.code = Net.normalizeCode(linkCode).slice(0, 5);
    ui.mode = 'ready';
    client.resume(linkCode);
    render();
  }

  start();
})();
