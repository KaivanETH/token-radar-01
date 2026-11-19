// The radar's model. One snapshot of the protocol universe in; one ranked board, one farm plan per
// protocol and one page's worth of data out. Node 22 strips the types and runs this file as it is.
//
// Two numbers per protocol, and they answer two different questions:
//
//   implied value  what a token would be worth if the protocol's record held as it is today. It is the
//                  board's rank, and it is built only from the snapshot's own figures:
//                    implied = TVL x multiple x momentum x tenure
//                  where `multiple` is the market's own median market-cap-to-TVL across the protocols in
//                  this same snapshot whose token already trades, tilted by category, and `momentum` and
//                  `tenure` are the seven-day change and the time tracked without a token.
//
//   farm window    how early the farm still is: momentum, youth and enough TVL for activity to count.
//                  It never moves a rank. It is the second lens: rank says what the launch is worth,
//                  window says whether it is worth starting this month.
//
// Nothing here is keyed to a protocol's name. Every row goes through the same arithmetic, and the only
// per-category numbers are medians the snapshot itself supplies.

/** One protocol, exactly the ten fields the sealed snapshot carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The market's multiple, read off the protocols that already have a token. */
export interface MultipleTable {
  /** Median market cap divided by TVL across every live-token protocol in the snapshot. */
  global: number;
  /** How many protocols that median was taken over. */
  live_count: number;
  /** Per-category multiple: the category's median, shrunk toward `global` and clamped near it. */
  by_category: Record<string, number>;
  /** How many live protocols each category's multiple was read from. */
  category_n: Record<string, number>;
}

/** The model's fixed rules. The multiple is the snapshot's; these are the damping choices. */
export interface ModelRules {
  /** How much of the seven-day change counts, as a fraction of the raw move. */
  momentum_weight: number;
  /** The seven-day change is clamped here before it counts: one week is a noisy vote. */
  momentum_floor: number;
  momentum_cap: number;
  /** Tenure at day zero, and the extra confidence a four-year track record earns. */
  tenure_floor: number;
  tenure_range: number;
  tenure_days: number;
  /** Age used when the snapshot carries no listing date. */
  unknown_age_days: number;
  /** A category's median is pulled toward the global one with this many pseudo-observations. */
  shrink: number;
  /** No category multiple strays further than this from the global multiple. */
  tilt_floor: number;
  tilt_cap: number;
}

export const RULES: ModelRules = {
  momentum_weight: 0.5,
  momentum_floor: -50,
  momentum_cap: 100,
  tenure_floor: 0.78,
  tenure_range: 0.3,
  tenure_days: 1460,
  unknown_age_days: 365,
  shrink: 12,
  tilt_floor: 0.7,
  tilt_cap: 1.5,
};

/** The model's label, quoted on the page and in board.json. */
export const MODEL_VERSION = 'radar-2';

/** A farm step: the action, what it costs, how long it takes, and which side of a launch it is on. */
export interface FarmStep {
  phase: 'before' | 'after';
  text: string;
  cost: string;
  time: string;
}

/** One row of the ranked board. `farm_steps` is the gate's shape; `farm` is the same plan for the page. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  age_days: number | null;
  implied_value_usd: number;
  multiple: number;
  momentum: number;
  tenure: number;
  farm_window: number;
  window_label: string;
  on_watchlist: boolean;
  above_floor: boolean;
  farm: FarmStep[];
  farm_steps: string[];
}

/** A live-token protocol, for the page's "already trading" table: the market's own numbers. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
  multiple: number;
}

/** Everything the page renders, written to data.js beside it. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  rules: ModelRules;
  multiples: MultipleTable;
  counts: {
    protocols: number;
    watchlist: number;
    board: number;
    below_floor: number;
    /** Rows at or above the floor that the house's watchlist does not name: the floor is not the ceiling. */
    above_floor_off_list: number;
    /** Protocols whose record carries a token (a symbol, a CoinGecko id or a market cap). */
    token_recorded: number;
    /** Protocols that carry a market cap and a TVL: the ones the multiple can be read from. */
    with_mcap: number;
  };
  rows: BoardRow[];
  live: LiveRow[];
}

const DAY_MS = 86_400_000;

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** A finite number, else `fallback`. */
const finite = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

/** The median of a non-empty list, without mutating it. */
function median(values: number[]): number {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Whole days from `listed_at` to `as_of`, never negative; null when a date is missing or malformed. */
export function ageInDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const end = Date.parse(`${asOf}T00:00:00Z`);
  const start = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, Math.floor((end - start) / DAY_MS));
}

/** Whether the snapshot's record carries no token at all: no market cap, no CoinGecko id, no symbol. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/**
 * Categories that are somebody else's asset rather than a protocol of their own: an exchange, a bridge,
 * a liquid-staking or restaking receipt, a wrapped or stable wrapper. A launch from one of these would
 * be a product of a token that already trades, so they are not launch candidates. The watchlist is
 * still covered whole; this filter only decides the extra rows below the house's floor.
 */
const DERIVATIVE_CATEGORIES = new Set([
  'CEX',
  'Bridge',
  'Canonical Bridge',
  'Cross Chain Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'Stablecoin Wrapper',
  'Dual-Token Stablecoin',
  'Anchor BTC',
]);

/** A name ending in a release marker is a pool of another protocol, not a new one. */
const VERSIONED = /\s(v\d+(\.\d+)?|\d+\.\d+)$/i;
/** A wrapped, staked or staking product is not a protocol waiting on a launch of its own. */
const DERIVATIVE_WORD = /\b(wrapped|staked|staking)\b/i;
/** An exchange's own product is the exchange, not a protocol to farm for a launch. */
const EXCHANGE_PREFIXES = ['binance', 'coinbase', 'bybit', 'kraken', 'bitget', 'okx', 'bitfinex', 'gemini'];

/** Whether a protocol that records no token is a launch candidate rather than a product of one. */
export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  if (!recordsNoToken(p)) return false;
  if (p.category !== null && DERIVATIVE_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name) || DERIVATIVE_WORD.test(p.name)) return false;
  const lower = p.name.toLowerCase();
  if (EXCHANGE_PREFIXES.some((prefix) => lower.startsWith(prefix))) return false;
  return true;
}

/**
 * The market's multiple, measured on this snapshot: median market cap over TVL among the protocols whose
 * token already trades. A category's own median is used when it has at least three of them, pulled toward
 * the global median by `shrink` pseudo-observations so a thin category cannot invent a multiple, and
 * clamped to a band around the global one.
 */
export function multipleTable(snapshot: Snapshot): MultipleTable {
  const live = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const ratios = live.map((p) => (p.mcap_usd as number) / p.tvl_usd);
  const raw = ratios.length > 0 ? median(ratios) : 0.25;
  // A snapshot with a handful of live protocols could produce a silly median; keep the multiple sane.
  const global = clamp(raw, 0.05, 1.5);

  const groups = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? '';
    if (key === '') continue;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [(p.mcap_usd as number) / p.tvl_usd]);
    else list.push((p.mcap_usd as number) / p.tvl_usd);
  }

  const by_category: Record<string, number> = {};
  const category_n: Record<string, number> = {};
  for (const key of [...groups.keys()].sort()) {
    const list = groups.get(key)!;
    category_n[key] = list.length;
    if (list.length < 3) continue;
    const shrunk = (list.length * median(list) + RULES.shrink * global) / (list.length + RULES.shrink);
    by_category[key] = clamp(shrunk, global * RULES.tilt_floor, global * RULES.tilt_cap);
  }
  return { global, live_count: live.length, by_category, category_n };
}

/** The multiple one protocol's launch is priced at: its category's, or the market's own. */
export function multipleFor(p: SnapshotProtocol, table: MultipleTable): number {
  const key = p.category ?? '';
  return table.by_category[key] ?? table.global;
}

/** The three multipliers and the implied value one protocol gets under the model. */
export interface Valuation {
  implied: number;
  multiple: number;
  momentum: number;
  tenure: number;
  age: number | null;
  growth_pct: number;
}

export function valueOf(p: SnapshotProtocol, asOf: string, table: MultipleTable): Valuation {
  const age = ageInDays(asOf, p.listed_at);
  const growth = clamp(finite(p.change_7d, 0), RULES.momentum_floor, RULES.momentum_cap);
  const momentum = 1 + (growth / 100) * RULES.momentum_weight;
  const years = Math.min(Math.max(age ?? RULES.unknown_age_days, 0), RULES.tenure_days) / RULES.tenure_days;
  const tenure = RULES.tenure_floor + years * RULES.tenure_range;
  const multiple = multipleFor(p, table);
  const implied = Math.max(1, Math.round(p.tvl_usd * multiple * momentum * tenure));
  return { implied, multiple, momentum, tenure, age, growth_pct: growth };
}

/**
 * The farm window, 0 to 100. Three inputs, all from the record: how fast TVL is moving (45%), how young
 * the protocol is (35%) and whether it is big enough for activity to count (20%). It is a timing signal,
 * never a value, and it never changes a rank.
 */
export function farmWindow(age: number | null, change7d: number | null, tvl: number): { score: number; label: string } {
  const growth = clamp(finite(change7d, 0), RULES.momentum_floor, RULES.momentum_cap);
  const momentum = clamp((growth + 20) / 80, 0, 1);
  const freshness = clamp(1 - (age ?? RULES.unknown_age_days) / 1095, 0.08, 1);
  const size = clamp(Math.log10(Math.max(tvl, 1) / 1_000_000) / 3.5, 0, 1);
  const score = Math.round(100 * (0.45 * momentum + 0.35 * freshness + 0.2 * size));
  return { score, label: score >= 65 ? 'wide' : score >= 40 ? 'open' : 'closing' };
}

// ---------------------------------------------------------------- farm plans

/** How much capital one position takes, from the protocol's own TVL. */
function capitalFor(tvl: number): number {
  if (tvl >= 2_000_000_000) return 250;
  if (tvl >= 500_000_000) return 200;
  if (tvl >= 100_000_000) return 150;
  if (tvl >= 25_000_000) return 100;
  return 75;
}

/** How long the position should stay open, from how long the protocol has been tracked. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 120) return 75;
  if (age < 365) return 60;
  if (age < 730) return 45;
  return 30;
}

/** How long to keep the weekly cadence, from the protocol's age. */
function cadenceWeeksFor(age: number | null): number {
  if (age === null) return 6;
  if (age < 120) return 8;
  if (age < 365) return 6;
  return 4;
}

/** How long to wait for a token before redeploying. */
function waitMonthsFor(age: number | null): number {
  if (age === null) return 12;
  if (age < 180) return 18;
  if (age < 730) return 12;
  return 9;
}

/** The first chain a protocol names. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/**
 * The one position that counts for this category, in words a farmer can follow. The category is the
 * snapshot's own field; no protocol name is ever special-cased.
 */
function positionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral') || c.includes('credit')) {
    return `Supply $${capital} of USDC to ${name} on ${chain}, then borrow about $${Math.round(capital / 3)} of a major asset against it so the wallet reads as an active borrower, not a one-off depositor.`;
  }
  if (c.includes('dex') || c.includes('yield') || c.includes('farm') || c.includes('liquidity')) {
    return `Provide $${capital} of liquidity to ${name}'s deepest pool on ${chain} and leave the LP position open rather than swapping in and out.`;
  }
  if (c.includes('perp') || c.includes('derivative')) {
    return `Deposit $${capital} of USDC as margin on ${name} and keep one small hedged position open through the season.`;
  }
  if (c.includes('prediction')) {
    return `Fund $${capital} on ${name} and keep one open position across two markets that resolve, so the wallet has settled volume.`;
  }
  if (c.includes('rwa') || c.includes('treasury')) {
    return `Mint $${capital} of ${name}'s yield asset on ${chain} and hold the receipt rather than the underlying.`;
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault')) {
    return `Deposit $${capital} of USDC into a ${name} vault on ${chain} and keep the shares for the whole season.`;
  }
  if (c.includes('basis')) {
    return `Deposit $${capital} into ${name}'s basis strategy on ${chain} and leave it through at least one funding cycle.`;
  }
  if (c.includes('restak') || c.includes('staking') || c.includes('stake')) {
    return `Stake $${capital} of ${chain}'s staking asset through ${name} and keep the receipt token in the same wallet.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active rather than letting it lapse.`;
  }
  if (c.includes('chain') || c.includes('payment')) {
    return `Bridge $${capital} of USDC onto ${chain} and use ${name}'s own app for one swap and one deposit a week.`;
  }
  if (c.includes('stable')) {
    return `Mint $${capital} of ${name}'s stable asset on ${chain} against collateral and hold it in the farming wallet.`;
  }
  if (c.includes('governance') || c.includes('incentive')) {
    return `Lock $${capital} in ${name}'s incentive program on ${chain} and vote in at least one proposal.`;
  }
  if (c.includes('otc') || c.includes('marketplace')) {
    return `Fund $${capital} and settle one trade through ${name} on ${chain}, then leave the balance there.`;
  }
  if (c.includes('card')) {
    return `Deposit $${capital} to ${name} on ${chain} and make one card transaction a week from that balance.`;
  }
  if (c.includes('cedefi')) {
    return `Deposit $${capital} into ${name}'s CeDeFi vault on ${chain} and keep it for the season.`;
  }
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open through the season.`;
}

/** One step as the gate's string: the action, then its cost and its time, 20 to 600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596).trimEnd()}...`;
  return s;
}

/** What the first sale should leave alone, in this category's own terms. */
function afterNoteFor(p: SnapshotProtocol): string {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('dex') || c.includes('yield') || c.includes('farm') || c.includes('liquidity')) {
    return 'If the token is paid to your LP position, claim it and restake rather than selling the whole claim on the first day.';
  }
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return 'If the token is a governance token, keep the borrow open through its first vote so the position still counts.';
  }
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault')) {
    return 'If the token is a share of the vault fees, keep the shares rather than selling into the first day.';
  }
  if (c.includes('perp') || c.includes('derivative')) {
    return 'If the token is paid as trading rewards, keep the hedge on until the claim settles.';
  }
  return 'If the token is paid for activity, claim it in the same wallet that did the activity.';
}

/**
 * A protocol's farm plan: eight steps, each with a cost and a time, split at the launch. Everything that
 * varies — the position, the capital, the hold, the cadence, the wait — comes from the protocol's own
 * record, so two protocols with different figures get different plans.
 */
export function farmPlan(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p.tvl_usd);
  const hold = holdDaysFor(age);
  const weeks = cadenceWeeksFor(age);
  const months = waitMonthsFor(age);
  const gas = capital >= 200 ? 10 : 6;
  const holdWhy =
    age === null
      ? 'the snapshot carries no listing date, so give it a full quarter of activity'
      : age < 180
        ? `it was listed ${age} days ago and has not yet been through a full season`
        : `it has been tracked ${Math.round(age / 30)} months, so its seasons are already running`;

  return [
    {
      phase: 'before',
      text: `Open a fresh wallet on ${chain} that holds only farm funds, write its seed phrase on paper, and never reuse it for anything you would mind losing.`,
      cost: '$0 to create, about $3 of gas for the first transaction',
      time: '10 minutes',
    },
    {
      phase: 'before',
      text: positionFor(p, capital, chain),
      cost: `$${capital} of capital, plus about $${gas} of gas and fees`,
      time: '15 minutes to set up',
    },
    {
      phase: 'before',
      text: `Repeat one qualifying action every week for ${weeks} weeks — a deposit, a borrow, a swap or a vote — so the wallet has a history rather than a single transaction.`,
      cost: 'about $2 of gas a week',
      time: `10 minutes a week for ${weeks} weeks`,
    },
    {
      phase: 'before',
      text: `Keep the position open for at least ${hold} days: ${holdWhy}.`,
      cost: `the $${capital} stays in the position and is not spent`,
      time: `${hold} days`,
    },
    {
      phase: 'before',
      text: `Read ${p.name}'s own docs and governance forum for a points, season or snapshot rule before adding more, and check the wallet's history on ${chain}'s explorer.`,
      cost: 'no fee to read; $0',
      time: '20 minutes',
    },
    {
      phase: 'after',
      text: `When a token is announced, claim only from ${p.name}'s official site or app, and never pay an address that sends you a claim link.`,
      cost: 'one network fee, usually under $5',
      time: '30 minutes on claim day',
    },
    {
      phase: 'after',
      text: `Sell enough of the claim to recover the $${capital} you put in. ${afterNoteFor(p)} Write the sale and the remaining position in the same log.`,
      cost: 'about 0.3% of the sale in fees and slippage',
      time: '30 minutes',
    },
    {
      phase: 'after',
      text: `If no token is announced within ${months} months, withdraw, keep the log, and move the $${capital} to the next row on this board.`,
      cost: 'exit gas, about $5',
      time: '20 minutes',
    },
  ];
}

// ---------------------------------------------------------------- the board

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor and is covered whole, whatever the category filter would say about it.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // Everything else the snapshot records with no token, strongest by TVL first for a stable insertion.
  const extras = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isLaunchCandidate(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const p of extras) chosen.set(p.slug, p);

  const table = multipleTable(snapshot);
  const scored = [...chosen.values()].map((p) => ({ p, v: valueOf(p, snapshot.as_of, table) }));
  scored.sort((a, b) => b.v.implied - a.v.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  const watch = new Set(snapshot.watchlist);
  return scored.map(({ p, v }, i) => {
    const window = farmWindow(v.age, p.change_7d, p.tvl_usd);
    const farm = farmPlan(p, v.age);
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      age_days: v.age,
      implied_value_usd: v.implied,
      multiple: v.multiple,
      momentum: v.momentum,
      tenure: v.tenure,
      farm_window: window.score,
      window_label: window.label,
      on_watchlist: watch.has(p.slug),
      above_floor: p.tvl_usd >= snapshot.floor_usd,
      farm,
      farm_steps: farm.map(stepText),
    };
  });
}

/** The live-token protocols, by market cap: the market's own numbers, and where the multiple comes from. */
export function liveRows(snapshot: Snapshot, cap = 60): LiveRow[] {
  return snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => (b.mcap_usd as number) - (a.mcap_usd as number) || b.tvl_usd - a.tvl_usd)
    .slice(0, cap)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd as number,
      change_7d: p.change_7d,
      multiple: (p.mcap_usd as number) / p.tvl_usd,
    }));
}

/** Everything the page needs, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const table = multipleTable(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    // The page is read offline; its text keeps the provenance but no scheme, so no attribute can hold a URL.
    source: snapshot.source.replace(/^DefiLlama\s+https?:\/\//, 'DefiLlama '),
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    rules: RULES,
    multiples: table,
    counts: {
      protocols: snapshot.protocols.length,
      watchlist: snapshot.watchlist.length,
      board: board.length,
      below_floor: board.filter((r) => !r.above_floor).length,
      above_floor_off_list: board.filter((r) => r.above_floor && !r.on_watchlist).length,
      token_recorded: snapshot.protocols.filter((p) => !recordsNoToken(p)).length,
      with_mcap: table.live_count,
    },
    rows: board,
    live: liveRows(snapshot),
  };
  return { board, radar };
}

// ---------------------------------------------------------------- input and output

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not an object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');

  const protocols = o.protocols.map((value, i) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new SnapshotError(`protocol ${i} is not an object`);
    const p = value as Record<string, unknown>;
    if (typeof p.slug !== 'string' || p.slug === '' || /\s/.test(p.slug)) throw new SnapshotError(`protocol ${i} has no usable slug`);
    if (typeof p.name !== 'string' || p.name === '') throw new SnapshotError(`protocol ${p.slug} has no name`);
    if (typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd) || p.tvl_usd < 0) throw new SnapshotError(`protocol ${p.slug} has no TVL`);
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  const slugs = new Set(protocols.map((p) => p.slug));
  if (slugs.size !== protocols.length) throw new SnapshotError('snapshot.json repeats a slug');
  // The watchlist is kept exactly as the snapshot states it: if a slug it names is missing from
  // protocols, boardIssue says so and the program refuses to write, rather than quietly dropping it.
  return { as_of: o.as_of, source: typeof o.source === 'string' ? o.source : 'sealed snapshot', floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null. The gate's own seven rows, checked before writing. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const seen = new Set<string>();
  for (const r of board) {
    if (seen.has(r.slug)) return `${r.slug} appears twice`;
    seen.add(r.slug);
    if (!Number.isSafeInteger(r.rank) || r.rank < 1) return `${r.slug} has rank ${r.rank}`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  const missing = snapshot.watchlist.filter((slug) => !seen.has(slug));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `rank ${i + 1} is worth more than rank ${i}`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'every row shares one implied value';
  return null;
}

/** board.json's bytes: rows, the model that made them, and the snapshot they were read from. */
export function boardDocument(board: BoardRow[], radar: RadarData): string {
  // The page's copy carries the structured plan; board.json keeps the gate's strings and drops the
  // duplicate so the file stays about the size of the rows it ranks.
  const rows = board.map(({ farm, ...row }) => row);
  return `${JSON.stringify({
    schema: 'makefun/board/v1',
    model: MODEL_VERSION,
    as_of: radar.as_of,
    floor_usd: radar.floor_usd,
    counts: radar.counts,
    rules: radar.rules,
    multiples: { global: radar.multiples.global, live_count: radar.multiples.live_count, by_category: radar.multiples.by_category },
    rows,
  })}\n`;
}

/** data.js: the page's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
