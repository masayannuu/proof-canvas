#!/usr/bin/env node
// proof-canvas: deterministic, offline, single-file HTML board for formal-verification results.
// Small boards: centered floating rule pill bar. Large / multi-module boards: a rule index grouped
// by module, a status filter and a hub overview, with only the active rule's figure mounted.
// Zero dependencies: Node 22+ standard-library ESM only.

import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bindEvidence } from './evidence.mjs';
import { esc, figKind, figSvg, figureRuntime } from './figure.mjs';
import { flowRuntime, flowView } from './flow.mjs';
import { uiFor, uiSource } from './i18n.mjs';
import {
  BASE64_RE, DATA_ELEMENT_ID, GZIP_TYPE, JSON_TYPE, MAX_DECODED_BYTES, MAX_PAYLOAD_TEXT_BYTES, PAYLOAD_MODES, ROOT_ELEMENT_ID, encodePayload,
} from './payload.mjs';
import { layoutFor, resolveProvenance, ruleStatus, validateBoardData } from './schema.mjs';

export const RENDER_MODES = ['standalone', 'embed'];
// "All journeys" value. "*" can never be a journey id ([a-zA-Z0-9_-]), so it cannot collide.
export const ALL_JOURNEYS = '*';

const USAGE = `Usage:
  node scripts/render_board.mjs --in <board.json> --out <board.html>
       [--title "..."] [--mode standalone|embed] [--payload auto|json|gzip]
       [--spec <path>]... [--log <path>]...
`;

function parseArgs(argv) {
  const opts = { inPath: '', outPath: '', title: undefined, mode: 'standalone', payload: 'auto', specPaths: [], logPaths: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (a === '--in' && argv[i + 1]) {
      opts.inPath = argv[++i];
    } else if ((a === '--spec' || a === '--log') && argv[i + 1] && !argv[i + 1].startsWith('-')) {
      opts[a === '--spec' ? 'specPaths' : 'logPaths'].push(argv[++i]);
    } else if (a === '--out' && argv[i + 1]) {
      opts.outPath = argv[++i];
    } else if (a === '--title' && argv[i + 1]) {
      opts.title = argv[++i];
    } else if (a === '--mode' && argv[i + 1]) {
      opts.mode = argv[++i];
    } else if (a === '--payload' && argv[i + 1]) {
      opts.payload = argv[++i];
    } else {
      throw new Error(`Unknown or incomplete argument: ${a}`);
    }
  }
  if (!opts.inPath || !opts.outPath) throw new Error('Both --in <board.json> and --out <board.html> are required.');
  return opts;
}

// ---- display text shared by the server render and the browser runtime (injected via toString) ----

// "TLA+ TLC" + "TLC 2.19" -> "TLA+ TLC 2.19"; "Lean 4" + "Lean 4.12" -> "Lean 4.12".
export function toolLabel(run) {
  const tool = String((run && run.tool) || '').trim();
  const ver = String((run && run.toolVersion) || '').trim();
  if (!ver) return tool;
  if (!tool) return ver;
  if (ver.toLowerCase().startsWith(tool.toLowerCase())) return ver;
  const toolTokens = tool.toLowerCase().split(/\s+/);
  const rest = ver.split(/\s+/);
  while (rest.length && toolTokens.includes(rest[0].toLowerCase())) rest.shift();
  return rest.length ? tool + ' ' + rest.join(' ') : tool;
}

export function bindingLabel(level, L) {
  return L.bind[level] || L.bind['self-reported'];
}

export function boundTools(binding, run) {
  const tools = [...new Set(binding.logFiles.map((file) => file.checker))];
  const label = toolLabel(run);
  if (tools.length === 1 && run?.toolVersion
    && run.tool.toLowerCase().split(/[^a-z0-9+]+/).includes(tools[0].toLowerCase())) return label;
  return tools.join(', ');
}

export function ruleEvidenceDetails(rule, board, binding, L) {
  const ref = Object.hasOwn(binding.refs, rule.id) ? binding.refs[rule.id] : null;
  const source = ref ? ref.file + ':' + ref.line + (ref.line === ref.endLine ? '' : '-' + ref.endLine) : '';
  const ids = binding.ruleEvidence && Object.hasOwn(binding.ruleEvidence, rule.id) ? binding.ruleEvidence[rule.id] : [];
  const logFiles = binding.logFiles.filter((file) => ids.includes(file.file));
  return {
    ref, source, logFiles,
    tool: boundTools({ logFiles }, board.run) || (binding.logFiles.length ? L.noVerdict : toolLabel(board.run)),
  };
}

export function footerMarkup(p, board, binding, L, specHash = binding.specHash || board.run.specHash) {
  const tool = boundTools(binding, board.run) || toolLabel(board.run);
  return '<footer class="pc-foot" data-provenance-note="' + p.kind + '"><span>' + esc(provNote(p, board, binding, L)) + '</span><span class="pc-spacer"></span>' +
    '<code>run: ' + esc(board.runId) + '</code>' + (specHash ? '<code>spec: ' + esc(String(specHash).slice(0, 19)) + '</code>' : '') +
    '<code>tool: ' + esc(tool) + '</code></footer>';
}

// What the models behind this board do not cover (board.outOfScope), shown under the main view.
export function oosMarkup(board, L, open) {
  return '<details class="pc-oos"' + (open ? ' open' : '') + '><summary>' + esc(L.oosTitle) + '</summary><ul>' +
    board.outOfScope.map((o) => '<li><b>' + esc(o.area) + '</b>' + esc(o.reason) + '</li>').join('') + '</ul></details>';
}

export function provLabel(p, L) {
  const v = p.verifiedCount;
  const t = p.total;
  if (p.kind === 'verified') return L.prov.counted(p.level === 'spec-and-log' ? bindingLabel(p.level, L) : L.provSelf[p.level] || L.provSelf['self-reported'], v, t);
  if (p.kind === 'failed') return L.prov.failed(p.failedCount, v, t);
  if (p.kind === 'mixed') return L.prov.mixed(v, t);
  if (p.kind === 'sample') return L.prov.sample;
  return L.prov.unverified(v, t);
}

export function provenanceBadge(p, L) {
  return '<span class="pc-prov pc-prov-' + p.tone + '" data-provenance="' + p.kind + '"><span class="pc-prov-dot" aria-hidden="true"></span>' + esc(provLabel(p, L)) + '</span>';
}

export function provNote(p, board, binding, L) {
  const N = L.note;
  let status;
  if (p.kind === 'verified') status = N.verified(p.total, p.level === 'self-reported');
  else if (p.kind === 'failed') status = N.failed(p.failedCount, p.verifiedCount, p.total);
  else if (p.kind === 'mixed') status = p.pendingCount ? N.mixedPending(p.verifiedCount, p.total, p.pendingCount) : N.mixedAll(p.total);
  else if (p.kind === 'sample') status = N.sample;
  else status = N.unverified(p.verifiedCount, p.total);

  let evidence = '';
  if (p.level === 'spec-and-log') evidence = N.specAndLog(boundTools(binding, board.run), binding.logHash, binding.specHash);
  else if (p.level === 'spec-only') evidence = N.specOnly(binding.specHash);
  else if (p.level === 'log-only') evidence = N.logOnly(boundTools(binding, board.run), binding.logHash);
  else if (p.kind !== 'verified') evidence = N.selfReported;
  return status + (evidence ? L.sep + evidence : '') + (board.provenanceNote ? L.sep + N.boardNote(board.provenanceNote) : '');
}

export function logLineTone(line) {
  if (/^\[ok\]|no violation|holds\b/i.test(line)) return 'good';
  if (/✗|VIOLATION|=\s*false|buggy|fail|error/i.test(line)) return 'bad';
  if (/✓|confirmed|locked|blocked|ok\b|rejected|keep|true\b/i.test(line)) return 'good';
  return '';
}

// One line per rule, grouped by module, so the no-JS fallback stays small at 100+ rules.
function renderNoscript(board, title, prov, L) {
  const groups = Array.isArray(board.modules)
    ? board.modules.map((m) => ({ title: m.title, items: board.rules.filter((r) => r.moduleId === m.id) }))
    : [{ title: '', items: board.rules }];
  const body = groups.map((g) => {
    const lis = g.items.map((r) => `<li>${esc(r.no)}. ${esc(r.title)}: ${esc(L.noscript[ruleStatus(r)])}</li>`).join('');
    return `${g.title ? `<h2>${esc(g.title)}</h2>` : ''}<ul>${lis}</ul>`;
  }).join('');
  return `<noscript><div class="pc-noscript"><p><strong>${esc(title)}</strong> (${esc(provLabel(prov, L))})</p>${body}</div></noscript>`;
}

// Page-level rules exist only in standalone mode; an embedded board styles nothing outside .pc-root.
const STANDALONE_CSS = 'html, body { margin: 0; padding: 0; } body { background: #fafafa; color: #09090b; }';

const CSS = `
.pc-root {
  --pc-surface: #ffffff; --pc-bg: #fafafa; --pc-hover: #f4f4f5;
  --pc-ink: #09090b; --pc-ink-2: #52525b; --pc-ink-3: #71717a;
  --pc-bd: #e4e4e7; --pc-bd-strong: #d4d4d8; --pc-control: #18181b;
  --pc-good: #15803d; --pc-good-bg: #f0fdf4; --pc-good-bd: #bbf7d0;
  --pc-bad: #b91c1c; --pc-bad-bg: #fef2f2; --pc-bad-bd: #fecaca;
  --pc-info: #1d4ed8; --pc-info-bg: #eff6ff; --pc-info-bd: #bfdbfe;
  --pc-warn: #b45309; --pc-warn-bg: #fffbeb; --pc-warn-bd: #fde68a;
  --t-source-f: #fafafa; --t-source-s: #a1a1aa;
  --t-gate-f: #ffffff;   --t-gate-s: #52525b;
  --t-pass-f: #f0fdf4;   --t-pass-s: #4ade80;
  --t-hold-f: #fffbeb;   --t-hold-s: #f59e0b;
  --t-stop-f: #fef2f2;   --t-stop-s: #f87171;
  --chip-good-f: #f0fdf4; --chip-bad-f: #fef2f2; --chip-neutral-f: #f4f4f5;
  --pc-shadow-1: 0 1px 2px rgb(0 0 0 / 0.04);
  --pc-font: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --pc-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace;
  font-family: var(--pc-font); color: var(--pc-ink); background: var(--pc-bg);
  color-scheme: light; font-size: 14px; line-height: 1.5; -webkit-font-smoothing: antialiased;
}
.pc-root * { box-sizing: border-box; }
.pc-root button, .pc-root select, .pc-root input { font: inherit; color: inherit; }
.pc-root button { cursor: pointer; }
.pc-root button:disabled { cursor: not-allowed; }
.pc-root h1, .pc-root h2, .pc-root h3, .pc-root p { margin: 0; }
.pc-root code, .pc-root pre { font-family: var(--pc-mono); }
.pc-root :focus-visible { outline: 2px solid var(--pc-control); outline-offset: 2px; }
.pc-root svg { flex: none; }

/* Header */
.pc-head { display: flex; align-items: center; gap: 12px; min-height: 50px; padding: 10px 20px; background: var(--pc-surface); border-bottom: 1px solid var(--pc-bd); }
.pc-root[data-mode="embed"] .pc-head { padding: 7px 14px; min-height: 44px; }
.pc-brand { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1 1 auto; }
.pc-title { font-weight: 650; font-size: 15px; letter-spacing: -0.02em; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pc-sub { font-size: 12px; line-height: 1.4; color: var(--pc-ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pc-root[data-mode="embed"] .pc-sub { display: none; }
.pc-head-right { display: inline-flex; align-items: center; gap: 8px; flex: none; }
.pc-spacer { flex: 1; min-width: 8px; }

/* Floating bar over the dot-grid canvas (pill bar or toolbar) */
.pc-float-wrap { position: sticky; top: 12px; z-index: 20; display: flex; justify-content: center; margin: 0 auto 18px; pointer-events: none; }
.pc-root[data-mode="embed"] .pc-float-wrap { top: 8px; margin-bottom: 14px; }
.pc-float-bar {
  pointer-events: auto; display: inline-flex; align-items: center; gap: 3px; flex-wrap: wrap; justify-content: center;
  max-width: 100%; padding: 4px 5px; background: rgb(255 255 255 / 0.94);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
  border: 1px solid var(--pc-bd); border-radius: 12px;
  box-shadow: 0 2px 10px rgb(9 9 11 / 0.06), 0 1px 2px rgb(9 9 11 / 0.04);
}
.pc-float-bar button {
  border: 0; background: transparent; padding: 5px 11px; border-radius: 8px; min-height: 30px;
  font-size: 12.5px; font-weight: 500; color: var(--pc-ink-2); white-space: nowrap;
  display: inline-flex; align-items: center; gap: 5px; transition: background 0.14s ease, color 0.14s ease;
}
.pc-float-bar button:hover:not([aria-pressed="true"]) { background: var(--pc-hover); color: var(--pc-ink); }
.pc-float-bar button[aria-pressed="true"] { background: var(--pc-control); color: #ffffff; font-weight: 600; box-shadow: 0 1px 2px rgb(9 9 11 / 0.14); }
.pc-float-no { font-variant-numeric: tabular-nums; color: var(--pc-ink-3); font-size: 12px; font-weight: 600; }
.pc-float-bar button[aria-pressed="true"] .pc-float-no { color: rgb(255 255 255 / 0.68); }
.pc-float-sep { width: 1px; height: 18px; background: var(--pc-bd); margin: 0 3px; flex: none; }
.pc-float-bar svg { width: 13.5px; height: 13.5px; }

/*@index*/
.pc-seg { display: inline-flex; align-items: center; gap: 2px; padding: 2px; border-radius: 9px; background: var(--pc-hover); }
.pc-float-bar .pc-seg button { min-height: 26px; padding: 3px 9px; border-radius: 7px; }
.pc-float-bar .pc-seg button[aria-pressed="true"] { background: var(--pc-surface); color: var(--pc-ink); box-shadow: 0 1px 2px rgb(9 9 11 / 0.10); }
.pc-seg .n { font-variant-numeric: tabular-nums; color: var(--pc-ink-3); font-weight: 600; font-size: 11.5px; }
.pc-seg button[aria-pressed="true"] .n { color: var(--pc-ink-2); }
.pc-seg button:disabled { opacity: 0.45; }
.pc-tb-icon { padding: 5px 7px !important; }
/*@end*/

/*@index,flow*/
.st-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; display: inline-block; }
.st-dot.st-verified { background: var(--pc-good); }
.st-dot.st-failed { background: var(--pc-bad); }
.st-dot.st-pending { background: transparent; border: 1.5px dashed var(--pc-warn); }
.st-pill { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 600; border-radius: 999px; padding: 1px 9px; border: 1px solid; white-space: nowrap; }
.st-pill.st-verified { color: var(--pc-good); background: var(--pc-good-bg); border-color: var(--pc-good-bd); }
.st-pill.st-failed { color: var(--pc-bad); background: var(--pc-bad-bg); border-color: var(--pc-bad-bd); }
.st-pill.st-pending { color: var(--pc-warn); background: var(--pc-warn-bg); border-color: var(--pc-warn-bd); border-style: dashed; }
/*@end*/

/*@oos*/
/* Out of scope: a calm note under the main view */
.pc-oos { margin-top: 14px; padding: 10px 14px; border: 1px dashed var(--pc-bd-strong); border-radius: 12px; background: var(--pc-surface); font-size: 12.5px; line-height: 1.5; color: var(--pc-ink-2); overflow-wrap: anywhere; }
.pc-oos summary { cursor: pointer; font-weight: 600; color: var(--pc-ink); }
.pc-oos ul { margin: 6px 0 0; padding-left: 18px; }
.pc-oos b { font-weight: 600; color: var(--pc-ink); margin-right: 0.6em; }
/*@end*/

/* Provenance pill */
.pc-prov { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 500; font-variant-numeric: tabular-nums; border-radius: 999px; padding: 3px 10px; white-space: nowrap; background: var(--pc-surface); border: 1px solid var(--pc-bd); color: var(--pc-ink-2); }
.pc-prov-dot { width: 6px; height: 6px; border-radius: 50%; flex: none; display: inline-block; }
.pc-prov-good { color: var(--pc-good); background: var(--pc-good-bg); border-color: var(--pc-good-bd); }
.pc-prov-good .pc-prov-dot { background: var(--pc-good); }
.pc-prov-warn { color: var(--pc-warn); background: var(--pc-warn-bg); border-color: var(--pc-warn-bd); border-style: dashed; }
.pc-prov-warn .pc-prov-dot { background: var(--pc-warn); }
.pc-prov-bad { color: var(--pc-bad); background: var(--pc-bad-bg); border-color: var(--pc-bad-bd); }
.pc-prov-bad .pc-prov-dot { background: var(--pc-bad); }

/* Dot-grid canvas */
.pc-canvas { background-color: var(--pc-bg); background-image: radial-gradient(rgba(9, 9, 11, 0.12) 1.25px, transparent 1.25px); background-size: 20px 20px; padding: 16px 24px 28px; }
.pc-root[data-mode="embed"] .pc-canvas { padding: 12px 14px 16px; }
.pc-wrap { max-width: 1260px; margin: 0 auto; }
.pc-main { container-type: inline-size; min-width: 0; }

/*@index*/
/* Index layout: rule index + main */
.pc-split { max-width: 1400px; margin: 0 auto; display: grid; grid-template-columns: 256px minmax(0, 1fr); gap: 16px; align-items: start; }
.pc-split[data-index="closed"] { grid-template-columns: minmax(0, 1fr); max-width: 1260px; }
.pc-split[data-index="closed"] .pc-index { display: none; }
.pc-index { position: sticky; top: 64px; max-height: 720px; overflow: auto; overscroll-behavior: contain; padding: 6px; background: var(--pc-surface); border: 1px solid var(--pc-bd); border-radius: 12px; box-shadow: var(--pc-shadow-1); scrollbar-width: thin; }
.pc-root[data-mode="embed"] .pc-index { top: 56px; }
@media (max-width: 860px) {
  .pc-split { grid-template-columns: minmax(0, 1fr); }
  .pc-index { position: static; max-height: 300px; }
}
.ix-head { display: flex; align-items: baseline; gap: 6px; padding: 4px 8px 6px; font-size: 11.5px; font-weight: 600; color: var(--pc-ink-3); letter-spacing: 0.01em; }
.ix-head .ix-count { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 500; }
.ix-group + .ix-group { margin-top: 4px; padding-top: 4px; border-top: 1px solid var(--pc-bd); }
.ix-mod { display: flex; align-items: center; gap: 7px; padding: 5px 8px; }
.ix-mod-title { flex: 1; min-width: 0; font-size: 12px; font-weight: 600; color: var(--pc-ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ix-mod-c { font-size: 11px; font-variant-numeric: tabular-nums; color: var(--pc-ink-3); white-space: nowrap; flex: none; }
.ix-mod-c b { color: var(--pc-bad); font-weight: 600; }
.ix-list { list-style: none; margin: 0; padding: 0 0 2px; }
.ix-row { width: 100%; display: flex; align-items: center; gap: 8px; border: 0; background: transparent; border-radius: 7px; padding: 5px 8px 5px 10px; min-height: 28px; text-align: left; color: var(--pc-ink-2); }
.ix-row:hover { background: var(--pc-hover); color: var(--pc-ink); }
.ix-row[aria-current="true"] { background: var(--pc-control); color: #ffffff; }
.ix-row[aria-current="true"] .ix-no { color: rgb(255 255 255 / 0.7); }
.ix-row[aria-current="true"] .st-dot.st-pending { border-color: #fcd34d; }
.ix-no { font-size: 11.5px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--pc-ink-3); min-width: 20px; text-align: right; flex: none; }
.ix-t { flex: 1; min-width: 0; font-size: 12.5px; line-height: 1.35; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }

/* Focus breadcrumb */
.pc-crumb { display: flex; align-items: center; gap: 8px; margin: 0 0 12px; min-height: 32px; font-size: 12.5px; color: var(--pc-ink-3); min-width: 0; }
.crumb-mod { font-weight: 600; color: var(--pc-ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.crumb-sep { color: var(--pc-bd-strong); }
.crumb-pos { font-variant-numeric: tabular-nums; white-space: nowrap; }
.crumb-btn { display: inline-grid; place-items: center; width: 28px; height: 28px; border: 1px solid var(--pc-bd); background: var(--pc-surface); border-radius: 7px; color: var(--pc-ink-2); padding: 0; }
.crumb-btn:hover:not(:disabled) { border-color: var(--pc-bd-strong); color: var(--pc-ink); }
.crumb-btn:disabled { opacity: 0.4; }
.crumb-btn svg { width: 15px; height: 15px; }
/*@end*/

/* Split board: figure card -> connector -> live preview. --pc-gap also caps the connector label width. */
.board { --pc-gap: 96px; position: relative; display: grid; grid-template-columns: minmax(0, 1fr) 340px; column-gap: var(--pc-gap); align-items: stretch; }
@container (max-width: 1100px) { .board { --pc-gap: 80px; grid-template-columns: minmax(0, 1fr) 288px; } }
@container (max-width: 900px) { .board { grid-template-columns: minmax(0, 1fr); row-gap: 16px; } .link-layer, .lk-label, .fg-port, .fg-lead { display: none; } }
.link-layer { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 3; }
.card { background: var(--pc-surface); border: 1px solid var(--pc-bd); border-radius: 12px; box-shadow: var(--pc-shadow-1); }
.fig { padding: 18px 20px 14px; display: flex; flex-direction: column; min-width: 0; }
@container (max-width: 1100px) { .fig { padding: 16px 16px 12px; } }
.fig-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.no { display: inline-grid; place-items: center; min-width: 24px; height: 24px; padding: 0 5px; border-radius: 6px; border: 1px solid var(--pc-bd); background: var(--pc-surface); color: var(--pc-ink-2); font-weight: 600; font-size: 12.5px; font-variant-numeric: tabular-nums; flex: none; }
.fig-title { font-size: 16.5px; font-weight: 650; letter-spacing: -0.015em; line-height: 1.35; min-width: 0; }
.fig-sub { font-size: 12px; color: var(--pc-ink-3); margin-left: auto; white-space: nowrap; }
.fx { display: flex; gap: 6px; margin: 12px 0 8px; flex-wrap: wrap; align-items: center; }
.fx-cue { font-size: 11px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--pc-ink-3); }
.fx-seg { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px; border: 1px solid var(--pc-bd); border-radius: 16px; background: var(--pc-bg); }
.fx button { font-size: 12.5px; font-weight: 500; padding: 4px 12px; min-height: 28px; border-radius: 999px; border: 1px solid var(--pc-bd); background: var(--pc-surface); color: var(--pc-ink-2); }
.fx button:hover:not(.is-on) { border-color: var(--pc-bd-strong); color: var(--pc-ink); }
.fx-seg button { border-color: transparent; background: transparent; min-height: 26px; }
.fx button.is-on { color: #ffffff; border-color: transparent; font-weight: 600; }
.fx .fx-normal.is-on { background: var(--pc-info); }
.fx .fx-bug.is-on { background: var(--pc-bad); }
.fx .fx-safe.is-on { background: var(--pc-good); }
.fx-prop { margin-left: auto; font-family: var(--pc-mono); font-size: 11.5px; color: var(--pc-ink-3); background: var(--pc-bg); border: 1px solid var(--pc-bd); border-radius: 6px; padding: 2px 8px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fg-wrap { position: relative; margin: 8px auto 0; width: 100%; max-width: 740px; }
.fg-svg { display: block; width: 100%; height: auto; overflow: visible; font-family: var(--pc-font); }
.fg-svg .fg-box, .fg-svg .fg-arrow { transition: opacity 0.22s ease; }
.fg-svg .is-dim { opacity: 0.20; }
.fg-box rect { stroke-width: 1px; }
.fg-box > text.fg-blabel { font-weight: 600; fill: var(--pc-ink); }
.tone-source > rect { fill: var(--t-source-f); stroke: var(--t-source-s); }
.tone-gate > rect { fill: var(--t-gate-f); stroke: var(--t-gate-s); }
.tone-pass > rect { fill: var(--t-pass-f); stroke: var(--t-pass-s); }
.tone-stop > rect { fill: var(--t-stop-f); stroke: var(--t-stop-s); }
.tone-hold > rect { fill: var(--t-hold-f); stroke: var(--t-hold-s); }
.fg-svg .is-on > rect { stroke-width: 1.6px; }
.fg-svg .is-here > rect { stroke-width: 2.6px; stroke: var(--hot); }
.fg-line { fill: none; stroke: #a1a1aa; stroke-width: 1.4px; stroke-linecap: round; }
.fg-head { fill: #a1a1aa; }
.fg-head-hot { fill: var(--hot); }
.is-on .fg-line { stroke: var(--hot); stroke-width: 2.5px; }
.fg-flow { fill: none; stroke: var(--pc-surface); stroke-width: 2.5px; stroke-linecap: round; stroke-dasharray: 0.1 14; animation: pc-fgflow 0.9s linear infinite; opacity: 0.92; }
@keyframes pc-fgflow { to { stroke-dashoffset: -14.1; } }
.fg-alabel { fill: var(--pc-ink-2); font-weight: 500; }
.fg-apill { fill: var(--pc-surface); opacity: 0.96; }
.is-on .fg-alabel { fill: var(--hot); font-weight: 600; }
.fg-life { stroke: var(--pc-bd-strong); stroke-width: 1.4px; stroke-dasharray: 4 5; }
.fg-badge circle { fill: var(--hot); }
.fg-badge text { fill: #ffffff; font-weight: 700; }
.fg-dot { fill: #a1a1aa; }
.fg-svg .is-here .fg-line { stroke-width: 3.4px; }
.fg-svg .is-here .fg-apill { stroke: var(--hot); stroke-width: 1.5px; }
.is-forbid .fg-line { stroke-dasharray: 7 5; }
.is-forbid.is-on .fg-line { stroke: var(--pc-bad); }
.is-forbid.is-on .fg-alabel { fill: var(--pc-bad); }
.fg-head-bad { fill: var(--pc-bad); }
.fg-stop { fill: none; stroke: var(--pc-bad); stroke-width: 2.6px; }
.fg-lead { fill: none; stroke: var(--hot); stroke-width: 1.5px; stroke-dasharray: 2 4; }
.fg-port { fill: var(--hot); }
.fg-box > text.fg-brole { fill: var(--pc-ink-3); font-weight: 500; }
.fg-chip rect { stroke-width: 1px; }
.fg-chip text { font-weight: 600; }
.chip-good rect { fill: var(--chip-good-f); stroke: #86efac; }
.chip-good text { fill: var(--pc-good); }
.chip-bad rect { fill: var(--chip-bad-f); stroke: #fca5a5; }
.chip-bad text { fill: var(--pc-bad); }
.chip-neutral rect { fill: var(--chip-neutral-f); stroke: var(--pc-bd); }
.chip-neutral text { fill: var(--pc-ink-2); }
.take { margin: 14px 0 0; text-align: center; font-size: 14.5px; font-weight: 600; line-height: 1.55; min-height: 42px; text-wrap: balance; }
.take-normal { color: var(--pc-info); }
.take-bug { color: var(--pc-bad); }
.take-safe { color: var(--pc-good); }
.src { margin: auto 0 0; padding-top: 8px; text-align: center; font-size: 12px; color: var(--pc-ink-3); }

/* Semantic connector */
.lk-path { fill: none; stroke-width: 2px; }
.lk-normal { stroke: var(--pc-info); }
.lk-safe { stroke: var(--pc-good); stroke-width: 2.25px; }
.lk-bug { stroke: var(--pc-bad); stroke-width: 2.25px; stroke-dasharray: 8 6; animation: pc-sedash 0.6s linear infinite; }
@keyframes pc-sedash { to { stroke-dashoffset: -14; } }
.lk-dot { stroke: var(--pc-surface); stroke-width: 1.5px; }
.lk-dot-normal, .lk-head-normal { fill: var(--pc-info); }
.lk-dot-safe, .lk-head-safe { fill: var(--pc-good); }
.lk-dot-bug, .lk-head-bug { fill: var(--pc-bad); }
/* The label sits above the connector midpoint and never grows wider than the gap, so it cannot cover either card. */
.lk-label { position: absolute; z-index: 4; transform: translate(-50%, calc(-100% - 6px)); max-width: calc(var(--pc-gap) - 12px); font-size: 11px; font-weight: 600; line-height: 1.25; padding: 2px 7px; border-radius: 9px; background: var(--pc-surface); border: 1px solid var(--pc-bd); box-shadow: var(--pc-shadow-1); text-align: center; overflow-wrap: anywhere; pointer-events: none; }
.lk-label-normal { color: var(--pc-info); border-color: var(--pc-info-bd); }
.lk-label-bug { color: var(--pc-bad); border-color: var(--pc-bad-bd); }
.lk-label-safe { color: var(--pc-good); border-color: var(--pc-good-bd); }

/* Live preview card */
.pv { overflow: hidden; display: flex; flex-direction: column; min-width: 0; }
.pv-normal { border-color: #93c5fd; }
.pv-bug { border-color: #fca5a5; }
.pv-safe { border-color: #86efac; }
.pv-chrome { display: flex; align-items: center; gap: 8px; padding: 11px 16px; background: var(--pc-surface); border-bottom: 1px solid var(--pc-bd); }
.pv-title { font-size: 13.5px; font-weight: 650; letter-spacing: -0.01em; flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pv-live { display: inline-flex; align-items: center; gap: 5px; font-size: 11.5px; font-weight: 500; color: var(--pc-ink-3); white-space: nowrap; }
.pv-live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--pc-good); }
.pv-live-normal .pv-live-dot { background: var(--pc-info); }
.pv-live-bug .pv-live-dot { background: var(--pc-bad); }
.board.is-swap .fg-wrap, .board.is-swap .pv-body { animation: pc-swap 0.26s ease; }
@keyframes pc-swap { from { opacity: 0.35; } }
.pv-body { padding: 14px 16px 16px; display: flex; flex-direction: column; gap: 7px; flex: 1; }
.pv-badge { align-self: flex-start; font-size: 12px; font-weight: 600; border-radius: 6px; padding: 2px 9px; margin-bottom: 3px; border: 1px solid transparent; }
.pv-badge-normal { color: var(--pc-info); background: var(--pc-info-bg); border-color: var(--pc-info-bd); }
.pv-badge-bug { color: var(--pc-bad); background: var(--pc-bad-bg); border-color: var(--pc-bad-bd); }
.pv-badge-safe { color: var(--pc-good); background: var(--pc-good-bg); border-color: var(--pc-good-bd); }
.pv-bars { display: flex; flex-direction: column; gap: 6px; padding: 8px 10px; border-radius: 8px; background: var(--pc-bg); border: 1px solid var(--pc-bd); }
.pv-bar-row { display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.pv-bar-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; min-width: 0; }
.pv-bar-lbl { min-width: 0; overflow-wrap: anywhere; color: var(--pc-ink-2); font-weight: 500; }
.pv-bar { position: relative; height: 8px; background: var(--pc-hover); border-radius: 4px; }
.pv-bar i { position: absolute; left: 0; top: 0; bottom: 0; border-radius: 4px; background: var(--pc-good); transition: width 0.25s ease; }
.pv-bar i.is-bad { background: var(--pc-bad); }
.pv-bar u { position: absolute; top: -3px; bottom: -3px; width: 1.5px; background: var(--pc-ink-2); text-decoration: none; }
.pv-bar-val { font-variant-numeric: tabular-nums; white-space: nowrap; font-size: 12px; font-weight: 600; }
.pv-row { display: flex; justify-content: space-between; gap: 10px; padding: 6px 10px; border-radius: 6px; background: var(--pc-bg); align-items: baseline; }
.pv-k { font-size: 12.5px; color: var(--pc-ink-2); white-space: nowrap; }
.pv-v { font-weight: 600; font-size: 13px; text-align: right; font-variant-numeric: tabular-nums; min-width: 0; overflow-wrap: anywhere; }
.t-normal { color: var(--pc-ink); }
.t-ok { color: var(--pc-good); }
.t-bad { color: var(--pc-bad); }
.t-warn { color: var(--pc-warn); }
.t-mute { color: var(--pc-ink-3); }
.pv-log { font-family: var(--pc-mono); font-size: 11px; line-height: 1.55; color: var(--pc-ink-3); border: 1px solid var(--pc-bd); border-left: 2px solid var(--pc-bd-strong); padding: 6px 9px; display: flex; flex-direction: column; gap: 1px; background: var(--pc-bg); border-radius: 6px; overflow-wrap: anywhere; margin-top: 2px; }
.pv-log .bad { color: var(--pc-bad); font-weight: 600; }
.pv-log .good { color: var(--pc-good); font-weight: 600; }
.pv-action { margin-top: auto; display: flex; flex-direction: column; gap: 8px; padding-top: 8px; }
.pv-banner { display: flex; gap: 7px; align-items: center; font-size: 12.5px; font-weight: 500; padding: 7px 10px; border-radius: 8px; border: 1px solid transparent; }
.pv-banner svg { width: 15px; height: 15px; }
.ban-normal { color: var(--pc-info); border-color: var(--pc-info-bd); background: var(--pc-info-bg); }
.ban-bug { color: var(--pc-bad); border-color: var(--pc-bad-bd); background: var(--pc-bad-bg); }
.ban-safe { color: var(--pc-good); border-color: var(--pc-good-bd); background: var(--pc-good-bg); }
.pv-btn { font-size: 13px; font-weight: 500; padding: 9px 14px; border-radius: 8px; border: 0; display: flex; gap: 6px; align-items: center; justify-content: center; min-height: 38px; }
.pv-btn svg { width: 15px; height: 15px; }
.pv-btn-ok { background: var(--pc-control); color: #ffffff !important; }
.pv-btn-danger { background: var(--pc-bad); color: #ffffff !important; }
.pv-btn-locked { background: var(--pc-hover); color: var(--pc-ink-3) !important; border: 1px dashed var(--pc-bd-strong); }

/* Evidence */
.ev { padding: 14px 18px; margin-top: 18px; }
.ev-head { margin: 0; font-size: 13.5px; font-weight: 600; }
.ev-tg { width: calc(100% + 16px); margin: -6px -8px; padding: 6px 8px; border: 0; border-radius: 8px; background: transparent; display: flex; align-items: center; gap: 7px; text-align: left; color: var(--pc-ink); transition: background 0.14s ease; }
.ev-tg:hover { background: var(--pc-hover); }
.ev-chev { display: inline-flex; align-items: center; color: var(--pc-ink-3); flex: none; }
.ev-chev svg { width: 14px; height: 14px; rotate: -90deg; }
.ev-tg[aria-expanded="true"] .ev-chev svg { rotate: 0deg; }
.ev-tg:hover .ev-chev { color: var(--pc-ink); }
.ev-shield { display: inline-flex; align-items: center; color: var(--pc-ink-2); flex: none; }
.ev-shield svg { width: 15px; height: 15px; }
.ev-cue { font-size: 12px; font-weight: 500; color: var(--pc-ink-3); margin-left: 4px; }
.ev-tg:hover .ev-cue { color: var(--pc-ink-2); }
@media (prefers-reduced-motion: no-preference) { .ev-chev svg { transition: rotate 0.18s ease; } }
.ev-facts { list-style: none; margin: 8px 0 0; padding: 0; display: flex; flex-wrap: wrap; gap: 6px 14px; font-size: 12px; color: var(--pc-ink-2); }
.ev-facts li { display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums; min-width: 0; }
.ev-facts li::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: var(--pc-bd-strong); flex: none; }
.ev-facts li.ok { color: var(--pc-good); }
.ev-facts li.ok::before { background: var(--pc-good); }
.ev-facts li.warn { color: var(--pc-warn); }
.ev-facts li.warn::before { background: var(--pc-warn); }
.ev-facts li.bad { color: var(--pc-bad); }
.ev-facts li.bad::before { background: var(--pc-bad); }
.ev-body { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--pc-bd); display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px 20px; font-size: 12.5px; color: var(--pc-ink-2); }
@container (max-width: 760px) { .ev-body { grid-template-columns: minmax(0, 1fr); } }
.ev-sec { font-weight: 600; color: var(--pc-ink-3); margin-bottom: 5px; font-size: 11.5px; letter-spacing: 0.01em; }
.ev-rule { color: var(--pc-ink); line-height: 1.55; }
.ev-quote { margin: 0; padding: 4px 10px; border-left: 2px solid var(--pc-bd-strong); color: var(--pc-ink-2); line-height: 1.55; }
.ev-impacts { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; }
.ev-imp { font-size: 12px; padding: 6px 9px; border-radius: 7px; background: var(--pc-bg); border: 1px solid var(--pc-bd); color: var(--pc-ink); }
.ev-imp b { margin-right: 6px; font-weight: 600; }
.term { margin: 0; background: var(--pc-bg); color: var(--pc-ink-2); border: 1px solid var(--pc-bd); border-radius: 8px; padding: 10px 12px; font: 11.5px/1.6 var(--pc-mono); white-space: pre-wrap; overflow: auto; max-height: 220px; }
.kv { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; align-items: baseline; }
.kv span:nth-child(odd) { color: var(--pc-ink-3); white-space: nowrap; }
.kv span:nth-child(even) { color: var(--pc-ink); font-variant-numeric: tabular-nums; }
.kv code { font-family: var(--pc-mono); font-size: 11.5px; color: var(--pc-ink-2); word-break: break-all; }

/*@compact*/
/* Compact overview (small boards): clean header, unobstructed scaled preview, opaque takeaway */
.ov-bar { display: flex; align-items: center; gap: 10px; margin-bottom: 14px; flex-wrap: wrap; }
.ov-bar .fx { margin: 0; }
.ov-hint { font-size: 12.5px; color: var(--pc-ink-3); }
.ov-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; align-items: stretch; }
.ov-grid.is-single { grid-template-columns: minmax(0, 1fr); max-width: 820px; margin: 0 auto; }
@container (max-width: 860px) { .ov-grid { grid-template-columns: minmax(0, 1fr); } }
.ov-cell { position: relative; display: flex; flex-direction: column; min-width: 0; overflow: hidden; border-radius: 12px; border: 1px solid var(--pc-bd); background: var(--pc-surface); box-shadow: var(--pc-shadow-1); transition: border-color 0.16s ease, box-shadow 0.16s ease; }
.ov-cell:hover, .ov-cell:has(.ov-open:hover) { border-color: var(--pc-control); box-shadow: 0 4px 14px rgb(9 9 11 / 0.08); }
.ov-cell:has(.ov-open:focus-visible) { outline: 2px solid var(--pc-control); outline-offset: 2px; }
.ov-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; background: var(--pc-surface); border-bottom: 1px solid var(--pc-bd); min-width: 0; }
.ov-open { border: 0; background: transparent; padding: 0; text-align: left; font-size: 14.5px; font-weight: 650; letter-spacing: -0.01em; line-height: 1.3; color: var(--pc-ink); text-wrap: balance; min-width: 0; }
.ov-open::after { content: ""; position: absolute; inset: 0; z-index: 4; }
.ov-open:focus-visible { outline: none; }
.ov-badge { margin-left: auto; margin-bottom: 0; font-size: 11.5px; flex: none; white-space: nowrap; }
.ov-stage { position: relative; flex: 0 0 auto; overflow: hidden; background: var(--pc-bg); }
.ov-scale { transform-origin: top left; pointer-events: none; padding: 12px; }
.ov-scale .take, .ov-scale .src { display: none; }
.ov-take { flex: 1; display: flex; align-items: center; padding: 11px 14px; background: var(--pc-surface); border-top: 1px solid var(--pc-bd); font-size: 13px; font-weight: 600; line-height: 1.5; text-wrap: pretty; line-break: strict; }
/*@end*/

/*@index*/
/* Hub-and-spoke overview (index layout): one hub card per module, numbered rule spokes */
.hv-sum { display: flex; align-items: center; gap: 8px 18px; flex-wrap: wrap; margin: 0 0 14px; padding: 10px 14px; background: var(--pc-surface); border: 1px solid var(--pc-bd); border-radius: 12px; box-shadow: var(--pc-shadow-1); font-size: 12.5px; color: var(--pc-ink-2); }
.hv-stat { display: inline-flex; align-items: baseline; gap: 5px; white-space: nowrap; }
.hv-stat b { font-size: 18px; font-weight: 650; color: var(--pc-ink); font-variant-numeric: tabular-nums; letter-spacing: -0.02em; }
.hv-stat.ok b { color: var(--pc-good); }
.hv-stat.bad b { color: var(--pc-bad); }
.hv-stat.warn b { color: var(--pc-warn); }
.hv-hint { margin-left: auto; color: var(--pc-ink-3); font-size: 12px; }
.hv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 14px; align-items: start; }
.hub { background: var(--pc-surface); border: 1px solid var(--pc-bd); border-radius: 12px; box-shadow: var(--pc-shadow-1); padding: 12px 12px 10px; min-width: 0; }
.hub.has-fail { border-color: var(--pc-bad-bd); }
.hub-head { width: 100%; display: flex; align-items: center; gap: 8px; border: 0; background: transparent; padding: 2px 2px 0; text-align: left; border-radius: 8px; }
.hub-head:hover .hub-title { text-decoration: underline; text-underline-offset: 3px; }
.hub-title { flex: 1; min-width: 0; font-size: 14px; font-weight: 650; letter-spacing: -0.01em; line-height: 1.35; color: var(--pc-ink); }
.hub-n { font-size: 11.5px; color: var(--pc-ink-3); font-variant-numeric: tabular-nums; white-space: nowrap; flex: none; }
.hub-sum { margin: 6px 2px 0; font-size: 12px; line-height: 1.5; color: var(--pc-ink-3); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.hub-meter { display: flex; height: 5px; border-radius: 3px; overflow: hidden; background: var(--pc-hover); margin: 9px 2px 0; }
.hub-meter i { display: block; height: 100%; }
.hub-meter .ok { background: var(--pc-good); }
.hub-meter .bad { background: var(--pc-bad); }
.hub-meter .warn { background: repeating-linear-gradient(90deg, var(--pc-warn) 0 3px, transparent 3px 5px); }
.hub-meta { display: flex; gap: 10px; margin: 5px 2px 0; font-size: 11px; color: var(--pc-ink-3); font-variant-numeric: tabular-nums; }
.hub-meta .bad { color: var(--pc-bad); font-weight: 600; }
.hub-spokes { list-style: none; margin: 8px 0 0 15px; padding: 0 0 0 12px; border-left: 1px solid var(--pc-bd-strong); display: flex; flex-direction: column; gap: 3px; }
.hub-spokes li { position: relative; min-width: 0; }
.hub-spokes li::before { content: ""; position: absolute; left: -12px; top: 50%; width: 10px; border-top: 1px solid var(--pc-bd-strong); }
.spoke { width: 100%; display: flex; align-items: center; gap: 7px; border: 1px solid var(--pc-bd); background: var(--pc-surface); border-radius: 8px; padding: 3px 8px 3px 4px; min-height: 28px; text-align: left; color: var(--pc-ink-2); }
.spoke:hover { border-color: var(--pc-control); color: var(--pc-ink); }
.spoke-no { display: inline-grid; place-items: center; min-width: 22px; height: 20px; padding: 0 4px; border-radius: 5px; font-size: 11px; font-weight: 650; font-variant-numeric: tabular-nums; flex: none; }
.spoke.st-verified .spoke-no { background: var(--pc-good-bg); color: var(--pc-good); }
.spoke.st-failed { border-color: var(--pc-bad-bd); background: var(--pc-bad-bg); color: var(--pc-bad); }
.spoke.st-failed .spoke-no { background: var(--pc-bad); color: #ffffff; }
.spoke.st-pending .spoke-no { color: var(--pc-warn); border: 1px dashed var(--pc-warn); }
.spoke-t { flex: 1; min-width: 0; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hv-grid.lod-min .hub-spokes { flex-direction: row; flex-wrap: wrap; margin-left: 2px; padding-left: 0; border-left: 0; gap: 4px; }
.hv-grid.lod-min .hub-spokes li::before { display: none; }
.hv-grid.lod-min .spoke { width: auto; padding: 2px; }
.hv-grid.lod-min .spoke-t { display: none; }
/*@end*/

/*@flow*/
/* Flow view: fixed-geometry map of stages and labeled edges. Each stage element sets its font size
   in --u (1/W of the map width) and sizes everything else in em, so the map scales as one picture. */
.fl { padding: 16px 18px 14px; }
.pc-root[data-mode="embed"] .fl { padding: 12px 14px; }
.fl-head, .fl-foot { display: flex; align-items: center; gap: 10px 16px; flex-wrap: wrap; }
.fl-title { font-size: 16.5px; font-weight: 650; letter-spacing: -0.015em; line-height: 1.35; }
.fl > .fl-cap { margin-top: 4px; font-size: 12.5px; color: var(--pc-ink-3); max-width: 880px; }
.fl-legend { margin-left: auto; display: inline-flex; gap: 12px; font-size: 11.5px; color: var(--pc-ink-3); }
.fl-legend span { display: inline-flex; align-items: center; gap: 5px; }
.fl-legend svg { width: 24px; height: 8px; }
.fl-jbar { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px; margin-top: 12px; border: 1px solid var(--pc-bd); border-radius: 16px; background: var(--pc-bg); }
.fl-jbar button { display: inline-flex; align-items: center; gap: 6px; font-size: 12.5px; font-weight: 500; padding: 3px 12px; min-height: 28px; border-radius: 999px; border: 0; background: none; color: var(--pc-ink-2); white-space: nowrap; }
.fl-jbar button:hover { color: var(--pc-ink); }
.fl-jbar button[aria-pressed="true"] { background: var(--pc-control); color: #fff; font-weight: 600; }
.fl-jdot { width: 7px; height: 7px; border-radius: 50%; background: var(--tn); }
.tn-normal { --tn: var(--pc-info); --tn-bg: var(--pc-info-bg); --tn-bd: var(--pc-info-bd); }
.tn-bug { --tn: var(--pc-bad); --tn-bg: var(--pc-bad-bg); --tn-bd: var(--pc-bad-bd); }
.tn-safe { --tn: var(--pc-good); --tn-bg: var(--pc-good-bg); --tn-bd: var(--pc-good-bd); }
.fl-canvas { --u: calc(100cqw / var(--fw)); position: relative; width: 100%; margin: 14px auto 0; container-type: inline-size; }
.fl-svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; font-family: var(--pc-font); }
.fl-edge, .fl-stage { transition: opacity 0.2s ease; }
.fl-edge.is-dim, .fl-stage.is-dim { opacity: 0.32; }
.fl-line { fill: none; stroke: #a1a1aa; stroke-width: 1.6px; stroke-linecap: round; }
.k-bypass .fl-line { stroke-dasharray: 7 5; }
.k-handoff .fl-line { stroke-dasharray: 0.1 5; stroke-width: 2.4px; }
.fl-tip { fill: #a1a1aa; }
.fl-tip-on { fill: var(--tn); }
.fl-pill { fill: var(--pc-surface); stroke: var(--pc-bd); }
.fl-elabel { fill: var(--pc-ink-2); font-weight: 500; }
.fl-edge.is-on .fl-line { stroke: var(--tn); stroke-width: 2.6px; }
.fl-edge.is-on .fl-pill { stroke: var(--tn-bd); }
.fl-edge.is-on .fl-elabel { fill: var(--tn); font-weight: 600; }
.fl-run { fill: none; stroke: var(--pc-surface); stroke-width: 2.6px; stroke-linecap: round; stroke-dasharray: 0.1 14; animation: pc-fgflow 0.9s linear infinite; }
.fl-stage { position: absolute; display: flex; flex-direction: column; overflow: hidden; font-size: calc(12 * var(--u)); padding: calc(1em - 1px); border-radius: 1em; background: var(--pc-surface); border: 1px solid var(--pc-bd); box-shadow: var(--pc-shadow-1); }
.fl-stage.has-fail { border-color: var(--pc-bad-bd); }
.fl-stage.is-on { border-color: var(--tn); box-shadow: 0 0 0 0.25em var(--tn-bg); }
.fl-stage.is-dim:hover, .fl-stage.is-dim:focus-within { opacity: 0.85; }
.fl-st-t { flex: none; font-size: calc(14.5 * var(--u)); line-height: 1.31; height: 1.31em; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fl-stage > .fl-st-s { flex: none; margin-top: 0.25em; height: 2.833em; line-height: 1.4166; color: var(--pc-ink-3); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.fl-stage > .fl-st-b { flex: none; align-self: flex-start; margin-top: 0.695em; height: 1.739em; padding: 0 0.7em; font-size: calc(11.5 * var(--u)); }
.fl-chips { list-style: none; margin: 0.666em 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.333em; }
.fl-stage .fl-chip { width: 100%; height: 2.08em; display: flex; align-items: center; gap: 0.48em; padding: 0 0.64em 0 0.32em; border: 1px solid var(--pc-bd); border-radius: 0.56em; background: var(--pc-surface); color: var(--pc-ink-2); font-size: calc(12.5 * var(--u)); text-align: left; }
.fl-stage .fl-chip:hover { border-color: var(--pc-control); color: var(--pc-ink); }
.fl-chip.is-cp { border-color: var(--tn); box-shadow: 0 0 0 0.16em var(--tn-bd); color: var(--pc-ink); font-weight: 600; }
.fl-stage .fl-chip.is-hit { border-color: currentColor; font-weight: 600; }
.fl-stage.is-off:not(.is-dim) { opacity: 0.45; }
.fl-stage:not(.is-off) .fl-chip.is-off { opacity: 0.4; }
.fl-chip-no { display: inline-grid; place-items: center; min-width: 2em; height: 1.636em; padding: 0 0.36em; border-radius: 0.45em; font-size: 0.88em; font-weight: 650; font-variant-numeric: tabular-nums; background: var(--pc-hover); }
.fl-chip.st-verified .fl-chip-no { background: var(--pc-good-bg); color: var(--pc-good); }
.fl-chip.st-failed { border-color: var(--pc-bad-bd); color: var(--pc-bad); }
.fl-chip.st-failed .fl-chip-no { background: var(--pc-bad); color: #fff; }
.fl-chip.st-pending .fl-chip-no { color: var(--pc-warn); border: 1px dashed; background: none; }
.fl-chip-t { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.fl-foot { margin-top: 14px; min-height: 36px; padding-top: 12px; border-top: 1px solid var(--pc-bd); }
.fl-sum { flex: 1 1 320px; font-size: 14px; font-weight: 600; color: var(--tn); text-wrap: pretty; }
.fl-hint { font-size: 12.5px; color: var(--pc-ink-3); }
.fl-foot .fl-cta { margin-left: auto; font-size: 13px; font-weight: 600; padding: 7px 14px; min-height: 34px; border-radius: 8px; border: 0; background: var(--pc-control); color: #fff; white-space: nowrap; }
@media (prefers-reduced-motion: reduce) { .fl-run { animation: none; } }
/*@end*/

/* Footer */
.pc-foot { padding: 9px 16px; font-size: 12px; color: var(--pc-ink-3); border-top: 1px solid var(--pc-bd); background: var(--pc-surface); display: flex; gap: 12px; flex-wrap: wrap; align-items: center; font-variant-numeric: tabular-nums; }
.pc-foot > span:first-child { min-width: 0; overflow-wrap: anywhere; }
.pc-foot code { font-family: var(--pc-mono); font-size: 11.5px; color: var(--pc-ink-2); }
.pc-noscript { padding: 16px; font-family: sans-serif; }
.pc-error { margin: 24px auto; max-width: 640px; padding: 14px 16px; border: 1px solid var(--pc-bad-bd); background: var(--pc-bad-bg); color: var(--pc-bad); border-radius: 10px; font-size: 13px; }
@media (prefers-reduced-motion: reduce) { .fg-flow, .lk-bug, .board.is-swap .fg-wrap, .board.is-swap .pv-body { animation: none; } }
`;

// Functions shared with the browser runtime. Their source is injected verbatim.
const SHARED_FNS = [ruleStatus, toolLabel, bindingLabel, boundTools, ruleEvidenceDetails, footerMarkup, provLabel, provenanceBadge, provNote, logLineTone]
  .map((f) => f.toString()).join('\n');

const CLIENT_JS = `(() => {
  const dataEl = document.getElementById(${JSON.stringify(DATA_ELEMENT_ID)});
  const root = document.getElementById(${JSON.stringify(ROOT_ELEMENT_ID)});
  if (!dataEl || !root) return;
/*@figures*/
  const MAX_TEXT = ${MAX_PAYLOAD_TEXT_BYTES};
  const MAX_DECODED = ${MAX_DECODED_BYTES};
  const BASE64 = new RegExp(${JSON.stringify(BASE64_RE.source)});
${SHARED_FNS}

  function fail(e) {
    console.error('[proof-canvas] could not show the board:', e);
    const box = document.createElement('div');
    box.className = 'pc-error';
    box.setAttribute('role', 'alert');
    box.textContent = UI(uiOptions(null)).err + String((e && e.message) || e);
    root.prepend(box);
  }

  async function decode() {
    const type = dataEl.getAttribute('type');
    const raw = dataEl.textContent || '';
    if (new TextEncoder().encode(raw).length >= MAX_TEXT) throw new Error('the board payload exceeds ' + MAX_TEXT + ' bytes.');
    let text = raw;
    if (type === ${JSON.stringify(GZIP_TYPE)}) {
      if (typeof DecompressionStream === 'undefined') throw new Error('this browser has no DecompressionStream; open the board in a current browser.');
      const b64 = raw.trim();
      if (!BASE64.test(b64)) throw new Error('the board payload is not standard base64.');
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
      const parts = [];
      let total = 0;
      for (;;) {
        const step = await reader.read();
        if (step.done) break;
        total += step.value.length;
        if (total > MAX_DECODED) { await reader.cancel(); throw new Error('the board payload inflates beyond ' + MAX_DECODED + ' bytes.'); }
        parts.push(step.value);
      }
      const all = new Uint8Array(total);
      let off = 0;
      for (const p of parts) { all.set(p, off); off += p.length; }
      text = new TextDecoder().decode(all);
    } else if (type !== ${JSON.stringify(JSON_TYPE)}) {
      throw new Error('unknown board payload type: ' + type);
    }
    const board = JSON.parse(text);
    if (!board || typeof board !== 'object' || Array.isArray(board) || !Array.isArray(board.rules) || !board.rules.length) {
      throw new Error('the embedded data is not a board.');
    }
    return board;
  }

  decode().then(boot).catch(fail);

  function boot(BOARD) {
  const MODE = root.dataset.mode === 'embed' ? 'embed' : 'standalone';
  const LAYOUT = BOARD.__layout;
  const PROV = BOARD.__provenance;
  const BINDING = BOARD.__binding;
  const L = UI(uiOptions(BOARD));
  const TITLE = BOARD.__titleOverride || BOARD.title;
  const STATE_ORDER = ['normal', 'bug', 'fixed'];
  const STATUS_ORDER = ['all', 'failed', 'verified', 'pending'];

  const SV = (body) => '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
  // Icon paths from Lucide (ISC; Feather-derived icons MIT). See THIRD_PARTY_NOTICES.md.
  const ICON = {
    lock: SV('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
    warn: SV('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
    ok: SV('<path d="M20 6 9 17l-5-5"/>'),
    shield: SV('<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>'),
    chevron: SV('<path d="m6 9 6 6 6-6"/>'),
    left: SV('<path d="m15 18-6-6 6-6"/>'),
    right: SV('<path d="m9 18 6-6-6-6"/>'),
    /*@flow*/
    flow: SV('<rect width="8" height="8" x="3" y="3" rx="2"/><path d="M7 11v4a2 2 0 0 0 2 2h4"/><rect width="8" height="8" x="13" y="13" rx="2"/>'),
    /*@end*/
    grid: SV('<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>'),
    panel: SV('<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>'),
  };


  const RULES = BOARD.rules;
  const BY_ID = Object.fromEntries(RULES.map((r) => [r.id, r]));
  const MODS = Array.isArray(BOARD.modules) && BOARD.modules.length ? BOARD.modules : [{ id: '__flat', title: TITLE, summary: '' }];
  const MOD_BY_ID = Object.fromEntries(MODS.map((m) => [m.id, m]));
  const modOf = (r) => r.moduleId || MODS[0].id;
  const STATUS = Object.fromEntries(RULES.map((r) => [r.id, ruleStatus(r)]));
  const SPEC_HASH = BINDING.specHash || BOARD.run.specHash;

  const S = {
    ruleId: RULES[0].id,
    focusByRule: Object.fromEntries(RULES.map((r) => [r.id, r.defaultFocus])),
    ovFocus: RULES[0].defaultFocus,
    view: 'focus', evOpen: false,
    status: 'all',
    indexOpen: MODE !== 'embed' && window.innerWidth >= 1100,
  };
  const activeRule = () => BY_ID[S.ruleId] || RULES[0];
  // The view the index toolbar button and the "o" key toggle: the flow map when there is one.
  let HUB = 'overview';
  /*@flow*/
  HUB = 'flow';
  S.journey = ${JSON.stringify(ALL_JOURNEYS)};
  if (BOARD.defaultView === 'flow') S.view = 'flow';
  const JOURNEY = Object.create(null);
  for (const j of BOARD.flow.journeys || []) JOURNEY[j.id] = j;
  // Open a rule from the flow map; drop the status filter only if it would hide that rule.
  function openFromFlow(id, focus) {
    S.ruleId = id; S.view = 'focus';
    if (S.status !== STATUS[id]) S.status = 'all';
    if (focus) S.focusByRule[id] = focus;
  }
  /*@end*/
  const focusOf = (r) => S.focusByRule[r.id] || r.defaultFocus;
  let oosHtml = () => '';
  /*@oos*/
  // Keep the out-of-scope note open or closed across re-renders.
  S.oosOpen = true;
  oosHtml = () => oosMarkup(BOARD, L, S.oosOpen);
  root.addEventListener('toggle', (e) => { if (e.target.classList.contains('pc-oos')) S.oosOpen = e.target.open; }, true);
  /*@end*/

  /*@index*/
  // ---- status filter (index layout) ----
  const visibleList = () => RULES.filter((r) => S.status === 'all' || STATUS[r.id] === S.status);
  const COUNTS = { all: RULES.length, failed: 0, verified: 0, pending: 0 };
  for (const r of RULES) COUNTS[STATUS[r.id]] += 1;
  /*@end*/

  // ---- figure / preview / evidence (shared by both layouts) ----
  // The scenario switch: one segmented control that changes the diagram and the preview together.
  function scenarioBar(stateOf, cur, act, extra) {
    return '<div class="fx" role="group" aria-label="' + esc(L.compare) + '"><span class="fx-cue">' + esc(L.compare) + '</span><span class="fx-seg">' +
      STATE_ORDER.map((k) => {
        const f = stateOf(k);
        const on = cur === k;
        return '<button type="button" aria-pressed="' + on + '" class="fx-' + f.tone + (on ? ' is-on' : '') + '" data-act="' + act + '" data-v="' + k + '">' + esc(f.label) + '</button>';
      }).join('') + '</span>' + extra + '</div>';
  }
  function figCard(r, focusKey, uid, opt) {
    const st = r.states[focusKey];
    const pills = opt && opt.noPills ? '' : scenarioBar((k) => r.states[k], focusKey, 'focus', '<span class="fx-prop" title="' + esc(r.property) + '">' + esc(r.property) + '</span>');
    return '<section class="card fig" data-fig><div class="fig-head"><span class="no">' + esc(r.no) + '</span><h2 class="fig-title">' + esc(r.title) + '</h2>' +
      (r.category ? '<span class="fig-sub">' + esc(r.category) + '</span>' : '') + '</div>' +
      pills + '<div class="fg-wrap">' + figSvg(r, st, uid, true) + '</div>' +
      '<p class="take take-' + st.tone + '">' + esc(st.takeaway) + '</p>' +
      '<p class="src">' + esc(r.source) + '</p></section>';
  }

  function pvCard(r, focusKey) {
    const st = r.states[focusKey];
    const pv = st.preview;
    const num = (v) => v.toLocaleString('en-US', { maximumFractionDigits: 2 });
    const bars = Array.isArray(pv.bars) && pv.bars.length
      ? '<div class="pv-bars">' + pv.bars.map((b) => {
          const pct = Math.max(0, Math.min(100, (b.value / b.max) * 100));
          const limPct = Math.max(0, Math.min(100, (b.limit / b.max) * 100));
          const valTxt = num(b.value) + (b.unit ? ' ' + b.unit : '');
          return '<div class="pv-bar-row"><div class="pv-bar-top"><span class="pv-bar-lbl">' + esc(b.label) + '</span>' +
            '<span class="pv-bar-val ' + (b.ok ? 't-ok' : 't-bad') + '">' + esc(valTxt) + '</span></div>' +
            '<span class="pv-bar"><i class="' + (b.ok ? '' : 'is-bad') + '" style="width:' + pct.toFixed(1) + '%"></i><u style="left:' + limPct.toFixed(1) + '%"></u></span></div>';
        }).join('') + '</div>'
      : '';
    const rows = pv.rows.map((x) => '<div class="pv-row"><span class="pv-k">' + esc(x.k) + '</span><span class="pv-v ' + (x.tone ? 't-' + x.tone : 't-normal') + '">' + esc(x.v) + '</span></div>').join('');
    const log = Array.isArray(pv.logLines) && pv.logLines.length
      ? '<div class="pv-log">' + pv.logLines.map((l) => '<span class="' + logLineTone(l) + '">' + esc(l) + '</span>').join('') + '</div>'
      : '';
    const btnCls = { ok: 'pv-btn-ok', danger: 'pv-btn-danger', locked: 'pv-btn-locked' }[pv.buttonKind];
    const ico = st.tone === 'bug' ? ICON.warn : st.tone === 'safe' ? ICON.lock : ICON.ok;
    return '<section class="card pv pv-' + st.tone + ' link-target">' +
      '<div class="pv-chrome"><span class="pv-title">' + esc(r.previewTitle) + '</span><span class="pv-live pv-live-' + st.tone + '" title="' + esc(L.compare) + '"><span class="pv-live-dot" aria-hidden="true"></span>' + esc(st.label) + '</span></div>' +
      '<div class="pv-body"><span class="pv-badge pv-badge-' + st.tone + '">' + esc(pv.statusBadge) + '</span>' + bars + rows + log +
      '<div class="pv-action"><div class="pv-banner ban-' + st.tone + '">' + ico + '<span>' + esc(pv.alert) + '</span></div>' +
      '<button class="pv-btn ' + btnCls + '" type="button" tabindex="-1"' + (pv.buttonKind === 'locked' ? ' disabled' : '') + '>' + (pv.buttonKind === 'locked' ? ICON.lock : '') + esc(pv.buttonLabel) + '</button></div></div></section>';
  }

  function liveStatusItem(r) {
    const s = STATUS[r.id];
    if (s === 'verified') return '<li class="ok">' + esc(L.liveOk(r.stepsChecked)) + '</li>';
    if (s === 'failed') return '<li class="bad">' + esc(L.liveBad) + '</li>';
    return '<li class="warn">' + esc(L.livePending) + '</li>';
  }

  function evCard(r) {
    const e = r.evidence;
    const { ref, source, logFiles, tool } = ruleEvidenceDetails(r, BOARD, BINDING, L);
    // A failed rule's trace is the failure itself. On any other rule a trace shows what breaks
    // with the rule switched off (a mutant), so it gets its own heading and is omitted when absent.
    const cex = STATUS[r.id] !== 'verified' ? { title: L.cexTitle, text: e.counterexample || L.noCex }
      : e.counterexample ? { title: L.cexOff, text: e.counterexample } : null;
    const kv = (k, v, code) => '<span>' + esc(k) + '</span>' + (code ? '<code>' + esc(v) + '</code>' : '<span>' + esc(v) + '</span>');
    const body = '<div class="ev-panel"' + (S.evOpen ? '' : ' hidden="until-found"') + '><div class="ev-body">' +
      '<div><div class="ev-sec">' + esc(L.rule) + ' (' + esc(r.property) + (r.category ? ' · ' + esc(r.category) : '') + ')</div><div class="ev-rule">' + esc(e.ruleSummary) + '</div>' +
      '<div class="ev-impacts"><div class="ev-imp"><b class="t-ok">' + esc(L.ifOn) + '</b>' + esc(e.ifEnforced) + '</div>' +
      '<div class="ev-imp"><b class="t-bad">' + esc(L.ifOff) + '</b>' + esc(e.ifNotEnforced) + '</div></div></div>' +
      '<div>' + (e.sourceQuote ? '<div class="ev-sec">' + esc(L.quote) + ' (' + esc(r.source) + ')</div><blockquote class="ev-quote">' + esc(e.sourceQuote) + '</blockquote>' : '') +
      '<div class="ev-sec" style="margin-top:' + (e.sourceQuote ? '10px' : '0') + '">' + esc(L.meta) + '</div>' +
      '<div class="kv">' + kv(L.scope, e.scope) + kv(L.method, e.method) + kv(L.tool, tool) +
      kv(L.binding, bindingLabel(BINDING.level, L)) +
      (SPEC_HASH ? kv(L.specHash, SPEC_HASH, true) : '') +
      logFiles.map((file) => kv(L.logHash, file.hash, true)).join('') +
      (Number.isInteger(r.stepsChecked) ? kv(L.steps, L.num(r.stepsChecked)) : '') + '</div></div>' +
      (ref ? '<div style="grid-column:1 / -1"><div class="ev-sec">' + esc(L.specSource) + ' (' + esc(source) + ')</div><pre class="term"><code>' + esc(ref.snippet) + '</code></pre></div>' : '') +
      (cex ? '<div style="grid-column:1 / -1"><div class="ev-sec">' + esc(cex.title) + '</div><pre class="term">' + esc(cex.text) + '</pre></div>' : '') +
      '</div></div>';
    return '<section class="card ev"><h3 class="ev-head">' +
      '<button class="ev-tg" type="button" data-act="ev" aria-expanded="' + S.evOpen + '">' +
      '<span class="ev-chev" aria-hidden="true">' + ICON.chevron + '</span>' +
      '<span class="ev-shield" aria-hidden="true">' + ICON.shield + '</span>' +
      '<span>' + esc(L.evTitle) + '</span>' +
      '<span class="ev-cue">' + esc(S.evOpen ? L.evClose : L.evOpen) + '</span></button></h3>' +
      '<ul class="ev-facts" role="list"><li>' + esc(r.source) + '</li><li>' + esc(e.checkerSummary) + '</li>' + liveStatusItem(r) + '</ul>' + body + '</section>';
  }

  function boardMarkup(r, focusKey, uid, opt) {
    const st = r.states[focusKey];
    return '<div class="board" data-board="' + uid + '" data-tone="' + st.tone + '" data-edge="' + esc(st.edgeShort) + '">' +
      figCard(r, focusKey, uid, opt) + pvCard(r, focusKey) + '<svg class="link-layer" aria-hidden="true"></svg></div>';
  }

  function headerHtml() {
    return '<header class="pc-head"><div class="pc-brand"><h1 class="pc-title" title="' + esc(TITLE) + '">' + esc(TITLE) + '</h1><p class="pc-sub" title="' + esc(BOARD.subtitle) + '">' + esc(BOARD.subtitle) + '</p></div>' +
      '<div class="pc-head-right">' + provenanceBadge(PROV, L) + '</div></header>';
  }

  function footerHtml() {
    return footerMarkup(PROV, BOARD, BINDING, L, SPEC_HASH);
  }

  function setRootData() {
    const r = activeRule();
    root.dataset.view = S.view;
    root.dataset.rule = r.id;
    root.dataset.focus = focusOf(r);
    root.dataset.layout = LAYOUT;
    root.dataset.status = S.status;
    /*@flow*/
    root.dataset.journey = S.journey;
    /*@end*/
  }

  /*@compact*/
  // ================= compact layout (<= 6 rules, single module) =================
  function compactBar() {
    let lead = '';
    /*@flow*/
    lead = '<button type="button" aria-pressed="' + (S.view === 'flow') + '" data-act="view" data-v="flow">' + ICON.flow + esc(L.overview) + '</button><span class="pc-float-sep" aria-hidden="true"></span>';
    /*@end*/
    const btns = RULES.map((r) => '<button type="button" aria-pressed="' + (S.view === 'focus' && S.ruleId === r.id) + '" data-act="rule" data-v="' + esc(r.id) + '"><span class="pc-float-no">' + esc(r.no) + '.</span>' + esc(r.short) + '</button>').join('');
    return '<div class="pc-float-wrap"><nav class="pc-float-bar" aria-label="' + esc(L.navRules) + '">' + lead + btns +
      '<span class="pc-float-sep" aria-hidden="true"></span><button type="button" aria-pressed="' + (S.view === 'overview') + '" data-act="view" data-v="overview">' + ICON.grid + esc(L.viewAll(RULES.length)) + '</button></nav></div>';
  }

  function compactOverview() {
    const fBar = '<div class="ov-bar">' + scenarioBar((k) => RULES[0].states[k], S.ovFocus, 'ov-focus', '') + '<span class="ov-hint">' + esc(L.ovHint) + '</span></div>';
    const cells = RULES.map((r) => {
      const st = r.states[S.ovFocus];
      return '<article class="ov-cell"><header class="ov-head"><span class="no">' + esc(r.no) + '</span>' +
        '<button type="button" class="ov-open" data-act="rule-open" data-v="' + esc(r.id) + '">' + esc(r.short) + '</button>' +
        '<span class="ov-badge pv-badge pv-badge-' + st.tone + '">' + esc(st.label) + ' · ' + esc(st.preview.statusBadge) + '</span></header>' +
        '<div class="ov-stage" aria-hidden="true"><div class="ov-scale" data-ov>' + boardMarkup(r, S.ovFocus, 'ov-' + r.id, { noPills: true }) + '</div></div>' +
        '<p class="ov-take take-' + st.tone + '">' + esc(st.takeaway) + '</p></article>';
    }).join('');
    return fBar + '<div class="ov-grid ' + (RULES.length === 1 ? 'is-single' : '') + '">' + cells + '</div>';
  }

  function renderCompact() {
    const r = activeRule();
    let main = S.view === 'overview' ? compactOverview() : boardMarkup(r, focusOf(r), 'focus-' + r.id) + evCard(r);
    /*@flow*/
    if (S.view === 'flow') main = flowView(BOARD, L, S.journey);
    /*@end*/
    root.innerHTML = headerHtml() + '<main class="pc-canvas">' + compactBar() + '<div class="pc-wrap pc-main">' + main + oosHtml() + '</div></main>' + footerHtml();
  }
  /*@end*/

  /*@index*/
  // ================= index layout (7+ rules or multiple modules) =================
  function toolbarHtml() {
    const seg = STATUS_ORDER.map((k) => '<button type="button" data-act="status" data-v="' + k + '">' + (k === 'all' ? '' : '<span class="st-dot st-' + k + '" aria-hidden="true"></span>') + esc(L.status[k]) + ' <span class="n" data-count="' + k + '"></span></button>').join('');
    return '<div class="pc-float-wrap"><div class="pc-float-bar" role="toolbar" aria-label="' + esc(L.toolbar) + '">' +
      '<button type="button" class="pc-tb-icon" data-act="index" aria-label="' + esc(L.index) + '" title="' + esc(L.index) + '">' + ICON.panel + '</button>' +
      '<div class="pc-seg" role="group" aria-label="' + esc(L.statusGroup) + '">' + seg + '</div>' +
      '<span class="pc-float-sep" aria-hidden="true"></span>' +
      '<button type="button" data-act="view" data-v="' + HUB + '">' + (HUB === 'flow' ? ICON.flow : ICON.grid) + esc(L.overview) + '</button></div></div>';
  }

  function renderShell() {
    root.innerHTML = headerHtml() + '<main class="pc-canvas">' + toolbarHtml() +
      '<div class="pc-split"><nav class="pc-index" id="pc-index" aria-label="' + esc(L.rules) + '"></nav><div class="pc-main" id="pc-main"></div></div></main>' + footerHtml();
  }

  function syncToolbar() {
    root.querySelectorAll('[data-count]').forEach((el) => { el.textContent = COUNTS[el.dataset.count]; });
    root.querySelectorAll('[data-act="status"]').forEach((el) => {
      el.setAttribute('aria-pressed', String(S.status === el.dataset.v));
      el.disabled = COUNTS[el.dataset.v] === 0;
    });
    root.querySelector('[data-act="view"]').setAttribute('aria-pressed', String(S.view === HUB));
    root.querySelector('[data-act="index"]').setAttribute('aria-pressed', String(S.indexOpen));
    root.querySelector('.pc-split').dataset.index = S.indexOpen ? 'open' : 'closed';
  }

  function renderIndex(vis) {
    const nav = root.querySelector('#pc-index');
    const visSet = new Set(vis.map((r) => r.id));
    let h = '<div class="ix-head"><span>' + esc(L.rules) + '</span><span class="ix-count">' + vis.length + ' / ' + RULES.length + '</span></div>';
    for (const m of MODS) {
      const rules = RULES.filter((r) => modOf(r) === m.id);
      const shown = rules.filter((r) => visSet.has(r.id));
      if (!shown.length) continue;
      const ok = rules.filter((r) => STATUS[r.id] === 'verified').length;
      const bad = rules.filter((r) => STATUS[r.id] === 'failed').length;
      const mm = MOD_BY_ID[m.id];
      h += '<div class="ix-group">' + (MODS.length > 1
        ? '<div class="ix-mod"><span class="ix-mod-title">' + esc(mm.title) + '</span><span class="ix-mod-c">' + (bad ? '<b>' + esc(L.nFailed(bad)) + '</b> ' : '') + ok + '/' + rules.length + '</span></div>'
        : '') + '<ul class="ix-list">' +
        shown.map((r) => '<li><button type="button" class="ix-row" data-act="rule" data-v="' + esc(r.id) + '" aria-current="' + (S.view === 'focus' && r.id === S.ruleId) + '" title="' + esc(r.title) + '"><span class="ix-no">' + esc(r.no) + '</span><span class="ix-t">' + esc(r.title) + '</span><span class="st-dot st-' + STATUS[r.id] + '" aria-label="' + esc(L.status[STATUS[r.id]]) + '"></span></button></li>').join('') +
        '</ul></div>';
    }
    nav.innerHTML = h;
    const cur = nav.querySelector('[aria-current="true"]');
    if (cur) {
      const top = cur.offsetTop - nav.offsetTop;
      if (top < nav.scrollTop || top + cur.offsetHeight > nav.scrollTop + nav.clientHeight) nav.scrollTop = Math.max(0, top - nav.clientHeight / 3);
    }
  }

  function crumbHtml(r, vis) {
    const m = MOD_BY_ID[modOf(r)];
    const pos = vis.findIndex((x) => x.id === r.id);
    const st = STATUS[r.id];
    return '<div class="pc-crumb">' + (MODS.length > 1 ? '<span class="crumb-mod">' + esc(m.title) + '</span><span class="crumb-sep">/</span>' : '') +
      '<span class="st-pill st-' + st + '">' + esc(L.status[st]) + '</span><span class="pc-spacer"></span>' +
      '<span class="crumb-pos">' + (pos + 1) + ' / ' + vis.length + '</span>' +
      '<button type="button" class="crumb-btn" data-act="step" data-v="-1" aria-label="' + esc(L.prev) + '"' + (pos <= 0 ? ' disabled' : '') + '>' + ICON.left + '</button>' +
      '<button type="button" class="crumb-btn" data-act="step" data-v="1" aria-label="' + esc(L.next) + '"' + (pos >= vis.length - 1 ? ' disabled' : '') + '>' + ICON.right + '</button></div>';
  }

  function hubOverview(vis) {
    const visSet = new Set(vis.map((r) => r.id));
    const tot = { verified: 0, failed: 0, pending: 0 };
    for (const r of RULES) tot[STATUS[r.id]] += 1;
    const sum = '<div class="hv-sum"><span class="hv-stat"><b>' + RULES.length + '</b>' + esc(L.rulesN) + '</span>' +
      (MODS.length > 1 ? '<span class="hv-stat"><b>' + MODS.length + '</b>' + esc(L.modulesN) + '</span>' : '') +
      '<span class="hv-stat ok"><b>' + tot.verified + '</b>' + esc(L.status.verified) + '</span>' +
      '<span class="hv-stat bad"><b>' + tot.failed + '</b>' + esc(L.status.failed) + '</span>' +
      '<span class="hv-stat warn"><b>' + tot.pending + '</b>' + esc(L.status.pending) + '</span>' +
      '<span class="hv-hint">' + esc(L.hubHint) + '</span></div>';
    const cards = [];
    for (const m of MODS) {
      const rules = RULES.filter((r) => modOf(r) === m.id);
      const shown = rules.filter((r) => visSet.has(r.id));
      if (!shown.length) continue;
      const c = { verified: 0, failed: 0, pending: 0 };
      for (const r of rules) c[STATUS[r.id]] += 1;
      const pct = (n) => (rules.length ? (n / rules.length) * 100 : 0).toFixed(1) + '%';
      const mm = MOD_BY_ID[m.id];
      cards.push('<section class="hub' + (c.failed ? ' has-fail' : '') + '">' +
        '<button type="button" class="hub-head" data-act="module-open" data-v="' + esc(m.id) + '" title="' + esc(L.hubOpen) + '"><span class="hub-title">' + esc(mm.title) + '</span><span class="hub-n">' + rules.length + ' ' + esc(L.rulesN) + '</span></button>' +
        (m.summary ? '<p class="hub-sum">' + esc(m.summary) + '</p>' : '') +
        '<div class="hub-meter" aria-hidden="true"><i class="ok" style="width:' + pct(c.verified) + '"></i><i class="bad" style="width:' + pct(c.failed) + '"></i><i class="warn" style="width:' + pct(c.pending) + '"></i></div>' +
        '<div class="hub-meta"><span>' + esc(L.status.verified) + ' ' + c.verified + '</span>' + '<span class="' + (c.failed ? 'bad' : '') + '">' + esc(L.status.failed) + ' ' + c.failed + '</span><span>' + esc(L.status.pending) + ' ' + c.pending + '</span></div>' +
        '<ul class="hub-spokes">' + shown.map((r) => '<li><button type="button" class="spoke st-' + STATUS[r.id] + '" data-act="rule-open" data-v="' + esc(r.id) + '" title="' + esc(r.no + '. ' + r.title + ' (' + L.status[STATUS[r.id]] + ')') + '"><span class="spoke-no">' + esc(r.no) + '</span><span class="spoke-t">' + esc(r.short) + '</span></button></li>').join('') + '</ul></section>');
    }
    const lod = RULES.length > 120 ? ' lod-min' : '';
    return sum + '<div class="hv-grid' + lod + '">' + cards.join('') + '</div>';
  }

  function renderMain(vis) {
    const put = (h) => { root.querySelector('#pc-main').innerHTML = h + oosHtml(); };
    if (S.view === 'overview') return put(hubOverview(vis));
    /*@flow*/
    if (S.view === 'flow') return put(flowView(BOARD, L, S.journey, S.status));
    /*@end*/
    const r = activeRule();
    put(crumbHtml(r, vis) + boardMarkup(r, focusOf(r), 'focus-' + r.id) + evCard(r));
  }

  function renderIndexLayout() {
    if (!root.querySelector('#pc-main')) renderShell();
    const vis = visibleList();
    if (vis.length && !vis.some((r) => r.id === S.ruleId)) S.ruleId = vis[0].id;
    syncToolbar();
    renderIndex(vis);
    renderMain(vis);
  }

  function stepRule(delta) {
    const vis = visibleList();
    const i = vis.findIndex((r) => r.id === S.ruleId);
    const next = vis[Math.min(vis.length - 1, Math.max(0, (i < 0 ? 0 : i + delta)))];
    if (next) { S.ruleId = next.id; S.view = 'focus'; render(); }
  }

  /*@end*/

  function render() {
    if (LAYOUT === 'compact') renderCompact(); else renderIndexLayout();
    setRootData();
    requestAnimationFrame(layout);
  }

  // ---- connector + sizing ----
  function drawLink(b) {
    const uid = b.dataset.board;
    const tone = b.dataset.tone;
    const svg = b.querySelector('.link-layer');
    const src = b.querySelector('.fg-svg [data-anchor]');
    const fig = b.querySelector('[data-fig]');
    const tgt = b.querySelector('.link-target');
    b.querySelectorAll('.lk-label').forEach((x) => x.remove());
    if (!svg || !src || !tgt || !fig) { if (svg) svg.innerHTML = ''; return; }
    if (getComputedStyle(svg).display === 'none') { svg.innerHTML = ''; return; }
    const br = b.getBoundingClientRect();
    if (!br.width || !b.offsetWidth) return;
    const k = br.width / b.offsetWidth || 1;
    const rel = (r) => ({ l: (r.left - br.left) / k, t: (r.top - br.top) / k, r: (r.right - br.left) / k, b: (r.bottom - br.top) / k });
    const s = rel(src.getBoundingClientRect());
    const f = rel(fig.getBoundingClientRect());
    const t = rel(tgt.getBoundingClientRect());
    if (t.l <= f.r + 8) { svg.innerHTML = ''; return; }
    const sx = s.r + 2;
    const sy = (s.t + s.b) / 2;
    const tx = t.l - 2;
    const ty = Math.min(Math.max(sy, t.t + 56), t.b - 56);
    const dx = Math.max(32, (tx - sx) * 0.5);
    const d = 'M' + sx.toFixed(1) + ' ' + sy.toFixed(1) + ' C' + (sx + dx).toFixed(1) + ' ' + sy.toFixed(1) + ', ' + (tx - dx).toFixed(1) + ' ' + ty.toFixed(1) + ', ' + tx.toFixed(1) + ' ' + ty.toFixed(1);
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    svg.innerHTML = '<defs><marker id="lk-' + uid + '" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 0 L10 5 L0 10z" class="lk-head-' + tone + '"/></marker></defs>' +
      '<path class="lk-path lk-' + tone + '" d="' + d + '" marker-end="url(#lk-' + uid + ')"/>' +
      (reduce ? '' : '<circle r="4.5" class="lk-dot lk-dot-' + tone + '"><animateMotion dur="' + (tone === 'bug' ? '1.1s' : '1.8s') + '" repeatCount="indefinite" path="' + d + '"/></circle>');
    const lab = document.createElement('div');
    lab.className = 'lk-label lk-label-' + tone;
    lab.textContent = b.dataset.edge;
    lab.style.left = ((f.r + t.l) / 2).toFixed(1) + 'px';
    lab.style.top = ((sy + ty) / 2).toFixed(1) + 'px';
    b.appendChild(lab);
  }

  function layout() {
    root.querySelectorAll('[data-ov]').forEach((el) => {
      const stage = el.parentElement;
      const natural = 1120;
      const k = Math.min(1, stage.clientWidth / natural);
      el.style.width = natural + 'px';
      el.style.transform = 'scale(' + k + ')';
      stage.style.height = Math.max(160, Math.ceil(el.scrollHeight * k)) + 'px';
    });
    const nav = root.querySelector('#pc-index');
    if (nav) nav.style.maxHeight = getComputedStyle(nav).position === 'sticky' ? Math.min(720, Math.max(320, window.innerHeight - 84)) + 'px' : '';
    root.querySelectorAll('[data-board]').forEach(drawLink);
  }

  root.addEventListener('beforematch', (e) => {
    if (e.target && e.target.closest && e.target.closest('.ev-panel') && !S.evOpen) {
      S.evOpen = true;
      const btn = root.querySelector('[data-act="ev"]');
      if (btn) {
        btn.setAttribute('aria-expanded', 'true');
        const cue = btn.querySelector('.ev-cue');
        if (cue) cue.textContent = L.evClose;
      }
    }
  });

  // ---- events ----
  root.addEventListener('click', (e) => {
    const el = e.target.closest('[data-act]');
    if (!el || !root.contains(el) || el.disabled) return;
    const act = el.dataset.act;
    const v = el.dataset.v;
    if (act === 'rule') { S.ruleId = v; S.view = 'focus'; }
    else if (act === 'rule-open') { S.ruleId = v; if (LAYOUT === 'compact') S.focusByRule[v] = S.ovFocus; S.view = 'focus'; }
    else if (act === 'focus') { S.focusByRule[activeRule().id] = v; render(); root.querySelectorAll('.board').forEach((b) => b.classList.add('is-swap')); return; }
    else if (act === 'ov-focus') { S.ovFocus = v; }
    else if (act === 'view') { S.view = S.view === v ? 'focus' : v; }
    else if (act === 'ev') { S.evOpen = !S.evOpen; }
    else if (act === 'status') { S.status = v; }
    else if (act === 'module-open') { const first = visibleList().find((r) => modOf(r) === v); if (!first) return; S.ruleId = first.id; S.view = 'focus'; }
    else if (act === 'index') { S.indexOpen = !S.indexOpen; }
    else if (act === 'step') { stepRule(Number(v)); return; }
    /*@flow*/
    else if (act === 'journey') { S.journey = v; }
    else if (act === 'flow-rule') { openFromFlow(v); }
    else if (act === 'checkpoint') { const j = JOURNEY[v]; if (!j) return; openFromFlow(j.checkpointRuleId, checkpointFocus(j)); }
    /*@end*/
    else return;
    render();
  });

  // Standalone pages take shortcuts page-wide; an embedded board only while focus is inside it.
  (MODE === 'embed' ? root : document).addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (LAYOUT === 'compact' && /^[1-9]$/.test(e.key)) {
      const r = RULES[Number(e.key) - 1];
      if (r) { S.ruleId = r.id; S.view = 'focus'; render(); }
    } else if (LAYOUT === 'index' && (e.key === 'j' || e.key === 'k')) {
      stepRule(e.key === 'j' ? 1 : -1);
    } else if (e.key === 'o') {
      const hub = LAYOUT === 'compact' ? 'overview' : HUB;
      S.view = S.view === hub ? 'focus' : hub; render();
    } else if (e.key === 'e' && S.view === 'focus') {
      S.evOpen = !S.evOpen; render();
    }
  });

  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => requestAnimationFrame(layout)).observe(root);
  else window.addEventListener('resize', () => requestAnimationFrame(layout));

  window.__proofCanvas = {
    getState: () => ({ ...S }),
    setState: (patch) => { Object.assign(S, patch); render(); },
    getBoard: () => BOARD,
    layout: LAYOUT,
    mode: MODE,
  };
  render();
  window.__proofCanvas.readyAt = performance.now();
  }
})();`;

// Keep only the CSS/JS blocks a board needs. A block is /*@tag*/ ... /*@end*/ or /*@a,b*/ ... /*@end*/
// (kept when any of its tags is in `keep`); blocks may nest, and the innermost are resolved first.
const BLOCK_RE = /\/\*@([a-z,]+)\*\/((?:(?!\/\*@)[\s\S])*?)\/\*@end\*\//g;
export function pickBlocks(src, keep) {
  let out = src;
  for (let prev = ''; prev !== out;) {
    prev = out;
    out = out.replace(BLOCK_RE, (_, tags, body) => (tags.split(',').some((t) => keep.includes(t)) ? body : ''));
  }
  return out;
}
// Whitespace-only minification that cannot change meaning: CSS comments and indentation,
// spaces around { } ; and never around ":" (selectors such as ".a :focus-visible" depend on it).
const minCss = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s*\n\s*/g, ' ').replace(/\s*([{};])\s*/g, '$1').trim();

// Index of the "}" that closes the "{" at `open`.
function closingBrace(css, open) {
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}' && (depth -= 1) === 0) return i;
  }
  throw new Error(`unbalanced CSS braces after offset ${open}`);
}
// Split a selector list on top-level commas (not inside :is(...), :not(...) or [attr="a,b"]).
function splitSelectors(list) {
  const out = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i];
    if (quote) { if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (c === ',' && depth === 0) { out.push(list.slice(start, i)); start = i + 1; }
  }
  out.push(list.slice(start));
  return out.map((x) => x.trim());
}
// Prefix every selector with :where(.pc-root) so board CSS can never match elements of a host page.
// :where() adds no specificity, so the cascade inside the board is exactly as written.
// Conditional groups (@media, @container, @supports) are scoped recursively; @keyframes are kept.
function scopeCss(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) { if (css.slice(i).trim()) throw new Error('trailing CSS outside a rule'); break; }
    const head = css.slice(i, open).trim();
    const close = closingBrace(css, open);
    const body = css.slice(open + 1, close);
    if (/^@(?:media|container|supports)\b/.test(head)) out += head + '{' + scopeCss(body) + '}';
    else if (head.startsWith('@')) out += head + '{' + body + '}';
    else out += splitSelectors(head).map((sel) => (sel.startsWith('.pc-root') ? sel : ':where(.pc-root) ' + sel)).join(',') + '{' + body + '}';
    i = close + 1;
  }
  return out;
}
// JS: drop indentation, blank lines and whole-line // comments; newlines are kept so ASI is unchanged.
const minJs = (js) => js.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).join('\n');

function checkOptions(opts) {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) throw new Error('renderBoardHtml options must be an object');
  const mode = opts.mode ?? 'standalone';
  const payload = opts.payload ?? 'auto';
  if (!RENDER_MODES.includes(mode)) throw new Error(`Invalid mode "${mode}" (expected ${RENDER_MODES.join(' or ')})`);
  if (!PAYLOAD_MODES.includes(payload)) throw new Error(`Invalid payload "${payload}" (expected ${PAYLOAD_MODES.join(', ')})`);
  if (opts.title !== undefined && (typeof opts.title !== 'string' || !opts.title.trim())) throw new Error('title must be a non-empty string when given');
  const { specPaths = [], logPaths = [] } = opts;
  for (const paths of [specPaths, logPaths]) {
    if (!Array.isArray(paths) || paths.some((p) => typeof p !== 'string' || !p)) {
      throw new Error('specPaths and logPaths must be arrays of file paths');
    }
  }
  return { mode, payload, title: opts.title, specPaths, logPaths };
}

// Public entry point. Throws on an invalid board or invalid options; never renders a partial page.
export function renderBoardHtml(boardInput, options = {}) {
  const checked = checkOptions(options);
  const check = validateBoardData(boardInput, { checkHash: checked.specPaths.length === 0 });
  if (!check.ok) throw new Error(`Invalid board:\n  - ${check.errors.join('\n  - ')}`);

  return render(structuredClone(boardInput), bindEvidence(boardInput, checked), checked);
}

function render(board, binding, { mode, payload: payloadMode, title }) {
  const shownTitle = title ?? board.title;
  const prov = resolveProvenance(board, binding);
  const layout = layoutFor(board);
  const payload = encodePayload({ ...board, __provenance: prov, __layout: layout, __binding: binding, ...(title !== undefined ? { __titleOverride: title } : {}) }, payloadMode);

  const L = uiFor(board);
  const first = board.rules[0];
  const firstSt = first.states[first.defaultFocus];
  const flowFirst = board.defaultView === 'flow';

  // Pre-hydration shell: header, provenance badge and the first view (the flow map, or the first
  // rule's figure). The flow markup is the exact string the runtime renders for the same state.
  const firstView = flowFirst ? flowView(board, L, ALL_JOURNEYS)
    : `<div class="board" data-board="focus-${esc(first.id)}" data-tone="${firstSt.tone}" data-edge="${esc(firstSt.edgeShort)}">` +
    `<section class="card fig" data-fig><div class="fig-head"><span class="no">${esc(first.no)}</span><h2 class="fig-title">${esc(first.title)}</h2></div>` +
    `<div class="fg-wrap">${figSvg(first, firstSt, `focus-${first.id}`, false)}</div><p class="take take-${firstSt.tone}">${esc(firstSt.takeaway)}</p></section>` +
    `<section class="card pv pv-${firstSt.tone} link-target"><div class="pv-chrome"><span class="pv-title">${esc(first.previewTitle)}</span></div><div class="pv-body"><span class="pv-badge pv-badge-${firstSt.tone}">${esc(firstSt.preview.statusBadge)}</span></div></section>` +
    `<svg class="link-layer" aria-hidden="true"></svg></div>`;
  const ssrShell = `<div class="pc-root" id="${ROOT_ELEMENT_ID}" data-mode="${mode}" data-layout="${layout}" data-view="${flowFirst ? 'flow' : 'focus'}" data-rule="${esc(first.id)}" data-focus="${first.defaultFocus}"${board.flow ? ` data-journey="${ALL_JOURNEYS}"` : ''}>` +
    `<header class="pc-head"><div class="pc-brand"><h1 class="pc-title">${esc(shownTitle)}</h1><p class="pc-sub">${esc(board.subtitle)}</p></div>` +
    `<div class="pc-head-right">${provenanceBadge(prov, L)}</div></header>` +
    `<main class="pc-canvas"><div class="pc-wrap pc-main">${firstView}${board.outOfScope ? oosMarkup(board, L, true) : ''}</div></main>` +
    `<footer class="pc-foot" data-provenance-note="${prov.kind}"><span>${esc(provNote(prov, board, binding, L))}</span></footer>` +
    // Inside the root so the scoped CSS applies; the runtime replaces the root's content anyway.
    `${renderNoscript(board, shownTitle, prov, L)}</div>`;

  const keep = [layout, ...(board.flow ? ['flow'] : []), ...(board.outOfScope ? ['oos'] : [])];
  const css = (mode === 'standalone' ? STANDALONE_CSS : '') + scopeCss(minCss(pickBlocks(CSS, keep)));
  const runtime = figureRuntime(board.rules.map(figKind)) + '\n' + uiSource(board) + (board.flow ? '\n' + flowRuntime() : '') +
    (board.outOfScope ? '\n' + oosMarkup.toString() : '');
  return `<!doctype html>
<html lang="${L.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(shownTitle)}</title>
<style>${css}</style>
</head>
<body>
${ssrShell}
<script id="${DATA_ELEMENT_ID}" type="${payload.type}">${payload.text}</script>
<script>${minJs(pickBlocks(CLIENT_JS, keep).replace('/*@figures*/', () => runtime))}</script>
</body>
</html>
`;
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const board = JSON.parse(readFileSync(resolve(opts.inPath), 'utf8'));
    const check = validateBoardData(board, { checkHash: opts.specPaths.length === 0 });
    for (const w of check.warnings) process.stderr.write(`warning: ${w}\n`);
    if (!check.ok) {
      process.stderr.write(`Invalid board JSON (${opts.inPath}):\n`);
      for (const e of check.errors) process.stderr.write(`  - ${e}\n`);
      process.exit(1);
    }
    const checked = checkOptions(opts);
    const binding = bindEvidence(board, checked);
    const html = render(board, binding, checked);
    const outAbs = resolve(opts.outPath);
    mkdirSync(dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, html, 'utf8');
    const bytes = Buffer.byteLength(html, 'utf8');
    process.stdout.write(
      `Rendered ${opts.outPath} (${bytes} bytes, ${(bytes / 1024).toFixed(1)} KB, ${board.rules.length} rule(s), layout=${layoutFor(board)}, mode=${opts.mode}, provenance=${resolveProvenance(board, binding).kind})\n`,
    );
  } catch (err) {
    process.stderr.write(`render_board error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
