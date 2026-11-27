# proof-canvas scale benchmark

Measurements of one renderer across 3 / 12 / 20 / 50 / 100-rule boards plus an embed-mode board.
Reproduce with `node scripts/bench_scale.mjs` (writes `out/bench/results.md`, `results.json`,
`browser.json` and screenshots). The tables below are copied from that output.

## Environment

| Item | Value |
|---|---|
| Machine | Apple M3, macOS (darwin-arm64) |
| Node | v24.22.1 |
| Browser | Headless Chromium 159.0.8154.6 via Playwright 1.65.2 (`uv run --with playwright==1.65.2`) |
| Viewports | 1280x800 and 1440x900; the embed tier at 900x700 |
| Node timings | median of 7 runs per tier |
| Interaction timings | median of 5 runs per interaction and viewport |

## Tiers

| Tier | Board | What it represents |
|---|---|---|
| tier1_3rules | `examples/01_room_booking.board.json` | Small board, compact layout |
| tier1b_escrow | `examples/02_escrow_payout.board.json` with `provenance` and `provenanceNote` removed | 3 modules x 12 rules; exercises the failed badge (`1 failed · 9/12 verified`) |
| tier2_20rules | `examples/03_multi_module_20rules.board.json` | 4 modules x 20 rules, hand-written |
| tier3_50rules | `synth_board.mjs --rules 50 --modules 10 --failed 2 --unverified 8 --seed 50` | Synthetic stress board |
| tier4_100rules | `synth_board.mjs --rules 100 --modules 20 --failed 5 --unverified 20 --seed 100` | Synthetic stress board |
| embed_20rules | example 03 rendered with `--mode embed` | Embedded in a 900x700 frame |

Every board is illustrative: the examples declare `provenance: "sample"` and the synthetic boards
are generated from a seeded PRNG (same bytes on every run). No checker output is involved; the
benchmark measures the renderer, not a verification.

## Method

- **Node:** render with `renderBoardHtml` (payload `auto`), validate with every gate, render
  again and compare bytes (determinism).
- **Browser load:** open the file over `file://`, wait for `window.__proofCanvas.readyAt`, read
  navigation timing and CDP `Performance.getMetrics`, count DOM nodes, console errors, page
  errors and network requests.
- **Layout sweep:** for every rule in every state (normal, bug, fixed) the page is switched to
  that view and probed. The table reports the worst value of:
  - *Min SVG text*: the smallest `font-size` in the figure, in SVG units (the figure is 740 units
    wide), with the on-screen pixel size in parentheses. The renderer never fits text below
    13 units; the benchmark fails if it does.
  - *SVG text overflow*: how far any box label, chip or arrow label leaves its box or pill
    (`getBBox`, SVG units).
  - *Connector overlap*: how far the connector pill between the figure and the preview overlaps
    either card (px).
  - *Clipped labels*: bar labels and values, connector pills and state buttons whose content is
    wider than the element.
  - *Page overflow*: horizontal scroll of the document or the floating toolbar (px).
- **Interactions:** each runs in the page: `t0` -> click -> forced layout
  (`document.body.offsetHeight`) = **sync**; then the next `requestAnimationFrame` + task =
  **frame**. After each run the inverse action restores the state, so every repetition measures
  the same transition.

## Results: size and Node

| Tier | Rules / modules | Layout | Mode | Badge | HTML (budget) | Payload | bytes/rule | Render ms | Validate ms | Deterministic | Validator |
|---|---|---|---|---|---|---|---|---|---|---|---|
| tier1_3rules | 3 / 0 | compact | standalone | sample | 73.9 KB (128 KB) | JSON | 3293 | 2.29 | 3.18 | yes | PASS |
| tier1b_escrow | 12 / 3 | index | standalone | failed | 113.1 KB (200 KB) | JSON | 3027 | 1.79 | 2.44 | yes | PASS |
| tier2_20rules | 20 / 4 | index | standalone | sample | 139.2 KB (200 KB) | JSON | 3101 | 2.33 | 3.26 | yes | PASS |
| tier3_50rules | 50 / 10 | index | standalone | sample | 246.2 KB (350 KB) | JSON | 3370 | 4.12 | 7.41 | yes | PASS |
| tier4_100rules | 100 / 20 | index | standalone | sample | 119.5 KB (512 KB) | gzip+base64 | 3380 | 19.63 | 23.42 | yes | PASS |
| embed_20rules | 20 / 4 | index | embed | sample | 139.1 KB (200 KB) | JSON | 3101 | 3.28 | 5.46 | yes | PASS |

`bytes/rule` is the raw JSON size of the rules divided by their count. Every tier passes the
validator with zero warnings.

## Results: browser

| Tier | Viewport | DOMContentLoaded ms | App ready ms | DOM nodes | JS heap MB | Views swept | Min SVG text units (px) | SVG text overflow | Connector overlap px | Clipped labels | Page overflow px | Toolbar rows | Index open at load | Errors (console / page) | External requests | CJK chars |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tier1_3rules | 1280x800 | 39 | 38.8 | 200 | 2.02 | 9 | 13.9 (13.9) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier1_3rules | 1440x900 | 30.8 | 30.5 | 200 | 2.02 | 9 | 13.9 (13.9) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier1b_escrow | 1280x800 | 31.6 | 31.5 | 297 | 2.03 | 36 | 13.1 (9.9) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier1b_escrow | 1440x900 | 35.9 | 35.7 | 297 | 2.03 | 36 | 13.1 (11.4) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier2_20rules | 1280x800 | 32.7 | 32.6 | 348 | 2.15 | 60 | 13.2 (10) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier2_20rules | 1440x900 | 38 | 37.6 | 348 | 2.15 | 60 | 13.2 (11.5) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier3_50rules | 1280x800 | 35.9 | 35.7 | 526 | 2.27 | 150 | 13 (9.8) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier3_50rules | 1440x900 | 40.5 | 40.3 | 526 | 2.27 | 150 | 13 (11.3) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier4_100rules | 1280x800 | 8.8 | 40.4 | 825 | 2.38 | 300 | 13 (9.8) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| tier4_100rules | 1440x900 | 11.5 | 37.2 | 825 | 2.37 | 300 | 13 (11.3) | 0 | 0 | 0 | 0 | 1 | true | 0 / 0 | 0 | 0 |
| embed_20rules | 900x700 | 35.7 | 35.6 | 341 | 2.14 | 60 | 13.2 (13.2) | 0 | 0 | 0 | 0 | 1 | false | 0 / 0 | 0 | 0 |

"Index open at load" is `true` for the compact tier because the flag is simply unused there.

## Results: behavior checks

Pages built only for these checks (`out/bench/check_*.html`).

| Behavior check | Viewport | Result | Detail |
|---|---|---|---|
| corrupted payload shows the error box | 1280x800 | PASS | This board could not be displayed: the board payload is not standard base64. |
| standalone below 1100 px starts with the index closed | 1024x768 | PASS | indexOpen at load = False |

## Results: interaction latency (ms, sync median; frame in parentheses)

| Tier | Viewport | switch rule | toggle normal/bug/fixed | toggle Evidence | toggle Overview | filter failed only |
|---|---|---|---|---|---|---|
| tier1_3rules | 1280x800 | 1.6 (frame 12.8) | 1.8 (frame 11.1) | 2.1 (frame 14.1) | 2.6 (frame 9.7) | n/a |
| tier1_3rules | 1440x900 | 1.6 (frame 15.3) | 1.5 (frame 9.5) | 1.5 (frame 14.6) | 2.3 (frame 15.3) | n/a |
| tier1b_escrow | 1280x800 | 1.9 (frame 15.3) | 1.7 (frame 12.1) | 1.7 (frame 13.7) | 1.3 (frame 13.4) | 1.8 (frame 14.3) |
| tier1b_escrow | 1440x900 | 2.1 (frame 11.8) | 1.8 (frame 12.3) | 1.9 (frame 12.2) | 1.6 (frame 13.3) | 1.8 (frame 12.2) |
| tier2_20rules | 1280x800 | 2 (frame 13.4) | 2.1 (frame 8.1) | 2.2 (frame 8.7) | 1.7 (frame 12.1) | 1.8 (frame 5.9) |
| tier2_20rules | 1440x900 | 2.1 (frame 8.7) | 2.1 (frame 12.3) | 2.3 (frame 13.9) | 1.9 (frame 11.1) | 1.8 (frame 13.5) |
| tier3_50rules | 1280x800 | 2.8 (frame 16.3) | 2.8 (frame 8.5) | 3 (frame 8.6) | 3.1 (frame 15.4) | 1.9 (frame 8.3) |
| tier3_50rules | 1440x900 | 3.6 (frame 12.6) | 3.2 (frame 13.3) | 4.2 (frame 10.3) | 5.1 (frame 12.3) | 2.4 (frame 10.6) |
| tier4_100rules | 1280x800 | 6.7 (frame 13.8) | 4.2 (frame 12.8) | 5.6 (frame 11.2) | 7.7 (frame 14.5) | 3.1 (frame 14.1) |
| tier4_100rules | 1440x900 | 4.1 (frame 13.9) | 3.7 (frame 13.8) | 3.9 (frame 11.3) | 6.3 (frame 15.1) | 2.3 (frame 14.5) |
| embed_20rules | 900x700 | 1.4 (frame 14.3) | 1.4 (frame 14.4) | 1.5 (frame 13.9) | 1.3 (frame 13.2) | 1.3 (frame 14.7) |

## Screenshots

| File | Viewport | Shows |
|---|---|---|
| `out/bench/tier1_3rules.png` | 1440x900 | Compact layout, floating pill bar |
| `out/bench/tier1b_escrow_failed_rule.png` | 1440x900 | Failed badge; the failed rule in its bug state with the evidence panel open |
| `out/bench/tier2_20rules_overview.png` | 1440x900 | Module overview |
| `out/bench/tier2_20rules_detail.png` | 1440x900 | One rule in focus; a two-line box label ("Return HTTP 409 Conflict") |
| `out/bench/tier2_20rules_detail_evidence.png` | 1440x900 | A failed rule with the evidence panel open |
| `out/bench/tier3_50rules_filtered.png` | 1440x900 | Status filter = Failed |
| `out/bench/tier4_100rules_overview.png` | 1440x900 | 20-module overview |
| `out/bench/tier4_100rules_failed_overview.png` | 1440x900 | Overview filtered to failed rules |
| `out/bench/embed_20rules_900.png` | 900x700 | Embed mode: one-row toolbar, index closed, stacked cards |

## Flow map boards (examples 05 and 06)

The tiers above have no `flow`. Examples 05 and 06 do, and open on their flow map. Measured on
the same machine with the commands in `README.md`, bound to the example 05 specs and logs
(`--spec` / `--log`).

| Board | Standalone | Embed | Budget |
|---|---|---|---|
| 05 multi-verifier (6 rules, 3 stages, 3 journeys, 3 `outOfScope` entries) | 127,458 B (124.5 KB) | 127,370 B (124.4 KB) | 128 KB |
| 06 Japanese (3 rules, 3 stages, 3 journeys, 3 `outOfScope` entries, `"lang": "ja"`) | 109,644 B (107.1 KB) | 109,556 B (107.0 KB) | 128 KB |

- **Cost.** The flow code and CSS are written only into boards that have `flow`, and the
  out-of-scope note only into boards that have `outOfScope`. Against the previous release
  (commit `d65cade`), compact boards without `flow` (00, 01) grow by 422 B (per-language UI
  text) and index boards (02, 03) shrink by 4,097 B, because the rule search and the module
  select were removed; example 05 grows by 18,038 B (17.6 KB) with its flow map and note.
- **Click sweep.** `scripts/sweep_figures.py flow` over examples 00-06, standalone and embed, at
  1440x900 and 900x700: 320 real clicks (every journey, every checkpoint button, every stage
  rule chip, the way back to Flow, each status filter on the map of the index layout followed by
  a matching chip, closing and reopening the out-of-scope note across a re-render, and on 02 and
  03 every module card of the overview, unfiltered and under the Failed filter), 0 failures:
  no stage or label overlap, no text outside a stage, no page overflow, no search box or select,
  the out-of-scope note under the main view with exactly the JSON entries and no overflow, no
  console errors. Because every example 05 rule is verified, a copy with one failed and one
  unchecked rule (not shipped) was swept too: 180 clicks, 0 failures; five deliberately broken
  copies (no dimming of chips, no dimming of stages, filter always cleared, note state lost,
  module card opening the first rule of the whole board) were each caught. The figure sweep (`sweep`) over the 14 example files: 564 views, 0 failures.

## Analysis

### What scales well

- **Load.** Every page is interactive in under 45 ms in this run (slowest: tier3 at 1440x900,
  40.3 ms). The very first page a browser process opens can be much slower; earlier runs
  measured 189-253 ms for that cold start. Plain-JSON boards are ready when DOMContentLoaded
  fires; the gzip board adds about 26-32 ms for `DecompressionStream` and `JSON.parse` (tier4:
  DOMContentLoaded 8.8-11.5 ms, App ready 37.2-40.4 ms).
- **DOM and memory.** Nodes grow roughly linearly with rules (200 -> 825) and the heap stays at
  2.0-2.4 MB.
- **Layout.** Across 1,170 swept views (every rule in every state, every viewport) no figure
  text leaves its box, no connector pill touches a card, no label is clipped, the page never
  scrolls sideways and the toolbar stays on one row, including at 900x700 in embed mode.
- **Latency.** The worst sync median is 7.7 ms (Overview at 100 rules, 1280x800). "frame"
  values (about 6-16 ms) are dominated by waiting for the next animation frame, not by work.

### Bottlenecks

1. **Payload dominates file size beyond about 15 rules.** At tier4 the HTML is 37.1 KB payload
   (gzip + base64), 38.3 KB JS, 31.5 KB CSS and 6.5 KB `<noscript>` text; the compact layout
   ships 32.8 KB JS and 24.5 KB CSS. The same 100-rule board as plain JSON is 416.8 KB, under
   the 512 KB limit; 200 rules (`--seed 200`) are 750.9 KB as plain JSON and 178.6 KB with gzip,
   which is why `auto` switches to gzip above 192 KB (covered by a self-test).
2. **Full re-render of the index.** The index is rebuilt with `innerHTML` on every state
   change, so its cost is linear in rule count: switch rule and Overview go from about 2 ms at
   20 rules to 4-8 ms at 100. That is fine up to a few hundred rules; above about 1,000 rules
   the index would need virtualization or keyed updates. This is an extrapolation: 1,000+ rules
   were not measured.
3. **Node render time is gzip.** tier4 renders in 19.6 ms (9-38 ms across runs) against
   1.8-4.1 ms for the JSON tiers; most of the difference is `gzipSync` at level 9.
4. **Small text at 1280 wide.** With the rule index open at 1280x800, the focus figure is drawn
   at about 75% scale, so its smallest text (13 units) is 9.8-10 px on screen. At 1440x900 it
   is 11.3 px or more. A layout that keeps the figure larger at 1280 was not attempted.

### Hand-written vs synthetic density

Synthetic rules are about the same size as hand-written ones but repeat much more, so they
compress far better:

| | bytes/rule | gzip ratio (compressed / raw) |
|---|---|---|
| Hand-written (example 03, 20 rules) | 3101 | 0.178 |
| Synthetic (tier4, 100 rules) | 3380 | 0.083 |

Projection for 100 rules at hand-written density: about 310 KB raw JSON -> about 55 KB gzip ->
about 74 KB base64, plus about 82 KB of shell (JS, CSS, `<noscript>` and markup) = about
**156 KB**, well below 512 KB. This is a projection, not a measurement.

## Caveats

- One machine, one browser build. Timings at this scale are noisy between runs (see the tier1
  cold start and the tier4 render time above); read them as orders of magnitude. Sizes, DOM counts, layout numbers, errors and determinism are stable.
- The self-tests and the renderer also pass on Node 22.23.4, and the HTML it renders is
  byte-identical to Node 24's; the tables above are from Node 24.
- Interaction timings come from synthetic events dispatched in the page, not from real input
  devices; they measure handler + layout, not paint or input latency.
- Text widths in the figure come from a per-character estimate shared by the renderer and the
  validator, not from the browser's font. In this Chromium on macOS the real width was at most
  1.05x the estimate (median 0.91-0.93x) across all labels of tiers 1b, 2 and 3; other fonts can differ,
  which is why the sweep measures real `getBBox` boxes.
