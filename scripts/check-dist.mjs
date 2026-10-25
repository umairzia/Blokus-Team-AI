// Checks a production build before it is published to GitHub Pages:
//  - every asset referenced by index.html (and by the built JS and CSS) uses
//    the repository base path and exists in the build,
//  - no source maps, .env files or credential-looking strings are shipped,
//  - the build is not configured to talk to local emulators.
// Usage: node scripts/check-dist.mjs dist [--base /Blokus-Team-AI/]
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const dir = process.argv[2] ?? 'dist';
const baseArg = process.argv.indexOf('--base');
const base = baseArg > 0 ? process.argv[baseArg + 1] : (process.env.BASE_PATH ?? '/Blokus-Team-AI/');
const problems = [];

function walk(d) {
  return readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

if (!existsSync(join(dir, 'index.html'))) {
  console.error(`No ${dir}/index.html: run the build first.`);
  process.exit(1);
}
const files = walk(dir).map((f) => relative(dir, f).split('\\').join('/'));
const html = readFileSync(join(dir, 'index.html'), 'utf8');

// 1. URLs in index.html.
const refs = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
for (const ref of refs) {
  if (/^(https?:|mailto:|#|data:)/.test(ref) || ref === './') continue;
  if (!ref.startsWith(base)) {
    problems.push(`index.html references ${ref}, which is not under the base path ${base}`);
    continue;
  }
  const file = ref.slice(base.length).split(/[?#]/)[0];
  if (!files.includes(file)) problems.push(`index.html references ${ref}, but ${file} is not in the build`);
}
if (!refs.some((r) => /assets\/index-.*\.js$/.test(r))) problems.push('index.html does not load the main script bundle');

// 2. Asset URLs inside JS and CSS (lazy chunks, the AI worker, fonts, images).
for (const f of files.filter((x) => /\.(js|css)$/.test(x))) {
  const text = readFileSync(join(dir, f), 'utf8');
  for (const m of text.matchAll(/["'(]((?:\/[\w.-]+)*\/assets\/[\w.-]+\.(?:js|css|svg|png|woff2?))["')]/g)) {
    const url = m[1];
    if (!url.startsWith(base)) problems.push(`${f} references ${url}, not under ${base}`);
    else if (!files.includes(url.slice(base.length))) problems.push(`${f} references missing ${url}`);
  }
  for (const m of text.matchAll(/["'`]((?:\.\/)?assets\/[\w.-]+\.(?:js|css))["'`]/g)) {
    const file = m[1].replace(/^\.\//, '');
    if (!files.includes(file)) problems.push(`${f} references missing ${m[1]}`);
  }
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----|"private_key"\s*:\s*"|"type"\s*:\s*"service_account"/.test(text)) {
    problems.push(`${f} contains something that looks like a private credential`);
  }
  if (/127\.0\.0\.1:9000|localhost:9000/.test(text) && dir === 'dist') problems.push(`${f} points at a local emulator`);
}

// 3. Things that must never be published.
for (const f of files) {
  if (f.endsWith('.map')) problems.push(`source map in the build: ${f}`);
  if (/(^|\/)\.env/.test(f)) problems.push(`environment file in the build: ${f}`);
}
const allJs = files.filter((x) => x.endsWith('.js')).map((x) => readFileSync(join(dir, x), 'utf8')).join('\n');
if (dir === 'dist' && /demo-blokus|127\.0\.0\.1:9000:9099/.test(allJs)) {
  problems.push('the production build contains the emulator configuration');
}

if (problems.length) {
  console.error(`check-dist: ${problems.length} problem(s) in ${dir}/:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}
console.log(`check-dist: ${dir}/ OK (${files.length} files, ${refs.length} references in index.html, base ${base}).`);
