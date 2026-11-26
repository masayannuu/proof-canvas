#!/usr/bin/env node
// proof-canvas structural, safety and honesty gate for board JSON and generated HTML.
// Zero dependencies: Node 22+ standard-library ESM only.
//
// Six gates (error prefixes in parentheses):
//   1. size             (size:)          strict < 512 KB; per-scale budget warns
//   2. structure/schema (html:, data:, board.)
//   3. offline          (offline:)       no external or relative resource loads, no network APIs
//   4. SVG IDs          (svg-markers:)   static <marker> present and unique
//   5. embed safety     (embed-safety:)  no 100vh-style heights, no :root host-token overrides,
//                                         no page-level CSS in embed mode
//   6. provenance       (provenance:)    badge and footer match the statuses and evidence
//   7. sync             (sync:)          --in checks the embedded board against the input JSON
//   8. evidence binding (binding:)       --spec / --log check evidence against the supplied files

import { readFileSync, realpathSync } from 'node:fs';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { bindEvidence, validateBinding } from './evidence.mjs';
import { esc } from './figure.mjs';
import { provenanceBadge, provNote } from './render_board.mjs';
import { DATA_ELEMENT_ID, ROOT_ELEMENT_ID, decodePayload, findPayloads, stripPayloads } from './payload.mjs';
import { MAX_BYTES, RESERVED_HOST_TOKENS, layoutFor, resolveProvenance, sizeBudgetFor, splitRendererKeys, validateBoardData } from './schema.mjs';

const USAGE = `Usage:
  node scripts/validate_board.mjs <board.html | board.json> [--in <board.json>] [--json]
       [--spec <path>]... [--log <path>]...
`;

function parseArgs(argv) {
  const opts = { target: '', jsonPath: '', asJson: false, specPaths: [], logPaths: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (a === '--in' && argv[i + 1]) {
      opts.jsonPath = argv[++i];
    } else if ((a === '--spec' || a === '--log') && argv[i + 1] && !argv[i + 1].startsWith('-')) {
      opts[a === '--spec' ? 'specPaths' : 'logPaths'].push(argv[++i]);
    } else if (a === '--json') {
      opts.asJson = true;
    } else if (!a.startsWith('-') && !opts.target) {
      opts.target = a;
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  if (!opts.target && !opts.jsonPath) throw new Error('Provide a generated HTML file or board JSON file to validate.');
  return opts;
}

const kb = (n) => (n / 1024).toFixed(1);
const SCRIPT_RE = /<script\b[^>]*>[\s\S]*?<\/script\s*>/gi;
const STYLE_RE = /<style\b[^>]*>([\s\S]*?)<\/style\s*>/gi;

// Tags and attributes of the markup (script and style contents removed beforehand).
// User text never forms a tag (the renderer escapes "<"), and attribute checks look at
// attribute names, so text such as title="srcset=..." is not mistaken for a resource.
const TAG_RE = /<([a-zA-Z][\w:-]*)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*\/?>/g;
const ATTR_RE = /([^\s=/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'>]+))?/g;
export function parseTags(markup) {
  return [...markup.matchAll(TAG_RE)].map((m) => {
    const attrs = new Map();
    for (const a of m[2].matchAll(ATTR_RE)) attrs.set(a[1].toLowerCase(), (a[2] ?? '').replace(/^["']|["']$/g, ''));
    return { name: m[1].toLowerCase(), attrs };
  });
}
const loads = (v) => v !== undefined && !/^\s*(?:data:|#)/i.test(v) && v.trim() !== '';
const SRC_TAGS = ['img', 'iframe', 'frame', 'audio', 'video', 'source', 'track', 'embed', 'input'];
function markupLoads(tag) {
  const { name, attrs } = tag;
  const out = [];
  if (name === 'script' && attrs.has('src')) out.push('<script src>');
  if (name === 'link' && loads(attrs.get('href'))) out.push('<link href>');
  if (SRC_TAGS.includes(name) && loads(attrs.get('src'))) out.push(`<${name} src>`);
  if (attrs.has('srcset') || attrs.has('imagesrcset')) out.push('srcset');
  if (name === 'object' && loads(attrs.get('data'))) out.push('<object data>');
  if (loads(attrs.get('xlink:href'))) out.push('xlink:href');
  if (['image', 'use', 'feimage'].includes(name) && loads(attrs.get('href'))) out.push(`<${name} href>`);
  if (loads(attrs.get('poster'))) out.push('poster');
  if (name === 'meta' && /refresh/i.test(attrs.get('http-equiv') || '')) out.push('<meta http-equiv="refresh">');
  if (name === 'base') out.push('<base>');
  return out;
}
const CSS_CHECKS = [
  { name: 'CSS @import', re: /@import\b/gi },
  { name: 'CSS url() resource', re: /url\(\s*["']?\s*(?!data:|#)[^\s"')]/gi },
];
const SCRIPT_CHECKS = [
  { name: 'fetch()', re: /\bfetch\s*\(/g },
  { name: 'XMLHttpRequest', re: /\bXMLHttpRequest\b/g },
  { name: 'WebSocket', re: /\bWebSocket\b/g },
  { name: 'EventSource', re: /\bEventSource\b/g },
  { name: 'sendBeacon', re: /\bsendBeacon\b/g },
  { name: 'dynamic import()', re: /\bimport\s*\(/g },
  { name: 'importScripts', re: /\bimportScripts\b/g },
  { name: 'Worker', re: /\b(?:Shared)?Worker\s*\(/g },
];

// The payload is inert data and user text inside it is never scanned; markup, CSS and
// runtime script are each scanned with the checks that apply to them.
function offlineErrors(html) {
  const noPayload = stripPayloads(html);
  const scripts = [...noPayload.matchAll(SCRIPT_RE)].map((m) => m[0]).join('\n');
  const styleBlocks = [...noPayload.matchAll(STYLE_RE)].map((m) => m[1]);
  const tags = parseTags(noPayload.replace(SCRIPT_RE, (m) => m.slice(0, m.indexOf('>') + 1)).replace(STYLE_RE, ''));
  const css = [...styleBlocks, ...tags.map((t) => t.attrs.get('style')).filter(Boolean)].join('\n');
  const out = [];
  const found = new Map();
  for (const t of tags) for (const what of markupLoads(t)) found.set(what, (found.get(what) || 0) + 1);
  for (const [what, n] of found) out.push(`offline: found ${n} ${what} reference(s)`);
  const run = (checks, text) => {
    for (const c of checks) {
      const m = text.match(c.re);
      if (m && m.length) out.push(`offline: found ${m.length} ${c.name} reference(s) (${m[0].slice(0, 80)})`);
    }
  };
  run(CSS_CHECKS, css);
  run(SCRIPT_CHECKS, scripts);
  return out;
}

export function validateHtmlContent(html, label = '<html>', { specPaths = [], logPaths = [] } = {}) {
  const errors = [];
  const warnings = [];
  const bytes = Buffer.byteLength(html, 'utf8');

  // 2a. Basic HTML structure
  if (!/^\s*<!doctype html>/i.test(html)) errors.push('html: missing <!doctype html>');
  for (const tag of ['<html', '<head', '<body', '</html>', '</head>', '</body>']) {
    if (!html.toLowerCase().includes(tag)) errors.push(`html: missing ${tag}`);
  }

  // 3. Offline
  errors.push(...offlineErrors(html));

  const domHtml = html.replace(SCRIPT_RE, '');
  const domTags = parseTags(domHtml.replace(STYLE_RE, ''));
  const rootTags = domTags.filter((t) => t.attrs.get('id') === ROOT_ELEMENT_ID);
  const mode = rootTags.length && rootTags[0].attrs.get('data-mode') === 'embed' ? 'embed' : 'standalone';

  // 5. Embed safety: the board must sit inside an iframe or inline host without fighting it.
  const allCss = [...html.matchAll(STYLE_RE)].map((m) => m[1]).join('\n');
  if (/\b100[dsl]?vh\b/i.test(allCss)) errors.push('embed-safety: CSS must not use 100vh / 100dvh / 100svh / 100lvh');
  for (const rb of allCss.matchAll(/:root\s*\{([^}]*)\}/gi)) {
    for (const tok of RESERVED_HOST_TOKENS) {
      if (new RegExp(`(?:^|[;\\s])${tok}\\s*:`, 'm').test(rb[1])) errors.push(`embed-safety: forbidden :root override of host design token "${tok}"`);
    }
  }
  if (mode === 'embed' && /(?:^|[}\s,])(?:html|body|:root)\s*[{,]/i.test(allCss)) {
    errors.push('embed-safety: an embed-mode board must not style html, body or :root');
  }

  // 4. Unique static SVG marker IDs (script contents excluded)
  const markerIds = [...domHtml.matchAll(/<marker\b[^>]*\bid\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  const seen = new Set();
  const dup = new Set();
  for (const id of markerIds) { if (seen.has(id)) dup.add(id); seen.add(id); }
  if (dup.size > 0) errors.push(`svg-markers: duplicate static SVG marker ID(s): ${[...dup].join(', ')}`);
  if (markerIds.length === 0) errors.push('svg-markers: no static SSR <marker id="..."> elements found in HTML');

  // 2b. Exactly one root and one payload element
  const roots = rootTags.length;
  if (roots !== 1) errors.push(`html: expected exactly 1 #${ROOT_ELEMENT_ID} element, found ${roots}`);
  const payloads = findPayloads(html);
  if (payloads.length !== 1) errors.push(`data: expected exactly 1 <script id="${DATA_ELEMENT_ID}"> payload, found ${payloads.length}`);

  // 6a. Provenance badge in the server-rendered markup
  const badges = domTags.filter((t) => t.attrs.has('data-provenance')).map((t) => t.attrs.get('data-provenance'));
  const notes = domTags.filter((t) => t.attrs.has('data-provenance-note')).map((t) => t.attrs.get('data-provenance-note'));
  if (badges.length !== 1) errors.push(`provenance: expected exactly 1 data-provenance badge in HTML, found ${badges.length}`);

  // 2c. Decode (size limits are enforced inside decodePayload, before any inflation) + schema
  let decoded;
  let board = null;
  let meta = {};
  let decodedOk = false;
  let checkedBinding;
  if (payloads.length === 1 && bytes < MAX_BYTES) {
    try {
      decoded = decodePayload(payloads[0].type, payloads[0].text);
      decodedOk = true;
    } catch (e) {
      errors.push(`data: invalid embedded payload (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  if (decodedOk) {
    ({ board, meta } = splitRendererKeys(decoded));
    const schemaRes = validateBoardData(board, { checkHash: board?.run?.specHash !== undefined || !meta.__binding?.specHash });
    errors.push(...schemaRes.errors.map((e) => `board.${e}`));
    warnings.push(...schemaRes.warnings.map((w) => `board.${w}`));
    if (schemaRes.ok) {
      // 6b. Check embedded evidence before trusting any badge or note that uses it.
      const binding = meta.__binding;
      let bindingOk = false;
      try {
        validateBinding(board, binding);
        bindingOk = true;
        checkedBinding = binding;
      } catch (err) {
        errors.push('provenance: ' + err.message);
      }
      if (bindingOk) {
        const expected = resolveProvenance(board, binding);
        if (badges.length === 1) {
          if (badges[0] !== expected.kind) {
            errors.push(`provenance: HTML badge shows "${badges[0]}" but the embedded board resolves to "${expected.kind}"`);
          } else if (!domHtml.includes(provenanceBadge(expected))) {
            errors.push('provenance: HTML badge text or tone differs from the embedded evidence');
          }
        }
        const note = `<footer class="pc-foot" data-provenance-note="${expected.kind}"><span>${esc(provNote(expected, board, binding))}</span></footer>`;
        if (notes.length !== 1 || notes[0] !== expected.kind || !domHtml.includes(note)) {
          errors.push(`provenance: footer note does not match the embedded evidence for "${expected.kind}"`);
        }
        if (!isDeepStrictEqual(meta.__provenance, expected)) errors.push('provenance: cached __provenance in the payload does not match the embedded statuses and evidence');
      }

      // 8. Re-read the files even when the HTML evidence passes the structural checks.
      if (specPaths.length || logPaths.length) {
        try {
          const actual = bindEvidence(board, { specPaths, logPaths });
          if (!isDeepStrictEqual(binding, actual)) errors.push('binding: embedded evidence does not match supplied files');
        } catch (err) {
          errors.push(err.message);
        }
      } else if (bindingOk && binding.level !== 'self-reported') {
        warnings.push('binding: embedded evidence was not re-checked against --spec/--log files');
      }
      if (meta.__layout !== layoutFor(board)) errors.push(`data: cached __layout "${meta.__layout}" does not match "${layoutFor(board)}"`);
      if (meta.__titleOverride !== undefined && (typeof meta.__titleOverride !== 'string' || !meta.__titleOverride.trim())) {
        errors.push('data: __titleOverride must be a non-empty string when present');
      }
    }
  } else if (payloads.length === 1 && bytes < MAX_BYTES && !errors.some((e) => e.startsWith('data:'))) {
    errors.push('data: embedded payload could not be decoded');
  }

  // 1. Size: strict ceiling + per-scale budget warning
  const n = Array.isArray(board?.rules) ? board.rules.length : 0;
  const budget = sizeBudgetFor(Math.max(1, n));
  if (bytes >= MAX_BYTES) errors.push(`size: ${bytes} bytes exceeds strict limit of ${MAX_BYTES} bytes (512 KB)`);
  else if (bytes > budget) warnings.push(`size: ${kb(bytes)} KB exceeds the ${kb(budget)} KB budget for ${n} rule(s)`);

  return {
    file: label,
    bytes,
    kb: Number(kb(bytes)),
    budgetKb: Number(kb(budget)),
    rules: n,
    modules: Array.isArray(board?.modules) ? board.modules.length : 0,
    mode,
    payload: payloads.length === 1 ? payloads[0].type : null,
    staticMarkerCount: markerIds.length,
    provenance: badges.length === 1 ? badges[0] : null,
    ok: errors.length === 0,
    errors,
    warnings,
    board,
    binding: checkedBinding,
  };
}

// First path at which two JSON values differ, or null when they are equal.
function firstDiff(a, b, path = '$') {
  if (isDeepStrictEqual(a, b)) return null;
  const isObj = (v) => v && typeof v === 'object';
  if (!isObj(a) || !isObj(b) || Array.isArray(a) !== Array.isArray(b)) return path;
  if (Array.isArray(a) && a.length !== b.length) return `${path} (length ${a.length} vs ${b.length})`;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const d = firstDiff(a[k], b[k], Array.isArray(a) ? `${path}[${k}]` : `${path}.${k}`);
    if (d) return d;
  }
  return path;
}

// The HTML must embed exactly the input board (renderer-owned keys stripped; a --title
// override is stored separately and leaves the board's own title untouched).
export function syncErrors(inputBoard, htmlBoard) {
  const d = firstDiff(htmlBoard, inputBoard);
  return d ? [`sync: the HTML embeds a different board than the input JSON (first difference at ${d})`] : [];
}

function jsonCheck(parsed, label, { specPaths = [], logPaths = [] } = {}, binding) {
  const res = validateBoardData(parsed, { checkHash: !binding?.specHash && specPaths.length === 0 });
  if (res.ok && (specPaths.length || logPaths.length)) {
    try {
      binding = bindEvidence(parsed, { specPaths, logPaths });
    } catch (err) {
      res.errors.push(err.message);
      res.ok = false;
    }
  }
  return {
    kind: 'json',
    file: label,
    rules: Array.isArray(parsed?.rules) ? parsed.rules.length : 0,
    provenance: res.ok ? resolveProvenance(parsed, binding).kind : null,
    ...res,
  };
}

function main() {
  try {
    const opts = parseArgs(process.argv.slice(2));
    const report = { ok: true, checks: [] };
    const inputBoard = opts.jsonPath ? JSON.parse(readFileSync(resolve(opts.jsonPath), 'utf8')) : undefined;

    if (opts.target && extname(opts.target).toLowerCase() !== '.json') {
      const raw = readFileSync(resolve(opts.target), 'utf8');
      const { board, binding, ...summary } = validateHtmlContent(raw, opts.target, opts);
      if (opts.jsonPath) {
        report.checks.push(jsonCheck(inputBoard, opts.jsonPath, {}, binding));
        if (board) summary.errors.push(...syncErrors(inputBoard, board));
        else summary.errors.push('sync: no decodable board in the HTML to compare with the input JSON');
        summary.ok = summary.errors.length === 0;
      }
      report.checks.push({ kind: 'html', ...summary });
    } else {
      if (opts.jsonPath) report.checks.push(jsonCheck(inputBoard, opts.jsonPath, opts));
      if (opts.target) {
        const raw = readFileSync(resolve(opts.target), 'utf8');
        report.checks.push(jsonCheck(JSON.parse(raw), opts.target, opts));
      }
    }
    report.ok = report.checks.every((c) => c.ok);

    if (opts.asJson) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      for (const c of report.checks) {
        const meta = c.kind === 'html'
          ? `${c.bytes} bytes (${c.kb} KB / budget ${c.budgetKb} KB), ${c.rules} rule(s), ${c.modules} modules, mode=${c.mode}, payload=${c.payload}, ${c.staticMarkerCount} SVG markers, provenance=${c.provenance}`
          : `${c.rules} rule(s), provenance=${c.provenance}`;
        process.stdout.write(`[${c.ok ? 'PASS' : 'FAIL'}] ${c.kind.toUpperCase()} ${c.file}: ${meta}\n`);
        for (const w of c.warnings || []) process.stdout.write(`  WARN: ${w}\n`);
        for (const e of c.errors || []) process.stdout.write(`  ERR:  ${e}\n`);
      }
    }
    process.exit(report.ok ? 0 : 1);
  } catch (err) {
    process.stderr.write(`validate_board error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main();
}
