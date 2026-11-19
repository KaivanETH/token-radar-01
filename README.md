# RADAR — the token launch radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/KaivanETH/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/KaivanETH/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

**Entry for the [`token-radar-01`](https://make.fun/bounty/token-radar-01) bounty on [make.fun](https://make.fun)** — `token-radar-01` · ranked pre-token protocols, an implied value built from the
snapshot's own figures, and a farm plan with a price and a clock for every row.

![Node](https://img.shields.io/badge/Node-22.18%2B-3c873a)
![License](https://img.shields.io/badge/license-MIT-0f7a5a)
![Gate](https://img.shields.io/badge/gate-7%2F7-brightgreen)

A protocol's launch is the token it may issue one day. RADAR reads a sealed snapshot of 758 protocols,
keeps the ones whose record carries no token, and ranks them by **what the token would be worth if the
record held as it is** — then tells you what to do about each one, before and after it issues.

It does not predict whether or when a token is issued. The watchlist is the house's floor; the board
carries all 40 of its rows and adds every smaller launch candidate the snapshot holds.

## The model

```
implied = TVL × multiple × momentum × tenure
```

| Term | Rule | Why |
| --- | --- | --- |
| `multiple` | The median market cap ÷ TVL of the protocols in this snapshot that record both (0.214× here), taken per category when it has at least three live protocols, shrunk toward the market's median by 12 pseudo-observations and held inside 0.7–1.5× of it | The market prices a launch at a multiple of its TVL; the snapshot already holds that multiple |
| `momentum` | `1 + clamp(Δ7d, −50, +100) ÷ 100 × 0.50` | TVL growth is the market's vote, but one week is noisy, so it counts at half weight |
| `tenure` | `0.78 + 0.30 × min(age, 1460) ÷ 1460` | A protocol tracked for years without a token has held TVL through cycles; a fresh listing has not |

No protocol name is special-cased, and no value is hardcoded: the multiple is measured on the run, from
the 128 protocols in the snapshot that carry a market cap. The page states the same formula and shows the
arithmetic for every row.

The board separates the protocols whose record carries a token from the ones still to come. The
**token already trades** tab lists 60 of the 128 with a market cap and their own mcap ÷ TVL — the column
the multiple is read from — so the claim can be checked on the page.

**Farm window** (0–100) is the second lens, and it never moves a rank: 45 % seven-day momentum, 35 %
youth, 20 % size. Rank says what the launch is worth; window says whether to start this month.

## The page

One static page, no framework and no network. It renders `data.js`, which the program writes beside it.

- **Board** — 192 rows, sortable by implied value, TVL, 7-day change, age, farm window or name, filterable
  by category, window band and free text, and split by stage (all candidates, watchlist, below the floor,
  token already trades).
- **Detail** — every protocol has one: the arithmetic with its three multipliers, the record (including the
  three fields that are null), the farm window and its inputs, what would move the value, and the farm plan.
- **Farm plan** — eight steps, split at the launch, each with its cost and its time. Capital, hold, cadence
  and the category's position come from the protocol's own TVL, age and category.

## Run it

Node 22.18 or later, standard library only, no network, no clock, no randomness.

```sh
node main.ts                                  # reads /input/snapshot.json, writes /output
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

It writes:

```
/output/board.json      192 rows: slug, name, rank, implied_value_usd, farm_steps, and the model's inputs
/output/data.js         the same rows plus the plans, read by the page
/output/dashboard/      index.html, app.css, app.js
/output/screenshots/    1-board.png, 2-detail.png, 3-filtered.png
/output/dossier.json    buildDossier('/output', {text_max_bytes: 65536}), byte for byte
```

Two runs over the same snapshot write the same bytes. The dossier is written last, after the page and the
screenshots are copied, because the scorer rebuilds it from `/output` and compares.

## Check it

`tools/gatecheck.mjs` is this entry's own stand-in for the sealed scorer's seven rows: the dashboard's
files and its no-network rule, the board's shape, the rank order, the watchlist coverage, the farm steps,
the screenshots' dimensions and size, and the dossier's bytes.

```sh
node tools/gatecheck.mjs          # 7/7 rows pass
python3 tools/shots.py            # re-render the three screenshots from /output
```

`tools/shots.py` is how the screenshots were made: Chromium at 1400 × 1400 through Playwright, each PNG
re-encoded losslessly into the 300–350 KB band the dossier wants.

## Layout

```
main.ts                  the program: read, score, write, copy, dossier
lib/model.ts             the multiple, the value, the window, the farm plan, the board
dashboard/               index.html · app.css · app.js
screenshots/             the board, a detail view, a filtered view
tools/gatecheck.mjs      the seven rows, locally
tools/shots.py           the three screenshots, from the page
vendor/makefun-board.ts  make.fun's dossier library, the kit's copy, unchanged
LICENSE                  MIT
```

The snapshot records no token for the protocols on the board. That is the record, not proof they have
none. An implied value is this radar's own claim, not advice.
