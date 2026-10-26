# Perudo

The bluffing dice game for 2 to 6 players, where everyone in the room plays on their own phone.

**Play:** https://ofekglik.github.io/perudo/

## How to start a game

1. One person opens the page, types their name and taps **Create table**. Their phone hosts the game, so it has to keep the page open with the screen on.
2. Everyone else scans the QR code on the host's phone, opens the shared link, or types the five-letter table code.
3. The host taps **Start**. Each phone rolls its own dice and shows them only to its owner.

The full rules are in the page under **How to play**.

## How it works

GitHub Pages only serves files, so there is no game server. The host's phone runs the table, and the other phones connect to it directly over WebRTC. [PeerJS](https://peerjs.com) and its free public signalling server introduce the phones to each other; after that, moves go phone to phone. This works best when everyone is on the same wifi.

- The shared table (seats, bids, whose turn) holds no dice. Each phone rolls its own dice and keeps them in its browser storage. A phone sends its dice to the host only when someone calls Dudo or Calza, and the host shares them only for that reveal.
- The host applies every move with one rules engine, so two players can't act on the same bid at once.
- If a phone locks or drops off, it reconnects and catches up by itself. If the host's page reloads, it picks the table back up from its saved copy and everyone reconnects.

## Rules decisions

Where the classic rules leave a choice, this version uses the common one:

- A round can't open on 1s, except in palifico.
- Palifico happens once per player: the first time they drop to one die.
- Calza can be called by anyone except the bidder, at any time. The caller opens the next round.
- The first player is chosen by everyone rolling one die; ties roll again.
- A bid can't name more dice than are on the table.
- If a player leaves mid-game, the round restarts with fresh dice.

## Development

`src/` holds the source. `npm run build` inlines it, with the libraries in `vendor/`, into the single `index.html` that GitHub Pages serves.

```sh
npm run build    # src/ + vendor/ -> index.html
npm test         # rules engine, plus the peer-to-peer protocol on a simulated network
npm run e2e      # three real browsers over WebRTC with a local PeerJS server (needs dev dependencies)
```

- `src/engine.js` is the rules: pure functions over a JSON table state.
- `src/net.js` is the host core, the PeerJS links with heartbeats and reconnects, and the per-phone session.
- `src/ui.js` and `src/page.html` are the screen.

Third-party code in `vendor/`: PeerJS 1.5.5 (MIT, see `vendor/LICENSE-peerjs`) and qrcode-generator 2.0.4 by Kazuhiko Arase (MIT, license in the file header).
