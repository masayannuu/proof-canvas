#!/usr/bin/env node
// Deterministic synthetic board generator for scale tests (e.g. 50 rules x 10 modules, 100 x 20).
// Output is always declared provenance "sample": it is benchmark data, never verification output.
// Zero dependencies: Node 22+ standard-library ESM only.

import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const USAGE = `Usage:
  node scripts/synth_board.mjs --rules <n> --modules <m> --out <board.json>
       [--failed <k>] [--unverified <k>] [--seed <int>]
  --unverified sets how many rules have status "pending" (not checked yet).
`;

// mulberry32: tiny deterministic PRNG
function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// [module id, module title, entity (singular, lower case), module summary]
const DOMAINS = [
  ['billing', 'Billing', 'invoice', 'Issue, correct and void invoices without amount drift.'],
  ['inventory', 'Inventory', 'stock item', 'Keep stock counts right through receipts and reservations.'],
  ['orders', 'Orders', 'order', 'Move orders from placed to fulfilled or cancelled safely.'],
  ['payments', 'Payments', 'payment', 'Authorize, capture and refund in the right order and amount.'],
  ['shipping', 'Shipping', 'shipment', 'Prevent mix-ups between picking, packing and dispatch.'],
  ['accounts', 'Accounts', 'account', 'Protect sign-in, suspension and closure of user accounts.'],
  ['roles', 'Roles', 'role grant', 'Least-privilege control over who may change what.'],
  ['notify', 'Notifications', 'notice', 'No duplicate, missing or misaddressed notifications.'],
  ['points', 'Loyalty points', 'point grant', 'Keep balances right through earn, spend and expiry.'],
  ['coupons', 'Coupons', 'coupon', 'Honour coupon conditions, limits and expiry.'],
  ['refunds', 'Refunds', 'refund', 'Keep refund amounts and counts within the original charge.'],
  ['slots', 'Time slots', 'slot', 'Never double-book a slot or exceed its capacity.'],
  ['attendance', 'Attendance', 'time entry', 'Keep clock-in order and lock entries after payroll close.'],
  ['expenses', 'Expenses', 'claim', 'Submit, approve and pay claims in order and within limits.'],
  ['contracts', 'Contracts', 'contract', 'Track versions and approvals of signed contracts.'],
  ['audit', 'Audit log', 'audit record', 'Every change leaves an append-only record.'],
  ['privacy', 'Personal data', 'data record', 'Deleted personal data is never read or restored.'],
  ['search', 'Search index', 'index entry', 'Updates and deletions reach search results correctly.'],
  ['plans', 'Plans', 'subscription', 'Plan changes and proration stay consistent.'],
  ['support', 'Support desk', 'ticket', 'Assignment, deadlines and closure follow the workflow.'],
];

// Ten invariant archetypes. {E} = the module's entity.
const ARCH = [
  { slug: 'no_double', title: 'Each {E} request takes effect once', short: 'No double effect', cat: 'safety',
    boxes: ['{E} request', 'Processed log', 'Duplicate check', 'Apply once', 'Return prior result', 'Applied twice'], a: ['request id', 'processed'],
    inN: 'id a1 (first)', ctxN: 'no record', inB: 'id a1 (retry)', ctxBug: 'checked on receipt', ctxFix: 'a1 processed', gateBug: 'misses in-flight', gateFix: 'check at commit', badChip: 'two {E}s', exitChip: 'prior result',
    keys: ['Request id', 'Delivery', 'Effects'], vN: ['a1', 'first', '1'], vB: ['a1', 'retry after timeout', '2'], vF: ['a1', 'retry after timeout', '1 (prior result)'],
    takeN: 'A first request for this {E} is applied exactly once.', takeB: 'A retry after a timeout applies the same {E} twice.', takeF: 'A retry with the same request id returns the prior result; still one {E}.',
    rule: 'A {E} request with a given id has the effect of one request, however often it is sent.', story: 'The duplicate check runs only on receipt, so an in-flight retry slips through and applies twice.', edgeB: 'Twice', edgeF: 'Same result' },
  { slug: 'within_limit', title: 'A {E} stays within its limit', short: 'Within limit', cat: 'boundary',
    boxes: ['{E} amount', 'Configured limit', 'Limit check', 'Accept', 'Show over-limit', 'Accept over limit'], a: ['amount', 'limit 10'],
    inN: '10 units', ctxN: 'limit 10', inB: '11 units', ctxBug: 'global maximum', ctxFix: 'limit 10', gateBug: 'global max', gateFix: 'own limit', badChip: '11 > 10', exitChip: 'over limit',
    keys: ['Plan', 'Amount', 'Decision'], vN: ['standard', '10', 'at limit: accept'], vB: ['standard', '11', 'max 20: accepted'], vF: ['standard', '11', 'over 10: rejected'],
    takeN: 'Ten units is exactly at the limit, so the {E} is accepted.', takeB: 'The check compares against the global maximum, so 11 units pass a limit of 10.', takeF: 'Anything above the {E} limit stops at the gate.',
    rule: 'An accepted {E} always satisfies 0 <= amount <= its own limit.', story: 'The limit check reads the global maximum instead of the per-{E} limit.', edgeB: 'Over limit', edgeF: 'Rejected' },
  { slug: 'owner_only', title: 'Only the owner may change a {E}', short: 'Owner only', cat: 'security',
    boxes: ['Change request', '{E} owner', 'Permission check', 'Apply change', 'Show not allowed', 'Changed by other'], a: ['actor', 'owner'],
    inN: 'owner edits', ctxN: 'own {E}', inB: 'teammate edits', ctxBug: 'same org is enough', ctxFix: 'not the owner', gateBug: 'checks org only', gateFix: 'owner or admin', badChip: 'edited by other', exitChip: 'not allowed',
    keys: ['Actor', 'Owner', 'Decision'], vN: ['ana', 'ana', 'owner: allowed'], vB: ['ben', 'ana', 'same org: allowed'], vF: ['ben', 'ana', 'not owner: denied'],
    takeN: 'The owner edits their own {E}, so the change goes through.', takeB: 'Anyone in the same organization can overwrite the {E}.', takeF: 'Changes by anyone but the owner or an admin are denied.',
    rule: 'A {E} can be changed only by its owner, a delegate, or an admin.', story: 'The permission check compares organizations only.', edgeB: 'Unauthorized', edgeF: 'Denied' },
  { slug: 'not_after_expiry', title: 'An expired {E} cannot be confirmed', short: 'Expiry', cat: 'boundary',
    boxes: ['Confirm request', '{E} expiry', 'Expiry check', 'Confirm', 'Show expired', 'Confirmed late'], a: ['confirm time', 'expires 10:10'],
    inN: 'at 10:09', ctxN: 'expires 10:10', inB: 'at 10:10', ctxBug: 'uses <=', ctxFix: 'expires 10:10', gateBug: 'time <= expiry', gateFix: 'time < expiry', badChip: 'confirmed at expiry', exitChip: 'expired',
    keys: ['Expiry', 'Confirm at', 'Decision'], vN: ['10:10', '10:09', 'in time: confirm'], vB: ['10:10', '10:10', '<= passes'], vF: ['10:10', '10:10', 'expired: rejected'],
    takeN: 'Confirming at 10:09 is before the 10:10 expiry, so it passes.', takeB: 'A confirm at exactly 10:10 passes and races the expiry job.', takeF: 'A confirm at the expiry instant is rejected as expired.',
    rule: 'A {E} at or past its expiry never moves to confirmed.', story: 'The expiry check uses <=, so a confirm at the exact expiry passes.', edgeB: 'Off by one', edgeF: 'Rejected' },
  { slug: 'audit_complete', title: 'Every {E} change is audited', short: 'Audit trail', cat: 'security',
    boxes: ['{E} change', 'Audit log', 'Audit check', 'Commit change', 'Roll back', 'Unaudited change'], a: ['change', 'append-only'],
    inN: 'create', ctxN: '+1 entry', inB: 'update', ctxBug: 'updates skipped', ctxFix: '+1 entry', gateBug: 'logs create only', gateFix: 'logs every change', badChip: 'no record', exitChip: 'who, when, what',
    keys: ['Operation', 'Audit entries', 'Erasable'], vN: ['create', '+1', 'no'], vB: ['update', '+0', 'n/a'], vF: ['update', '+1', 'no'],
    takeN: 'Creating a {E} appends one audit entry before commit.', takeB: 'Updates leave no audit entry, so nobody can tell who changed the {E}.', takeF: 'Every change appends who, when and what, and the entry cannot be erased.',
    rule: 'Every change to a {E} writes one append-only audit record in the same transaction.', story: 'The update path skips the audit write.', edgeB: 'No record', edgeF: 'Recorded', exit: 'pass' },
  { slug: 'forward_only', title: 'A {E} never moves backwards', short: 'Forward only', cat: 'safety',
    boxes: ['State change', 'Current state', 'Transition check', 'Apply transition', 'Reject transition', 'State reversed'], a: ['next state', 'done'],
    inN: 'open to done', ctxN: 'open', inB: 'done to open', ctxBug: 'no transition table', ctxFix: 'already done', gateBug: 'allows any move', gateFix: 'transition table', badChip: 'done reopened', exitChip: 'not allowed',
    keys: ['Current', 'Requested', 'Decision'], vN: ['open', 'done', 'forward: ok'], vB: ['done', 'open', 'backward: passed'], vF: ['done', 'open', 'invalid: rejected'],
    takeN: 'Moving an open {E} to done is a forward step, so it passes.', takeB: 'A done {E} reopens, and follow-up jobs run a second time.', takeF: 'Moves not in the transition table are rejected.',
    rule: 'A {E} only moves forward along the transition table and never leaves a final state.', story: 'The state change ignores the transition table, so a final {E} reopens.', edgeB: 'Reversed', edgeF: 'Rejected' },
  { slug: 'non_negative', title: 'A {E} balance never goes negative', short: 'Non-negative', cat: 'concurrency',
    boxes: ['Reserve request', 'Current balance', 'Balance check', 'Reserve', 'Show insufficient', 'Balance below zero'], a: ['need 3', 'left 2'],
    inN: 'need 2', ctxN: 'left 2', inB: 'need 3', ctxBug: 'stale read', ctxFix: 'left 2', gateBug: 'stale value', gateFix: 'check at commit', badChip: 'balance -1', exitChip: 'insufficient',
    keys: ['Balance', 'Requested', 'After'], vN: ['2', '2', '0'], vB: ['2', '3', '-1'], vF: ['2', '3', 'insufficient'],
    takeN: 'Reserving 2 of 2 is exactly at the boundary, so it succeeds.', takeB: 'Two concurrent reservations both read the stale balance and drive it below zero.', takeF: 'The balance is rechecked at commit, so the second reservation is refused.',
    rule: 'A {E} balance is always >= 0 and reservations never exceed what is available.', story: 'The balance check uses a stale read, so concurrent reservations overdraw.', edgeB: 'Negative', edgeF: 'Refused' },
  { slug: 'tenant_isolation', title: 'A {E} stays inside its tenant', short: 'Tenant isolation', cat: 'security',
    boxes: ['Admin action', '{E} tenant', 'Tenant check', 'Perform action', 'Hidden, denied', 'Cross-tenant action'], a: ['actor', 'other tenant'],
    inN: 'own tenant', ctxN: 'same tenant', inB: 'other tenant', ctxBug: 'admins may act', ctxFix: 'other tenant', gateBug: 'checks role only', gateFix: 'same tenant only', badChip: 'crossed tenant', exitChip: 'out of scope',
    keys: ['Actor', '{E} tenant', 'Decision'], vN: ['org2 admin', 'org2', 'same: allowed'], vB: ['org2 admin', 'org1', 'admin: allowed'], vF: ['org2 admin', 'org1', 'other: denied'],
    takeN: 'An admin acts on a {E} in their own tenant, so it passes.', takeB: 'Being an admin is enough to act on another tenant’s {E}.', takeF: 'A {E} in another tenant is neither listed nor actionable.',
    rule: 'Every {E} action succeeds only when the actor and the {E} share a tenant.', story: 'The tenant check looks at the role only.', edgeB: 'Crossed', edgeF: 'Blocked' },
  { slug: 'no_read_after_delete', title: 'A deleted {E} is never returned', short: 'Read after delete', cat: 'privacy',
    boxes: ['Read request', 'Deletion log', 'Deletion check', 'Return content', 'Show deleted', 'Served after delete'], a: ['read', 'deleted'],
    inN: 'live {E}', ctxN: 'not deleted', inB: 'deleted {E}', ctxBug: 'reads cache', ctxFix: 'deleted', gateBug: 'returns cache', gateFix: 'checks deletions', badChip: 'shown after delete', exitChip: 'deleted',
    keys: ['Target', 'Deleted', 'Response'], vN: ['#31', 'no', 'content'], vB: ['#31', 'yes', 'cached copy'], vF: ['#31', 'yes', '410 Gone'],
    takeN: 'The {E} has not been deleted, so its content is returned.', takeB: 'After deletion the cache still serves the {E}.', takeF: 'The deletion log is checked first, so a deleted {E} is never served.',
    rule: 'Once a {E} deletion commits, no path returns its content.', story: 'The read path prefers the cache and serves deleted data.', edgeB: 'Leaked', edgeF: 'Blocked' },
  { slug: 'no_lost_update', title: 'Concurrent {E} edits are not lost', short: 'No lost update', cat: 'concurrency',
    boxes: ['Save from old tab', 'Latest version', 'Version compare', 'Save', 'Show 409 Conflict', 'Overwrites edit'], a: ['version v1', 'latest v2'],
    inN: 'saves v2', ctxN: 'latest v2', inB: 'saves v1', ctxBug: 'no compare', ctxFix: 'latest v2', gateBug: 'last write wins', gateFix: 'detects v1 != v2', badChip: 'edit lost', exitChip: '409 Conflict',
    keys: ['Saved from', 'Latest', 'Result'], vN: ['v2', 'v2', 'saved'], vB: ['v1 (old tab)', 'v2', 'overwritten'], vF: ['v1 (old tab)', 'v2', '409'],
    takeN: 'Saving from the latest version simply commits.', takeB: 'A save from an old tab silently overwrites someone else’s {E} edit.', takeF: 'A stale save gets 409 Conflict and the user reloads the latest version.',
    rule: 'A {E} save succeeds only if it was read at the latest version.', story: 'Saves never compare versions, so the last write wins.', edgeB: 'Overwrite', edgeF: '409' },
];

// "{E}" is the entity noun; "A {E}" / "a {E}" pick "An" / "an" before a vowel sound.
const fill = (s, E) => String(s)
  .replace(/\b([Aa]) \{E\}/g, (_, a) => `${/^[aeiou]/i.test(E) ? `${a}n` : a} ${E}`)
  .split('{E}').join(E);

function makeRule({ no, dom, arch, status, rnd }) {
  const [modId, , E] = dom;
  const f = (s) => fill(s, E);
  const prop = `inv_${modId}_${arch.slug}`;
  const live = arch.exit === 'pass';
  const exit = live ? 'pass' : 'hold';
  const depth = 3 + Math.floor(rnd() * 14);
  const states = 60 + Math.floor(rnd() * 1800);
  const rows = (vals, last) => arch.keys.map((k, i) => ({ k: f(k), v: f(vals[i]), tone: i === arch.keys.length - 1 ? last : 'normal' }));
  // Random-valued state dump so per-rule bytes and gzip ratio resemble real checker output.
  const r9 = () => Math.floor(rnd() * 9999);
  const stateDump = `{ ${modId}: Map(${Array.from({ length: 5 }, (_, i) => `${i} -> { id: ${r9()}, owner: "user${r9()}", qty: ${r9()}, status: "${['ACTIVE', 'DONE', 'HELD', 'CANCELED', 'PENDING'][Math.floor(rnd() * 5)]}", version: ${r9()}, updatedAt: ${r9()}, ref: "${r9().toString(36)}${r9().toString(36)}" }`).join(', ')}), now: ${depth}, pending: Set(${r9()}, ${r9()}), lastActor: "user${r9()}" }`;
  const checker = status === 'verified' ? `No violation in ${states} states (sample)`
    : status === 'failed' ? `Counterexample at depth ${depth} (sample)` : 'Not run yet';
  return {
    id: `${modId}_${arch.slug}`,
    no,
    moduleId: modId,
    short: f(arch.short),
    title: f(arch.title),
    property: prop,
    category: arch.cat,
    source: rnd() < 0.5 ? `Requirements section ${1 + Math.floor(rnd() * 9)}` : 'Synthetic requirement',
    previewTitle: `${dom[1]} screen`,
    figure: {
      boxes: Object.fromEntries(['src1', 'src2', 'gate', 'pass', 'hold', 'bad'].map((k, i) => [k, f(arch.boxes[i])])),
      arrows: { a1: f(arch.a[0]), a2: f(arch.a[1]), a3: 'pass', a4: live ? 'roll back' : 'block', a5: 'unchecked' },
    },
    states: {
      normal: {
        label: 'Normal', tone: 'normal', route: ['a1', 'a2', 'a3'], here: 'pass', edgeShort: 'Accepted',
        chips: [{ box: 'src1', text: f(arch.inN), tone: 'neutral' }, { box: 'src2', text: f(arch.ctxN), tone: 'good' }, { box: 'gate', text: f(arch.gateFix), tone: 'good' }, { box: 'pass', text: 'accepted', tone: 'good' }],
        takeaway: f(arch.takeN),
        preview: { statusBadge: 'Normal', rows: rows(arch.vN, 'ok'), alert: 'All conditions hold, so the action goes through.', buttonLabel: f(arch.boxes[3]), buttonKind: 'ok',
          logLines: [`check --invariant=${prop}`, status === 'pending' ? 'not run yet' : '[ok] no violation found'] },
      },
      bug: {
        label: 'Bug', tone: 'bug', route: ['a1', 'a5'], here: 'bad', edgeShort: f(arch.edgeB),
        chips: [{ box: 'src1', text: f(arch.inB), tone: 'neutral' }, { box: 'src2', text: f(arch.ctxBug), tone: 'bad' }, { box: 'gate', text: f(arch.gateBug), tone: 'bad' }, { box: 'bad', text: f(arch.badChip), tone: 'bad' }],
        takeaway: f(arch.takeB),
        preview: { statusBadge: 'Violation', rows: rows(arch.vB, 'bad'), alert: `Without the rule: ${f(arch.edgeB).toLowerCase()}.`, buttonLabel: `${f(arch.boxes[3])} (unsafe)`, buttonKind: 'danger',
          logLines: [`check --invariant=${prop} --variant=bug`, `${prop} = false at depth ${depth}`] },
      },
      fixed: {
        label: 'Fixed', tone: 'safe', route: live ? ['a1', 'a2', 'a3'] : ['a1', 'a2', 'a4'], here: exit, edgeShort: f(arch.edgeF),
        chips: [{ box: 'src1', text: f(arch.inB), tone: 'neutral' }, { box: 'src2', text: f(arch.ctxFix), tone: 'neutral' }, { box: 'gate', text: f(arch.gateFix), tone: 'good' }, { box: exit, text: f(arch.exitChip), tone: 'good' }],
        takeaway: f(arch.takeF),
        preview: { statusBadge: live ? 'Accepted' : 'Blocked', rows: rows(arch.vF, 'ok'), alert: f(arch.takeF), buttonLabel: f(arch.boxes[3]), buttonKind: live ? 'ok' : 'locked',
          logLines: [`${prop} ${status === 'failed' ? 'violated' : 'holds'}`, `explored ${states} states`] },
      },
    },
    defaultFocus: status === 'failed' ? 'bug' : 'fixed',
    status,
    evidence: {
      ruleSummary: f(arch.rule),
      ifEnforced: f(arch.takeF),
      ifNotEnforced: f(arch.story),
      checkerSummary: checker,
      scope: `${E} count <= 5, 3 users, time <= 6, up to 2 concurrent requests`,
      method: 'Synthetic benchmark data (not produced by a checker run)',
      ...(status === 'failed' ? { counterexample: [`$ check --invariant=${prop} --max-steps=20`, `violation at depth ${depth}`, 'final state (excerpt):', stateDump].join('\n') } : {}),
    },
  };
}

const isCount = (v) => Number.isInteger(v) && v >= 0;

export function synthBoard({ rules, modules, failed = 0, unverified = 0, seed = 1 }) {
  if (!Number.isInteger(rules) || rules < 1) throw new Error('--rules must be a positive integer');
  if (!Number.isInteger(modules) || modules < 1 || modules > DOMAINS.length) throw new Error(`--modules must be an integer in 1..${DOMAINS.length}`);
  if (!isCount(failed)) throw new Error('--failed must be a non-negative integer');
  if (!isCount(unverified)) throw new Error('--unverified must be a non-negative integer');
  if (!isCount(seed)) throw new Error('--seed must be a non-negative integer');
  if (modules > rules) throw new Error('--modules may not exceed --rules (every module needs a rule)');
  if (rules > modules * ARCH.length) throw new Error(`at most ${ARCH.length} rules per module (${modules * ARCH.length} for ${modules} modules)`);
  if (failed + unverified > rules) throw new Error('--failed + --unverified exceeds --rules');
  const rnd = prng(seed);

  // Deterministic status assignment: pick distinct indices for failed / pending.
  const order = Array.from({ length: rules }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const statusAt = new Array(rules).fill('verified');
  order.slice(0, failed).forEach((i) => { statusAt[i] = 'failed'; });
  order.slice(failed, failed + unverified).forEach((i) => { statusAt[i] = 'pending'; });

  const doms = DOMAINS.slice(0, modules);
  const perModule = doms.map((_, mi) => Math.floor(rules / modules) + (mi < rules % modules ? 1 : 0));
  const list = [];
  let no = 0;
  doms.forEach((dom, mi) => {
    for (let j = 0; j < perModule[mi]; j += 1) {
      const arch = ARCH[(mi + j * 3) % ARCH.length];
      list.push(makeRule({ no: no + 1, dom, arch, status: statusAt[no], rnd }));
      no += 1;
    }
  });

  const verified = rules - failed - unverified;
  return {
    version: 1,
    runId: `synthetic-${rules}rules-${modules}modules-seed${seed}`,
    title: `Synthetic benchmark: ${modules} modules, ${rules} rules`,
    subtitle: `Scale-test data (${failed} failed, ${unverified} not checked, ${verified} verified)`,
    generatedAt: '2026-11-26T00:00:00Z',
    provenance: 'sample',
    provenanceNote: 'Synthetic scale-test data. Statuses and counterexamples are generated deterministically; no checker was run.',
    run: { tool: 'Example checker', toolVersion: '1.0', status: failed ? 'failed' : unverified ? 'pending' : 'verified' },
    modules: doms.map(([id, title, , summary]) => ({ id, title, summary })),
    rules: list,
  };
}

// Strict integer parsing for CLI values ("3", not "3.5", "1e2", "" or "abc").
function intArg(name, v) {
  if (!/^-?\d+$/.test(v)) throw new Error(`${name} must be an integer (got "${v}")`);
  return Number(v);
}

function main() {
  const args = process.argv.slice(2);
  const opts = { rules: undefined, modules: undefined, failed: 0, unverified: 0, seed: 1, out: '' };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '-h' || a === '--help') { process.stdout.write(USAGE); process.exit(0); }
    const v = args[i + 1];
    if (v === undefined) throw new Error(`Missing value for ${a}`);
    if (a === '--out') opts.out = v;
    else if (['--rules', '--modules', '--failed', '--unverified', '--seed'].includes(a)) opts[a.slice(2)] = intArg(a, v);
    else throw new Error(`Unknown argument: ${a}`);
    i += 1;
  }
  if (!opts.out) throw new Error('--out <board.json> is required');
  const board = synthBoard(opts);
  mkdirSync(dirname(resolve(opts.out)), { recursive: true });
  writeFileSync(resolve(opts.out), `${JSON.stringify(board, null, 2)}\n`);
  process.stdout.write(`Wrote ${opts.out} (${board.rules.length} rules, ${board.modules.length} modules)\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try { main(); } catch (e) { process.stderr.write(`synth_board error: ${e.message}\n`); process.exit(1); }
}
