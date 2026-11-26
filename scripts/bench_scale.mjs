#!/usr/bin/env node
// proof-canvas scale benchmark: 3 / 12 / 20 / 50 / 100 rules, plus embed mode.
//   Node stage (always): generate tiers deterministically, time render + validate, check byte-identical
//   re-render, size budgets.  Browser stage (unless --no-browser): headless Chromium via
//   `uv run --with playwright==1.65.2 python scripts/bench_browser.py` at 1280x800 and 1440x900
//   (embed tier: 900x700), with a layout sweep over every rule in every state.
// Writes out/bench/{results.json,results.md,manifest.json,browser.json,*.html,*.png}. All paths
// written are relative to the repository root. Zero npm dependencies.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FS } from './figure.mjs';
import { findPayloads } from './payload.mjs';
import { renderBoardHtml } from './render_board.mjs';
import { layoutFor, ruleStatus, sizeBudgetFor, validateBoardData } from './schema.mjs';
import { synthBoard } from './synth_board.mjs';
import { validateHtmlContent } from './validate_board.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLAYWRIGHT_PIN = 'playwright==1.65.2';
const RUNS = 7;
// No figure text may be fitted below this size (SVG user units; the figure is 740 units wide).
const FS_FLOOR = Math.min(FS.boxMin, FS.labelMin, FS.chipMin);

const DESKTOP = [[1280, 800], [1440, 900]];
// The escrow example with its "sample" declaration removed: exercises the failed-run badge.
const unsample = (b) => { const c = structuredClone(b); delete c.provenance; delete c.provenanceNote; return c; };
const TIERS = [
  { name: 'tier1_3rules', label: 'Tier 1: 3 rules, no modules (example 01)', source: 'examples/01_room_booking.board.json' },
  { name: 'tier1b_escrow', label: 'Tier 1b: 12 rules / 3 modules (example 02, sample declaration removed)', source: 'examples/02_escrow_payout.board.json', transform: unsample, searchKeyword: 'dispute' },
  { name: 'tier2_20rules', label: 'Tier 2: 20 rules / 4 modules (example 03)', source: 'examples/03_multi_module_20rules.board.json', searchKeyword: 'overlap' },
  { name: 'tier3_50rules', label: 'Tier 3: 50 rules / 10 modules (synthetic)', synth: { rules: 50, modules: 10, failed: 2, unverified: 8, seed: 50 }, searchKeyword: 'expired' },
  { name: 'tier4_100rules', label: 'Tier 4: 100 rules / 20 modules (synthetic)', synth: { rules: 100, modules: 20, failed: 5, unverified: 20, seed: 100 }, searchKeyword: 'expired' },
  { name: 'embed_20rules', label: 'Embed: example 03 in embed mode at 900x700', source: 'examples/03_multi_module_20rules.board.json', mode: 'embed', viewports: [[900, 700]], searchKeyword: 'overlap' },
];

const SCREENSHOTS = [
  { tier: 'tier1_3rules', file: 'tier1_3rules.png' },
  { tier: 'tier1b_escrow', file: 'tier1b_escrow_failed_rule.png', state: { ruleId: 'no_release_in_dispute', evOpen: true } },
  { tier: 'tier2_20rules', file: 'tier2_20rules_overview.png', state: { view: 'overview' } },
  { tier: 'tier2_20rules', file: 'tier2_20rules_detail.png', state: { ruleId: 'calendar_sync' } },
  { tier: 'tier2_20rules', file: 'tier2_20rules_detail_evidence.png', state: { ruleId: 'cleaning_buffer', evOpen: true } },
  { tier: 'tier3_50rules', file: 'tier3_50rules_filtered.png', state: { status: 'failed' } },
  { tier: 'tier3_50rules', file: 'tier3_50rules_empty_search.png', state: { q: 'zzzz-no-match' } },
  { tier: 'tier4_100rules', file: 'tier4_100rules_overview.png', state: { view: 'overview' } },
  { tier: 'tier4_100rules', file: 'tier4_100rules_failed_overview.png', state: { view: 'overview', status: 'failed' } },
  { tier: 'embed_20rules', file: 'embed_20rules_900.png', w: 900, h: 700 },
];

const rel = (p) => relative(REPO_ROOT, p) || '.';
const ms = (t0) => Number(process.hrtime.bigint() - t0) / 1e6;
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return Number(s[Math.floor(s.length / 2)].toFixed(2)); };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const kb = (n) => Number((n / 1024).toFixed(1));

function parseArgs(argv) {
  const opts = { out: join(REPO_ROOT, 'out', 'bench'), browser: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--no-browser') opts.browser = false;
    else if (a === '--out' && argv[i + 1]) opts.out = resolve(argv[++i]);
    else if (a === '-h' || a === '--help') {
      process.stdout.write('Usage: node scripts/bench_scale.mjs [--out out/bench] [--no-browser]\n');
      process.exit(0);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

function nodeStage(outDir) {
  const tiers = [];
  for (const t of TIERS) {
    let board;
    let synthMs = null;
    if (t.synth) {
      const t0 = process.hrtime.bigint();
      board = synthBoard(t.synth);
      synthMs = Number(ms(t0).toFixed(2));
      writeFileSync(join(outDir, `${t.name}.board.json`), `${JSON.stringify(board, null, 2)}\n`);
    } else {
      board = JSON.parse(readFileSync(join(REPO_ROOT, t.source), 'utf8'));
      if (t.transform) board = t.transform(board);
    }
    const schema = validateBoardData(board);
    if (!schema.ok) throw new Error(`${t.name}: invalid board: ${schema.errors.join('; ')}`);

    const renderTimes = [];
    const hashes = new Set();
    let html = '';
    for (let i = 0; i < RUNS; i += 1) {
      const t0 = process.hrtime.bigint();
      html = renderBoardHtml(board, { mode: t.mode || 'standalone' });
      renderTimes.push(ms(t0));
      hashes.add(sha(html));
    }
    const htmlPath = join(outDir, `${t.name}.html`);
    writeFileSync(htmlPath, html);

    const validateTimes = [];
    let v;
    for (let i = 0; i < RUNS; i += 1) {
      const t0 = process.hrtime.bigint();
      v = validateHtmlContent(html, rel(htmlPath));
      validateTimes.push(ms(t0));
    }
    const statuses = { verified: 0, failed: 0, pending: 0 };
    for (const r of board.rules) statuses[ruleStatus(r)] += 1;
    const rawJsonBytes = Buffer.byteLength(JSON.stringify(board), 'utf8');
    tiers.push({
      name: t.name,
      label: t.label,
      source: t.synth ? `${rel(outDir)}/${t.name}.board.json` : `${t.source}${t.transform ? ' (provenance removed)' : ''}`,
      html: rel(htmlPath),
      rules: board.rules.length,
      modules: Array.isArray(board.modules) ? board.modules.length : 0,
      layout: layoutFor(board),
      mode: v.mode,
      viewports: t.viewports || DESKTOP,
      statuses,
      provenance: v.provenance,
      bytesPerRule: Math.round(board.rules.reduce((n, r) => n + Buffer.byteLength(JSON.stringify(r)), 0) / board.rules.length),
      boardJsonKb: kb(rawJsonBytes),
      htmlBytes: v.bytes,
      htmlKb: v.kb,
      budgetKb: kb(sizeBudgetFor(board.rules.length)),
      payload: v.payload,
      synthMs,
      renderMedianMs: median(renderTimes),
      validateMedianMs: median(validateTimes),
      deterministic: hashes.size === 1,
      htmlSha256: [...hashes][0],
      validator: { ok: v.ok, errors: v.errors, warnings: v.warnings },
      ids: board.rules.slice(0, 2).map((r) => r.id),
      moduleIds: (board.modules || []).map((m) => m.id),
      filterStatus: statuses.failed > 0 ? 'failed' : 'verified',
      searchKeyword: t.searchKeyword || null,
    });
  }
  return tiers;
}

// Pages for behavior checks that the tiers cannot show: a corrupted payload, a module whose id is
// "all" (must not collide with the all-modules filter), and a standalone page narrower than 1100 px.
function checkPages(outDir) {
  const ex = (f) => JSON.parse(readFileSync(join(REPO_ROOT, 'examples', f), 'utf8'));
  const write = (name, html) => { const p = join(outDir, name); writeFileSync(p, html); return rel(p); };
  const gz = renderBoardHtml(ex('01_room_booking.board.json'), { payload: 'gzip' });
  const [p] = findPayloads(gz);
  const corrupt = write('check_corrupt_payload.html', gz.replace(p.text, () => p.text.replace(/[+/]/g, '-')));
  const allBoard = ex('03_multi_module_20rules.board.json');
  const firstId = allBoard.modules[0].id;
  allBoard.modules[0].id = 'all';
  for (const r of allBoard.rules) if (r.moduleId === firstId) r.moduleId = 'all';
  const inAll = allBoard.rules.filter((r) => r.moduleId === 'all').length;
  const moduleAll = write('check_module_all.html', renderBoardHtml(allBoard));
  const narrow = write('check_standalone_1024.html', renderBoardHtml(ex('03_multi_module_20rules.board.json')));
  return [
    { name: 'corrupted payload shows the error box', kind: 'error-box', html: corrupt, w: 1280, h: 800 },
    { name: 'module id "all" vs the all-modules filter', kind: 'module-all', html: moduleAll, w: 1440, h: 900, expectRows: [inAll, allBoard.rules.length] },
    { name: 'standalone below 1100 px starts with the index closed', kind: 'index-closed', html: narrow, w: 1024, h: 768 },
  ];
}

function browserStage(outDir, tiers) {
  const manifest = {
    checks: checkPages(outDir),
    tiers: tiers.map((t) => ({ name: t.name, html: t.html, layout: t.layout, viewports: t.viewports, ids: t.ids, moduleIds: t.moduleIds, filterStatus: t.filterStatus, searchKeyword: t.searchKeyword })),
    screenshots: SCREENSHOTS.map((s) => ({ file: s.file, html: tiers.find((t) => t.name === s.tier).html, state: s.state || null, w: s.w || 1440, h: s.h || 900 })),
  };
  const manifestPath = join(outDir, 'manifest.json');
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const r = spawnSync('uv', ['run', '-q', '--with', PLAYWRIGHT_PIN, 'python', 'scripts/bench_browser.py', rel(manifestPath)], { cwd: REPO_ROOT, stdio: 'inherit' });
  if (r.error && r.error.code === 'ENOENT') {
    throw new Error('`uv` was not found. Install uv (https://docs.astral.sh/uv/) for the browser stage, or rerun with --no-browser for Node-only metrics.');
  }
  if (r.status !== 0) throw new Error(`browser stage failed (exit ${r.status})`);
  return JSON.parse(readFileSync(join(outDir, 'browser.json'), 'utf8'));
}

function markdown(tiers, browser) {
  const L = [];
  L.push('| Tier | Rules / modules | Layout | Mode | Badge | HTML (budget) | Payload | bytes/rule | Render ms | Validate ms | Deterministic | Validator |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const t of tiers) {
    L.push(`| ${t.name} | ${t.rules} / ${t.modules} | ${t.layout} | ${t.mode} | ${t.provenance} | ${t.htmlKb} KB (${t.budgetKb} KB) | ${t.payload === 'application/json' ? 'JSON' : 'gzip+base64'} | ${t.bytesPerRule} | ${t.renderMedianMs} | ${t.validateMedianMs} | ${t.deterministic ? 'yes' : 'NO'} | ${t.validator.ok ? 'PASS' : 'FAIL'}${t.validator.warnings.length ? ` (${t.validator.warnings.length} warn)` : ''} |`);
  }
  if (!browser) return `${L.join('\n')}\n\nBrowser stage skipped (--no-browser).\n`;
  L.push('');
  L.push('| Behavior check | Viewport | Result | Detail |');
  L.push('|---|---|---|---|');
  for (const c of browser.checks) L.push(`| ${c.name} | ${c.viewport} | ${c.ok ? 'PASS' : 'FAIL'} | ${c.detail} |`);
  L.push('');
  L.push(`Chromium ${browser.chromium}. Interaction latency = median of ${browser.repeat} runs (click -> handler + forced layout); "frame" adds the next animation frame. Layout columns are the worst value over a sweep of every rule in every state (normal, bug, fixed).`);
  L.push('');
  L.push('| Tier | Viewport | DOMContentLoaded ms | App ready ms | DOM nodes | JS heap MB | Views swept | Min SVG text units (px) | SVG text overflow | Connector overlap px | Clipped labels | Page overflow px | Toolbar rows | Index open at load | Errors (console / page) | External requests | CJK chars |');
  L.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const bt of browser.tiers) {
    for (const r of bt.rows) {
      L.push(`| ${bt.name} | ${r.viewport} | ${r.domContentLoadedMs} | ${r.appReadyMs} | ${r.domNodesInitial} | ${r.jsHeapUsedMB} | ${r.sweepViews} | ${r.minSvgFontUnits} (${r.minSvgFontPx}) | ${r.maxSvgTextOverflow} | ${r.maxConnectorOverlapPx} | ${r.maxClippedLabels} | ${r.maxHorizontalOverflowPx} | ${r.maxToolbarRows} | ${r.indexOpenAtLoad} | ${r.consoleErrors.length} / ${r.pageErrors.length} | ${r.externalRequests.length} | ${r.cjkChars} |`);
    }
  }
  const names = [...new Set(browser.tiers.flatMap((bt) => bt.rows.flatMap((r) => Object.keys(r.interactions))))];
  L.push('');
  L.push(`| Tier | Viewport | ${names.join(' | ')} |`);
  L.push(`|---|---|${names.map(() => '---').join('|')}|`);
  for (const bt of browser.tiers) {
    for (const r of bt.rows) {
      const cells = names.map((n) => {
        const x = r.interactions[n];
        if (!x) return 'n/a';
        if (x.skipped) return 'n/a';
        return `${x.syncMedianMs} (frame ${x.frameMedianMs})`;
      });
      L.push(`| ${bt.name} | ${r.viewport} | ${cells.join(' | ')} |`);
    }
  }
  return `${L.join('\n')}\n`;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  mkdirSync(opts.out, { recursive: true });
  const tiers = nodeStage(opts.out);
  for (const t of tiers) {
    process.stdout.write(`[node] ${t.name}: ${t.htmlKb} KB (${t.payload}), render ${t.renderMedianMs} ms, validate ${t.validateMedianMs} ms, deterministic=${t.deterministic}, validator=${t.validator.ok ? 'PASS' : 'FAIL'}\n`);
  }
  const browser = opts.browser ? browserStage(opts.out, tiers) : null;
  const results = { node: process.version, platform: `${process.platform}-${process.arch}`, runs: RUNS, tiers, browser };
  writeFileSync(join(opts.out, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
  const md = markdown(tiers, browser);
  writeFileSync(join(opts.out, 'results.md'), md);
  process.stdout.write(`\n${md}`);

  const failures = [];
  for (const t of tiers) {
    if (!t.validator.ok) failures.push(`${t.name}: validator FAIL`);
    if (!t.deterministic) failures.push(`${t.name}: non-deterministic render`);
  }
  for (const c of browser ? browser.checks : []) if (!c.ok) failures.push(`check failed: ${c.name} (${c.detail})`);
  for (const bt of browser ? browser.tiers : []) {
    for (const r of bt.rows) {
      if (r.consoleErrors.length || r.pageErrors.length) failures.push(`${bt.name} ${r.viewport}: console/page errors`);
      if (r.externalRequests.length) failures.push(`${bt.name} ${r.viewport}: external requests`);
      if (r.maxHorizontalOverflowPx > 0) failures.push(`${bt.name} ${r.viewport}: horizontal overflow ${r.maxHorizontalOverflowPx}px`);
      if (r.maxSvgTextOverflow > 0.5) failures.push(`${bt.name} ${r.viewport}: SVG text leaves its box by ${r.maxSvgTextOverflow}`);
      if (r.maxConnectorOverlapPx > 0) failures.push(`${bt.name} ${r.viewport}: connector pill overlaps a card by ${r.maxConnectorOverlapPx}px`);
      if (r.maxClippedLabels > 0) failures.push(`${bt.name} ${r.viewport}: ${r.maxClippedLabels} clipped label(s)`);
      if (r.maxToolbarRows > 1) failures.push(`${bt.name} ${r.viewport}: toolbar wraps to ${r.maxToolbarRows} rows`);
      if (r.minSvgFontUnits !== null && r.minSvgFontUnits < FS_FLOOR) failures.push(`${bt.name} ${r.viewport}: SVG text at ${r.minSvgFontUnits} units, below the ${FS_FLOOR}-unit floor`);
      if (r.cjkChars > 0) failures.push(`${bt.name} ${r.viewport}: ${r.cjkChars} CJK character(s)`);
      if (r.lang !== 'en') failures.push(`${bt.name} ${r.viewport}: lang="${r.lang}"`);
      if (r.errorBox) failures.push(`${bt.name} ${r.viewport}: error box shown`);
      if (bt.name === 'embed_20rules' && r.indexOpenAtLoad) failures.push(`${bt.name} ${r.viewport}: index open at load in embed mode`);
    }
  }
  if (failures.length) {
    process.stderr.write(`\nbench_scale: ${failures.length} failure(s):\n  - ${failures.join('\n  - ')}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { main(); } catch (e) { process.stderr.write(`bench_scale error: ${e.message}\n`); process.exit(1); }
}
