#!/usr/bin/env node
// Self-tests for the proof-canvas renderer and gates. Each negative case breaks exactly one
// thing and asserts that the gate fails *for that reason* (by error prefix), not merely that
// it exits non-zero. Run: node scripts/test_validator.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { GZIP_TYPE, JSON_TYPE, MAX_DECODED_BYTES, MAX_PAYLOAD_TEXT_BYTES, decodePayload, encodePayload, findPayloads } from './payload.mjs';
import { FIGURE_KINDS, GEOM, figSvg, figureOverflows, figureRuntime, layoutBoxLabel, pillBox, relLayout, stmLayout, textW, tlLayout } from './figure.mjs';
import { checkpointFocus, flowLayout, flowOverflows, flowRuntime, flowView } from './flow.mjs';
import { bindEvidence, parseMutantFlag, validateBinding } from './evidence.mjs';
import { uiFor, uiSource } from './i18n.mjs';
import { ALL_JOURNEYS, footerMarkup, oosMarkup, provLabel, renderBoardHtml, ruleEvidenceDetails, toolLabel } from './render_board.mjs';
import { SAFE_ID, isRealHash, layoutFor, resolveProvenance, ruleStatus, splitRendererKeys, validateBoardData } from './schema.mjs';
import { synthBoard } from './synth_board.mjs';
import { validateHtmlContent } from './validate_board.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = join(ROOT, 'scripts');
const load = (f) => JSON.parse(readFileSync(join(ROOT, 'examples', f), 'utf8'));
const EXAMPLES = {
  '00_minimal': load('00_minimal.board.json'),
  '01_room_booking': load('01_room_booking.board.json'),
  '02_escrow_payout': load('02_escrow_payout.board.json'),
  '03_multi_module_20rules': load('03_multi_module_20rules.board.json'),
};
const EX0 = EXAMPLES['00_minimal'];
const EX1 = EXAMPLES['01_room_booking'];
const EX2 = EXAMPLES['02_escrow_payout'];
const EX3 = EXAMPLES['03_multi_module_20rules'];
const clone = (o) => structuredClone(o);
const EN = uiFor({});
const CJK = /[\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uff00-\uffef]/;
const TMP = mkdtempSync(join(tmpdir(), 'proof-canvas-test-'));

const results = [];
function test(name, fn) {
  try {
    fn();
    results.push({ name, ok: true });
  } catch (e) {
    results.push({ name, ok: false, msg: e instanceof Error ? e.message : String(e) });
  }
}

function expectFail(html, prefix) {
  const r = validateHtmlContent(html);
  assert.equal(r.ok, false, `expected validator to fail with "${prefix}", but it passed`);
  assert.ok(r.errors.some((e) => e.startsWith(prefix)), `expected an error starting with "${prefix}", got:\n  ${r.errors.join('\n  ')}`);
  return r;
}
function expectPass(html) {
  const r = validateHtmlContent(html);
  assert.equal(r.ok, true, r.errors.join('\n'));
  return r;
}
const footerNote = (html) => html.match(/data-provenance-note="[^"]*"><span>([^<]*)<\/span>/)[1];
const hasWarning = (res, prefix) => res.warnings.some((w) => w.startsWith(prefix));
const schemaErr = (board, prefix) => {
  const r = validateBoardData(board);
  assert.equal(r.ok, false, `expected a schema error at ${prefix}`);
  assert.ok(r.errors.some((e) => e.startsWith(prefix)), `expected an error starting with "${prefix}", got:\n  ${r.errors.join('\n  ')}`);
};

// Replace the embedded payload of a valid rendering with an edited copy. This is how invalid
// boards reach the validator: renderBoardHtml itself refuses to render them.
function tamper(html, edit) {
  const [p] = findPayloads(html);
  const decoded = decodePayload(p.type, p.text);
  const next = edit(decoded) ?? decoded;
  const enc = encodePayload(next, p.type === GZIP_TYPE ? 'gzip' : 'json');
  return html.replace(p.text, () => enc.text);
}
function replacePayloadText(html, text) {
  const [p] = findPayloads(html);
  return html.replace(p.text, () => text);
}
const node = (script, args) => spawnSync(process.execPath, [join(SCRIPTS, script), ...args], { encoding: 'utf8' });
const tmpFile = (name, text) => { const f = join(TMP, name); writeFileSync(f, text); return f; };

// A board with a plausible spec hash and no declared provenance: the badge is computed from statuses.
function realRun(base = EX3) {
  const b = clone(base);
  delete b.provenance;
  delete b.provenanceNote;
  b.run = { tool: 'TLA+ TLC', toolVersion: 'TLC 2.19', specHash: 'sha256:3f9a1c27e4b8', status: 'verified' };
  for (const r of b.rules) { r.status = 'verified'; delete r.evidence.counterexample; }
  return b;
}

const baseHtml = renderBoardHtml(EX1);

// ---------------------------------------------------------------------------------------------
// Examples
// ---------------------------------------------------------------------------------------------
for (const [name, board] of Object.entries(EXAMPLES)) {
  test(`example ${name}: schema has no errors and no warnings`, () => {
    const r = validateBoardData(board);
    assert.equal(r.ok, true, r.errors.join('\n'));
    assert.deepEqual(r.warnings, []);
  });
  for (const payload of ['json', 'gzip']) {
    test(`example ${name}: ${payload} rendering passes every gate with no warnings`, () => {
      const r = expectPass(renderBoardHtml(board, { payload }));
      assert.deepEqual(r.warnings, []);
    });
  }
}
test('docs: SKILL.md reproduces examples/00_minimal.board.json verbatim', () => {
  const skill = readFileSync(join(ROOT, 'skills', 'proof-canvas', 'SKILL.md'), 'utf8');
  const minimal = readFileSync(join(ROOT, 'examples', '00_minimal.board.json'), 'utf8');
  assert.ok(skill.includes(`\`\`\`json\n${minimal}\`\`\``), 'SKILL.md and 00_minimal.board.json differ');
});
test('examples: rule and module counts match the docs', () => {
  const counts = (b) => {
    const c = { verified: 0, failed: 0, pending: 0 };
    for (const r of b.rules) c[r.status ?? 'pending'] += 1;
    return [b.rules.length, (b.modules || []).length, c.verified, c.failed, c.pending];
  };
  assert.deepEqual(counts(EX0), [1, 0, 1, 0, 0]);
  assert.deepEqual(counts(EX1), [3, 0, 3, 0, 0]);
  assert.deepEqual(counts(EX2), [12, 3, 9, 1, 2]);
  assert.deepEqual(counts(EX3), [20, 4, 17, 1, 2]);
});
test('examples: every example is honestly declared sample and resolves to sample', () => {
  for (const b of Object.values(EXAMPLES)) {
    assert.equal(b.provenance, 'sample');
    assert.equal(resolveProvenance(b).kind, 'sample');
  }
});
test('examples: only failed rules carry a counterexample', () => {
  for (const [name, b] of Object.entries(EXAMPLES)) {
    for (const r of b.rules) {
      if (r.evidence.counterexample !== undefined) assert.equal(r.status, 'failed', `${name}: ${r.id} has a counterexample but is ${r.status}`);
    }
  }
});
test('examples: the failed escrow rule carries a TLC counterexample', () => {
  const failed = EX2.rules.filter((r) => r.status === 'failed');
  assert.equal(failed.length, 1);
  assert.match(failed[0].evidence.counterexample, /Invariant \w+ is violated/);
  assert.equal(EX2.run.tool, 'TLA+ TLC');
});
test('layout: up to 6 rules without modules is compact; multi-module boards use the index', () => {
  assert.equal(layoutFor(EX0), 'compact');
  assert.equal(layoutFor(EX1), 'compact');
  assert.equal(layoutFor(EX2), 'index');
  assert.equal(layoutFor(EX3), 'index');
});

// ---------------------------------------------------------------------------------------------
// Provenance branches (fixtures for every kind)
// ---------------------------------------------------------------------------------------------
test('provenance: all rules marked verified without evidence are self-reported', () => {
  const b = realRun();
  assert.equal(resolveProvenance(b).kind, 'verified');
  const html = renderBoardHtml(b);
  assert.equal(expectPass(html).provenance, 'verified');
  assert.match(html, /pc-prov-warn[^>]*><span[^>]*><\/span>Self-reported \(20\/20\)/);
  assert.equal(footerNote(html), 'All 20 rules are marked verified in JSON, but no spec file or checker log was checked by proof-canvas.');
});
test('provenance: one pending rule resolves to mixed', () => {
  const b = realRun();
  b.rules[0].status = 'pending';
  b.run.status = 'pending';
  assert.equal(resolveProvenance(b).kind, 'mixed');
  assert.equal(expectPass(renderBoardHtml(b)).provenance, 'mixed');
});
test('provenance: one failed rule resolves to failed with the failure count in the label', () => {
  const b = realRun(EX2);
  b.rules[4].status = 'failed';
  b.run.status = 'failed';
  const p = resolveProvenance(b);
  assert.equal(p.kind, 'failed');
  assert.equal(provLabel(p, EN), '1 failed · 11/12 verified');
  const html = renderBoardHtml(b);
  assert.equal(expectPass(html).provenance, 'failed');
  assert.ok(html.includes('1 failed · 11/12 verified'));
});
test('provenance: a run failure without a failed rule still resolves to failed', () => {
  const b = realRun();
  b.run.status = 'failed';
  const p = resolveProvenance(b);
  assert.equal(p.kind, 'failed');
  assert.match(provLabel(p, EN), /^Run failed · 20\/20 verified$/);
});
test('provenance: nothing checked resolves to unverified', () => {
  const b = realRun();
  for (const r of b.rules) r.status = 'pending';
  b.run.status = 'pending';
  assert.equal(resolveProvenance(b).kind, 'unverified');
  assert.equal(expectPass(renderBoardHtml(b)).provenance, 'unverified');
});
test('provenance: a failure wins over a missing spec hash (not hidden as sample)', () => {
  const b = clone(EX2);
  delete b.provenance;
  delete b.provenanceNote;
  assert.equal(b.run.specHash, undefined);
  assert.equal(resolveProvenance(b).kind, 'failed');
  assert.equal(expectPass(renderBoardHtml(b)).provenance, 'failed');
});
test('provenance: a declared sample stays sample even with a failed rule', () => {
  assert.equal(resolveProvenance(EX2).kind, 'sample');
});
test('provenance: a declared mixed caps an otherwise verified board', () => {
  const b = realRun();
  b.provenance = 'mixed';
  assert.equal(resolveProvenance(b).kind, 'mixed');
});
test('provenance: a declared unverified caps a board with verified rules, and the text says so', () => {
  const b = realRun();
  b.provenance = 'unverified';
  const p = resolveProvenance(b);
  assert.equal(p.kind, 'unverified');
  assert.equal(provLabel(p, EN), 'Unverified (20/20)');
  const html = renderBoardHtml(b);
  assert.equal(expectPass(html).provenance, 'unverified');
  assert.equal(footerNote(html), '20 of 20 rules are marked verified, but the board is declared unverified. Self-reported JSON. No spec file or checker log was checked.');
});
test('provenance: every rule verified but no spec hash is mixed, and the note gives the reason', () => {
  const b = realRun();
  delete b.run.specHash;
  const p = resolveProvenance(b);
  assert.equal(p.kind, 'mixed');
  const html = renderBoardHtml(b);
  assert.match(footerNote(html), /^All 20 rules are marked verified, but the run is not/);
});
test('provenance: a malformed hash with nothing verified resolves to sample', () => {
  const b = realRun();
  for (const r of b.rules) r.status = 'pending';
  b.run.status = 'pending';
  b.run.specHash = 'not-a-hash';
  assert.equal(resolveProvenance(b).kind, 'sample');
});
test('provenance: declared verified with a blocker is a schema error listing the reason', () => {
  const b = realRun();
  b.provenance = 'verified';
  b.rules[3].status = 'pending';
  schemaErr(b, '$.provenance');
  assert.throws(() => renderBoardHtml(b), /Invalid board/);
});

// ---------------------------------------------------------------------------------------------
// Spec hash
// ---------------------------------------------------------------------------------------------
test('spec hash: hex with an optional sha prefix is real; zeros and placeholders are not', () => {
  for (const h of ['3f9a1c2', 'sha256:3f9a1c27e4b8', 'SHA1:ABCDEF0123', `sha512:${'a'.repeat(128)}`]) assert.equal(isRealHash(h), true, h);
  for (const h of ['0000000', 'sha256:00000000', 'sample-hash', 'abc', 'sha3:3f9a1c27', `${'a'.repeat(129)}`, '']) assert.equal(isRealHash(h), false, h);
});
test('spec hash: an all-zero hash blocks Verified and warns at $.run.specHash', () => {
  const b = realRun();
  b.run.specHash = 'sha256:0000000000000000';
  const r = validateBoardData(b);
  assert.equal(r.ok, true);
  assert.ok(hasWarning(r, '$.run.specHash'), r.warnings.join('\n'));
  assert.equal(resolveProvenance(b).kind, 'mixed');
});
test('spec hash: a non-string hash is an error', () => {
  const b = realRun();
  b.run.specHash = 12345678;
  schemaErr(b, '$.run.specHash');
});

// ---------------------------------------------------------------------------------------------
// Schema v1
// ---------------------------------------------------------------------------------------------
test('schema: run.tool is required, run.toolVersion is optional', () => {
  const b = clone(EX1);
  delete b.run.toolVersion;
  assert.equal(validateBoardData(b).ok, true);
  delete b.run.tool;
  schemaErr(b, '$.run.tool');
});
test('schema: run.status and rule status only accept verified | failed | pending', () => {
  const b = clone(EX1);
  b.run.status = 'sealed';
  schemaErr(b, '$.run.status');
  const c = clone(EX1);
  c.rules[0].status = 'passed';
  schemaErr(c, '$.rules[0].status');
});
test('schema: the old top-level layout (seal + scenarios) is rejected', () => {
  const b = clone(EX1);
  b.seal = b.run;
  b.scenarios = b.rules;
  delete b.run;
  delete b.rules;
  const r = validateBoardData(b);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => e.startsWith('$.run')));
  assert.ok(r.errors.some((e) => e.startsWith('$.rules')));
  assert.ok(hasWarning(r, '$.seal') && hasWarning(r, '$.scenarios'), r.warnings.join('\n'));
});
test('schema: unknown keys warn at every level (typo such as counterExample is caught)', () => {
  const b = clone(EX1);
  b.extra = 1;
  b.run.iteration = 3;
  b.rules[0].engine = 'x';
  b.rules[0].evidence.counterExample = 'typo';
  b.rules[0].states.bug.preview.rows[0].key = 'x';
  const r = validateBoardData(b);
  assert.equal(r.ok, true, r.errors.join('\n'));
  for (const p of ['$.extra', '$.run.iteration', '$.rules[0].engine', '$.rules[0].evidence.counterExample', '$.rules[0].states.bug.preview.rows[0].key']) {
    assert.ok(hasWarning(r, p), `missing warning for ${p}:\n  ${r.warnings.join('\n  ')}`);
  }
});
test('schema: top-level keys starting with "__" are reserved for the renderer', () => {
  const b = clone(EX1);
  b.__provenance = { kind: 'verified' };
  schemaErr(b, '$.__provenance');
});
test('schema: optional fields are strictly typed when present', () => {
  const cases = [
    [(b) => { b.rules[0].category = 5; }, '$.rules[0].category'],
    [(b) => { b.rules[0].stepsChecked = -1; }, '$.rules[0].stepsChecked'],
    [(b) => { b.rules[0].stepsChecked = 1.5; }, '$.rules[0].stepsChecked'],
    [(b) => { b.rules[0].evidence.sourceQuote = 3; }, '$.rules[0].evidence.sourceQuote'],
    [(b) => { b.rules[0].evidence.counterexample = ['State 1']; }, '$.rules[0].evidence.counterexample'],
    [(b) => { b.run.toolVersion = ''; }, '$.run.toolVersion'],
    [(b) => { b.provenanceNote = '   '; }, '$.provenanceNote'],
    [(b) => { b.rules[1].states.normal.preview.bars[0].unit = 5; }, '$.rules[1].states.normal.preview.bars[0].unit'],
    [(b) => { b.rules[0].states.normal.preview.logLines = ['ok', 2]; }, '$.rules[0].states.normal.preview.logLines'],
  ];
  for (const [edit, prefix] of cases) {
    const b = clone(EX1);
    edit(b);
    schemaErr(b, prefix);
  }
});
test('schema: modules — unknown moduleId and moduleId without modules[] fail', () => {
  const b = clone(EX3);
  b.rules[3].moduleId = 'nope';
  schemaErr(b, '$.rules[3].moduleId');
  const c = clone(EX1);
  c.rules[0].moduleId = 'booking';
  schemaErr(c, '$.rules[0].moduleId');
});
test('schema: a module whose id is "all" is legal, and "*" (all journeys) can never be a journey id', () => {
  assert.equal(SAFE_ID.test(ALL_JOURNEYS), false);
  const b = clone(EX3);
  b.modules[0].id = 'all';
  for (const r of b.rules) if (r.moduleId === 'booking') r.moduleId = 'all';
  expectPass(renderBoardHtml(b));
});
test('schema: warnings for long short / edgeShort labels', () => {
  const b = clone(EX1);
  b.rules[0].short = 'A short label that is far too long';
  b.rules[0].states.bug.edgeShort = 'Thirty minute clash';
  const r = validateBoardData(b);
  assert.equal(r.ok, true);
  assert.ok(hasWarning(r, '$.rules[0].short'));
  assert.ok(hasWarning(r, '$.rules[0].states.bug.edgeShort'));
});
test('schema: figure text that cannot fit warns (box label, arrow label, chip)', () => {
  const b = clone(EX1);
  b.rules[0].figure.boxes.gate = 'A gate label that is much too long to fit on two lines of the box';
  b.rules[0].figure.arrows.a1 = 'a label that is far too wide for its gap';
  b.rules[0].states.normal.chips[2].text = 'a chip text that overflows the box width';
  const r = validateBoardData(b);
  assert.equal(r.ok, true);
  for (const path of ['$.rules[0].figure.boxes.gate', '$.rules[0].figure.arrows.a1', '$.rules[0].states.normal.chips[2].text']) {
    assert.ok(hasWarning(r, path), `missing warning for ${path}:\n  ${r.warnings.join('\n  ')}`);
  }
});
test('schema: flat boards without modules[] are valid', () => {
  assert.equal(EX1.modules, undefined);
  assert.equal(validateBoardData(EX1).ok, true);
});
test('schema: a non-object root is rejected, not crashed on', () => {
  for (const root of [null, 0, '', [], 'board']) {
    const r = validateBoardData(root);
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => e.startsWith('$')), r.errors.join('\n'));
  }
});

// ---------------------------------------------------------------------------------------------
// renderBoardHtml boundary
// ---------------------------------------------------------------------------------------------
test('render: an invalid board throws instead of rendering a partial page', () => {
  const b = clone(EX1);
  delete b.rules[0].figure.boxes.gate;
  assert.throws(() => renderBoardHtml(b), /Invalid board:[\s\S]*figure\.boxes\.gate/);
  assert.throws(() => renderBoardHtml(null), /Invalid board/);
});
test('render: invalid options throw', () => {
  assert.throws(() => renderBoardHtml(EX1, null), /options must be an object/);
  assert.throws(() => renderBoardHtml(EX1, []), /options must be an object/);
  assert.throws(() => renderBoardHtml(EX1, { mode: 'inline' }), /Invalid mode/);
  assert.throws(() => renderBoardHtml(EX1, { payload: 'brotli' }), /Invalid payload/);
  assert.throws(() => renderBoardHtml(EX1, { title: '' }), /title must be a non-empty string/);
  assert.throws(() => renderBoardHtml(EX1, { title: 7 }), /title must be a non-empty string/);
});
test('render: the server-rendered badge equals the computed provenance for every kind', () => {
  const fixtures = [EX1, realRun()];
  const mixed = realRun(); mixed.rules[0].status = 'pending'; fixtures.push(mixed);
  const failed = realRun(); failed.rules[0].status = 'failed'; fixtures.push(failed);
  const none = realRun(); for (const r of none.rules) r.status = 'pending'; fixtures.push(none);
  for (const b of fixtures) {
    const html = renderBoardHtml(b);
    const m = html.match(/data-provenance="([^"]+)"/);
    assert.equal(m[1], resolveProvenance(b).kind);
  }
});
test('render: byte-for-byte deterministic', () => {
  const big = synthBoard({ rules: 100, modules: 20, failed: 5, unverified: 20, seed: 7 });
  assert.equal(renderBoardHtml(big), renderBoardHtml(big));
  assert.equal(renderBoardHtml(EX3), renderBoardHtml(EX3));
});
test('render: English only — lang="en", no CJK characters, no language toggle', () => {
  for (const b of Object.values(EXAMPLES)) {
    for (const mode of ['standalone', 'embed']) {
      const html = renderBoardHtml(b, { mode });
      assert.match(html, /<html lang="en">/);
      assert.equal(CJK.test(html), false, 'found a CJK or full-width character');
      assert.equal(/lang-btn|I18N|data-lang/.test(html), false);
    }
  }
});
test('figure: long box labels wrap to two lines without overflow; uppercase is measured wider', () => {
  const two = layoutBoxLabel('Return HTTP 409 Conflict', GEOM.pass.w - 16, true);
  assert.equal(two.lines.length, 2);
  assert.equal(two.overflow, false);
  assert.deepEqual(two.lines, ['Return HTTP', '409 Conflict']);
  const one = layoutBoxLabel('Confirm booking', GEOM.pass.w - 16, false);
  assert.equal(one.lines.length, 1);
  assert.equal(layoutBoxLabel('An outcome label that is far too long to fit even on two lines', GEOM.gate.w - 16, true).overflow, true);
  assert.ok(textW('HTTP', 10) > textW('http', 10));
  assert.ok(Math.abs(textW('ABCD', 10) - 4 * 0.76 * 10) < 1e-9);
});
test('render: the run footer deduplicates tool and version', () => {
  assert.equal(toolLabel({ tool: 'TLA+ TLC', toolVersion: 'TLC 2.19' }), 'TLA+ TLC 2.19');
  assert.equal(toolLabel({ tool: 'Lean 4', toolVersion: 'Lean 4.12' }), 'Lean 4.12');
  assert.equal(toolLabel({ tool: 'Alloy', toolVersion: '6.1' }), 'Alloy 6.1');
  assert.equal(toolLabel({ tool: 'Example checker' }), 'Example checker');
});
test('render: modules are named by their own title, with no synthesized M1 / M2 codes', () => {
  const html = renderBoardHtml(EX2);
  assert.equal(/ix-mod-no|hub-no|\bM[1-9] ·/.test(html), false);
  const b = clone(EX2);
  b.modules[1].title = 'M7 · Disputes';
  assert.ok(renderBoardHtml(b).includes('<h2>M7 · Disputes</h2>'), 'an author-written title is kept verbatim');
});
test('render: --title override is stored apart from the board and keeps the board in sync', () => {
  const html = renderBoardHtml(EX1, { title: 'Custom title' });
  const [p] = findPayloads(html);
  const { board, meta } = splitRendererKeys(decodePayload(p.type, p.text));
  assert.equal(meta.__titleOverride, 'Custom title');
  assert.deepEqual(board, EX1);
  assert.ok(html.includes('<title>Custom title</title>'));
});
test('render: every board selector is scoped to .pc-root (only standalone html/body are page-level)', () => {
  const selectors = (css) => {
    const noFrames = css.replace(/@keyframes[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    return [...noFrames.matchAll(/(?:^|[{}])\s*([^{}@][^{}]*?)\{/g)].flatMap((m) => m[1].split(',').map((x) => x.trim())).filter(Boolean);
  };
  for (const b of [EX1, EX3]) {
    for (const mode of ['standalone', 'embed']) {
      const css = renderBoardHtml(b, { mode }).match(/<style>([\s\S]*?)<\/style>/)[1];
      const loose = selectors(css).filter((x) => !x.startsWith('.pc-root') && !x.startsWith(':where(.pc-root) '));
      assert.deepEqual([...new Set(loose)], mode === 'standalone' ? ['html', 'body'] : []);
      assert.match(css, /@keyframes pc-fgflow/);
    }
  }
});
test('render: embed mode emits no page-level CSS and passes the gates', () => {
  const html = renderBoardHtml(EX3, { mode: 'embed' });
  expectPass(html);
  assert.match(html, /data-mode="embed"/);
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
  assert.equal(/(?:^|[}\s,])(?:html|body)\s*[{,]/.test(css), false);
});

// ---------------------------------------------------------------------------------------------
// Payload codec
// ---------------------------------------------------------------------------------------------
test('payload: gzip round-trips to the same board', () => {
  const html = renderBoardHtml(EX3, { payload: 'gzip' });
  const [p] = findPayloads(html);
  assert.equal(p.type, GZIP_TYPE);
  assert.deepEqual(splitRendererKeys(decodePayload(p.type, p.text)).board, EX3);
});
test('payload: auto switches to gzip for large boards; 200 rules as plain JSON exceed 512 KB', () => {
  const big = synthBoard({ rules: 200, modules: 20, failed: 5, unverified: 20, seed: 7 });
  const auto = renderBoardHtml(big);
  assert.equal(findPayloads(auto)[0].type, GZIP_TYPE);
  const r = expectPass(auto);
  assert.equal(r.provenance, 'sample');
  expectFail(renderBoardHtml(big, { payload: 'json' }), 'size:');
});
test('payload: small boards stay plain JSON in auto mode', () => {
  assert.equal(findPayloads(baseHtml)[0].type, JSON_TYPE);
});
test('payload: non-strict base64 (URL-safe alphabet, missing padding) is rejected', () => {
  const html = renderBoardHtml(EX3, { payload: 'gzip' });
  const [p] = findPayloads(html);
  expectFail(replacePayloadText(html, p.text.replace(/[+/]/g, (c) => (c === '+' ? '-' : '_'))), 'data: invalid embedded payload');
  assert.throws(() => decodePayload(GZIP_TYPE, 'H4sI'), /strict standard base64|incorrect header|unexpected end/);
  assert.throws(() => decodePayload(GZIP_TYPE, 'H4sIAA'), /strict standard base64/);
});
test('payload: a decompression bomb is stopped at 4 MiB', () => {
  const bomb = gzipSync(Buffer.from(`"${'a'.repeat(MAX_DECODED_BYTES + 16)}"`)).toString('base64');
  assert.ok(bomb.length < 64 * 1024);
  assert.throws(() => decodePayload(GZIP_TYPE, bomb), /inflates beyond/);
  const html = renderBoardHtml(EX3, { payload: 'gzip' });
  expectFail(replacePayloadText(html, bomb), 'data: invalid embedded payload');
});
test('payload: the outer text size is checked before any decoding', () => {
  assert.throws(() => decodePayload(GZIP_TYPE, 'A'.repeat(MAX_PAYLOAD_TEXT_BYTES)), /payload text is/);
  assert.throws(() => decodePayload(JSON_TYPE, ' '.repeat(MAX_PAYLOAD_TEXT_BYTES)), /payload text is/);
});
test('payload: encoding refuses a board over 4 MiB', () => {
  assert.throws(() => encodePayload({ blob: 'x'.repeat(MAX_DECODED_BYTES) }), /the limit is/);
});
test('payload: corrupted gzip fails', () => {
  const html = renderBoardHtml(EX3, { payload: 'gzip' });
  const [p] = findPayloads(html);
  expectFail(replacePayloadText(html, `AAAA${p.text.slice(40)}`), 'data: invalid embedded payload');
});
test('payload: falsy or non-object roots fail', () => {
  for (const text of ['null', '0', 'false', '""', '[]']) {
    expectFail(replacePayloadText(baseHtml, text), 'board.$');
  }
});

// ---------------------------------------------------------------------------------------------
// Gate 1: size
// ---------------------------------------------------------------------------------------------
test('size: a page of 512 KB or more fails', () => {
  expectFail(baseHtml.replace('</body>', `<!-- ${'x'.repeat(530 * 1024)} --></body>`), 'size:');
});

// ---------------------------------------------------------------------------------------------
// Gate 2: structure and schema of the embedded board
// ---------------------------------------------------------------------------------------------
test('structure: missing doctype fails', () => {
  expectFail(baseHtml.replace(/^<!doctype html>/i, ''), 'html: missing <!doctype html>');
});
test('structure: a duplicate payload element fails', () => {
  const [p] = findPayloads(baseHtml);
  const el = `<script id="proof-canvas-data" type="${p.type}">${p.text}</script>`;
  assert.ok(baseHtml.includes(el));
  expectFail(baseHtml.replace(el, () => el + el), 'data: expected exactly 1');
});
test('structure: a missing or duplicate root element fails', () => {
  expectFail(baseHtml.replace('id="proof-canvas-root"', 'id="other-root"'), 'html: expected exactly 1');
  expectFail(baseHtml.replace('</body>', '<div id="proof-canvas-root"></div></body>'), 'html: expected exactly 1');
});
test('schema via payload: a tampered board missing its gate box fails', () => {
  expectFail(tamper(baseHtml, (d) => { delete d.rules[0].figure.boxes.gate; }), 'board.$.rules[0].figure.boxes.gate');
});
test('schema via payload: a tampered gzip board missing its "fixed" state fails', () => {
  const html = renderBoardHtml(EX3, { payload: 'gzip' });
  expectFail(tamper(html, (d) => { delete d.rules[1].states.fixed; }), 'board.$.rules[1].states.fixed');
});
test('data: a cached __layout that disagrees with the board fails', () => {
  expectFail(tamper(baseHtml, (d) => { d.__layout = 'index'; }), 'data: cached __layout');
});

// ---------------------------------------------------------------------------------------------
// Gate 3: offline
// ---------------------------------------------------------------------------------------------
const OFFLINE = [
  ['external <script src>', '</head>', '<script src="https://cdn.example.com/x.js"></script></head>'],
  ['CSS url()', '<style>', '<style>.x{background:url(https://example.com/a.png)}'],
  ['CSS @import', '<style>', '<style>@import "https://example.com/a.css";'],
  ['inline style url()', '<body>', '<body><div style="background:url(//example.com/a.png)"></div>'],
  ['fetch()', '</body>', '<script>fetch("https://example.com/beacon")</script></body>'],
  ['WebSocket', '</body>', '<script>new WebSocket("wss://example.com")</script></body>'],
  ['sendBeacon', '</body>', '<script>navigator.sendBeacon("/b", "x")</script></body>'],
  ['dynamic import()', '</body>', '<script>import("https://example.com/m.js")</script></body>'],
  ['srcset', '<body>', '<body><img srcset="https://example.com/a.png 1x">'],
  ['xlink:href', '<body>', '<body><svg><image xlink:href="https://example.com/a.png"/></svg>'],
  ['meta refresh', '</head>', '<meta http-equiv="refresh" content="0; url=https://example.com"></head>'],
  ['<base>', '</head>', '<base href="https://example.com/"></head>'],
  ['<link href>', '</head>', '<link rel="stylesheet" href="https://example.com/a.css"></head>'],
];
for (const [what, anchor, inject] of OFFLINE) {
  test(`offline: ${what} fails`, () => {
    assert.ok(baseHtml.includes(anchor));
    expectFail(baseHtml.replace(anchor, () => inject), 'offline:');
  });
}
test('offline: URLs and API names inside board text are data, not loads (JSON and gzip)', () => {
  const b = clone(EX1);
  b.rules[0].title = 'Rejects srcset=x.png and href=https://evil.example';
  b.rules[0].evidence.sourceQuote = 'See https://example.com/spec and url(https://example.com/a.png); fetch("x"), import("y"), new WebSocket("z"), sendBeacon.';
  b.rules[0].states.bug.preview.logLines = ['<script src="https://example.com/x.js"></script>', '@import url(evil.css)'];
  for (const payload of ['json', 'gzip']) expectPass(renderBoardHtml(b, { payload }));
});

// ---------------------------------------------------------------------------------------------
// Gate 4: SVG marker IDs
// ---------------------------------------------------------------------------------------------
test('svg-markers: duplicate static marker id fails', () => {
  const marker = baseHtml.match(/<marker\b[^>]*>[\s\S]*?<\/marker>/)[0];
  expectFail(baseHtml.replace(marker, () => marker + marker), 'svg-markers: duplicate');
});
test('svg-markers: no static marker fails', () => {
  const cut = baseHtml.indexOf('<script');
  const stripped = baseHtml.slice(0, cut).replace(/<marker\b[^>]*>[\s\S]*?<\/marker>/g, '') + baseHtml.slice(cut);
  expectFail(stripped, 'svg-markers: no static');
});

// ---------------------------------------------------------------------------------------------
// Gate 5: embed safety
// ---------------------------------------------------------------------------------------------
test('embed-safety: 100vh / 100dvh fail', () => {
  expectFail(baseHtml.replace('<style>', '<style>.pc-root{min-height:100vh}'), 'embed-safety: CSS must not use 100vh');
  expectFail(baseHtml.replace('<style>', '<style>.pc-root{height:100dvh}'), 'embed-safety: CSS must not use 100vh');
});
test('embed-safety: :root host-token override fails', () => {
  expectFail(baseHtml.replace('<style>', '<style>:root{--background:#000}'), 'embed-safety: forbidden :root override');
});
test('embed-safety: an embed-mode board that styles body fails', () => {
  const html = renderBoardHtml(EX1, { mode: 'embed' });
  expectFail(html.replace('<style>', '<style>body{margin:0}'), 'embed-safety: an embed-mode board must not style');
});

// ---------------------------------------------------------------------------------------------
// Gate 6: provenance honesty
// ---------------------------------------------------------------------------------------------
test('provenance: a sample board whose badge claims "verified" fails', () => {
  expectFail(baseHtml.replace('data-provenance="sample"', 'data-provenance="verified"'), 'provenance: HTML badge shows "verified"');
});
test('provenance: a missing or duplicated badge fails', () => {
  expectFail(baseHtml.replace(/data-provenance="[^"]*"/g, ''), 'provenance: expected exactly 1');
  expectFail(baseHtml.replace('</body>', '<span data-provenance="sample"></span></body>'), 'provenance: expected exactly 1');
});
test('provenance: a footer note that disagrees fails', () => {
  expectFail(baseHtml.replace('data-provenance-note="sample"', 'data-provenance-note="verified"'), 'provenance: footer note');
});
test('provenance: a tampered status under a stale cached badge fails', () => {
  const html = renderBoardHtml(realRun());
  expectFail(tamper(html, (d) => { d.rules[2].status = 'failed'; }), 'provenance: HTML badge shows "verified"');
});
test('provenance: a tampered cached __provenance fails', () => {
  expectFail(tamper(baseHtml, (d) => { d.__provenance.verifiedCount = 99; }), 'provenance: cached __provenance');
});

// ---------------------------------------------------------------------------------------------
// CLI: --in sync, renderer warnings, synth argument checks
// ---------------------------------------------------------------------------------------------
test('cli: --in passes when the HTML embeds exactly that board (with a --title override)', () => {
  const inPath = join(ROOT, 'examples', '01_room_booking.board.json');
  const out = join(TMP, 'r1.html');
  const r = node('render_board.mjs', ['--in', inPath, '--out', out, '--title', 'Override title']);
  assert.equal(r.status, 0, r.stderr);
  const v = node('validate_board.mjs', [out, '--in', inPath]);
  assert.equal(v.status, 0, v.stdout + v.stderr);
});
test('cli: --in fails with sync: when any field differs from the input JSON', () => {
  const inPath = join(ROOT, 'examples', '01_room_booking.board.json');
  const out = join(TMP, 'r2.html');
  assert.equal(node('render_board.mjs', ['--in', inPath, '--out', out]).status, 0);
  const edited = clone(EX1);
  edited.rules[2].evidence.scope = 'a different scope';
  const v = node('validate_board.mjs', [out, '--in', tmpFile('edited.json', JSON.stringify(edited))]);
  assert.equal(v.status, 1);
  assert.match(v.stdout, /sync: .*first difference at \$\.rules\[2\]\.evidence\.scope/);
});
test('cli: the renderer prints validator warnings to stderr', () => {
  const b = clone(EX1);
  b.rules[0].short = 'A short label that is far too long';
  const r = node('render_board.mjs', ['--in', tmpFile('warn.json', JSON.stringify(b)), '--out', join(TMP, 'w.html')]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^warning: \$\.rules\[0\]\.short/m);
});
// ---------------------------------------------------------------------------------------------
// Real-file evidence binding
// ---------------------------------------------------------------------------------------------
const refundDir = join(ROOT, 'examples', '04_refund_guard');
const refundBoard = join(refundDir, 'refund_guard.board.json');
const refundSpec = join(refundDir, 'refund_guard.qnt');
const refundLog = join(refundDir, 'refund_guard.quint.log');
const refund = load('04_refund_guard/refund_guard.board.json');
const refundEvidence = { specPaths: [refundSpec], logPaths: [refundLog] };
const bindingIn = (html) => {
  const [p] = findPayloads(html);
  return decodePayload(p.type, p.text).__binding;
};
const oneRule = (property) => {
  const board = realRun(EX0);
  delete board.run.specHash;
  board.rules[0].property = property;
  return board;
};
const markedFailed = (board, rules = board.rules) => {
  board.run.status = 'failed';
  for (const rule of rules) rule.status = 'failed';
  return board;
};

test('binding: Quint example renders and rechecks the actual files with a deterministic green badge', () => {
  const flags = ['--spec', refundSpec, '--log', refundLog];
  const out = join(TMP, 'refund.html');
  const render = node('render_board.mjs', ['--in', refundBoard, ...flags, '--out', out]);
  assert.equal(render.status, 0, render.stderr);
  assert.equal(render.stderr, '');
  const html = readFileSync(out, 'utf8');
  assert.equal(html, renderBoardHtml(refund, refundEvidence));
  assert.match(html, /pc-prov-good[^>]*><span[^>]*><\/span>Spec &amp; log verified \(2\/2\)/);
  const binding = bindingIn(html);
  assert.equal(binding.specHash, refund.run.specHash);
  assert.match(binding.logHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(footerNote(html), /Quint 0\.32\.0 log sha256:/);
  const lines = readFileSync(refundSpec, 'utf8').split('\n');
  for (const rule of refund.rules) {
    const ref = binding.refs[rule.id];
    assert.equal(ref.file, 'refund_guard.qnt');
    assert.equal(ref.snippet, lines.slice(ref.line - 1, ref.endLine).join('\n'));
    assert.match(ref.snippet, new RegExp('^  val ' + rule.property + ' ='));
    const details = ruleEvidenceDetails(rule, refund, binding, EN);
    assert.equal(details.tool, 'Quint 0.32.0');
    assert.equal(details.source, 'refund_guard.qnt:' + ref.line);
  }
  assert.equal(html.includes(refundDir), false);
  assert.equal(CJK.test(html), false);
  const validate = node('validate_board.mjs', ['--in', refundBoard, ...flags, out]);
  assert.equal(validate.status, 0, validate.stdout + validate.stderr);
});

test('binding: spec-only and log-only show exactly which files were checked', () => {
  const specOnly = renderBoardHtml(refund, { specPaths: [refundSpec] });
  expectPass(specOnly);
  assert.match(specOnly, /pc-prov-warn[^>]*><span[^>]*><\/span>Spec checked · self-reported log \(2\/2\)/);
  assert.match(footerNote(specOnly), /No checker log was verified\./);
  const logOnly = renderBoardHtml(refund, { logPaths: [refundLog] });
  expectPass(logOnly);
  assert.match(logOnly, /pc-prov-warn[^>]*><span[^>]*><\/span>Log checked · self-reported spec \(2\/2\)/);
  assert.match(footerNote(logOnly), /No spec file was checked\./);
  const sample = renderBoardHtml({ ...refund, provenance: 'sample' }, refundEvidence);
  assert.match(sample, /data-provenance="sample"[^>]*><span[^>]*><\/span>Sample data/);
});

test('binding: derive a missing hash without altering the board or masking a supplied mismatch', () => {
  const board = clone(refund);
  delete board.run.specHash;
  const input = tmpFile('derived.json', JSON.stringify(board));
  const html = renderBoardHtml(board, refundEvidence);
  expectPass(html);
  assert.equal(bindingIn(html).specHash, refund.run.specHash);
  assert.match(footerMarkup(resolveProvenance(board, bindingIn(html)), board, bindingIn(html), EN),
    new RegExp('<code>spec: ' + refund.run.specHash.slice(0, 19) + '</code>'));
  const output = tmpFile('derived.html', html);
  for (const flags of [[], ['--spec', refundSpec, '--log', refundLog]]) {
    const check = node('validate_board.mjs', ['--in', input, ...flags, output]);
    assert.equal(check.status, 0, check.stdout + check.stderr);
    assert.equal(check.stdout.includes('binding: embedded evidence was not re-checked against --spec/--log files'), flags.length === 0);
  }
  const standalone = node('validate_board.mjs', ['--in', input, '--spec', refundSpec, '--log', refundLog]);
  assert.equal(standalone.status, 0, standalone.stdout + standalone.stderr);
  board.run.specHash = refund.run.specHash.split(':')[1].toUpperCase();
  assert.equal(bindingIn(renderBoardHtml(board, refundEvidence)).specHash, refund.run.specHash);
  for (const hash of ['bogus', refund.run.specHash.slice(0, -1), 'sha256:' + 'a'.repeat(64)]) {
    board.run.specHash = hash;
    assert.throws(() => renderBoardHtml(board, refundEvidence), /binding: spec hash mismatch/);
  }
});

test('binding: repeatable CLI flags hash and render files in basename order', () => {
  const cap = tmpFile('A.qnt', 'pure val refundsWithinPaid = true\n');
  const balance = tmpFile('B.qnt', 'val balanceNonNegative = true\n');
  const capLog = tmpFile('A.log', '$ quint verify A.qnt --invariant=refundsWithinPaid\n[ok] No violation found.\n');
  const balanceLog = tmpFile('B.log', '$ quint verify B.qnt --invariant balanceNonNegative\n[ok] No violation found.\n');
  const forward = ['--spec', cap, '--spec', balance, '--log', capLog, '--log', balanceLog];
  const reverse = ['--log', balanceLog, '--log', capLog, '--spec', balance, '--spec', cap];
  const board = clone(refund);
  delete board.run.specHash;
  const input = tmpFile('multi-binding.json', JSON.stringify(board));
  const outputs = [join(TMP, 'ordered.html'), join(TMP, 'reversed.html')];
  for (const [i, flags] of [forward, reverse].entries()) {
    const result = node('render_board.mjs', ['--in', input, ...flags, '--out', outputs[i]]);
    assert.equal(result.status, 0, result.stderr);
  }
  const html = readFileSync(outputs[0], 'utf8');
  assert.equal(html, readFileSync(outputs[1], 'utf8'));
  assert.equal(html.includes(TMP), false);
  const binding = bindingIn(html);
  const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
  const manifest = createHash('sha256').update('A.qnt\n' + digest(cap) + '\nB.qnt\n' + digest(balance)).digest('hex');
  assert.equal(binding.specHash, 'sha256:' + manifest);
  assert.deepEqual(binding.specFiles.map((f) => f.file), ['A.qnt', 'B.qnt']);
  assert.deepEqual(binding.logFiles.map((f) => f.file), ['A.log', 'B.log']);
  const validate = node('validate_board.mjs', ['--in', input, ...reverse, outputs[0]]);
  assert.equal(validate.status, 0, validate.stdout + validate.stderr);
});

test('binding: only declarations outside comments count in each supported language', () => {
  const cases = [
    ['qnt', '// val Missing = true\n/*\n  val Missing = true\n*/\n  pure def Real = all {\n    true,\n  }\n'],
    ['tla', '\\* Missing == TRUE\n(* outer (* inner *)\nMissing == TRUE\n*)\n  Real(v) ==\n    LET Missing == TRUE\n    IN v = v\n====\n'],
    ['als', '-- assert Missing {}\n// pred Missing {}\n/*\nfun Missing {}\n*/\npred Real {\n  some univ\n}\n'],
    ['lean', '-- theorem Missing : True := trivial\n/- outer /- inner -/\nlemma Missing : True := trivial\n-/\nprivate theorem Real : True := by\n  trivial\n'],
    ['dfy', '// function Missing(): bool { true }\n/* outer /* inner */\nmethod Missing() {}\n*/\nghost predicate Real() {\n  true\n}\n'],
  ];
  for (const [extension, source] of cases) {
    const spec = tmpFile('Comments.' + extension, source);
    assert.throws(() => renderBoardHtml(oneRule('Missing'), { specPaths: [spec] }),
      /binding: rule "stock_never_negative" property "Missing" not found in supplied --spec file\(s\)/);
    const html = renderBoardHtml(oneRule('Real'), { specPaths: [spec] });
    expectPass(html);
    const ref = bindingIn(html).refs.stock_never_negative;
    assert.equal(ref.snippet, source.split('\n').slice(ref.line - 1, ref.endLine).join('\n'));
    assert.match(ref.snippet, /^ *[^\n]*\bReal\b/);
    assert.equal(ref.snippet.includes('\n===='), false);
  }
});

test('binding: paths reported by checker logs do not appear in HTML and source excerpts cannot reveal them', () => {
  const spec = tmpFile('Path.qnt', 'val Real = "/api/v1/refunds"\n');
  const log = tmpFile('path.log', '$ quint verify "' + spec + '" --invariant=Real\n[ok] No violation found.\nWorking file: ' + spec + '\n');
  const board = oneRule('Real');
  const html = renderBoardHtml(board, { specPaths: [spec], logPaths: [log] });
  expectPass(html);
  assert.equal(html.includes(TMP), false);
  for (const path of ['\x60/Users/example/model.qnt\x60', '[/etc/passwd]', '</opt/x/y>', '"~/model.qnt"', 'C:\\specs\\Model.qnt', '\\\\server\\share', 'file:///Model.qnt']) {
    writeFileSync(spec, 'val Real = true // ' + path + '\n');
    assert.throws(() => renderBoardHtml(board, { specPaths: [spec] }), /binding: rule .* spec excerpt contains an absolute file path/);
  }
});

test('binding: excerpts preserve CRLF and truncate complete source at 10 lines or 600 characters', () => {
  const long = tmpFile('long.qnt', 'val Real = all {\r\n' + '  true,\r\n'.repeat(11) + '}\r\n');
  const wide = tmpFile('wide.qnt', 'val Real = "' + 'x'.repeat(620) + '"\n');
  const board = oneRule('Real');
  const html = renderBoardHtml(board, { specPaths: [long] });
  expectPass(html);
  const ref = bindingIn(html).refs.stock_never_negative;
  assert.equal(ref.line, 1);
  assert.equal(ref.endLine, 10);
  assert.equal(ref.snippet, 'val Real = all {\r\n' + '  true,\r\n'.repeat(8) + '  true,…');
  const wideHtml = renderBoardHtml(board, { specPaths: [wide] });
  expectPass(wideHtml);
  const wideRef = bindingIn(wideHtml).refs.stock_never_negative;
  assert.equal(wideRef.endLine, 1);
  assert.equal(wideRef.snippet.length, 600);
  assert.ok(wideRef.snippet.endsWith('…'));
});

test('binding: a TLC pass requires configured scope and a named violation contradicts that property', () => {
  const spec = tmpFile('Spend.tla', '---- MODULE Spend ----\nNoDoubleSpend == TRUE\n====\n');
  const config = tmpFile('Spend.cfg', 'INVARIANT NoDoubleSpend\n');
  const pass = tmpFile('tlc-pass.log', 'Model checking completed. No error has been found.\n1,027 states generated, 30 distinct states found.\n');
  const fail = tmpFile('tlc-fail.log', 'Error: Invariant NoDoubleSpend is violated.\nError: The behavior up to this point is:\n');
  const board = oneRule('NoDoubleSpend');
  assert.throws(() => renderBoardHtml(board, { specPaths: [spec], logPaths: [pass] }), /binding: a TLC pass requires/);
  const html = renderBoardHtml(board, { specPaths: [spec, config], logPaths: [pass] });
  expectPass(html);
  assert.equal(bindingIn(html).logFiles[0].checker, 'TLC');
  assert.equal(bindingIn(html).logFiles[0].statesGenerated, 1027);
  assert.throws(() => renderBoardHtml(board, { specPaths: [spec], logPaths: [fail] }), /binding: checker log contradicts verified rule .*NoDoubleSpend/);
  markedFailed(board);
  assert.throws(() => renderBoardHtml(board, { specPaths: [spec, config], logPaths: [pass] }), /binding: checker log contradicts failed rule/);
  const failure = renderBoardHtml(board, { specPaths: [spec], logPaths: [fail] });
  assert.equal(expectPass(failure).provenance, 'failed');
  assert.match(footerNote(failure), /TLA\+ TLC 2\.19 log sha256:/);
});

test('binding: unnamed Quint pass cannot assign multiple results, and violations or errors cannot produce a green badge', () => {
  const pass = tmpFile('quint-unnamed.log', '[ok] No violation found (123ms).\n');
  const violation = tmpFile('quint-violation.log', '[violation] Found an issue.\n');
  const quoted = tmpFile('quint-named-violation.log', "[violation] Found an issue.\nInvariant 'refundsWithinPaid' was violated.\n");
  const trace = tmpFile('quint-trace.log', '[violation] Found an issue.\n  \u274c refundsWithinPaid\n');
  const error = tmpFile('quint-error.log', '$ quint verify refund_guard.qnt --invariant=refundsWithinPaid\n[error] Type error.\n');
  const errorThenPass = tmpFile('quint-error-before-command.log', 'Error: syntax error\n' + readFileSync(refundLog, 'utf8'));
  assert.throws(() => renderBoardHtml(refund, { logPaths: [errorThenPass] }), /binding: .*requires run.status/);
  assert.throws(() => renderBoardHtml(oneRule('refundsWithinPaid'), { logPaths: [pass] }), /binding: unrecognized checker log format/);
  assert.throws(() => renderBoardHtml(refund, { logPaths: [pass] }), /binding: unrecognized checker log format/);
  for (const log of [violation, quoted, trace, error]) {
    assert.throws(() => renderBoardHtml(refund, { logPaths: [refundLog, log] }), /binding: .*requires run.status|binding: checker log contradicts verified rule/);
  }
  const wrongRule = clone(refund);
  delete wrongRule.provenance;
  markedFailed(wrongRule, wrongRule.rules.slice(1));
  assert.throws(() => renderBoardHtml(wrongRule, { logPaths: [trace, refundLog] }), /contradicts verified rule .*refundsWithinPaid/);
  const mixed = clone(refund);
  delete mixed.provenance;
  markedFailed(mixed, mixed.rules.slice(0, 1));
  const otherPass = tmpFile('quint-other-pass.log', '$ quint verify refund_guard.qnt --invariants balanceNonNegative --verbosity=1\n[ok] No violation found.\n');
  for (const failure of [violation, quoted, trace, error]) {
    const html = renderBoardHtml(mixed, { specPaths: [refundSpec], logPaths: [failure, otherPass] });
    assert.equal(expectPass(html).provenance, 'failed');
  }
});

test('binding: Apalache accepts ordinary progress and rejects a counterexample or explicit error', () => {
  const board = oneRule('NoDoubleSpend');
  const pass = tmpFile('apalache-pass.log', ' > Set an invariant to NoDoubleSpend I@12:00:00\nState 0: Generating 1 symbolic transitions\nState 0: Picking a transition...\nThe outcome is: NoError\n');
  expectPass(renderBoardHtml(board, { logPaths: [pass] }));
  for (const message of ['The outcome is: Error', 'The outcome is: Deadlock', 'The outcome is: RuntimeError', 'Checker has found an error', 'Checker has found a deadlock', 'State 0:\n  x = 0', 'State 0: <Initial predicate>\n  x = 0']) {
    const fail = tmpFile('apalache-fail.log', message + '\n');
    assert.throws(() => renderBoardHtml(board, { logPaths: [fail] }), /binding: checker log contradicts verified rule/);
  }
});

test('binding: unrecognized logs are rejected individually', () => {
  for (const text of ['', 'Just some text', '[ok] pending']) {
    const log = tmpFile('unknown.log', text);
    assert.throws(() => renderBoardHtml(refund, { specPaths: [refundSpec], logPaths: [log] }), /binding: unrecognized checker log format/);
  }
  const log = tmpFile('unrecognized-extra.log', 'Additional context');
  assert.throws(() => renderBoardHtml(refund, { specPaths: [refundSpec], logPaths: [refundLog, log] }), /binding: unrecognized checker log format in "unrecognized-extra.log"/);
  const html = renderBoardHtml(refund, refundEvidence);
  expectFail(tamper(html, (d) => { d.__binding.logFiles[0].results = []; }), 'provenance: binding: invalid embedded evidence metadata');
});

test('binding: structured receipts require exact properties, verdicts, and reported step counts', () => {
  const board = oneRule('Real');
  board.rules[0].stepsChecked = 5;
  const result = { property: 'Real', status: 'verified', stepsChecked: 5 };
  const write = (value) => tmpFile('receipt.json', JSON.stringify(value));
  const receipt = { schemaVersion: 'proof-canvas-log-1', checker: 'Dafny', results: [result] };
  expectPass(renderBoardHtml(board, { logPaths: [write(receipt)] }));
  expectPass(renderBoardHtml(board, { logPaths: [write({ checker: 'Dafny', results: [result] })] }));
  for (const results of [[], [result, result], [{ ...result, status: 'passed' }], [{ ...result, unexpected: true }]]) {
    assert.throws(() => renderBoardHtml(board, { logPaths: [write({ ...receipt, results })] }), /binding: invalid structured checker log/);
  }
  assert.throws(() => renderBoardHtml(board, { logPaths: [write({ ...receipt, schemaVersion: 'wrong' })] }), /binding: invalid structured checker log/);
  for (const [change, error] of [
    [{ property: 'Unrelated' }, /no passing checker verdict/],
    [{ status: 'failed' }, /contradicts verified rule/],
    [{ stepsChecked: 6 }, /stepsChecked mismatch/],
  ]) {
    assert.throws(() => renderBoardHtml(board, { logPaths: [write({ ...receipt, results: [{ ...result, ...change }] })] }), error);
  }
  markedFailed(board);
  const failing = write({ ...receipt, results: [{ ...result, status: 'failed' }] });
  assert.equal(expectPass(renderBoardHtml(board, { logPaths: [failing] })).provenance, 'failed');
});

test('binding: Alloy reads assertion names and final solver verdicts after terminal overwrites', () => {
  const spec = tmpFile('Approval.als', 'assert Safe {\n  no none\n}\ncheck Safe for 5\npred Node.reachable[n: Node] {}\n');
  const board = oneRule('Safe');
  const check = (line) => ({ specPaths: [spec], logPaths: [tmpFile('alloy.log', line + '\n')] });
  for (const row of ['00. check Safe    0    UNSAT', '01. alias: check Safe  0  UNSAT', '02. check alias: Safe  0  UNSAT',
    'Working...\r00. check Safe    0    \x1b[32mUNSAT\x1b[0m']) {
    const html = renderBoardHtml(board, check(row));
    assert.equal(expectPass(html).provenance, 'verified');
    assert.equal(bindingIn(html).refs.stock_never_negative.snippet, 'assert Safe {\n  no none\n}');
  }
  const failed = check('00. check Safe    0\b\b\b\b\b    1/1     SAT');
  assert.throws(() => renderBoardHtml(board, failed), /binding: checker log contradicts verified rule/);
  assert.equal(expectPass(renderBoardHtml(markedFailed(clone(board)), failed)).provenance, 'failed');
  for (const row of ['00. run Safe    1/1    SAT', '00. check Safe    0']) {
    assert.throws(() => renderBoardHtml(board, check(row)), /binding: unrecognized checker log format/);
  }
  expectPass(renderBoardHtml(oneRule('reachable'), { specPaths: [spec] }));
  assert.throws(() => renderBoardHtml(oneRule('Node'), { specPaths: [spec] }), /binding: rule .* not found/);
});

test('binding: TLC certifies only configured identifiers and includes the config in the manifest', () => {
  const [first, second] = refund.rules.map((rule) => rule.property);
  const original = 'INVARIANT ' + first + '\nPROPERTIES\n  ' + second + '\n';
  const spec = tmpFile('Scoped.tla', '---- MODULE Scoped ----\n' + first + ' == TRUE\n' + second + ' == TRUE\n====\n');
  const config = tmpFile('Scoped.cfg', original);
  const other = tmpFile('Other.cfg', 'INVARIANTS\n  ' + first + '\n');
  const pass = 'Model checking completed. No error has been found.\n';
  const log = tmpFile('scoped-tlc.log', pass);
  const opts = { specPaths: [spec, config], logPaths: [log] };
  const board = clone(refund);
  delete board.run.specHash;
  assert.throws(() => renderBoardHtml(board, { ...opts, specPaths: [spec] }), /binding: a TLC pass requires/);
  const html = renderBoardHtml(board, opts);
  assert.equal(expectPass(html).provenance, 'verified');

  writeFileSync(config, 'INVARIANTS\n  ' + first + ' \\* ' + second + '\n(* outer (* inner *) PROPERTY ' + second + ' *)\nINIT Init\n');
  assert.throws(() => renderBoardHtml(board, opts), /no passing checker verdict .*balanceNonNegative/);
  assert.throws(() => renderBoardHtml(oneRule(second), opts), /no passing checker verdict .*balanceNonNegative/);
  assert.notEqual(bindingIn(renderBoardHtml(oneRule(first), opts)).specHash, bindingIn(html).specHash);
  writeFileSync(config, original);

  const multi = { ...opts, specPaths: [spec, config, other] };
  assert.throws(() => renderBoardHtml(board, multi), /binding: a TLC pass requires/);
  writeFileSync(log, '$ java -cp tla2tools.jar tlc2.TLC -config Scoped.cfg Scoped.tla\n' + pass);
  assert.equal(expectPass(renderBoardHtml(board, multi)).provenance, 'verified');
});

test('binding: Apalache pass scope comes from checked invariants or the command', () => {
  const spec = tmpFile('Apalache.tla', '---- MODULE Apalache ----\nInv == TRUE\nBad == FALSE\n====\n');
  const pass = 'The outcome is: NoError\n';
  const cfg = (prefix) => ({ specPaths: [spec], logPaths: [tmpFile('apalache-scope.log', prefix + pass)] });
  for (const prefix of [' > Set an invariant to Inv\n', '$ apalache-mc check --inv=Inv Apalache.tla\n']) {
    assert.equal(expectPass(renderBoardHtml(oneRule('Inv'), cfg(prefix))).provenance, 'verified');
    assert.throws(() => renderBoardHtml(oneRule('Bad'), cfg(prefix)), /binding: no passing checker verdict/);
  }
  assert.throws(() => renderBoardHtml(oneRule('Inv'), cfg('')), /binding: unrecognized checker log format/);
});

test('binding: Quint accepts supported command forms and requires explicit formal scope', () => {
  const [first, second] = refund.rules.map((r) => r.property);
  const transcript = (command, output = '[ok] No violation found.\n') => tmpFile('quint-scoped.log', command + '\n' + output);
  for (const command of [
    '% npx quint verify refund_guard.qnt --invariants=' + first + ' --invariants ' + second,
    'mise exec quint@0.32.0 -- quint verify refund_guard.qnt --invariants ' + first + ' ' + second + ' --verbosity=1',
    'PS C:\\> quint.cmd verify "C:\\example files\\refund_guard.qnt" --inductive-invariant=' + first + ' --temporal ' + second,
  ]) {
    const html = renderBoardHtml(refund, { specPaths: [refundSpec], logPaths: [transcript(command)] });
    assert.equal(expectPass(html).provenance, 'verified');
    assert.equal(html.includes('example files'), false);
  }
  const board = oneRule(first);
  const opts = (command, output) => ({ specPaths: [refundSpec], logPaths: [transcript(command, output)] });
  for (const command of [
    'quint verify refund_guard.qnt --max-steps=2',
    'quint run refund_guard.qnt --invariant=' + first,
    'quint verify refund_guard.qnt --invariant="' + first + ' or ' + second + '"',
  ]) {
    assert.throws(() => renderBoardHtml(board, opts(command)), /binding: unrecognized checker log format/);
  }
  assert.throws(() => renderBoardHtml(board, opts('quint verify foreign.qnt --invariant=' + first)), /references spec "foreign\.qnt"/);
  for (const [mode, trailer] of [['verify', 'found a counterexample'], ['run', 'Invariant violated']]) {
    const failure = opts('quint ' + mode + ' refund_guard.qnt --invariant=' + first,
      '[violation] Found an issue.\nerror: ' + trailer + '\n');
    const failed = markedFailed(clone(board));
    assert.equal(expectPass(renderBoardHtml(failed, failure)).provenance, 'failed');
    assert.throws(() => renderBoardHtml(markedFailed(oneRule(second)), failure), /no failing checker verdict/);
  }
});

test('binding: a pending rule cannot hide a named failure', () => {
  const board = markedFailed(clone(refund), []);
  delete board.provenance;
  board.rules[0].status = 'pending';
  board.rules[1].status = 'failed';
  const log = tmpFile('pending-violation.log', '$ quint verify refund_guard.qnt --invariants refundsWithinPaid balanceNonNegative\n[violation] Found an issue.\nInvariant refundsWithinPaid was violated.\nInvariant balanceNonNegative was violated.\n');
  assert.throws(() => renderBoardHtml(board, { specPaths: [refundSpec], logPaths: [log] }), /checker log contradicts pending rule .*refundsWithinPaid/);
});

test('binding: native and structured verdicts must match the property source family and any declared hash', () => {
  const board = oneRule('Real');
  const qnt = tmpFile('Receipt.qnt', 'val Real = true\n');
  const tla = tmpFile('Receipt.tla', 'Other == TRUE\n');
  const alloy = tmpFile('Receipt.als', 'assert Real {}\ncheck Real for 5\n');
  const cfg = tmpFile('Receipt.cfg', 'INVARIANT Real\n');
  const other = tmpFile('OtherReceipt.qnt', 'val Spare = false\n');
  const assertMismatch = (specPaths, log) => assert.throws(() => renderBoardHtml(board, { specPaths, logPaths: [log] }), /checker or spec in log does not match rule/);
  assertMismatch([qnt], tmpFile('wrong-alloy.log', '00. check Real    0    UNSAT\n'));
  assertMismatch([qnt], tmpFile('wrong-apalache.log', ' > Set an invariant to Real\nThe outcome is: NoError\n'));
  assertMismatch([qnt, tla, cfg], tmpFile('wrong-tlc.log', 'Parsing file Receipt.tla\nModel checking completed. No error has been found.\n'));
  assertMismatch([alloy], tmpFile('wrong-quint.log', '$ quint verify --invariant=Real\n[ok] No violation found.\n'));
  const receipt = (checker, specHash) => tmpFile('hash-receipt.json', JSON.stringify({
    schemaVersion: 'proof-canvas-log-1', checker, specHash, results: [{ property: 'Real', status: 'verified' }],
  }));
  assertMismatch([qnt], receipt('Alloy 6.2.0'));
  const specPaths = [qnt, other];
  const manifest = bindingIn(renderBoardHtml(board, { specPaths })).specHash;
  const digest = (path) => 'sha256:' + createHash('sha256').update(readFileSync(path)).digest('hex');
  for (const hash of [manifest, digest(qnt)]) {
    assert.equal(expectPass(renderBoardHtml(board, { specPaths, logPaths: [receipt('Quint 0.32.0', hash)] })).provenance, 'verified');
  }
  assertMismatch(specPaths, receipt('Quint', digest(other)));
  assert.throws(() => renderBoardHtml(board, { specPaths, logPaths: [receipt('Quint', 'sha256:' + '1'.repeat(64))] }), /spec hash mismatch in checker receipt/);
  assert.throws(() => renderBoardHtml(board, { logPaths: [receipt('Quint', digest(qnt))] }), /spec hash mismatch in checker receipt/);
});

test('binding: UTF-16 log BOMs are decoded and the raw bytes are hashed', () => {
  const text = readFileSync(refundLog, 'utf8');
  for (const swap of [false, true]) {
    const bytes = Buffer.from('\uFEFF' + text, 'utf16le');
    if (swap) bytes.swap16();
    const log = tmpFile('powershell.log', bytes);
    const html = renderBoardHtml(refund, { specPaths: [refundSpec], logPaths: [log] });
    assert.equal(expectPass(html).provenance, 'verified');
    assert.equal(bindingIn(html).logHash, 'sha256:' + createHash('sha256').update(bytes).digest('hex'));
  }
});

test('binding: source ranges keep full bodies and exclude local or out-of-module definitions', () => {
  const cases = [
    ['Scope.tla', 'Early == TRUE\n---- MODULE Scope ----\nReal[n \\in Nat] ==\n  /\\ n \\in {1, 2}\n  /\\ n > 0\n====\nLate == TRUE\n', 'Real[n \\in Nat] ==\n  /\\ n \\in {1, 2}\n  /\\ n > 0', ['Early', 'Late']],
    ['Scopes.qnt', 'module Scopes {\n  def Real = {\n    val Local = {1, 2}\n    Local.size() > 0\n  }\n  val Other = true\n}\n', '  def Real = {\n    val Local = {1, 2}\n    Local.size() > 0\n  }', ['Local']],
    ['Attributes.lean', '@[simp] theorem Real {a : Type} (v : a) :\n  v = v := by\n  rfl\n', '@[simp] theorem Real {a : Type} (v : a) :\n  v = v := by\n  rfl', []],
    ['Attributes.dfy', 'lemma {:induction false} Real(s: set<int>)\n  requires s != {}\n{\n  assert |s| > 0;\n}\n', 'lemma {:induction false} Real(s: set<int>)\n  requires s != {}\n{\n  assert |s| > 0;\n}', []],
    ['Inline.qnt', 'val Real = Set({1, 2})\n  .size() > 0\n', 'val Real = Set({1, 2})\n  .size() > 0', []],
  ];
  for (const [file, text, snippet, excluded] of cases) {
    const options = { specPaths: [tmpFile(file, text)] };
    const board = oneRule('Real');
    const html = renderBoardHtml(board, options);
    expectPass(html);
    const details = ruleEvidenceDetails(board.rules[0], board, bindingIn(html), EN);
    assert.equal(details.ref.snippet, snippet);
    assert.equal(details.source, file + ':' + details.ref.line + '-' + details.ref.endLine);
    for (const property of excluded) {
      assert.throws(() => renderBoardHtml(oneRule(property), options), /binding: rule .* not found/);
    }
  }
  const commented = tmpFile('SameLine.qnt', '/* comment\n  closes */ val Real = true\n');
  const html = renderBoardHtml(oneRule('Real'), { specPaths: [commented] });
  expectPass(html);
  for (const marker of ['// */', '// Some text */']) {
    expectFail(tamper(html, (d) => { d.__binding.refs.stock_never_negative.snippet = marker + ' val Real = true'; }),
      'provenance: binding: invalid embedded spec reference');
  }
});

test('binding: native combined example renders and validates deterministically with per-rule evidence', () => {
  const example = (...paths) => join(ROOT, 'examples', '05_multi_verifier', ...paths);
  const specPaths = ['escrow_ledger.qnt', 'delegation_rbac.als', 'period_lock.tla', 'period_lock.cfg'].map((f) => example(f));
  const logPaths = ['quint_escrow.log', 'alloy_rbac.log', 'tlc_pass.log'].map((f) => example(f));
  const input = example('multi_verifier.board.json');
  const board = JSON.parse(readFileSync(input, 'utf8'));
  const flags = [...specPaths.flatMap((p) => ['--spec', p]), ...logPaths.flatMap((p) => ['--log', p])];
  const output = join(TMP, 'multi-verifier.html');
  const rendered = node('render_board.mjs', ['--in', input, ...flags, '--out', output]);
  assert.equal(rendered.status, 0, rendered.stderr);
  const html = readFileSync(output, 'utf8');
  assert.equal(html, renderBoardHtml(board, { specPaths: [...specPaths].reverse(), logPaths: [...logPaths].reverse() }));
  assert.match(html, /pc-prov-good[^>]*><span[^>]*><\/span>Spec &amp; log verified \(6\/6\)/);
  assert.equal(CJK.test(html), false);
  assert.equal(html.includes(ROOT), false);
  const validated = node('validate_board.mjs', ['--in', input, ...flags, output]);
  assert.equal(validated.status, 0, validated.stdout + validated.stderr);
  assert.match(validated.stdout, /\[PASS\] HTML/);
  const binding = bindingIn(html);
  assert.equal(binding.specHash, board.run.specHash);
  assert.match(footerNote(html), /Alloy, Quint, TLC log sha256:/);
  for (const [i, rule] of board.rules.entries()) {
    const family = Math.floor(i / 2);
    const details = ruleEvidenceDetails(rule, board, binding, EN);
    assert.equal(details.tool, ['Quint', 'Alloy', 'TLC'][family]);
    assert.equal(details.logFiles.length, 1);
    const expectedHash = createHash('sha256').update(readFileSync(logPaths[family])).digest('hex');
    assert.equal(details.logFiles[0].hash, 'sha256:' + expectedHash);
    const lines = readFileSync(specPaths[family], 'utf8').split('\n');
    assert.equal(details.ref.snippet, lines.slice(details.ref.line - 1, details.ref.endLine).join('\n'));
    assert.match(details.ref.snippet, new RegExp('\\b' + rule.property + '\\b'));
  }
  const embedded = renderBoardHtml(board, { specPaths, logPaths, mode: 'embed' });
  assert.equal(expectPass(embedded).mode, 'embed');
});

test('binding: structural validation detects forged levels, references, hashes and provenance copy', () => {
  const html = renderBoardHtml(refund, refundEvidence);
  expectFail(tamper(html, (d) => { d.__binding.specFiles = []; }), 'provenance:');
  expectFail(tamper(html, (d) => { d.__binding.logHash = 'sha256:' + '0'.repeat(64); }), 'provenance:');
  expectFail(tamper(html, (d) => { delete d.__binding.refs.refund_cap; }), 'provenance:');
  expectFail(tamper(html, (d) => { d.__binding.refs.refund_cap.snippet = '// val refundsWithinPaid = true'; }), 'provenance:');
  expectFail(renderBoardHtml(refund).replace('Self-reported (2/2)', 'Spec &amp; log verified (2/2)'), 'provenance: HTML badge text or tone');
  expectFail(html.replace('matched the reported verdicts.', 'proved the invariants.'), 'provenance: footer note');
  const input = clone(refund);
  input.__binding = bindingIn(html);
  schemaErr(input, '$.__binding');
});

test('binding: supplied files catch valid-looking changed snippets and changed raw log bytes', () => {
  const html = renderBoardHtml(refund, refundEvidence);
  const changed = tamper(html, (d) => { d.__binding.refs.refund_cap.snippet = '  val refundsWithinPaid = true'; });
  expectPass(changed);
  const { errors } = validateHtmlContent(changed, '<html>', refundEvidence);
  assert.ok(errors.some((error) => error.startsWith('binding: embedded evidence does not match supplied files')));
  const edited = join(TMP, 'refund_guard.quint.log');
  writeFileSync(edited, readFileSync(refundLog, 'utf8') + '\n');
  const wrongLog = node('validate_board.mjs', ['--spec', refundSpec, '--log', edited, tmpFile('original.html', html)]);
  assert.equal(wrongLog.status, 1);
  assert.match(wrongLog.stdout, /binding: embedded evidence does not match supplied files/);
});

test('synth: rejects negative, fractional, NaN and inconsistent counts', () => {
  assert.throws(() => synthBoard({ rules: -1, modules: 1 }), /--rules/);
  assert.throws(() => synthBoard({ rules: NaN, modules: 1 }), /--rules/);
  assert.throws(() => synthBoard({ rules: 10, modules: 2, failed: -1 }), /--failed/);
  assert.throws(() => synthBoard({ rules: 10, modules: 2, unverified: 1.5 }), /--unverified/);
  assert.throws(() => synthBoard({ rules: 3, modules: 4 }), /--modules may not exceed/);
  assert.throws(() => synthBoard({ rules: 10, modules: 2, failed: 6, unverified: 5 }), /exceeds --rules/);
  for (const v of ['abc', '1e2', '3.5', '']) {
    const r = node('synth_board.mjs', ['--rules', v, '--modules', '1', '--out', join(TMP, 's.json')]);
    assert.equal(r.status, 1, `accepted --rules "${v}"`);
  }
});
test('synth: requested status counts are exact and the board validates without warnings', () => {
  const b = synthBoard({ rules: 50, modules: 10, failed: 3, unverified: 7, seed: 3 });
  const c = { verified: 0, failed: 0, pending: 0 };
  for (const r of b.rules) c[r.status] += 1;
  assert.deepEqual(c, { verified: 40, failed: 3, pending: 7 });
  const v = validateBoardData(b);
  assert.equal(v.ok, true, v.errors.join('\n'));
  assert.deepEqual(v.warnings, []);
});

// ---------------------------------------------------------------------------------------------
// Figure kinds: gate, sequence, relation
// ---------------------------------------------------------------------------------------------
const EX5 = load('05_multi_verifier/multi_verifier.board.json');
const EX6 = load('06_japanese_board/multi_verifier_ja.board.json');
const SEQ_RULE = 4;
const REL_RULE = 2;
const STATES = ['normal', 'bug', 'fixed'];
const ex5Flags = () => {
  const example = (f) => join(ROOT, 'examples', '05_multi_verifier', f);
  return [
    ...['escrow_ledger.qnt', 'delegation_rbac.als', 'period_lock.tla', 'period_lock.cfg'].flatMap((f) => ['--spec', example(f)]),
    ...['quint_escrow.log', 'alloy_rbac.log', 'tlc_pass.log'].flatMap((f) => ['--log', example(f)]),
  ];
};
const anchors = (svg) => (svg.match(/data-anchor="1"/g) || []).length;

test('figure: example 05 draws gate, relation and sequence rules; 06 draws all three in Japanese', () => {
  assert.deepEqual(EX5.rules.map((r) => r.figure.kind ?? 'gate'), ['gate', 'gate', 'relation', 'relation', 'sequence', 'gate']);
  assert.deepEqual(EX6.rules.map((r) => r.figure.kind ?? 'gate'), ['gate', 'relation', 'sequence']);
});
test('example 06_japanese_board: binds to the 05 specs and logs, 3/3 green, no warnings, Japanese copy', () => {
  const input = join(ROOT, 'examples', '06_japanese_board', 'multi_verifier_ja.board.json');
  const r = validateBoardData(EX6);
  assert.equal(r.ok, true, r.errors.join('\n'));
  assert.deepEqual(r.warnings, []);
  for (const mode of ['standalone', 'embed']) {
    const output = join(TMP, `ja-${mode}.html`);
    const rendered = node('render_board.mjs', ['--in', input, ...ex5Flags(), '--mode', mode, '--out', output]);
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.equal(rendered.stderr, '');
    const html = readFileSync(output, 'utf8');
    assert.match(html, /pc-prov-good[^>]*><span[^>]*><\/span>実ログ検証済み \(3\/3\)/);
    assert.match(html, /<html lang="ja">/);
    assert.ok(CJK.test(html), 'the Japanese board copy is missing');
    assert.ok(html.includes('締済みの会計期間には計上できない'));
    const validated = node('validate_board.mjs', ['--in', input, ...ex5Flags(), output]);
    assert.equal(validated.status, 0, validated.stdout + validated.stderr);
    assert.equal(/WARN/.test(validated.stdout), false, validated.stdout);
  }
});
test('figure: every state of every kind marks exactly one connector anchor', () => {
  for (const b of [EX5, EX6, EX1]) {
    for (const r of b.rules) for (const k of STATES) assert.equal(anchors(figSvg(r, r.states[k], 'u', true)), 1, `${r.id}/${k}`);
  }
});
test('figure: a missing kind is the gate, drawn exactly like kind "gate"', () => {
  const r = clone(EX1.rules[0]);
  const explicit = clone(r);
  explicit.figure.kind = 'gate';
  for (const k of STATES) assert.equal(figSvg(explicit, explicit.states[k], 'u', true), figSvg(r, r.states[k], 'u', true));
  assert.equal(validateBoardData({ ...clone(EX1), rules: [explicit, ...clone(EX1).rules.slice(1)] }).ok, true);
});
test('figure: the injected runtime draws every kind exactly like the server, and ships only the kinds used', () => {
  const ctx = {};
  runInNewContext(figureRuntime(FIGURE_KINDS) + '\nthis.figSvg = figSvg;', ctx);
  for (const r of [...EX5.rules, ...EX6.rules]) {
    for (const k of STATES) assert.equal(ctx.figSvg(r, r.states[k], 'b-' + r.id, true), figSvg(r, r.states[k], 'b-' + r.id, true), `${r.id}/${k}`);
  }
  const gateOnly = figureRuntime(['gate']);
  assert.equal(/function (seqSvg|relSvg|relLayout)\b/.test(gateOnly), false);
  const g = {};
  runInNewContext(gateOnly + '\nthis.figSvg = figSvg;', g);
  assert.equal(g.figSvg(EX1.rules[0], EX1.rules[0].states.bug, 'x', true), figSvg(EX1.rules[0], EX1.rules[0].states.bug, 'x', true));
  assert.equal(renderBoardHtml(EX1).includes('function relSvg'), false);
  assert.ok(renderBoardHtml(EX5).includes('function relSvg'));
});
test('figure: a board whose first rule is a relation still server-renders unique static markers', () => {
  const b = clone(EX5);
  delete b.defaultView;
  b.rules.unshift(...b.rules.splice(REL_RULE, 1));
  const html = renderBoardHtml(b);
  expectPass(html);
  assert.ok(html.includes('id="fg-hs-focus-delegation_cycle"'));
  const seqFirst = clone(EX5);
  delete seqFirst.defaultView;
  seqFirst.rules.unshift(...seqFirst.rules.splice(SEQ_RULE, 1));
  expectPass(renderBoardHtml(seqFirst));
});
test('sequence: 3 lanes x 5 steps with a lane-skipping step, a self-step on the last lane and chips fit without warnings', () => {
  const b = clone(EX5);
  const r = b.rules[SEQ_RULE];
  r.figure.steps[1] = { id: 'close', from: 'ledger', to: 'ledger', label: 'close October' };
  assert.deepEqual(figureOverflows(r), []);
  const svg = figSvg(r, r.states.bug, 'u', true);
  assert.equal((svg.match(/class="fg-badge"/g) || []).length, 3);
  assert.ok(/data-step="write" class="fg-arrow is-on is-here"/.test(svg));
  assert.ok(/data-step="post" class="fg-arrow is-dim"/.test(svg));
  assert.equal(validateBoardData(b).warnings.length, 0);
});
test('sequence: two lanes and two steps are valid; a step label too wide for its lanes warns', () => {
  const b = clone(EX5);
  const r = b.rules[SEQ_RULE];
  r.figure.lanes = r.figure.lanes.slice(0, 2);
  r.figure.steps = [{ id: 'check', from: 'acct', to: 'lock', label: 'check: open' }, { id: 'close', from: 'lock', to: 'lock', label: 'close October' }];
  for (const st of Object.values(r.states)) { st.activeSteps = ['check', 'close']; st.focusStep = 'close'; delete st.chips; }
  assert.deepEqual(validateBoardData(b).warnings, []);
  r.figure.steps[1].label = 'close October and every other open period in the ledger';
  assert.ok(hasWarning(validateBoardData(b), `$.rules[${SEQ_RULE}].figure.steps[1].label`));
});
test('sequence: invalid lanes, steps and state references are errors', () => {
  const p = `$.rules[${SEQ_RULE}]`;
  const edit = (f) => { const b = clone(EX5); f(b.rules[SEQ_RULE]); return b; };
  schemaErr(edit((r) => { r.figure.lanes.push({ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }); }), `${p}.figure.lanes`);
  schemaErr(edit((r) => { r.figure.steps[0].from = 'nobody'; }), `${p}.figure.steps[0].from`);
  schemaErr(edit((r) => { r.figure.steps[1].id = 'check'; }), `${p}.figure.steps[1].id`);
  schemaErr(edit((r) => { r.states.bug.focusStep = 'post'; }), `${p}.states.bug.focusStep`);
  schemaErr(edit((r) => { r.states.bug.activeSteps = []; }), `${p}.states.bug.activeSteps`);
  schemaErr(edit((r) => { r.states.bug.activeSteps.push('nope'); }), `${p}.states.bug.activeSteps`);
  schemaErr(edit((r) => { r.states.bug.chips.push({ lane: 'lock', text: 'again', tone: 'bad' }); }), `${p}.states.bug.chips[2].lane`);
  const gateKey = edit((r) => { r.states.bug.route = ['a1']; });
  assert.ok(hasWarning(validateBoardData(gateKey), `${p}.states.bug.route`));
});
test('relation: 5 nodes x 7 edges with a bidirectional pair and a self-loop fit without warnings', () => {
  const b = clone(EX5);
  const r = b.rules[REL_RULE];
  r.figure.nodes = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, label: 'Node ' + id.toUpperCase() }));
  r.figure.edges = [
    { id: 'ab', from: 'a', to: 'b', label: 'owns' },
    { id: 'ba', from: 'b', to: 'a', label: 'trusts' },
    { id: 'ad', from: 'a', to: 'd', label: 'manages' },
    { id: 'be', from: 'b', to: 'e', label: 'manages' },
    { id: 'de', from: 'd', to: 'e', label: 'reports to' },
    { id: 'cc', from: 'c', to: 'c', label: 'audits', forbidden: true },
    { id: 'ec', from: 'e', to: 'c', label: 'asks' },
  ];
  for (const st of Object.values(r.states)) { st.activeEdges = ['ab', 'ba', 'cc']; st.focusNodes = ['c']; st.chips = [{ node: 'c', text: 'Self audit', tone: 'bad' }]; }
  assert.deepEqual(figureOverflows(r), []);
  assert.deepEqual(validateBoardData(b).warnings, []);
  const g = relLayout(r);
  const [ab, ba] = g.edges;
  assert.ok(Math.abs(ab.cy - ba.cy) >= 30, 'the two directions of a pair must bow apart');
  const pa = pillBox(ab.cx, ab.cy, ab.fit);
  const pb = pillBox(ba.cx, ba.cy, ba.fit);
  assert.ok(pa.y + pa.h <= pb.y || pb.y + pb.h <= pa.y, 'the labels of a bidirectional pair overlap');
  const safe = figSvg(r, { ...r.states.fixed }, 'u', true);
  assert.ok(safe.includes('marker-end="url(#fg-hs-u)"'), 'an active forbidden edge in the fixed state ends in a stop bar');
  assert.ok(figSvg(r, r.states.bug, 'u', true).includes('marker-end="url(#fg-hb-u)"'));
});
test('relation: crossing diagonals of a 2x2 layout are reported as a label collision', () => {
  const b = clone(EX5);
  const r = b.rules[REL_RULE];
  r.figure.nodes = ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id.toUpperCase() }));
  r.figure.edges = [{ id: 'ad', from: 'a', to: 'd', label: 'grants role' }, { id: 'bc', from: 'b', to: 'c', label: 'grants role' }];
  for (const st of Object.values(r.states)) { st.activeEdges = ['ad']; delete st.focusNodes; delete st.chips; }
  const w = validateBoardData(b).warnings;
  assert.ok(w.some((x) => x.startsWith(`$.rules[${REL_RULE}].figure.edges[1].label`) && /overlaps the label|crossed by/.test(x)), w.join('\n'));
});
test('relation: invalid nodes, edges and state references are errors', () => {
  const p = `$.rules[${REL_RULE}]`;
  const edit = (f) => { const b = clone(EX5); f(b.rules[REL_RULE]); return b; };
  schemaErr(edit((r) => { r.figure.nodes = r.figure.nodes.slice(0, 2); }), `${p}.figure.nodes`);
  schemaErr(edit((r) => { r.figure.edges[0].to = 'mallory'; }), `${p}.figure.edges[0].to`);
  schemaErr(edit((r) => { r.figure.edges.push({ id: 'ab2', from: 'alice', to: 'bob', label: 'again' }); }), `${p}.figure.edges[3]`);
  schemaErr(edit((r) => { r.figure.edges[2].forbidden = 'yes'; }), `${p}.figure.edges[2].forbidden`);
  schemaErr(edit((r) => { r.states.bug.focusNodes = ['mallory']; }), `${p}.states.bug.focusNodes`);
  schemaErr(edit((r) => { r.states.normal.activeEdges = []; }), `${p}.states.normal.activeEdges`);
  schemaErr(edit((r) => { r.states.bug.chips[0].node = 'mallory'; }), `${p}.states.bug.chips[0].node`);
  schemaErr(edit((r) => { r.figure.kind = 'graph'; }), `${p}.figure.kind`);
});

test('sequence: the connector lead of a right-to-left focus step starts right of its number badge', () => {
  const r = EX5.rules[SEQ_RULE];
  assert.equal(r.states.fixed.focusStep, 'reject');
  const svg = figSvg(r, r.states.fixed, 'u', true);
  const badge = svg.match(/data-step="reject"[^]*?<g class="fg-badge"><circle cx="([\d.]+)" cy="[\d.]+" r="([\d.]+)"/);
  const lead = svg.match(/class="fg-lead" d="M([\d.]+) /);
  assert.ok(badge && lead, 'the reject step has a badge and the figure a lead');
  assert.ok(Number(lead[1]) > Number(badge[1]) + Number(badge[2]), `lead starts at ${lead[1]}, inside the badge at ${badge[1]} r ${badge[2]}`);
});
test('relation: endpoints of bowed bidirectional pairs sit on the node borders, never inside', () => {
  const r = clone(EX5.rules[REL_RULE]);
  r.figure.nodes = ['a', 'b', 'c'].map((id) => ({ id, label: id.toUpperCase() }));
  r.figure.edges = [['a', 'b'], ['b', 'a'], ['b', 'c'], ['c', 'b'], ['c', 'a'], ['a', 'c']].map(([f, t]) => ({ id: f + t, from: f, to: t, label: 'x' }));
  const g = relLayout(r);
  const gap = (pt, n) => {
    const inside = pt[0] > n.x && pt[0] < n.x + n.w && pt[1] > n.y && pt[1] < n.y + n.h;
    return inside ? -1 : Math.hypot(Math.max(n.x - pt[0], 0, pt[0] - n.x - n.w), Math.max(n.y - pt[1], 0, pt[1] - n.y - n.h));
  };
  for (const x of g.edges) {
    for (const [pt, id] of [[x.p[0], x.e.from], [x.p[3], x.e.to]]) {
      const d = gap(pt, g.nodes[id]);
      assert.ok(d >= 0 && d <= 2.5, `edge ${x.e.id} endpoint (${pt.map((v) => v.toFixed(1))}) is ${d < 0 ? 'inside' : d.toFixed(1) + ' away from'} node ${id}`);
    }
  }
});
test('figure: lane and node ids such as constructor, toString and __proto__ draw like any other id', () => {
  const rename = (rule, map) => JSON.parse(Object.entries(map).reduce((t, [a, z]) => t.split('"' + a + '"').join('"' + z + '"'), JSON.stringify(rule)));
  const b = clone(EX5);
  b.rules[SEQ_RULE] = rename(b.rules[SEQ_RULE], { acct: 'constructor', ledger: 'toString' });
  b.rules[REL_RULE] = rename(b.rules[REL_RULE], { alice: 'constructor', bob: 'toString', carol: '__proto__' });
  assert.deepEqual(validateBoardData(b).errors, []);
  assert.deepEqual(validateBoardData(b).warnings, []);
  for (const i of [SEQ_RULE, REL_RULE]) {
    const r = b.rules[i];
    for (const [k, st] of Object.entries(r.states)) {
      const svg = figSvg(r, st, 'u', true);
      assert.equal(/NaN|undefined/.test(svg), false, `${r.id}/${k} draws NaN or undefined`);
      assert.equal((svg.match(/class="fg-chip /g) || []).length, (st.chips || []).length, `${r.id}/${k} draws a chip that is not in the state`);
    }
  }
  expectPass(renderBoardHtml(b));
});

// ---------------------------------------------------------------------------------------------
// Flow view (board.flow) and language-aware chrome (board.lang, board.labels)
// ---------------------------------------------------------------------------------------------
const ex5Evidence = () => {
  const f = ex5Flags();
  return { specPaths: f.filter((_, i) => f[i - 1] === '--spec'), logPaths: f.filter((_, i) => f[i - 1] === '--log') };
};
const JOURNEY_IDS = (b) => ['*', ...b.flow.journeys.map((j) => j.id)];
const withFlowEdit = (base, f) => { const b = clone(base); f(b); return b; };
const NO_FLOW = { '00_minimal': EX0, '01_room_booking': EX1, '02_escrow_payout': EX2, '03_multi_module_20rules': EX3 };

test('flow: examples 05 and 06 open on a valid flow with three journeys and no warnings', () => {
  for (const b of [EX5, EX6]) {
    const r = validateBoardData(b);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(r.warnings, []);
    assert.equal(b.defaultView, 'flow');
    assert.equal(b.flow.journeys.length, 3);
    assert.deepEqual(b.flow.journeys.map((j) => j.tone), ['normal', 'bug', 'safe']);
  }
  assert.deepEqual(EX5.flow.steps.map((s) => s.moduleId), ['delegation', 'escrow', 'period']);
  assert.equal(EX6.lang, 'ja');
});

test('flow schema: bad references, empty stages, self-loops, duplicates and misplaced options are errors', () => {
  const e5 = (f) => withFlowEdit(EX5, f);
  schemaErr(e5((b) => { delete b.flow; }), '$.defaultView');
  schemaErr(e5((b) => { b.defaultView = 'grid'; }), '$.defaultView');
  schemaErr(e5((b) => { b.lang = 'fr'; }), '$.lang');
  schemaErr(e5((b) => { b.labels = { modulePlural: '' }; }), '$.labels.modulePlural');
  schemaErr(e5((b) => { b.labels = 'stages'; }), '$.labels');
  schemaErr(e5((b) => { b.flow = []; }), '$.flow');
  schemaErr(e5((b) => { b.flow.steps = b.flow.steps.slice(0, 1); }), '$.flow.steps');
  schemaErr(e5((b) => { b.flow.steps.push(...['a', 'b', 'c', 'd'].map((id) => ({ id, label: id, moduleId: 'escrow' }))); }), '$.flow.steps');
  schemaErr(e5((b) => { b.flow.steps[1].id = 'access'; }), '$.flow.steps[1].id');
  schemaErr(e5((b) => { b.flow.steps[1].id = 'bad id'; }), '$.flow.steps[1].id');
  schemaErr(e5((b) => { b.flow.steps[1].moduleId = 'ghost'; }), '$.flow.steps[1].moduleId');
  schemaErr(e5((b) => { delete b.flow.steps[1].moduleId; }), '$.flow.steps[1]');
  schemaErr(e5((b) => { b.flow.steps[0].ruleIds = ['refund_cap']; }), '$.flow.steps[0].ruleIds');
  schemaErr(e5((b) => { b.flow.steps[0].ruleIds = ['ghost']; }), '$.flow.steps[0].ruleIds');
  schemaErr(e5((b) => { b.flow.steps[0].ruleIds = []; }), '$.flow.steps[0].ruleIds');
  schemaErr(e5((b) => { b.flow.steps[0].ruleIds = ['self_approval', 'self_approval']; }), '$.flow.steps[0].ruleIds');
  schemaErr(e5((b) => { b.flow.edges = []; }), '$.flow.edges');
  schemaErr(e5((b) => { b.flow.edges[0].to = 'access'; }), '$.flow.edges[0]');
  schemaErr(e5((b) => { b.flow.edges[0].to = 'ghost'; }), '$.flow.edges[0].to');
  schemaErr(e5((b) => { b.flow.edges[1].id = 'approved'; }), '$.flow.edges[1].id');
  schemaErr(e5((b) => { b.flow.edges.push({ ...b.flow.edges[0], id: 'again' }); }), '$.flow.edges[2]');
  schemaErr(e5((b) => { b.flow.edges[0].kind = 'teleport'; }), '$.flow.edges[0].kind');
  schemaErr(e5((b) => { delete b.flow.edges[0].label; }), '$.flow.edges[0].label');
  schemaErr(e5((b) => { b.flow.journeys = []; }), '$.flow.journeys');
  schemaErr(e5((b) => { b.flow.journeys[2].id = 'happy'; }), '$.flow.journeys[2].id');
  schemaErr(e5((b) => { b.flow.journeys[0].stepIds = ['ghost']; }), '$.flow.journeys[0].stepIds');
  schemaErr(e5((b) => { b.flow.journeys[0].stepIds = []; }), '$.flow.journeys[0].stepIds');
  schemaErr(e5((b) => { b.flow.journeys[1].edgeIds = ['posting']; }), '$.flow.journeys[1].edgeIds');
  schemaErr(e5((b) => { b.flow.journeys[1].edgeIds = ['ghost']; }), '$.flow.journeys[1].edgeIds');
  schemaErr(e5((b) => { b.flow.journeys[1].tone = 'scary'; }), '$.flow.journeys[1].tone');
  schemaErr(e5((b) => { delete b.flow.journeys[1].summary; }), '$.flow.journeys[1].summary');
  schemaErr(e5((b) => { b.flow.journeys[1].checkpointRuleId = 'ghost'; }), '$.flow.journeys[1].checkpointRuleId');
  schemaErr(e5((b) => { b.flow.journeys[0].checkpointFocus = 'bug'; }), '$.flow.journeys[0].checkpointFocus');
  schemaErr(e5((b) => { b.flow.journeys[1].checkpointFocus = 'broken'; }), '$.flow.journeys[1].checkpointFocus');
  schemaErr(withFlowEdit(EX6, (b) => { b.flow.steps[0].moduleId = 'access'; }), '$.flow.steps[0].moduleId');
  const lone = withFlowEdit(EX5, (b) => { b.modules.push({ id: 'audit', title: 'Audit' }); b.flow.steps[2].moduleId = 'audit'; });
  schemaErr(lone, '$.flow.steps[2].moduleId');
  const long = validateBoardData(e5((b) => { b.labels.overview = 'A very long overview button label'; b.flow.journeys[0].label = 'A journey label that runs too long'; }));
  assert.equal(long.ok, true, long.errors.join('\n'));
  assert.ok(hasWarning(long, '$.labels.overview') && hasWarning(long, '$.flow.journeys[0].label'), long.warnings.join('\n'));
});

test('flow: a journey checkpoint opens the given focus, or the one its tone implies', () => {
  const [happy, bug, safe] = EX5.flow.journeys;
  assert.equal(checkpointFocus(bug), 'bug');
  assert.equal(checkpointFocus(safe), 'fixed');
  assert.equal(checkpointFocus(happy), 'normal');
  assert.equal(checkpointFocus({ ...bug, checkpointFocus: undefined }), 'bug');
  assert.equal(checkpointFocus({ ...safe, checkpointFocus: 'normal' }), 'normal');
});

test('flow: stage, edge and journey ids such as constructor, toString and __proto__ draw like any other id', () => {
  const rename = { access: 'constructor', escrow: 'toString', period: '__proto__', approved: 'constructor', posting: '__proto__', happy: 'toString', unreviewed: 'constructor', guarded: '__proto__' };
  const b = clone(EX5);
  for (const s of b.flow.steps) s.id = rename[s.id];
  for (const e of b.flow.edges) { e.id = rename[e.id]; e.from = rename[e.from]; e.to = rename[e.to]; }
  for (const j of b.flow.journeys) { j.id = rename[j.id]; j.stepIds = j.stepIds.map((x) => rename[x]); j.edgeIds = j.edgeIds.map((x) => rename[x]); }
  assert.deepEqual(validateBoardData(b).errors, []);
  assert.deepEqual(validateBoardData(b).warnings, []);
  for (const jid of JOURNEY_IDS(b)) {
    const html = flowView(b, uiFor(b), jid);
    assert.equal(/NaN|undefined|\[object/.test(html), false, `journey ${jid} draws NaN or undefined`);
    assert.equal((html.match(/class="fl-stage/g) || []).length, 3);
    assert.equal((html.match(/data-act="flow-rule"/g) || []).length, 6);
  }
  assert.ok(flowView(b, uiFor(b), 'constructor').includes('data-journey="constructor"'));
  expectPass(renderBoardHtml(b));
});

test('flow: the injected runtime renders every journey exactly like the server, and the SSR opens on it', () => {
  for (const b of [EX5, EX6]) {
    const ctx = { B: b };
    runInNewContext([figureRuntime(FIGURE_KINDS), ruleStatus.toString(), uiSource(b), flowRuntime(), 'this.out = (j, sf) => flowView(B, UI(uiOptions(B)), j, sf);'].join('\n'), ctx);
    for (const jid of JOURNEY_IDS(b)) {
      for (const sf of ['all', 'failed', 'verified', 'pending']) assert.equal(ctx.out(jid, sf), flowView(b, uiFor(b), jid, sf), `${b.runId} / ${jid} / ${sf}`);
    }
    const html = renderBoardHtml(b, ex5Evidence());
    assert.ok(html.includes('<div class="pc-wrap pc-main">' + flowView(b, uiFor(b), '*') + oosMarkup(b, uiFor(b), true) + '</div></main>'), 'the SSR shell is not the runtime flow markup plus the out-of-scope note');
    assert.match(html, /<div class="pc-root" id="proof-canvas-root" data-mode="standalone" data-layout="[a-z]+" data-view="flow" [^>]*data-journey="\*">/);
    assert.equal(html.includes('id="fg-h-focus-'), false, 'a flow-first board still server-renders the first rule');
  }
});

test('flow: a journey dims every other stage and edge and offers its checkpoint; "all" dims nothing', () => {
  const L = uiFor(EX5);
  const all = flowView(EX5, L, '*');
  assert.equal(/is-dim|is-on|fl-cta/.test(all), false);
  assert.ok(all.includes(L.flowHint));
  const bug = flowView(EX5, L, 'unreviewed');
  assert.match(bug, /<section class="card fl tn-bug" data-flow data-journey="unreviewed">/);
  assert.match(bug, /class="fl-stage is-on[^"]*" data-step="access"/);
  assert.match(bug, /class="fl-stage is-dim[^"]*" data-step="period"/);
  assert.match(bug, /class="fl-edge k-normal is-on" data-edge="approved"/);
  assert.match(bug, /class="fl-edge k-normal is-dim" data-edge="posting"/);
  assert.match(bug, /class="fl-chip st-verified is-cp" data-act="flow-rule" data-v="self_approval"/);
  assert.match(bug, /<button type="button" class="fl-cta" data-act="checkpoint" data-v="unreviewed">Inspect this rule →<\/button>/);
  assert.ok(bug.includes(EX5.flow.journeys[1].summary.replace(/'/g, "'")));
  assert.equal(flowView(EX5, L, 'happy').includes('fl-cta'), false, 'a journey without a checkpoint shows no button');
  assert.equal(flowView(EX5, L, 'ghost'), all, 'an unknown journey shows every stage');
});

test('flow: the honesty caption is always on the map, with flow.note after it', () => {
  const en = flowView(EX5, uiFor(EX5), '*');
  assert.ok(en.includes('<p class="fl-cap">System flow map: arrows show how stages connect; each rule\'s status reflects its reported check. ' + EX5.flow.note + '</p>'));
  const ja = flowView(EX6, uiFor(EX6), 'late_post');
  assert.ok(ja.includes('<p class="fl-cap">システム全体の見取り図：矢印は工程のつながり、各ルールの状態は記録された検証結果を示します。' + EX6.flow.note + '</p>'));
  const bare = withFlowEdit(EX5, (b) => { delete b.flow.note; });
  assert.ok(flowView(bare, uiFor(bare), '*').includes('<p class="fl-cap">System flow map: arrows show how stages connect; each rule\'s status reflects its reported check.</p>'));
});

test('flow: stage badges count the rules\' own verdicts (a failed rule turns its stage red)', () => {
  const b = withFlowEdit(EX5, (x) => { x.rules[3].status = 'failed'; x.rules[3].evidence.counterexample = 'trace'; x.rules[4].status = 'pending'; });
  const html = flowView(b, uiFor(b), '*');
  assert.match(html, /data-step="access"[^>]*>.*?<span class="st-pill st-failed fl-st-b">1 failed · 1\/2 verified<\/span>/);
  assert.match(html, /data-step="escrow"[^>]*>.*?<span class="st-pill st-verified fl-st-b">2\/2 verified<\/span>/);
  assert.match(html, /data-step="period"[^>]*>.*?<span class="st-pill st-pending fl-st-b">1\/2 verified<\/span>/);
  assert.match(html, /class="fl-stage has-fail" data-step="access"/);
  assert.equal(resolveProvenance(b, undefined).kind, 'failed', 'the flow never changes the board badge rules');
});

test('flow layout: 2 to 6 stages with forward, skip, back and two-way edges fit without collisions', () => {
  const ids = EX5.rules.map((r) => r.id);
  for (let n = 2; n <= 6; n += 1) {
    const b = clone(EX5);
    b.flow.steps = Array.from({ length: n }, (_, i) => ({ id: 's' + i, label: (i + 1) + '. Stage ' + (i + 1), summary: 'What happens in stage ' + (i + 1) + '.', ruleIds: [ids[i % ids.length]] }));
    const edges = Array.from({ length: n - 1 }, (_, i) => ({ id: 'e' + i, from: 's' + i, to: 's' + (i + 1), label: 'hand over ' + i }));
    if (n >= 3) edges.push({ id: 'skip', from: 's0', to: 's2', label: 'skip review', kind: 'bypass' });
    if (n >= 4) edges.push({ id: 'back', from: 's' + (n - 1), to: 's0', label: 'retry', kind: 'handoff' });
    edges.push({ id: 'undo', from: 's1', to: 's0', label: 'send back' });
    b.flow.edges = edges;
    b.flow.journeys = [{ id: 'j', label: 'Path', tone: 'bug', summary: 'One path.', stepIds: ['s0', 's1'], edgeIds: ['e0', 'undo'] }];
    const r = validateBoardData(b);
    assert.deepEqual(r.errors, [], `${n} stages`);
    assert.deepEqual(flowOverflows(b), [], `${n} stages`);
    const html = flowView(b, uiFor(b), 'j');
    assert.equal((html.match(/class="fl-edge/g) || []).length, edges.length);
    assert.equal(/NaN|undefined/.test(html), false);
  }
  const crowded = withFlowEdit(EX5, (b) => { b.flow.edges[0].label = 'an authorized and fully reviewed escrow payout request'; });
  assert.ok(hasWarning(validateBoardData(crowded), '$.flow.edges[0].label'), 'a label too long for its gap must warn');
});

// A chain of n stages over two rows, plus extra edges; returns the board and its layout.
const chainFlow = (n, label, extra = [], lang) => {
  const ids = EX5.rules.map((r) => r.id);
  const b = clone(EX5);
  if (lang) b.lang = lang;
  b.flow.steps = Array.from({ length: n }, (_, i) => ({ id: 's' + i, label: (i + 1) + '. Stage', summary: 'Stage ' + (i + 1) + '.', ruleIds: [ids[i % ids.length]] }));
  b.flow.edges = [...Array.from({ length: n - 1 }, (_, i) => ({ id: 'e' + i, from: 's' + i, to: 's' + (i + 1), label: i === Math.ceil(n / 2) - 1 ? label : 'next' })), ...extra];
  b.flow.journeys = [{ id: 'j', label: 'Path', tone: 'normal', summary: 'One path.', stepIds: ['s0', 's1'], edgeIds: ['e0'] }];
  return { b, g: flowLayout(b) };
};
const pillsMeet = (p, q) => p.x < q.x + q.w - 0.5 && q.x < p.x + p.w - 0.5 && p.y < q.y + q.h - 0.5 && q.y < p.y + p.h - 0.5;

test('flow layout: the corner label of the last column turns inward and an outer two-way pair stays on the map', () => {
  for (const n of [4, 6]) {
    const last = 's' + (n - 1);
    const audit = [{ id: 'up', from: 's0', to: last, label: 'direct audit log' }, { id: 'down', from: last, to: 's0', label: 'direct audit log' }];
    for (const [label, lang] of [['承認済みの払い出し', 'ja'], ['approved release', undefined]]) {
      const { b, g } = chainFlow(n, label, audit, lang);
      assert.deepEqual(validateBoardData(b).errors, [], `${n} stages, ${label}`);
      assert.deepEqual(flowOverflows(b), [], `${n} stages, ${label}`);
      const corner = g.edges.find((x) => x.e.label === label);
      assert.equal(corner.type, 'v');
      const line = Number(corner.d.match(/^M([\d.]+)/)[1]);
      assert.ok(corner.pill.x + corner.pill.w < line, `${label}: the last-column label sits left of its line`);
      for (const x of g.edges) assert.ok(x.pill.x >= 0 && x.pill.x + x.pill.w <= g.W, `${n} stages, ${x.e.id} pill inside [0, W]`);
    }
  }
});

test('flow layout: a two-way diagonal pair puts one label above the crossing and one below', () => {
  for (const n of [4, 6]) {
    const cross = [{ id: 'x1', from: 's0', to: 's' + (n - 2), label: 'cross check' }, { id: 'x2', from: 's' + (n - 2), to: 's0', label: 'cross check' }];
    const { b, g } = chainFlow(n, 'next', cross);
    const [p, q] = ['x1', 'x2'].map((id) => g.edges.find((x) => x.e.id === id));
    assert.equal(p.type, 'x', `${n} stages`);
    assert.equal(pillsMeet(p.pill, q.pill), false, `${n} stages: the two diagonal labels overlap`);
    assert.deepEqual(flowOverflows(b), [], `${n} stages`);
  }
});

test('flow schema: a null rule is a schema error, not a crash in the flow layout', () => {
  const b = clone(EX5);
  b.rules.push(null);
  let r;
  assert.doesNotThrow(() => { r = validateBoardData(b); });
  assert.ok(r.errors.some((e) => e.startsWith('$.rules[6]')), JSON.stringify(r.errors));
  assert.equal(r.warnings.some((w) => w.startsWith('$.flow')), false);
});

test('flow: boards without a flow ship no flow code, styles or copy', () => {
  for (const [name, b] of [...Object.entries(NO_FLOW), ['04_refund_guard', refund]]) {
    const html = renderBoardHtml(b);
    for (const needle of ['function flowView', 'fl-stage', 'fl-jbar', 'Inspect this rule', 'System flow map', 'data-journey', 'openFromFlow']) {
      assert.equal(html.includes(needle), false, `${name} ships "${needle}"`);
    }
  }
  const html = renderBoardHtml(EX5, ex5Evidence());
  for (const needle of ['function flowView', 'fl-stage', 'Inspect this rule', 'openFromFlow']) assert.ok(html.includes(needle), needle);
});

test('lang: Japanese boards get <html lang="ja"> and Japanese chrome; English boards stay CJK-free', () => {
  const ja = renderBoardHtml(EX6, ex5Evidence());
  assert.match(ja, /<html lang="ja">/);
  for (const s of ['実ログ検証済み (3/3)', 'このボードは実ファイルと突合済みです。', '動きを比べる', '根拠と実ログ', 'このルールがないときの反例', '反例は記録されていません', 'ルール一覧', '全体の流れ', '全体を見る', 'このルールの詳細を見る →', 'ルールをクリックして詳細を開く', '見本データ', '一部未検証']) {
    assert.ok(ja.includes(s), `missing Japanese chrome "${s}"`);
  }
  for (const s of ["'Proof & log'", "'Compare'", 'Spec &amp; log verified', "'Filter rules'"]) assert.equal(ja.includes(s), false, `English chrome "${s}" leaked into a Japanese board`);
  const en = renderBoardHtml(EX5, ex5Evidence());
  assert.match(en, /<html lang="en">/);
  assert.equal(CJK.test(en), false, 'an English flow board carries CJK text');
  for (const s of ["'Compare'", "'Proof & log'", 'Spec &amp; log verified (6/6)']) assert.ok(en.includes(s), s);
  assert.equal(en.includes("'Scenario'") || en.includes("evTitle: 'Evidence'"), false);
});

test('labels: module wording and the overview button follow labels, then the language default', () => {
  assert.equal(uiFor(EX5).flowAll, 'All stages');
  assert.equal(uiFor(EX5).hubOpen, 'Open the first rule of this stage');
  assert.equal(uiFor(EX3).modulesN, 'modules');
  assert.equal(uiFor(EX3).hubOpen, 'Open the first rule of this module');
  assert.equal(uiFor(EX6).hubOpen, 'この工程の最初のルールを開く');
  assert.equal(uiFor({ lang: 'ja' }).modulesN, 'グループ');
  assert.equal(uiFor(EX5).overview, 'Flow');
  assert.equal(uiFor(EX1).overview, 'Overview');
  assert.equal(uiFor(EX6).overview, '全体の流れ');
  assert.equal(uiFor({ lang: 'ja' }).overview, '一覧');
  assert.equal(uiFor({ ...EX5, labels: { overview: 'Map' } }).overview, 'Map');
  assert.equal(uiFor(EX6).viewAll(3), '一覧 (3)');
  assert.equal(uiFor(EX1).viewAll(3), 'Overview (3)');
});

test('flow: every new text field is escaped in the server render and in each journey', () => {
  const x = '<img src=x onerror=alert(1)>"';
  const b = withFlowEdit(EX5, (v) => {
    v.flow.title = x; v.flow.note = x;
    v.flow.steps[0].label = x; v.flow.steps[0].summary = x;
    v.flow.edges[0].label = x;
    v.flow.journeys[1].label = x; v.flow.journeys[1].summary = x;
    v.labels = { moduleSingular: x, modulePlural: x, overview: x };
  });
  assert.deepEqual(validateBoardData(b).errors, []);
  const html = renderBoardHtml(b);
  expectPass(html);
  assert.equal(html.includes('<img src=x'), false);
  for (const jid of JOURNEY_IDS(b)) assert.equal(flowView(b, uiFor(b), jid).includes('<img'), false, jid);
  assert.ok(flowView(b, uiFor(b), 'unreviewed').includes('&lt;img src=x onerror=alert(1)&gt;&quot;'));
});

test('examples 05 and 06: the flow boards bind to real specs and logs with 0 errors, 0 warnings, under budget', () => {
  const inputs = { '05_multi_verifier': join(ROOT, 'examples', '05_multi_verifier', 'multi_verifier.board.json'), '06_japanese_board': join(ROOT, 'examples', '06_japanese_board', 'multi_verifier_ja.board.json') };
  for (const [name, input] of Object.entries(inputs)) {
    for (const mode of ['standalone', 'embed']) {
      const output = join(TMP, `${name}-${mode}.html`);
      const rendered = node('render_board.mjs', ['--in', input, ...ex5Flags(), '--mode', mode, '--out', output]);
      assert.equal(rendered.status, 0, rendered.stderr);
      assert.equal(rendered.stderr, '', rendered.stderr);
      assert.match(rendered.stdout, /provenance=verified/);
      const validated = node('validate_board.mjs', ['--in', input, ...ex5Flags(), output]);
      assert.equal(validated.status, 0, validated.stdout + validated.stderr);
      assert.equal(/WARN|ERR/.test(validated.stdout), false, validated.stdout);
      assert.ok(readFileSync(output).length <= 128 * 1024, `${name} ${mode} is over the 128 KB budget`);
      assert.equal((readFileSync(output, 'utf8').match(/<details class="pc-oos" open>/g) || []).length, 1, `${name} ${mode} has no out-of-scope note`);
    }
  }
});

// A flow board with one failed and one unchecked rule, so a status filter has hits and misses.
const MIXED = withFlowEdit(EX5, (b) => {
  b.rules.find((r) => r.id === 'refund_cap').status = 'failed';
  delete b.rules.find((r) => r.id === 'period_closed').status;
  b.run.status = 'failed';
});
const chipTags = (html) => Object.fromEntries([...html.matchAll(/class="fl-chip st-([a-z]+)( is-cp)?( is-hit| is-off)?" data-act="flow-rule" data-v="([^"]+)"/g)].map((m) => [m[4], (m[3] || '').trim()]));
const stageOff = (html) => Object.fromEntries([...html.matchAll(/<section class="fl-stage([^"]*)" data-step="([^"]+)"/g)].map((m) => [m[2], / is-off/.test(m[1])]));

test('toolbar: no board ships a search box, a module select or their shortcut', () => {
  for (const [name, b] of [...Object.entries(NO_FLOW), ['04_refund_guard', refund], ['05', EX5], ['06', EX6], ['mixed', MIXED]]) {
    const html = renderBoardHtml(b);
    for (const s of ['<input', '<select', 'pc-q', 'pc-module', 'pc-search', 'pc-select', 'pc-kbd', "e.key === '/'", 'compositionend', 'data-act="module"', "act === 'module'"]) {
      assert.equal(html.includes(s), false, `${name} still carries ${s}`);
    }
  }
});

test('flow: a status filter highlights matching chips and dims the rest and stages with no match', () => {
  const L = uiFor(MIXED);
  const all = flowView(MIXED, L, '*');
  assert.deepEqual(Object.values(chipTags(all)), ['', '', '', '', '', '']);
  assert.equal(/is-hit|is-off/.test(all), false);
  assert.equal(flowView(MIXED, L, '*', 'all'), all);
  const failed = flowView(MIXED, L, '*', 'failed');
  assert.deepEqual(chipTags(failed), { delegation_cycle: 'is-off', self_approval: 'is-off', refund_cap: 'is-hit', nonnegative: 'is-off', period_closed: 'is-off', draft_budget: 'is-off' });
  assert.deepEqual(stageOff(failed), { access: true, escrow: false, period: true });
  const verified = flowView(MIXED, L, '*', 'verified');
  assert.deepEqual(chipTags(verified), { delegation_cycle: 'is-hit', self_approval: 'is-hit', refund_cap: 'is-off', nonnegative: 'is-hit', period_closed: 'is-off', draft_budget: 'is-hit' });
  assert.deepEqual(stageOff(verified), { access: false, escrow: false, period: false });
  // A journey and a status filter combine: the journey still dims its stages.
  const j = MIXED.flow.journeys[0];
  const both = flowView(MIXED, L, j.id, 'pending');
  assert.deepEqual(stageOff(both), { access: true, escrow: true, period: false });
  assert.ok(both.includes('data-journey="' + j.id + '"'));
  assert.match(both, /class="fl-stage is-(on|dim) is-off/);
});

test('schema: outOfScope is an optional list of 1 to 12 { area, reason } with non-empty strings', () => {
  const ok = withFlowEdit(EX1, (b) => { b.outOfScope = [{ area: 'Clock skew', reason: 'Time is a counter in the model.' }]; });
  assert.deepEqual(validateBoardData(ok).errors, []);
  assert.deepEqual(validateBoardData(ok).warnings, []);
  const item = { area: 'A', reason: 'R' };
  for (const [v, path] of [
    ['none', '$.outOfScope'], [{}, '$.outOfScope'], [[], '$.outOfScope'], [Array(13).fill(item), '$.outOfScope'],
    [['x'], '$.outOfScope[0]'], [[{ reason: 'R' }], '$.outOfScope[0].area'], [[{ area: 'A', reason: ' ' }], '$.outOfScope[0].reason'],
    [[item, { area: 3, reason: 'R' }], '$.outOfScope[1].area'],
  ]) schemaErr(withFlowEdit(EX1, (b) => { b.outOfScope = v; }), path);
  assert.deepEqual(validateBoardData(withFlowEdit(EX1, (b) => { b.outOfScope = Array(12).fill(item); })).errors, []);
  assert.ok(hasWarning(validateBoardData(withFlowEdit(EX1, (b) => { b.outOfScope = [{ ...item, owner: 'x' }]; })), '$.outOfScope[0].owner'));
});

test('outOfScope: escaped, rendered under the main view in English and Japanese, absent when not given', () => {
  const x = '<img src=x onerror=alert(1)>"';
  for (const base of [EX1, EX3, EX5, EX6]) {
    const b = withFlowEdit(base, (v) => { v.outOfScope = [{ area: x, reason: x + ' & more' }]; });
    const html = renderBoardHtml(b);
    expectPass(html);
    assert.equal(html.includes('<img src=x'), false, b.runId);
    const note = oosMarkup(b, uiFor(b), true);
    assert.ok(note.includes('<li><b>&lt;img src=x onerror=alert(1)&gt;&quot;</b>&lt;img src=x onerror=alert(1)&gt;&quot; &amp; more</li>'), note);
    assert.ok(html.includes(note + '</div></main>'), `${b.runId}: the server shell does not end the main view with the note`);
    assert.ok(html.includes('function oosMarkup('), `${b.runId}: the runtime cannot redraw the note`);
    assert.equal(oosMarkup(b, uiFor(b), false).startsWith('<details class="pc-oos"><summary>'), true);
  }
  assert.ok(oosMarkup(EX5, uiFor(EX5), true).startsWith('<details class="pc-oos" open><summary>Out of scope (not checked by these models)</summary><ul><li><b>Larger inputs</b>'));
  assert.ok(oosMarkup(EX6, uiFor(EX6), true).startsWith('<details class="pc-oos" open><summary>モデル外・検証していない範囲</summary><ul><li><b>大きな入力</b>'));
  for (const b of [EX0, EX1, EX2, EX3, refund]) {
    const html = renderBoardHtml(b);
    assert.equal(/pc-oos|oosMarkup|oosOpen/.test(html), false, `${b.runId} carries out-of-scope code without outOfScope`);
  }
});

// ---------------------------------------------------------------------------------------------
// Mutant counterexamples (--mutant-log), run.bounds, evidence.witness and the trust pill
// ---------------------------------------------------------------------------------------------
const MUT = (name, text) => { const f = join(TMP, name); writeFileSync(f, text); return f; };
const quintStates = (n) => Array.from({ length: n }, (_, i) => `[State ${i}]\n{\n  booked:\n    Set(${i}),\n  path: "/Users/alice/secret/model.qnt"\n}\n`).join('\n');
const QUINT_KILL = MUT('quint_kill.log', `$ quint run /Users/alice/models/mutant.qnt --max-steps=6 --invariant=NoOverlappingBookings\nAn example execution:\n\n${quintStates(3)}\n[violation] Found an issue (12ms).\nerror: Invariant violated\n`);
const QUINT_LONG = MUT('quint_long.log', `$ quint run mutant.qnt --invariant=NoOverlappingBookings\n${quintStates(20)}\n[violation] Found an issue (12ms).\n`);
const QUINT_OK = MUT('quint_ok.log', '$ quint run mutant.qnt --invariant=NoOverlappingBookings\n[ok] No violation found (2000 traces).\n');
const QUINT_TWO = MUT('quint_two.log', `$ quint run mutant.qnt --invariants NoOverlappingBookings AttendeesWithinCapacity\n${quintStates(2)}\n[violation] Found an issue.\n`);
const tlc = (inv) => `$ java tlc2.TLC -config M.cfg M.tla\nParsing file /Users/alice/models/M.tla\nError: Invariant ${inv} is violated.\nError: The behavior up to this point is:\nState 1: <Initial predicate>\n/\\ bookings = {}\n/\\ log = "C:\\\\work\\\\run.txt"\n\nState 2: <ConfirmNoCheck line 3, col 1 to line 4, col 2 of module M>\n/\\ bookings = {"a", "b"}\n/\\ log = "C:\\\\work\\\\run.txt"\n\n9 states generated, 5 distinct states found.\n`;
const TLC_KILL = MUT('tlc_kill.log', tlc('NoOverlappingBookings'));
const TLC_OTHER = MUT('tlc_other.log', tlc('AttendeesWithinCapacity'));
const TLC_PASS = MUT('tlc_pass.log', 'Model checking completed. No error has been found.\n9 states generated, 5 distinct states found.\n');
const ALLOY_KILL = MUT('alloy_kill.log', '$ java -jar alloy.jar exec m.als\n00. run   Witness   0    1/1     SAT\n01. check NoOverlappingBookings   0    1/1     SAT\n02. check AttendeesWithinCapacity   0       UNSAT\n');
const ALLOY_UNSAT = MUT('alloy_unsat.log', '00. check NoOverlappingBookings   0       UNSAT\n');
const receipt = (sat) => JSON.stringify({ commands: {
  Witness: { name: 'Witness', type: 'run', source: 'run Witness', solution: [{ instances: [{ values: {} }] }] },
  NoOverlappingBookings: { name: 'NoOverlappingBookings', type: 'check', source: 'check NoOverlappingBookings for 4',
    ...(sat ? { solution: [{ instances: [{ skolems: { $clash: { data: [['Booking$0'], ['Booking$1']] } }, values: { Booking$0: { room: [['Room$0']], slot: [] } } }] }] } : {}) },
} });
const RECEIPT_KILL = MUT('receipt.json', receipt(true));
const RECEIPT_UNSAT = MUT('receipt_unsat.json', receipt(false));
const itf = (status) => JSON.stringify({ '#meta': { format: 'ITF', status, description: 'Created by Quint' }, vars: ['s'],
  states: [0, 1, 2].map((i) => ({ '#meta': { index: i }, s: { held: { '#set': i ? [{ '#bigint': String(i) }] : [] }, stage: i === 2 ? 'double' : 'open' } })) });
const ITF_KILL = MUT('mutant.itf.json', itf('violation'));
const ITF_OK = MUT('ok.itf.json', itf('ok'));
const bindOne = (path, board = EX1, ruleId = 'no_double_booking') => bindEvidence(board, { mutantLogs: [{ ruleId, path }] });
const traceOf = (path, board, ruleId = 'no_double_booking') => bindOne(path, board, ruleId).counterexamples[ruleId];
const bindErr = (fn, re) => assert.throws(fn, (e) => re.test(e.message), re.source);

test('mutant-log: Quint, TLC, Alloy stdout, Alloy receipt and ITF counterexamples bind with machine-extracted steps', () => {
  const q = traceOf(QUINT_KILL);
  assert.deepEqual({ ...q, sha256: undefined }, { file: 'quint_kill.log', sha256: undefined, checker: 'Quint', violatedProperty: 'NoOverlappingBookings', stepCount: 3,
    steps: ['State 0: booked = Set(0); path = "…/model.qnt"', 'State 1: booked = Set(1)', 'State 2: booked = Set(2)'] });
  assert.equal(q.sha256, 'sha256:' + createHash('sha256').update(readFileSync(QUINT_KILL)).digest('hex'));
  const t = traceOf(TLC_KILL);
  assert.equal(t.checker, 'TLC');
  assert.deepEqual(t.steps, ['State 1 · Initial predicate: bookings = {}; log = "…/run.txt"', 'State 2 · ConfirmNoCheck: bookings = {"a", "b"}']);
  const a = traceOf(ALLOY_KILL);
  assert.deepEqual([a.checker, a.violatedProperty, a.steps], ['Alloy', 'NoOverlappingBookings', ['01. check NoOverlappingBookings 0 1/1 SAT']]);
  const r = traceOf(RECEIPT_KILL);
  assert.deepEqual(r.steps, ['check NoOverlappingBookings for 4: counterexample found', '$clash = {Booking$0, Booking$1}', 'Booking$0.room = {Room$0}']);
  const i = traceOf(ITF_KILL);
  assert.deepEqual([i.checker, i.violatedProperty, i.stepCount], ['Quint', null, 3]);
  assert.deepEqual(i.steps, ['State 0: s.held = Set(); s.stage = "open"', 'State 1: s.held = Set(1)', 'State 2: s.held = Set(2); s.stage = "double"']);
});

test('mutant-log: a long trace keeps 12 lines, the first six and the violating last states, with the true step count', () => {
  const c = traceOf(QUINT_LONG);
  assert.equal(c.stepCount, 20);
  assert.equal(c.steps.length, 12);
  assert.equal(c.steps[6], '… 9 more states …');
  assert.ok(c.steps[11].startsWith('State 19: '), c.steps[11]);
  for (const step of c.steps) assert.equal(/\/Users|C:\\/.test(step), false, step);
});

test('mutant-log anti-slop: a log without a kill, of another property or of several properties never binds', () => {
  for (const f of [QUINT_OK, TLC_PASS, ALLOY_UNSAT, RECEIPT_UNSAT, ITF_OK]) bindErr(() => bindOne(f), /binding: .*the mutant was not killed/);
  bindErr(() => bindOne(TLC_OTHER), /killed "AttendeesWithinCapacity", not the rule's property "NoOverlappingBookings"/);
  bindErr(() => bindOne(QUINT_TWO), /does not name the violated property/);
  bindErr(() => bindOne(MUT('noise.log', 'hello world\n')), /not a recognized/);
  bindErr(() => bindOne(MUT('bad.json', '{"x": 1}')), /unrecognized --mutant-log JSON/);
  bindErr(() => bindEvidence(EX1, { mutantLogs: [{ ruleId: 'ghost', path: QUINT_KILL }] }), /unknown rule "ghost"/);
  bindErr(() => bindEvidence(EX1, { mutantLogs: [{ ruleId: 'no_double_booking', path: QUINT_KILL }, { ruleId: 'no_double_booking', path: TLC_KILL }] }), /twice/);
  bindErr(() => parseMutantFlag('no-equals-sign'), /expects <ruleId>=<path>/);
  assert.deepEqual(parseMutantFlag('a=b=c.log'), { ruleId: 'a', path: 'b=c.log' });
});

test('mutant-log CLI: render and validate accept repeated flags and reject unknown or duplicate rules', () => {
  const input = join(ROOT, 'examples', '01_room_booking.board.json');
  const out = join(TMP, 'mutant-cli.html');
  const cap = MUT('cap.log', tlc('AttendeesWithinCapacity'));
  const flags = ['--mutant-log', 'no_double_booking=' + TLC_KILL, '--mutant-log', 'capacity=' + cap];
  const r = node('render_board.mjs', ['--in', input, ...flags, '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  const v = node('validate_board.mjs', ['--in', input, ...flags, out]);
  assert.equal(v.status, 0, v.stdout + v.stderr);
  assert.equal(/WARN|ERR/.test(v.stdout), false, v.stdout);
  const ghost = node('render_board.mjs', ['--in', input, '--mutant-log', 'ghost=' + TLC_KILL, '--out', out]);
  assert.match(ghost.stderr, /unknown rule "ghost"/);
  const twice = node('validate_board.mjs', [input, '--mutant-log', 'capacity=' + cap, '--mutant-log', 'capacity=' + cap]);
  assert.match(twice.stdout + twice.stderr, /twice/);
  const json = node('validate_board.mjs', [input, '--mutant-log', 'capacity=' + TLC_KILL]);
  assert.match(json.stdout, /killed "NoOverlappingBookings", not the rule's property "AttendeesWithinCapacity"/);
});

test('mutant-log validation: re-checked against the files, tampering and forged trace metadata are caught', () => {
  const mutantLogs = [{ ruleId: 'no_double_booking', path: TLC_KILL }];
  const html = renderBoardHtml(EX1, { mutantLogs });
  const ok = validateHtmlContent(html, 'x', { mutantLogs });
  assert.deepEqual([ok.errors, ok.warnings], [[], []]);
  assert.ok(hasWarning(validateHtmlContent(html), 'binding: embedded mutant counterexamples were not re-checked'));
  const edit = (f) => tamper(html, (d) => { f(d.__binding.counterexamples.no_double_booking, d); });
  const forgedStep = edit((c) => { c.steps[1] = 'State 2 · Confirm: bookings = {} (hand-written)'; });
  assert.equal(validateHtmlContent(forgedStep).ok, true, 'structurally valid, so only the file re-check can catch it');
  const caught = validateHtmlContent(forgedStep, 'x', { mutantLogs });
  assert.ok(caught.errors.some((e) => e.startsWith('binding: embedded mutant counterexamples do not match')), caught.errors.join('\n'));
  for (const [what, f] of [
    ['other property', (c) => { c.violatedProperty = 'AttendeesWithinCapacity'; }],
    ['null property on a text log', (c) => { c.violatedProperty = null; }],
    ['absolute path', (c) => { c.steps[0] = 'State 1: path = /Users/alice/x.tla'; }],
    ['step count', (c) => { c.stepCount = 5; }],
    ['checker', (c) => { c.checker = 'Hand'; }],
    ['extra key', (c) => { c.traceBound = true; }],
    ['unknown rule', (c, d) => { d.__binding.counterexamples.toString = c; }],
    ['empty map', (c, d) => { d.__binding.counterexamples = {}; }],
  ]) {
    const r = validateHtmlContent(edit(f));
    assert.ok(r.errors.some((e) => e.startsWith('provenance: binding: invalid embedded mutant counterexample metadata') || e.startsWith('provenance: binding: invalid embedded evidence')), `${what}: ${r.errors.join('; ')}`);
  }
  const missing = validateHtmlContent(renderBoardHtml(EX1), 'x', { mutantLogs });
  assert.ok(missing.errors.some((e) => e.startsWith('binding: embedded mutant counterexamples do not match')), missing.errors.join('\n'));
});

test('mutant-log validation: spec/log evidence and mutant traces are re-checked independently', () => {
  const { specPaths, logPaths } = ex5Evidence();
  const kill = MUT('refund_mutant.log', `$ quint run m.qnt --invariant=refundsWithinEscrow\n${quintStates(2)}\n[violation] Found an issue.\n`);
  const mutantLogs = [{ ruleId: 'refund_cap', path: kill }];
  const html = renderBoardHtml(EX5, { specPaths, logPaths, mutantLogs });
  const specOnly = validateHtmlContent(html, 'x', { specPaths, logPaths });
  assert.deepEqual(specOnly.errors, []);
  assert.deepEqual(specOnly.warnings, ['binding: embedded mutant counterexamples were not re-checked against --mutant-log files']);
  const mutantOnly = validateHtmlContent(html, 'x', { mutantLogs });
  assert.deepEqual(mutantOnly.errors, []);
  assert.deepEqual(mutantOnly.warnings, ['binding: embedded evidence was not re-checked against --spec/--log files']);
  assert.deepEqual(validateHtmlContent(html, 'x', { specPaths, logPaths, mutantLogs }).warnings, []);
  assert.equal(resolveProvenance(EX5, bindEvidence(EX5, { specPaths, logPaths, mutantLogs })).kind, 'verified');
});

test('mutant-log: rule ids such as __proto__ and constructor bind as own keys', () => {
  const b = clone(EX1);
  b.rules[0].id = '__proto__';
  b.rules[1].id = 'constructor';
  const binding = bindEvidence(b, { mutantLogs: [{ ruleId: '__proto__', path: TLC_KILL }] });
  assert.ok(Object.hasOwn(binding.counterexamples, '__proto__'));
  assert.equal(Object.hasOwn(binding.counterexamples, 'constructor'), false);
  const html = renderBoardHtml(b, { mutantLogs: [{ ruleId: '__proto__', path: TLC_KILL }] });
  assert.deepEqual(validateHtmlContent(html, 'x', { mutantLogs: [{ ruleId: '__proto__', path: TLC_KILL }] }).errors, []);
  assert.ok(html.includes('Object.hasOwn(BINDING.counterexamples, r.id)'), 'the runtime reads traces as own keys only');
  validateBinding(b, JSON.parse(JSON.stringify(binding)));
});

test('trace UI: trace copy and styles ship only with bound mutant logs; the honest pill ships everywhere', () => {
  const plain = renderBoardHtml(EX1);
  for (const s of ['trTitle', 'tr-steps', 'Machine-extracted']) assert.equal(plain.includes(s), false, `unbound board carries ${s}`);
  assert.ok(plain.includes('Illustrative only (no trace bound)') && plain.includes('tp-illus'));
  const bound = renderBoardHtml(EX1, { mutantLogs: [{ ruleId: 'no_double_booking', path: TLC_KILL }] });
  for (const s of ['Machine-extracted mutant trace', 'tr-steps', 'Trace-bound mutant kill']) assert.ok(bound.includes(s), s);
  assert.equal(CJK.test(bound), false, 'an English board with a trace stays CJK-free');
  const ja = renderBoardHtml(EX6, { mutantLogs: [{ ruleId: 'refund_cap', path: MUT('ja_mutant.log', `$ quint run m.qnt --invariant=refundsWithinEscrow\n${quintStates(2)}\n[violation] Found an issue.\n`) }] });
  for (const s of ['機械抽出した変異体の反例', '実反例ログ突合済み', '図解のみ（反例ログ未突合）']) assert.ok(ja.includes(s), s);
  assert.equal(uiSource(EX5), uiSource(EX5, {}), 'a board without traces gets the same copy as before');
});

test('bounds and witness: run.bounds is one escaped line above every view, tree-shaken without it; both are optional strings', () => {
  const x = '<img src=x onerror=alert(1)>';
  const b = withFlowEdit(EX1, (v) => { v.run.bounds = 'TLC depth 5 ' + x; v.rules[0].evidence.witness = '60/2000 traces ' + x; });
  const html = renderBoardHtml(b);
  expectPass(html);
  assert.ok(html.includes('<div class="pc-wrap pc-main"><p class="pc-bounds"><b>Bounded check</b>TLC depth 5 &lt;img src=x onerror=alert(1)&gt;</p>'), 'the SSR shell opens with the bounds line');
  assert.ok(html.includes('function boundsMarkup('));
  assert.equal(html.includes('<img src=x'), false);
  assert.ok(html.includes("e.witness ? kv(L.witness, e.witness)"));
  for (const base of [EX0, EX1, EX5]) assert.equal(/pc-bounds|boundsMarkup/.test(renderBoardHtml(base)), false, base.runId);
  const flow = withFlowEdit(EX5, (v) => { v.run.bounds = 'Alloy scope 5 · Quint 5 steps · TLC depth 4'; });
  assert.ok(renderBoardHtml(flow, ex5Evidence()).includes('<p class="pc-bounds"><b>Bounded check</b>Alloy scope 5'));
  schemaErr(withFlowEdit(EX1, (v) => { v.run.bounds = ' '; }), '$.run.bounds');
  schemaErr(withFlowEdit(EX1, (v) => { v.rules[0].evidence.witness = 3; }), '$.rules[0].evidence.witness');
  assert.ok(hasWarning(validateBoardData(withFlowEdit(EX1, (v) => { v.run.bounds = 'x'.repeat(121); })), '$.run.bounds'));
  assert.deepEqual(validateBoardData(b).warnings, []);
});

test('mutant-log: a passing run before the failing one never leaks into the trace; two failing runs or a restarted trace fail closed', () => {
  const pass = '$ quint run m.qnt --invariant=NonNegative\nAn example execution:\n\n[State 0] { n: 0 }\n\n[State 1] { n: 1 }\n\n[State 2] { n: 2 }\n\n[ok] No violation found (18ms).\n';
  const kill = '$ quint run m.qnt --invariant=NoOverlappingBookings\nAn example execution:\n\n[State 0] { n: 0 }\n\n[State 1] { n: 7 }\n\n[violation] Found an issue (66ms).\nerror: Invariant violated\n';
  const t = traceOf(MUT('quint_concat.log', pass + kill));
  assert.deepEqual([t.violatedProperty, t.stepCount, t.steps], ['NoOverlappingBookings', 2, ['State 0: n = 0', 'State 1: n = 7']]);
  const tlcPass = '$ java tlc2.TLC -config P.cfg M.tla\nTLC2 Version 2.19\nModel checking completed. No error has been found.\n9 states generated, 5 distinct states found.\n';
  assert.deepEqual(traceOf(MUT('tlc_concat.log', tlcPass + tlc('NoOverlappingBookings'))).steps, traceOf(TLC_KILL).steps);
  bindErr(() => bindOne(MUT('quint_two_kills.log', kill + kill)), /holds 2 failing runs; split the log/);
  bindErr(() => bindOne(MUT('quint_restart.log', kill.replace('[violation]', '[State 0] { n: 0 }\n\n[violation]'))), /more than one trace in its failing run; split the log/);
});

test('mutant-log: ITF binds only as a well-formed Quint trace; Apalache ITF and malformed traces are refused', () => {
  const base = JSON.parse(itf('violation'));
  const bad = (name, edit) => { const j = clone(base); edit(j); return MUT(name, JSON.stringify(j)); };
  bindErr(() => bindOne(bad('apalache.itf.json', (j) => { delete j['#meta'].status; j['#meta'].description = 'Created by Apalache'; })), /records no "#meta.status".*bind Apalache's stdout log/);
  bindErr(() => bindOne(bad('novars.itf.json', (j) => { delete j.vars; })), /non-empty "vars" array/);
  bindErr(() => bindOne(bad('blankvar.itf.json', (j) => { j.vars = ['']; })), /non-empty "vars" array/);
  bindErr(() => bindOne(bad('nostates.itf.json', (j) => { j.states = []; })), /"states" array whose states hold exactly/);
  bindErr(() => bindOne(bad('missing.itf.json', (j) => { delete j.states[1].s; })), /"states" array whose states hold exactly/);
  bindErr(() => bindOne(bad('extra.itf.json', (j) => { j.states[0].ghost = 1; })), /"states" array whose states hold exactly/);
  bindErr(() => bindOne(bad('scalar.itf.json', (j) => { j.states[0] = 3; })), /"states" array whose states hold exactly/);
  const forged = bindOne(ITF_KILL);
  forged.counterexamples.no_double_booking.checker = 'Apalache';
  assert.throws(() => validateBinding(EX1, forged), /invalid embedded mutant counterexample metadata/);
});

test('trace UI: only a property-matched kill earns the trace-bound pill; a property-less ITF trace says "Trace attached (property unnamed)"', () => {
  const pillOf = (board, mutantLogs, id) => {
    const html = renderBoardHtml(board, { mutantLogs });
    const binding = bindEvidence(board, { mutantLogs });
    const code = [/const hasTrace = [^\n]*/.exec(html)[0], /const tracePill = \(r\) => \{[\s\S]*?\n\s*\};/.exec(html)[0]].join('\n');
    const ctx = { BINDING: binding, L: uiFor(board, binding), esc: (x) => x };
    runInNewContext(code + '\nthis.out = tracePill({ id: ' + JSON.stringify(id) + ' });', ctx);
    return ctx.out;
  };
  const itfLog = [{ ruleId: 'no_double_booking', path: ITF_KILL }];
  assert.equal(pillOf(EX1, itfLog, 'no_double_booking'), '<span class="tp tp-unnamed">Trace attached (property unnamed)</span>');
  assert.equal(pillOf(EX1, itfLog, EX1.rules[1].id), '<span class="tp tp-illus">Illustrative only (no trace bound)</span>');
  assert.equal(pillOf(EX1, [{ ruleId: 'no_double_booking', path: TLC_KILL }], 'no_double_booking'), '<span class="tp tp-bound">Trace-bound mutant kill</span>');
  assert.equal(pillOf(EX6, [{ ruleId: 'refund_cap', path: ITF_KILL }], 'refund_cap'), '<span class="tp tp-unnamed">反例添付（性質名なし）</span>');
  assert.equal(renderBoardHtml(EX1, { mutantLogs: itfLog }).includes('.tp.tp-unnamed{'), true);
  assert.equal(renderBoardHtml(EX1).includes('tp-unnamed'), false, 'boards without traces do not carry the unnamed pill');
});

test('mutant-log: Alloy 6.2.0 "SAT expects=0" binds, "UNSAT expects=0" is not a kill; quoted paths with spaces keep only their last segment', () => {
  const a = traceOf(MUT('alloy_expects.log', '00. check NoOverlappingBookings   1/1     SAT expects=0\n'));
  assert.deepEqual([a.checker, a.violatedProperty, a.steps], ['Alloy', 'NoOverlappingBookings', ['00. check NoOverlappingBookings 1/1 SAT expects=0']]);
  bindErr(() => bindOne(MUT('alloy_expects_unsat.log', '00. check NoOverlappingBookings   1/1     UNSAT expects=0\n')), /reports no violation/);
  const states = (n) => `[State ${n}] { log: "/Users/foo/Library/Application Support/x/run.log", model: "/Users/Example Person/private/model.qnt", n: ${n} }\n\n`;
  const q = traceOf(MUT('quint_space.log', '$ quint run m.qnt --invariant=NoOverlappingBookings\n' + states(0) + states(1) + '[violation] Found an issue.\n'));
  assert.deepEqual(q.steps, ['State 0: log = "…/run.log"; model = "…/model.qnt"; n = 0', 'State 1: n = 1']);
  const t = traceOf(MUT('tlc_space.log', tlc('NoOverlappingBookings').replaceAll('"C:\\\\work\\\\run.txt"', "'C:\\\\Users\\\\Example Person\\\\run log.txt'")));
  assert.equal(t.steps[0], "State 1 · Initial predicate: bookings = {}; log = '…/run log.txt'");
});

// ---------------------------------------------------------------------------------------------
// state and timeline figures (example 07)
// ---------------------------------------------------------------------------------------------
const EX7 = load('07_state_timeline/state_timeline_ja.board.json');
const EX7_DIR = join(ROOT, 'examples', '07_state_timeline');
const ex7Mutants = () => [['refresh_reuse', 'mutant_reuse_rotated_accepted.log'], ['code_ttl', 'mutant_off_by_one_ttl.log'], ['replay_revoke', 'mutant_tlc_replay_compromised_no_revoke.log']]
  .map(([ruleId, f]) => ({ ruleId, path: join(EX7_DIR, f) }));
const STM_RULE = 0;
const TL_RULE = 1;
const editRule = (i, f) => { const b = clone(EX7); f(b.rules[i]); return b; };

test('example 07: state and timeline rules bind three real mutant logs with 0 errors, 0 warnings, under budget', () => {
  assert.deepEqual([validateBoardData(EX7).errors, validateBoardData(EX7).warnings], [[], []]);
  const flags = ex7Mutants().flatMap((m) => ['--mutant-log', m.ruleId + '=' + m.path]);
  const input = join(EX7_DIR, 'state_timeline_ja.board.json');
  for (const mode of ['standalone', 'embed']) {
    const out = join(TMP, `07-${mode}.html`);
    const r = node('render_board.mjs', ['--in', input, ...flags, '--mode', mode, '--out', out]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    const v = node('validate_board.mjs', ['--in', input, ...flags, out]);
    assert.equal(v.status, 0, v.stdout + v.stderr);
    assert.equal(/WARN|ERR/.test(v.stdout), false, v.stdout);
    assert.ok(readFileSync(out).length <= 128 * 1024);
  }
  const traces = bindEvidence(EX7, { mutantLogs: ex7Mutants() }).counterexamples;
  assert.deepEqual(Object.values(traces).map((c) => [c.checker, c.violatedProperty, c.stepCount]),
    [['Quint', 'inv_no_expired_code_redeem', 12], ['Quint', 'inv_refresh_reuse_revokes_family', 11], ['TLC', 'InvRevokeOnReplay', 5]]);
  for (const c of Object.values(traces)) for (const step of c.steps) assert.equal(/\/Users|\/private|masaya/.test(step), false, step);
});

test('state: every state draws one anchor, transitions end on box borders, a forbidden pill holds its circled x', () => {
  for (const i of [0, 2]) {
    const r = EX7.rules[i];
    const g = stmLayout(r);
    for (const x of g.edges) {
      if (x.e.from === x.e.to) continue;
      for (const [pt, id] of [[x.p[0], x.e.from], [x.p[3], x.e.to]]) {
        const n = g.nodes[id];
        const inside = pt[0] > n.x && pt[0] < n.x + n.w && pt[1] > n.y && pt[1] < n.y + n.h;
        const d = Math.hypot(Math.max(n.x - pt[0], 0, pt[0] - n.x - n.w), Math.max(n.y - pt[1], 0, pt[1] - n.y - n.h));
        assert.ok(!inside && d <= 2.5, `${r.id} ${x.e.id} endpoint is ${inside ? 'inside' : d.toFixed(1) + ' away from'} ${id}`);
      }
    }
    for (const k of STATES) {
      const svg = figSvg(r, r.states[k], 'u', true);
      assert.equal(anchors(svg), 1, `${r.id}/${k}`);
      assert.equal(/NaN|undefined/.test(svg), false);
    }
  }
  const r = EX7.rules[STM_RULE];
  const bug = figSvg(r, r.states.bug, 'u', true);
  const pill = bug.match(/data-tr="accept_old" class="fg-arrow is-forbid is-on is-here">[^]*?<rect class="fg-apill" x="([\d.]+)" y="[\d.]+" width="([\d.]+)"[^]*?<g class="fg-x"><circle cx="([\d.]+)"/);
  assert.ok(pill, 'the forbidden self-transition is drawn with its x');
  assert.ok(Number(pill[3]) - 6 >= Number(pill[1]) && Number(pill[3]) + 6 <= Number(pill[1]) + Number(pill[2]), 'the x sits inside its pill');
  assert.ok(bug.includes('marker-end="url(#fg-hb-u)"'));
  assert.ok(figSvg(r, r.states.fixed, 'u', true).includes('data-tr="revive" class="fg-arrow is-forbid is-on is-blocked"'), 'the fix blocks the forbidden revive');
  assert.ok(figSvg(r, r.states.fixed, 'u', true).includes('marker-end="url(#fg-hs-u)"'));
  const loop = EX7.rules[2];
  assert.ok(figSvg(loop, loop.states.bug, 'u', true).includes('class="fg-arrow is-loop is-on is-here"'), 'a loop in the bug state is drawn hot (red)');
  assert.ok(figSvg(loop, { ...loop.states.bug, tone: 'normal' }, 'u', true).includes('is-loop is-amber is-on'));
  assert.ok(bug.includes('<circle class="fg-start"') && figSvg(r, r.states.fixed, 'u', true).includes('<rect class="fg-inner"'), 'initial dot and terminal double border');
});

test('state: a two-state machine with a two-way pair and a forbidden self-loop fits; label collisions warn', () => {
  const b = editRule(STM_RULE, (r) => {
    r.figure.states = [{ id: 'open', label: 'Open', role: 'initial' }, { id: 'closed', label: 'Closed', role: 'terminal' }];
    r.figure.transitions = [{ id: 'close', from: 'open', to: 'closed', label: 'close' }, { id: 'reopen', from: 'closed', to: 'open', label: 'reopen', kind: 'forbidden' },
      { id: 'spin', from: 'open', to: 'open', label: 'retry', kind: 'loop' }];
    for (const st of Object.values(r.states)) { st.activeStates = ['open', 'closed']; st.activeTransitions = ['close', 'reopen']; st.focusTransition = 'reopen'; st.chips = [{ state: 'closed', text: 'final', tone: 'good' }]; }
  });
  assert.deepEqual(validateBoardData(b).warnings, []);
  const g = stmLayout(b.rules[STM_RULE]);
  const [p, q] = g.edges.slice(0, 2).map((x) => pillBox(x.cx, x.cy, x.fit));
  assert.ok(p.y + p.h <= q.y || q.y + q.h <= p.y, 'the two directions of a pair keep their labels apart');
  const crowded = editRule(STM_RULE, (r) => { r.figure.transitions[2].label = 'stolen generation-one token accepted again and again'; });
  assert.ok(validateBoardData(crowded).warnings.some((w) => w.startsWith(`$.rules[${STM_RULE}].figure.transitions[2].label`)), validateBoardData(crowded).warnings.join('\n'));
});

test('state: invalid states, transitions and state references are errors', () => {
  const p = `$.rules[${STM_RULE}]`;
  const e = (f) => editRule(STM_RULE, f);
  schemaErr(e((r) => { r.figure.states = r.figure.states.slice(0, 1); }), `${p}.figure.states`);
  schemaErr(e((r) => { r.figure.transitions = []; }), `${p}.figure.transitions`);
  schemaErr(e((r) => { r.figure.states[0].role = 'start'; }), `${p}.figure.states[0].role`);
  schemaErr(e((r) => { r.figure.transitions[0].to = 'ghost'; }), `${p}.figure.transitions[0].to`);
  schemaErr(e((r) => { r.figure.transitions[0].kind = 'maybe'; }), `${p}.figure.transitions[0].kind`);
  schemaErr(e((r) => { r.figure.transitions[0].to = r.figure.transitions[0].from; }), `${p}.figure.transitions[0]`);
  schemaErr(e((r) => { r.figure.transitions.push({ id: 'again', from: 'active', to: 'rotated', label: 'x' }); }), `${p}.figure.transitions[4]`);
  schemaErr(e((r) => { r.states.bug.activeStates = []; }), `${p}.states.bug.activeStates`);
  schemaErr(e((r) => { r.states.bug.activeTransitions = ['ghost']; }), `${p}.states.bug.activeTransitions`);
  schemaErr(e((r) => { r.states.bug.focusTransition = 'ghost'; }), `${p}.states.bug.focusTransition`);
  schemaErr(e((r) => { r.states.bug.chips.push({ state: 'rotated', text: 'twice', tone: 'bad' }); }), `${p}.states.bug.chips[1].state`);
});

test('timeline: two events on one tick stack upward, the pin joins them, a fourth stacked event warns', () => {
  const r = EX7.rules[TL_RULE];
  const g = tlLayout(r);
  const [accept, reject] = [g.events[2], g.events[3]];
  assert.equal(accept.x, reject.x);
  assert.ok(reject.cy < accept.cy, 'the second event on a tick sits above the first');
  const a = pillBox(accept.cx, accept.cy, accept.fit);
  const q = pillBox(reject.cx, reject.cy, reject.fit);
  assert.ok(q.y + q.h <= a.y, 'stacked pills do not overlap');
  assert.ok(Math.abs(reject.pinTo - a.y) < 0.01, 'the upper pin ends on the lower pill');
  for (const k of STATES) assert.equal(anchors(figSvg(r, r.states[k], 'u', true)), 1);
  const worst = editRule(TL_RULE, (x) => {
    x.figure.ticks = ['a', 'b', 'c', 'd', 'e'].map((id, i) => ({ id, label: 't=' + i, ...(i === 3 ? { boundary: true } : {}) }));
    x.figure.bars = [{ id: 'b1', from: 'a', to: 'd', label: 'lease', tone: 'good' }, { id: 'b2', from: 'b', to: 'e', label: 'renewal', tone: 'bad' }, { id: 'b3', from: 'a', to: 'b', label: 'grace' }];
    x.figure.events = [{ id: 'e1', tick: 'd', label: 'expire' }, { id: 'e2', tick: 'd', label: 'renew', tone: 'good' }, { id: 'e3', tick: 'd', label: 'use', tone: 'bad' }, { id: 'e4', tick: 'a', label: 'grant' }];
    for (const st of Object.values(x.states)) { st.activeBars = ['b1', 'b2', 'b3']; st.activeEvents = ['e1', 'e2', 'e3', 'e4']; st.focusEvent = 'e3'; st.chips = [{ tick: 'd', text: 'now == exp', tone: 'bad' }]; }
  });
  assert.deepEqual(validateBoardData(worst).warnings, [], 'three bars, three stacked events and a chip fit');
  const fourth = clone(worst);
  fourth.rules[TL_RULE].figure.events[3].tick = 'd';
  assert.ok(validateBoardData(fourth).warnings.some((w) => /figure\.events\[3\]\.label.*fourth row/.test(w)), validateBoardData(fourth).warnings.join('\n'));
  const wide = clone(worst);
  wide.rules[TL_RULE].figure.ticks[1].label = 'renewal requested by the client application after expiry';
  assert.ok(validateBoardData(wide).warnings.some((w) => w.startsWith(`$.rules[${TL_RULE}].figure.ticks[1].label`)));
});

test('timeline: an event label wider than its box even at the minimum font size warns', () => {
  const wide = editRule(TL_RULE, (x) => { x.figure.events[0].label = 'Authorization code issued to the client'; });
  assert.ok(hasWarning(validateBoardData(wide), `$.rules[${TL_RULE}].figure.events[0].label: "Authorization code issued to the client" does not fit its 220-unit box`));
  assert.deepEqual(validateBoardData(EX7).warnings, []);
});

test('timeline: invalid ticks, bars, events and state references are errors', () => {
  const p = `$.rules[${TL_RULE}]`;
  const e = (f) => editRule(TL_RULE, f);
  schemaErr(e((r) => { r.figure.ticks = r.figure.ticks.slice(0, 1); }), `${p}.figure.ticks`);
  schemaErr(e((r) => { r.figure.ticks[2].boundary = 'yes'; }), `${p}.figure.ticks[2].boundary`);
  schemaErr(e((r) => { r.figure.bars[0].to = 't2'; }), `${p}.figure.bars[0]`);
  schemaErr(e((r) => { r.figure.bars[0].from = 'ghost'; }), `${p}.figure.bars[0].from`);
  schemaErr(e((r) => { r.figure.bars[0].tone = 'warn'; }), `${p}.figure.bars[0].tone`);
  schemaErr(e((r) => { r.figure.events[0].tick = 'ghost'; }), `${p}.figure.events[0].tick`);
  schemaErr(e((r) => { r.figure.events[0].tone = 'warn'; }), `${p}.figure.events[0].tone`);
  schemaErr(e((r) => { r.states.bug.activeEvents = []; }), `${p}.states.bug.activeEvents`);
  schemaErr(e((r) => { r.states.bug.focusEvent = 'ghost'; }), `${p}.states.bug.focusEvent`);
  schemaErr(e((r) => { r.states.bug.chips = [{ tick: 'ghost', text: 'x', tone: 'bad' }]; }), `${p}.states.bug.chips[0].tick`);
});

test('state and timeline: the runtime draws them exactly like the server; other boards ship none of their code or styles', () => {
  const ctx = {};
  runInNewContext(figureRuntime(['state', 'timeline']) + '\nthis.figSvg = figSvg;', ctx);
  for (const r of EX7.rules) for (const k of STATES) assert.equal(ctx.figSvg(r, r.states[k], 'b-' + r.id, true), figSvg(r, r.states[k], 'b-' + r.id, true), `${r.id}/${k}`);
  const markers = ['function stmSvg', 'function tlSvg', 'function tlLayout', 'const STM', 'const TL ', 'fg-start', 'fg-axis', 'fg-pindot', 'is-amber'];
  for (const b of [EX0, EX1, EX2, EX3, EX5, EX6]) {
    const html = renderBoardHtml(b);
    for (const m of markers) assert.equal(html.includes(m), false, `${b.runId} ships ${m}`);
  }
  const html = renderBoardHtml(EX7);
  for (const m of markers) assert.ok(html.includes(m), m);
  const stateOnly = renderBoardHtml(withFlowEdit(EX7, (b) => { b.rules.splice(TL_RULE, 1); }));
  assert.equal(/function tlSvg|fg-axis/.test(stateOnly), false, 'a board without a timeline ships no timeline code');
  assert.equal(figureRuntime(['relation']).includes('STM'), false, 'relation boards do not get the state slot table');
});

test('state and timeline: ids such as constructor, toString and __proto__ draw like any other id; every label is escaped', () => {
  const rename = (rule, map) => JSON.parse(Object.entries(map).reduce((t, [a, z]) => t.split('"' + a + '"').join('"' + z + '"'), JSON.stringify(rule)));
  const x = '<img src=x onerror=alert(1)>';
  const b = clone(EX7);
  b.rules[STM_RULE] = rename(b.rules[STM_RULE], { active: 'constructor', rotated: 'toString', revoked: '__proto__' });
  b.rules[TL_RULE] = rename(b.rules[TL_RULE], { t2: 'constructor', t4: '__proto__', accept: 'toString' });
  b.rules[STM_RULE].figure.states[0].label = x;
  b.rules[TL_RULE].figure.events[0].label = x;
  b.rules[TL_RULE].figure.ticks[0].label = x;
  assert.deepEqual(validateBoardData(b).errors, []);
  for (const i of [STM_RULE, TL_RULE]) {
    for (const [k, st] of Object.entries(b.rules[i].states)) {
      const svg = figSvg(b.rules[i], st, 'u', true);
      assert.equal(/NaN|undefined|<img/.test(svg), false, `${b.rules[i].id}/${k}`);
      assert.equal((svg.match(/class="fg-chip /g) || []).length, (st.chips || []).length);
    }
  }
  assert.ok(figSvg(b.rules[STM_RULE], b.rules[STM_RULE].states.bug, 'u', true).includes('&lt;img'));
  const html = renderBoardHtml(b);
  expectPass(html);
  assert.equal(html.includes('<img src=x'), false);
});

rmSync(TMP, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
for (const r of results) process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : `\n     ${r.msg.replace(/\n/g, '\n     ')}`}\n`);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length ? 1 : 0);
