# proof-canvas

**Visualize formal-verification results for people who do not read TLA+, Quint, Alloy or Lean.**

You (or your agent) describe the checked rules in one JSON file. `proof-canvas` turns it into
**one offline HTML file** that product owners, domain experts and reviewers can read without
knowing the spec language, and a validator proves the file is safe to share.

Each rule is drawn as the same 6-box flow (two inputs, the check, then pass / hold / reject) with
three switchable states: **normal**, **bug** (what happens without the rule) and **fixed**. A
linked screen preview shows what a user would see, and an evidence panel says what was checked,
how, and within which bounds.

## At a glance

All four screenshots below are rendered directly from the bundled examples in [`examples/`](examples/).

| Compact starter (3 rules, fixed state) | Failed rule with TLA+ counterexample & evidence (12 rules) |
|---|---|
| ![Compact 3-rule room booking board](docs/images/01-compact.png) | ![Failed escrow payout rule with counterexample and evidence](docs/images/02-failed-counterexample.png) |
| **Module overview with search & status filters (20 rules)** | **Embed mode (`--mode embed`, 900×700 iframe/pane)** |
| ![20-rule multi-module overview with search and filters](docs/images/03-overview-20rules.png) | ![Embed mode at 900x700 viewport](docs/images/04-embed-900.png) |

- **Zero dependencies.** Node 22 or later. No `npm install`, no CDN, no network at view time.
- **Deterministic.** The same board and evidence files render to the same bytes.
- **Evidence binding.** Supply spec files and checker logs to check rule names, file hashes,
  and reported verdicts. The badge and Evidence panel show which files were checked.
- **Visualization.** You run the checker. proof-canvas renders its results and can compare
  those results with the board JSON.
- **Scales from 1 to 100+ rules.** Up to 6 rules get a compact pill bar; larger apps get
  modules, a rule index, search, a status filter (All / Failed / Verified / Not checked) and a
  module overview.
- **Embeddable.** All CSS is scoped to the board, nothing uses `100vh`, SVG ids are unique, and
  `--mode embed` drops page-level styles, so a board can sit inside an `<iframe>` or a host page.

## Quickstart

```bash
node scripts/render_board.mjs   --in examples/02_escrow_payout.board.json --out board.html
node scripts/validate_board.mjs --in examples/02_escrow_payout.board.json board.html
open board.html   # or xdg-open / start
```

Write your own board by copying `examples/00_minimal.board.json` (one rule) and filling in your
checker's real results. The full schema, render options, validation gates and honesty rules are
in [the proof-canvas skill](skills/proof-canvas/SKILL.md).

| Example | Rules / modules | Shows |
|---|---|---|
| `examples/00_minimal.board.json` | 1 / none | The smallest valid board |
| `examples/01_room_booking.board.json` | 3 / none | Compact layout |
| `examples/02_escrow_payout.board.json` | 12 / 3 | TLA+ / TLC style: 9 verified, 1 failed with a counterexample, 2 not checked |
| `examples/03_multi_module_20rules.board.json` | 20 / 4 | Index layout, search, filters, module overview |
| `examples/04_refund_guard/` | 2 / none | Real spec and log from Quint 0.32.0 |
| `examples/05_multi_verifier/` | 6 / 3 | Native Quint 0.32.0, Alloy 6.2.0, and TLC 2.19 verdicts on one board |

Examples 00 through 03 are illustrative and declare `"provenance": "sample"`.

## Check a spec and checker log

Render and validate the [refund guard example](examples/04_refund_guard/) with its
Quint 0.32.0 spec. Its `refund_guard.quint.log` records the Quint command followed by
its verbatim output.

```bash
example=examples/04_refund_guard/refund_guard
node scripts/render_board.mjs --in "$example.board.json" --spec "$example.qnt" \
  --log "$example.quint.log" --out out/04_refund_guard.html
node scripts/validate_board.mjs --in "$example.board.json" --spec "$example.qnt" \
  --log "$example.quint.log" out/04_refund_guard.html
```

The board shows **Spec & log verified (2/2)**. Open **Evidence** for the exact source and
line range of each invariant. Repeat `--spec` and `--log` for additional files. Use the
same set of files on both commands to verify the embedded evidence against disk.

A board whose rules all pass uses the following labels.

| Evidence supplied | Badge |
|---|---|
| Spec and checker log | **Spec & log verified** |
| Spec only | **Spec checked · self-reported log** |
| Checker log only | **Log checked · self-reported spec** |
| Board JSON only | **Self-reported** |
| Any files with a board declared as sample | **Sample data** |

Use `--spec` for Quint, TLA+, Alloy, Lean, and Dafny sources. Include the TLC `.cfg`
with `--spec` to bind a passing TLC log to the properties the config lists.
Use `--log` for native Quint, Alloy 6, TLC, and Apalache logs or
[`proof-canvas-log-1` JSON receipts](skills/proof-canvas/SKILL.md#checker-logs). Every passing verdict
needs a named property. For Quint verification, include the command with its
invariant or temporal options.

### Combine native logs on one board

The [multi-verifier example](examples/05_multi_verifier/) uses captured checker
output with host paths and localized diagnostics removed. The solver verdicts
are verbatim.

```bash
example=examples/05_multi_verifier
flags=(
  --spec "$example/escrow_ledger.qnt"
  --spec "$example/delegation_rbac.als"
  --spec "$example/period_lock.tla"
  --spec "$example/period_lock.cfg"
  --log "$example/quint_escrow.log"
  --log "$example/alloy_rbac.log"
  --log "$example/tlc_pass.log"
)
node scripts/render_board.mjs --in "$example/multi_verifier.board.json" "${flags[@]}" \
  --out out/05_multi_verifier.html
node scripts/validate_board.mjs --in "$example/multi_verifier.board.json" "${flags[@]}" \
  out/05_multi_verifier.html
```

The board shows **Spec & log verified (6/6)**. Each **Evidence** card shows the
rule's checker, log hash, and source excerpt. The footer lists the three checkers
and the combined log hash.

## Install

**Claude Code**. Run these commands in Claude Code.

```text
/plugin marketplace add masayannuu/proof-canvas
/plugin install proof-canvas@proof-canvas
```

**Codex**. Run these commands in your terminal.

```bash
codex plugin marketplace add masayannuu/proof-canvas
codex plugin add proof-canvas
```

**Antigravity**. Run this command in your terminal.

```bash
agy plugin install https://github.com/masayannuu/proof-canvas
```

**Cursor**. In Customize, choose **Import from Disk** and select the repository root.
The repository includes a [Cursor plugin manifest](.cursor-plugin/plugin.json).

**Other agents and standalone use**. Point your agent at
[`skills/proof-canvas/SKILL.md`](skills/proof-canvas/SKILL.md) in a complete checkout,
or run the [quickstart commands](#quickstart) from the repository root.

After installing, ask your agent to "Render our TLC results as a proof-canvas board and validate it."

## Scale benchmark

Apple M3, Node 24, headless Chromium 159. Full method, every viewport and the analysis are in
[`BENCHMARK.md`](BENCHMARK.md). Timings are medians from one run and vary by a few ms between runs.

| Rules / modules | Layout | HTML | Payload | Render | App ready | DOM nodes | Worst interaction (sync) | Layout defects in sweep | Errors |
|---|---|---|---|---|---|---|---|---|---|
| 3 / none | compact | 66.8 KB | JSON | 1.5 ms | 24 ms (253 ms cold start) | 170 | 2.7 ms | 0 | 0 |
| 12 / 3 | index | 111.4 KB | JSON | 2.0 ms | 35-44 ms | 288 | 2.1 ms | 0 | 0 |
| 20 / 4 | index | 137.5 KB | JSON | 1.9 ms | 33-34 ms | 339 | 3.7 ms | 0 | 0 |
| 50 / 10 | index | 244.5 KB | JSON | 4.4 ms | 29-32 ms | 530 | 4.5 ms | 0 | 0 |
| 100 / 20 | index | 117.8 KB | gzip | 38.0 ms | 33-35 ms | 852 | 5.3 ms | 0 | 0 |
| 20 / 4, embed at 900x700 | index | 137.4 KB | JSON | 2.9 ms | 41 ms | 332 | 3.2 ms | 0 | 0 |

"Layout defects in sweep" counts, over every rule in every state, figure text leaving its box,
connector pills overlapping a card, clipped labels and horizontal page overflow. "Cold start" is
the first page a fresh browser process opened; it was 35.7 ms in the previous run.

Run it yourself:

```bash
npm test                                   # or: node scripts/test_validator.mjs
node scripts/bench_scale.mjs --no-browser  # Node-only metrics
npm run bench                              # Node + headless Chromium (needs uv)
```

The browser stage is for development only: it runs `uv run --with playwright==1.65.2`. If
Chromium is not installed for Playwright yet, run
`uv run --with playwright==1.65.2 playwright install chromium` once. Rendering and validating
boards never need Python or Playwright.

## Layout

```
plugin.json           Antigravity and Agent Plugins manifest
.claude-plugin/
  icon.png            Claude Code plugin icon
  plugin.json         Claude Code plugin manifest
  marketplace.json    Claude Code marketplace
.codex-plugin/
  plugin.json         Codex plugin manifest
.agents/plugins/
  marketplace.json    Codex marketplace
.cursor-plugin/
  plugin.json         Cursor plugin manifest
skills/proof-canvas/
  SKILL.md            agent instructions, board schema, and commands
scripts/
  render_board.mjs    board JSON -> single-file HTML
  validate_board.mjs  gates: size, structure, offline, svg-markers, embed-safety, provenance, sync, binding
  evidence.mjs        spec hashes, source excerpts, and checker log verdicts
  schema.mjs          board schema, layout and provenance rules
  figure.mjs          figure geometry, text fitting and the SVG builder (shared with the browser)
  payload.mjs         JSON / gzip + base64 payload codec
  synth_board.mjs     deterministic synthetic boards for stress tests
  test_validator.mjs  self-tests
  bench_scale.mjs     scale benchmark driver
  bench_browser.py    headless Chromium metrics (development only)
examples/
  00-03               sample boards
  04_refund_guard/    Quint spec and log
  05_multi_verifier/  Quint, Alloy, and TLC specs and logs
```

## Acknowledgements

The fixed six-box flow layout, single-pill arrow labels, and state switching over a fixed figure
were inspired by the diagram design principles in
[`figure-docs`](https://github.com/u-ichi/agent-plugins) by u-ichi (MIT; no code or text from
`figure-docs` is copied into `proof-canvas`).

## License

MIT, see [`LICENSE`](LICENSE). The board embeds icon paths from Lucide (ISC; icons derived from
Feather are MIT); see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
