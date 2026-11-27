---
name: proof-canvas
description: Render formal-verification or property-based testing results as one offline HTML spec review board with rule diagrams, counterexamples, mutant kills, and verified spec/log evidence. Use for TLA+/TLC, Quint, Alloy, Apalache, Lean, Dafny, PropEr, fast-check, or Hypothesis outputs, or Japanese requests like 形式検証の可視化・仕様マップ. Not for general architecture diagrams, UI wireframes, or running checkers itself.
---

# proof-canvas

Visualize formal-verification results for people who do not read TLA+, Quint, Alloy or Lean.

Describe the checked rules in a board JSON file. proof-canvas renders one deterministic offline
HTML file under 512 KB. The validator checks its structure, offline use, embed safety, and
provenance.

Run your checker separately. Supply spec files and checker logs to compare their definitions,
hashes, and verdicts with the board JSON.

Use Node 22 or later. Set `SKILL_DIR` to the absolute directory containing this `SKILL.md`.
The installed plugin keeps its scripts in `../../scripts/` relative to that directory.
Resolve the plugin root before running commands from your project directory.

```bash
SKILL_DIR=/absolute/path/to/skills/proof-canvas
PLUGIN_ROOT="$(cd -P "$SKILL_DIR" && cd ../.. && pwd)"
```

The examples below live in `$PLUGIN_ROOT/examples/`.

## 1. Write the board JSON

Start from an example:

| Example | Rules | Modules | Shows |
|---|---|---|---|
| `examples/00_minimal.board.json` | 1 | none | The smallest valid board (reproduced below) |
| `examples/01_room_booking.board.json` | 3 | none | Compact layout: pill bar and overview |
| `examples/02_escrow_payout.board.json` | 12 | 3 | Index layout, TLA+ / TLC style: 9 verified, 1 failed with a counterexample, 2 not checked |
| `examples/03_multi_module_20rules.board.json` | 20 | 4 | Index layout with the status filter and the module overview |
| `examples/04_refund_guard/` | 2 | none | Spec and real log from Quint 0.32.0 |
| `examples/05_multi_verifier/` | 6 | 3 | Native Quint 0.32.0, Alloy 6.2.0, and TLC 2.19 verdicts on one board; `gate`, `relation` and `sequence` figures; a three-stage flow map that opens first |
| `examples/06_japanese_board/` | 3 | none | The 05 specs and logs with `"lang": "ja"`: Japanese board copy and UI, one rule per figure kind, a flow map built from `ruleIds` |
| `examples/07_state_timeline/` | 3 | none | `state` and `timeline` figures, `run.bounds`, and three real mutant logs bound with `--mutant-log` |

Examples 00 through 03 are illustrative and declare `"provenance": "sample"`: their statuses and
counterexamples were written by hand, and no checker was run.

The minimal board (`examples/00_minimal.board.json`, verbatim):

```json
{
  "version": 1,
  "runId": "minimal-sample",
  "title": "Minimal board: one rule",
  "subtitle": "The smallest valid board",
  "generatedAt": "2026-11-27T00:00:00Z",
  "provenance": "sample",
  "run": { "tool": "Example checker", "status": "verified" },
  "rules": [
    {
      "id": "stock_never_negative",
      "no": 1,
      "short": "Stock never negative",
      "title": "An order never takes stock below zero",
      "property": "StockNonNegative",
      "source": "Inventory spec 1.1",
      "previewTitle": "Checkout",
      "status": "verified",
      "figure": {
        "boxes": { "src1": "Order", "src2": "Stock level", "gate": "Stock check", "pass": "Place order", "hold": "Show sold out", "bad": "Negative stock" },
        "arrows": { "a1": "quantity", "a2": "in stock", "a3": "enough", "a4": "too few", "a5": "not checked" }
      },
      "states": {
        "normal": {
          "label": "Normal", "tone": "normal", "route": ["a1", "a2", "a3"], "here": "pass", "edgeShort": "Placed",
          "chips": [{ "box": "gate", "text": "2 <= 5", "tone": "good" }],
          "takeaway": "Two items are ordered and five are in stock, so the order is placed.",
          "preview": { "statusBadge": "Placed", "rows": [{ "k": "Ordered", "v": "2" }, { "k": "In stock", "v": "5", "tone": "ok" }], "alert": "Order placed.", "buttonLabel": "Place order", "buttonKind": "ok" }
        },
        "bug": {
          "label": "Bug", "tone": "bug", "route": ["a1", "a5"], "here": "bad", "edgeShort": "Oversold",
          "chips": [{ "box": "bad", "text": "stock -1", "tone": "bad" }],
          "takeaway": "Without the check, six items are sold from a stock of five.",
          "preview": { "statusBadge": "Violation", "rows": [{ "k": "Ordered", "v": "6" }, { "k": "In stock", "v": "-1", "tone": "bad" }], "alert": "One customer is promised an item that does not exist.", "buttonLabel": "Place order", "buttonKind": "danger" }
        },
        "fixed": {
          "label": "Fixed", "tone": "safe", "route": ["a1", "a2", "a4"], "here": "hold", "edgeShort": "Sold out",
          "chips": [{ "box": "gate", "text": "6 > 5", "tone": "good" }],
          "takeaway": "The stock check stops the order and shows how many are left.",
          "preview": { "statusBadge": "Blocked", "rows": [{ "k": "Ordered", "v": "6" }, { "k": "In stock", "v": "5", "tone": "warn" }], "alert": "Only 5 left. Lower the quantity.", "buttonLabel": "Place order", "buttonKind": "locked" }
        }
      },
      "defaultFocus": "fixed",
      "evidence": {
        "ruleSummary": "Stock on hand is never below zero after any order.",
        "ifEnforced": "Orders larger than the stock are refused.",
        "ifNotEnforced": "Customers buy items that do not exist.",
        "checkerSummary": "Sample: no violation",
        "scope": "1 product, stock 0-5, orders of 1-6",
        "method": "Illustrative sample; no checker was run"
      }
    }
  ]
}
```

### Schema (version 1)

Every field not marked optional is required, strings must be non-empty, unknown keys produce a
validator warning (catching typos such as `counterExample`), and top-level `__*` keys are reserved
for the renderer. Put the full `normal` / `bug` / `fixed` comparison inside one rule (never split
"with rule" and "without rule" into separate rules). Full field-by-field definitions, types, and
fit rules live in [`references/schema.md`](references/schema.md):

| Section | Covers | Reference |
|---|---|---|
| Board | `version: 1`, `runId`, `title`, `subtitle`, `generatedAt`, `provenance?`, `provenanceNote?`, `lang?` (`en\|ja`), `labels?`, `defaultView?`, `modules?`, `outOfScope?` (1..12 `{ area, reason }`) | [`references/schema.md#board`](references/schema.md#board) |
| `run` | `tool`, `toolVersion?`, `specHash?`, `status`, and optional `bounds` (whole-run search bounds shown above every view) | [`references/schema.md#run`](references/schema.md#run) |
| `rules[]` | `id`, `no`, `moduleId?`, `short`, `title`, `property`, `category?`, `source`, `previewTitle`, `status?`, `stepsChecked?`, `defaultFocus` | [`references/schema.md#rules`](references/schema.md#rules) |
| `figure` | Five kinds: `gate` (default), `sequence`, `relation`, `state`, and `timeline` | [`references/schema.md#figure`](references/schema.md#figure) |
| `states` | `normal`, `bug`, `fixed`: shared `label`, `tone`, `edgeShort`, `takeaway`, `preview`, plus per-kind active elements and `chips` | [`references/schema.md#states`](references/schema.md#states) |
| `evidence` | `ruleSummary`, `ifEnforced`, `ifNotEnforced`, `checkerSummary`, `scope`, `method`, `witness?`, `sourceQuote?`, `counterexample?` | [`references/schema.md#evidence`](references/schema.md#evidence) |
| `flow` | Optional system flow map: `title?`, `note?`, 2..6 `steps`, 1..9 `edges` (`normal\|bypass\|handoff`), 1..5 `journeys` with optional checkpoint CTA | [`references/schema.md#flow`](references/schema.md#flow) |

## 2. Render

```bash
node "$PLUGIN_ROOT/scripts/render_board.mjs" --in board.json --out board.html
#   [--mode standalone|embed] [--title "..."] [--payload auto|json|gzip]
```

- **Layout is automatic.** Up to 6 rules without modules (or with one module) get the *compact*
  layout: a floating pill bar (`1. ... | 2. ... | Overview`). Anything larger gets the *index*
  layout: a rule index grouped by module, a status filter (All / Failed / Verified / Not checked,
  with counts; on the flow map it highlights matching rule chips) and a module overview with
  rule chips colored by status.
  A board with `flow` replaces the index toolbar's Overview button with **Flow** and puts a
  **Flow** pill first in the compact bar.
- **Proof & log.** Repeat `--spec <path>` and `--log <path>` to bind files, and
  `--mutant-log <ruleId>=<path>` to bind a killed mutant's trace to a rule. See section 5.
- **Payload.** `auto` embeds readable JSON up to 192 KB and gzip + base64 above that, decoded
  by the browser's built-in `DecompressionStream`. The decoded board may not exceed 4 MiB.
- **Embedding.** `--mode embed` drops page-level CSS (`html`, `body`) so the board can sit inside
  an `<iframe>` or a host page; keyboard shortcuts then only apply while focus is inside the
  board, and the rule index starts closed. For an iframe, set its height yourself (the board
  never uses `100vh`). All CSS is scoped to `.pc-root`.
- **Warnings.** The renderer prints validator warnings (long labels, text that cannot fit, unknown
  keys) to stderr and still renders; errors stop it with a non-zero exit code.
- **Keys.** `o` the flow map (index layout with `flow`) or the overview, `e` proof & log; compact: `1`-`9` jump to a rule; index:
  `j` / `k` next / previous rule.

## 3. Validate (required)

```bash
node "$PLUGIN_ROOT/scripts/validate_board.mjs" --in board.json board.html   # exit 0 = pass
```

Each gate reports a distinct error prefix.

1. `size:` strictly < 512 KB; warns above the per-scale budget (up to 6 rules 128 KB, 20 rules
   200 KB, 50 rules 350 KB, more 512 KB).
2. `html:` / `data:` / `board.` structure and schema: exactly one root and one payload element,
   strict base64, decoded size limits, and the full board schema in [`references/schema.md`](references/schema.md).
3. `offline:` no external script, stylesheet, `@import`, `url()`, media, `srcset`, `xlink:href`,
   `<base>`, meta refresh, or network API (`fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
   `sendBeacon`, `import()`, workers). Board text is data and is never scanned as markup.
4. `svg-markers:` static SVG arrow markers present and ids unique.
5. `embed-safety:` no `100vh`-style heights, no `:root` override of host design tokens, no
   `html` / `body` styling in embed mode.
6. `provenance:` the badge, footer, and cached value agree with the embedded board and evidence.
7. `sync:` with `--in`, the HTML must embed exactly that JSON (a `--title` override is stored
   separately and does not count as a difference).
8. `binding:` with `--spec` or `--log`, recompute evidence from the files and compare it with
   the embedded binding. Use the same set of files you passed to the renderer. Validating
   a bound HTML file without the source files or logs warns that the evidence was not re-checked.
   With `--mutant-log`, re-extract each trace and compare file, SHA-256, property and steps.

Regenerate older HTML boards to add the evidence metadata required by this validator.

`node "$PLUGIN_ROOT/scripts/test_validator.mjs"` runs the self-tests.

## 4. Look at it

Open the HTML in a browser and check: no console errors, no horizontal scroll, the state buttons
move the figure, the connector and the preview together, and Failed filters to the broken rules.

In a development checkout with `uv`, `scripts/sweep_figures.py sweep <board.html>` shows every
rule in every state, and **Proof & log** on the bug state, in headless Chromium; `flow` real-clicks
the flow map; `mobile` taps through both on 390 and 375px phones. They fail on overlaps, text outside its box, clipped text, page overflow, or
console errors; `sweep` also on a trace that disagrees with the binding.

No gate checks that the drawing says what the spec and trace say: run the
[semantic fidelity check](references/evidence.md#semantic-fidelity-check) before locking.

## 5. Honesty rules

Use checker results for rule verdicts, step counts, and counterexamples. Describe the
scope and method in the evidence. Use `pending` for rules that still need a verdict
and `sample` for illustrative boards.

A board declared as `sample` always shows **Sample data**. A failed run or rule shows
a failure badge. A board with verified and pending rules shows **Partially verified**.
A board with no verified rules shows **Not checked yet**. Declaring `mixed` or
`unverified` limits the badge.

A board declared as `verified` needs a verified run, a spec hash, and verified rules.
The badge also depends on which files you supply.

| Files supplied | Badge when every rule is verified |
|---|---|
| Spec and log | **Spec & log verified** in green |
| Spec only | **Spec checked · self-reported log** in amber |
| Log only | **Log checked · self-reported spec** in amber |
| Neither | **Self-reported** in amber |

### Spec files and checker logs

Repeat `--spec` for Quint, TLA+ (with any TLC `.cfg`), Alloy, Lean and Dafny sources; each
rule's `property` must match exactly one declaration.
Repeat `--log` for native Quint, Alloy 6, TLC and Apalache logs or `proof-canvas-log-1` JSON
receipts. Every file needs a recognized verdict, and only named passes can substantiate a
verified rule (a `quint run` simulation cannot). Hashes, per-checker rules and the receipt
format: [`references/evidence.md`](references/evidence.md).

### Mutant logs

`--mutant-log <ruleId>=<path>` binds the log of a mutant run (the rule switched off) to one
rule. The log must report a violation, and a named violated property must equal the rule's
`property`. **Proof & log** pairs
your bug drawing with the file name, SHA-256 and up to 12 steps extracted from the one failing
run. A property-matched kill shows **Trace-bound mutant kill**; a Quint ITF trace, which names no
property, **Trace attached (property unnamed)**; no log, **Illustrative only (no trace bound)**.
Formats and refusals: [`references/evidence.md`](references/evidence.md#mutant-logs).

## 6. Scale benchmark

`node "$PLUGIN_ROOT/scripts/bench_scale.mjs"` (add `--no-browser` without `uv`) renders and measures
3 to 100-rule boards; results and stress-board commands are in [`BENCHMARK.md`](../../BENCHMARK.md).
