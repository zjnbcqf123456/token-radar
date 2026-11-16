// Local gate: the same seven checks the server's scorer runs, on this machine's /output.
// Usage: node scripts/check.mjs [out-dir] [snapshot.json]
// Exit 0 when every check passes, 1 otherwise. It never writes anything.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildDossier } from '../vendor/makefun-board.ts';

const out = process.argv[2] ?? 'out';
const snapPath = process.argv[3] ?? '../token-radar-01-kit/input/snapshot.json';
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

const dashDir = join(out, 'dashboard');
const dashFiles = existsSync(dashDir)
  ? readdirSync(dashDir).filter((f) => statSync(join(dashDir, f)).isFile())
  : [];
const dashBytes = dashFiles.reduce((n, f) => n + statSync(join(dashDir, f)).size, 0);
const hasHtml = dashFiles.includes('index.html');
const hasCss = dashFiles.some((f) => f.endsWith('.css'));
const hasJs = dashFiles.some((f) => f.endsWith('.js'));
let urlLeak = '';
for (const f of dashFiles) {
  if (!/\.(html|css|js|txt|md)$/.test(f)) continue;
  const text = readFileSync(join(dashDir, f), 'utf8');
  if (/https?:\/\//.test(text)) urlLeak = `${f} carries an http(s) address`;
  if (/url\(/i.test(text)) urlLeak = `${f} carries a url()`;
}
let inlineScript = '';
if (hasHtml) {
  const html = readFileSync(join(dashDir, 'index.html'), 'utf8');
  const tags = [...html.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
  if (tags.some((t) => !/src=/.test(t))) inlineScript = 'index.html carries an inline <script>';
}
check(
  'dashboard_files',
  hasHtml && hasCss && hasJs && dashFiles.length <= 400 && dashBytes <= 4_194_304 && !urlLeak && !inlineScript,
  `${dashFiles.length} files, ${dashBytes} bytes${urlLeak ? `; ${urlLeak}` : ''}${inlineScript ? `; ${inlineScript}` : ''}`,
);

let board = null;
try {
  board = JSON.parse(readFileSync(join(out, 'board.json'), 'utf8'));
} catch {
  board = null;
}
const rows = board?.rows ?? [];
check(
  'board_file',
  Array.isArray(rows) && rows.length >= 100 && rows.length <= 4000,
  `${rows.length} rows`,
);

const values = rows.map((r) => r.implied_value_usd);
const nonIncreasing = values.every((v, i) => i === 0 || v <= values[i - 1]);
const notAllEqual = values.length < 2 || values[0] !== values[values.length - 1];
const intsOk = rows.every((r) => Number.isSafeInteger(r.implied_value_usd) && r.implied_value_usd > 0 && r.implied_value_usd <= 1e14);
check('sorted_by_value', nonIncreasing && notAllEqual && intsOk, nonIncreasing ? `top $${values[0]?.toLocaleString()} to bottom $${values[values.length - 1]?.toLocaleString()}` : 'implied value rises with rank');

const snap = JSON.parse(readFileSync(snapPath, 'utf8'));
const slugs = new Set(rows.map((r) => r.slug));
const missing = snap.watchlist.filter((s) => !slugs.has(s));
const ranksOk = rows.map((r) => r.rank).sort((a, b) => a - b).every((r, i) => r === i + 1);
check('coverage', missing.length === 0 && ranksOk, missing.length === 0 ? `all ${snap.watchlist.length} watchlist slugs, ranks 1..${rows.length}` : `missing ${missing.join(', ')}`);

let farmBad = '';
for (const r of rows) {
  const steps = r.farm_steps ?? [];
  if (steps.length < 3 || steps.length > 12) { farmBad = `${r.slug} has ${steps.length} steps`; break; }
  const bad = steps.find((s) => s.length < 20 || s.length > 600);
  if (bad) { farmBad = `${r.slug} has a ${bad.length}-character step`; break; }
}
check('farm_steps', !farmBad, farmBad || `${rows.length} rows, 3..12 steps each, 20..600 characters`);

const shotDir = join(out, 'screenshots');
const shots = existsSync(shotDir) ? readdirSync(shotDir).filter((f) => statSync(join(shotDir, f)).isFile()) : [];
let shotBad = '';
for (const name of shots) {
  const buf = readFileSync(join(shotDir, name));
  if (buf.length > 524_288) { shotBad = `${name} is ${buf.length} bytes`; break; }
  const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8;
  if (!isPng && !isJpeg) { shotBad = `${name} is neither PNG nor JPEG`; break; }
  if (isPng) {
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (Math.max(w, h) > 1440 || Math.min(w, h) < 800) { shotBad = `${name} is ${w}x${h}`; break; }
  }
}
check('screenshots', shots.length >= 3 && shots.length <= 4 && !shotBad, `${shots.length} images${shotBad ? `; ${shotBad}` : ''}`);

let dossierOk = false;
let dossierDetail = '';
try {
  const rebuilt = buildDossier(out, {
    text_max_bytes: 65_536,
    screenshots: { max: 4, max_bytes: 524_288 },
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  });
  const saved = readFileSync(join(out, 'dossier.json'));
  const parsed = JSON.parse(saved.toString('utf8'));
  const textBytes = Buffer.byteLength(parsed.text ?? '', 'utf8');
  dossierOk = Buffer.from(rebuilt).equals(saved) && saved.length <= 1_572_864 && textBytes <= 65_536;
  dossierDetail = `rebuilt ${rebuilt.length} bytes, saved ${saved.length} bytes, text ${textBytes} bytes, identical: ${Buffer.from(rebuilt).equals(saved)}`;
} catch (e) {
  dossierDetail = `buildDossier threw: ${e.message}`;
}
check('dossier_matches', dossierOk, dossierDetail);

const failed = results.filter((r) => !r.ok).length;
console.log(failed === 0 ? `\nALL ${results.length} CHECKS PASS` : `\n${failed} OF ${results.length} CHECKS FAIL`);
process.exit(failed === 0 ? 0 : 1);
