// proof-canvas board schema (version 1), provenance resolution and size budgets.
// Zero dependencies: Node 22+ standard-library ESM only.

import { FIGURE_KINDS, figureOverflows } from './figure.mjs';
import { flowOverflows } from './flow.mjs';
import { LANGS } from './i18n.mjs';

export const BOX_KEYS = ['src1', 'src2', 'gate', 'pass', 'hold', 'bad'];
export const ARROW_KEYS = ['a1', 'a2', 'a3', 'a4', 'a5'];
export const STATE_KEYS = ['normal', 'bug', 'fixed'];
export const EXIT_BOXES = ['pass', 'hold', 'bad'];
export const FOCUS_TONES = ['normal', 'bug', 'safe'];
export const CHIP_TONES = ['neutral', 'good', 'bad'];
export const BUTTON_KINDS = ['ok', 'danger', 'locked'];
export const ROW_TONES = ['normal', 'ok', 'bad', 'warn', 'mute'];
export const RUN_STATUSES = ['verified', 'failed', 'pending'];
export const RULE_STATUSES = ['verified', 'failed', 'pending'];
export const PROVENANCE_VALUES = ['verified', 'mixed', 'sample', 'unverified'];
export const DEFAULT_VIEWS = ['rule', 'flow'];
export const EDGE_KINDS = ['normal', 'bypass', 'handoff'];
export const LABEL_WARN_CHARS = 24;

// Keys the renderer adds to the embedded payload. They are never part of an input board.
export const RENDERER_KEYS = ['__provenance', '__layout', '__titleOverride', '__binding'];

// Recommended label lengths (characters). Longer labels still render; the validator warns.
export const SHORT_WARN_CHARS = 20;
export const EDGE_WARN_CHARS = 12;

const KEYS = {
  board: ['version', 'runId', 'title', 'subtitle', 'generatedAt', 'provenance', 'provenanceNote', 'lang', 'labels', 'defaultView', 'run', 'modules', 'flow', 'rules'],
  labels: ['moduleSingular', 'modulePlural', 'overview'],
  flow: ['title', 'note', 'steps', 'edges', 'journeys'],
  flowStep: ['id', 'label', 'summary', 'moduleId', 'ruleIds'],
  flowEdge: ['id', 'from', 'to', 'label', 'kind'],
  journey: ['id', 'label', 'tone', 'summary', 'stepIds', 'edgeIds', 'checkpointRuleId', 'checkpointFocus'],
  run: ['tool', 'toolVersion', 'specHash', 'status'],
  module: ['id', 'title', 'summary'],
  rule: ['id', 'no', 'moduleId', 'short', 'title', 'property', 'category', 'source', 'previewTitle', 'figure', 'states', 'defaultFocus', 'status', 'stepsChecked', 'evidence'],
  state: ['label', 'tone', 'edgeShort', 'takeaway', 'preview'],
  preview: ['statusBadge', 'rows', 'bars', 'logLines', 'alert', 'buttonLabel', 'buttonKind'],
  row: ['k', 'v', 'tone'],
  bar: ['label', 'value', 'limit', 'max', 'unit', 'ok'],
  evidence: ['ruleSummary', 'ifEnforced', 'ifNotEnforced', 'checkerSummary', 'scope', 'method', 'sourceQuote', 'counterexample'],
};

// Design tokens commonly owned by a host page (shadcn/ui-style). An embedded board must
// never redefine them on :root, or it repaints the host around the iframe / inline visual.
export const RESERVED_HOST_TOKENS = [
  '--background', '--foreground', '--card', '--card-foreground',
  '--popover', '--popover-foreground', '--primary', '--primary-foreground',
  '--secondary', '--secondary-foreground', '--muted', '--muted-foreground',
  '--accent', '--accent-foreground', '--destructive', '--destructive-foreground',
  '--border', '--input', '--ring', '--radius', '--font-sans', '--font-mono',
  '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5',
];

// Size discipline. MAX_BYTES is a hard ceiling; the per-scale budget only warns.
export const MAX_BYTES = 512 * 1024;
const BUDGETS = [
  { upTo: 6, bytes: 128 * 1024 },
  { upTo: 20, bytes: 200 * 1024 },
  { upTo: 50, bytes: 350 * 1024 },
  { upTo: Infinity, bytes: MAX_BYTES },
];
export function sizeBudgetFor(ruleCount) {
  return BUDGETS.find((b) => ruleCount <= b.upTo).bytes;
}

// Compact pill bar for small single-module boards; index layout (module selector,
// rule index, search, status filter, hub overview) for everything larger.
export const COMPACT_MAX_RULES = 6;
export function layoutFor(board) {
  const n = Array.isArray(board?.rules) ? board.rules.length : 0;
  const m = Array.isArray(board?.modules) ? board.modules.length : 0;
  return n <= COMPACT_MAX_RULES && m <= 1 ? 'compact' : 'index';
}

// A rule without a status has not been checked yet.
export function ruleStatus(rule) {
  return rule?.status === 'verified' || rule?.status === 'failed' ? rule.status : 'pending';
}

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
export const SAFE_ID = /^[a-zA-Z0-9_-]+$/;
const HASH_RE = /^(?:sha(?:1|256|512):)?([0-9a-f]{7,128})$/i;

// A real spec fingerprint: optional sha1:/sha256:/sha512: prefix, 7-128 hex digits, not all zeros.
// Without a supplied spec file, only the hash format can be checked.
export function isRealHash(h) {
  if (typeof h !== 'string') return false;
  const m = h.trim().match(HASH_RE);
  return !!m && !/^0+$/.test(m[1]);
}

// Reasons a board cannot display "Verified" (empty = it can).
export function verifiedBlockers(board, { checkHash = true, specHash = board?.run?.specHash } = {}) {
  const rules = Array.isArray(board?.rules) ? board.rules : [];
  const run = isPlainObject(board?.run) ? board.run : {};
  const out = [];
  if (board?.provenance === 'sample' || board?.provenance === 'mixed' || board?.provenance === 'unverified') {
    out.push(`provenance is declared "${board.provenance}"`);
  }
  if (run.status !== 'verified') out.push(`run.status is "${run.status}", not "verified"`);
  if (checkHash) {
    if (specHash === undefined) out.push('run.specHash is missing');
    else if (!isRealHash(specHash)) out.push('run.specHash is not a real hash');
  }
  if (rules.length === 0) out.push('there are no rules');
  const notVerified = rules.filter((r) => ruleStatus(r) !== 'verified').length;
  if (notVerified > 0) out.push(`${notVerified} of ${rules.length} rule(s) are not "verified"`);
  return out;
}

const RANK = { unverified: 0, mixed: 1, verified: 2 };

// Badge kind computed from the board's own statuses. Order of precedence:
//   1. declared "sample"                       -> sample
//   2. any failed rule, or run.status "failed" -> failed (even without a spec hash)
//   3. malformed spec hash and nothing verified -> sample
//   4. otherwise verified / mixed / unverified, capped by a declared "mixed" or "unverified".
export function resolveProvenance(board, binding) {
  const rules = Array.isArray(board?.rules) ? board.rules : [];
  const run = isPlainObject(board?.run) ? board.run : {};
  const verifiedCount = rules.filter((r) => ruleStatus(r) === 'verified').length;
  const failedCount = rules.filter((r) => ruleStatus(r) === 'failed').length;
  const total = rules.length;
  const level = binding?.level ?? 'self-reported';
  const specHash = binding?.specHash ?? run.specHash;
  const base = { verifiedCount, failedCount, pendingCount: total - verifiedCount - failedCount, total, level };
  const declared = board?.provenance;

  if (declared === 'sample') return { kind: 'sample', tone: 'warn', ...base };
  if (failedCount > 0 || run.status === 'failed') return { kind: 'failed', tone: 'bad', ...base };
  if (specHash !== undefined && !isRealHash(specHash) && verifiedCount === 0) return { kind: 'sample', tone: 'warn', ...base };

  let kind = verifiedBlockers(board, { specHash }).length === 0 ? 'verified' : verifiedCount > 0 ? 'mixed' : 'unverified';
  if ((declared === 'mixed' || declared === 'unverified') && RANK[declared] < RANK[kind]) kind = declared;
  return { kind, tone: kind === 'verified' && level === 'spec-and-log' ? 'good' : 'warn', ...base };
}

// Items of a figure list: objects with unique [a-zA-Z0-9_-] ids, count in [min, max].
// Returns the set of valid ids, so states can be checked against them.
function figureItems(list, path, min, max, allowed, c) {
  const ids = new Set();
  if (!Array.isArray(list) || list.length < min || list.length > max) {
    c.err(path, `must be an array of ${min} to ${max} items`);
    return ids;
  }
  list.forEach((it, i) => {
    const ip = `${path}[${i}]`;
    if (!isPlainObject(it)) { c.err(ip, 'must be an object'); return; }
    c.keys(it, allowed, ip);
    if (!isNonEmptyString(it.id) || !SAFE_ID.test(it.id)) c.err(`${ip}.id`, 'must be a non-empty [a-zA-Z0-9_-] string');
    else if (ids.has(it.id)) c.err(`${ip}.id`, `duplicate id "${it.id}"`);
    else ids.add(it.id);
    c.reqStr(it, 'label', ip);
  });
  return ids;
}

// A state's list of ids that must all be known and distinct.
function idRefs(list, known, path, nonEmpty, what, c) {
  if (!Array.isArray(list) || (nonEmpty && list.length < 1)) { c.err(path, `must be ${nonEmpty ? 'a non-empty' : 'an'} array of ${what} IDs`); return; }
  const seen = new Set();
  for (const id of list) {
    if (!known.has(id)) c.err(path, `invalid ${what} ID "${id}"`);
    else if (seen.has(id)) c.err(path, `duplicate ${what} ID "${id}"`);
    seen.add(id);
  }
}

// Chips of a state: { <target>, text, tone }, at most one per target.
function chipList(chips, target, known, path, required, c) {
  if (chips === undefined && !required) return;
  if (!Array.isArray(chips)) { c.err(path, required ? 'must be an array' : 'must be an array when present'); return; }
  const seen = new Set();
  chips.forEach((ch, ci) => {
    const cp = `${path}[${ci}]`;
    if (!isPlainObject(ch)) { c.err(cp, 'must be an object'); return; }
    c.keys(ch, [target, 'text', 'tone'], cp);
    if (!known.has(ch[target])) c.err(`${cp}.${target}`, `invalid ${target} "${ch[target]}"`);
    else if (!required && seen.has(ch[target])) c.err(`${cp}.${target}`, `a second chip for ${target} "${ch[target]}"`);
    seen.add(ch[target]);
    c.reqStr(ch, 'text', cp);
    if (!CHIP_TONES.includes(ch.tone)) c.err(`${cp}.tone`, `must be one of ${CHIP_TONES.join(', ')}`);
  });
}

// Per-kind checks of rule.figure (returns the ids states may reference) and of a state's figure fields.
const KIND_CHECKS = {
  gate: {
    figureKeys: ['kind', 'boxes', 'arrows'],
    stateKeys: ['label', 'tone', 'route', 'here', 'edgeShort', 'chips', 'takeaway', 'preview'],
    figure(fig, fp, c) {
      if (!isPlainObject(fig.boxes)) {
        c.err(`${fp}.boxes`, 'must be an object with 6 box labels');
      } else {
        c.keys(fig.boxes, BOX_KEYS, `${fp}.boxes`);
        for (const bk of BOX_KEYS) c.reqStr(fig.boxes, bk, `${fp}.boxes`);
      }
      if (!isPlainObject(fig.arrows)) {
        c.err(`${fp}.arrows`, 'must be an object with 5 arrow labels');
      } else {
        c.keys(fig.arrows, ARROW_KEYS, `${fp}.arrows`);
        for (const ak of ARROW_KEYS) c.reqStr(fig.arrows, ak, `${fp}.arrows`);
      }
      return null;
    },
    state(st, _refs, sp, c) {
      if (!Array.isArray(st.route) || st.route.length < 1) {
        c.err(`${sp}.route`, 'must be a non-empty array of arrow IDs');
      } else {
        for (const a of st.route) if (!ARROW_KEYS.includes(a)) c.err(`${sp}.route`, `invalid arrow ID "${a}"`);
      }
      if (!EXIT_BOXES.includes(st.here)) c.err(`${sp}.here`, `must be one of ${EXIT_BOXES.join(', ')}`);
      chipList(st.chips, 'box', new Set(BOX_KEYS), `${sp}.chips`, true, c);
    },
  },
  sequence: {
    figureKeys: ['kind', 'lanes', 'steps'],
    stateKeys: ['label', 'tone', 'activeSteps', 'focusStep', 'edgeShort', 'chips', 'takeaway', 'preview'],
    figure(fig, fp, c) {
      const lanes = figureItems(fig.lanes, `${fp}.lanes`, 2, 3, ['id', 'label'], c);
      const steps = figureItems(fig.steps, `${fp}.steps`, 2, 5, ['id', 'from', 'to', 'label'], c);
      (Array.isArray(fig.steps) ? fig.steps : []).forEach((s, i) => {
        for (const k of ['from', 'to']) if (isPlainObject(s) && !lanes.has(s[k])) c.err(`${fp}.steps[${i}].${k}`, `must be a lane id (got "${s[k]}")`);
      });
      return { lanes, steps };
    },
    state(st, refs, sp, c) {
      idRefs(st.activeSteps, refs.steps, `${sp}.activeSteps`, true, 'step', c);
      if (!Array.isArray(st.activeSteps) || !st.activeSteps.includes(st.focusStep)) c.err(`${sp}.focusStep`, 'must be one of the state\'s activeSteps');
      chipList(st.chips, 'lane', refs.lanes, `${sp}.chips`, false, c);
    },
  },
  relation: {
    figureKeys: ['kind', 'nodes', 'edges'],
    stateKeys: ['label', 'tone', 'activeEdges', 'focusNodes', 'edgeShort', 'chips', 'takeaway', 'preview'],
    figure(fig, fp, c) {
      const nodes = figureItems(fig.nodes, `${fp}.nodes`, 3, 5, ['id', 'label', 'role'], c);
      const edges = figureItems(fig.edges, `${fp}.edges`, 2, 7, ['id', 'from', 'to', 'label', 'forbidden'], c);
      const pairs = new Set();
      (Array.isArray(fig.nodes) ? fig.nodes : []).forEach((n, i) => { if (isPlainObject(n)) c.optStr(n, 'role', `${fp}.nodes[${i}]`); });
      (Array.isArray(fig.edges) ? fig.edges : []).forEach((e, i) => {
        if (!isPlainObject(e)) return;
        const ep = `${fp}.edges[${i}]`;
        for (const k of ['from', 'to']) if (!nodes.has(e[k])) c.err(`${ep}.${k}`, `must be a node id (got "${e[k]}")`);
        if (e.forbidden !== undefined && typeof e.forbidden !== 'boolean') c.err(`${ep}.forbidden`, 'must be a boolean when present');
        const pair = e.from + '>' + e.to;
        if (pairs.has(pair)) c.err(ep, `a second edge from "${e.from}" to "${e.to}"`);
        pairs.add(pair);
      });
      return { nodes, edges };
    },
    state(st, refs, sp, c) {
      idRefs(st.activeEdges, refs.edges, `${sp}.activeEdges`, true, 'edge', c);
      if (st.focusNodes !== undefined) idRefs(st.focusNodes, refs.nodes, `${sp}.focusNodes`, false, 'node', c);
      chipList(st.chips, 'node', refs.nodes, `${sp}.chips`, false, c);
    },
  },
};

// A flow list: objects with unique [a-zA-Z0-9_-] ids, count in [min, max]. Returns the valid ids.
function flowItems(list, path, min, max, allowed, c) {
  const ids = new Set();
  if (!Array.isArray(list) || list.length < min || list.length > max) {
    c.err(path, `must be an array of ${min} to ${max} items`);
    return ids;
  }
  list.forEach((it, i) => {
    const ip = `${path}[${i}]`;
    if (!isPlainObject(it)) { c.err(ip, 'must be an object'); return; }
    c.keys(it, allowed, ip);
    if (!isNonEmptyString(it.id) || !SAFE_ID.test(it.id)) c.err(`${ip}.id`, 'must be a non-empty [a-zA-Z0-9_-] string');
    else if (ids.has(it.id)) c.err(`${ip}.id`, `duplicate id "${it.id}"`);
    else ids.add(it.id);
    c.reqStr(it, 'label', ip);
  });
  return ids;
}

// board.flow: stages (each resolving to at least one rule), labeled edges between them, and
// optional journeys that highlight a path and may open one checkpoint rule.
function checkFlow(board, moduleIds, c) {
  const f = board.flow;
  const fp = '$.flow';
  if (!isPlainObject(f)) { c.err(fp, 'must be an object when present'); return; }
  const before = c.count();
  c.keys(f, KEYS.flow, fp);
  c.optStr(f, 'title', fp);
  c.optStr(f, 'note', fp);
  const rules = Array.isArray(board.rules) ? board.rules.filter(isPlainObject) : [];
  const ruleModule = new Map(rules.map((r) => [r.id, r.moduleId]));
  const stepIds = flowItems(f.steps, `${fp}.steps`, 2, 6, KEYS.flowStep, c);
  (Array.isArray(f.steps) ? f.steps : []).forEach((s, i) => {
    if (!isPlainObject(s)) return;
    const sp = `${fp}.steps[${i}]`;
    c.optStr(s, 'summary', sp);
    if (s.moduleId !== undefined) {
      if (!moduleIds.size) c.err(`${sp}.moduleId`, 'requires a top-level $.modules array');
      else if (!moduleIds.has(s.moduleId)) c.err(`${sp}.moduleId`, `unknown module "${s.moduleId}"`);
    }
    if (s.ruleIds !== undefined) {
      if (!Array.isArray(s.ruleIds) || s.ruleIds.length < 1) { c.err(`${sp}.ruleIds`, 'must be a non-empty array of rule IDs when present'); return; }
      const seen = new Set();
      for (const id of s.ruleIds) {
        if (!ruleModule.has(id)) c.err(`${sp}.ruleIds`, `invalid rule ID "${id}"`);
        else if (seen.has(id)) c.err(`${sp}.ruleIds`, `duplicate rule ID "${id}"`);
        else if (s.moduleId !== undefined && ruleModule.get(id) !== s.moduleId) c.err(`${sp}.ruleIds`, `rule "${id}" belongs to module "${ruleModule.get(id) ?? '(none)'}", not "${s.moduleId}"`);
        seen.add(id);
      }
    } else if (s.moduleId === undefined) {
      c.err(sp, 'needs ruleIds or a moduleId so the stage shows at least one rule');
    } else if (moduleIds.has(s.moduleId) && !rules.some((r) => r.moduleId === s.moduleId)) {
      c.err(`${sp}.moduleId`, `module "${s.moduleId}" has no rules, so the stage would be empty`);
    }
  });
  const edgeIds = flowItems(f.edges, `${fp}.edges`, 1, 9, KEYS.flowEdge, c);
  const ends = new Map();
  const pairs = new Set();
  (Array.isArray(f.edges) ? f.edges : []).forEach((e, i) => {
    if (!isPlainObject(e)) return;
    const ep = `${fp}.edges[${i}]`;
    for (const k of ['from', 'to']) if (!stepIds.has(e[k])) c.err(`${ep}.${k}`, `must be a step id (got "${e[k]}")`);
    if (e.from === e.to) c.err(ep, `an edge from stage "${e.from}" to itself`);
    if (e.kind !== undefined && !EDGE_KINDS.includes(e.kind)) c.err(`${ep}.kind`, `must be one of ${EDGE_KINDS.join(', ')} when present`);
    const pair = e.from + '>' + e.to;
    if (pairs.has(pair)) c.err(ep, `a second edge from "${e.from}" to "${e.to}"`);
    pairs.add(pair);
    if (isNonEmptyString(e.id)) ends.set(e.id, [e.from, e.to]);
  });
  if (f.journeys !== undefined) {
    flowItems(f.journeys, `${fp}.journeys`, 1, 5, KEYS.journey, c);
    (Array.isArray(f.journeys) ? f.journeys : []).forEach((j, i) => {
      if (!isPlainObject(j)) return;
      const jp = `${fp}.journeys[${i}]`;
      if (!FOCUS_TONES.includes(j.tone)) c.err(`${jp}.tone`, `must be one of ${FOCUS_TONES.join(', ')}`);
      c.reqStr(j, 'summary', jp);
      idRefs(j.stepIds, stepIds, `${jp}.stepIds`, true, 'step', c);
      if (j.edgeIds !== undefined) {
        idRefs(j.edgeIds, edgeIds, `${jp}.edgeIds`, false, 'edge', c);
        const on = new Set(Array.isArray(j.stepIds) ? j.stepIds : []);
        for (const id of Array.isArray(j.edgeIds) ? j.edgeIds : []) {
          const [from, to] = ends.get(id) ?? [];
          if (edgeIds.has(id) && !(on.has(from) && on.has(to))) c.err(`${jp}.edgeIds`, `edge "${id}" runs from "${from}" to "${to}", but both ends must be in stepIds`);
        }
      }
      if (j.checkpointRuleId !== undefined && !ruleModule.has(j.checkpointRuleId)) c.err(`${jp}.checkpointRuleId`, `invalid rule ID "${j.checkpointRuleId}"`);
      if (j.checkpointFocus !== undefined) {
        if (j.checkpointRuleId === undefined) c.err(`${jp}.checkpointFocus`, 'requires checkpointRuleId');
        else if (!STATE_KEYS.includes(j.checkpointFocus)) c.err(`${jp}.checkpointFocus`, `must be one of ${STATE_KEYS.join(', ')}`);
      }
      if (isNonEmptyString(j.label) && [...j.label].length > LABEL_WARN_CHARS) c.warn(`${jp}.label`, `length ${[...j.label].length} exceeds the recommended ${LABEL_WARN_CHARS} characters`);
    });
  }
  // Fit and collisions, only once the flow's structure is valid.
  if (c.count() === before) for (const o of flowOverflows(board)) c.warn(`${fp}.${o.where}`, o.msg);
}

export function validateBoardData(board, { checkHash = true } = {}) {
  const errors = [];
  const warnings = [];
  const err = (path, msg) => errors.push(`${path}: ${msg}`);
  const warn = (path, msg) => warnings.push(`${path}: ${msg}`);
  const keys = (obj, allowed, path) => {
    for (const k of Object.keys(obj)) {
      if (k.startsWith('__') && path === '$') err(`$.${k}`, 'keys starting with "__" are reserved for the renderer');
      else if (!allowed.includes(k)) warn(`${path}.${k}`, `unknown key (ignored); expected one of ${allowed.join(', ')}`);
    }
  };
  const reqStr = (obj, k, path) => { if (!isNonEmptyString(obj[k])) err(`${path}.${k}`, 'must be a non-empty string'); };
  const optStr = (obj, k, path) => { if (obj[k] !== undefined && !isNonEmptyString(obj[k])) err(`${path}.${k}`, 'must be a non-empty string when present'); };
  const ctx = { err, warn, keys, reqStr, optStr, count: () => errors.length };

  if (!isPlainObject(board)) {
    err('$', 'root must be a JSON object');
    return { ok: false, errors, warnings };
  }
  keys(board, KEYS.board, '$');

  if (board.version !== 1) err('$.version', 'must be 1');
  for (const k of ['runId', 'title', 'subtitle', 'generatedAt']) reqStr(board, k, '$');
  optStr(board, 'provenanceNote', '$');
  if (board.provenance !== undefined && !PROVENANCE_VALUES.includes(board.provenance)) {
    err('$.provenance', `must be one of ${PROVENANCE_VALUES.join(', ')}`);
  }
  if (board.lang !== undefined && !LANGS.includes(board.lang)) err('$.lang', `must be one of ${LANGS.join(', ')} when present`);
  if (board.labels !== undefined) {
    if (!isPlainObject(board.labels)) {
      err('$.labels', 'must be an object when present');
    } else {
      keys(board.labels, KEYS.labels, '$.labels');
      for (const k of KEYS.labels) {
        optStr(board.labels, k, '$.labels');
        if (isNonEmptyString(board.labels[k]) && [...board.labels[k]].length > LABEL_WARN_CHARS) {
          warn(`$.labels.${k}`, `length ${[...board.labels[k]].length} exceeds the recommended ${LABEL_WARN_CHARS} characters`);
        }
      }
    }
  }
  if (board.defaultView !== undefined && !DEFAULT_VIEWS.includes(board.defaultView)) err('$.defaultView', `must be one of ${DEFAULT_VIEWS.join(', ')} when present`);
  else if (board.defaultView === 'flow' && board.flow === undefined) err('$.defaultView', '"flow" requires a $.flow');

  const run = board.run;
  if (!isPlainObject(run)) {
    err('$.run', 'must be an object');
  } else {
    keys(run, KEYS.run, '$.run');
    reqStr(run, 'tool', '$.run');
    optStr(run, 'toolVersion', '$.run');
    if (!RUN_STATUSES.includes(run.status)) err('$.run.status', `must be one of ${RUN_STATUSES.join(', ')}`);
    if (run.specHash !== undefined) {
      if (typeof run.specHash !== 'string') err('$.run.specHash', 'must be a string when present');
      else if (!isRealHash(run.specHash)) {
        warn('$.run.specHash', `"${run.specHash.slice(0, 40)}" is not a real hash (expected an optional sha1:/sha256:/sha512: prefix and 7-128 hex digits, not all zeros); the board cannot show a verified run`);
      }
    }
  }

  // Optional modules[] for multi-domain boards.
  const moduleIds = new Set();
  const hasModules = board.modules !== undefined;
  if (hasModules) {
    if (!Array.isArray(board.modules) || board.modules.length < 1) {
      err('$.modules', 'must be a non-empty array when present');
    } else {
      board.modules.forEach((m, mi) => {
        const mp = `$.modules[${mi}]`;
        if (!isPlainObject(m)) { err(mp, 'must be an object'); return; }
        keys(m, KEYS.module, mp);
        if (!isNonEmptyString(m.id) || !SAFE_ID.test(m.id)) err(`${mp}.id`, 'must be a non-empty [a-zA-Z0-9_-] string');
        else if (moduleIds.has(m.id)) err(`${mp}.id`, `duplicate module id "${m.id}"`);
        else moduleIds.add(m.id);
        reqStr(m, 'title', mp);
        if (m.summary !== undefined && typeof m.summary !== 'string') err(`${mp}.summary`, 'must be a string when present');
      });
    }
  }

  if (!Array.isArray(board.rules) || board.rules.length < 1) {
    err('$.rules', 'must be a non-empty array (1..N rules)');
    return { ok: false, errors, warnings };
  }

  const seenIds = new Set();
  const seenNos = new Set();
  const usedModules = new Set();
  board.rules.forEach((rule, idx) => {
    const p = `$.rules[${idx}]`;
    if (!isPlainObject(rule)) { err(p, 'must be an object'); return; }
    const errorsBefore = errors.length;
    keys(rule, KEYS.rule, p);

    if (!isNonEmptyString(rule.id)) {
      err(`${p}.id`, 'must be a non-empty string');
    } else {
      if (!SAFE_ID.test(rule.id)) err(`${p}.id`, 'must contain only [a-zA-Z0-9_-] so SVG marker IDs stay valid');
      if (seenIds.has(rule.id)) err(`${p}.id`, `duplicate rule id "${rule.id}"`);
      seenIds.add(rule.id);
    }

    if (!isFiniteNumber(rule.no) || rule.no < 1) err(`${p}.no`, 'must be a positive number');
    else if (seenNos.has(rule.no)) warn(`${p}.no`, `duplicate display number ${rule.no}`);
    else seenNos.add(rule.no);

    if (hasModules) {
      if (!isNonEmptyString(rule.moduleId)) err(`${p}.moduleId`, 'must reference a module id when $.modules is present');
      else if (!moduleIds.has(rule.moduleId)) err(`${p}.moduleId`, `unknown module "${rule.moduleId}"`);
      else usedModules.add(rule.moduleId);
    } else if (rule.moduleId !== undefined) {
      err(`${p}.moduleId`, 'requires a top-level $.modules array');
    }

    for (const k of ['short', 'title', 'property', 'source', 'previewTitle']) reqStr(rule, k, p);
    optStr(rule, 'category', p);
    if (isNonEmptyString(rule.short) && [...rule.short].length > SHORT_WARN_CHARS) {
      warn(`${p}.short`, `length ${[...rule.short].length} exceeds the recommended ${SHORT_WARN_CHARS} characters`);
    }
    if (rule.status !== undefined && !RULE_STATUSES.includes(rule.status)) {
      err(`${p}.status`, `must be one of ${RULE_STATUSES.join(', ')} when present`);
    }
    if (rule.stepsChecked !== undefined && !(Number.isInteger(rule.stepsChecked) && rule.stepsChecked >= 0)) {
      err(`${p}.stepsChecked`, 'must be a non-negative integer when present');
    }

    // Figure: one of FIGURE_KINDS, checked by its entry in KIND_CHECKS.
    const fig = rule.figure;
    let kind = null;
    let refs = null;
    if (!isPlainObject(fig)) {
      err(`${p}.figure`, 'must be an object');
    } else if (fig.kind !== undefined && !FIGURE_KINDS.includes(fig.kind)) {
      err(`${p}.figure.kind`, `must be one of ${FIGURE_KINDS.join(', ')} when present`);
    } else {
      kind = KIND_CHECKS[fig.kind ?? 'gate'];
      keys(fig, kind.figureKeys, `${p}.figure`);
      refs = kind.figure(fig, `${p}.figure`, ctx);
    }

    // 3 focus states: normal, bug, fixed
    const states = rule.states;
    if (!isPlainObject(states)) {
      err(`${p}.states`, 'must be an object with normal, bug, and fixed states');
    } else {
      keys(states, STATE_KEYS, `${p}.states`);
      for (const sk of STATE_KEYS) {
        const st = states[sk];
        const sp = `${p}.states.${sk}`;
        if (!isPlainObject(st)) { err(sp, 'missing required state'); continue; }
        keys(st, kind ? kind.stateKeys : KEYS.state, sp);
        reqStr(st, 'label', sp);
        if (!FOCUS_TONES.includes(st.tone)) err(`${sp}.tone`, `must be one of ${FOCUS_TONES.join(', ')}`);
        if (kind) kind.state(st, refs, sp, ctx);
        reqStr(st, 'edgeShort', sp);
        if (isNonEmptyString(st.edgeShort) && [...st.edgeShort].length > EDGE_WARN_CHARS) {
          warn(`${sp}.edgeShort`, `length ${[...st.edgeShort].length} exceeds the recommended ${EDGE_WARN_CHARS} characters (the connector label wraps)`);
        }
        reqStr(st, 'takeaway', sp);

        const pv = st.preview;
        const pp = `${sp}.preview`;
        if (!isPlainObject(pv)) {
          err(pp, 'must be an object');
        } else {
          keys(pv, KEYS.preview, pp);
          for (const k of ['statusBadge', 'alert', 'buttonLabel']) reqStr(pv, k, pp);
          if (!BUTTON_KINDS.includes(pv.buttonKind)) err(`${pp}.buttonKind`, `must be one of ${BUTTON_KINDS.join(', ')}`);
          if (!Array.isArray(pv.rows) || pv.rows.length < 1) {
            err(`${pp}.rows`, 'must be a non-empty array');
          } else {
            pv.rows.forEach((r, ri) => {
              const rp = `${pp}.rows[${ri}]`;
              if (!isPlainObject(r)) { err(rp, 'must be an object'); return; }
              keys(r, KEYS.row, rp);
              if (!isNonEmptyString(r.k) || !isNonEmptyString(r.v)) err(rp, 'must have non-empty strings k and v');
              if (r.tone !== undefined && !ROW_TONES.includes(r.tone)) err(`${rp}.tone`, `must be one of ${ROW_TONES.join(', ')} when present`);
            });
          }
          if (pv.bars !== undefined) {
            if (!Array.isArray(pv.bars)) {
              err(`${pp}.bars`, 'must be an array when present');
            } else {
              pv.bars.forEach((b, bi) => {
                const bp = `${pp}.bars[${bi}]`;
                if (!isPlainObject(b)) { err(bp, 'must be an object'); return; }
                keys(b, KEYS.bar, bp);
                if (!isNonEmptyString(b.label) || !isFiniteNumber(b.value) || !isFiniteNumber(b.limit) || !isFiniteNumber(b.max) || b.max <= 0 || typeof b.ok !== 'boolean') {
                  err(bp, 'must have a label, finite value / limit / max (max > 0), and boolean ok');
                }
                optStr(b, 'unit', bp);
              });
            }
          }
          if (pv.logLines !== undefined && (!Array.isArray(pv.logLines) || !pv.logLines.every((l) => typeof l === 'string'))) {
            err(`${pp}.logLines`, 'must be an array of strings when present');
          }
        }
      }
    }

    if (!STATE_KEYS.includes(rule.defaultFocus)) err(`${p}.defaultFocus`, `must be one of ${STATE_KEYS.join(', ')}`);

    const ev = rule.evidence;
    if (!isPlainObject(ev)) {
      err(`${p}.evidence`, 'must be an object');
    } else {
      keys(ev, KEYS.evidence, `${p}.evidence`);
      for (const k of ['ruleSummary', 'ifEnforced', 'ifNotEnforced', 'checkerSummary', 'scope', 'method']) reqStr(ev, k, `${p}.evidence`);
      optStr(ev, 'sourceQuote', `${p}.evidence`);
      optStr(ev, 'counterexample', `${p}.evidence`);
    }

    // Label fit, only once the rule's structure is valid.
    if (errors.length === errorsBefore) {
      for (const o of figureOverflows(rule)) {
        warn(`${p}.${o.where}`, o.msg ?? `"${o.text}" is wider than ${o.room}; shorten it`);
      }
    }
  });

  if (hasModules && Array.isArray(board.modules)) {
    for (const m of board.modules) {
      if (m && isNonEmptyString(m.id) && !usedModules.has(m.id)) warn('$.modules', `module "${m.id}" has no rules`);
    }
  }

  if (board.flow !== undefined) checkFlow(board, moduleIds, ctx);

  // Honesty: a declared "verified" must be backed by the board's own statuses.
  if (board.provenance === 'verified' && errors.length === 0) {
    const blockers = verifiedBlockers(board, { checkHash });
    if (blockers.length) err('$.provenance', `declared "verified" but ${blockers.join('; ')}`);
  }

  return { ok: errors.length === 0, errors, warnings };
}

// Split a decoded payload into the input board and the renderer-owned metadata.
export function splitRendererKeys(decoded) {
  if (!isPlainObject(decoded)) return { board: decoded, meta: {} };
  const board = {};
  const meta = {};
  for (const [k, v] of Object.entries(decoded)) {
    if (RENDERER_KEYS.includes(k)) meta[k] = v;
    else board[k] = v;
  }
  return { board, meta };
}
