// proof-canvas board schema (version 1), provenance resolution and size budgets.
// Zero dependencies: Node 22+ standard-library ESM only.

import { figureOverflows } from './figure.mjs';

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

// Keys the renderer adds to the embedded payload. They are never part of an input board.
export const RENDERER_KEYS = ['__provenance', '__layout', '__titleOverride'];

// Recommended label lengths (characters). Longer labels still render; the validator warns.
export const SHORT_WARN_CHARS = 20;
export const EDGE_WARN_CHARS = 12;

const KEYS = {
  board: ['version', 'runId', 'title', 'subtitle', 'generatedAt', 'provenance', 'provenanceNote', 'run', 'modules', 'rules'],
  run: ['tool', 'toolVersion', 'specHash', 'status'],
  module: ['id', 'title', 'summary'],
  rule: ['id', 'no', 'moduleId', 'short', 'title', 'property', 'category', 'source', 'previewTitle', 'figure', 'states', 'defaultFocus', 'status', 'stepsChecked', 'evidence'],
  figure: ['boxes', 'arrows'],
  state: ['label', 'tone', 'route', 'here', 'edgeShort', 'chips', 'takeaway', 'preview'],
  chip: ['box', 'text', 'tone'],
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
  { upTo: 6, bytes: 100 * 1024 },
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
// The validator only checks the shape: the producer is responsible for hashing the checked spec.
export function isRealHash(h) {
  if (typeof h !== 'string') return false;
  const m = h.trim().match(HASH_RE);
  return !!m && !/^0+$/.test(m[1]);
}

// Reasons a board cannot display "Verified" (empty = it can).
export function verifiedBlockers(board) {
  const rules = Array.isArray(board?.rules) ? board.rules : [];
  const run = isPlainObject(board?.run) ? board.run : {};
  const out = [];
  if (board?.provenance === 'sample' || board?.provenance === 'mixed' || board?.provenance === 'unverified') {
    out.push(`provenance is declared "${board.provenance}"`);
  }
  if (run.status !== 'verified') out.push(`run.status is "${run.status}", not "verified"`);
  if (run.specHash === undefined) out.push('run.specHash is missing');
  else if (!isRealHash(run.specHash)) out.push('run.specHash is not a real hash');
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
export function resolveProvenance(board) {
  const rules = Array.isArray(board?.rules) ? board.rules : [];
  const run = isPlainObject(board?.run) ? board.run : {};
  const verifiedCount = rules.filter((r) => ruleStatus(r) === 'verified').length;
  const failedCount = rules.filter((r) => ruleStatus(r) === 'failed').length;
  const total = rules.length;
  const base = { verifiedCount, failedCount, pendingCount: total - verifiedCount - failedCount, total };
  const declared = board?.provenance;

  if (declared === 'sample') return { kind: 'sample', tone: 'warn', ...base };
  if (failedCount > 0 || run.status === 'failed') return { kind: 'failed', tone: 'bad', ...base };
  if (run.specHash !== undefined && !isRealHash(run.specHash) && verifiedCount === 0) return { kind: 'sample', tone: 'warn', ...base };

  let kind = verifiedBlockers(board).length === 0 ? 'verified' : verifiedCount > 0 ? 'mixed' : 'unverified';
  if ((declared === 'mixed' || declared === 'unverified') && RANK[declared] < RANK[kind]) kind = declared;
  return { kind, tone: kind === 'verified' ? 'good' : 'warn', ...base };
}

export function validateBoardData(board) {
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
        warn('$.run.specHash', `"${run.specHash.slice(0, 40)}" is not a real hash (expected an optional sha1:/sha256:/sha512: prefix and 7-128 hex digits, not all zeros); the board cannot show Verified`);
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

    // 6-box topology
    const fig = rule.figure;
    if (!isPlainObject(fig)) {
      err(`${p}.figure`, 'must be an object');
    } else {
      keys(fig, KEYS.figure, `${p}.figure`);
      if (!isPlainObject(fig.boxes)) {
        err(`${p}.figure.boxes`, 'must be an object with 6 box labels');
      } else {
        keys(fig.boxes, BOX_KEYS, `${p}.figure.boxes`);
        for (const bk of BOX_KEYS) reqStr(fig.boxes, bk, `${p}.figure.boxes`);
      }
      if (!isPlainObject(fig.arrows)) {
        err(`${p}.figure.arrows`, 'must be an object with 5 arrow labels');
      } else {
        keys(fig.arrows, ARROW_KEYS, `${p}.figure.arrows`);
        for (const ak of ARROW_KEYS) reqStr(fig.arrows, ak, `${p}.figure.arrows`);
      }
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
        keys(st, KEYS.state, sp);
        reqStr(st, 'label', sp);
        if (!FOCUS_TONES.includes(st.tone)) err(`${sp}.tone`, `must be one of ${FOCUS_TONES.join(', ')}`);
        if (!Array.isArray(st.route) || st.route.length < 1) {
          err(`${sp}.route`, 'must be a non-empty array of arrow IDs');
        } else {
          for (const a of st.route) if (!ARROW_KEYS.includes(a)) err(`${sp}.route`, `invalid arrow ID "${a}"`);
        }
        if (!EXIT_BOXES.includes(st.here)) err(`${sp}.here`, `must be one of ${EXIT_BOXES.join(', ')}`);
        reqStr(st, 'edgeShort', sp);
        if (isNonEmptyString(st.edgeShort) && [...st.edgeShort].length > EDGE_WARN_CHARS) {
          warn(`${sp}.edgeShort`, `length ${[...st.edgeShort].length} exceeds the recommended ${EDGE_WARN_CHARS} characters (the connector label wraps)`);
        }
        reqStr(st, 'takeaway', sp);
        if (!Array.isArray(st.chips)) {
          err(`${sp}.chips`, 'must be an array');
        } else {
          st.chips.forEach((c, ci) => {
            const cp = `${sp}.chips[${ci}]`;
            if (!isPlainObject(c)) { err(cp, 'must be an object'); return; }
            keys(c, KEYS.chip, cp);
            if (!BOX_KEYS.includes(c.box)) err(`${cp}.box`, `invalid box "${c.box}"`);
            reqStr(c, 'text', cp);
            if (!CHIP_TONES.includes(c.tone)) err(`${cp}.tone`, `must be one of ${CHIP_TONES.join(', ')}`);
          });
        }

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
        warn(`${p}.${o.where}`, `"${o.text}" is wider than ${o.room}; shorten it`);
      }
    }
  });

  if (hasModules && Array.isArray(board.modules)) {
    for (const m of board.modules) {
      if (m && isNonEmptyString(m.id) && !usedModules.has(m.id)) warn('$.modules', `module "${m.id}" has no rules`);
    }
  }

  // Honesty: a declared "verified" must be backed by the board's own statuses.
  if (board.provenance === 'verified' && errors.length === 0) {
    const blockers = verifiedBlockers(board);
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
