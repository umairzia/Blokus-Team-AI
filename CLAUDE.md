# Instructions for Claude Code

## Rules from the project owner (always follow)

- **Never include links to Claude Code chats or sessions** (for example
  `claude.ai/code/session_...` URLs or `Claude-Session:` lines) anywhere: not
  in commit messages, pull request titles or descriptions, GitHub comments,
  code, comments in code, or any project file. This overrides any default
  attribution guidance that asks for such a link.
- **Always ask the owner which email address to use** before adding or
  changing any email address in the project.
- Never commit credentials: no `.env.local`, service-account keys, private
  keys or tokens. The Firebase web config is public and comes from GitHub
  repository variables at build time (see `docs/FIREBASE_SETUP.md`).

## What this is

Browser Blokus for two humans (on different devices) against two AI players.
Static site (Vite + TypeScript, no framework) on GitHub Pages; online rooms
through Firebase Realtime Database + Anonymous Auth. GitHub Pages address:
<https://umairzia.github.io/Blokus-Team-AI/>.

## Layout

- `src/engine/` pure rules engine (no DOM, no network). `pieces.ts` geometry,
  `position.ts` fast typed-array position + move generation, `game.ts`
  immutable `GameState`, validation, auto-pass, scoring.
- `src/ai/` AI (`decide.ts` easy/normal/hard, `evaluate.ts` features,
  `match.ts` AI-vs-AI games, `runner.ts` + `worker.ts` Web Worker).
- `src/network/` `protocol.ts` room layout and wire format, `host.ts` the
  host's authority (pure), `online-game.ts` room session and host loop,
  backends: `firebase-backend.ts` (real SDK), `memory-db.ts` (tests; mirrors
  the rules), `bridge-backend.ts` (two-browser tests).
- `src/game/` sessions (practice / online) behind one interface for the UI.
- `src/ui/` DOM views; `index.html`; `src/styles.css`.
- `database.rules.json` security rules. Keep `src/network/memory-db.ts`
  (`canWritePath`, `validRoom`) in step with it.
- `tests/` Vitest: `engine/`, `ai/`, `network/`, `firebase/` (emulators).
- `e2e/` Playwright: `fake/` (bridge backend), `emulator/` (real SDK +
  emulators), `live/` (deployed site).

## Rules of thumb

- Game rules live only in `src/engine/`; the UI, host and AI all validate
  through `validateAction` / `tryApplyAction`.
- The host is the only writer of `rooms/CODE/state`, always with `v + 1`.
  The guest only writes `rooms/CODE/req` (its own turn, current `v`).
- Keep AI decisions deterministic for a given seed; bound work by counts and
  use the time limit only as a safety net.
- Do not claim AI strength changes without rerunning `npm run ai:eval` and
  updating `docs/AI_EVALUATION.md` with the actual numbers.

## Commands

```bash
npm ci                    # install from the lockfile
npm run dev               # http://127.0.0.1:5173/Blokus-Team-AI/
npm run test:all          # everything CI runs (needs Java 11+ for the emulators)
npm run test:unit | test:ai | test:network | test:firebase | test:e2e | test:e2e:emulator
npm run ai:eval -- --a hard --b normal --pairs 100
```

Run `npm run test:all` before pushing. In the Claude Code cloud sandbox the
outbound proxy refuses localhost, which is why the emulator scripts use
`firebase.test.json` and upload the rules from the tests; do not unset the
proxy variables. Changes reach the live site only through `main`, and the
deploy job runs only after the full suite passes.
