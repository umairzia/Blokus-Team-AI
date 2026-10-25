/**
 * AI evaluation harness: plays paired-seed AI-versus-AI games and reports
 * how two difficulty levels compare.
 *
 * For each seed, the same seeded random opening (a few random pentomino
 * placements, so the series covers different games) is played twice with
 * the teams swapped: once with level A on team 0 (seats 0 and 2, who move
 * first) and once on team 1. Pairing removes the first-move advantage and
 * opening luck from the comparison.
 *
 * Usage:
 *   npm run ai:eval -- --a hard --b normal --pairs 100 [--opening 4]
 *                      [--workers 4] [--seed 1000] [--json out.json]
 */

import { writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { isLevel, type Level } from '../src/ai/decide';
import { lineup, playMatch } from '../src/ai/match';

interface Job {
  pair: number;
  seed: number;
  a: Level;
  b: Level;
  opening: number;
}

interface GameRecord {
  aTeam: 0 | 1;
  aScore: number;
  bScore: number;
  margin: number; // A minus B
  outcome: 'win' | 'draw' | 'loss';
  aThinkMs: number;
  aMaxMs: number;
  aDecisions: number;
  plies: number;
  timeouts: number;
}

interface PairRecord {
  pair: number;
  seed: number;
  games: [GameRecord, GameRecord];
}

function runJob(job: Job): PairRecord {
  const games = ([0, 1] as const).map((aTeam) => {
    const players = aTeam === 0 ? lineup({ level: job.a }, { level: job.b }) : lineup({ level: job.b }, { level: job.a });
    const r = playMatch({ players, seed: job.seed, randomOpeningPlies: job.opening });
    const aScore = r.score.teams[aTeam];
    const bScore = r.score.teams[1 - aTeam];
    const aSeats = aTeam === 0 ? [0, 2] : [1, 3];
    const aDecisions = r.final.history.filter((h, i) => i >= job.opening && aSeats.includes(h.seat) && !(h.type === 'pass' && h.auto)).length;
    return {
      aTeam,
      aScore,
      bScore,
      margin: aScore - bScore,
      outcome: aScore > bScore ? 'win' : aScore === bScore ? 'draw' : 'loss',
      aThinkMs: r.thinkMs[aSeats[0]] + r.thinkMs[aSeats[1]],
      aMaxMs: r.maxDecisionMs,
      aDecisions,
      plies: r.plies,
      timeouts: r.timeouts,
    } satisfies GameRecord;
  });
  return { pair: job.pair, seed: job.seed, games: games as [GameRecord, GameRecord] };
}

if (!isMainThread) {
  parentPort!.on('message', (job: Job | null) => {
    if (job === null) process.exit(0);
    parentPort!.postMessage(runJob(job));
  });
} else {
  await main();
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

/** Two-sided exact binomial (sign) test with p = 1/2. */
function signTest(wins: number, losses: number): number {
  const n = wins + losses;
  if (n === 0) return 1;
  const k = Math.min(wins, losses);
  let logC = 0;
  let tail = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logC += Math.log(n - i + 1) - Math.log(i);
    tail += Math.exp(logC - n * Math.LN2);
  }
  return Math.min(1, 2 * tail);
}

function meanCi(xs: number[]): { mean: number; lo: number; hi: number; sd: number } {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(xs.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1));
  const half = (1.96 * sd) / Math.sqrt(n);
  return { mean, lo: mean - half, hi: mean + half, sd };
}

async function main(): Promise<void> {
  const a = arg('a', 'hard');
  const b = arg('b', 'normal');
  if (!isLevel(a) || !isLevel(b)) throw new Error('--a and --b must be easy, normal or hard');
  const pairs = Number(arg('pairs', '100'));
  const opening = Number(arg('opening', '4'));
  const baseSeed = Number(arg('seed', '1000'));
  const workers = Math.max(1, Math.min(Number(arg('workers', String(availableParallelism()))), pairs));
  const jsonOut = arg('json', '');

  const jobs: Job[] = Array.from({ length: pairs }, (_, i) => ({ pair: i, seed: baseSeed + i, a, b, opening }));
  const results: PairRecord[] = [];
  const started = performance.now();
  await new Promise<void>((resolve, reject) => {
    let next = 0;
    let active = 0;
    const file = fileURLToPath(import.meta.url);
    for (let w = 0; w < workers; w++) {
      // tsx's loader does not reach a worker's entry module, so each worker
      // registers it first and then imports this file.
      const boot = `import('tsx/esm/api').then((m) => { m.register(); return import(${JSON.stringify(pathToFileURL(file).href)}); });`;
      const worker = new Worker(boot, { eval: true });
      active++;
      const feed = () => worker.postMessage(next < jobs.length ? jobs[next++] : null);
      worker.on('message', (r: PairRecord) => {
        results.push(r);
        if (results.length % 10 === 0) process.stderr.write(`  ${results.length}/${pairs} pairs\n`);
        feed();
      });
      worker.on('error', reject);
      worker.on('exit', () => {
        if (--active === 0) resolve();
      });
      feed();
    }
  });
  results.sort((x, y) => x.pair - y.pair);
  const wallS = (performance.now() - started) / 1000;

  const games = results.flatMap((r) => r.games);
  const w = games.filter((g) => g.outcome === 'win').length;
  const d = games.filter((g) => g.outcome === 'draw').length;
  const l = games.filter((g) => g.outcome === 'loss').length;
  const scoreRate = (w + d / 2) / games.length;
  const rateHalf = 1.96 * Math.sqrt((scoreRate * (1 - scoreRate)) / games.length);
  const pairMargins = results.map((r) => (r.games[0].margin + r.games[1].margin) / 2);
  const m = meanCi(pairMargins);
  const pairWins = pairMargins.filter((x) => x > 0).length;
  const pairLosses = pairMargins.filter((x) => x < 0).length;
  const p = signTest(pairWins, pairLosses);
  const decisions = games.reduce((s, g) => s + g.aDecisions, 0);
  const avgMs = games.reduce((s, g) => s + g.aThinkMs, 0) / Math.max(1, decisions);
  const maxMs = Math.max(...games.map((g) => g.aMaxMs));
  const timeouts = games.reduce((s, g) => s + g.timeouts, 0);
  const asTeam0 = games.filter((g) => g.aTeam === 0);
  const asTeam1 = games.filter((g) => g.aTeam === 1);
  const winsAs = (gs: GameRecord[]) => gs.filter((g) => g.outcome === 'win').length;

  const summary = {
    a,
    b,
    pairs,
    games: games.length,
    opening,
    baseSeed,
    wins: w,
    draws: d,
    losses: l,
    scoreRate,
    scoreRateCi: [scoreRate - rateHalf, scoreRate + rateHalf],
    meanPairMargin: m.mean,
    meanPairMarginCi: [m.lo, m.hi],
    pairWins,
    pairLosses,
    pairTies: pairs - pairWins - pairLosses,
    signTestP: p,
    winsAsTeam0: `${winsAs(asTeam0)}/${asTeam0.length}`,
    winsAsTeam1: `${winsAs(asTeam1)}/${asTeam1.length}`,
    avgDecisionMsA: avgMs,
    maxDecisionMsAny: maxMs,
    timeouts,
    wallSeconds: wallS,
  };
  console.log(JSON.stringify(summary, null, 2));
  console.log(
    `\n${a} vs ${b}: ${w}W ${d}D ${l}L over ${games.length} games (score rate ${(scoreRate * 100).toFixed(1)}% ` +
      `± ${(rateHalf * 100).toFixed(1)}); mean paired margin ${m.mean.toFixed(2)} [${m.lo.toFixed(2)}, ${m.hi.toFixed(2)}]; ` +
      `pairs won/lost ${pairWins}/${pairLosses}, sign test p = ${p.toPrecision(3)}`,
  );
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify({ summary, results }, null, 2));
}
