'use strict';
/* Several phones on a fake PeerJS network, playing through the real TableSession. */
const assert = require('node:assert/strict');
const P = require('../src/engine.js');
const N = require('../src/net.js');
const { Hub, memoryStorage } = require('./fakepeer.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, what, timeout = 15000) {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try { ok = cond(); } catch (e) { ok = false; }
    if (ok) return;
    if (Date.now() - t0 > timeout) throw new Error('timed out waiting for: ' + what);
    await sleep(5);
  }
}

const TIMING = { heartbeatMs: 60, timeoutMs: 450, actTimeoutMs: 4000, joinTimeoutMs: 6000, openTimeoutMs: 700 };
const errors = [];
const NAMES = ['Ofek', 'Noa', 'Lior', 'Maya', 'Dan', 'Tal'];

function phone(hub, i, opts = {}) {
  const storage = opts.storage || memoryStorage();
  const pid = opts.pid || 'pid' + i + '-' + Math.random().toString(36).slice(2, 7);
  const s = new N.TableSession({
    pid, storage, Peer: hub.Peer, timing: Object.assign({}, TIMING, opts.timing || {}),
    onError: (e) => errors.push(['p' + i, e && (e.code || e.message)])
  });
  s.label = 'p' + i;
  s.storage = storage;
  return s;
}

/** Every message on the wire that carries dice must belong to a reveal in progress. */
function guardPrivacy(hub, getHost) {
  const leaks = [];
  hub.sendHooks.push((from, to, msg) => {
    const core = getHost() && getHost().core;
    if (msg.t === 'reveal') {
      const s = core && core.state;
      if (!s || s.phase !== 'reveal' || s.roundId !== msg.roundId) leaks.push('reveal sent outside its reveal: ' + JSON.stringify(msg).slice(0, 80));
    }
    if (msg.t === 'state' && msg.hands) {
      for (const [sid, h] of Object.entries(msg.hands)) {
        if (!msg.state || msg.state.phase !== 'reveal' || h.roundId !== msg.state.roundId) leaks.push('state carried dice outside a reveal for ' + sid);
      }
    }
    if (msg.t === 'state' && msg.state && JSON.stringify(msg.state).includes('"dice":[') && msg.state.phase === 'bidding') {
      // lastResult may carry the PREVIOUS round's revealed dice; the current round must not appear
      const cur = msg.state.roundId;
      if (JSON.stringify(msg.state).includes(cur + '","dice"')) leaks.push('current round dice inside table state');
    }
  });
  return leaks;
}

async function setupTable(hub, n, opts = {}) {
  const phones = [];
  for (let i = 0; i < n; i++) phones.push(phone(hub, i, (opts.phoneOpts || {})[i]));
  const host = phones[0];
  const code = await host.create(NAMES[0], opts.calza !== false);
  await waitFor(() => host.link === 'open', 'host registered');
  await Promise.all(phones.slice(1).map((p, k) => p.join(code, NAMES[k + 1])));
  await waitFor(() => phones.every((p) => p.game && p.game.seats.length === n), 'everyone sees all seats');
  return { phones, host, code };
}

const caughtUp = (phones, g) => phones.every((p) => p.game && p.game.seq >= g.seq);
const truth = (host) => host.core.state;

async function playUntilOver(phones, host, opts = {}) {
  const stats = { rounds: 0, dudo: 0, calza: 0, calzaRaces: 0 };
  for (let step = 0; step < 5000; step++) {
    const g = truth(host);
    if (g.status === 'over') return stats;
    if (opts.onStep) await opts.onStep(g, stats);
    const g2 = truth(host);
    if (g2.seq !== g.seq) continue;
    await waitFor(() => caughtUp(phones, g), 'phones catch up to ' + g.seq);
    const seated = phones.filter((p) => P.seatOfOwner(g, p.pid));
    if (g.phase === 'bidding') {
      await waitFor(() => seated.every((p) => { const s = P.seatOfOwner(g, p.pid); return s.out || (p.hand && p.hand.roundId === g.roundId && p.hand.dice.length === s.dice); }), 'hands rolled');
      const turnPhone = seated.find((p) => P.seatOfOwner(g, p.pid).sid === g.turn);
      const bid = P.currentBid(g);
      if (g.calza && bid && Math.random() < 0.08) {
        const callers = seated.filter((p) => { const s = P.seatOfOwner(g, p.pid); return !s.out && s.sid !== bid.by; });
        if (callers.length >= 2 && Math.random() < 0.5) {
          const results = await Promise.allSettled([callers[0].calza(), callers[1].calza()]);
          assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'exactly one of two simultaneous calzas lands');
          const bad = results.find((r) => r.status === 'rejected').reason;
          assert.ok(['stale', 'not_bidding'].includes(bad.code), 'the other was told the table changed: ' + bad.code);
          stats.calzaRaces++;
        } else {
          await callers[Math.floor(Math.random() * callers.length)].calza();
        }
        stats.calza++;
        continue;
      }
      const faces = [1, 2, 3, 4, 5, 6].filter((f) => P.minQuantity(g, f) !== null);
      if (bid && (!faces.length || Math.random() < 0.28)) { await turnPhone.dudo(); stats.dudo++; continue; }
      const f = faces[Math.floor(Math.random() * faces.length)];
      const q = Math.min(P.minQuantity(g, f) + (Math.random() < 0.25 ? 1 : 0), P.totalDice(g));
      const other = seated.find((p) => p !== turnPhone && !P.seatOfOwner(g, p.pid).out);
      await assert.rejects(other.bid(q, f), (e) => e.code === 'not_turn');
      await turnPhone.bid(q, f);
      continue;
    }
    if (g.phase === 'reveal') {
      await waitFor(() => phones.every((p) => p.revealView() && p.revealView().result), 'everyone sees the full reveal', 20000);
      for (const p of seated) {
        const s = P.seatOfOwner(g, p.pid);
        if (s.out) continue;
        assert.deepEqual(host.core.hands[s.sid].dice, p.hand.dice, p.label + ' revealed exactly the dice it held');
      }
      const outcomes = phones.map((p) => JSON.stringify(p.revealView().result));
      assert.ok(outcomes.every((o) => o === outcomes[0]), 'all phones show the same outcome');
      const expected = P.resolve(g, host.core.hands);
      const a = seated[Math.floor(Math.random() * seated.length)];
      const b = seated.find((p) => p !== a);
      const results = await Promise.allSettled([a.nextRound(), b.nextRound()]);
      assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, 'next round advances once');
      assert.equal(results.find((r) => r.status === 'rejected').reason.code, 'stale');
      const after = truth(host);
      assert.equal(P.seatOf(after, expected.change.sid).dice, Math.min(5, Math.max(0, P.seatOf(g, expected.change.sid).dice + expected.change.delta)));
      stats.rounds++;
      continue;
    }
    throw new Error('unexpected phase ' + g.phase);
  }
  throw new Error('game did not finish');
}

function stopAll(phones) { phones.forEach((p) => p.closeView()); }

async function scenarioFullGames() {
  for (let n = 2; n <= 6; n++) {
    const hub = new Hub();
    let host = null;
    const leaks = guardPrivacy(hub, () => host);
    const t = await setupTable(hub, n);
    host = t.host;
    const { phones } = t;
    await assert.rejects(phones[1].startGame(), (e) => e.code === 'not_host');
    await host.startGame();
    const stats = await playUntilOver(phones, host);
    const g = truth(host);
    assert.equal(g.status, 'over');
    assert.equal(P.aliveSeats(g).length, 1);
    await waitFor(() => phones.every((p) => p.game && p.game.status === 'over'), 'everyone sees game over');
    await host.playAgain();
    await waitFor(() => phones.every((p) => p.game && p.game.status === 'lobby'), 'back in lobby');
    assert.deepEqual(leaks, []);
    stopAll(phones);
    console.log(`  ${n} phones: ${stats.rounds} rounds, ${stats.dudo} dudo, ${stats.calza} calza (${stats.calzaRaces} simultaneous)`);
  }
}

async function scenarioConnections() {
  const hub = new Hub();
  let host = null;
  const leaks = guardPrivacy(hub, () => host);

  // a code nobody hosts
  const lost = phone(hub, 9, { timing: { joinTimeoutMs: 1500 } });
  await assert.rejects(lost.join('ZZZZZ', 'Nobody'), (e) => e.code === 'unreachable' && /No table ZZZZZ/.test(e.message));
  assert.equal(lost.link, 'no-host');
  assert.throws(() => lost.open('AB1'), /5 letters/);
  lost.closeView();

  const t = await setupTable(hub, 4);
  host = t.host;
  let phones = t.phones;
  const code = t.code;
  await host.startGame();
  let g = truth(host);
  await waitFor(() => phones.every((p) => p.hand && p.hand.roundId === g.roundId), 'hands');
  assert.deepEqual(host.online.slice().sort(), phones.map((p) => p.pid).sort(), 'everyone online');

  // 1. Noa's phone goes to sleep; the host notices; she wakes up and is back with the same dice
  const noa = phones[1];
  const noaDice = noa.hand.dice.slice();
  const noaPeer = noa.guestLink.peer.id;
  hub.freeze(noaPeer);
  await waitFor(() => !host.online.includes(noa.pid), 'host sees Noa offline');
  hub.thaw(noaPeer);
  await waitFor(() => noa.link === 'open' && host.online.includes(noa.pid), 'Noa back online');
  assert.deepEqual(noa.hand.dice, noaDice);

  // 2. a challenge while Lior's phone sleeps: the reveal waits for him
  g = truth(host);
  const turnPhone = phones.find((p) => P.seatOfOwner(g, p.pid).sid === g.turn);
  await turnPhone.bid(3, 4);
  g = truth(host);
  await waitFor(() => caughtUp(phones, g), 'caught up');
  const lior = phones[2];
  const challenger = phones.find((p) => P.seatOfOwner(g, p.pid).sid === g.turn);
  const liorPeer = lior.guestLink.peer.id;
  if (challenger === lior) {
    await lior.dudo();
    hub.freeze(liorPeer);
  } else {
    hub.freeze(liorPeer);
    await challenger.dudo();
  }
  await sleep(300);
  const sidLior = P.seatOfOwner(truth(host), lior.pid).sid;
  const missing = P.missingHands(truth(host), host.core.hands);
  if (challenger !== lior) assert.ok(missing.includes(sidLior), 'reveal waits for the sleeping phone');
  hub.thaw(liorPeer);
  await waitFor(() => phones.every((p) => p.revealView() && p.revealView().result), 'reveal completes once Lior wakes');
  assert.deepEqual(host.core.hands[sidLior].dice, lior.hand.dice);

  // 3. the host's page reloads in the middle of the reveal
  const hostStorage = host.storage;
  const hostPid = host.pid;
  const hostDice = host.hand.dice.slice();
  host.closeView();
  const host2 = phone(hub, 0, { storage: hostStorage, pid: hostPid });
  assert.equal(host2.resume(null), 'host');
  host = host2;
  phones = [host2].concat(phones.slice(1));
  await waitFor(() => host2.link === 'open', 'host re-registered its code');
  await waitFor(() => phones.slice(1).every((p) => p.link === 'open') && host2.online.length === 4, 'guests reconnected to the reloaded host');
  assert.deepEqual(host2.hand.dice, hostDice, 'host kept its dice');
  await waitFor(() => phones.every((p) => p.revealView() && p.revealView().result), 'reveal still complete after reload');
  await phones[3].nextRound();

  // 4. a guest reloads: same dice
  g = truth(host);
  await waitFor(() => caughtUp(phones, g) && phones.every((p) => p.hand && p.hand.roundId === g.roundId), 'new round');
  const maya = phones[3];
  const mayaDice = maya.hand.dice.slice();
  maya.closeView = maya.closeView.bind(maya);
  maya.guestLink.stop(); // the page just vanishes, storage stays
  const maya2 = phone(hub, 3, { storage: maya.storage, pid: maya.pid });
  assert.equal(maya2.resume(null), 'guest');
  phones[3] = maya2;
  await waitFor(() => maya2.game && maya2.hand && maya2.hand.roundId === g.roundId, 'Maya reloaded');
  assert.deepEqual(maya2.hand.dice, mayaDice);

  // 5. the signalling server goes down: open lines keep working
  hub.signalling(false);
  await sleep(100);
  g = truth(host);
  const tp = phones.find((p) => P.seatOfOwner(g, p.pid).sid === g.turn);
  const fq = P.minQuantity(g, 5) !== null ? 5 : 6;
  await tp.bid(P.minQuantity(g, fq), fq);
  assert.equal(truth(host).bids.length, g.bids.length + 1, 'a bid went through with signalling down');
  hub.signalling(true);
  await waitFor(() => host.link === 'open', 'host re-registered after the outage', 20000);

  // 6. Lior moves to a new phone and takes over his seat; nobody can take the host's seat
  const liorSid = P.seatOfOwner(truth(host), lior.pid).sid;
  lior.closeView();
  const newPhone = phone(hub, 7);
  newPhone.open(code);
  await waitFor(() => newPhone.game, 'watching');
  await assert.rejects(newPhone.claimSeat(P.seatOfOwner(truth(host), host.pid).sid), (e) => e.code === 'host_stays');
  await newPhone.claimSeat(liorSid);
  await waitFor(() => newPhone.hand && newPhone.hand.roundId === truth(host).roundId, 'claimed seat has dice');
  phones[2] = newPhone;

  // 7. the host cannot remove itself or leave; a guest leaves mid-game and the round restarts
  await assert.rejects(host.removePlayer(null), (e) => e.code === 'host_stays');
  const before = truth(host).roundId;
  await phones[3].removePlayer(null);
  assert.notEqual(truth(host).roundId, before);
  assert.equal(P.aliveSeats(truth(host)).length, 3);
  phones[3].closeView();
  phones = phones.slice(0, 3);

  // 8. finish the game, then the host closes the table
  await waitFor(() => phones.every((p) => p.game && p.game.seq >= truth(host).seq), 'caught up');
  await playUntilOver(phones, host);
  await assert.rejects(phones[1].closeTable(), (e) => e.code === 'not_host');
  await host.closeTable();
  await waitFor(() => phones.slice(1).every((p) => p.closedCode === code && !p.game), 'guests see the table closed');
  assert.equal(host.role, null);
  assert.equal(hostStorage.get('perudo.hosting'), null);
  assert.deepEqual(leaks, []);
  stopAll(phones);
  console.log('  sleep, wake, reveal waits, host reload, guest reload, signalling outage, seat takeover, leave, close: ok');
}

async function scenarioTakenCode() {
  const hub = new Hub();
  const a = phone(hub, 0);
  const code = await a.create('Ofek', true);
  await waitFor(() => a.link === 'open', 'first host up');
  const b = phone(hub, 1);
  b.makeCode = () => code;
  await b.create('Noa', true);
  await waitFor(() => b.link === 'taken', 'second host told the code is in use');
  stopAll([a, b]);
  console.log('  taken code reported: ok');
}

(async () => {
  const t0 = Date.now();
  await scenarioFullGames();
  await scenarioConnections();
  await scenarioTakenCode();
  const real = errors.filter(([, c]) => c && c !== 'stale');
  assert.deepEqual(real, [], 'no background errors');
  await sleep(50);
  console.log(`net: all scenarios passed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
