/* Perudo rules engine: pure functions over a plain-JSON table state.
 * Every action takes the current state and returns a new state, or throws
 * RuleError with a message a player can read. Randomness and ids come in
 * through ctx so the engine stays deterministic under test. */
(function (root) {
  'use strict';

  var MAX_DICE = 5;
  var MIN_PLAYERS = 2;
  var MAX_PLAYERS = 6;
  var NAME_MAX = 16;
  var FACE_PLURAL = ['', '1s', '2s', '3s', '4s', '5s', '6s'];
  var FACE_WORDS = ['', 'ones', 'twos', 'threes', 'fours', 'fives', 'sixes'];

  function RuleError(message, code) {
    var e = new Error(message);
    e.name = 'RuleError';
    e.code = code || 'rule';
    e.isRuleError = true;
    return e;
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function cleanName(raw) {
    var s = String(raw == null ? '' : raw)
      .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (Array.from(s).length > NAME_MAX) s = Array.from(s).slice(0, NAME_MAX).join('').trim();
    return s;
  }

  // ---- seats -------------------------------------------------------------

  function seatOf(state, sid) {
    for (var i = 0; i < state.seats.length; i++) if (state.seats[i].sid === sid) return state.seats[i];
    return null;
  }
  function seatOfOwner(state, owner) {
    for (var i = 0; i < state.seats.length; i++) {
      var s = state.seats[i];
      if (s.owner === owner && !s.left) return s;
    }
    return null;
  }
  function aliveSeats(state) { return state.seats.filter(function (s) { return !s.out; }); }
  function totalDice(state) {
    return aliveSeats(state).reduce(function (n, s) { return n + s.dice; }, 0);
  }
  /** Next seat clockwise (seat order) after `sid` that still has dice. Never `sid` itself. */
  function nextAlive(state, sid) {
    var n = state.seats.length;
    var i = -1;
    for (var k = 0; k < n; k++) if (state.seats[k].sid === sid) { i = k; break; }
    if (i < 0) throw RuleError('Unknown seat.', 'internal');
    for (var step = 1; step < n; step++) {
      var s = state.seats[(i + step) % n];
      if (!s.out) return s.sid;
    }
    return null;
  }
  function requireSeat(state, owner) {
    var s = seatOfOwner(state, owner);
    if (!s) throw RuleError('You are not seated at this table.', 'not_seated');
    return s;
  }
  function requireHost(state, owner) {
    var s = requireSeat(state, owner);
    if (s.sid !== state.host) throw RuleError('Only the host can do that.', 'not_host');
    return s;
  }
  function pickNewHost(state) {
    var h = seatOf(state, state.host);
    if (h && !h.left) return;
    var next = state.seats.find(function (s) { return !s.left; });
    state.host = next ? next.sid : null;
  }

  // ---- table lifecycle ---------------------------------------------------

  function newTable(opts) {
    var name = cleanName(opts.name);
    if (!name) throw RuleError('Type your name first.', 'name');
    return {
      v: 1,
      gid: opts.gid,
      createdAt: opts.now,
      updatedAt: opts.now,
      seq: 0,
      status: 'lobby',
      calza: opts.calza !== false,
      host: opts.sid,
      seats: [newSeat(opts.sid, opts.owner, name)],
      round: 0,
      roundId: null,
      phase: null,
      starter: null,
      turn: null,
      palifico: false,
      bids: [],
      challenge: null,
      lastResult: null,
      firstRoll: null,
      winner: null,
      note: null
    };
  }

  function newSeat(sid, owner, name) {
    return { sid: sid, owner: owner, name: name, dice: MAX_DICE, out: false, palificoUsed: false, left: false };
  }

  function addPlayer(state, owner, sid, rawName) {
    var s = clone(state);
    if (s.status !== 'lobby') throw RuleError('This game has already started.', 'started');
    if (seatOfOwner(s, owner)) throw RuleError('You are already at this table.', 'already');
    var name = cleanName(rawName);
    if (!name) throw RuleError('Type your name first.', 'name');
    var active = s.seats.filter(function (x) { return !x.left; });
    if (active.length >= MAX_PLAYERS) throw RuleError('This table is full (6 players).', 'full');
    var lower = name.toLocaleLowerCase();
    if (active.some(function (x) { return x.name.toLocaleLowerCase() === lower; })) {
      throw RuleError('Someone here is already called ' + name + '. Pick another name.', 'name_taken');
    }
    s.seats.push(newSeat(sid, owner, name));
    return s;
  }

  /** Leave (or remove someone from) a table that has not started. Returns null when the table is empty. */
  function leaveLobby(state, owner, targetSid) {
    var s = clone(state);
    if (s.status !== 'lobby') throw RuleError('The game has started. Use Leave game instead.', 'started');
    var me = requireSeat(s, owner);
    var target = targetSid || me.sid;
    if (target !== me.sid && me.sid !== s.host) throw RuleError('Only the host can remove players.', 'not_host');
    if (!seatOf(s, target)) throw RuleError('That player already left.', 'gone');
    s.seats = s.seats.filter(function (x) { return x.sid !== target; });
    if (!s.seats.some(function (x) { return !x.left; })) return null;
    pickNewHost(s);
    return s;
  }

  function setCalza(state, owner, on) {
    var s = clone(state);
    requireHost(s, owner);
    if (s.status !== 'lobby') throw RuleError('Rules can only change before the game starts.', 'started');
    s.calza = !!on;
    return s;
  }

  /** Each player rolls one die; highest goes first; tied players roll again. */
  function rollForFirst(sids, roll) {
    var passes = [];
    var contenders = sids.slice();
    for (var guard = 0; guard < 200; guard++) {
      var rolls = contenders.map(function (sid) { return { sid: sid, roll: roll() }; });
      passes.push(rolls);
      var max = Math.max.apply(null, rolls.map(function (r) { return r.roll; }));
      var top = rolls.filter(function (r) { return r.roll === max; });
      if (top.length === 1) return { passes: passes, winner: top[0].sid };
      contenders = top.map(function (r) { return r.sid; });
    }
    return { passes: passes, winner: contenders[0] };
  }

  function beginRound(s, starter, palifico, roundId) {
    s.round += 1;
    s.roundId = roundId;
    s.phase = 'bidding';
    s.starter = starter;
    s.turn = starter;
    s.palifico = !!palifico;
    s.bids = [];
    s.challenge = null;
  }

  function startGame(state, owner, ctx) {
    var s = clone(state);
    requireHost(s, owner);
    if (s.status !== 'lobby') throw RuleError('This game has already started.', 'started');
    s.seats = s.seats.filter(function (x) { return !x.left; });
    if (s.seats.length < MIN_PLAYERS) throw RuleError('You need at least 2 players to start.', 'too_few');
    if (s.seats.length > MAX_PLAYERS) throw RuleError('At most 6 players can play.', 'full');
    s.seats.forEach(function (x) { x.dice = MAX_DICE; x.out = false; x.palificoUsed = false; });
    s.status = 'playing';
    s.round = 0;
    s.winner = null;
    s.lastResult = null;
    s.note = null;
    s.firstRoll = rollForFirst(s.seats.map(function (x) { return x.sid; }), ctx.roll);
    beginRound(s, s.firstRoll.winner, false, ctx.id());
    return s;
  }

  // ---- bidding -----------------------------------------------------------

  function currentBid(state) { return state.bids.length ? state.bids[state.bids.length - 1] : null; }
  function lockedFace(state) { return state.palifico && state.bids.length ? state.bids[0].f : null; }
  function onesWild(state) { return !state.palifico; }

  /** Why a bid of q × f is not a legal next bid right now, or null if it is. */
  function raiseProblem(state, q, f) {
    if (typeof q !== 'number' || q % 1 !== 0 || q < 1) return 'The quantity must be at least 1.';
    if (typeof f !== 'number' || f % 1 !== 0 || f < 1 || f > 6) return 'Pick a face from 1 to 6.';
    var total = totalDice(state);
    if (q > total) return 'There are only ' + total + ' dice on the table.';
    var prev = currentBid(state);
    if (state.palifico) {
      if (!prev) return null;
      if (f !== prev.f) return 'Palifico: the face is locked to ' + FACE_PLURAL[prev.f] + '. Raise the quantity only.';
      if (q <= prev.q) return 'Bid more than ' + prev.q + ' ' + FACE_PLURAL[f] + '.';
      return null;
    }
    if (!prev) return f === 1 ? 'A round cannot open on 1s.' : null;
    if (prev.f === 1) {
      if (f === 1) return q > prev.q ? null : 'Bid more than ' + prev.q + ' 1s.';
      var minOut = 2 * prev.q + 1;
      return q >= minOut ? null : 'Leaving 1s needs at least ' + minOut + ' (double plus one).';
    }
    if (f === 1) {
      var minIn = Math.ceil(prev.q / 2);
      return q >= minIn ? null : 'Switching to 1s needs at least ' + minIn + ' (half, rounded up).';
    }
    if (q > prev.q) return null;
    if (q === prev.q && f > prev.f) return null;
    if (q === prev.q) return 'At ' + q + ' dice, pick a face higher than ' + prev.f + '.';
    return 'Bid at least ' + prev.q + ' dice.';
  }

  /** Smallest legal quantity for face f, or null if no quantity up to the dice on the table works. */
  function minQuantity(state, f) {
    var total = totalDice(state);
    for (var q = 1; q <= total; q++) if (raiseProblem(state, q, f) === null) return q;
    return null;
  }

  function requireBidding(s) {
    if (s.status !== 'playing') throw RuleError('The game is not running.', 'not_playing');
    if (s.phase !== 'bidding') throw RuleError('The dice are being revealed.', 'not_bidding');
  }

  function placeBid(state, owner, q, f) {
    var s = clone(state);
    requireBidding(s);
    var me = requireSeat(s, owner);
    if (me.out) throw RuleError('You are out of dice.', 'out');
    if (s.turn !== me.sid) throw RuleError('It is not your turn.', 'not_turn');
    var problem = raiseProblem(s, q, f);
    if (problem) throw RuleError(problem, 'illegal_bid');
    s.bids.push({ q: q, f: f, by: me.sid });
    s.turn = nextAlive(s, me.sid);
    s.note = null;
    return s;
  }

  function callDudo(state, owner) {
    var s = clone(state);
    requireBidding(s);
    var me = requireSeat(s, owner);
    if (me.out) throw RuleError('You are out of dice.', 'out');
    if (s.turn !== me.sid) throw RuleError('You can only call Dudo on your turn.', 'not_turn');
    var bid = currentBid(s);
    if (!bid) throw RuleError('There is no bid to challenge yet.', 'no_bid');
    if (bid.by === me.sid) throw RuleError('You cannot challenge your own bid.', 'own_bid');
    s.challenge = { type: 'dudo', by: me.sid, bid: clone(bid) };
    s.phase = 'reveal';
    s.turn = null;
    s.note = null;
    return s;
  }

  function callCalza(state, owner) {
    var s = clone(state);
    requireBidding(s);
    if (!s.calza) throw RuleError('Calza is switched off at this table.', 'calza_off');
    var me = requireSeat(s, owner);
    if (me.out) throw RuleError('You are out of dice.', 'out');
    var bid = currentBid(s);
    if (!bid) throw RuleError('There is no bid to call Calza on yet.', 'no_bid');
    if (bid.by === me.sid) throw RuleError('You cannot call Calza on your own bid.', 'own_bid');
    s.challenge = { type: 'calza', by: me.sid, bid: clone(bid) };
    s.phase = 'reveal';
    s.turn = null;
    s.note = null;
    return s;
  }

  // ---- reveal and resolution --------------------------------------------

  function validHand(dice, n) {
    if (!Array.isArray(dice) || dice.length !== n) return false;
    for (var i = 0; i < dice.length; i++) {
      var d = dice[i];
      if (typeof d !== 'number' || d % 1 !== 0 || d < 1 || d > 6) return false;
    }
    return true;
  }

  function matches(die, face, wild) { return die === face || (wild && face !== 1 && die === 1); }

  function countMatches(dice, face, wild) {
    var n = 0;
    for (var i = 0; i < dice.length; i++) if (matches(dice[i], face, wild)) n++;
    return n;
  }

  /** Seats whose dice are still missing for this reveal. */
  function missingHands(state, hands) {
    if (state.phase !== 'reveal') return [];
    return aliveSeats(state).filter(function (seat) {
      var h = hands && hands[seat.sid];
      return !(h && h.roundId === state.roundId && validHand(h.dice, seat.dice));
    }).map(function (seat) { return seat.sid; });
  }

  /** What the reveal shows. Pure; does not change the table. */
  function resolve(state, hands) {
    if (state.phase !== 'reveal' || !state.challenge) throw RuleError('Nothing to reveal.', 'no_reveal');
    var missing = missingHands(state, hands);
    if (missing.length) throw RuleError('Still waiting for everyone’s dice.', 'waiting');
    var ch = state.challenge;
    var bid = ch.bid;
    var wild = onesWild(state);
    var shown = {};
    var actual = 0;
    aliveSeats(state).forEach(function (seat) {
      var dice = hands[seat.sid].dice.slice();
      shown[seat.sid] = dice;
      actual += countMatches(dice, bid.f, wild);
    });
    var out = {
      round: state.round,
      type: ch.type,
      by: ch.by,
      bid: clone(bid),
      actual: actual,
      wild: wild,
      palifico: !!state.palifico,
      hands: shown,
      change: null
    };
    if (ch.type === 'dudo') {
      out.bidHolds = actual >= bid.q;
      out.change = { sid: out.bidHolds ? ch.by : bid.by, delta: -1 };
    } else {
      out.exact = actual === bid.q;
      if (out.exact) {
        var caller = seatOf(state, ch.by);
        out.change = { sid: ch.by, delta: caller.dice < MAX_DICE ? 1 : 0 };
      } else {
        out.change = { sid: ch.by, delta: -1 };
      }
    }
    return out;
  }

  /** Apply the revealed outcome and start the next round (or end the game). */
  function advance(state, owner, hands, ctx) {
    if (!seatOfOwner(state, owner)) throw RuleError('Only players at this table can continue.', 'not_seated');
    var res = resolve(state, hands);
    var s = clone(state);
    var seat = seatOf(s, res.change.sid);
    seat.dice = Math.max(0, Math.min(MAX_DICE, seat.dice + res.change.delta));
    res.eliminated = [];
    if (seat.dice === 0) { seat.out = true; res.eliminated.push(seat.sid); }
    var alive = aliveSeats(s);
    res.palificoNext = null;
    if (alive.length <= 1) {
      s.status = 'over';
      s.winner = alive.length ? alive[0].sid : null;
      s.phase = null;
      s.turn = null;
      s.challenge = null;
      s.lastResult = res;
      s.note = null;
      return s;
    }
    var starter = seat.out ? nextAlive(s, seat.sid) : seat.sid;
    var palifico = !seat.out && res.change.delta < 0 && seat.dice === 1 && !seat.palificoUsed;
    if (palifico) { seat.palificoUsed = true; res.palificoNext = seat.sid; }
    res.nextStarter = starter;
    s.lastResult = res;
    s.note = null;
    beginRound(s, starter, palifico, ctx.id());
    return s;
  }

  // ---- people coming and going mid-game ----------------------------------

  /** Leave a running game, or (host) remove a player whose phone is gone. The round restarts with fresh dice. */
  function removePlayer(state, owner, targetSid, ctx) {
    var s = clone(state);
    var me = requireSeat(s, owner);
    var target = targetSid || me.sid;
    if (target !== me.sid && me.sid !== s.host) throw RuleError('Only the host can remove players.', 'not_host');
    var t = seatOf(s, target);
    if (!t || t.left) throw RuleError('That player already left.', 'gone');
    if (s.status === 'lobby') return leaveLobby(state, owner, target);
    var wasAlive = !t.out;
    t.left = true;
    t.out = true;
    t.dice = 0;
    pickNewHost(s);
    if (s.status === 'over' || !wasAlive) return s;
    var alive = aliveSeats(s);
    if (alive.length <= 1) {
      s.status = 'over';
      s.winner = alive.length ? alive[0].sid : null;
      s.phase = null;
      s.turn = null;
      s.challenge = null;
      s.note = t.name + ' left the game.';
      return s;
    }
    var starter = s.starter && !seatOf(s, s.starter).out ? s.starter : nextAlive(s, s.starter);
    var palifico = s.palifico && starter === s.starter;
    beginRound(s, starter, palifico, ctx.id());
    s.note = t.name + ' left, so the round restarted with fresh dice.';
    return s;
  }

  /** Take over a seat from another phone (same person, new device). */
  function claimSeat(state, owner, sid) {
    var s = clone(state);
    if (seatOfOwner(s, owner)) throw RuleError('You already have a seat here.', 'already');
    var t = seatOf(s, sid);
    if (!t || t.left) throw RuleError('That seat is no longer at the table.', 'gone');
    t.owner = owner;
    return s;
  }

  function playAgain(state, owner) {
    var s = clone(state);
    requireHost(s, owner);
    if (s.status !== 'over') throw RuleError('The game is still running.', 'not_over');
    s.seats = s.seats.filter(function (x) { return !x.left; });
    s.seats.forEach(function (x) { x.dice = MAX_DICE; x.out = false; x.palificoUsed = false; });
    s.status = 'lobby';
    s.round = 0;
    s.roundId = null;
    s.phase = null;
    s.starter = null;
    s.turn = null;
    s.palifico = false;
    s.bids = [];
    s.challenge = null;
    s.lastResult = null;
    s.firstRoll = null;
    s.winner = null;
    s.note = null;
    return s;
  }

  // ---- words -------------------------------------------------------------

  var FACE_SINGULAR = ['', 'one', 'two', 'three', 'four', 'five', 'six'];
  function bidText(b) { return b.q + ' × ' + FACE_PLURAL[b.f]; }
  function bidWords(b) { return b.q + ' ' + (b.q === 1 ? FACE_SINGULAR[b.f] : FACE_WORDS[b.f]); }

  var api = {
    MAX_DICE: MAX_DICE, MIN_PLAYERS: MIN_PLAYERS, MAX_PLAYERS: MAX_PLAYERS, NAME_MAX: NAME_MAX,
    FACE_PLURAL: FACE_PLURAL, FACE_WORDS: FACE_WORDS,
    RuleError: RuleError, clone: clone, cleanName: cleanName,
    seatOf: seatOf, seatOfOwner: seatOfOwner, aliveSeats: aliveSeats, totalDice: totalDice, nextAlive: nextAlive,
    newTable: newTable, addPlayer: addPlayer, leaveLobby: leaveLobby, setCalza: setCalza,
    rollForFirst: rollForFirst, startGame: startGame,
    currentBid: currentBid, lockedFace: lockedFace, onesWild: onesWild,
    raiseProblem: raiseProblem, minQuantity: minQuantity,
    placeBid: placeBid, callDudo: callDudo, callCalza: callCalza,
    validHand: validHand, matches: matches, countMatches: countMatches, missingHands: missingHands,
    resolve: resolve, advance: advance,
    removePlayer: removePlayer, claimSeat: claimSeat, playAgain: playAgain,
    bidText: bidText, bidWords: bidWords
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Perudo = api;
})(typeof window !== 'undefined' ? window : this);
