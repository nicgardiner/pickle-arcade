## Step 4d: Wire Up Online Multiplayer (if applicable)

Some games support **online PvP** through the Pickle Arcade lobby system: Firebase
(anonymous auth + Firestore lobby listings over REST) for matchmaking, and PeerJS
(P2P over the public cloud broker) for the actual gameplay connection. Both are
provided by `lobby-sdk.js`; the game itself never touches Firebase or PeerJS
directly — it only calls `window.LobbySDK`.

**Skip this entire step for single-player games.** Most games are solo. Only wire up
multiplayer when the game has a genuine two-player adversarial/turn-based mode that
two separate people could play from two separate machines. If the game is solo, or
its "2-player" mode is hotseat-only and wouldn't make sense over a network, do
nothing here and don't mention it.

### Step 4d.1 — Decide whether the game qualifies

Wire up multiplayer only if ALL of these hold:

- The game has a discrete two-player mode (turn-based or simultaneous) where each
  player controls one side — chess, checkers, connect4, battleship, etc.
- The game state can be kept in sync by passing small, discrete **move messages**
  (a drop, a move, an attack). Real-time games needing per-frame netcode are NOT a
  fit for this lobby system — skip them.
- There are exactly two participants (this system is strictly 1-vs-1).

If the game is solo, co-op-only, or needs continuous real-time sync, skip to the
next step and say nothing about multiplayer.

### Step 4d.2 — The real API (do not invent calls)

The ONLY multiplayer surface is `window.LobbySDK`, with exactly these four methods:

```js
// Register the game and its network callbacks. Call once, before openLobby().
window.LobbySDK.init(gameId, {
  onConnected(isHost) { /* both peers connected; isHost === true for the room host */ },
  onData(data)        { /* a message the opponent sent via send() */ },
  onDisconnected()    { /* opponent dropped or connection closed */ },
});

// Open the host/browse lobby overlay (Firebase-backed room list + PeerJS connect).
window.LobbySDK.openLobby();

// Send an arbitrary JSON-serializable message to the opponent.
window.LobbySDK.send({ type: 'move', /* ...game-specific fields... */ });

// Tear down: removes our lobby doc, destroys the peer. Call on "back to menu" / rematch reset.
window.LobbySDK.closeLobby();
```

That is the complete API. There is **no** `peerjsConfig`, `signalingServer`,
`GameSDK.recordMultiplayerMatch`, `onMultiplayerConnect`, `onMultiplayerError`,
`peerjsEnabled`, or `onlineMultiplayer` field anywhere. If you find yourself
writing any of those, stop — they don't exist. The SDK handles auth, the room
list, names/emblems, the lobby UI, and the PeerJS handshake internally.

Notes on behavior the SDK already handles for you, so the game must NOT duplicate:
- Player name + emblem exchange (a `{type:'__handshake', ...}` message). The game's
  `onData` never sees the handshake — the SDK swallows it. Don't send a `__`-prefixed
  message type; those are reserved.
- The lobby overlay (host a room / browse rooms / connecting states / errors).
- Lobby doc cleanup on connect, on close, and on window unload.

### Step 4d.3 — Register the game in preload.js (REQUIRED — the easy step to miss)

`lobby-sdk.js` is only injected into a game window if the game's `id` is in the
`ONLINE_MULTIPLAYER_GAMES` Set in `preload.js`. If you skip this, `window.LobbySDK`
will be `undefined` at runtime and the game's online button will fail with the
"Lobby SDK not loaded yet" alert forever. This is the single most common wiring
mistake — do it first.

Edit `preload.js`:

```js
const ONLINE_MULTIPLAYER_GAMES = new Set([
  'chess', 'checkers', 'connect4', 'battleship',
  'ultimate-tic-tac-toe', 'poke_clash_v7',
  'your_game_id',          // ← add the new game's id (fileName minus .html)
]);
```

Use the exact `gameId` (same value passed to `LobbySDK.init` and used everywhere
else in the launcher). Verify it matches after editing.

### Step 4d.4 — Wire the game's online mode

Follow the established pattern (see `connect4.html`, `checkers.html`, `chess.html`,
`battleship.html` for working references). A clean integration has:

**1. An "Online" mode entry point** that guards on the SDK, inits with callbacks,
and opens the lobby:

```js
function startOnlineMode() {
  if (!window.LobbySDK) { alert('Lobby SDK not loaded yet — try again in a moment.'); return; }
  window.LobbySDK.init('your_game_id', {
    onConnected(isHost) {
      // isHost decides which side this client plays. Host conventionally moves first.
      onlineSide = isHost ? /* side A */ : /* side B */;
      gameMode = 'online';
      startGame();
    },
    onData(data) {
      // Apply the opponent's move. Mirror exactly what send() emits below.
      if (data.type === 'move') { applyRemoteMove(data); }
    },
    onDisconnected() {
      // Surface a "opponent left" state; stop accepting input.
      if (!gameOver) endGameAsDisconnect();
    },
  });
  window.LobbySDK.openLobby();
}
```

**2. Outgoing moves** — when the LOCAL player makes a move in online mode, send it.
Guard on `mode === 'online'` and on it being the local player's turn so you never
echo the opponent's own move back to them:

```js
if (gameMode === 'online' && isLocalPlayersTurn && window.LobbySDK) {
  window.LobbySDK.send({ type: 'move', /* the minimal data to reproduce the move */ });
}
```

**3. A consistent message schema.** Keep messages small and declarative — send the
intent (`{type:'drop', col}`, `{type:'move', from, to}`, `{type:'attack', r, c}`),
not the whole board. `onData` on the other side replays it through the same code
path a local move would take. Match the field names exactly on both ends.

**4. Turn authority.** Decide the rule once (commonly: host = player 1 / white /
yellow and moves first) and make both `onConnected` branches agree. Apply remote
moves in `onData` without re-validating turn ownership the way you would for local
input — the sender already owned the turn.

**5. Teardown on exit.** Call `window.LobbySDK.closeLobby()` when the user leaves
the match or returns to the menu, so stale lobby docs don't linger in the room list.

Make surgical edits. If the game has no existing online mode and adding one would
require restructuring its input/turn handling, don't force it — add a
`// TODO: online mode entry point` where it would go and tell the user it needs a
manual pass rather than half-wiring it.

### Step 4d.5 — Tag and confirm

- Add `"Multiplayer"` to the game's `tags` in games.json (2–4 tags total). Multiplayer
  games carry NO special games.json field — the `"Multiplayer"` tag plus the
  preload.js registration are the only markers. Do not add invented fields like
  `onlineMultiplayer` or `peerjsEnabled`.
- In the Step 6 confirmation, if multiplayer was wired, report: that the id was added
  to `ONLINE_MULTIPLAYER_GAMES` in preload.js, the message schema you used, and which
  side hosts. If the game was solo and multiplayer was skipped, say nothing about it.

### Step 4d.6 — Verify before declaring done

Check each, since a miss here means a silent runtime failure:

1. The game's `id` is in `ONLINE_MULTIPLAYER_GAMES` in preload.js, spelled identically
   to the `LobbySDK.init` argument.
2. Every `LobbySDK.send({type:'X', ...})` has a matching `onData` branch handling
   `type === 'X'` — on BOTH clients (the same code runs both sides).
3. No reserved `__`-prefixed message types are sent.
4. `onConnected`, `onData`, `onDisconnected` are all provided (the SDK calls all three).
5. Only the four real methods are used — grep the game for `peerjsConfig`,
   `recordMultiplayerMatch`, `onMultiplayerConnect`, `signalingServer`,
   `peerjsEnabled`; there should be zero hits.
