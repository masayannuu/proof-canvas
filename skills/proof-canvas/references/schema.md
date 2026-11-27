# Board schema (version 1)

Every field not marked optional is required. Strings must be non-empty. Unknown keys produce a
validator warning (typos such as `counterExample` are caught), and top-level keys starting with
`__` are reserved for the renderer.

For CLI commands, provenance badges, and honesty rules see [`../SKILL.md`](../SKILL.md). For
`--spec`, `--log`, and `--mutant-log` binding formats see [`evidence.md`](evidence.md).

## Board

| Field | Type | Notes |
|---|---|---|
| `version` | `1` | Schema version. |
| `runId` | string | Identifier of the run or data set, shown in the footer. |
| `title`, `subtitle` | string | Page header. |
| `generatedAt` | string | ISO 8601 timestamp. |
| `provenance` | optional `verified \| mixed \| sample \| unverified` | Declared provenance. Use `sample` for illustrative data. See [`../SKILL.md` section 5](../SKILL.md#5-honesty-rules). |
| `provenanceNote` | optional string | Adds a board note after the computed footer note. |
| `lang` | optional `en \| ja` | Language of the renderer's UI text and `<html lang>`; default `en`. Only that language ships. |
| `labels` | optional object | `{ moduleSingular?, modulePlural?, overview? }` rename "module(s)" (e.g. `stage` / `stages`) and the hub button (default `Flow` with a flow map, else `Overview`). Warns above 24 characters. |
| `defaultView` | optional `rule \| flow` | The first screen; default `rule`. `flow` requires `flow`. |
| `flow` | optional object | A system flow map across modules (see [`flow`](#flow) below). |
| `outOfScope` | optional array, 1..12 | `{ area, reason }`: what the models leave out; shown under the main view. |
| `run` | object | The checker run (below). |
| `modules` | optional array | `{ id, title, summary? }`. When present, every rule needs a `moduleId`. |
| `rules` | array, 1..N | One entry per checked rule (below). |

## `run`

| Field | Type | Notes |
|---|---|---|
| `tool` | string | Checker name, for example `"TLA+ TLC"`, `"Alloy"`, `"fast-check"`. |
| `toolVersion` | optional string | Shown after the tool; a repeated tool name is removed (`"TLA+ TLC"` + `"TLC 2.19"` shows `TLA+ TLC 2.19`). |
| `specHash` | optional string | Spec fingerprint. With `--spec`, omit it for a derived hash or supply the full SHA-256. Without `--spec`, a hash needs 7–128 hex digits and can use a `sha1:`, `sha256:`, or `sha512:` prefix. |
| `status` | `verified \| failed \| pending` | Outcome of the run as a whole. |
| `bounds` | optional string | The search bounds of the whole run (`"Quint: 2000 runs x 16 steps; TLC: 3 clients"`), always shown above the board; warns above 120 characters. |

## `rules[]`

| Field | Type | Notes |
|---|---|---|
| `id` | string | Unique, `[a-zA-Z0-9_-]` only. |
| `no` | number | Positive display number. |
| `moduleId` | string, only with `modules` | Must reference a module id. |
| `short` | string | Label for the pill bar and overview; warns above 20 characters. |
| `title` | string | One sentence that states the rule. |
| `property` | string | Invariant or property name in the spec. |
| `category` | optional string | For example `safety`, `liveness`, `security`. |
| `source` | string | Where the rule comes from (requirement, policy, section). |
| `previewTitle` | string | Title of the linked screen preview. |
| `figure` | object | The diagram: one of five kinds, below. |
| `states.normal`, `states.bug`, `states.fixed` | object | The three switchable states (below). |
| `defaultFocus` | `normal \| bug \| fixed` | State shown first. |
| `status` | optional `verified \| failed \| pending` | Checker result for this rule. Missing means `pending` (shown as "Not checked yet"). |
| `stepsChecked` | optional integer >= 0 | States or steps the checker explored, shown as "N steps checked". |
| `evidence` | object | What was checked and how (below). |

## `figure`

Pick the kind that shows what the checker proved. `figure.kind` is optional and defaults to
`gate`. Every kind draws into the same canvas. The validator warns when figure text cannot fit:
a box, lane or node label, a chip, or a line label too long for its free length. `gate` and
`sequence` use fixed slots, so only fit is checked. `timeline` also warns on an event that needs a
fourth row and a pin that crosses another event. `relation` also warns when a line label
overlaps another label or a node, when a line crosses a node it does not connect, or when a line
crosses another line's label. Line-on-line crossings are not checked.

| Kind | Use for | Fields |
|---|---|---|
| `gate` (default) | A value or status check: limits, budgets, guards | `boxes`: `src1`, `src2` (inputs), `gate` (the check), `pass`, `hold`, `bad` (outcomes). `arrows`: `a1` src1 to gate, `a2` src2 to gate, `a3` gate to pass, `a4` gate to hold, `a5` gate to bad. Box labels wrap to two lines; keep arrow labels to about 12 characters. |
| `sequence` | Races, check-then-act, ordering between actors (TLA+ / TLC, Quint, Apalache) | `lanes`: 2 or 3 `{ id, label }` actors. `steps`: 2 to 5 `{ id, from, to, label }` in time order, top to bottom; `from` and `to` are lane ids, and `from` equal to `to` draws a step on one lane. |
| `relation` | Structure: delegation, roles, ownership, cycles (Alloy) | `nodes`: 3 to 5 `{ id, label, role? }`, placed in fixed slots in array order (3: triangle, 4: 2 x 2, 5: corners and center); `role` is a caption above the label. `edges`: 2 to 7 `{ id, from, to, label, forbidden? }`; `from` equal to `to` draws a loop, an edge and its reverse bow apart, and `forbidden: true` draws the edge dashed. At most one edge per direction between two nodes. |
| `state` | State machines: lifecycles, revocation, forbidden transitions | `states`: 2 to 5 `{ id, label, role? }` in fixed slots in array order; `role` `initial` (start dot), `normal`, `terminal` (double border) or `bad` (red while active). `transitions`: 1 to 8 `{ id, from, to, label, kind? }`; `kind` `allowed` (default), `forbidden` (dashed, a circled x) or `loop` (bowed); a self-transition must be `loop` or `forbidden`. One transition per direction. |
| `timeline` | Expiry, TTL, deadlines, off-by-one boundaries | `ticks`: 2 to 5 `{ id, label, boundary? }` left to right; `boundary: true` draws a vertical limit line. `bars`: 1 to 3 `{ id, from, to, label, tone? }` spans that run forward between ticks. `events`: 1 to 4 `{ id, tick, label, tone? }` pills pinned to a tick, stacked upward. `tone`: bars `neutral \| good \| bad`, events `normal \| good \| bad`. |

Ids in `lanes`, `steps`, `nodes`, `edges`, `states`, `transitions`, `ticks`, `bars` and `events` are unique `[a-zA-Z0-9_-]` strings. If a
relation label collides with another element, shorten it or reorder `nodes`.

## `states`

`states.<normal | bug | fixed>` defines the three switchable views of a rule.

One rule is one card. The **Compare** switch on that card moves the diagram and the screen
preview together, so put the whole comparison inside one rule: `normal` is the everyday case,
`bug` is what happens with the rule switched off, and `fixed` is the rule doing its job. Never
split one rule into two rules or modules ("with rule" and "without rule"): the reader then
meets two switches that contradict each other.

Every kind:

| Field | Type | Notes |
|---|---|---|
| `label` | string | Button text. |
| `tone` | `normal \| bug \| safe` | Color of the active route, connector and preview. |
| `edgeShort` | string | Connector pill between the figure and the preview; warns above 12 characters. |
| `takeaway` | string | One sentence under the figure. |
| `preview.statusBadge`, `preview.alert`, `preview.buttonLabel` | string | Screen preview text. |
| `preview.buttonKind` | `ok \| danger \| locked` | Button style. |
| `preview.rows` | array, 1..N | `{ k, v, tone? }` with `tone` `normal \| ok \| bad \| warn \| mute`. |
| `preview.bars` | optional array | `{ label, value, limit, max, unit?, ok }`: a meter with a limit marker. |
| `preview.logLines` | optional array of strings | Short trace lines. |

By figure kind (chip `tone` is `neutral \| good \| bad`):

| Kind | Field | Type | Notes |
|---|---|---|---|
| `gate` | `route` | array of arrow ids | Arrows drawn as active. |
| `gate` | `here` | `pass \| hold \| bad` | Outcome box the state ends in; the connector starts there. |
| `gate` | `chips` | array | `{ box, text, tone }`: a value shown inside a box. |
| `sequence` | `activeSteps` | non-empty array of step ids | Steps drawn as active and numbered 1, 2, ... top to bottom; the rest are dimmed. |
| `sequence` | `focusStep` | step id | One of `activeSteps`: where the outcome happens. It is emphasized, and the connector starts on its row. |
| `sequence` | `chips` | optional array | `{ lane, text, tone }`, at most one per lane, shown under the lane header. |
| `relation` | `activeEdges` | non-empty array of edge ids | Edges drawn as active. An active forbidden edge is red; in a `safe` state it ends in a stop bar instead of an arrowhead. |
| `relation` | `focusNodes` | optional array of node ids | Nodes outlined in the state color. |
| `relation` | `chips` | optional array | `{ node, text, tone }`, at most one per node, shown inside the node. With a chip, a node with a `role` keeps its label on one line. |
| `state` | `activeStates`, `activeTransitions` | array of ids | Drawn as active; the rest are dimmed (`activeStates` non-empty). |
| `state` | `focusTransition` | transition id | Emphasized; its target state, when active, is outlined as the outcome. |
| `state` | `chips` | optional array | `{ state, text, tone }`, at most one per state. |
| `timeline` | `activeBars`, `activeEvents` | array of ids | Drawn as active; the rest are dimmed (`activeEvents` non-empty). |
| `timeline` | `focusEvent` | event id | The outcome event, emphasized. |
| `timeline` | `chips` | optional array | `{ tick, text, tone }`, at most one per tick, under the axis. |

## `evidence`

| Field | Type | Notes |
|---|---|---|
| `ruleSummary` | string | The rule in plain words. |
| `ifEnforced`, `ifNotEnforced` | string | What the rule protects; what breaks without it. |
| `checkerSummary` | string | One-line checker result, for example `"No violation in 41,280 states"`. |
| `scope` | string | Bounds of the check (model size, ranges, number of runs); also a chip next to the property on the figure. |
| `method` | string | How it was checked (exhaustive model checking, bounded simulation, property-based testing with N runs, and so on). |
| `witness` | optional string | Reachability evidence: how often the checker reached the interesting states (`"reuse -> revoke in 1128/2000 runs"`). |
| `sourceQuote` | optional string | Verbatim text of the source the rule comes from. |
| `counterexample` | optional string | Checker trace. On a failed or not-checked rule it shows under **Counterexample** ("No counterexample recorded" when absent). On a verified rule, use it for the trace of the rule switched off (for example a killed mutant); it shows under **Counterexample without this rule**. When a verified rule has none, the section is left out. |

## `flow`

Optional system flow map across modules or stages.

Stages are cards listing their rules as clickable chips with verifier status; labeled arrows
join them; a journey highlights one path and links to the rule that decides it. A fixed caption
says arrows show connections and each rule's status is its reported check, so the map never
claims the connections were verified. Say in `note` how the checkers ran.

| Field | Type | Notes |
|---|---|---|
| `title`, `note` | optional string | Map heading (default "System flow") and a note after the caption. |
| `steps` | array, 2..6 | `{ id, label, summary?, moduleId?, ruleIds? }`: `ruleIds`, or every rule of `moduleId` (with both, the rules must be in that module); at least one rule. 2-3 stages draw in one row, 4-6 in two. |
| `edges` | array, 1..9 | `{ id, from, to, label, kind? }` between two different steps, one per direction. `kind`: `normal` (solid), `bypass` (dashed), `handoff` (dotted). |
| `journeys` | optional array, 1..5 | `{ id, label, tone, summary, stepIds, edgeIds?, checkpointRuleId?, checkpointFocus? }`. `tone`: `normal`, `bug`, `safe`. Both ends of each `edgeIds` edge must be in `stepIds`. `checkpointRuleId` adds a button that opens that rule in `checkpointFocus` (needs `checkpointRuleId`; default by tone: bug → `bug`, safe → `fixed`, else `normal`). |

Ids are unique `[a-zA-Z0-9_-]` strings. Text that does not fit or labels that collide warn.
