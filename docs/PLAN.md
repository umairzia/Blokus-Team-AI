# Blokus Team AI: technical plan

This is the plan written before implementation. The README describes the
finished result; where the two differ, the README and the code win.

## 1. Rules and scoring

- 20 × 20 board, four seats in clockwise turn order, alternating teams:
  seat 0 Human 1 (blue, top-left) → seat 1 AI 1 (yellow, top-right) →
  seat 2 Human 2 (red, bottom-right) → seat 3 AI 2 (green, bottom-left).
  Teammates sit in diagonally opposite corners.
- Each seat owns the standard 21 pieces (89 squares). A placement is legal
  when every cell is on the board and empty, no cell shares an edge with the
  same colour, and it either covers the seat's start corner (first piece) or
  touches the same colour at a corner (later pieces).
- A seat with no legal placement is passed automatically and stays out for
  the rest of the game (the board only fills up, so it can never move again).
  The game ends when every seat is out; one seat being out never ends it.
- Score: −1 per unplayed square; +15 for placing all 21 pieces; +5 more if
  the last piece placed was the monomino. Team score = sum of its two seats.

## 2. Board and piece geometry

- `src/engine/pieces.ts`: the 21 pieces as ASCII art, expanded into their
  unique orientations (rotations × reflections, normalised to the top-left
  and de-duplicated by a canonical key: 91 orientations in total).
- `src/engine/position.ts`: a mutable, typed-array position for speed:
  board (`Int8Array(400)`), per-seat "forbidden" masks (occupied or
  edge-adjacent to own colour) and per-seat corner-anchor direction masks.
  Move generation only tries piece cells whose free diagonal matches an
  anchor's own-colour diagonal, then de-duplicates with a stamp array.
- `src/engine/game.ts`: the immutable, JSON-friendly `GameState` and the
  pure `applyAction` / `validateAction` / `legalMoves` / `scoreGame` API.
  Every action carries the ply number it was made for, so a replayed or
  stale action is refused by the engine itself, not just by the network.

## 3. AI

A deterministic decision engine (`src/ai/`) that only ever chooses from the
engine's legal-move list, and passes only when that list is empty.

- Evaluation (team-level): placed squares, corner anchors, territory
  (multi-source BFS: cells a seat reaches before anyone else), opponent
  anchors removed, teammate anchors preserved, monomino-last bonus.
- Easy: size + own anchors, seeded noise, picks among the top few.
- Normal: full 1-ply evaluation of every legal move.
- Hard: Normal's evaluation picks the top K candidates; each is then
  re-scored with real mobility (legal-move counts) after simulating the next
  opponent's strongest replies (paranoid, bounded), with a time cap.
- Deterministic seeds; work budgets are counted in evaluations, with a
  wall-clock cap as a safety net. Runs in a Web Worker in the browser.
- `scripts/ai-eval.ts` runs paired-seed AI-vs-AI matches (same randomised
  opening, both seatings) and reports win rates with confidence intervals.
  No strength claim is made beyond what those numbers show.

## 4. Multiplayer

- Static site on GitHub Pages + Firebase Realtime Database + Anonymous Auth.
- Host-authoritative: the host's browser validates every move, runs the AI
  and is the only writer of `rooms/CODE/state`. The guest writes only a move
  request (`rooms/CODE/req`) for its own turn and the current version.
- Every state write must carry version `v + 1` (enforced by the database
  rules), so stale, duplicated or second-tab writes cannot apply twice.
- Presence via `.info/connected` + `onDisconnect`. Anonymous sessions
  persist, so a refresh returns the same uid, seat and room.
- If the host disconnects the game pauses; there is no host migration.
- A `Backend` interface hides Firebase: `FirebaseBackend` (real SDK),
  `MemoryBackend` (in-process, with the rules re-implemented, for Node
  integration tests) and a Playwright bridge for two-browser e2e tests.

## 5. Firebase auth and database security

`database.rules.json`: signed-in users only; a room code can be created once
and its creator is host; anyone signed in can read a room's seat list (to
see whether it is full) but only its two members can read the room; the
guest seat can be claimed only while empty; only the host writes the state
(exactly one version newer, validated shape); the guest writes only its own
presence and a well-formed move request on its own turn for the current
version; only the host deletes the room. Tested against the official
emulator with `@firebase/rules-unit-testing`.

## 6. UI

Vanilla TypeScript + CSS (no framework). Screens: home (create / join /
offline practice), lobby (code, copy link, seats, difficulty, start), game
(board, seat panel with scores, inventories, presence and thinking
indicators, piece tray, rotate / flip / cancel / hint / place, move log,
rules panel), game-over dialog. Pointer hover preview, tap-to-preview then
confirm on touch, full keyboard control. Responsive from 360 px phones to
desktops; prefers-color-scheme, reduced-motion and focus-visible support.
Offline practice (both human colours on one device) is clearly labelled as
not online play.

## 7. Tests

- Unit (Vitest + fast-check): pieces, placement rules, passing, termination,
  scoring, replay protection, and move generation vs. brute force.
- AI: legality, passing, time budget, determinism, full games per level,
  and a recorded paired-seed strength comparison.
- Network integration (MemoryBackend): rooms, joins, third-human refusal,
  requests, stale / duplicate requests, AI applied once, two host tabs,
  reconnect, network loss and recovery, room closure.
- Firebase emulator: database rules (allowed and denied cases) and the real
  SDK `FirebaseBackend` with two clients.
- Browser e2e (Playwright): two independent contexts via the bridge backend,
  plus the production bundle against the emulators; mobile viewport.
- Static: typecheck, lint, production build, and a dist check for the
  GitHub Pages base path.

## 8. Build and deployment

Vite with `base: '/Blokus-Team-AI/'`. One GitHub Actions workflow: the
`checks` job runs `npm ci` and the whole suite on pull requests and pushes;
the `deploy` job (push to `main` or manual dispatch only) needs `checks`,
uploads the Pages artifact and deploys it; a `verify` job then loads the
live URL in a browser. Least-privilege permissions; Firebase web config
comes from repository variables at build time.
