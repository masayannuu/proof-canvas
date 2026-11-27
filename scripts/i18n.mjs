// UI copy for the board chrome, one factory per language. A board ships only the factory of its
// own language: render_board.mjs injects its source with Function.prototype.toString, so an English
// board carries no Japanese text and the reverse. Each factory must stay self-contained (no
// references outside its own body) and its argument comes from uiOptions.

export const LANGS = ['en', 'ja'];

// Label overrides and flags a factory needs, read from a validated board.
export function uiOptions(board) {
  const lb = board && board.labels && typeof board.labels === 'object' ? board.labels : {};
  return { singular: lb.moduleSingular || '', plural: lb.modulePlural || '', overview: lb.overview || '', hasFlow: !!(board && board.flow) };
}

export function uiEn(o) {
  const singular = o.singular || 'module';
  const plural = o.plural || 'modules';
  const overview = o.overview || (o.hasFlow ? 'Flow' : 'Overview');
  const num = (n) => n.toLocaleString('en-US');
  const rules = (n) => n + (n === 1 ? ' rule' : ' rules');
  const ratio = (v, t) => v + '/' + t;
  return {
    lang: 'en', sep: ' ', err: 'This board could not be displayed: ', num,
    navRules: 'Rules', overview, viewAll: (n) => (o.hasFlow ? 'Overview' : overview) + ' (' + n + ')',
    compare: 'Compare',
    evTitle: 'Proof & log', evOpen: 'Show details', evClose: 'Hide details',
    rule: 'Rule', ifOn: 'If enforced', ifOff: 'If not enforced', quote: 'Source text', meta: 'Verification metadata',
    scope: 'Scope', method: 'Method', tool: 'Tool', binding: 'Spec & log binding', specHash: 'Spec hash', logHash: 'Log hash',
    steps: 'Steps checked', specSource: 'Spec source', witness: 'Witness hits', bounds: 'Bounded check', scopeChip: 'Scope',
    traceBound: 'Trace-bound mutant kill', traceIllus: 'Illustrative only (no trace bound)',
    cexTitle: 'Counterexample', cexOff: 'Counterexample without this rule', noCex: 'No counterexample recorded',
    ovHint: 'Click a card to open that rule',
    liveOk: (n) => 'Verified' + (n ? ' · ' + num(n) + ' steps checked' : ''), liveBad: 'Violation found', livePending: 'Not checked yet',
    toolbar: 'Filter rules', statusGroup: 'Status',
    status: { all: 'All', failed: 'Failed', verified: 'Verified', pending: 'Not checked' },
    noscript: { verified: 'Verified', failed: 'Failed', pending: 'Not checked yet' },
    rules: 'Rules', index: 'Toggle rule index',
    prev: 'Previous rule', next: 'Next rule', modulesN: plural, rulesN: 'rules', nFailed: (n) => n + ' failed',
    hubHint: 'Click a number to open that rule', hubOpen: 'Open the first rule of this ' + singular,
    oosTitle: 'Out of scope (not checked by these models)',
    noVerdict: 'No bound checker verdict',
    bind: { 'spec-and-log': 'Spec & log verified', 'spec-only': 'Spec checked (log self-reported)', 'log-only': 'Log checked (spec self-reported)', 'self-reported': 'Self-reported JSON' },
    provSelf: { 'spec-only': 'Spec checked · self-reported log', 'log-only': 'Log checked · self-reported spec', 'self-reported': 'Self-reported' },
    prov: {
      counted: (label, v, t) => label + ' (' + ratio(v, t) + ')',
      failed: (f, v, t) => (f ? f + ' failed' : 'Run failed') + ' · ' + ratio(v, t) + ' verified',
      mixed: (v, t) => 'Partially verified (' + ratio(v, t) + ')',
      sample: 'Sample data',
      unverified: (v, t) => (v ? 'Unverified (' : 'Not checked yet (') + ratio(v, t) + ')',
    },
    note: {
      verified: (t, selfReported) => 'All ' + rules(t) + ' are marked verified in JSON' + (selfReported ? ', but no spec file or checker log was checked by proof-canvas.' : '.'),
      failed: (f, v, t) => (f ? rules(f) + ' failed.' : 'The run failed.') + ' ' + v + ' of ' + rules(t) + ' marked verified.',
      mixedPending: (v, t, p) => v + ' of ' + rules(t) + ' marked verified. ' + p + ' still pending.',
      mixedAll: (t) => 'All ' + rules(t) + ' are marked verified, but the run is not (it needs status "verified" and a real spec hash) or the board is declared partially verified.',
      sample: 'Sample data. The board is illustrative.',
      unverified: (v, t) => (v ? v + ' of ' + rules(t) + ' are marked verified, but the board is declared unverified.' : 'No rule is marked verified or failed.'),
      specAndLog: (tools, logHash, specHash) => tools + ' log ' + logHash + ' matched the reported verdicts. Spec ' + specHash + ' matched the rule definitions.',
      specOnly: (specHash) => 'Spec definitions and hash were checked (' + specHash + '). No checker log was verified.',
      logOnly: (tools, logHash) => tools + ' log ' + logHash + ' matched the reported verdicts. No spec file was checked.',
      selfReported: 'Self-reported JSON. No spec file or checker log was checked.',
      boardNote: (s) => 'Board note: ' + s,
    },
  };
}

export function uiJa(o) {
  const singular = o.singular || 'グループ';
  const plural = o.plural || 'グループ';
  const overview = o.overview || (o.hasFlow ? '全体の流れ' : '一覧');
  const num = (n) => n.toLocaleString('ja-JP');
  const ratio = (v, t) => v + '/' + t;
  return {
    lang: 'ja', sep: '', err: 'このボードを表示できませんでした: ', num,
    navRules: 'ルール一覧', overview, viewAll: (n) => (o.hasFlow ? '一覧' : overview) + ' (' + n + ')',
    compare: '動きを比べる',
    evTitle: '根拠と実ログ', evOpen: '詳細を表示', evClose: '詳細を閉じる',
    rule: 'ルール', ifOn: '守られているとき', ifOff: '守られないとき', quote: '元の文書', meta: '検証の情報',
    scope: '確認した範囲', method: '検証の方法', tool: '検証器', binding: '仕様・本体ログ照合', specHash: '仕様のハッシュ', logHash: 'ログのハッシュ',
    steps: '確認したステップ数', specSource: '仕様の該当箇所', witness: '到達の確認', bounds: '探索の境界', scopeChip: '範囲',
    traceBound: '実反例ログ突合済み', traceIllus: '図解のみ（反例ログ未突合）',
    cexTitle: '反例', cexOff: 'このルールがないときの反例', noCex: '反例は記録されていません',
    ovHint: 'カードをクリックすると、そのルールを開きます',
    liveOk: (n) => '検証済み' + (n ? ' · ' + num(n) + ' ステップを確認' : ''), liveBad: '違反あり', livePending: '未検証',
    toolbar: 'ルールの絞り込み', statusGroup: '状態',
    status: { all: 'すべて', failed: '違反あり', verified: '検証済み', pending: '未検証' },
    noscript: { verified: '検証済み', failed: '違反あり', pending: '未検証' },
    rules: 'ルール一覧', index: 'ルール一覧の表示を切り替える',
    prev: '前のルール', next: '次のルール', modulesN: plural, rulesN: 'ルール', nFailed: (n) => '違反 ' + n,
    hubHint: '番号をクリックすると、そのルールを開きます', hubOpen: 'この' + singular + 'の最初のルールを開く',
    oosTitle: 'モデル外・検証していない範囲',
    noVerdict: '照合できた検証結果はありません',
    bind: { 'spec-and-log': '実ログ検証済み', 'spec-only': '仕様のみ照合（ログは自己申告）', 'log-only': 'ログのみ照合（仕様は自己申告）', 'self-reported': '自己申告の JSON' },
    provSelf: { 'spec-only': '仕様のみ照合 · ログは自己申告', 'log-only': 'ログのみ照合 · 仕様は自己申告', 'self-reported': '自己申告' },
    prov: {
      counted: (label, v, t) => label + ' (' + ratio(v, t) + ')',
      failed: (f, v, t) => (f ? '違反あり ' + f + ' 件' : '実行が失敗') + ' · ' + ratio(v, t) + ' 検証済み',
      mixed: (v, t) => '一部未検証 (' + ratio(v, t) + ')',
      sample: '見本データ',
      unverified: (v, t) => '未検証 (' + ratio(v, t) + ')',
    },
    note: {
      verified: (t, selfReported) => 'JSON では ' + t + ' 件のルールがすべて検証済みです' + (selfReported ? '。ただし proof-canvas は仕様ファイルも検証器のログも照合していません。' : '。'),
      failed: (f, v, t) => (f ? f + ' 件のルールで違反が見つかりました。' : '検証の実行が失敗しました。') + t + ' 件中 ' + v + ' 件が検証済みです。',
      mixedPending: (v, t, p) => t + ' 件中 ' + v + ' 件が検証済みで、' + p + ' 件はまだ検証していません。',
      mixedAll: (t) => t + ' 件のルールはすべて検証済みですが、実行結果が検証済みではない（status "verified" と実際の仕様ハッシュが必要）か、ボードが一部未検証と宣言されています。',
      sample: '見本データです。このボードは説明用です。',
      unverified: (v, t) => (v ? t + ' 件中 ' + v + ' 件が検証済みですが、ボードは未検証と宣言されています。' : '検証済みのルールも違反のあるルールもまだありません。'),
      specAndLog: (tools, logHash, specHash) => 'このボードは実ファイルと突合済みです。' + tools + ' のログ ' + logHash + ' は報告された結果と一致し、仕様 ' + specHash + ' はルールの定義と一致しました。',
      specOnly: (specHash) => '仕様の定義とハッシュを照合しました（' + specHash + '）。検証器のログは照合していません。',
      logOnly: (tools, logHash) => tools + ' のログ ' + logHash + ' は報告された結果と一致しました。仕様ファイルは照合していません。',
      selfReported: '自己申告の JSON です。仕様ファイルも検証器のログも照合していません。',
      boardNote: (s) => 'ボードの注記: ' + s,
    },
  };
}

// Flow-view copy, shipped only by boards with a flow (see uiSource).
export function flowUiEn(o) {
  const ratio = (v, t) => v + '/' + t;
  return {
    flowTitle: 'System flow', flowAll: 'All ' + (o.plural || 'stages'), journeys: 'Journeys',
    flowCaption: 'System flow map: arrows show how stages connect; each rule\'s status reflects its reported check.',
    flowHint: 'Click a rule to open its proof', inspect: 'Inspect this rule →',
    stageBadge: (v, t, f) => (f ? f + ' failed · ' : '') + ratio(v, t) + ' verified',
    edgeKind: { bypass: 'bypass', handoff: 'handoff' },
  };
}

export function flowUiJa(o) {
  const ratio = (v, t) => v + '/' + t;
  return {
    flowTitle: '全体の流れ', flowAll: '全体を見る', journeys: '流れの例',
    flowCaption: 'システム全体の見取り図：矢印は工程のつながり、各ルールの状態は記録された検証結果を示します。',
    flowHint: 'ルールをクリックして詳細を開く', inspect: 'このルールの詳細を見る →',
    stageBadge: (v, t, f) => (f ? '違反 ' + f + ' · ' : '') + ratio(v, t) + ' 検証済み',
    edgeKind: { bypass: '迂回', handoff: '引き継ぎ' },
  };
}

// Mutant-trace copy, shipped only by boards with a bound --mutant-log (see uiSource).
export function traceUiEn() {
  return {
    trTitle: 'Machine-extracted mutant trace', trFile: 'Mutant log', trProp: 'Violated property',
    trUnnamed: 'Not named by the trace format', traceUnnamed: 'Trace attached (property unnamed)', trLen: 'Extracted steps', trShown: (n) => ' (' + n + ' shown)',
  };
}

export function traceUiJa() {
  return {
    trTitle: '機械抽出した変異体の反例', trFile: '変異体のログ', trProp: '違反した性質',
    trUnnamed: 'トレース形式に性質名なし', traceUnnamed: '反例添付（性質名なし）', trLen: '抽出したステップ', trShown: (n) => '（' + n + ' 件を表示）',
  };
}

const FACTORIES = { en: { base: uiEn, flow: flowUiEn, trace: traceUiEn }, ja: { base: uiJa, flow: flowUiJa, trace: traceUiJa } };
// The factories a board needs: the base copy, plus flow copy with a flow and trace copy with bound mutant logs.
function factoriesOf(board, binding) {
  const f = FACTORIES[board && board.lang === 'ja' ? 'ja' : 'en'];
  return [f.base, ...(board && board.flow ? [f.flow] : []), ...(binding && binding.counterexamples ? [f.trace] : [])];
}

export function uiFor(board, binding) {
  const o = uiOptions(board);
  return Object.assign({}, ...factoriesOf(board, binding).map((f) => f(o)));
}

// Browser source defining UI(o) and uiOptions(board), with only the board's language and only the
// flow and trace copy the board uses.
export function uiSource(board, binding) {
  const parts = factoriesOf(board, binding);
  const ui = parts.length === 1 ? String(parts[0]) : '(o) => Object.assign(' + parts.map((f) => '(' + f + ')(o)').join(', ') + ')';
  return 'const UI = ' + ui + ';\n' + uiOptions;
}
