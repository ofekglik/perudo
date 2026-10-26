'use strict';
const assert = require('node:assert/strict');
const P = require('../src/engine.js');

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; } catch (e) { console.error('FAIL', name); throw e; }
}

let idn = 0;
const ctx = (rolls) => {
  const seq = rolls ? rolls.slice() : null;
  return { roll: () => (seq && seq.length ? seq.shift() : 1 + Math.floor(Math.random() * 6)), id: () => 'r' + (++idn) };
};

function table(names, opts = {}) {
  let s = P.newTable({ gid: 'GAME', sid: 's0', owner: 'u0', name: names[0], calza: opts.calza !== false, now: 1 });
  for (let i = 1; i < names.length; i++) s = P.addPlayer(s, 'u' + i, 's' + i, names[i]);
  return s;
}
function started(n, opts = {}) {
  const names = ['Ana', 'Ben', 'Cy', 'Dee', 'Eli', 'Fay'].slice(0, n);
  // first-player roll: give seat 0 a 6 and everyone else 1 so seat 0 starts
  const rolls = [6].concat(Array(n - 1).fill(1));
  return P.startGame(table(names, opts), 'u0', ctx(rolls));
}
const owner = (s, sid) => P.seatOf(s, sid).owner;
function withBid(s, q, f) { return P.placeBid(s, owner(s, s.turn), q, f); }
function hands(s, map) {
  const h = {};
  for (const seat of P.aliveSeats(s)) h[seat.sid] = { roundId: s.roundId, sid: seat.sid, dice: map[seat.sid] };
  return h;
}

// ---- raise rules --------------------------------------------------------
test('opening bid cannot be on 1s outside palifico', () => {
  const s = started(3);
  assert.match(P.raiseProblem(s, 3, 1), /cannot open on 1s/);
  assert.equal(P.raiseProblem(s, 1, 2), null);
  assert.equal(P.raiseProblem(s, 15, 6), null);
  assert.match(P.raiseProblem(s, 16, 6), /only 15 dice/);
  assert.match(P.raiseProblem(s, 0, 3), /at least 1/);
  assert.match(P.raiseProblem(s, 2.5, 3), /at least 1/);
  assert.match(P.raiseProblem(s, 2, 7), /face/);
});

test('raise: more dice any face, or same dice higher face', () => {
  let s = started(4);
  s = withBid(s, 5, 4);
  assert.equal(P.raiseProblem(s, 5, 5), null);
  assert.equal(P.raiseProblem(s, 5, 6), null);
  assert.equal(P.raiseProblem(s, 6, 2), null);
  assert.equal(P.raiseProblem(s, 6, 4), null);
  assert.ok(P.raiseProblem(s, 5, 4));
  assert.ok(P.raiseProblem(s, 5, 3));
  assert.ok(P.raiseProblem(s, 4, 6));
});

test('switching to 1s: half rounded up (seven 4s -> four 1s)', () => {
  let s = started(4);
  s = withBid(s, 7, 4);
  assert.equal(P.raiseProblem(s, 4, 1), null);
  assert.match(P.raiseProblem(s, 3, 1), /at least 4/);
  assert.equal(P.minQuantity(s, 1), 4);
  s = started(4);
  s = withBid(s, 5, 3);
  assert.equal(P.minQuantity(s, 1), 3);
  s = started(4);
  s = withBid(s, 6, 3);
  assert.equal(P.minQuantity(s, 1), 3);
  s = started(4);
  s = withBid(s, 1, 6);
  assert.equal(P.minQuantity(s, 1), 1);
});

test('leaving 1s: double plus one (four 1s -> nine 2s)', () => {
  let s = started(4);
  s = withBid(s, 7, 4);
  s = withBid(s, 4, 1);
  assert.equal(P.raiseProblem(s, 9, 2), null);
  assert.match(P.raiseProblem(s, 8, 6), /at least 9/);
  assert.equal(P.minQuantity(s, 2), 9);
  assert.equal(P.minQuantity(s, 6), 9);
  assert.equal(P.raiseProblem(s, 5, 1), null);
  assert.ok(P.raiseProblem(s, 4, 1));
  assert.equal(P.minQuantity(s, 1), 5);
});

test('leaving 1s can be impossible when double plus one exceeds the table', () => {
  let s = started(2); // 10 dice
  s = withBid(s, 4, 3);
  s = withBid(s, 5, 1);
  assert.equal(P.minQuantity(s, 4), null); // needs 11
  assert.equal(P.minQuantity(s, 1), 6);
});

test('minQuantity matches raiseProblem everywhere (monotone in quantity)', () => {
  for (let trial = 0; trial < 300; trial++) {
    let s = started(2 + (trial % 5));
    const total = P.totalDice(s);
    for (let k = 0; k < 4; k++) {
      const faces = [1, 2, 3, 4, 5, 6].filter((f) => P.minQuantity(s, f) !== null);
      if (!faces.length) break;
      const f = faces[Math.floor(Math.random() * faces.length)];
      const min = P.minQuantity(s, f);
      for (let q = 1; q <= total; q++) assert.equal(P.raiseProblem(s, q, f) === null, q >= min, `q=${q} f=${f} min=${min}`);
      s = withBid(s, min + Math.floor(Math.random() * 2 * (min < total)), f);
    }
  }
});

// ---- counting -----------------------------------------------------------
test('counting: 1s are wild for other faces, never double-count when bidding 1s', () => {
  assert.equal(P.countMatches([1, 1, 4, 4, 5], 4, true), 4);
  assert.equal(P.countMatches([1, 1, 4, 4, 5], 4, false), 2);
  assert.equal(P.countMatches([1, 1, 4, 4, 5], 1, true), 2);
  assert.equal(P.countMatches([1, 1, 4, 4, 5], 1, false), 2);
  assert.equal(P.countMatches([2, 3, 6], 5, true), 0);
});

// ---- dudo ---------------------------------------------------------------
test('dudo: bid true (count equals bid) -> challenger loses and starts', () => {
  let s = started(3);
  s = withBid(s, 4, 5); // s0 bids
  const r1 = s.roundId;
  s = P.callDudo(s, 'u1'); // s1 challenges
  assert.equal(s.phase, 'reveal');
  const h = hands(s, { s0: [5, 5, 2, 3, 4], s1: [1, 2, 3, 4, 6], s2: [5, 2, 2, 3, 3] });
  const res = P.resolve(s, h);
  assert.equal(res.actual, 4);
  assert.equal(res.bidHolds, true);
  assert.deepEqual(res.change, { sid: 's1', delta: -1 });
  s = P.advance(s, 'u2', h, ctx());
  assert.equal(P.seatOf(s, 's1').dice, 4);
  assert.equal(s.starter, 's1');
  assert.equal(s.turn, 's1');
  assert.notEqual(s.roundId, r1);
  assert.equal(s.round, 2);
  assert.deepEqual(s.bids, []);
  assert.equal(s.lastResult.actual, 4);
});

test('dudo: bid false (count below bid) -> bidder loses and starts', () => {
  let s = started(3);
  s = withBid(s, 5, 5);
  s = P.callDudo(s, 'u1');
  const h = hands(s, { s0: [5, 5, 2, 3, 4], s1: [1, 2, 3, 4, 6], s2: [5, 2, 2, 3, 3] });
  const res = P.resolve(s, h);
  assert.equal(res.actual, 4);
  assert.equal(res.bidHolds, false);
  s = P.advance(s, 'u0', h, ctx());
  assert.equal(P.seatOf(s, 's0').dice, 4);
  assert.equal(s.starter, 's0');
});

test('dudo only on your own turn, needs a bid, not on your own bid', () => {
  let s = started(3);
  assert.throws(() => P.callDudo(s, 'u0'), /no bid/);
  s = withBid(s, 2, 3);
  assert.throws(() => P.callDudo(s, 'u2'), /only call Dudo on your turn/);
  assert.throws(() => P.callDudo(s, 'u0'), /only call Dudo on your turn/);
  assert.doesNotThrow(() => P.callDudo(s, 'u1'));
});

test('bidding only on your turn; turn moves clockwise and skips players who are out', () => {
  let s = started(4);
  assert.throws(() => P.placeBid(s, 'u2', 3, 3), /not your turn/);
  s = withBid(s, 2, 3);
  assert.equal(s.turn, 's1');
  // knock s2 out
  const t = P.clone(s); P.seatOf(t, 's2').out = true; P.seatOf(t, 's2').dice = 0;
  const u = P.placeBid(t, 'u1', 3, 3);
  assert.equal(u.turn, 's3');
  const v = P.placeBid(u, 'u3', 4, 3);
  assert.equal(v.turn, 's0');
});

// ---- calza --------------------------------------------------------------
test('calza exact -> caller gains a die (capped at 5) and starts', () => {
  let s = started(3);
  s = withBid(s, 3, 5);
  s = withBid(s, 4, 5); // s1 bids four 5s
  const st = P.clone(s); P.seatOf(st, 's2').dice = 3;
  let c = P.callCalza(st, 'u2');
  const h = hands(c, { s0: [5, 1, 2, 3, 4], s1: [2, 2, 3, 4, 6], s2: [5, 5, 3] });
  const res = P.resolve(c, h);
  assert.equal(res.actual, 4);
  assert.equal(res.exact, true);
  assert.deepEqual(res.change, { sid: 's2', delta: 1 });
  c = P.advance(c, 'u0', h, ctx());
  assert.equal(P.seatOf(c, 's2').dice, 4);
  assert.equal(c.starter, 's2');
  // at 5 dice: gain nothing
  let d = P.callCalza(s, 'u2');
  const h2 = hands(d, { s0: [5, 1, 2, 3, 4], s1: [2, 2, 3, 4, 6], s2: [5, 5, 3, 3, 3] });
  assert.equal(P.resolve(d, h2).change.delta, 0);
  d = P.advance(d, 'u0', h2, ctx());
  assert.equal(P.seatOf(d, 's2').dice, 5);
  assert.equal(d.starter, 's2');
});

test('calza wrong -> caller loses a die; bidder never loses', () => {
  let s = started(3);
  s = withBid(s, 3, 5);
  s = P.callCalza(s, 'u2');
  const h = hands(s, { s0: [5, 1, 2, 3, 4], s1: [5, 5, 3, 4, 6], s2: [2, 2, 2, 2, 2] });
  const res = P.resolve(s, h);
  assert.equal(res.actual, 4);
  assert.equal(res.exact, false);
  s = P.advance(s, 'u0', h, ctx());
  assert.equal(P.seatOf(s, 's2').dice, 4);
  assert.equal(P.seatOf(s, 's0').dice, 5);
  assert.equal(s.starter, 's2');
});

test('calza: anyone but the bidder, any time a bid stands, and only when switched on', () => {
  let s = started(3);
  assert.throws(() => P.callCalza(s, 'u1'), /no bid/);
  s = withBid(s, 2, 2);
  assert.throws(() => P.callCalza(s, 'u0'), /own bid/);
  assert.doesNotThrow(() => P.callCalza(s, 'u1')); // whose turn it is
  assert.doesNotThrow(() => P.callCalza(s, 'u2')); // not their turn
  let off = started(3, { calza: false });
  off = withBid(off, 2, 2);
  assert.throws(() => P.callCalza(off, 'u2'), /switched off/);
});

// ---- palifico -----------------------------------------------------------
test('palifico: dropping to one die starts a palifico round once per player', () => {
  let s = started(3);
  const t = P.clone(s); P.seatOf(t, 's0').dice = 2; s = t;
  s = withBid(s, 9, 6); // s0 bids too high
  s = P.callDudo(s, 'u1');
  let h = hands(s, { s0: [2, 3], s1: [2, 2, 3, 4, 5], s2: [2, 3, 4, 5, 2] });
  s = P.advance(s, 'u1', h, ctx());
  assert.equal(P.seatOf(s, 's0').dice, 1);
  assert.equal(s.palifico, true);
  assert.equal(s.starter, 's0');
  assert.equal(P.seatOf(s, 's0').palificoUsed, true);
  assert.equal(s.lastResult.palificoNext, 's0');
  // palifico: opener may bid 1s; 1s are not wild; face locked
  assert.equal(P.raiseProblem(s, 2, 1), null);
  s = withBid(s, 2, 3);
  assert.equal(P.lockedFace(s), 3);
  assert.match(P.raiseProblem(s, 3, 4), /locked/);
  assert.match(P.raiseProblem(s, 5, 1), /locked/);
  assert.match(P.raiseProblem(s, 2, 3), /more than 2/);
  assert.equal(P.raiseProblem(s, 3, 3), null);
  assert.equal(P.minQuantity(s, 3), 3);
  assert.equal(P.minQuantity(s, 4), null);
  s = withBid(s, 3, 3);
  s = P.callDudo(s, 'u2');
  h = hands(s, { s0: [3], s1: [1, 1, 3, 4, 5], s2: [1, 3, 4, 5, 6] });
  const res = P.resolve(s, h);
  assert.equal(res.wild, false);
  assert.equal(res.actual, 3);
  s = P.advance(s, 'u0', h, ctx());
  assert.equal(s.palifico, false); // s2 lost and went to 4: normal round
  assert.equal(s.starter, 's2');
});

test('palifico does not repeat for a player who climbs back via calza and drops again', () => {
  let s = started(3);
  let t = P.clone(s); P.seatOf(t, 's0').dice = 1; P.seatOf(t, 's0').palificoUsed = true; s = t;
  s = withBid(s, 2, 4); // s0
  s = withBid(s, 3, 4); // s1
  s = P.callCalza(s, 'u0');
  let h = hands(s, { s0: [4], s1: [4, 2, 2, 2, 2], s2: [1, 3, 3, 3, 3] });
  s = P.advance(s, 'u1', h, ctx());
  assert.equal(P.seatOf(s, 's0').dice, 2);
  assert.equal(s.palifico, false);
  assert.equal(s.starter, 's0');
  s = withBid(s, 8, 6);
  s = P.callDudo(s, 'u1');
  h = hands(s, { s0: [2, 2], s1: [4, 2, 2, 2, 2], s2: [1, 3, 3, 3, 3] });
  s = P.advance(s, 'u1', h, ctx());
  assert.equal(P.seatOf(s, 's0').dice, 1);
  assert.equal(s.palifico, false);
});

test('a failed calza that drops the caller to one die also starts palifico', () => {
  let s = started(3);
  const t = P.clone(s); P.seatOf(t, 's2').dice = 2; s = t;
  s = withBid(s, 3, 5);
  s = P.callCalza(s, 'u2');
  const h = hands(s, { s0: [2, 2, 2, 2, 2], s1: [2, 2, 2, 2, 2], s2: [2, 2] });
  s = P.advance(s, 'u0', h, ctx());
  assert.equal(P.seatOf(s, 's2').dice, 1);
  assert.equal(s.palifico, true);
  assert.equal(s.starter, 's2');
});

// ---- elimination and game end --------------------------------------------
test('loser with no dice left is out; the next player clockwise starts', () => {
  let s = started(3);
  const t = P.clone(s); P.seatOf(t, 's1').dice = 1; P.seatOf(t, 's1').palificoUsed = true; s = t;
  s = withBid(s, 2, 2);   // s0
  s = withBid(s, 9, 6);   // s1 bluffs
  s = P.callDudo(s, 'u2');
  const h = hands(s, { s0: [2, 2, 2, 2, 2], s1: [3], s2: [2, 2, 2, 2, 2] });
  s = P.advance(s, 'u2', h, ctx());
  assert.equal(P.seatOf(s, 's1').out, true);
  assert.deepEqual(s.lastResult.eliminated, ['s1']);
  assert.equal(s.starter, 's2');
  assert.equal(s.status, 'playing');
});

test('last player with dice wins', () => {
  let s = started(2);
  const t = P.clone(s); P.seatOf(t, 's1').dice = 1; P.seatOf(t, 's1').palificoUsed = true; s = t;
  s = withBid(s, 2, 2);
  s = P.callDudo(s, 'u1');
  const h = hands(s, { s0: [2, 2, 3, 4, 5], s1: [6] });
  s = P.advance(s, 'u0', h, ctx());
  assert.equal(s.status, 'over');
  assert.equal(s.winner, 's0');
  assert.equal(s.phase, null);
  assert.throws(() => P.placeBid(s, 'u0', 1, 2), /not running/);
});

test('resolve waits for every hand, with the right count of dice', () => {
  let s = started(3);
  s = withBid(s, 2, 2);
  s = P.callDudo(s, 'u1');
  const h = hands(s, { s0: [2, 2, 3, 4, 5], s1: [1, 2, 3, 4, 5], s2: [1, 2, 3, 4, 5] });
  delete h.s2;
  assert.deepEqual(P.missingHands(s, h), ['s2']);
  assert.throws(() => P.resolve(s, h), /waiting/);
  h.s2 = { roundId: 'old', dice: [1, 2, 3, 4, 5] };
  assert.deepEqual(P.missingHands(s, h), ['s2']);
  h.s2 = { roundId: s.roundId, dice: [1, 2, 3, 4] };
  assert.deepEqual(P.missingHands(s, h), ['s2']);
  h.s2 = { roundId: s.roundId, dice: [1, 2, 3, 4, 7] };
  assert.deepEqual(P.missingHands(s, h), ['s2']);
});

// ---- first player -------------------------------------------------------
test('first player: highest single die; ties roll again among the tied', () => {
  const r = P.rollForFirst(['a', 'b', 'c', 'd'], ctx([6, 2, 6, 6, 3, 5, 5, 4, 1]).roll);
  // pass1: a6 b2 c6 d6 -> a,c,d; pass2: a3 c5 d5 -> c,d; pass3: c4 d1 -> c
  assert.equal(r.winner, 'c');
  assert.equal(r.passes.length, 3);
  assert.deepEqual(r.passes[2], [{ sid: 'c', roll: 4 }, { sid: 'd', roll: 1 }]);
  const s = P.startGame(table(['A', 'B', 'C']), 'u0', ctx([2, 5, 1]));
  assert.equal(s.starter, 's1');
  assert.equal(s.turn, 's1');
  assert.equal(s.round, 1);
});

// ---- lobby --------------------------------------------------------------
test('lobby: 2-6 players, unique names, host only start, cannot join after start', () => {
  let s = table(['Ana']);
  assert.throws(() => P.startGame(s, 'u0', ctx()), /at least 2/);
  assert.throws(() => P.addPlayer(s, 'u9', 'x', 'ana '), /already called/);
  assert.throws(() => P.addPlayer(s, 'u0', 'x', 'Zed'), /already at this table/);
  assert.throws(() => P.addPlayer(s, 'u9', 'x', '   '), /name/);
  for (let i = 1; i < 6; i++) s = P.addPlayer(s, 'u' + i, 's' + i, 'P' + i);
  assert.throws(() => P.addPlayer(s, 'u7', 's7', 'Seven'), /full/);
  assert.throws(() => P.startGame(s, 'u1', ctx()), /Only the host/);
  s = P.startGame(s, 'u0', ctx());
  assert.equal(P.totalDice(s), 30);
  assert.throws(() => P.addPlayer(s, 'u8', 's8', 'Late'), /already started/);
  assert.equal(P.cleanName('  a​  b\u0007  '), 'a b');
  assert.equal(Array.from(P.cleanName('x'.repeat(40))).length, P.NAME_MAX);
});

test('lobby: leaving passes host on; last one out deletes the table', () => {
  let s = table(['Ana', 'Ben']);
  s = P.leaveLobby(s, 'u0');
  assert.equal(s.host, 's1');
  assert.equal(s.seats.length, 1);
  assert.equal(P.leaveLobby(s, 'u1'), null);
  let t = table(['Ana', 'Ben', 'Cy']);
  assert.throws(() => P.leaveLobby(t, 'u1', 's2'), /Only the host/);
  t = P.leaveLobby(t, 'u0', 's2');
  assert.equal(t.seats.length, 2);
});

test('leaving mid-game restarts the round with fresh dice and the same opener', () => {
  let s = started(4);
  s = withBid(s, 3, 3);
  s = withBid(s, 4, 3);
  const before = s.roundId;
  s = P.removePlayer(s, 'u2', null, ctx());
  assert.equal(P.seatOf(s, 's2').out, true);
  assert.equal(P.seatOf(s, 's2').left, true);
  assert.notEqual(s.roundId, before);
  assert.equal(s.starter, 's0');
  assert.deepEqual(s.bids, []);
  assert.match(s.note, /left/);
  // host removes the opener: next player opens
  s = P.removePlayer(s, 'u0', 's0', ctx());
  assert.equal(s.host, 's1');
  assert.equal(s.starter, 's1');
  assert.throws(() => P.removePlayer(s, 'u3', 's1', ctx()), /Only the host/);
  s = P.removePlayer(s, 'u3', null, ctx());
  assert.equal(s.status, 'over');
  assert.equal(s.winner, 's1');
});

test('leaving during palifico keeps palifico only if its player still opens', () => {
  let s = started(3);
  let t = P.clone(s); t.palifico = true; P.seatOf(t, 's0').dice = 1; s = t;
  let a = P.removePlayer(s, 'u1', null, ctx());
  assert.equal(a.palifico, true);
  let b = P.removePlayer(s, 'u0', null, ctx());
  assert.equal(b.palifico, false);
  assert.equal(b.starter, 's1');
});

test('claim seat moves the seat to a new phone; play again resets to lobby', () => {
  let s = started(3);
  assert.throws(() => P.claimSeat(s, 'u1', 's2'), /already have a seat/);
  s = P.claimSeat(s, 'newphone', 's2');
  assert.equal(P.seatOf(s, 's2').owner, 'newphone');
  assert.equal(P.seatOfOwner(s, 'u2'), null);
  const t = P.clone(s); P.seatOf(t, 's1').dice = 0; P.seatOf(t, 's1').out = true; P.seatOf(t, 's2').dice = 0; P.seatOf(t, 's2').out = true;
  t.status = 'over'; t.winner = 's0';
  const again = P.playAgain(t, 'u0');
  assert.equal(again.status, 'lobby');
  assert.ok(again.seats.every((x) => x.dice === 5 && !x.out && !x.palificoUsed));
  assert.throws(() => P.playAgain(s, 'u0'), /still running/);
});

test('bid text', () => {
  assert.equal(P.bidText({ q: 5, f: 4 }), '5 × 4s');
  assert.equal(P.bidWords({ q: 1, f: 6 }), '1 six');
  assert.equal(P.bidWords({ q: 3, f: 6 }), '3 sixes');
});

// ---- random full games: invariants --------------------------------------
test('5,000 random games end with one winner and never break a rule', () => {
  let rounds = 0, calzas = 0, palificos = 0, gains = 0;
  for (let g = 0; g < 5000; g++) {
    const n = 2 + (g % 5);
    let s = P.startGame(table(['A', 'B', 'C', 'D', 'E', 'F'].slice(0, n), { calza: g % 3 !== 0 }), 'u0', ctx());
    let guard = 0;
    while (s.status === 'playing') {
      assert.ok(++guard < 5000, 'game did not end');
      assert.equal(s.phase, 'bidding');
      const turnSeat = P.seatOf(s, s.turn);
      assert.ok(turnSeat && !turnSeat.out, 'turn on a live seat');
      assert.equal(s.starter, s.round && s.bids.length === 0 ? s.turn : s.starter);
      if (s.palifico) palificos += s.bids.length === 0 ? 1 : 0;
      // the table rolls hidden dice
      const map = {};
      for (const seat of P.aliveSeats(s)) map[seat.sid] = Array.from({ length: seat.dice }, () => 1 + Math.floor(Math.random() * 6));
      // bidding
      let calledBy = null;
      for (let k = 0; k < 40; k++) {
        const bid = P.currentBid(s);
        if (s.calza && bid && Math.random() < 0.06) {
          const others = P.aliveSeats(s).filter((x) => x.sid !== bid.by);
          const c = others[Math.floor(Math.random() * others.length)];
          s = P.callCalza(s, c.owner); calledBy = 'calza'; calzas++; break;
        }
        const faces = [1, 2, 3, 4, 5, 6].filter((f) => P.minQuantity(s, f) !== null);
        if (bid && (!faces.length || Math.random() < 0.3)) { s = P.callDudo(s, P.seatOf(s, s.turn).owner); calledBy = 'dudo'; break; }
        assert.ok(faces.length, 'opening always has a legal bid');
        const f = faces[Math.floor(Math.random() * faces.length)];
        const q = P.minQuantity(s, f) + (Math.random() < 0.2 ? 1 : 0);
        const qq = Math.min(q, P.totalDice(s));
        const prevTotal = P.totalDice(s);
        s = P.placeBid(s, P.seatOf(s, s.turn).owner, qq, f);
        assert.equal(P.totalDice(s), prevTotal);
      }
      if (!calledBy) s = P.callDudo(s, P.seatOf(s, s.turn).owner);
      const before = P.totalDice(s);
      const h = {};
      for (const sid of Object.keys(map)) h[sid] = { roundId: s.roundId, dice: map[sid] };
      const res = P.resolve(s, h);
      // independent recount
      let actual = 0;
      for (const sid of Object.keys(map)) for (const d of map[sid]) if (d === res.bid.f || (!s.palifico && res.bid.f !== 1 && d === 1)) actual++;
      assert.equal(res.actual, actual);
      const anyone = P.aliveSeats(s)[0].owner;
      s = P.advance(s, anyone, h, ctx());
      rounds++;
      const after = P.totalDice(s);
      if (res.change.delta > 0) gains++;
      assert.equal(after, before + res.change.delta);
      for (const seat of s.seats) {
        assert.equal(seat.out, seat.dice === 0);
        assert.ok(seat.dice >= 0 && seat.dice <= 5);
      }
      if (s.status === 'playing') {
        assert.ok(!P.seatOf(s, s.starter).out);
        if (s.palifico) assert.equal(P.seatOf(s, s.starter).dice, 1);
      }
    }
    assert.equal(s.status, 'over');
    assert.equal(P.aliveSeats(s).length, 1);
    assert.equal(s.winner, P.aliveSeats(s)[0].sid);
  }
  assert.ok(calzas > 100 && palificos > 100 && gains > 10, `coverage calza=${calzas} palifico=${palificos} gains=${gains}`);
  console.log(`  simulated ${rounds} rounds, ${calzas} calzas, ${palificos} palifico rounds, ${gains} dice won back`);
});

console.log(`engine: ${passed} tests passed`);
