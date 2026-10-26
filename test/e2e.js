'use strict';
/* Real browsers, real WebRTC: a local PeerJS server and three isolated browser "phones"
 * play complete games through the page's own buttons. The host's page reloads mid-game.
 *
 *   PLAYWRIGHT_PATH=... PEER_PATH=... node test/e2e.js [screenshot.png]
 * Needs: playwright with Chromium, the `peer` npm package, and `sharp` for the screenshot. */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { PeerServer } = require(process.env.PEER_PATH || 'peer');

const ROOT = path.join(__dirname, '..');
const SHOT = process.argv[2] || null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const peerPort = 9123;
  const peerServer = PeerServer({ port: peerPort, host: '127.0.0.1', path: '/perudo' });
  const web = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/' || url === '/index.html') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(fs.readFileSync(path.join(ROOT, 'index.html'))); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => web.listen(0, r));
  const base = `http://localhost:${web.address().port}/`;

  const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const peerOptions = { host: '127.0.0.1', port: peerPort, path: '/perudo', secure: false, debug: 0, config: { iceServers: [] } };
  const problems = [];
  async function newPhone(name, scheme) {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: scheme || 'light' });
    await ctx.addInitScript((opts) => { window.PERUDO_PEER_OPTIONS = opts; }, peerOptions);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => problems.push(name + ' pageerror: ' + e.message));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/fonts\.(googleapis|gstatic)|Failed to load resource|ERR_/.test(m.text())) problems.push(name + ' console: ' + m.text());
    });
    page.label = name;
    return page;
  }
  const phones = [await newPhone('Ofek'), await newPhone('Noa'), await newPhone('Lior', 'dark')];
  const [host, noa, lior] = phones;
  const tiles = [];
  const tile = async (page) => { if (SHOT) tiles.push(await page.screenshot({ fullPage: false })); };

  // host creates a table
  await host.goto(base);
  await host.fill('#name', 'Ofek');
  await host.click('[data-action="create"]');
  await host.waitForSelector('text=Waiting to start');
  await host.waitForFunction(() => !document.body.innerText.includes('Getting the table online'), null, { timeout: 15000 });
  const code = (await host.locator('.stage .bid-big').innerText()).trim();
  if (!/^[A-Z]{5}$/.test(code)) throw new Error('bad code ' + code);
  if (!(await host.locator('.qr svg').count())) throw new Error('no QR code');
  const link = await host.locator('.share .link').innerText();
  if (link !== base + '?t=' + code) throw new Error('share link is ' + link);

  // Noa opens the shared link; Lior types the code
  await noa.goto(base + '?t=' + code);
  await noa.waitForSelector('[data-action="join-here"]', { timeout: 20000 });
  await noa.fill('#name', 'Noa');
  await noa.click('[data-action="join-here"]');
  await noa.waitForSelector('text=Waiting for Ofek to start');
  await lior.goto(base);
  await lior.fill('#name', 'Lior');
  await lior.fill('#code', code.toLowerCase());
  await lior.click('[data-action="join"]');
  await lior.waitForSelector('text=Waiting for Ofek to start', { timeout: 20000 });
  await host.waitForSelector('text=Start game with 3 players');
  await tile(host);

  const table = async () => {
    const snap = await host.evaluate((c) => JSON.parse(localStorage.getItem('perudo.host.' + c)), code);
    return snap.state;
  };
  const byOwner = async () => {
    const out = {};
    for (const p of phones) out[await p.evaluate(() => JSON.parse(localStorage.getItem('perudo.pid')))] = p;
    return out;
  };
  const waitSeq = async (seq) => {
    for (let t = 0; t < 600; t++) { const g = await table(); if (g && g.seq > seq) return g; await sleep(25); }
    throw new Error('table did not change after seq ' + seq);
  };

  await host.click('[data-action="start"]');
  let g = await waitSeq((await table()).seq - 1);
  const owners = await byOwner();
  const phoneOf = (st, sid) => owners[st.seats.find((s) => s.sid === sid).owner];
  for (const p of phones) { await p.waitForSelector('.cup .covered', { timeout: 20000 }); await p.click('[data-action="cup"]'); await p.waitForSelector('.cup .hand .die'); }

  let rounds = 0, bids = 0, dudos = 0, calzas = 0, reloaded = false, shotPlay = false, shotReveal = false;
  for (let step = 0; step < 800; step++) {
    g = await table();
    if (g.status === 'over') break;
    if (g.phase === 'bidding') {
      // reload the host's page once, mid-round, after a bid
      if (!reloaded && g.round >= 2 && g.bids.length >= 1) {
        reloaded = true;
        await host.reload();
        await host.waitForSelector('.cup', { timeout: 20000 });
        await host.waitForFunction(() => !/Getting the table online|Reconnecting/.test(document.body.innerText), null, { timeout: 20000 });
        for (const p of [noa, lior]) await p.waitForFunction(() => !/Reconnecting|Lost the line/.test(document.body.innerText), null, { timeout: 30000 });
        const again = await table();
        if (again.seq !== g.seq || again.bids.length !== g.bids.length) throw new Error('state changed across host reload');
        if (!(await host.locator('.cup .hand .die').count())) await host.click('[data-action="cup"]');
        continue;
      }
      const t = phoneOf(g, g.turn);
      await t.waitForSelector('.dock [data-action="bid"]', { timeout: 20000 });
      if (!shotPlay && g.round >= 2 && g.bids.length >= 2 && t === noa) { await sleep(200); await tile(noa); shotPlay = true; }
      const bid = g.bids[g.bids.length - 1];
      const r = Math.random();
      if (bid && g.calza && r < 0.08) {
        const callers = phones.filter((p) => { const s = g.seats.find((x) => owners[x.owner] === p); return s && !s.out && s.sid !== bid.by; });
        const c = callers[Math.floor(Math.random() * callers.length)];
        await c.waitForSelector('[data-action="calza"]');
        await c.click('[data-action="calza"]');
        await c.waitForSelector('[data-action="calza"].armed');
        await c.click('[data-action="calza"]');
        calzas++;
        g = await waitSeq(g.seq);
        continue;
      }
      if (bid && (r < 0.38 || !(await t.locator('.dock [data-action="bid"]:not([disabled])').count()))) {
        await t.click('.dock [data-action="dudo"]');
        await t.waitForSelector('[data-action="dudo"].armed');
        await t.click('.dock [data-action="dudo"]');
        dudos++;
        g = await waitSeq(g.seq);
        continue;
      }
      const faces = t.locator('.face:not([disabled])');
      const nf = await faces.count();
      if (nf) await faces.nth(Math.floor(Math.random() * nf)).click();
      if (await t.locator('.dock [data-action="bid"][disabled]').count()) throw new Error('bid disabled after picking a legal face');
      await t.click('.dock [data-action="bid"]');
      bids++;
      g = await waitSeq(g.seq);
      continue;
    }
    if (g.phase === 'reveal') {
      for (const p of phones) await p.waitForSelector('[data-action="next"]', { timeout: 30000 });
      const verdicts = [];
      for (const p of phones) verdicts.push(await p.locator('.verdict b').innerText());
      if (new Set(verdicts).size !== 1) throw new Error('phones disagree: ' + verdicts.join(' / '));
      if (!shotReveal) { await sleep(150); await tile(lior); shotReveal = true; }
      const who = phones[Math.floor(Math.random() * phones.length)];
      await who.click('[data-action="next"]');
      rounds++;
      g = await waitSeq(g.seq);
      continue;
    }
  }
  g = await table();
  if (g.status !== 'over') throw new Error('game did not finish');
  for (const p of phones) await p.waitForSelector('.winner-name', { timeout: 20000 });
  const winner = await host.locator('.winner-name').innerText();
  await host.click('[data-action="again"]');
  for (const p of phones) await p.waitForSelector('text=Waiting to start', { timeout: 20000 });
  // the host closes the table; guests are told
  await host.click('[data-action="close"]');
  await host.click('[data-action="close"]');
  await noa.waitForSelector('text=was closed by its host', { timeout: 20000 });
  await lior.waitForSelector('text=was closed by its host', { timeout: 20000 });

  console.log(`e2e: ${rounds} rounds, ${bids} bids, ${dudos} dudo, ${calzas} calza, host reloaded mid-game: ${reloaded}; "${winner}"`);
  if (SHOT && tiles.length) {
    const sharp = require(process.env.SHARP_PATH || 'sharp');
    const imgs = await Promise.all(tiles.map((b) => sharp(b).metadata().then((m) => ({ b, m }))));
    const W = imgs.reduce((a, x) => a + x.m.width, 0) + 16 * (imgs.length + 1);
    const H = Math.max(...imgs.map((x) => x.m.height)) + 32;
    let left = 16;
    const comp = imgs.map((x) => { const o = { input: x.b, left, top: 16 }; left += x.m.width + 16; return o; });
    await sharp({ create: { width: W, height: H, channels: 3, background: '#77748a' } }).composite(comp).png().toFile(SHOT);
  }
  if (problems.length) { console.error('PROBLEMS', problems); process.exitCode = 1; } else console.log('no page errors');
  await browser.close();
  web.close();
  peerServer.close && peerServer.close();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
