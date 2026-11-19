// A local stand-in for the sealed scorer's seven gate rows, run against /output before pushing.
// It reads the same files the server reads, checks the same limits, and prints one line per row.
//
//   node tools/gatecheck.mjs [--output /output] [--input /input/snapshot.json]
//
// This is the entrant's own checker, not the competition's: it is deliberately strict (it scans whole JS
// and CSS files for a scheme, not only import specifiers) so that a pass here is a pass there.

import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { buildDossier } from '../vendor/makefun-board.ts';

const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
};

const OUT = argOf('output', '/output');
const INPUT = argOf('input', '/input/snapshot.json');
const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const hasScheme = (s) => /https?:\/\//i.test(s);

const snapshot = JSON.parse(readFileSync(INPUT, 'utf8'));
const known = new Set(snapshot.protocols.map((p) => p.slug));
const watchlist = snapshot.watchlist;

// ---------------------------------------------------------------- dashboard_files

function walk(root) {
  const files = [];
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop();
    const dir = rel === '' ? root : join(root, rel);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.')) throw new Error(`dot-directory ${p}`);
        stack.push(p);
      } else if (entry.isFile()) {
        files.push(p);
      } else {
        throw new Error(`${p} is not a regular file`);
      }
    }
  }
  return files.sort();
}

function attributeUrls(html) {
  const hits = [];
  const attrRe = /\s([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  for (const tag of html.match(/<[a-zA-Z][^>]*>/g) ?? []) {
    let m;
    while ((m = attrRe.exec(tag)) !== null) {
      const value = m[2] ?? m[3] ?? m[4] ?? '';
      if (hasScheme(value)) hits.push(`attribute ${m[1]}="${value.slice(0, 50)}"`);
    }
  }
  return hits;
}

function styleUrls(html) {
  const hits = [];
  for (const m of html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)) {
    if (hasScheme(m[1])) hits.push('a <style> body names a scheme');
  }
  return hits;
}

function importUrls(js) {
  const hits = [];
  const patterns = [
    /import\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g,
    /export\s+(?:[\s\S]*?\s+from\s+)["']([^"']+)["']/g,
    /require\s*\(\s*["']([^"']+)["']\s*\)/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of js.matchAll(re)) if (hasScheme(m[1])) hits.push(`import specifier ${m[1].slice(0, 50)}`);
  }
  return hits;
}

function checkDashboard() {
  const root = join(OUT, 'dashboard');
  if (!existsSync(root)) return { problems: ['no dashboard/ directory'] };
  let files;
  try {
    files = walk(root);
  } catch (err) {
    return { problems: [err.message] };
  }
  const problems = [];
  if (!files.includes('index.html')) problems.push('no index.html');
  if (!files.some((f) => f.endsWith('.css'))) problems.push('no .css file');
  if (!files.some((f) => f.endsWith('.js'))) problems.push('no .js file');
  if (files.length > 400) problems.push(`${files.length} files, over 400`);
  let bytes = 0;
  for (const f of files) {
    const path = join(root, f);
    if (!lstatSync(path).isFile()) problems.push(`${f} is not a regular file`);
    if (!PLAIN.test(f.split('/').pop())) problems.push(`${f}: name is not plain`);
    bytes += statSync(path).size;
    const text = readFileSync(path, 'utf8');
    if (f.endsWith('.html')) {
      problems.push(...attributeUrls(text).map((h) => `${f}: ${h}`));
      problems.push(...styleUrls(text).map((h) => `${f}: ${h}`));
      problems.push(...importUrls(text).map((h) => `${f}: ${h}`));
    } else if (f.endsWith('.css') && hasScheme(text)) {
      problems.push(`${f}: a CSS file names a scheme`);
    } else if ((f.endsWith('.js') || f.endsWith('.mjs')) && hasScheme(text)) {
      problems.push(`${f}: a JS file names a scheme`);
    }
  }
  if (bytes > 4 * 1024 * 1024) problems.push(`${bytes} bytes, over 4 MiB`);
  return { problems, note: `${files.length} files, ${bytes} bytes, no scheme in an attribute, style, CSS or JS file` };
}

// ---------------------------------------------------------------- the board

function loadBoard() {
  const path = join(OUT, 'board.json');
  if (!existsSync(path)) return { error: 'no board.json' };
  const bytes = statSync(path).size;
  if (bytes > 8 * 1024 * 1024) return { error: `${bytes} bytes, over 8 MiB` };
  let doc;
  try {
    doc = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { error: 'board.json is not JSON' };
  }
  const rows = Array.isArray(doc) ? doc : doc && Array.isArray(doc.rows) ? doc.rows : null;
  return rows === null ? { error: 'board.json has no rows array' } : { rows, bytes };
}

const board = loadBoard();

function checkBoard() {
  if (board.error) return { problems: [board.error] };
  const { rows, bytes } = board;
  const problems = [];
  if (rows.length < 100 || rows.length > 4000) problems.push(`${rows.length} rows, outside 100..4000`);
  const seen = new Set();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (typeof r !== 'object' || r === null) { problems.push(`row ${i} is not an object`); continue; }
    if (typeof r.slug !== 'string' || r.slug.length < 1 || r.slug.length > 128 || /\s/.test(r.slug)) problems.push(`row ${i} has a bad slug`);
    else if (!known.has(r.slug)) problems.push(`row ${i}: ${r.slug} is not a snapshot protocol`);
    else if (seen.has(r.slug)) problems.push(`row ${i}: ${r.slug} appears twice`);
    else seen.add(r.slug);
    if (typeof r.name !== 'string' || r.name.trim() === '') problems.push(`row ${i} has no name`);
    if (!Number.isInteger(r.rank) || r.rank < 1) problems.push(`row ${i} has rank ${r.rank}`);
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > 100_000_000_000_000) problems.push(`row ${i} has implied value ${r.implied_value_usd}`);
    if (!Array.isArray(r.farm_steps)) problems.push(`row ${i} has no farm_steps array`);
  }
  return { problems: problems.slice(0, 6), note: `${rows.length} rows, ${bytes} bytes, every slug a snapshot protocol` };
}

function checkSorted() {
  if (board.error) return { problems: [board.error] };
  const rows = board.rows;
  const problems = [];
  const ranks = rows.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) { problems.push(`rank ${i + 1} is ${ranks[i]}`); break; }
  }
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].implied_value_usd > rows[i - 1].implied_value_usd) { problems.push(`rank ${i + 1} is worth more than rank ${i}`); break; }
  }
  if (rows.length >= 2 && rows.every((r) => r.implied_value_usd === rows[0].implied_value_usd)) problems.push('every row shares one implied value');
  return { problems, note: `ranks 1..${rows.length} once each, implied value never rises` };
}

function checkCoverage() {
  if (board.error) return { problems: [board.error] };
  const slugs = new Set(board.rows.map((r) => r.slug));
  const missing = watchlist.filter((s) => !slugs.has(s));
  return { problems: missing.length ? [`missing ${missing.length}: ${missing.slice(0, 5).join(', ')}`] : [], note: `all ${watchlist.length} watchlist slugs present` };
}

function checkFarmSteps() {
  if (board.error) return { problems: [board.error] };
  const problems = [];
  let count = 0;
  for (const r of board.rows) {
    if (!Array.isArray(r.farm_steps)) { problems.push(`${r.slug}: no array`); continue; }
    count = Math.max(count, r.farm_steps.length);
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) problems.push(`${r.slug}: ${r.farm_steps.length} steps`);
    for (const s of r.farm_steps) {
      if (typeof s !== 'string') { problems.push(`${r.slug}: a step is not a string`); break; }
      const t = s.trim();
      if (t.length < 20 || t.length > 600) problems.push(`${r.slug}: a step is ${t.length} characters`);
    }
    if (problems.length > 5) break;
  }
  return { problems: problems.slice(0, 6), note: `every row has ${count} steps, each 20..600 characters` };
}

// ---------------------------------------------------------------- screenshots

function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let at = 2;
  while (at + 9 < buf.length) {
    if (buf[at] !== 0xff) { at++; continue; }
    const marker = buf[at + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { at += 2; continue; }
    const length = buf.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: buf.readUInt16BE(at + 5), width: buf.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return null;
}

function checkScreenshots() {
  const dir = join(OUT, 'screenshots');
  if (!existsSync(dir)) return { problems: ['no screenshots/ directory'] };
  const names = readdirSync(dir).filter((n) => !n.startsWith('.')).sort();
  if (names.length < 3 || names.length > 4) return { problems: [`${names.length} images, want 3 or 4`] };
  const problems = [];
  const detail = [];
  for (const name of names) {
    const path = join(dir, name);
    if (!lstatSync(path).isFile()) { problems.push(`${name} is not a regular file`); continue; }
    if (!PLAIN.test(name)) problems.push(`${name}: name is not plain`);
    const size = statSync(path).size;
    if (size > 512 * 1024) problems.push(`${name}: ${size} bytes, over 512 KiB`);
    const buf = readFileSync(path);
    const dims = pngSize(buf) ?? jpegSize(buf);
    if (dims === null) { problems.push(`${name}: not a whole PNG or JPEG`); continue; }
    const long = Math.max(dims.width, dims.height);
    const short = Math.min(dims.width, dims.height);
    if (long > 1440) problems.push(`${name}: long side ${long} over 1440`);
    if (short < 800) problems.push(`${name}: short side ${short} under 800`);
    if (size < 300 * 1024) problems.push(`${name}: ${Math.round(size / 1024)} KB, under the 300 KB band`);
    detail.push(`${name} ${dims.width}x${dims.height} ${Math.round(size / 1024)}KB`);
  }
  return { problems, note: detail.join(' · ') };
}

// ---------------------------------------------------------------- dossier

function checkDossier() {
  const path = join(OUT, 'dossier.json');
  if (!existsSync(path)) return { problems: ['no dossier.json'] };
  const size = statSync(path).size;
  if (size > 1.5 * 1024 * 1024) return { problems: [`${size} bytes, over 1.5 MiB`] };
  const written = Buffer.from(buildDossier(OUT, { text_max_bytes: 65_536 }));
  const mine = readFileSync(path);
  if (!mine.equals(written)) return { problems: [`dossier.json is ${mine.length} bytes; buildDossier writes ${written.length}`] };
  const doc = JSON.parse(mine.toString('utf8'));
  const text = doc.text ?? '';
  const cut = /\n\d+ of its lines are not shown|\n\d+ whole files? and \d+ bytes were left out/.test(text);
  if (cut) return { problems: ['the dossier text was cut: the dashboard source is over 65,536 bytes'] };
  return { problems: [], note: `${size} bytes, byte for byte buildDossier's, text ${Buffer.byteLength(text, 'utf8')} bytes, nothing cut` };
}

// ---------------------------------------------------------------- run

const checks = [
  ['dashboard_files', checkDashboard],
  ['board_file', checkBoard],
  ['sorted_by_value', checkSorted],
  ['coverage', checkCoverage],
  ['farm_steps', checkFarmSteps],
  ['screenshots', checkScreenshots],
  ['dossier_matches', checkDossier],
];

let pass = 0;
for (const [name, run] of checks) {
  const { problems, note } = run();
  const ok = problems.length === 0;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(17)} ${ok ? note : problems.join(' | ')}`);
}
console.log(`\n${pass}/7 rows pass`);
process.exit(pass === 7 ? 0 : 1);
