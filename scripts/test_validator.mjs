#!/usr/bin/env node
// Self-tests for the proof-canvas renderer and gates. Each negative case breaks exactly one
// thing and asserts that the gate fails *for that reason* (by error prefix), not merely that
// it exits non-zero. Run: node scripts/test_validator.mjs   (exit 0 = all pass)

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { GZIP_TYPE, JSON_TYPE, MAX_DECODED_BYTES, MAX_PAYLOAD_TEXT_BYTES, decodePayload, encodePayload, findPayloads } from './payload.mjs';
import { GEOM, layoutBoxLabel, textW } from './figure.mjs';
import { ALL_MODULES, modParts, provLabel, renderBoardHtml, toolLabel } from './render_board.mjs';
import { SAFE_ID, isRealHash, layoutFor, resolveProvenance, splitRendererKeys, validateBoardData } from './schema.mjs';
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

// A board with a real spec hash and no declared provenance: the badge is computed from statuses.
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
  const skill = readFileSync(join(ROOT, 'SKILL.md'), 'utf8');
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
test('provenance: real hash and every rule verified resolves to verified', () => {
  const b = realRun();
  assert.equal(resolveProvenance(b).kind, 'verified');
  const r = expectPass(renderBoardHtml(b));
  assert.equal(r.provenance, 'verified');
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
  assert.equal(provLabel(p), '1 failed · 11/12 verified');
  const html = renderBoardHtml(b);
  assert.equal(expectPass(html).provenance, 'failed');
  assert.ok(html.includes('1 failed · 11/12 verified'));
});
test('provenance: a run failure without a failed rule still resolves to failed', () => {
  const b = realRun();
  b.run.status = 'failed';
  const p = resolveProvenance(b);
  assert.equal(p.kind, 'failed');
  assert.match(provLabel(p), /^Run failed · 20\/20 verified$/);
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
  assert.equal(provLabel(p), 'Unverified (20/20)');
  const html = renderBoardHtml(b);
  assert.equal(expectPass(html).provenance, 'unverified');
  assert.equal(footerNote(html), '20 of 20 rules are marked verified, but the board is declared unverified.');
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
test('schema: a module whose id is "all" is legal and never collides with the all-modules filter', () => {
  assert.equal(SAFE_ID.test(ALL_MODULES), false);
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
test('render: a module title that starts with "M1" is not prefixed twice', () => {
  assert.deepEqual(modParts({ title: 'M2 · Disputes' }, 1), { tag: 'M2', title: 'Disputes' });
  assert.deepEqual(modParts({ title: 'Disputes' }, 1), { tag: 'M2', title: 'Disputes' });
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

rmSync(TMP, { recursive: true, force: true });
const failed = results.filter((r) => !r.ok);
for (const r of results) process.stdout.write(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.ok ? '' : `\n     ${r.msg.replace(/\n/g, '\n     ')}`}\n`);
process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length ? 1 : 0);
