/**
 * The page: home (create / join / practice), lobby and game screens. All
 * game rules come from the engine; this file only turns clicks, taps and
 * keys into actions and draws whatever the current Session reports.
 */

import { chooseAction, isLevel, type Level } from '../ai/decide';
import { createAiRunner, type AiRunner } from '../ai/runner';
import { BOARD_SIZE, SEATS, teamOf, type Seat } from '../engine/constants';
import {
  ERROR_TEXT,
  positionOf,
  scoreGame,
  scoreSeat,
  validateAction,
  type PlaceAction,
} from '../engine/game';
import { PIECES, flipCells, orientationIndexOf, pieceById, rotateCells, type Cell, type PieceId } from '../engine/pieces';
import { decodeMove } from '../engine/position';
import { OnlineSession } from '../game/online-session';
import { PracticeSession } from '../game/practice-session';
import type { Session, SessionSnapshot } from '../game/session';
import type { Backend } from '../network/backend';
import { BridgeBackend, bridgeAvailable } from '../network/bridge-backend';
import { readFirebaseConfig, type FirebaseConfigStatus } from '../network/firebase-config';
import { OnlineGame, createRoom, joinRoom } from '../network/online-game';
import { cleanName, normalizeRoomCode } from '../network/protocol';
import { BoardView, type Preview } from './board-view';
import { $, h } from './dom';
import { pieceSvg } from './piece-svg';
import { load, save } from './storage';
import { COLOR_NAMES, CORNER_NAMES, LEVEL_NAMES, TEAM_NAMES, formatScore, seatClass } from './theme';

interface TestHooks {
  aiDelayMs?: number;
}

interface Selection {
  piece: PieceId;
  cells: Cell[];
  o: number;
}

type Screen = 'home' | 'lobby' | 'game';

const CONNECT_TIMEOUT_MS = 20_000;

/** The cell of a shape nearest its centre: it sits under the pointer. */
function handleOf(cells: readonly Cell[]): Cell {
  let cx = 0;
  let cy = 0;
  for (const [x, y] of cells) {
    cx += x;
    cy += y;
  }
  cx /= cells.length;
  cy /= cells.length;
  let best = cells[0];
  let bestD = Infinity;
  for (const c of cells) {
    const d = (c[0] - cx) ** 2 + (c[1] - cy) ** 2;
    if (d < bestD - 1e-9) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

function friendlyError(err: unknown): string {
  const e = err as { code?: string; message?: string };
  const code = e?.code ?? '';
  if (code === 'auth/operation-not-allowed' || code === 'auth/admin-restricted-operation') {
    return 'Anonymous sign-in is turned off in the Firebase project. The site owner needs to enable it (see docs/FIREBASE_SETUP.md).';
  }
  if (code.startsWith('auth/api-key') || code === 'auth/invalid-api-key') {
    return 'Firebase rejected the API key. Check VITE_FIREBASE_API_KEY and the key restrictions (see docs/FIREBASE_SETUP.md).';
  }
  if (code === 'auth/network-request-failed') return 'Cannot reach Firebase. Check your internet connection and try again.';
  if (code === 'auth/unauthorized-domain' || code === 'auth/requests-from-referer-are-blocked') {
    return 'This website is not on the Firebase project\'s list of allowed sites (see docs/FIREBASE_SETUP.md).';
  }
  return e?.message ?? String(err);
}

export class App {
  private readonly hooks: TestHooks;
  private readonly config: FirebaseConfigStatus;
  private readonly onlineAvailable: boolean;
  private readonly ai: AiRunner = createAiRunner();
  private backend: Promise<Backend> | null = null;
  private session: Session | null = null;
  private unsubscribe: (() => void) | null = null;
  private snap: SessionSnapshot | null = null;
  private screen: Screen = 'home';
  private board!: BoardView;

  private selection: Selection | null = null;
  private hover: number | null = null;
  private cursor = 0;
  private keyboardMode = false;
  private pinned: number | null = null;
  private hints = false;
  private busy = false;
  private overShown = '';
  private trayKey = '';
  private fitCache: { key: string; noFit: Set<number> } = { key: '', noFit: new Set() };
  private toastTimer: ReturnType<typeof setTimeout> | undefined;
  private confirmResolve: ((yes: boolean) => void) | null = null;

  constructor() {
    this.hooks = ((window as unknown as { __BLOKUS_TEST__?: TestHooks }).__BLOKUS_TEST__ ?? {}) as TestHooks;
    this.config = readFirebaseConfig(import.meta.env as Record<string, string | undefined>);
    this.onlineAvailable = bridgeAvailable() || this.config.kind === 'ready';
  }

  start(): void {
    this.board = new BoardView($('board'), {
      onHover: (cell) => {
        this.keyboardMode = false;
        this.hover = cell;
        this.renderBoard();
      },
      onActivate: (cell, pointerType) => this.activate(cell, pointerType),
      onKey: (e) => this.onBoardKey(e),
    });
    this.bindUi();
    this.restoreOptions();
    this.renderConn();
    this.initHome();
    window.addEventListener('hashchange', () => this.onHash());
  }

  // ---- Options ---------------------------------------------------------------

  private restoreOptions(): void {
    $<HTMLInputElement>('name').value = load('name');
    const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
    const confirm = load('confirm');
    $<HTMLInputElement>('opt-confirm').checked = confirm ? confirm === '1' : coarse;
    $<HTMLInputElement>('opt-patterns').checked = load('patterns') === '1';
    document.body.classList.toggle('patterns', load('patterns') === '1');
    for (const id of ['level', 'practice-level']) {
      const saved = load(id);
      if (isLevel(saved)) $<HTMLSelectElement>(id).value = saved;
    }
  }

  private get confirmPlacements(): boolean {
    return $<HTMLInputElement>('opt-confirm').checked;
  }

  // ---- Wiring ------------------------------------------------------------------

  private bindUi(): void {
    $('btn-help').addEventListener('click', () => $<HTMLDialogElement>('dlg-help').showModal());
    $('btn-help-close').addEventListener('click', () => $<HTMLDialogElement>('dlg-help').close());
    $('btn-create').addEventListener('click', () => void this.create());
    $('join-form').addEventListener('submit', (e) => {
      e.preventDefault();
      void this.join($<HTMLInputElement>('join-code').value);
    });
    $('btn-resume').addEventListener('click', () => void this.join(load('room')));
    $('btn-practice').addEventListener('click', () => this.startPractice());
    $('btn-copy').addEventListener('click', () => void this.copyLink());
    $('room-chip').addEventListener('click', () => void this.copyLink());
    $('btn-start').addEventListener('click', () => void this.run(() => this.session!.startGame()));
    $('lobby-level').addEventListener('change', () => {
      const v = $<HTMLSelectElement>('lobby-level').value;
      if (isLevel(v)) void this.run(() => this.session!.setLevel(v));
    });
    $('btn-free-seat').addEventListener('click', () => void this.freeSeat());
    $('btn-lobby-leave').addEventListener('click', () => void this.leave());
    $('btn-leave').addEventListener('click', () => void this.leave());
    $('btn-new').addEventListener('click', () => void this.newGame());
    $('btn-over-new').addEventListener('click', () => {
      $<HTMLDialogElement>('dlg-over').close();
      void this.newGame(true);
    });
    $('btn-over-close').addEventListener('click', () => $<HTMLDialogElement>('dlg-over').close());
    $('btn-rotate').addEventListener('click', () => this.rotate(1));
    $('btn-flip').addEventListener('click', () => this.flip());
    $('btn-cancel').addEventListener('click', () => this.cancel());
    $('btn-hint').addEventListener('click', () => this.toggleHints());
    $('btn-suggest').addEventListener('click', () => this.suggest());
    $('btn-place').addEventListener('click', () => this.placePreview());
    $('btn-pass').addEventListener('click', () => void this.pass());
    $('opt-confirm').addEventListener('change', () => {
      save('confirm', $<HTMLInputElement>('opt-confirm').checked ? '1' : '0');
      this.pinned = null;
      this.renderGame();
    });
    $('opt-patterns').addEventListener('change', () => {
      const on = $<HTMLInputElement>('opt-patterns').checked;
      save('patterns', on ? '1' : '0');
      document.body.classList.toggle('patterns', on);
    });
    for (const id of ['level', 'practice-level']) {
      $(id).addEventListener('change', () => save(id, $<HTMLSelectElement>(id).value));
    }
    $('btn-confirm-yes').addEventListener('click', () => this.closeConfirm(true));
    $('btn-confirm-no').addEventListener('click', () => this.closeConfirm(false));
    $<HTMLDialogElement>('dlg-confirm').addEventListener('cancel', () => this.closeConfirm(false));
    document.addEventListener('keydown', (e) => this.onGlobalKey(e));
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.toast(friendlyError(err));
    }
  }

  // ---- Screens -----------------------------------------------------------------

  private setScreen(s: Screen): void {
    if (this.screen === s) return;
    this.screen = s;
    for (const name of ['home', 'lobby', 'game'] as const) $(`screen-${name}`).hidden = name !== s;
    document.body.dataset.screen = s;
    if (s !== 'game') $<HTMLDialogElement>('dlg-over').close();
  }

  private homeMsg(text: string | null): void {
    const el = $('home-msg');
    el.textContent = text ?? '';
    el.hidden = !text;
  }

  private initHome(): void {
    document.body.dataset.screen = 'home';
    $('online-setup').hidden = this.onlineAvailable;
    $('online-forms').hidden = !this.onlineAvailable;
    if (!this.onlineAvailable) {
      const detail =
        this.config.kind === 'invalid'
          ? `Problems found: ${this.config.problems.join('; ')}.`
          : this.config.kind === 'missing'
            ? `Missing settings: ${this.config.missing.join(', ')}.`
            : '';
      $('online-setup-detail').textContent = detail;
    }
    this.showResume();
    this.onHash();
  }

  private showResume(): void {
    const code = load('room');
    $('resume-box').hidden = !(this.onlineAvailable && code);
    $('resume-code').textContent = code;
  }

  private onHash(): void {
    const code = normalizeRoomCode(window.location.hash.replace(/^#/, ''));
    if (!code || !this.onlineAvailable || this.session) return;
    $<HTMLInputElement>('join-code').value = code;
    // A browser that already holds a seat goes straight back to it.
    void this.tryResume(code);
  }

  private async tryResume(code: string): Promise<void> {
    try {
      const backend = await this.getBackend();
      const players = (await backend.get(`rooms/${code}/players`)) as { host?: { uid: string }; guest?: { uid: string } } | null;
      if (players && (players.host?.uid === backend.uid || players.guest?.uid === backend.uid)) {
        await this.join(code);
        return;
      }
      if (!players) this.homeMsg(`There is no room ${code}. It may have been closed.`);
      else this.homeMsg(`You are invited to room ${code}. Enter your name and press Join.`);
      $<HTMLInputElement>('name').focus();
    } catch (err) {
      this.homeMsg(friendlyError(err));
    }
  }

  // ---- Connecting ----------------------------------------------------------------

  private getBackend(): Promise<Backend> {
    if (!this.backend) {
      this.renderConn('connecting');
      const connect = async (): Promise<Backend> => {
        if (bridgeAvailable()) return BridgeBackend.connect();
        if (this.config.kind !== 'ready') throw new Error('Online play is not set up on this site.');
        const { FirebaseBackend } = await import('../network/firebase-backend');
        return FirebaseBackend.connect(this.config.config, this.config.emulator);
      };
      const timeout = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Cannot reach the game server. Check your internet connection and try again.')), CONNECT_TIMEOUT_MS),
      );
      this.backend = Promise.race([connect(), timeout]).catch((err) => {
        this.backend = null;
        this.renderConn();
        throw err;
      });
    }
    return this.backend;
  }

  private playerName(): string {
    const name = cleanName($<HTMLInputElement>('name').value);
    save('name', name === 'Player' ? '' : name);
    return name;
  }

  private setBusy(on: boolean): void {
    for (const id of ['btn-create', 'btn-join', 'btn-resume', 'btn-practice']) $<HTMLButtonElement>(id).disabled = on;
  }

  private async create(): Promise<void> {
    const name = this.playerName();
    const level = $<HTMLSelectElement>('level').value as Level;
    this.homeMsg(null);
    this.setBusy(true);
    try {
      const backend = await this.getBackend();
      const code = await createRoom(backend, name, level);
      this.openRoom(backend, code, 'host');
    } catch (err) {
      this.homeMsg(friendlyError(err));
    } finally {
      this.setBusy(false);
    }
  }

  private async join(text: string): Promise<void> {
    const code = normalizeRoomCode(text);
    if (!code) {
      this.homeMsg('Please enter the 6-character room code (letters and digits), or open the invitation link.');
      return;
    }
    const name = this.playerName();
    this.homeMsg(null);
    this.setBusy(true);
    try {
      const backend = await this.getBackend();
      const res = await joinRoom(backend, code, name);
      if (!res.ok) {
        if (load('room') === code && res.reason !== 'denied') save('room', null);
        this.showResume();
        this.homeMsg(res.message);
        return;
      }
      this.openRoom(backend, res.code, res.role);
    } catch (err) {
      this.homeMsg(friendlyError(err));
    } finally {
      this.setBusy(false);
    }
  }

  private openRoom(backend: Backend, code: string, role: 'host' | 'guest'): void {
    save('room', code);
    if (window.location.hash !== `#${code}`) history.replaceState(null, '', `#${code}`);
    const online = new OnlineGame(backend, code, role, { ai: this.ai, aiDelayMs: this.hooks.aiDelayMs ?? 900 }).start();
    this.attach(new OnlineSession(online));
  }

  private startPractice(): void {
    const level = $<HTMLSelectElement>('practice-level').value as Level;
    const name = cleanName($<HTMLInputElement>('name').value);
    this.attach(
      new PracticeSession({
        level,
        ai: this.ai,
        aiDelayMs: this.hooks.aiDelayMs ?? 700,
        names: [name === 'Player' ? 'Blue player' : name, 'Red player'],
      }),
    );
  }

  private attach(session: Session): void {
    this.detach();
    this.session = session;
    this.overShown = '';
    this.resetSelection();
    this.unsubscribe = session.subscribe((s) => this.onSnapshot(s));
  }

  private detach(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session?.dispose();
    this.session = null;
    this.snap = null;
  }

  private goHome(message: string | null): void {
    this.detach();
    if (window.location.hash) history.replaceState(null, '', window.location.pathname + window.location.search);
    this.setScreen('home');
    this.showResume();
    this.homeMsg(message);
    $('room-chip').hidden = true;
    $('mode-banner').hidden = true;
    this.renderConn();
  }

  // ---- Session updates -------------------------------------------------------------

  private onSnapshot(s: SessionSnapshot): void {
    const prev = this.snap;
    this.snap = s;
    if (s.closed) {
      if (load('room') === s.code) save('room', null);
      this.goHome(s.closed);
      return;
    }
    if (prev && prev.game && s.game && (s.game.n !== prev.game.n || s.gameNumber !== prev.gameNumber)) {
      // The board moved on: a pinned preview may no longer make sense.
      this.pinned = null;
      if (s.gameNumber !== prev.gameNumber) this.resetSelection();
    }
    if (this.selection && s.game) {
      const seat = this.traySeat();
      if (seat === null || !(s.game.remaining[seat] & (1 << pieceById(this.selection.piece).index))) this.resetSelection();
    }
    this.renderConn();
    $('room-chip').hidden = s.mode !== 'online';
    $('room-chip-code').textContent = s.code ?? '';
    $('mode-banner').hidden = s.mode !== 'practice';
    if (s.mode === 'online' && s.phase === 'lobby') {
      this.setScreen('lobby');
      this.renderLobby(s);
    } else {
      this.setScreen('game');
      this.renderGame();
      this.maybeShowGameOver(s);
    }
    if (s.error) this.toast(s.error);
  }

  private renderConn(override?: 'connecting'): void {
    const s = this.snap;
    const el = $('conn');
    let kind: string;
    let text: string;
    if (override === 'connecting') [kind, text] = ['connecting', 'Connecting…'];
    else if (s?.mode === 'practice') [kind, text] = ['local', 'Offline practice'];
    else if (s?.mode === 'online') {
      kind = s.connection;
      text = { online: 'Online', offline: 'Offline – reconnecting…', connecting: 'Connecting…', local: 'Offline' }[s.connection];
    } else if (this.backend) [kind, text] = ['online', 'Online'];
    else [kind, text] = ['local', this.onlineAvailable ? 'Not connected' : 'Online play not set up'];
    el.className = `conn conn-${kind}`;
    $('conn-text').textContent = text;
  }

  // ---- Lobby -------------------------------------------------------------------------

  private inviteLink(code: string): string {
    return `${window.location.origin}${window.location.pathname}#${code}`;
  }

  private renderLobby(s: SessionSnapshot): void {
    const code = s.code ?? '';
    $('lobby-code').textContent = code;
    $<HTMLInputElement>('share-link').value = this.inviteLink(code);
    const guest = s.seats[2];
    const hostName = s.seats[0].name;
    $('lobby-lead').textContent = s.isHost
      ? 'Send the code or the invitation link to your partner. They open it on their own device to take the red seat.'
      : `You are in ${hostName}'s room as Human 2 (red).`;
    const list = $('lobby-seats');
    list.replaceChildren(
      ...s.seats.map((seat) => {
        const role = seat.kind === 'ai' ? `AI · ${LEVEL_NAMES[s.level]}` : seat.seat === 0 ? 'Human 1 · host' : 'Human 2';
        const status =
          seat.kind === 'ai' ? '' : seat.vacant ? 'waiting to join' : seat.local ? 'you' : seat.online ? 'online' : 'offline';
        return h(
          'li',
          { class: seatClass(seat.seat), style: `--pc: var(--p${seat.seat})` },
          h('span', { class: `presence${seat.online ? ' on' : ''}`, 'aria-hidden': 'true' }),
          h('b', { text: seat.name }),
          h('span', { class: 'muted', text: `${COLOR_NAMES[seat.seat]} · ${role}${status ? ` · ${status}` : ''}` }),
        );
      }),
    );
    $('lobby-host-controls').hidden = !s.isHost;
    $<HTMLSelectElement>('lobby-level').value = s.level;
    $<HTMLButtonElement>('btn-start').disabled = guest.vacant;
    $('btn-free-seat').hidden = !(s.isHost && !guest.vacant && guest.online === false);
    $('lobby-wait').textContent = s.isHost
      ? guest.vacant
        ? 'Waiting for your partner to join…'
        : `${guest.name} has joined. Press Start game when you are both ready.`
      : `Waiting for ${hostName} to start the game. AI level: ${LEVEL_NAMES[s.level]}.`;
  }

  private async copyLink(): Promise<void> {
    const code = this.snap?.code;
    if (!code) return;
    const link = this.inviteLink(code);
    try {
      await navigator.clipboard.writeText(link);
      this.toast('Invitation link copied.');
    } catch {
      const input = $<HTMLInputElement>('share-link');
      input.value = link;
      input.select();
      this.toast('Select the link and copy it: ' + link);
    }
  }

  private async freeSeat(): Promise<void> {
    if (!(await this.confirm('Free your partner\'s seat? They can then rejoin with the code from a new device.'))) return;
    await this.run(() => this.session!.freeGuestSeat!());
  }

  private async leave(): Promise<void> {
    const s = this.snap;
    if (!s || !this.session) return;
    const text =
      s.mode === 'practice'
        ? 'Leave this practice game?'
        : s.isHost
          ? 'Close the room for both of you? The game cannot be continued afterwards.'
          : 'Leave the room? Your seat will be free for someone with the code.';
    if (!(await this.confirm(text))) return;
    const session = this.session;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.session = null;
    if (s.mode === 'online') save('room', null);
    try {
      await session.leave();
    } catch (err) {
      this.toast(friendlyError(err));
    }
    this.goHome(null);
  }

  private async newGame(fromDialog = false): Promise<void> {
    const s = this.snap;
    if (!s || !this.session) return;
    if (!s.isHost) {
      this.toast('Only the host can start a new game.');
      return;
    }
    if (!fromDialog && s.phase === 'playing' && !(await this.confirm('Abandon this game and start a new one?'))) return;
    await this.run(() => this.session!.startGame());
  }

  // ---- Game rendering --------------------------------------------------------------------

  /** The human seat whose pieces the tray shows. */
  private traySeat(): Seat | null {
    const s = this.snap;
    if (!s) return null;
    const local = s.seats.filter((x) => x.local).map((x) => x.seat);
    if (local.length === 0) return null;
    const turn = s.game?.turn;
    if (turn !== undefined && local.includes(turn)) return turn;
    if (local.length === 1) return local[0];
    // Practice: show whoever of the two plays next.
    for (let i = 1; i <= 4 && turn !== undefined; i++) {
      const seat = ((turn + i) % 4) as Seat;
      if (local.includes(seat)) return seat;
    }
    return local[0];
  }

  /** The seat this device may move for right now, or null. */
  private actingSeat(): Seat | null {
    const s = this.snap;
    const g = s?.game;
    if (!s || !g || g.status !== 'playing' || s.phase !== 'playing' || s.pending || this.busy) return null;
    return s.seats[g.turn].local ? g.turn : null;
  }

  private placementAt(cell: number): PlaceAction | null {
    const sel = this.selection;
    const seat = this.traySeat();
    const g = this.snap?.game;
    if (!sel || seat === null || !g) return null;
    const [hx, hy] = handleOf(sel.cells);
    const x = (cell % BOARD_SIZE) - hx;
    const y = Math.floor(cell / BOARD_SIZE) - hy;
    return { type: 'place', seat, piece: sel.piece, o: sel.o, x, y, n: g.n };
  }

  private previewCell(): number | null {
    if (this.pinned !== null) return this.pinned;
    return this.keyboardMode ? this.cursor : this.hover;
  }

  private currentPreview(): { preview: Preview; action: PlaceAction; error: string | null } | null {
    const cell = this.previewCell();
    const g = this.snap?.game;
    if (cell === null || !this.selection || !g) return null;
    const action = this.placementAt(cell);
    if (!action) return null;
    const cells: number[] = [];
    for (const [cx, cy] of this.selection.cells) {
      const x = action.x + cx;
      const y = action.y + cy;
      if (x >= 0 && y >= 0 && x < BOARD_SIZE && y < BOARD_SIZE) cells.push(y * BOARD_SIZE + x);
    }
    const err = this.actingSeat() === action.seat ? validateAction(g, action) : 'not-your-turn';
    return {
      preview: { cells, ok: err === null, seat: action.seat, pinned: this.pinned !== null },
      action,
      error: err ? ERROR_TEXT[err] : null,
    };
  }

  private renderGame(): void {
    const s = this.snap;
    if (!s || !s.game) return;
    this.renderStatus(s);
    this.renderSeats(s);
    this.renderTray(s);
    this.renderLog(s);
    this.renderBoard();
    this.renderControls(s);
    const notice = $('notice');
    notice.textContent = s.notice ?? '';
    notice.hidden = !s.notice;
    $<HTMLButtonElement>('btn-new').hidden = !s.isHost;
  }

  private renderBoard(): void {
    const s = this.snap;
    const g = s?.game;
    if (!g) return;
    const lastEntry = [...g.history].reverse().find((h) => h.type === 'place');
    const last = new Set<number>();
    if (lastEntry && lastEntry.type === 'place') {
      const piece = pieceById(lastEntry.piece);
      for (const [cx, cy] of piece.orientations[lastEntry.o].cells) last.add((lastEntry.y + cy) * BOARD_SIZE + lastEntry.x + cx);
    }
    const unstarted = SEATS.filter((seat) => !g.history.some((h) => h.type === 'place' && h.seat === seat));
    const pv = this.currentPreview();
    const seat = this.actingSeat();
    const hints = new Set<number>();
    const anchors = new Set<number>();
    if (this.hints && seat !== null) {
      const pos = positionOf(g);
      if (this.selection) {
        const sel = this.selection;
        const [hx, hy] = handleOf(sel.cells);
        for (const code of pos.legalMovesForPiece(seat, pieceById(sel.piece).index)) {
          const m = decodeMove(code);
          if (m.o === sel.o) hints.add((m.y + hy) * BOARD_SIZE + m.x + hx);
        }
      } else {
        for (let c = 0; c < BOARD_SIZE * BOARD_SIZE; c++) if (pos.anchorMask(seat, c)) anchors.add(c);
      }
    }
    this.board.render({
      board: g.board,
      last,
      unstarted,
      preview: pv?.preview ?? null,
      hints,
      anchors,
      anchorSeat: seat,
      cursor: this.keyboardMode && document.activeElement === this.board.root ? this.cursor : null,
    });
    const root = this.board.root;
    root.dataset.n = String(g.n);
    root.dataset.turn = String(g.turn);
    root.dataset.status = g.status;
    $<HTMLButtonElement>('btn-place').disabled = !(pv && pv.preview.ok && this.actingSeat() !== null);
  }

  private renderStatus(s: SessionSnapshot): void {
    const g = s.game!;
    const el = $('status');
    const turnSeat = g.turn;
    let text: string;
    let mine = false;
    let colorSeat: Seat | null = turnSeat;
    if (g.status === 'over' || s.phase === 'over') {
      const score = scoreGame(g);
      colorSeat = null;
      text =
        score.leader === null
          ? `Game over: a draw, ${formatScore(score.teams[0])} each.`
          : `Game over: ${TEAM_NAMES[score.leader]} wins, ${formatScore(score.teams[score.leader])} to ${formatScore(score.teams[1 - score.leader])}.`;
    } else {
      const info = s.seats[turnSeat];
      const color = COLOR_NAMES[turnSeat];
      if (info.local) {
        mine = true;
        const first = !g.history.some((h) => h.type === 'place' && h.seat === turnSeat);
        const who = s.mode === 'practice' ? `${info.name} (${color})` : `Your turn (${color})`;
        if (s.pending) text = 'Sending your move to the host…';
        else
          text = first
            ? `${who}: your first piece must cover the ${CORNER_NAMES[turnSeat]} corner.`
            : `${who}: place a piece touching your own colour at a corner.`;
      } else if (info.kind === 'ai') {
        text = s.thinking === turnSeat ? `${info.name} (${color}) is thinking…` : `${info.name} (${color}) to play.`;
      } else {
        text = `${info.name}'s turn (${color}).`;
      }
    }
    el.style.setProperty('--pc', colorSeat === null ? 'var(--border)' : `var(--p${colorSeat})`);
    el.style.setProperty('--pc-soft', colorSeat === null ? 'var(--surface)' : `var(--p${colorSeat}-soft)`);
    el.classList.toggle('mine', mine);
    $('status-text').textContent = text;
    $('thinking').hidden = !(s.thinking !== null && g.status === 'playing');
    const teams = scoreGame(g).teams;
    $('status-score').textContent = `Human ${formatScore(teams[0])} · AI ${formatScore(teams[1])}`;
  }

  private renderSeats(s: SessionSnapshot): void {
    const g = s.game!;
    const score = scoreGame(g);
    $('team-scores').replaceChildren(
      ...([0, 1] as const).map((team) =>
        h(
          'div',
          { class: `team-score${score.leader === team ? ' leading' : ''}` },
          h('span', { text: TEAM_NAMES[team] }),
          h('b', { text: formatScore(score.teams[team]) }),
        ),
      ),
    );
    $('seats').replaceChildren(
      ...s.seats.map((info) => {
        const seat = info.seat;
        const sc = scoreSeat(g, seat);
        const isTurn = g.status === 'playing' && g.turn === seat;
        const roleText =
          info.kind === 'ai'
            ? `${TEAM_NAMES[1]} · ${LEVEL_NAMES[s.level]}`
            : `${TEAM_NAMES[0]}${info.local && s.mode === 'online' ? ' · you' : ''}`;
        let state = '';
        if (g.out[seat] && g.status === 'playing') state = sc.allPlaced ? 'All pieces placed' : 'No moves left';
        else if (isTurn) state = s.thinking === seat ? 'Thinking…' : 'Playing';
        const presence =
          info.kind === 'human' && s.mode === 'online'
            ? h('span', {
                class: `presence${info.online ? ' on' : ''}`,
                title: info.vacant ? 'Not joined' : info.online ? 'Online' : 'Offline',
                'aria-label': info.vacant ? 'not joined' : info.online ? 'online' : 'offline',
              })
            : null;
        const inv = h('div', { class: 'inv', 'aria-label': `${sc.piecesLeft} pieces left` });
        for (const p of PIECES) {
          const svg = pieceSvg(p.orientations[0].cells, seat);
          if (!(g.remaining[seat] & (1 << p.index))) svg.classList.add('used');
          inv.append(svg);
        }
        return h(
          'li',
          {
            class: `seat ${seatClass(seat)}${isTurn ? ' turn' : ''}${g.out[seat] ? ' out' : ''}`,
            'aria-current': isTurn ? 'true' : null,
          },
          h('span', { class: 'seat-name' }, presence, `${info.name}`),
          h('span', { class: 'seat-score', text: formatScore(sc.score) }),
          h('span', {
            class: 'seat-meta',
            text: `${COLOR_NAMES[seat]} · ${roleText} · ${sc.piecesLeft} pieces, ${sc.remainingSquares} squares left${state ? ` · ${state}` : ''}`,
          }),
          inv,
        );
      }),
    );
  }

  private renderTray(s: SessionSnapshot): void {
    const g = s.game!;
    const seat = this.traySeat();
    const tray = $('tray');
    if (seat === null) {
      tray.replaceChildren();
      return;
    }
    const acting = this.actingSeat() === seat;
    const fitKey = `${s.gameNumber}:${g.n}:${seat}`;
    if (this.fitCache.key !== fitKey) {
      const pos = positionOf(g);
      const noFit = new Set<number>();
      if (g.status === 'playing') {
        for (const p of PIECES) if (pos.hasPiece(seat, p.index) && pos.legalMovesForPiece(seat, p.index).length === 0) noFit.add(p.index);
      }
      this.fitCache = { key: fitKey, noFit };
    }
    const key = `${fitKey}:${acting}:${this.selection?.piece ?? ''}:${this.selection?.o ?? ''}`;
    $('tray-title').textContent =
      s.mode === 'practice' ? `${s.seats[seat].name}'s pieces (${COLOR_NAMES[seat]})` : `Your pieces (${COLOR_NAMES[seat]})`;
    if (key === this.trayKey) return;
    this.trayKey = key;
    tray.replaceChildren(
      ...PIECES.map((p) => {
        const used = !(g.remaining[seat] & (1 << p.index));
        const noFit = this.fitCache.noFit.has(p.index);
        const selected = this.selection?.piece === p.id;
        const cells = selected ? this.selection!.cells : p.orientations[0].cells;
        const label = `${p.name}, ${p.size} square${p.size > 1 ? 's' : ''}${used ? ', already played' : noFit ? ', does not fit anywhere now' : ''}`;
        const btn = h('button', {
          type: 'button',
          class: `piece-btn${noFit ? ' no-fit' : ''}`,
          'data-piece': p.id,
          'aria-pressed': selected ? 'true' : 'false',
          'aria-label': label,
          title: label,
          disabled: used || g.status !== 'playing',
        });
        btn.append(pieceSvg(cells, seat));
        btn.addEventListener('click', () => this.select(p.id));
        return btn;
      }),
    );
  }

  private renderLog(s: SessionSnapshot): void {
    const g = s.game!;
    const items: HTMLElement[] = [];
    g.history.forEach((e, i) => {
      const name = s.seats[e.seat].name;
      const text =
        e.type === 'place'
          ? `${name} placed the ${pieceById(e.piece).name.toLowerCase()} (${pieceById(e.piece).size})`
          : e.auto
            ? `${name} cannot place any piece and is out`
            : `${name} passed`;
      items.push(
        h('li', { class: seatClass(e.seat), value: i + 1 }, h('span', { class: 'sw', 'aria-hidden': 'true' }), text),
      );
    });
    items.reverse();
    $('log').replaceChildren(...items);
  }

  private renderControls(s: SessionSnapshot): void {
    const acting = this.actingSeat() !== null;
    const hasSel = this.selection !== null;
    $<HTMLButtonElement>('btn-rotate').disabled = !hasSel;
    $<HTMLButtonElement>('btn-flip').disabled = !hasSel;
    $<HTMLButtonElement>('btn-cancel').disabled = !hasSel;
    $<HTMLButtonElement>('btn-suggest').disabled = !acting;
    $<HTMLButtonElement>('btn-hint').disabled = !acting;
    $('btn-hint').setAttribute('aria-pressed', this.hints ? 'true' : 'false');
    const g = s.game!;
    const seat = this.actingSeat();
    $('btn-pass').hidden = !(seat !== null && !positionOf(g).hasMove(seat));
  }

  private maybeShowGameOver(s: SessionSnapshot): void {
    const g = s.game;
    if (!g || g.status !== 'over') return;
    const key = `${s.code ?? 'practice'}:${s.gameNumber}`;
    if (this.overShown === key) return;
    this.overShown = key;
    const score = scoreGame(g);
    $('over-title').textContent = score.leader === null ? 'A draw!' : `${TEAM_NAMES[score.leader]} wins!`;
    const humanWon = score.leader === 0;
    $('over-lead').textContent =
      score.leader === null
        ? `Both teams finished on ${formatScore(score.teams[0])}.`
        : `${TEAM_NAMES[0]} ${formatScore(score.teams[0])}, ${TEAM_NAMES[1]} ${formatScore(score.teams[1])}.${humanWon ? ' Well played!' : ''}`;
    const rows: HTMLElement[] = [];
    for (const team of [0, 1] as const) {
      for (const seat of SEATS.filter((x) => teamOf(x) === team)) {
        const sc = score.seats[seat];
        const bonus = sc.allPlaced ? (sc.monominoLast ? '+15 +5' : '+15') : '';
        rows.push(
          h(
            'tr',
            {},
            h('td', {}, h('span', { class: `log ${seatClass(seat)}` }, h('span', { class: 'sw' })), `${s.seats[seat].name} (${COLOR_NAMES[seat]})`),
            h('td', { text: sc.piecesLeft }),
            h('td', { text: sc.remainingSquares }),
            h('td', { text: bonus }),
            h('td', { text: formatScore(sc.score) }),
          ),
        );
      }
      rows.push(h('tr', { class: 'team-row' }, h('td', { text: TEAM_NAMES[team], colspan: 4 }), h('td', { text: formatScore(score.teams[team]) })));
    }
    $('over-body').replaceChildren(...rows);
    $('btn-over-new').hidden = !s.isHost;
    const dlg = $<HTMLDialogElement>('dlg-over');
    if (!dlg.open) dlg.showModal();
  }

  // ---- Piece handling ----------------------------------------------------------------------

  private resetSelection(): void {
    this.selection = null;
    this.pinned = null;
    this.trayKey = '';
  }

  private select(piece: PieceId): void {
    if (this.selection?.piece === piece) {
      this.cancel();
      return;
    }
    const cells = pieceById(piece).orientations[0].cells.map((c) => [c[0], c[1]] as Cell);
    this.selection = { piece, cells, o: 0 };
    this.pinned = null;
    this.trayKey = '';
    this.announce(`${pieceById(piece).name} selected. Point at the board, or use the arrow keys.`);
    this.renderGame();
  }

  private setCells(cells: Cell[]): void {
    const sel = this.selection;
    if (!sel) return;
    sel.cells = cells;
    sel.o = orientationIndexOf(sel.piece, cells);
    this.trayKey = '';
    this.renderGame();
  }

  private rotate(times: 1 | 3): void {
    if (!this.selection) return;
    let c = this.selection.cells;
    for (let i = 0; i < times; i++) c = rotateCells(c);
    this.setCells(c);
  }

  private flip(): void {
    if (!this.selection) return;
    this.setCells(flipCells(this.selection.cells));
  }

  private cancel(): void {
    this.resetSelection();
    this.renderGame();
  }

  private cyclePiece(dir: 1 | -1): void {
    const g = this.snap?.game;
    const seat = this.traySeat();
    if (!g || seat === null) return;
    const avail = PIECES.filter((p) => g.remaining[seat] & (1 << p.index));
    if (!avail.length) return;
    const i = this.selection ? avail.findIndex((p) => p.id === this.selection!.piece) : -1;
    const next = avail[(i + dir + avail.length) % avail.length];
    this.selection = null;
    this.select(next.id);
  }

  private toggleHints(): void {
    this.hints = !this.hints;
    this.renderGame();
    if (this.hints && this.selection) {
      const g = this.snap?.game;
      const seat = this.actingSeat();
      if (g && seat !== null) {
        const all = positionOf(g).legalMovesForPiece(seat, pieceById(this.selection.piece).index);
        if (all.length === 0) this.toast('This piece does not fit anywhere right now. Try another one.');
        else if (!all.some((c) => decodeMove(c).o === this.selection!.o)) this.toast('It does not fit turned this way. Try Rotate or Flip.');
      }
    }
  }

  private suggest(): void {
    const g = this.snap?.game;
    const seat = this.actingSeat();
    if (!g || seat === null) return;
    const d = chooseAction(g, seat, { level: 'normal', seed: g.n });
    if (d.action.type !== 'place') return;
    const a = d.action;
    const cells = pieceById(a.piece).orientations[a.o].cells.map((c) => [c[0], c[1]] as Cell);
    this.selection = { piece: a.piece, cells, o: a.o };
    const [hx, hy] = handleOf(cells);
    this.pinned = (a.y + hy) * BOARD_SIZE + a.x + hx;
    this.trayKey = '';
    this.renderGame();
    this.toast(`Suggestion: the ${pieceById(a.piece).name.toLowerCase()}. Press Place to play it, or choose another spot.`);
  }

  private activate(cell: number, pointerType: string): void {
    this.keyboardMode = false;
    this.cursor = cell;
    if (!this.selection) {
      if (this.actingSeat() !== null) this.toast('Choose a piece from your tray first.');
      return;
    }
    if (this.actingSeat() === null) {
      this.toast(this.snap?.pending ? 'Your move is on its way to the host.' : 'It is not your turn.');
      return;
    }
    const needsConfirm = this.confirmPlacements || pointerType === 'touch';
    if (needsConfirm && this.pinned !== cell) {
      this.pinned = cell;
      this.renderGame();
      const pv = this.currentPreview();
      this.announce(pv?.error ?? 'Preview placed. Tap the same spot again or press Place to confirm.');
      return;
    }
    this.pinned = cell;
    this.placePreview();
  }

  private placePreview(): void {
    const pv = this.currentPreview();
    if (!pv) {
      this.toast('Choose a piece and a spot on the board first.');
      return;
    }
    if (pv.error) {
      this.toast(pv.error);
      return;
    }
    void this.submit(pv.action);
  }

  private async submit(action: PlaceAction | { type: 'pass'; seat: Seat; n: number }): Promise<void> {
    if (!this.session) return;
    this.busy = true;
    this.renderGame();
    const res = await this.session.submit(action);
    this.busy = false;
    if (res.ok) {
      this.resetSelection();
      if (action.type === 'place') this.announce(`Placed the ${pieceById(action.piece).name.toLowerCase()}.`);
    } else {
      this.pinned = null;
      this.toast(res.error);
    }
    this.renderGame();
  }

  private async pass(): Promise<void> {
    const g = this.snap?.game;
    const seat = this.actingSeat();
    if (!g || seat === null) return;
    await this.submit({ type: 'pass', seat, n: g.n });
  }

  // ---- Keyboard --------------------------------------------------------------------------------

  private onBoardKey(e: KeyboardEvent): void {
    const moves: Record<string, [number, number]> = {
      ArrowLeft: [-1, 0],
      ArrowRight: [1, 0],
      ArrowUp: [0, -1],
      ArrowDown: [0, 1],
    };
    const d = moves[e.key];
    if (d) {
      e.preventDefault();
      this.keyboardMode = true;
      this.pinned = null;
      const x = Math.min(BOARD_SIZE - 1, Math.max(0, (this.cursor % BOARD_SIZE) + d[0]));
      const y = Math.min(BOARD_SIZE - 1, Math.max(0, Math.floor(this.cursor / BOARD_SIZE) + d[1]));
      this.cursor = y * BOARD_SIZE + x;
      this.renderBoard();
      const pv = this.currentPreview();
      this.announce(`${BoardView.coords(this.cursor)}${pv ? (pv.error ? `: ${pv.error}` : ': fits') : ''}`);
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      this.keyboardMode = true;
      if (!this.selection) {
        this.toast('Choose a piece first: press ] for the next piece.');
        return;
      }
      this.pinned = null;
      this.placePreview();
    }
  }

  private onGlobalKey(e: KeyboardEvent): void {
    if (this.screen !== 'game' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.closest('input, select, textarea, dialog[open]')) return;
    const k = e.key.toLowerCase();
    if (k === 'r') this.rotate(e.shiftKey ? 3 : 1);
    else if (k === 'f') this.flip();
    else if (k === 'escape') this.cancel();
    else if (k === 'h') this.toggleHints();
    else if (k === 's') this.suggest();
    else if (k === ']') this.cyclePiece(1);
    else if (k === '[') this.cyclePiece(-1);
    else return;
    e.preventDefault();
  }

  // ---- Feedback --------------------------------------------------------------------------------

  private announce(text: string): void {
    $('board-live').textContent = text;
  }

  toast(text: string): void {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (el.hidden = true), 4500);
  }

  private confirm(text: string): Promise<boolean> {
    $('confirm-text').textContent = text;
    const dlg = $<HTMLDialogElement>('dlg-confirm');
    dlg.showModal();
    return new Promise((resolve) => {
      this.confirmResolve = resolve;
    });
  }

  private closeConfirm(yes: boolean): void {
    const dlg = $<HTMLDialogElement>('dlg-confirm');
    if (dlg.open) dlg.close();
    const r = this.confirmResolve;
    this.confirmResolve = null;
    r?.(yes);
  }
}
