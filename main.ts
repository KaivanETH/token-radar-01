// token-radar-01 entry: read the sealed snapshot, rank every launch candidate, write the board, the
// page's data, the page itself, the screenshots and the dossier the judge reads.
//
//   node main.ts                       reads /input/snapshot.json, writes /output
//   node main.ts --input <file|dir> --output <dir>
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
//
// Node 22 (standard library only), no network, no clock, no randomness: two runs over the same snapshot
// write the same bytes. The dossier is written last, from the files that were just copied, because the
// scorer rebuilds it from /output and compares bytes.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardDocument, boardIssue, buildRadar, dataScript, parseSnapshot, SnapshotError } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const HERE = fileURLToPath(new URL('.', import.meta.url));

/** The scorer's caps. Only the text cap shapes the dossier's bytes; the rest refuse. */
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const DASHBOARD_CAPS = { max_files: 400, max_bytes: 4_194_304 };
/** A file name the gate and the dossier both accept. */
const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** `--name value` or `--name=value` from the arguments, else the fallback. */
function argument(name: string, fallback: string): string {
  const flag = `--${name}`;
  const at = process.argv.indexOf(flag);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const inline = process.argv.find((a) => a.startsWith(`${flag}=`));
  return inline === undefined ? fallback : inline.slice(flag.length + 1);
}

const inputArgument = argument('input', '/input');
const snapshotPath = inputArgument.endsWith('.json') ? inputArgument : join(inputArgument, 'snapshot.json');
const outputDir = argument('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

if (!existsSync(snapshotPath)) {
  process.stderr.write(`token radar: no snapshot at ${snapshotPath}; pass --input <snapshot.json|directory> or mount the sealed /input\n`);
  process.exit(2);
}

let snapshot;
try {
  snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
} catch (err) {
  const why = err instanceof SnapshotError ? err.message : 'it could not be read';
  process.stderr.write(`token radar: the snapshot is not one this model can score: ${why}\n`);
  process.exit(2);
}

const { board, radar } = buildRadar(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: refusing to write a board the gate would refuse: ${issue}\n`);
  process.exit(1);
}

/** Empty a directory this program owns, so a second run cannot leave a stale file behind. */
function resetDirectory(path: string): void {
  rmSync(path, { recursive: true, force: true });
  mkdirSync(path, { recursive: true });
}

/** Copy a directory's plain files into `to`, in name order; returns their names. */
function copyDirectory(from: string, to: string): string[] {
  resetDirectory(to);
  if (!existsSync(from)) return [];
  const names = readdirSync(from).filter((name) => !name.startsWith('.')).sort();
  const copied: string[] = [];
  for (const name of names) {
    const source = join(from, name);
    if (!statSync(source).isFile()) continue;
    copyFileSync(source, join(to, name));
    copied.push(name);
  }
  return copied;
}

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'board.json'), boardDocument(board, radar));
writeFileSync(join(outputDir, 'data.js'), dataScript(radar));

const dashboardFiles = copyDirectory(join(HERE, 'dashboard'), join(outputDir, 'dashboard'));
if (!dashboardFiles.includes('index.html') || !dashboardFiles.some((f) => f.endsWith('.css')) || !dashboardFiles.some((f) => f.endsWith('.js'))) {
  process.stderr.write('token radar: dashboard/ needs index.html and at least one .css and one .js file\n');
  process.exit(1);
}
for (const name of dashboardFiles) {
  if (!PLAIN_NAME.test(name)) {
    process.stderr.write(`token radar: dashboard/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

const shots = copyDirectory(join(HERE, 'screenshots'), join(outputDir, 'screenshots'));
if (shots.length < 3 || shots.length > 4) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length}; the gate wants 3 or 4 (the board, a detail view, a filtered view)\n`);
  process.exit(1);
}
for (const name of shots) {
  if (!PLAIN_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`);
    process.exit(1);
  }
}

// Last, and from the bytes just written: the scorer rebuilds this file from /output and compares it.
writeFileSync(
  join(outputDir, 'dossier.json'),
  buildDossier(outputDir, { text_max_bytes: TEXT_MAX_BYTES, screenshots: SCREENSHOT_CAPS, dashboard: DASHBOARD_CAPS }),
);

const usd = (n: number): string => `$${(n / 1_000_000).toFixed(1)}M`;
process.stdout.write(
  [
    `token radar: ${snapshot.protocols.length} protocols at ${snapshot.as_of}, ${snapshot.watchlist.length} on the watchlist`,
    `token radar: board ${board.length} rows (${radar.counts.below_floor} below the ${usd(snapshot.floor_usd)} floor), top ${board[0]!.name} at ${usd(board[0]!.implied_value_usd)}`,
    `token radar: market multiple ${radar.multiples.global.toFixed(3)}x TVL from ${radar.multiples.live_count} live-token protocols, ${Object.keys(radar.multiples.by_category).length} category tilts`,
    `token radar: wrote board.json, data.js, dashboard/ (${dashboardFiles.length} files), screenshots/ (${shots.length}) and dossier.json to ${outputDir}`,
  ].join('\n') + '\n',
);
