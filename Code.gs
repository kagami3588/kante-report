/**
 * ============================================================================
 * KAGAMI｜子どもの進路・自己理解支援アンケート 計測システム（Google Apps Script）
 * ============================================================================
 * 目的：
 *   鑑定前 → 鑑定直後 → 3ヶ月後 の3時点を同じ対象者IDで比較し、
 *   「鑑定 → 自己理解 → 判断軸 → 進路の明確さ → 主体的な行動 → 進路の具体化」
 *   の流れを数字で検証する。
 *
 * 使い方（詳細は README.md）：
 *   1) script.google.com で新規プロジェクトを作り、このファイルを貼り付ける
 *   2) setupKagamiSystem() を実行（初回のみ。承認画面で許可）
 *   3) 実行ログ、または「フォームURL」シートで6つのフォームURLを確認
 *
 * 主な実行関数：
 *   setupKagamiSystem()      初回構築（作成済みなら何も複製せず案内だけ出す）
 *   updateKagamiSystem()     既存システムの更新（シート・数式・グラフを再生成。回答は消えない）
 *   createNewKagamiSystem()  あえて「別の新しいシステム」を作る（旧IDは履歴に残す）
 *   issueSubjectIds()        対象者IDを発行（設定シートの発行数ぶん）＋事前入力URLを作成
 *   fillPrefilledUrls()      未作成の事前入力URLを補完
 *   recalculateAll()         回答ログ・個人別分析を再計算（回答送信時は自動実行）
 *   showFormUrls()           6フォームのURLをログに表示
 *
 * 質問の変更：
 *   下の「2. 質問定義」だけを編集 → updateKagamiSystem()。
 *   ※ 回答が1件でもあるフォームは、データ保護のため質問の差し替えをスキップします。
 * ============================================================================
 */

// ############################################################################
// ## 1. 基本設定
// ############################################################################

const APP = {
  SS_TITLE: 'KAGAMI｜進路・自己理解支援アンケート（回答・分析）',
  ID_PREFIX: 'KGM',          // 対象者IDの接頭辞
  ID_DIGITS: 4,              // 連番の桁数（KGM-0001）
  MAX_SUBJECTS: 1000,        // 個人別分析などの最大行数
  DEFAULT_THRESHOLD_2: 0.5,  // 2問平均スコアの「改善／低下」しきい値
  DEFAULT_THRESHOLD_1: 1.0,  // 1問スコア（不安）の「改善／低下」しきい値
  DEFAULT_MIN_N: 30,         // 「傾向」として解釈してよい最小人数
  DEFAULT_ISSUE_COUNT: 10,   // issueSubjectIds() で一度に発行する数
  FOLLOWUP_DAYS: 90,         // 3ヶ月後アンケートの案内予定日（鑑定日＋日数・目安）
  HANDLER: 'onKagamiFormSubmit',
  TIMEZONE: 'Asia/Tokyo',
  LOCALE: 'ja_JP',
};

const PROP_KEY = 'KAGAMI_STATE';

/** シート名（変更するとCode.gs内の参照も自動で追従します） */
const SHEET = {
  README: 'README',
  SETTINGS: '設定',
  QLIST: '質問一覧',
  SUBJECTS: '対象者管理',
  E: '鑑定前_子ども',
  F: '鑑定前_保護者',
  A: '鑑定直後_子ども',
  B: '鑑定直後_保護者',
  C: '3ヶ月後_子ども',
  D: '3ヶ月後_保護者',
  LOG: '回答ログ',
  PERSON: '個人別分析',
  AGG: '全体集計',
  CROSS: 'クロス集計',
  CASE: 'ケーススタディ',
  DASH: 'ダッシュボード',
  URLS: 'フォームURL',
};
const SHEET_ORDER = [
  SHEET.README, SHEET.DASH, SHEET.SUBJECTS, SHEET.E, SHEET.F, SHEET.A, SHEET.B, SHEET.C, SHEET.D,
  SHEET.PERSON, SHEET.AGG, SHEET.CROSS, SHEET.CASE, SHEET.LOG, SHEET.QLIST, SHEET.SETTINGS, SHEET.URLS,
];

/** 3つの時点（キーはシート内の列名にも使う） */
const PHASE_LABEL = { base: '鑑定前', imm: '鑑定直後', post: '3ヶ月後' };
/** 変化量：d1=鑑定による直後の変化／d2=変化の維持・発展／d3=最終的な変化 */
const DELTA_DEF = {
  d1: { from: 'base', to: 'imm', label: '鑑定前→鑑定直後' },
  d2: { from: 'imm', to: 'post', label: '鑑定直後→3ヶ月後' },
  d3: { from: 'base', to: 'post', label: '鑑定前→3ヶ月後' },
};

/** 判定ラベル */
const JUDGE = { UP: '改善', FLAT: '変化なし', DOWN: '低下' };

// ############################################################################
// ## 2. 質問定義（ここを編集すれば質問を変更できます）
// ############################################################################

// ---- 選択肢セット -----------------------------------------------------------
/** 基本の4段階評価（中央の「どちらともいえない」は置かない／大きいほど良い） */
const SCALE4 = ['全くそう思わない', 'あまりそう思わない', 'まあそう思う', 'とてもそう思う'];
/** 主体的行動の強度（これを「主体的行動スコア」1〜4として集計する） */
const ACTION4 = ['全く行動していない', '少し行動した', '何度か行動した', '継続して行動した'];
const STATUS6 = [
  'まだ何も決まっていない',
  '興味のある方向が見えてきた',
  '進路の候補がいくつか決まった',
  '進路の候補を絞ることができた',
  '具体的な進路を決めた',
  '実際に進学・就職・活動を始めた',
];
const STATUS_SHORT = ['未決定', '興味のある方向', '候補あり', '候補を絞った', '決定', '活動開始'];
/** 進路状況の番号（1始まり）のしきい値 */
const STATUS_DIRECTION_MIN = 3; // 方向性決定：候補がいくつか決まった 以上
const STATUS_CONCRETE_MIN = 5;  // 具体的進路決定：具体的な進路を決めた 以上

/** 「鑑定がなかった場合」（単一選択） */
const CF_OPTIONS = [
  '今とあまり変わらなかったと思う',
  '進路について考えるのが遅くなっていたと思う',
  '自分に合う進路が分からないままだったと思う',
  '何をすればいいか分からないままだったと思う',
  '進路について行動することが少なかったと思う',
  'その他',
];
const CF_SHORT = ['変わらない', '考えるのが遅い', '合う進路が不明', '何をすれば不明', '行動が少ない', 'その他'];

/** 3ヶ月間に行ったこと（複数選択）。「特に何もしていない」は必須回答のため追加 */
const CHILD_ACTIONS = [
  '進路について調べた', '学校・会社・仕事について調べた', '家族に相談した', '先生・学校の人に相談した',
  'その他の人に相談した', '学校や会社などを見学した', '説明会・イベントに参加した', 'オープンキャンパス等に参加した',
  '実際に仕事や活動を体験した', '興味のある分野について勉強した', '進路候補を比較した', '進路候補を絞った',
  '実際に進路を決めた', 'その他', '特に何もしていない',
];

// ---- スコア（比較対象の5指標＋補助指標） --------------------------------------
const CORE_SCORES = [
  { key: 'self', label: '自己理解' },
  { key: 'axis', label: '判断軸' },
  { key: 'clarity', label: '進路の明確さ' },
  { key: 'decide', label: '自己決定・自己肯定' },
  { key: 'anx', label: '不安の少なさ', single: true }, // 1問のみ。大きい＝不安が少ない（逆転項目は作らない）
];
const EXTRA_SCORES = [
  { key: 'value', label: '鑑定への納得・参考度（直後・補助）' },
  { key: 'talk', label: '親子の進路対話（補助）' },
];
const ALL_SCORE_KEYS = CORE_SCORES.concat(EXTRA_SCORES).map(s => s.key);

function scoreMeta_(key) { return CORE_SCORES.filter(s => s.key === key)[0]; }

// ---- 各質問の「役割」（設計思想：目的のない質問は置かない） ------------------
const ROLE = {
  LINK: 'データの紐づけ',
  SELF: '自己理解を測る',
  AXIS: '判断軸を測る',
  CLARITY: '進路の明確さを測る',
  DECIDE: '自己決定を測る',
  ANX: '不安を測る',
  ACT: '行動を測る',
  RESULT: '結果を測る',
  USE: '鑑定の活用度を測る',
  IMPACT: '鑑定の影響度を測る',
  TALK: '自己決定を測る（親子対話）',
  FREE: '数値で分からない変化を拾う',
  CONTACT: '連絡・本人確認',
};

// ---- 質問ヘルパー -------------------------------------------------------------
/** 4段階などの選択式（番号＝選択肢の位置。大きいほど良い）。 */
const ord = (q, text, role, extra) =>
  Object.assign({ q: q, type: 'ordinal', text: text, role: role, choices: SCALE4, required: true }, extra || {});
/** 対象者ID（全フォーム共通） */
const idItem = () => ({
  q: 1, type: 'id', text: '対象者ID', role: ROLE.LINK, required: true,
  help: '担当者からお知らせした「KGM-0000」の形式のIDを、半角で入力してください。（専用URLからは自動で入力されています）',
});
/** お名前・メールアドレス（全フォーム共通。対象者IDの直後に置く） */
const nameItem = () => ({ q: 0, type: 'name', text: 'お名前', role: ROLE.CONTACT, key: 'name', required: true,
  help: '回答の確認と、ご連絡のためにだけ使います。（お子様の回答では、お子様のお名前を入力してください）' });
const emailItem = () => ({ q: 0, type: 'email', text: 'メールアドレス', role: ROLE.CONTACT, key: 'email', required: true,
  help: '3ヶ月後のアンケートのご案内など、ご連絡のためにだけ使います。' });
const FREE_TEXT = (q, text, long, key) =>
  ({ q: q, type: 'text', text: text, key: key || 'text', long: !!long, required: false, role: ROLE.FREE });
const CHECKS = (q, text, choices, key, role) =>
  ({ q: q, type: 'checkbox', text: text, choices: choices, key: key, role: role, required: true,
     help: '当てはまるものをすべて選んでください。' });
const SINGLE = (q, text, choices, key, role) =>
  ({ q: q, type: 'single', text: text, choices: choices, key: key, role: role, required: true });

const PICK_HELP = '正解・不正解はありません。今の気持ちに一番近いものを選んでください。';

/** 状態を測る9問（鑑定前・直後・3ヶ月後で同じ意味。3ヶ月後だけ先頭に「現在、」） */
const STATE_CHILD = [
  ['自分が力を発揮しやすい環境を理解している', ROLE.SELF, 'self', 'S2'],
  ['自分の性格や行動の特徴を、自分の言葉で説明できる', ROLE.SELF, 'self', 'S4'],
  ['進路を選ぶときに、自分が大切にしたいことが分かっている', ROLE.AXIS, 'axis', 'A1'],
  ['「自分に合っているか」という視点で進路を考えられる', ROLE.AXIS, 'axis', 'A3'],
  ['自分がどのような方向に進みたいのかイメージできている', ROLE.CLARITY, 'clarity', 'C1'],
  ['次に何を調べたり、経験したりすればよいか分かっている', ROLE.CLARITY, 'clarity', 'C3'],
  ['自分の進路について、自分で決めていけそうだと感じる', ROLE.DECIDE, 'decide', 'D1'],
  ['「自分は自分のままでいい」と思える', ROLE.DECIDE, 'decide', 'D2'],
  ['将来や進路について感じている不安は少ない', ROLE.ANX, 'anx', 'N1'],
];
const STATE_PARENT = [
  ['子どもが力を発揮しやすい環境を理解している', ROLE.SELF, 'self', 'S2'],
  ['子どもの性格や行動の特徴を理解している', ROLE.SELF, 'self', 'S4'],
  ['子どもの進路を考えるときに、大切にすべきことが整理できている', ROLE.AXIS, 'axis', 'A1'],
  ['「子どもに合っているか」という視点で進路を考えられる', ROLE.AXIS, 'axis', 'A3'],
  ['子どもがどのような方向に進むとよいのかイメージできている', ROLE.CLARITY, 'clarity', 'C1'],
  ['今後、子どもにどんな経験や情報が必要なのか分かっている', ROLE.CLARITY, 'clarity', 'C3'],
  ['子ども自身が進路を決めていけそうだと感じる', ROLE.DECIDE, 'decide', 'D1'],
  ['子どもの将来について前向きに考えられる', ROLE.DECIDE, 'decide', 'D2'],
  ['子どもの進路について感じている不安は少ない', ROLE.ANX, 'anx', 'N1'],
];

/** 状態9問を4つのセクション（ページ）に分けて返す */
function stateSections_(who, startQ, prefix, ttl) {
  const src = who === 'c' ? STATE_CHILD : STATE_PARENT;
  const it = src.map((r, i) => ord(startQ + i, prefix + r[0], r[1], { score: r[2], pair: r[3] }));
  return [
    { title: ttl + '自己理解', help: PICK_HELP, items: it.slice(0, 2) },
    { title: ttl + '判断軸（進路を考えるときの基準）', help: PICK_HELP, items: it.slice(2, 4) },
    { title: ttl + '進路の明確さ', help: PICK_HELP, items: it.slice(4, 6) },
    { title: ttl + '自己決定・将来への気持ち', help: PICK_HELP, items: it.slice(6, 9) },
  ];
}

/** 6つのフォーム定義。who: c=お子様 / p=保護者、phase: base=鑑定前 / imm=鑑定直後 / post=3ヶ月後 */
const FORM_SPECS = [
  // ========================= FORM E 鑑定前｜お子様 =========================
  {
    key: 'E', who: 'c', phase: 'base', sheetName: SHEET.E, whoLabel: 'お子様', surveyType: '鑑定前',
    title: 'KAGAMI｜鑑定前アンケート｜お子様',
    description: '鑑定を受ける前の、今の気持ちを教えてください。あとで「鑑定のあとで何が変わったか」を知るために使います。\n' +
      '正解・不正解はありません。今の気持ちに一番近いものを選んでください。（所要時間：約3分）',
    sections: [{ title: '基本情報', items: [idItem(), nameItem(), emailItem()] }].concat(stateSections_('c', 2, '', '今の')),
  },
  // ========================= FORM F 鑑定前｜保護者様 =========================
  {
    key: 'F', who: 'p', phase: 'base', sheetName: SHEET.F, whoLabel: '保護者', surveyType: '鑑定前',
    title: 'KAGAMI｜鑑定前アンケート｜保護者様',
    description: '鑑定を受ける前の、現在のお気持ちをお聞かせください。あとで「鑑定のあとで何が変わったか」を知るために使います。\n' +
      '正解・不正解はありません。現在のお気持ちに最も近いものをお選びください。（所要時間：約3分）',
    sections: [{ title: '基本情報', items: [idItem(), nameItem(), emailItem()] }].concat(stateSections_('p', 2, '', '現在の')),
  },
  // ========================= FORM A 鑑定直後｜お子様 =========================
  {
    key: 'A', who: 'c', phase: 'imm', sheetName: SHEET.A, whoLabel: 'お子様', surveyType: '鑑定直後',
    title: 'KAGAMI｜鑑定直後アンケート｜お子様',
    description: '今日の面談で「自分のこと」を知って、これからの進路を考えるきっかけになったかを知るためのアンケートです。\n' +
      '正解・不正解はありません。今の気持ちに一番近いものを選んでください。（所要時間：約4分）',
    sections: [{ title: '基本情報', items: [idItem(), nameItem(), emailItem()] }].concat(stateSections_('c', 2, '', '鑑定後の現在の'), [
      { title: '今回の鑑定について', help: PICK_HELP, items: [
        ord(11, '今回の鑑定内容に納得できた', ROLE.USE, { score: 'value' }),
        ord(12, '今回の鑑定で知った自分の特徴は、今後の進路を考えるうえで参考になりそうだ', ROLE.USE, { score: 'value' }),
        ord(13, '今回の面談は、自分の進路について考えるきっかけになった', ROLE.USE, { score: 'value' }),
        FREE_TEXT(14, '今回の面談で、特に印象に残った気づきがあれば教えてください。（任意）', false),
      ] },
    ]),
  },
  // ========================= FORM B 鑑定直後｜保護者様 =========================
  {
    key: 'B', who: 'p', phase: 'imm', sheetName: SHEET.B, whoLabel: '保護者', surveyType: '鑑定直後',
    title: 'KAGAMI｜鑑定直後アンケート｜保護者様',
    description: '本日の面談を通じて、お子様への理解や進路への向き合い方がどう整理されたかを知るためのアンケートです。\n' +
      '正解・不正解はありません。現在のお気持ちに最も近いものをお選びください。（所要時間：約4分）',
    sections: [{ title: '基本情報', items: [idItem(), nameItem(), emailItem()] }].concat(stateSections_('p', 2, '', '鑑定後の現在の'), [
      { title: '今回の鑑定について', help: PICK_HELP, items: [
        ord(11, '今回の鑑定内容に納得できた', ROLE.USE, { score: 'value' }),
        ord(12, '今回の鑑定で知った子どもの特徴は、今後の進路を考えるうえで参考になりそうだ', ROLE.USE, { score: 'value' }),
        ord(13, '今回の面談は、子どもの進路について考えるきっかけになった', ROLE.USE, { score: 'value' }),
        ord(14, '子どもと進路について話しやすくなった', ROLE.TALK, { score: 'talk', pair: 'T1' }),
        FREE_TEXT(15, '今回の面談で、新しく気づいたことがあれば教えてください。（任意）', true),
      ] },
    ]),
  },
  // ========================= FORM C 3ヶ月後｜お子様 =========================
  {
    key: 'C', who: 'c', phase: 'post', sheetName: SHEET.C, whoLabel: 'お子様', surveyType: '3ヶ月後',
    title: 'KAGAMI｜3ヶ月後アンケート｜お子様',
    description: '鑑定から3ヶ月がたちました。この3ヶ月での「自分のこと」や「進路」についての変化を教えてください。\n' +
      '正解・不正解はありません。今の気持ちに一番近いものを選んでください。（所要時間：約6分）',
    sections: [{ title: '基本情報', items: [idItem(), nameItem(), emailItem()] }].concat(stateSections_('c', 2, '現在、', '現在の'), [
      { title: '鑑定内容の活用', help: PICK_HELP, items: [
        ord(11, '鑑定で知った自分の特徴を、進路について考えるときに意識した', ROLE.USE, { key: 'use' }),
      ] },
      { title: '実際の行動', items: [
        ord(12, 'この3ヶ月間で、進路について自分から行動しましたか？', ROLE.ACT, { choices: ACTION4, key: 'action' }),
        CHECKS(13, 'この3ヶ月間で行ったことをすべて選んでください。', CHILD_ACTIONS, 'actions', ROLE.ACT),
      ] },
      { title: '3ヶ月間の結果と、鑑定の影響', items: [
        ord(14, '現在の進路の状況を教えてください。', ROLE.RESULT, { choices: STATUS6, key: 'status' }),
        ord(15, '今回の鑑定がなかった場合と比べて、進路について考えるきっかけや行動に影響があったと思う', ROLE.IMPACT, { key: 'impact' }),
        SINGLE(16, 'もし今回の鑑定を受けていなかったとしたら、今の自分は進路についてどうなっていたと思いますか？', CF_OPTIONS, 'cf', ROLE.IMPACT),
        FREE_TEXT(17, 'そう思う理由があれば教えてください。（任意）', true, 'cf_reason'),
        FREE_TEXT(18, 'この3ヶ月間で、一番大きかった変化や気づきがあれば教えてください。（任意）', true),
      ] },
    ]),
  },
  // ========================= FORM D 3ヶ月後｜保護者様 =========================
  {
    key: 'D', who: 'p', phase: 'post', sheetName: SHEET.D, whoLabel: '保護者', surveyType: '3ヶ月後',
    title: 'KAGAMI｜3ヶ月後アンケート｜保護者様',
    description: '鑑定から3ヶ月がたちました。この3ヶ月でのお子様の変化と、保護者としての向き合い方についてお聞かせください。\n' +
      '正解・不正解はありません。現在のお気持ちに最も近いものをお選びください。（所要時間：約6分）',
    sections: [{ title: '基本情報', items: [idItem(), nameItem(), emailItem()] }].concat(stateSections_('p', 2, '現在、', '現在の'), [
      { title: '現在の親子関係', help: PICK_HELP, items: [
        ord(11, '現在、子どもと進路について話しやすい', ROLE.TALK, { score: 'talk', pair: 'T1' }),
      ] },
      { title: '実際の変化', items: [
        ord(12, 'この3ヶ月間で、お子様は進路について自分から行動しましたか？', ROLE.ACT, { choices: ACTION4, key: 'action' }),
        ord(13, '現在のお子様の進路の状況を教えてください。', ROLE.RESULT, { choices: STATUS6, key: 'status' }),
      ] },
      { title: '鑑定の影響', items: [
        ord(14, '今回の鑑定がなかった場合と比べて、お子様の進路についての考え方や行動に影響があったと思う', ROLE.IMPACT, { key: 'impact' }),
        ord(15, '今回の面談を通じて、保護者としての子どもへの向き合い方が変わった', ROLE.IMPACT, { key: 'selfchange' }),
        SINGLE(16, 'もし今回の鑑定を受けていなかったとしたら、今のお子様は進路についてどうなっていたと思いますか？', CF_OPTIONS, 'cf', ROLE.IMPACT),
        FREE_TEXT(17, 'そう思う理由があれば教えてください。（任意）', true, 'cf_reason'),
        FREE_TEXT(18, 'この3ヶ月間で、一番大きかったお子様の変化や、保護者としての気づきがあれば教えてください。（任意）', true),
      ] },
    ]),
  },
];

// 質問番号は定義順に自動で振り直す（名前・メール追加などで番号がずれないように）
FORM_SPECS.forEach(spec => flatItems_(spec).forEach((it, i) => { it.q = i + 1; }));

/** フォームを配布する順番（鑑定前→直後→3ヶ月後）。対象者管理の列の並びにも使う */
const FORM_ORDER = ['E', 'F', 'A', 'B', 'C', 'D'];

// ############################################################################
// ## 3. 共通ユーティリティ
// ############################################################################

function log_(msg) { Logger.log(msg); }

function colLetter_(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** 対象者IDの正規化：全角→半角、空白除去、大文字化 */
function normalizeId_(v) {
  return String(v == null ? '' : v).normalize('NFKC').replace(/\s+/g, '').toUpperCase();
}

function formatId_(n) {
  let s = String(n);
  while (s.length < APP.ID_DIGITS) s = '0' + s;
  return APP.ID_PREFIX + '-' + s;
}

function specByKey_(key) { return FORM_SPECS.filter(s => s.key === key)[0]; }

/** 回答対象となる質問（セクション見出しを除く）を一列に並べる */
function flatItems_(spec) {
  const out = [];
  spec.sections.forEach(sec => sec.items.forEach(it => out.push(it)));
  return out;
}

function getState_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_KEY);
  return raw ? JSON.parse(raw) : null;
}
function saveState_(state) {
  PropertiesService.getScriptProperties().setProperty(PROP_KEY, JSON.stringify(state));
}

function openSs_() {
  const st = getState_();
  if (!st || !st.ssId) throw new Error('システムが未作成です。先に setupKagamiSystem() を実行してください。');
  return SpreadsheetApp.openById(st.ssId);
}

/** シートを取得（無ければ作成）して内容・書式・グラフ・結合をリセット */
function resetSheet_(ss, name) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  sh.getCharts().forEach(c => sh.removeChart(c));
  sh.clearConditionalFormatRules();
  sh.setFrozenRows(0);
  sh.setFrozenColumns(0);
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  sh.clear();
  return sh;
}

function getOrCreate_(ss, name) { return ss.getSheetByName(name) || ss.insertSheet(name); }

function ensureSize_(sh, rows, cols) {
  if (sh.getMaxRows() < rows) sh.insertRowsAfter(sh.getMaxRows(), rows - sh.getMaxRows());
  if (sh.getMaxColumns() < cols) sh.insertColumnsAfter(sh.getMaxColumns(), cols - sh.getMaxColumns());
}

function styleHeader_(range) {
  range.setBackground('#1f3a5f').setFontColor('#ffffff').setFontWeight('bold')
    .setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
}

function styleTitle_(range) { range.setFontSize(16).setFontWeight('bold').setFontColor('#1f3a5f'); }

function setNamedRange_(ss, name, range) {
  ss.getNamedRanges().forEach(n => { if (n.getName() === name) n.remove(); });
  ss.setNamedRange(name, range);
}

function tryDo_(fn) { try { fn(); } catch (e) { log_('（スキップ）' + e); } }

// ############################################################################
// ## 4. 設定の自己検証（設計チェックを自動で確認）
// ############################################################################

function validateConfig_() {
  const errors = [];
  const NEUTRAL = ['どちらともいえない', 'どちらでもない', 'ふつう', '普通', 'わからない'];
  const REVERSE_HINT = ['強い', '多い', '感じない'];

  FORM_SPECS.forEach(spec => {
    const items = flatItems_(spec);
    const titles = {};
    items.forEach((it, i) => {
      if (it.q !== i + 1) errors.push(spec.key + ' Q' + it.q + ': Q番号が連番ではありません');
      if (titles[it.text]) errors.push(spec.key + ' Q' + it.q + ': 質問文が重複しています');
      titles[it.text] = true;
      (it.choices || []).forEach(c => { if (NEUTRAL.indexOf(c) >= 0) errors.push(spec.key + ' Q' + it.q + ': 中央選択肢「' + c + '」は使えません'); });
      if (it.type === 'ordinal' && it.choices.length > 6) errors.push(spec.key + ' Q' + it.q + ': 選択肢が多すぎます');
      if (it.score && scoreMeta_(it.score)) {
        if (it.choices !== SCALE4) errors.push(spec.key + ' Q' + it.q + ': 比較対象の質問は4段階評価(SCALE4)にしてください');
        if (it.score === 'anx' && it.text.indexOf('少ない') < 0) errors.push(spec.key + ' Q' + it.q + ': 不安は「少ない」表現にしてください（逆転項目禁止）');
      }
      if (it.type === 'ordinal' && it.choices === SCALE4 && REVERSE_HINT.some(w => it.text.indexOf('不安が' + w) >= 0)) {
        errors.push(spec.key + ' Q' + it.q + ': 逆転項目の可能性があります');
      }
      if (spec.phase === 'post' && it.text.indexOf('鑑定前') >= 0) errors.push(spec.key + ' Q' + it.q + ': 3ヶ月後で「鑑定前」を聞いてはいけません');
      if (spec.phase === 'base' && it.type !== 'name' && it.type !== 'email' && (it.key || (it.score && !scoreMeta_(it.score)))) errors.push(spec.key + ' Q' + it.q + ': 鑑定前に鑑定内容・行動・結果の質問は置けません');
    });
    if (items[0].type !== 'id') errors.push(spec.key + ': 先頭は対象者IDにしてください');
  });

  // 3時点で比較ペアが対応しているか（同じ回答者区分どうし）
  [['E', 'A'], ['A', 'C'], ['E', 'C'], ['F', 'B'], ['B', 'D'], ['F', 'D']].forEach(pr => {
    const pick = (k) => flatItems_(specByKey_(k)).filter(i => i.pair && scoreMeta_(i.score));
    const a = {}; pick(pr[0]).forEach(i => a[i.pair] = i.score);
    const b = {}; pick(pr[1]).forEach(i => b[i.pair] = i.score);
    Object.keys(a).forEach(p => { if (b[p] !== a[p]) errors.push(pr[0] + '↔' + pr[1] + ': 比較ペア ' + p + ' が対応していません'); });
    Object.keys(b).forEach(p => { if (a[p] !== b[p]) errors.push(pr[0] + '↔' + pr[1] + ': 比較ペア ' + p + ' が対応していません'); });
  });

  if (errors.length) throw new Error('設定エラー:\n' + errors.join('\n'));
  log_('設定チェック OK（3時点の比較ペア対応・4段階・中央選択肢なし・逆転項目なし・鑑定前の悩みを再質問していない）');
}

// ############################################################################
// ## 5. エントリポイント（初回／更新／別システム新規）
// ############################################################################

/** 初回構築。既に作成済みなら何も複製せず案内だけを出す。 */
function setupKagamiSystem() {
  const st = getState_();
  if (st && st.ssId) {
    log_('すでにシステムが作成されています（二重作成を防止しました）。\n' +
      ' ・既存を更新する → updateKagamiSystem()\n ・別のシステムを新しく作る → createNewKagamiSystem()');
    showFormUrls();
    return;
  }
  buildSystem_({ ssId: null, forms: {}, history: [] });
}

/** 既存システムを更新（シート・数式・グラフを再生成。回答データは消えない）。新設フォーム（鑑定前）はここで追加される。 */
function updateKagamiSystem() {
  const st = getState_();
  if (!st || !st.ssId) { log_('システムが未作成です。setupKagamiSystem() を実行します。'); setupKagamiSystem(); return; }
  buildSystem_(st);
}

/** あえて新しいシステムを作る。旧システムのIDは履歴に残し、旧ファイルは削除しない。 */
function createNewKagamiSystem() {
  const old = getState_();
  const history = (old && old.history) ? old.history : [];
  if (old && old.ssId) history.push({ archivedAt: new Date().toISOString(), ssId: old.ssId, forms: old.forms });
  buildSystem_({ ssId: null, forms: {}, history: history });
}

function buildSystem_(state) {
  validateConfig_();

  // --- 1) スプレッドシート（作成直後にIDを保存＝途中失敗でも複製されない） ---
  let ss;
  if (state.ssId) {
    try { ss = SpreadsheetApp.openById(state.ssId); }
    catch (e) { throw new Error('保存済みのスプレッドシートを開けません。createNewKagamiSystem() で作り直せます。\n' + e); }
  } else {
    ss = SpreadsheetApp.create(APP.SS_TITLE);
    state.ssId = ss.getId();
    saveState_(state);
  }
  ss.setSpreadsheetTimeZone(APP.TIMEZONE);
  ss.setSpreadsheetLocale(APP.LOCALE);

  // --- 2) 設定・回答ログ・対象者管理（他シートの数式が参照するため先に作る） ---
  buildSettings_(ss);
  buildLogSheet_(ss);
  buildSubjects_(ss);

  // --- 3) フォーム作成＋回答先リンク ---
  FORM_SPECS.forEach(spec => {
    const form = ensureForm_(state, spec);
    linkResponseSheet_(ss, form, spec);
  });

  // --- 4) 分析系シート ---
  buildQuestionList_(ss);
  buildPersonSheet_(ss);
  const aggReg = buildAggSheet_(ss);
  buildCrossSheet_(ss);
  buildCaseSheet_(ss);
  buildDashboard_(ss, aggReg);
  buildUrlSheet_(ss, state);
  buildReadmeSheet_(ss);

  // --- 5) 後処理 ---
  installTrigger_(ss);
  removeDefaultSheet_(ss);
  recalculateAll();
  reorderSheets_(ss);
  fillPrefilledUrls();

  log_('✅ 完了：' + ss.getUrl());
  showFormUrls();
}

// ############################################################################
// ## 6. Googleフォームの生成
// ############################################################################

function ensureForm_(state, spec) {
  let form = null;
  if (state.forms[spec.key]) {
    try { form = FormApp.openById(state.forms[spec.key]); }
    catch (e) { log_('⚠ ' + spec.key + ' のフォームを開けないため新規作成します: ' + e); }
  }
  const isNew = !form;
  if (isNew) {
    form = FormApp.create(spec.title);
    state.forms[spec.key] = form.getId();
    saveState_(state);
  }

  form.setTitle(spec.title);
  form.setDescription(spec.description);
  form.setConfirmationMessage('ご回答ありがとうございました。いただいた内容は、KAGAMIのサービス改善と効果の検証にのみ使用します。');
  tryDo_(() => form.setCollectEmail(false));
  tryDo_(() => form.setAllowResponseEdits(false));
  tryDo_(() => form.setShowLinkToRespondAgain(false));
  tryDo_(() => form.setProgressBar(true));
  tryDo_(() => form.setLimitOneResponsePerUser(false));
  tryDo_(() => form.setPublishingSummary(false));

  const hasResponses = !isNew && form.getResponses().length > 0;
  if (hasResponses) {
    log_('ℹ ' + spec.key + ': 回答が既にあるため質問の差し替えはスキップしました（回答データ保護）。');
  } else {
    form.getItems().forEach(it => form.deleteItem(it));
    populateForm_(form, spec);
  }
  return form;
}

function populateForm_(form, spec) {
  spec.sections.forEach((sec, idx) => {
    // 1画面に詰め込まないよう、セクションごとにページを分ける
    const head = idx === 0 ? form.addSectionHeaderItem() : form.addPageBreakItem();
    head.setTitle(sec.title);
    if (sec.help) head.setHelpText(sec.help);
    sec.items.forEach(it => addQuestion_(form, it));
  });
}

function addQuestion_(form, it) {
  let item;
  switch (it.type) {
    case 'id': {
      item = form.addTextItem();
      item.setValidation(FormApp.createTextValidation()
        .setHelpText('「' + APP.ID_PREFIX + '-' + '0'.repeat(APP.ID_DIGITS - 1) + '1」の形式（半角）で入力してください')
        .requireTextMatchesPattern('^[' + APP.ID_PREFIX[0].toUpperCase() + APP.ID_PREFIX[0].toLowerCase() + ']' +
          APP.ID_PREFIX.slice(1).split('').map(c => '[' + c.toUpperCase() + c.toLowerCase() + ']').join('') +
          '-[0-9]{' + APP.ID_DIGITS + '}$')
        .build());
      break;
    }
    case 'name':
      item = form.addTextItem();
      break;
    case 'email':
      item = form.addTextItem();
      item.setValidation(FormApp.createTextValidation().setHelpText('メールアドレスの形式で入力してください').requireTextIsEmail().build());
      break;
    case 'single':
    case 'ordinal':
      item = form.addMultipleChoiceItem();
      item.setChoiceValues(it.choices);
      break;
    case 'checkbox':
      item = form.addCheckboxItem();
      item.setChoiceValues(it.choices);
      break;
    case 'text':
      item = it.long ? form.addParagraphTextItem() : form.addTextItem();
      break;
    default:
      throw new Error('未対応の質問タイプ: ' + it.type);
  }
  item.setTitle(it.text);
  if (it.help) item.setHelpText(it.help);
  item.setRequired(!!it.required);
}

/** フォームの回答先をスプレッドシートに設定し、生成されたシートを所定の名前に変更 */
function linkResponseSheet_(ss, form, spec) {
  const existing = ss.getSheetByName(spec.sheetName);
  let linked = false;
  try {
    linked = form.getDestinationType() === FormApp.DestinationType.SPREADSHEET && form.getDestinationId() === ss.getId();
  } catch (e) { linked = false; }
  if (linked && existing) return existing;

  const before = ss.getSheets().map(s => s.getSheetId());
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
  let created = null;
  for (let i = 0; i < 10 && !created; i++) {
    SpreadsheetApp.flush();
    created = ss.getSheets().filter(s => before.indexOf(s.getSheetId()) < 0)[0] || null;
    if (!created) Utilities.sleep(1000);
  }
  if (!created) throw new Error(spec.key + ': 回答シートが作成されませんでした。もう一度 updateKagamiSystem() を実行してください。');
  if (existing) existing.setName(spec.sheetName + '_旧(' + Utilities.formatDate(new Date(), APP.TIMEZONE, 'MMddHHmm') + ')');
  created.setName(spec.sheetName);
  return created;
}

function removeDefaultSheet_(ss) {
  ['シート1', 'Sheet1'].forEach(n => {
    const sh = ss.getSheetByName(n);
    if (sh && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
}

function reorderSheets_(ss) {
  SHEET_ORDER.forEach((name, i) => {
    const sh = ss.getSheetByName(name);
    if (sh) { ss.setActiveSheet(sh); ss.moveActiveSheet(i + 1); }
  });
  const dash = ss.getSheetByName(SHEET.DASH);
  if (dash) ss.setActiveSheet(dash);
}

function installTrigger_(ss) {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === APP.HANDLER) ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger(APP.HANDLER).forSpreadsheet(ss).onFormSubmit().create();
}

/** フォーム回答時に自動実行（インストーラブルトリガー） */
function onKagamiFormSubmit(e) {
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(60000);
    recalculateAll();
  } catch (err) {
    log_('自動再計算に失敗: ' + err);
  } finally {
    try { lock.releaseLock(); } catch (x) { /* noop */ }
  }
}

// ############################################################################
// ## 7. 設定・対象者管理・質問一覧
// ############################################################################

function buildSettings_(ss) {
  const sh = getOrCreate_(ss, SHEET.SETTINGS);
  sh.getRange('A1').setValue('設定').setFontSize(14).setFontWeight('bold');
  sh.getRange('A2:C2').setValues([['項目', '値', '説明']]);
  styleHeader_(sh.getRange('A2:C2'));
  const defs = [
    ['KAGAMI_THRESHOLD_2', '改善／低下の判定しきい値（2問平均のスコア）', APP.DEFAULT_THRESHOLD_2,
      '変化量が +しきい値以上で「改善」、−しきい値以下で「低下」、その間は「変化なし」。自己理解・判断軸・進路の明確さ・自己決定が対象。'],
    ['KAGAMI_THRESHOLD_1', '改善／低下の判定しきい値（1問のスコア＝不安の少なさ）', APP.DEFAULT_THRESHOLD_1,
      '不安の少なさは1問のため、1点以上の動きで改善／低下とします。'],
    ['KAGAMI_MIN_N', '傾向として解釈する最小人数(N)', APP.DEFAULT_MIN_N,
      'これ未満のときダッシュボードに注意を表示します。断定表現は使わないでください。'],
    ['KAGAMI_ISSUE_COUNT', 'ID発行数（issueSubjectIds用）', APP.DEFAULT_ISSUE_COUNT,
      'issueSubjectIds() を実行すると、この数だけ新しい対象者IDを発行します。'],
    ['KAGAMI_FOLLOWUP_DAYS', '3ヶ月後案内までの日数（目安）', APP.FOLLOWUP_DAYS,
      '対象者管理の「鑑定日」＋この日数＝3ヶ月後アンケートの案内予定日（目安）。'],
  ];
  defs.forEach((d, i) => {
    const row = 3 + i;
    sh.getRange(row, 1).setValue(d[1]);
    const cell = sh.getRange(row, 2);
    if (cell.getValue() === '') cell.setValue(d[2]); // ユーザーが変更した値は上書きしない
    cell.setBackground('#fff2cc').setFontWeight('bold');
    sh.getRange(row, 3).setValue(d[3]).setWrap(true);
    setNamedRange_(ss, d[0], cell);
  });
  sh.setColumnWidth(1, 330); sh.setColumnWidth(2, 90); sh.setColumnWidth(3, 640);
  sh.setFrozenRows(2);
}

/** 対象者管理の列定義（1始まり） */
const SUBJ = {
  FIRST: 2,
  COLS: ['対象者ID', '発行日', '鑑定日（入力）', '3ヶ月後案内予定日（目安）', 'お子様のお名前（任意）', '保護者のお名前（任意）',
    '連絡先メールアドレス（保護者）', '学年区分（任意）', '初回アンケートの主な悩み（カテゴリ）', '初回アンケートの悩み（要約）',
    '事例掲載の許可', 'メモ',
    '鑑定前・子ども', '鑑定前・保護者', '直後・子ども', '直後・保護者', '3ヶ月後・子ども', '3ヶ月後・保護者',
    '事前入力URL｜E 鑑定前・子ども', '事前入力URL｜F 鑑定前・保護者', '事前入力URL｜A 直後・子ども',
    '事前入力URL｜B 直後・保護者', '事前入力URL｜C 3ヶ月後・子ども', '事前入力URL｜D 3ヶ月後・保護者'],
  ID: 1, ISSUED: 2, DATE: 3, DUE: 4, CNAME: 5, PNAME: 6, MAIL: 7, GRADE: 8, CONCERN: 9, SUMMARY: 10, PERMIT: 11, MEMO: 12,
  STATUS: 13, // 13〜18：回答状況 6列
  URL: 19,    // 19〜24：事前入力URL 6列
};

function buildSubjects_(ss) {
  const sh = getOrCreate_(ss, SHEET.SUBJECTS);
  const n = APP.MAX_SUBJECTS;
  const nc = SUBJ.COLS.length;
  ensureSize_(sh, n + 1, nc);
  sh.getRange(1, 1, 1, nc).setValues([SUBJ.COLS]);
  styleHeader_(sh.getRange(1, 1, 1, nc));
  sh.setRowHeight(1, 52);
  sh.setFrozenRows(1); sh.setFrozenColumns(1);

  const last = n + 1;
  const dateF = [], statF = [];
  const pairs = [['お子様', '鑑定前'], ['保護者', '鑑定前'], ['お子様', '鑑定直後'], ['保護者', '鑑定直後'], ['お子様', '3ヶ月後'], ['保護者', '3ヶ月後']];
  for (let r = 2; r <= last; r++) {
    dateF.push(['=IF(AND($A' + r + '<>"",ISNUMBER($C' + r + ')),$C' + r + '+KAGAMI_FOLLOWUP_DAYS,"")']);
    statF.push(pairs.map(p =>
      '=IF($A' + r + '="","",IF(COUNTIFS(\'' + SHEET.LOG + '\'!$B:$B,$A' + r + ',\'' + SHEET.LOG + '\'!$C:$C,"' + p[0] +
      '",\'' + SHEET.LOG + '\'!$D:$D,"' + p[1] + '")>0,"✓",""))'));
  }
  sh.getRange(2, SUBJ.DUE, n, 1).setFormulas(dateF);
  sh.getRange(2, SUBJ.STATUS, n, 6).setFormulas(statF);
  sh.getRange(2, 1, n, 1).setNumberFormat('@');
  sh.getRange(2, SUBJ.ISSUED, n, 1).setNumberFormat('yyyy/mm/dd');
  sh.getRange(2, SUBJ.DATE, n, 2).setNumberFormat('yyyy/mm/dd');
  sh.getRange(2, SUBJ.PERMIT, n, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['○', '×'], true).setAllowInvalid(true).build());
  sh.getRange(2, SUBJ.STATUS, n, 6).setHorizontalAlignment('center').setFontColor('#38761d').setFontWeight('bold');
  sh.getRange(1, SUBJ.CNAME, 1, 3).setBackground('#990000');                        // 個人情報の列（赤）
  sh.getRange(1, SUBJ.GRADE, 1, 5).setBackground('#38761d');                        // 手入力の属性列（緑）
  sh.getRange(1, SUBJ.URL, 1, 6).setBackground('#7f6000');
  [110, 90, 100, 120, 130, 130, 190, 100, 180, 220, 90, 220, 70, 70, 70, 70, 80, 80, 160, 160, 160, 160, 160, 160]
    .forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.getRange(1, SUBJ.CNAME).setNote('氏名・メールアドレスはこの台帳にだけ保存します（回答フォームでは聞きません）。\n' +
    'この列を含むシートは、共有範囲を必要最小限にしてください。分析シートには出ません。');
  sh.getRange('A1').setNote('IDは issueSubjectIds() で発行してください。手入力する場合も KGM-0001 の形式（半角）で。');
}

/** 対象者IDを発行（設定シートの発行数ぶん） */
function issueSubjectIds() {
  const ss = openSs_();
  const sh = ss.getSheetByName(SHEET.SUBJECTS);
  const count = Math.max(1, parseInt(ss.getRangeByName('KAGAMI_ISSUE_COUNT').getValue(), 10) || APP.DEFAULT_ISSUE_COUNT);
  const ids = sh.getRange(2, 1, APP.MAX_SUBJECTS, 1).getValues().map(r => normalizeId_(r[0]));
  let maxNum = 0, lastIdx = -1;
  const re = new RegExp('^' + APP.ID_PREFIX + '-([0-9]+)$');
  ids.forEach((id, i) => {
    if (id) { lastIdx = i; const m = re.exec(id); if (m) maxNum = Math.max(maxNum, parseInt(m[1], 10)); }
  });
  if (lastIdx + 1 + count > APP.MAX_SUBJECTS) throw new Error('対象者管理の上限(' + APP.MAX_SUBJECTS + '件)を超えます。');
  const startRow = lastIdx + 3;
  const today = new Date();
  const newRows = [];
  for (let i = 1; i <= count; i++) newRows.push([formatId_(maxNum + i), today]);
  sh.getRange(startRow, 1, count, 2).setValues(newRows);
  log_('発行したID: ' + newRows.map(r => r[0]).join(', '));
  fillPrefilledUrls();
  recalculateAll();
}

/** 事前入力URL（IDが自動入力されるURL）を、未作成の行だけ作る */
function fillPrefilledUrls() {
  const ss = openSs_();
  const st = getState_();
  const sh = ss.getSheetByName(SHEET.SUBJECTS);
  const n = APP.MAX_SUBJECTS;
  const idVals = sh.getRange(2, 1, n, 1).getValues();
  const urlRange = sh.getRange(2, SUBJ.URL, n, 6);
  const urls = urlRange.getValues();
  let changed = false;
  FORM_ORDER.forEach((k, ci) => {
    const need = idVals.some((r, i) => normalizeId_(r[0]) && !urls[i][ci]);
    if (!need) return;
    let form, idItem;
    try {
      form = FormApp.openById(st.forms[k]);
      idItem = form.getItems(FormApp.ItemType.TEXT).filter(i => i.getTitle() === '対象者ID')[0].asTextItem();
    } catch (e) { log_('事前入力URL(' + k + ')を作れません: ' + e); return; }
    idVals.forEach((r, i) => {
      const id = normalizeId_(r[0]);
      if (id && !urls[i][ci]) {
        urls[i][ci] = form.createResponse().withItemResponse(idItem.createResponse(id)).toPrefilledUrl();
        changed = true;
      }
    });
  });
  if (changed) urlRange.setValues(urls);
}

function buildQuestionList_(ss) {
  const sh = resetSheet_(ss, SHEET.QLIST);
  const head = ['フォーム', 'Q', '質問文', '形式', '必須', '測る目的', '集計スコア', '比較ペア', '選択肢'];
  const rows = [];
  FORM_ORDER.forEach(k => {
    const spec = specByKey_(k);
    flatItems_(spec).forEach(it => {
      const sc = CORE_SCORES.concat(EXTRA_SCORES).filter(s => s.key === it.score)[0];
      rows.push([
        spec.key + '｜' + spec.surveyType + '｜' + spec.whoLabel, 'Q' + it.q, it.text,
        { id: '記述(ID)', name: '記述(お名前)', email: '記述(メール)', single: '単一選択', ordinal: '4段階/順序選択', checkbox: '複数選択', text: it.long ? '長文記述' : '短文記述' }[it.type],
        it.required ? '必須' : '任意', it.role, sc ? sc.label : '', it.pair || '', (it.choices || []).join(' / '),
      ]);
    });
  });
  sh.getRange(1, 1, 1, head.length).setValues([head]);
  styleHeader_(sh.getRange(1, 1, 1, head.length));
  sh.getRange(2, 1, rows.length, head.length).setValues(rows).setVerticalAlignment('top').setWrap(true);
  [210, 40, 420, 100, 50, 190, 130, 70, 380].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.setFrozenRows(1);
}

// ############################################################################
// ## 8. 回答ログ（回答者区分・アンケート種別・回答日時つきの縦持ちデータ）
// ############################################################################

const LOG_HEAD = ['回答日時', '対象者ID', '回答者区分', 'アンケート種別', 'フォーム'].concat(
  CORE_SCORES.map(s => s.label), ['納得・参考度(補助)', '親子対話(補助)'],
  ['主体的行動(1-4)', '進路状況(1-6)', '鑑定活用(1-4)', '鑑定影響(1-4)', '最新回答', 'ID登録']);

function buildLogSheet_(ss) {
  const sh = resetSheet_(ss, SHEET.LOG);
  ensureSize_(sh, 6, LOG_HEAD.length);
  sh.getRange(1, 1, 1, LOG_HEAD.length).setValues([LOG_HEAD]);
  styleHeader_(sh.getRange(1, 1, 1, LOG_HEAD.length));
  sh.getRange('B:B').setNumberFormat('@');
  sh.setFrozenRows(1);
  sh.getRange('A1').setNote('このシートはスクリプトが自動で作り直します（手入力しないでください）。\nBIツールや追加分析にはこのシートを使うと便利です。');
}

// ############################################################################
// ## 9. 回答の読み取りと再計算
// ############################################################################

/** 全フォームの回答シートを読み、スコア等を計算して配列で返す */
function collectResponses_(ss) {
  const out = [];
  FORM_SPECS.forEach(spec => {
    const sh = ss.getSheetByName(spec.sheetName);
    if (!sh || sh.getLastRow() < 2) return;
    const values = sh.getDataRange().getValues();
    const header = values[0].map(h => String(h).trim());
    const items = flatItems_(spec);
    // 列の特定：見出し(質問文)一致を優先し、無ければ並び順で推定
    const colOf = items.map((it, i) => {
      const idx = header.indexOf(it.text);
      return idx >= 0 ? idx : i + 1;
    });
    for (let r = 1; r < values.length; r++) {
      const row = values[r];
      const id = normalizeId_(row[colOf[0]]);
      if (!id) continue;
      const rec = { spec: spec, ts: row[0] instanceof Date ? row[0] : new Date(row[0]), id: id, scores: {}, keys: {} };
      const sums = {};
      items.forEach((it, i) => {
        const raw = row[colOf[i]];
        if (it.type === 'ordinal') {
          const n = it.choices.indexOf(String(raw).trim()) + 1;
          if (n > 0) {
            if (it.score) { (sums[it.score] = sums[it.score] || []).push(n); }
            if (it.key) rec.keys[it.key] = n;
          }
        } else if ((it.type === 'checkbox' || it.type === 'text' || it.type === 'single' || it.type === 'name' || it.type === 'email') && it.key) {
          rec.keys[it.key] = String(raw == null ? '' : raw);
        }
      });
      Object.keys(sums).forEach(k => {
        rec.scores[k] = Math.round(sums[k].reduce((a, b) => a + b, 0) / sums[k].length * 10000) / 10000;
      });
      out.push(rec);
    }
  });
  return out;
}

/** (フォーム,ID)ごとに最新の回答だけを残す */
function pickLatest_(responses) {
  const latest = {};
  responses.forEach(rec => {
    const k = rec.spec.key + '|' + rec.id;
    if (!latest[k] || rec.ts.getTime() >= latest[k].ts.getTime()) latest[k] = rec;
  });
  return latest;
}

/** 回答ログ・個人別分析を再計算（回答送信時にも自動実行） */
function recalculateAll() {
  const ss = openSs_();
  const responses = collectResponses_(ss);
  const latest = pickLatest_(responses);
  const registered = readRegisteredIds_(ss);
  const regSet = {}; registered.forEach(id => regSet[id] = true);

  writeLog_(ss, responses, latest, regSet);
  writePersonValues_(ss, responses, latest, registered, regSet);
  fillLedgerContacts_(ss, latest);
  SpreadsheetApp.flush();
  log_('再計算完了：回答 ' + responses.length + ' 件 / 最新 ' + Object.keys(latest).length + ' 件');
}

/** 回答で届いた氏名・メールを、対象者管理の空欄にだけ転記（手入力した値は上書きしない） */
function fillLedgerContacts_(ss, latest) {
  const sh = ss.getSheetByName(SHEET.SUBJECTS);
  const n = APP.MAX_SUBJECTS;
  const ids = sh.getRange(2, 1, n, 1).getValues().map(r => normalizeId_(r[0]));
  const pick = (who, key) => {
    const m = {};
    Object.keys(latest).map(k => latest[k]).filter(r => r.spec.who === who && r.keys[key])
      .sort((a, b) => a.ts - b.ts).forEach(r => { m[r.id] = r.keys[key]; });
    return m;
  };
  [[SUBJ.CNAME, 'c', 'name'], [SUBJ.PNAME, 'p', 'name'], [SUBJ.MAIL, 'p', 'email']].forEach(t => {
    const src = pick(t[1], t[2]);
    const rg = sh.getRange(2, t[0], n, 1);
    const cur = rg.getValues();
    let changed = false;
    ids.forEach((id, i) => { if (id && !cur[i][0] && src[id]) { cur[i][0] = src[id]; changed = true; } });
    if (changed) rg.setValues(cur);
  });
}

function readRegisteredIds_(ss) {
  const sh = ss.getSheetByName(SHEET.SUBJECTS);
  const seen = {}; const out = [];
  sh.getRange(2, 1, APP.MAX_SUBJECTS, 1).getValues().forEach(r => {
    const id = normalizeId_(r[0]);
    if (id && !seen[id]) { seen[id] = true; out.push(id); }
  });
  return out;
}

function writeLog_(ss, responses, latest, regSet) {
  const sh = ss.getSheetByName(SHEET.LOG);
  const lastRow = sh.getLastRow();
  if (lastRow > 1) sh.getRange(2, 1, lastRow - 1, LOG_HEAD.length).clearContent();
  if (!responses.length) return;
  const sorted = responses.slice().sort((a, b) => a.ts - b.ts);
  const rows = sorted.map(rec => {
    const isLatest = latest[rec.spec.key + '|' + rec.id] === rec ? 1 : 0;
    const k = rec.keys;
    return [rec.ts, rec.id, rec.spec.whoLabel, rec.spec.surveyType, rec.spec.key + ' ' + rec.spec.title]
      .concat(ALL_SCORE_KEYS.map(sk => rec.scores[sk] !== undefined ? rec.scores[sk] : ''))
      .concat([k.action !== undefined ? k.action : '', k.status !== undefined ? k.status : '',
        k.use !== undefined ? k.use : '', k.impact !== undefined ? k.impact : '',
        isLatest, regSet[rec.id] ? '登録済' : '未登録（要確認）']);
  });
  ensureSize_(sh, rows.length + 1, LOG_HEAD.length);
  sh.getRange(2, 1, rows.length, LOG_HEAD.length).setValues(rows);
  sh.getRange(2, 1, rows.length, 1).setNumberFormat('yyyy/mm/dd hh:mm');
}

// ############################################################################
// ## 10. 個人別分析（鑑定前・直後・3ヶ月後の3時点）
// ############################################################################

const PERSON = { BAND: 1, HEAD: 2, FIRST: 3 };
PERSON.LAST = PERSON.FIRST + APP.MAX_SUBJECTS - 1;

let _pcols = null;
/** 個人別分析の列定義（kind: input=スクリプトが書く／formula=数式） */
function pcols_() {
  if (_pcols) return _pcols;
  const cols = [];
  const add = (key, label, kind, group, fmt) => cols.push({ key: key, label: label, kind: kind, group: group, fmt: fmt || '' });
  const WHO = [['c', 'お子様'], ['p', '保護者']];
  add('id', '対象者ID', 'input', '基本'); add('reg', 'ID登録', 'input', '基本');
  WHO.forEach(w => {
    ['base', 'imm', 'post'].forEach(ph => CORE_SCORES.forEach(s =>
      add(w[0] + '_' + ph + '_' + s.key, s.label, 'input', w[1] + '｜' + PHASE_LABEL[ph], '0.00')));
    ['d1', 'd2', 'd3'].forEach(dk => CORE_SCORES.forEach(s =>
      add(w[0] + '_' + dk + '_' + s.key, s.label, 'formula', w[1] + '｜変化量 ' + DELTA_DEF[dk].label, '+0.00;-0.00;0.00')));
    ['j1', 'j2', 'j3'].forEach(jk => CORE_SCORES.forEach(s =>
      add(w[0] + '_' + jk + '_' + s.key, s.label, 'formula', w[1] + '｜判定 ' + DELTA_DEF['d' + jk.slice(1)].label)));
  });
  CORE_SCORES.forEach(s => add('gap_' + s.key, s.label, 'formula', '親子差（3ヶ月後：保護者−お子様）', '+0.00;-0.00;0.00'));
  add('match_status', '進路状況の一致(1=一致)', 'formula', '親子差（3ヶ月後：保護者−お子様）');
  add('c_name', 'お子様 お名前', 'input', '連絡先（最新回答）', '@');
  add('c_email', 'お子様 メール', 'input', '連絡先（最新回答）', '@');
  add('p_name', '保護者 お名前', 'input', '連絡先（最新回答）', '@');
  add('p_email', '保護者 メール', 'input', '連絡先（最新回答）', '@');
  add('c_imm_value', 'お子様 納得・参考度', 'input', '補助｜鑑定直後', '0.00');
  add('p_imm_value', '保護者 納得・参考度', 'input', '補助｜鑑定直後', '0.00');
  add('p_imm_talk', '保護者 親子対話(直後)', 'input', '補助｜親子対話', '0.00');
  add('p_post_talk', '保護者 親子対話(3ヶ月後)', 'input', '補助｜親子対話', '0.00');
  add('p_d_talk', '保護者 親子対話の変化(直後→3ヶ月後)', 'formula', '補助｜親子対話', '+0.00;-0.00;0.00');
  const g1 = 'お子様｜3ヶ月後の行動・結果', g2 = '保護者｜3ヶ月後の行動・結果';
  add('c_use', '鑑定活用(1-4)', 'input', g1);
  add('c_action', '主体的行動スコア(1-4)', 'input', g1);
  add('c_status', '進路状況(1-6)', 'input', g1);
  add('c_impact', '鑑定影響(1-4)', 'input', g1);
  add('c_cf', '鑑定がなかった場合', 'input', g1, '@');
  add('p_action', '主体的行動スコア(1-4)', 'input', g2);
  add('p_status', '進路状況(1-6)', 'input', g2);
  add('p_impact', '鑑定影響(1-4)', 'input', g2);
  add('p_selfchange', '向き合い方の変化(1-4)', 'input', g2);
  add('p_cf', '鑑定がなかった場合', 'input', g2, '@');
  const g3 = '複数回答・自由記述（最新回答）';
  add('c_actions', 'お子様 行動内容（複数）', 'input', g3, '@');
  add('c_cf_reason', 'お子様 「鑑定がなかった場合」の理由', 'input', g3, '@');
  add('p_cf_reason', '保護者 「鑑定がなかった場合」の理由', 'input', g3, '@');
  add('c_imm_text', 'お子様 直後の気づき', 'input', g3, '@');
  add('p_imm_text', '保護者 直後の気づき', 'input', g3, '@');
  add('c_post_text', 'お子様 3ヶ月後の変化・気づき', 'input', g3, '@');
  add('p_post_text', '保護者 3ヶ月後の変化・気づき', 'input', g3, '@');
  cols.forEach((c, i) => { c.idx = i + 1; c.letter = colLetter_(i + 1); });
  _pcols = cols;
  return cols;
}

function pcol_(key) {
  const c = pcols_().filter(x => x.key === key)[0];
  if (!c) throw new Error('個人別分析の列キーが不明: ' + key);
  return c;
}
/** 個人別分析の列範囲（絶対参照）。例: '個人別分析'!$L$3:$L$1002 */
function pr_(key) {
  const c = pcol_(key);
  return "'" + SHEET.PERSON + "'!$" + c.letter + '$' + PERSON.FIRST + ':$' + c.letter + '$' + PERSON.LAST;
}

function personFormula_(key, row) {
  const A = (k) => pcol_(k).letter + row;
  let m;
  if ((m = /^([cp])_(d[123])_(\w+)$/.exec(key))) {
    const d = DELTA_DEF[m[2]];
    const to = A(m[1] + '_' + d.to + '_' + m[3]), from = A(m[1] + '_' + d.from + '_' + m[3]);
    return '=IF(AND(ISNUMBER(' + to + '),ISNUMBER(' + from + ')),ROUND(' + to + '-' + from + ',4),"")';
  }
  if ((m = /^([cp])_(j[123])_(\w+)$/.exec(key))) {
    const dc = A(m[1] + '_d' + m[2].slice(1) + '_' + m[3]);
    const thr = scoreMeta_(m[3]).single ? 'KAGAMI_THRESHOLD_1' : 'KAGAMI_THRESHOLD_2';
    return '=IF(ISNUMBER(' + dc + '),IF(' + dc + '>=' + thr + ',"' + JUDGE.UP + '",IF(' + dc + '<=-' + thr + ',"' + JUDGE.DOWN + '","' + JUDGE.FLAT + '")),"")';
  }
  if ((m = /^gap_(\w+)$/.exec(key))) {
    const p = A('p_post_' + m[1]), c = A('c_post_' + m[1]);
    return '=IF(AND(ISNUMBER(' + p + '),ISNUMBER(' + c + ')),ROUND(' + p + '-' + c + ',4),"")';
  }
  if (key === 'match_status') {
    return '=IF(AND(ISNUMBER(' + A('c_status') + '),ISNUMBER(' + A('p_status') + ')),IF(' + A('c_status') + '=' + A('p_status') + ',1,0),"")';
  }
  if (key === 'p_d_talk') {
    return '=IF(AND(ISNUMBER(' + A('p_post_talk') + '),ISNUMBER(' + A('p_imm_talk') + ')),ROUND(' + A('p_post_talk') + '-' + A('p_imm_talk') + ',4),"")';
  }
  throw new Error('数式未定義: ' + key);
}

function buildPersonSheet_(ss) {
  const sh = resetSheet_(ss, SHEET.PERSON);
  const cols = pcols_();
  ensureSize_(sh, PERSON.LAST, cols.length);
  const N = PERSON.LAST - PERSON.FIRST + 1;

  // グループ帯（1行目）と見出し（2行目）
  const palette = ['#d9e2f3', '#e2efda', '#fff2cc', '#fce4d6'];
  let gi = -1, prev = null;
  cols.forEach(c => {
    if (c.group !== prev) { gi++; prev = c.group; sh.getRange(PERSON.BAND, c.idx).setValue(c.group); }
    sh.getRange(PERSON.BAND, c.idx).setBackground(palette[gi % palette.length]).setFontWeight('bold').setFontSize(9);
  });
  sh.getRange(PERSON.HEAD, 1, 1, cols.length).setValues([cols.map(c => c.label)]);
  styleHeader_(sh.getRange(PERSON.HEAD, 1, 1, cols.length));
  sh.setRowHeight(PERSON.HEAD, 44);

  // 数式列
  cols.forEach(c => {
    if (c.kind === 'formula') {
      const f = [];
      for (let r = PERSON.FIRST; r <= PERSON.LAST; r++) f.push([personFormula_(c.key, r)]);
      sh.getRange(PERSON.FIRST, c.idx, N, 1).setFormulas(f);
    }
    if (c.fmt) sh.getRange(PERSON.FIRST, c.idx, N, 1).setNumberFormat(c.fmt);
    sh.setColumnWidth(c.idx, c.fmt === '@' ? 220 : (c.key === 'id' ? 100 : 80));
  });
  sh.setColumnWidth(2, 110);

  // 判定列の色分け
  const rules = [];
  cols.filter(c => /_j[123]_/.test(c.key)).forEach(c => {
    const rg = sh.getRange(PERSON.FIRST, c.idx, N, 1);
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(JUDGE.UP).setBackground('#d9ead3').setRanges([rg]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(JUDGE.DOWN).setBackground('#f4cccc').setRanges([rg]).build());
  });
  sh.setConditionalFormatRules(rules);
  sh.setFrozenRows(PERSON.HEAD);
  sh.setFrozenColumns(2);
  sh.getRange(PERSON.HEAD, 1).setNote('このシートの「入力列」はスクリプトが自動で更新します。手入力しないでください。\n' +
    '変化量・判定・親子差は数式です。変化量：d1=鑑定前→直後／d2=直後→3ヶ月後／d3=鑑定前→3ヶ月後（最終的な変化）。');
}

function writePersonValues_(ss, responses, latest, registered, regSet) {
  const sh = ss.getSheetByName(SHEET.PERSON);
  const cols = pcols_();
  const N = PERSON.LAST - PERSON.FIRST + 1;

  // 行の並び：登録済みID（対象者管理の順）→ 未登録ID（回答にだけ存在）
  const unreg = [];
  const seen = {};
  responses.forEach(r => { if (!regSet[r.id] && !seen[r.id]) { seen[r.id] = true; unreg.push(r.id); } });
  unreg.sort();
  const ids = registered.concat(unreg);
  if (ids.length > N) log_('⚠ 対象者数が上限(' + N + ')を超えています。超過分は表示されません。');

  // ID別に値をまとめる
  const byId = {};
  Object.keys(latest).sort((a, b) => latest[a].ts - latest[b].ts).forEach(k => {
    const rec = latest[k];
    const w = rec.spec.who, ph = rec.spec.phase;
    const o = byId[rec.id] = byId[rec.id] || {};
    Object.keys(rec.scores).forEach(sk => { o[w + '_' + ph + '_' + sk] = rec.scores[sk]; });
    Object.keys(rec.keys).forEach(kk => {
      if (rec.keys[kk] === '') return;
      o[kk === 'text' ? (w + '_' + ph + '_text') : (w + '_' + kk)] = rec.keys[kk];
    });
  });

  cols.filter(c => c.kind === 'input').forEach(c => {
    const arr = [];
    for (let i = 0; i < N; i++) {
      const id = ids[i];
      let v = '';
      if (id !== undefined) {
        if (c.key === 'id') v = id;
        else if (c.key === 'reg') v = regSet[id] ? '登録済' : '未登録（要確認）';
        else if (byId[id] && byId[id][c.key] !== undefined) v = byId[id][c.key];
      }
      arr.push([v]);
    }
    const rg = sh.getRange(PERSON.FIRST, c.idx, N, 1);
    if (c.fmt === '@' || c.key === 'id') rg.setNumberFormat('@'); // 自由記述が数式として解釈されないようにする
    rg.setValues(arr);
  });
}

// ############################################################################
// ## 11. 全体集計
// ############################################################################

const q_ = (s) => '"' + s + '"';

/** 複数回答の中に選択肢が含まれる人数（選択肢どうしの部分一致を避けるため、区切り位置まで見る） */
function cntOpt_(range, opt) {
  return 'COUNTIF(' + range + ',"' + opt + '")+COUNTIF(' + range + ',"' + opt + ', *")+COUNTIF(' + range + ',"*, ' + opt + '")+COUNTIF(' + range + ',"*, ' + opt + ', *")';
}
/** 相関係数（両方が数値の人だけで計算） */
function corrF_(x, y) {
  return '=IFERROR(CORREL(FILTER(' + x + ',ISNUMBER(' + x + '),ISNUMBER(' + y + ')),FILTER(' + y + ',ISNUMBER(' + x + '),ISNUMBER(' + y + '))),"")';
}
function nPair_(x, y) { return 'SUMPRODUCT(ISNUMBER(' + x + ')*ISNUMBER(' + y + '))'; }
/** 相関の読み方（因果ではなく「関係の強さ」） */
function readCorr_(rCell, nCell) {
  return '=IF(NOT(ISNUMBER(' + rCell + ')),"算出できません（Nが少ない）",IF(' + nCell + '<10,"Nが少なく判断できません",' +
    'IF(ABS(' + rCell + ')>=0.5,IF(' + rCell + '>0,"強い正の関係","強い負の関係"),' +
    'IF(ABS(' + rCell + ')>=0.3,IF(' + rCell + '>0,"ある程度の正の関係","ある程度の負の関係"),' +
    'IF(ABS(' + rCell + ')>=0.1,"弱い関係","ほぼ関係なし")))))';
}

function buildAggSheet_(ss) {
  const sh = resetSheet_(ss, SHEET.AGG);
  ensureSize_(sh, 220, 12);
  const rows = []; const reg = {}; const fmts = []; const sections = []; const heads = [];
  const push = (arr) => { rows.push(arr); return rows.length; };
  const section = (t) => sections.push(push([t, '', '', '']));
  const head = (a, b, c, d) => heads.push(push([a, b, c, d]));
  const line = (key, label, b, c, note, fmt) => {
    const n = push([label, b, c, note || '']);
    if (key) reg[key] = n;
    if (fmt) fmts.push({ n: n, fmt: fmt });
    return n;
  };
  const rate = (r, min) => '=IFERROR(COUNTIF(' + r + ',">=' + min + '")/COUNT(' + r + '),"")';
  const PCT = '0.0%', NUM = '0.00', DELTA = '+0.00;-0.00;0.00', INT = '0';

  push(['全体集計', '', '', '']);
  push(['※ 数値は回答者本人の自己評価・本人が感じた変化・報告された行動／進路状況です。「KAGAMIによって○○が起きた」という因果の証明ではありません。', '', '', '']);

  // --- 1. 基本数値 ---
  section('1. 基本数値'); head('指標', 'お子様', '保護者', '定義');
  line('subjects', '鑑定人数（対象者管理のID数）', "=COUNTA('" + SHEET.SUBJECTS + "'!$A$2:$A$" + (APP.MAX_SUBJECTS + 1) + ')', '', '対象者管理に登録されたID数', INT);
  line('n_base', '鑑定前アンケート 回答者数', '=COUNT(' + pr_('c_base_self') + ')', '=COUNT(' + pr_('p_base_self') + ')', '同一ID・同一フォームは最新の1件のみ集計', INT);
  line('n_imm', '鑑定直後アンケート 回答者数', '=COUNT(' + pr_('c_imm_self') + ')', '=COUNT(' + pr_('p_imm_self') + ')', '', INT);
  line('n_post', '3ヶ月後アンケート 回答者数', '=COUNT(' + pr_('c_action') + ')', '=COUNT(' + pr_('p_action') + ')', '', INT);
  line('n_any_post', '3ヶ月後アンケート 回答対象者数（子ども・保護者いずれか）',
    '=SUMPRODUCT(--((ISNUMBER(' + pr_('c_action') + ')+ISNUMBER(' + pr_('p_action') + '))>0))', '', '', INT);
  line('resp_rate', '3ヶ月後回答率（鑑定人数に対する割合）', '=IFERROR(B' + reg.n_any_post + '/B' + reg.subjects + ',"")', '', '子ども・保護者いずれかが回答した割合', PCT);
  line('resp_rate_s', '　（内訳）3ヶ月後回答率', '=IFERROR(B' + reg.n_post + '/B' + reg.subjects + ',"")', '=IFERROR(C' + reg.n_post + '/B' + reg.subjects + ',"")', '回答者区分ごと', PCT);
  const all3 = (w) => '=SUMPRODUCT(ISNUMBER(' + pr_(w + '_base_self') + ')*ISNUMBER(' + pr_(w + '_imm_self') + ')*ISNUMBER(' + pr_(w + '_post_self') + '))';
  line('n_all3', '3時点（鑑定前・直後・3ヶ月後）すべてに回答した人数', all3('c'), all3('p'), '3時点の推移グラフはこの人数で計算', INT);
  line('n_d1', '変化を算出できる人数（鑑定前→直後）', '=COUNT(' + pr_('c_d1_self') + ')', '=COUNT(' + pr_('p_d1_self') + ')', '', INT);
  line('n_d3', '変化を算出できる人数（鑑定前→3ヶ月後）', '=COUNT(' + pr_('c_d3_self') + ')', '=COUNT(' + pr_('p_d3_self') + ')', '最終的な変化の分母になる人数(N)', INT);

  // --- 2. スコア（3時点） ---
  section('2. スコアの変化（4段階：数字が大きいほど良い状態）');
  head('指標', 'お子様', '保護者', '定義');
  CORE_SCORES.forEach(s => {
    const f = (w, what) => {
      const b = pr_(w + '_base_' + s.key), i = pr_(w + '_imm_' + s.key), p = pr_(w + '_post_' + s.key);
      const trip = ',' + b + ',">0",' + i + ',">0",' + p + ',">0"';
      if (what === 'base') return '=IFERROR(AVERAGEIFS(' + b + trip + '),"")';
      if (what === 'imm') return '=IFERROR(AVERAGEIFS(' + i + trip + '),"")';
      if (what === 'post') return '=IFERROR(AVERAGEIFS(' + p + trip + '),"")';
      if (/^d[123]$/.test(what)) return '=IFERROR(AVERAGE(' + pr_(w + '_' + what + '_' + s.key) + '),"")';
      const j = pr_(w + '_j3_' + s.key), d = pr_(w + '_d3_' + s.key);
      const lab = { up3: JUDGE.UP, flat3: JUDGE.FLAT, down3: JUDGE.DOWN }[what];
      return '=IFERROR(COUNTIF(' + j + ',' + q_(lab) + ')/COUNT(' + d + '),"")';
    };
    const note = s.key === 'anx' ? '＋＝不安が軽くなった（数字が大きいほど不安が少ない）' : '';
    line(s.key + '_base', s.label + '｜鑑定前（平均）', f('c', 'base'), f('p', 'base'), '3時点すべてに回答した人のみ', NUM);
    line(s.key + '_imm', s.label + '｜鑑定直後（平均）', f('c', 'imm'), f('p', 'imm'), '', NUM);
    line(s.key + '_post', s.label + '｜3ヶ月後（平均）', f('c', 'post'), f('p', 'post'), '', NUM);
    line(s.key + '_d1', s.label + '｜平均変化量 鑑定前→鑑定直後', f('c', 'd1'), f('p', 'd1'), '鑑定による直後の変化' + (note ? '。' + note : ''), DELTA);
    line(s.key + '_d2', s.label + '｜平均変化量 鑑定直後→3ヶ月後', f('c', 'd2'), f('p', 'd2'), '変化の維持・発展', DELTA);
    line(s.key + '_d3', s.label + '｜平均変化量 鑑定前→3ヶ月後', f('c', 'd3'), f('p', 'd3'), '最終的な変化', DELTA);
    line(s.key + '_up3', s.label + '｜「改善」の割合（鑑定前→3ヶ月後）', f('c', 'up3'), f('p', 'up3'), '変化量≧+しきい値', PCT);
    line(s.key + '_flat3', s.label + '｜「変化なし」の割合', f('c', 'flat3'), f('p', 'flat3'), '', PCT);
    line(s.key + '_down3', s.label + '｜「低下」の割合', f('c', 'down3'), f('p', 'down3'), '変化量≦−しきい値', PCT);
  });
  line('value_imm', '参考｜鑑定直後の納得・参考度（平均）', '=IFERROR(AVERAGE(' + pr_('c_imm_value') + '),"")', '=IFERROR(AVERAGE(' + pr_('p_imm_value') + '),"")', '満足度のみで価値判断しないための参考値', NUM);
  line('talk_imm', '参考｜親子の進路対話（直後・平均）', '', '=IFERROR(AVERAGE(' + pr_('p_imm_talk') + '),"")', '保護者のみ', NUM);
  line('talk_post', '参考｜親子の進路対話（3ヶ月後・平均）', '', '=IFERROR(AVERAGE(' + pr_('p_post_talk') + '),"")', '保護者のみ', NUM);
  line('talk_delta', '参考｜親子の進路対話の平均変化量（直後→3ヶ月後）', '', '=IFERROR(AVERAGE(' + pr_('p_d_talk') + '),"")', '保護者のみ', DELTA);

  // --- 3. 行動・結果 ---
  section('3. 主体的な行動と進路の結果（3ヶ月後）'); head('指標', 'お子様', '保護者', '定義');
  line('action_avg', '主体的行動スコア（平均 1〜4）', '=IFERROR(AVERAGE(' + pr_('c_action') + '),"")', '=IFERROR(AVERAGE(' + pr_('p_action') + '),"")',
    '1=全く行動していない／2=少し／3=何度か／4=継続して。行動の「強度」を見る', NUM);
  line('act_rate', '行動率（少しでも行動した）', rate(pr_('c_action'), 2), rate(pr_('p_action'), 2), '主体的行動スコアが2以上の割合', PCT);
  line('act_habit', '何度か以上行動した割合', rate(pr_('c_action'), 3), rate(pr_('p_action'), 3), 'スコアが3以上', PCT);
  line('act_cont', '継続して行動した割合', rate(pr_('c_action'), 4), rate(pr_('p_action'), 4), 'スコアが4', PCT);
  line('status_avg', '進路状況の平均（1〜6）', '=IFERROR(AVERAGE(' + pr_('c_status') + '),"")', '=IFERROR(AVERAGE(' + pr_('p_status') + '),"")', '1=まだ何も決まっていない 〜 6=実際に始めた', NUM);
  line('dir_rate', '方向性決定率', rate(pr_('c_status'), STATUS_DIRECTION_MIN), rate(pr_('p_status'), STATUS_DIRECTION_MIN), '進路状況が「候補がいくつか決まった」以上', PCT);
  line('concrete_rate', '具体的進路決定率', rate(pr_('c_status'), STATUS_CONCRETE_MIN), rate(pr_('p_status'), STATUS_CONCRETE_MIN), '「具体的な進路を決めた」「実際に始めた」', PCT);

  section('4. 進路状況の分布（人数）'); head('進路状況', 'お子様', '保護者', '');
  STATUS6.forEach((lab, i) => line('status_' + (i + 1), STATUS_SHORT[i] + '：' + lab,
    '=COUNTIF(' + pr_('c_status') + ',' + (i + 1) + ')', '=COUNTIF(' + pr_('p_status') + ',' + (i + 1) + ')', '', INT));

  section('5. 3ヶ月間の行動内容（お子様・複数回答）'); head('行動内容', '人数', '回答者に対する割合', '');
  CHILD_ACTIONS.forEach((lab, i) => {
    const r = pr_('c_actions');
    line('ca_' + i, lab, '=' + cntOpt_(r, lab), '=IFERROR(B' + (rows.length + 1) + '/COUNTIF(' + r + ',"?*"),"")', '', INT);
    fmts.push({ n: rows.length, fmt: INT, col: 2 }); fmts.push({ n: rows.length, fmt: PCT, col: 3 });
  });

  // --- 6. 鑑定の活用・影響 ---
  section('6. 鑑定の活用・影響（本人が感じた度合い）'); head('指標', 'お子様', '保護者', '定義');
  line('use_rate', '鑑定活用率', rate(pr_('c_use'), 3), '', '「鑑定で知った特徴を進路を考えるとき意識した」で3または4（お子様のみ）', PCT);
  line('impact_rate', '鑑定影響率（主観評価）', rate(pr_('c_impact'), 3), rate(pr_('p_impact'), 3), '「鑑定がなかった場合と比べ影響があった」で3または4。因果の証明ではなく本人の感じた影響度', PCT);
  line('selfchange_rate', '保護者の向き合い方が変わった割合', '', rate(pr_('p_selfchange'), 3), '保護者のみ', PCT);

  section('7. 「鑑定がなかった場合」の回答分布（人数）'); head('もし鑑定を受けていなかったら', 'お子様', '保護者', '');
  CF_OPTIONS.forEach((lab, i) => line('cf_' + i, CF_SHORT[i] + '：' + lab,
    '=COUNTIF(' + pr_('c_cf') + ',"' + lab + '")', '=COUNTIF(' + pr_('p_cf') + ',"' + lab + '")', '', INT));
  line('cf_total', '回答者数', '=COUNTIF(' + pr_('c_cf') + ',"?*")', '=COUNTIF(' + pr_('p_cf') + ',"?*")', '', INT);
  const cfEff = (w, col) => '=IFERROR((' + [1, 2, 3, 4].map(k => col + reg['cf_' + k]).join('+') + ')/' + col + reg.cf_total + ',"")';
  line('cf_effect', '具体的な影響を感じた割合', cfEff('c', 'B'), cfEff('p', 'C'),
    '「今とあまり変わらない」「その他」以外（考えるのが遅い／進路不明／何をすれば不明／行動が少ない）を選んだ割合。主観評価', PCT);

  // --- 8. 検証の流れ（相関） ---
  section('8. 検証の流れ（変化どうしの関係の強さ r。因果ではありません）'); head('組み合わせ', 'お子様 r', '保護者 r', 'N（子／保）');
  const corrRow = (key, label, xk, yk) => {
    const xc = pr_('c_' + xk), yc = pr_('c_' + yk), xp = pr_('p_' + xk), yp = pr_('p_' + yk);
    line(key, label, corrF_(xc, yc), corrF_(xp, yp),
      '="N="&' + nPair_(xc, yc) + '&" ／ "&' + nPair_(xp, yp), '0.00');
  };
  corrRow('r_self_axis', '自己理解の変化 × 判断軸の変化（鑑定前→3ヶ月後）', 'd3_self', 'd3_axis');
  corrRow('r_axis_clarity', '判断軸の変化 × 進路の明確さの変化', 'd3_axis', 'd3_clarity');
  corrRow('r_clarity_action', '進路の明確さの変化 × 主体的行動スコア', 'd3_clarity', 'action');
  corrRow('r_action_status', '主体的行動スコア × 進路状況', 'action', 'status');
  corrRow('r_self_action', '自己理解の変化 × 主体的行動スコア', 'd3_self', 'action');
  corrRow('r_clarity_status', '進路の明確さの変化 × 進路状況', 'd3_clarity', 'status');

  section('9. お子様と保護者の差（3ヶ月後・同じ家庭内）'); head('指標', '平均差(保護者−子ども)', '', '');
  CORE_SCORES.forEach(s => line('gap_' + s.key, s.label + '｜3ヶ月後スコアの差', '=IFERROR(AVERAGE(' + pr_('gap_' + s.key) + '),"")', '', '＋＝保護者のほうが高い評価', DELTA));
  line('match_rate', '進路状況の一致率', '=IFERROR(AVERAGE(' + pr_('match_status') + '),"")', '', '同一家庭で子ども・保護者の回答が一致した割合', PCT);

  // 書き込み
  const maxW = 4;
  rows.forEach(r => { while (r.length < maxW) r.push(''); });
  ensureSize_(sh, rows.length + 2, 12);
  sh.getRange(1, 1, rows.length, maxW).setValues(rows);
  styleTitle_(sh.getRange(1, 1));
  sh.getRange(2, 1).setFontColor('#990000').setFontSize(9);
  sections.forEach(n => sh.getRange(n, 1, 1, maxW).setBackground('#d9e2f3').setFontWeight('bold'));
  heads.forEach(n => sh.getRange(n, 1, 1, maxW).setBackground('#f3f3f3').setFontWeight('bold'));
  fmts.forEach(f => {
    if (f.col) sh.getRange(f.n, f.col).setNumberFormat(f.fmt);
    else sh.getRange(f.n, 2, 1, 2).setNumberFormat(f.fmt);
  });
  sh.setColumnWidth(1, 470); sh.setColumnWidth(2, 110); sh.setColumnWidth(3, 110); sh.setColumnWidth(4, 420);
  sh.getRange(1, 2, rows.length, 2).setHorizontalAlignment('right');
  sh.setFrozenRows(2);

  // --- グラフ用データ（F列以降） ---
  const refB = (k) => '=B' + reg[k];
  const refC = (k) => '=C' + reg[k];
  const chart = {};
  let r0 = 3;
  sh.getRange(r0 - 1, 6).setValue('▼ グラフ用データ').setFontWeight('bold');
  // グラフ1・2：5スコアの 鑑定前→直後→3ヶ月後（お子様／保護者）
  [['b1', 'お子様', refB], ['b2', '保護者', refC]].forEach(g => {
    const b = [['スコア', g[1] + ' 鑑定前', g[1] + ' 鑑定直後', g[1] + ' 3ヶ月後']];
    CORE_SCORES.forEach(s => b.push([s.label, g[2](s.key + '_base'), g[2](s.key + '_imm'), g[2](s.key + '_post')]));
    sh.getRange(r0, 6, b.length, 4).setValues(b); chart[g[0]] = { row: r0, n: b.length, cols: 4 };
    sh.getRange(r0 + 1, 7, 5, 3).setNumberFormat(NUM);
    r0 += b.length + 2;
  });
  // グラフ3：進路状況
  const b3 = [['進路状況', 'お子様', '保護者']];
  STATUS_SHORT.forEach((lab, i) => b3.push([lab, refB('status_' + (i + 1)), refC('status_' + (i + 1))]));
  sh.getRange(r0, 6, b3.length, 3).setValues(b3); chart.b3 = { row: r0, n: b3.length, cols: 3 };
  r0 += b3.length + 2;
  // グラフ4：行動内容（お子様）
  const b4 = [['行動内容', '人数']];
  CHILD_ACTIONS.forEach((lab, i) => b4.push([lab, refB('ca_' + i)]));
  sh.getRange(r0, 6, b4.length, 2).setValues(b4); chart.b4 = { row: r0, n: b4.length, cols: 2 };
  r0 += b4.length + 2;
  // グラフ5：「鑑定がなかった場合」
  const b5 = [['もし鑑定を受けていなかったら', 'お子様', '保護者']];
  CF_SHORT.forEach((lab, i) => b5.push([lab, refB('cf_' + i), refC('cf_' + i)]));
  sh.getRange(r0, 6, b5.length, 3).setValues(b5); chart.b5 = { row: r0, n: b5.length, cols: 3 };
  r0 += b5.length + 2;
  // グラフ6：鑑定活用度（1〜4）× 主体的行動スコア（お子様）
  const b6 = [['鑑定活用度（お子様）', '主体的行動スコア平均', '人数']];
  SCALE4.forEach((lab, i) => {
    const c = pr_('c_use'), a = pr_('c_action');
    b6.push([(i + 1) + ' ' + lab, '=IFERROR(AVERAGEIFS(' + a + ',' + c + ',' + (i + 1) + '),"")', '=COUNTIFS(' + c + ',' + (i + 1) + ',' + a + ',">=1")']);
  });
  sh.getRange(r0, 6, b6.length, 3).setValues(b6); chart.b6 = { row: r0, n: b6.length, cols: 3 };
  sh.getRange(r0 + 1, 7, 4, 1).setNumberFormat(NUM);
  for (let c = 6; c <= 10; c++) sh.setColumnWidth(c, c === 6 ? 260 : 130);

  reg._chart = chart;
  return reg;
}

// ############################################################################
// ## 12. クロス集計（重要な7つの分析＋親子比較）
// ############################################################################

function buildCrossSheet_(ss) {
  const sh = resetSheet_(ss, SHEET.CROSS);
  ensureSize_(sh, 260, 8);
  const rows = []; const sections = []; const heads = []; const pcts = []; const nums = []; const deltas = [];
  const push = (arr) => { while (arr.length < 7) arr.push(''); rows.push(arr); return rows.length; };
  const NOTE = (r) => '=IF(B' + r + '<KAGAMI_MIN_N,"参考値（Nが少ない）","")';

  push(['クロス集計（鑑定 → 自己理解 → 判断軸 → 進路の明確さ → 主体的行動 → 進路の具体化）']);
  push(['※ 各グループの人数(N)が少ないうちは傾向として扱わず「参考値」としてください。関係の強さは因果を意味しません。変化＝鑑定前→3ヶ月後（最終的な変化）。']);

  const judgeGroups = [JUDGE.UP, JUDGE.FLAT, JUDGE.DOWN].map(l => ({ label: l, crit: q_(l) }));
  const levelGroups = SCALE4.map((l, i) => ({ label: (i + 1) + ' ' + l, crit: String(i + 1) }));
  const actionGroups = ACTION4.map((l, i) => ({ label: (i + 1) + ' ' + l, crit: String(i + 1) }));

  /** グループ別に「結果」を集計する汎用テーブル */
  const table = (title, who, groupKey, groups, kind) => {
    const g = pr_(groupKey);
    sections.push(push([title]));
    let h;
    if (kind === 'actscore') h = ['グループ', '人数(N)', '主体的行動スコア平均(1-4)', '行動率(少しでも)', '何度か以上(3-4)', '継続して行動(4)', '注意'];
    else if (kind === 'status') h = ['グループ', '人数(N)', '進路状況の平均(1-6)', '方向性決定率', '具体的進路決定率', '', '注意'];
    else h = ['グループ', '人数(N)', '進路の明確さ 変化量の平均', '「改善」の割合', '', '', '注意'];
    heads.push(push(h));
    groups.forEach(gr => {
      const n = rows.length + 1;
      let o;
      if (kind === 'actscore') {
        const a = pr_(who + '_action');
        o = [gr.label, '=COUNTIFS(' + g + ',' + gr.crit + ',' + a + ',">=1")', '=IFERROR(AVERAGEIFS(' + a + ',' + g + ',' + gr.crit + '),"")',
          '=IFERROR(COUNTIFS(' + g + ',' + gr.crit + ',' + a + ',">=2")/B' + n + ',"")',
          '=IFERROR(COUNTIFS(' + g + ',' + gr.crit + ',' + a + ',">=3")/B' + n + ',"")',
          '=IFERROR(COUNTIFS(' + g + ',' + gr.crit + ',' + a + ',">=4")/B' + n + ',"")', NOTE(n)];
        nums.push('C' + n); pcts.push('D' + n, 'E' + n, 'F' + n);
      } else if (kind === 'status') {
        const s = pr_(who + '_status');
        o = [gr.label, '=COUNTIFS(' + g + ',' + gr.crit + ',' + s + ',">=1")', '=IFERROR(AVERAGEIFS(' + s + ',' + g + ',' + gr.crit + '),"")',
          '=IFERROR(COUNTIFS(' + g + ',' + gr.crit + ',' + s + ',">=' + STATUS_DIRECTION_MIN + '")/B' + n + ',"")',
          '=IFERROR(COUNTIFS(' + g + ',' + gr.crit + ',' + s + ',">=' + STATUS_CONCRETE_MIN + '")/B' + n + ',"")', '', NOTE(n)];
        nums.push('C' + n); pcts.push('D' + n, 'E' + n);
      } else {
        const d = pr_(who + '_d3_clarity'), j = pr_(who + '_j3_clarity');
        o = [gr.label, '=COUNTIFS(' + g + ',' + gr.crit + ',' + d + ',">-10")', '=IFERROR(AVERAGEIFS(' + d + ',' + g + ',' + gr.crit + '),"")',
          '=IFERROR(COUNTIFS(' + g + ',' + gr.crit + ',' + j + ',' + q_(JUDGE.UP) + ')/B' + n + ',"")', '', '', NOTE(n)];
        deltas.push('C' + n); pcts.push('D' + n);
      }
      push(o);
    });
    push(['']);
  };

  [['c', '【お子様】'], ['p', '【保護者】']].forEach(w => {
    push([w[1]]); sections.push(rows.length);
    table('分析1｜自己理解が上がった人ほど、主体的に行動しているか（自己理解の変化 × 主体的行動）', w[0], w[0] + '_j3_self', judgeGroups, 'actscore');
    table('分析2｜判断軸が上がった人ほど、進路が明確になっているか（判断軸の変化 × 進路の明確さの変化）', w[0], w[0] + '_j3_axis', judgeGroups, 'clarity');
    table('分析3｜進路の明確さが上がった人ほど、実際に進路を決めているか（明確さの変化 × 進路状況）', w[0], w[0] + '_j3_clarity', judgeGroups, 'status');
    if (w[0] === 'c') table('分析4｜鑑定を強く活用した人ほど、行動しているか（鑑定活用度 × 主体的行動）', 'c', 'c_use', levelGroups, 'actscore');
    table('分析5｜鑑定の影響を強く感じた人ほど、進路が進んでいるか（鑑定影響度 × 進路状況）', w[0], w[0] + '_impact', levelGroups, 'status');
    table('分析7｜主体的行動スコア別に見た進路状況（主体的行動 × 進路状況）', w[0], w[0] + '_action', actionGroups, 'status');
  });

  // 分析6：相関（自己理解の変化量と主体的行動スコアほか）
  sections.push(push(['分析6｜変化量どうし・行動と進路の関係の強さ（相関係数 r：−1〜+1。因果ではありません）']));
  heads.push(push(['組み合わせ', 'お子様 r', 'お子様 N', '保護者 r', '保護者 N', '読み方（お子様）', '']));
  [
    ['自己理解の変化量 × 主体的行動スコア', 'd3_self', 'action'],
    ['自己理解の変化量 × 判断軸の変化量', 'd3_self', 'd3_axis'],
    ['判断軸の変化量 × 進路の明確さの変化量', 'd3_axis', 'd3_clarity'],
    ['進路の明確さの変化量 × 主体的行動スコア', 'd3_clarity', 'action'],
    ['主体的行動スコア × 進路状況(1-6)', 'action', 'status'],
    ['進路の明確さの変化量 × 進路状況(1-6)', 'd3_clarity', 'status'],
    ['鑑定活用度 × 主体的行動スコア（お子様のみ）', 'use', 'action'],
    ['鑑定影響度 × 進路状況(1-6)', 'impact', 'status'],
    ['鑑定影響度 × 進路の明確さの変化量', 'impact', 'd3_clarity'],
  ].forEach(c => {
    const n = rows.length + 1;
    const isUse = c[1] === 'use';
    push([c[0],
      corrF_(pr_('c_' + c[1]), pr_('c_' + c[2])), '=' + nPair_(pr_('c_' + c[1]), pr_('c_' + c[2])),
      isUse ? '' : corrF_(pr_('p_' + c[1]), pr_('p_' + c[2])), isUse ? '' : '=' + nPair_(pr_('p_' + c[1]), pr_('p_' + c[2])),
      readCorr_('B' + n, 'C' + n), '']);
    nums.push('B' + n, 'D' + n);
  });
  push(['']);

  // 分析F：子ども × 保護者
  sections.push(push(['分析8｜お子様の回答 × 保護者の回答']));
  heads.push(push(['指標', 'お子様', '保護者', '差（保護者−お子様）', '備考']));
  CORE_SCORES.forEach(s => {
    const n = rows.length + 1;
    push([s.label + '｜3ヶ月後スコア（平均）', '=IFERROR(AVERAGE(' + pr_('c_post_' + s.key) + '),"")', '=IFERROR(AVERAGE(' + pr_('p_post_' + s.key) + '),"")',
      '=IFERROR(AVERAGE(' + pr_('gap_' + s.key) + '),"")', '差は同じ家庭どうしの平均差']);
    nums.push('B' + n, 'C' + n, 'D' + n);
  });
  CORE_SCORES.forEach(s => {
    const n = rows.length + 1;
    push([s.label + '｜平均変化量（鑑定前→3ヶ月後）', '=IFERROR(AVERAGE(' + pr_('c_d3_' + s.key) + '),"")', '=IFERROR(AVERAGE(' + pr_('p_d3_' + s.key) + '),"")',
      '=IFERROR(C' + n + '-B' + n + ',"")', '']);
    deltas.push('B' + n, 'C' + n, 'D' + n);
  });
  [['主体的行動スコア（平均）', 'action', 0], ['行動率（少しでも）', 'action', 2], ['方向性決定率', 'status', STATUS_DIRECTION_MIN],
   ['具体的進路決定率', 'status', STATUS_CONCRETE_MIN], ['鑑定影響率（主観）', 'impact', 3]].forEach(m => {
    const n = rows.length + 1;
    if (m[2] === 0) {
      push([m[0], '=IFERROR(AVERAGE(' + pr_('c_' + m[1]) + '),"")', '=IFERROR(AVERAGE(' + pr_('p_' + m[1]) + '),"")', '=IFERROR(C' + n + '-B' + n + ',"")', '']);
      nums.push('B' + n, 'C' + n, 'D' + n);
    } else {
      push([m[0], '=IFERROR(COUNTIF(' + pr_('c_' + m[1]) + ',">=' + m[2] + '")/COUNT(' + pr_('c_' + m[1]) + '),"")',
        '=IFERROR(COUNTIF(' + pr_('p_' + m[1]) + ',">=' + m[2] + '")/COUNT(' + pr_('p_' + m[1]) + '),"")', '=IFERROR(C' + n + '-B' + n + ',"")', '']);
      pcts.push('B' + n, 'C' + n, 'D' + n);
    }
  });
  {
    const n = rows.length + 1;
    push(['進路状況の一致率（同一家庭）', '=IFERROR(AVERAGE(' + pr_('match_status') + '),"")', '', '', '子ども・保護者の回答が一致した割合']);
    pcts.push('B' + n);
  }

  ensureSize_(sh, rows.length + 2, 8);
  sh.getRange(1, 1, rows.length, 7).setValues(rows);
  styleTitle_(sh.getRange(1, 1));
  sh.getRange(2, 1).setFontColor('#990000').setFontSize(9);
  sections.forEach(n => sh.getRange(n, 1, 1, 7).setBackground('#d9e2f3').setFontWeight('bold'));
  heads.forEach(n => sh.getRange(n, 1, 1, 7).setBackground('#f3f3f3').setFontWeight('bold').setWrap(true));
  if (pcts.length) sh.getRangeList(pcts).setNumberFormat('0.0%');
  if (nums.length) sh.getRangeList(nums).setNumberFormat('0.00');
  if (deltas.length) sh.getRangeList(deltas).setNumberFormat('+0.00;-0.00;0.00');
  [330, 90, 140, 140, 140, 150, 140].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.setFrozenRows(2);
}

// ############################################################################
// ## 13. ケーススタディ用データ
// ############################################################################

function SHEET_Q_(name) { return "'" + name + "'"; }

function buildCaseSheet_(ss) {
  const sh = resetSheet_(ss, SHEET.CASE);
  const N = APP.MAX_SUBJECTS;
  const F = PERSON.FIRST;
  const P = (k) => SHEET_Q_(SHEET.PERSON) + '!' + pcol_(k).letter;
  const sl = (idx) => colLetter_(idx);
  const subj = (colIdx, r) => 'IFERROR(INDEX(' + SHEET_Q_(SHEET.SUBJECTS) + '!$' + sl(colIdx) + '$2:$' + sl(colIdx) + '$' + (APP.MAX_SUBJECTS + 1) +
    ',MATCH($A' + r + ',' + SHEET_Q_(SHEET.SUBJECTS) + '!$A$2:$A$' + (APP.MAX_SUBJECTS + 1) + ',0)),"")';
  const statusChoose = (cell) => 'IF(ISNUMBER(' + cell + '),CHOOSE(' + cell + ',' + STATUS6.map(q_).join(',') + '),"")';
  const actionLabel = (cell) => 'IF(ISNUMBER(' + cell + '),CHOOSE(' + cell + ',' + ACTION4.map(q_).join(',') + '),"")';
  const R = (r) => 3 + r;
  const ref = (k) => (r) => '=IF($A' + R(r) + '="","",' + P(k) + (F + r) + ')';

  const defs = [
    ['対象者ID', (r) => '=IF(' + P('id') + (F + r) + '="","",' + P('id') + (F + r) + ')', 100],
    ['学年区分', (r) => '=IF($A' + R(r) + '="","",' + subj(SUBJ.GRADE, R(r)) + ')', 80],
    ['初回アンケートの主な悩み（カテゴリ）', (r) => '=IF($A' + R(r) + '="","",' + subj(SUBJ.CONCERN, R(r)) + ')', 160],
    ['初回アンケートの悩み（要約）', (r) => '=IF($A' + R(r) + '="","",' + subj(SUBJ.SUMMARY, R(r)) + ')', 220],
    ['自己理解の変化(子)', ref('c_d3_self'), 80],
    ['判断軸の変化(子)', ref('c_d3_axis'), 80],
    ['進路の明確さの変化(子)', ref('c_d3_clarity'), 90],
    ['自己決定・自己肯定の変化(子)', ref('c_d3_decide'), 100],
    ['不安の少なさの変化(子)', ref('c_d3_anx'), 90],
    ['主体的行動スコア(子 1-4)', ref('c_action'), 90],
    ['行動の強さ(子)', (r) => '=IF($A' + R(r) + '="","",' + actionLabel(P('c_action') + (F + r)) + ')', 130],
    ['進路結果(子)', (r) => '=IF($A' + R(r) + '="","",' + statusChoose(P('c_status') + (F + r)) + ')', 180],
    ['鑑定活用(子 1-4)', ref('c_use'), 80],
    ['鑑定影響(子 1-4)', ref('c_impact'), 80],
    ['鑑定がなかった場合(子)', ref('c_cf'), 230],
    ['進路の明確さの変化(保護者)', ref('p_d3_clarity'), 100],
    ['主体的行動スコア(保護者 1-4)', ref('p_action'), 100],
    ['進路結果(保護者)', (r) => '=IF($A' + R(r) + '="","",' + statusChoose(P('p_status') + (F + r)) + ')', 180],
    ['鑑定影響(保護者 1-4)', ref('p_impact'), 90],
    ['鑑定がなかった場合(保護者)', ref('p_cf'), 230],
    ['3ヶ月間に行ったこと(子)', ref('c_actions'), 260],
    ['鑑定直後の気づき(子)', ref('c_imm_text'), 260],
    ['鑑定直後の気づき(保護者)', ref('p_imm_text'), 260],
    ['「鑑定がなかった場合」の理由(子)', ref('c_cf_reason'), 260],
    ['「鑑定がなかった場合」の理由(保護者)', ref('p_cf_reason'), 260],
    ['3ヶ月後の変化・気づき(子)', ref('c_post_text'), 280],
    ['3ヶ月後の変化・気づき(保護者)', ref('p_post_text'), 280],
    ['事例掲載の許可', (r) => '=IF($A' + R(r) + '="","",' + subj(SUBJ.PERMIT, R(r)) + ')', 80],
  ];
  ensureSize_(sh, F + N, defs.length);
  sh.getRange('A1').setValue('ケーススタディ用データ（実際の回答のみを表示。ストーリーの自動生成は行いません。変化は鑑定前→3ヶ月後）');
  styleTitle_(sh.getRange('A1'));
  sh.getRange(2, 1, 1, defs.length).setValues([defs.map(d => d[0])]);
  styleHeader_(sh.getRange(2, 1, 1, defs.length));
  sh.setRowHeight(2, 52);
  defs.forEach((d, ci) => {
    const f = [];
    for (let r = 0; r < N; r++) f.push([d[1](r)]);
    sh.getRange(3, ci + 1, N, 1).setFormulas(f);
    sh.setColumnWidth(ci + 1, d[2]);
  });
  sh.getRange(3, 5, N, 5).setNumberFormat('+0.00;-0.00;0.00');
  sh.getRange(3, 16, N, 1).setNumberFormat('+0.00;-0.00;0.00');
  sh.getRange(3, 15, N, 15).setWrap(true).setVerticalAlignment('top');
  sh.setFrozenRows(2); sh.setFrozenColumns(1);
  sh.getRange('A2').setNote('「鑑定前の悩み」は3ヶ月後には再質問しません。初回アンケートの内容を 対象者管理 の「悩み」列に転記してください。\n掲載の許可が「○」のものだけを外部で使用してください。');
}

// ############################################################################
// ## 14. ダッシュボード
// ############################################################################

function buildDashboard_(ss, reg) {
  const sh = resetSheet_(ss, SHEET.DASH);
  const aggS = ss.getSheetByName(SHEET.AGG);
  ensureSize_(sh, 220, 13);
  sh.setHiddenGridlines(true);
  const ag = (k, c) => "'" + SHEET.AGG + "'!$" + c + '$' + reg[k];
  sh.setColumnWidth(1, 14);
  for (let c = 2; c <= 13; c++) sh.setColumnWidth(c, 112);
  const GREEN = '#d9ead3', RED = '#f4cccc';
  const rules = [];
  const colorJudge = (a1) => {
    const rg = sh.getRange(a1);
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(JUDGE.UP).setBackground(GREEN).setRanges([rg]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(JUDGE.DOWN).setBackground(RED).setRanges([rg]).build());
  };
  const title = (row, text) => {
    const rg = sh.getRange(row, 2, 1, 12).merge();
    rg.setValue(text).setBackground('#1f3a5f').setFontColor('#ffffff').setFontWeight('bold').setFontSize(12).setVerticalAlignment('middle');
    sh.setRowHeight(row, 28);
  };
  const judgeF = (cell, single) => {
    const t = single ? 'KAGAMI_THRESHOLD_1' : 'KAGAMI_THRESHOLD_2';
    return '=IF(ISNUMBER(' + cell + '),IF(' + cell + '>=' + t + ',"' + JUDGE.UP + '",IF(' + cell + '<=-' + t + ',"' + JUDGE.DOWN + '","' + JUDGE.FLAT + '")),"-")';
  };
  /** B:E 結合のラベル / F お子様 / G 保護者 / H:M 結合の説明 の1行 */
  const kvRow = (row, label, fC, fP, note, fmt, style) => {
    sh.getRange(row, 2, 1, 4).merge().setValue(label).setWrap(true).setVerticalAlignment('middle');
    sh.getRange(row, 6).setFormula(fC || '=""');
    sh.getRange(row, 7).setFormula(fP || '=""');
    if (fmt) sh.getRange(row, 6, 1, 2).setNumberFormat(fmt);
    sh.getRange(row, 6, 1, 2).setHorizontalAlignment('center').setFontWeight('bold');
    const nr = sh.getRange(row, 8, 1, 6).merge();
    if (String(note).charAt(0) === '=') nr.setFormula(note); else nr.setValue(note);
    nr.setFontColor('#666666').setFontSize(10).setWrap(true).setVerticalAlignment('middle');
    if (style === 'arrow') sh.getRange(row, 2, 1, 12).setBackground('#f3f3f3').setFontStyle('italic');
    sh.setRowHeight(row, 32);
  };
  const header3 = (row, a, b, c, d) => {
    sh.getRange(row, 2, 1, 4).merge().setValue(a);
    sh.getRange(row, 6).setValue(b); sh.getRange(row, 7).setValue(c);
    sh.getRange(row, 8, 1, 6).merge().setValue(d);
    sh.getRange(row, 2, 1, 12).setBackground('#f3f3f3').setFontWeight('bold').setHorizontalAlignment('center');
  };

  // タイトル
  sh.getRange('B1:M1').merge().setValue('KAGAMI 成果ダッシュボード').setFontSize(22).setFontWeight('bold').setFontColor('#1f3a5f');
  sh.setRowHeight(1, 40);
  sh.getRange('B2:M2').merge().setValue('鑑定 → 自己理解 → 判断軸 → 進路の明確さ → 主体的な行動 → 進路の具体化。数値は回答者の自己評価・報告に基づき、因果関係の証明ではありません。')
    .setFontColor('#666666').setWrap(true);
  sh.getRange('B3:M3').merge().setFormula('=IF(N(' + ag('n_d3', 'B') + ')<KAGAMI_MIN_N,"⚠ 鑑定前→3ヶ月後の変化を算出できる人数が "&N(' + ag('n_d3', 'B') +
    ')&" 名（目安 "&KAGAMI_MIN_N&" 名未満）です。現時点の数値は参考値であり、傾向や効果として断定しないでください。","")')
    .setFontColor('#990000').setFontWeight('bold').setWrap(true);
  sh.setRowHeight(3, 30);

  // 1. 基本数値（カード6枚）
  title(5, '1. 基本数値');
  const cards = [
    ['鑑定人数', '=' + ag('subjects', 'B'), '0'],
    ['鑑定前 回答数（子／保）', '=' + ag('n_base', 'B') + '&" / "&' + ag('n_base', 'C'), '@'],
    ['鑑定直後 回答数（子／保）', '=' + ag('n_imm', 'B') + '&" / "&' + ag('n_imm', 'C'), '@'],
    ['3ヶ月後 回答数（子／保）', '=' + ag('n_post', 'B') + '&" / "&' + ag('n_post', 'C'), '@'],
    ['3ヶ月後 回答率', '=' + ag('resp_rate', 'B'), '0.0%'],
    ['3時点そろった人数（子／保）', '=' + ag('n_all3', 'B') + '&" / "&' + ag('n_all3', 'C'), '@'],
  ];
  cards.forEach((c, i) => {
    const col = 2 + i * 2;
    sh.getRange(6, col, 1, 2).merge().setValue(c[0]).setFontColor('#666666').setHorizontalAlignment('center').setFontSize(10).setWrap(true);
    const v = sh.getRange(7, col, 1, 2).merge();
    v.setFormula(c[1]).setFontSize(20).setFontWeight('bold').setHorizontalAlignment('center').setFontColor('#1f3a5f').setBackground('#eef3fb');
    if (c[2] !== '@') v.setNumberFormat(c[2]);
  });
  sh.setRowHeight(7, 46);

  // 2. 検証の流れ
  let r = 9;
  title(r++, '2. 検証の流れ：鑑定 → 自己理解 → 判断軸 → 進路の明確さ → 主体的行動 → 進路の具体化');
  header3(r++, 'ステップ（変化は鑑定前→3ヶ月後の平均変化量）', 'お子様', '保護者', '読み方');
  kvRow(r++, '① 鑑定による直後の変化（自己理解：鑑定前→直後）', '=' + ag('self_d1', 'B'), '=' + ag('self_d1', 'C'), '鑑定の直後に自己理解がどれだけ動いたか', '+0.00;-0.00;0.00');
  kvRow(r++, '② 自己理解が深まる（鑑定前→3ヶ月後）', '=' + ag('self_d3', 'B'), '=' + ag('self_d3', 'C'), '＋なら自己理解が上がっている', '+0.00;-0.00;0.00');
  kvRow(r++, '　↓ 自己理解の変化と判断軸の変化の関係（r）', '=' + ag('r_self_axis', 'B'), '=' + ag('r_self_axis', 'C'), '', '0.00', 'arrow');
  kvRow(r++, '③ 自分の判断軸が明確になる', '=' + ag('axis_d3', 'B'), '=' + ag('axis_d3', 'C'), '＋なら「大切にしたいこと」「自分に合うか」の視点が上がっている', '+0.00;-0.00;0.00');
  kvRow(r++, '　↓ 判断軸の変化と進路の明確さの変化の関係（r）', '=' + ag('r_axis_clarity', 'B'), '=' + ag('r_axis_clarity', 'C'), '', '0.00', 'arrow');
  kvRow(r++, '④ 進路が明確になる', '=' + ag('clarity_d3', 'B'), '=' + ag('clarity_d3', 'C'), '＋なら方向のイメージ・次にやることが分かってきている', '+0.00;-0.00;0.00');
  kvRow(r++, '　↓ 進路の明確さの変化と主体的行動の関係（r）', '=' + ag('r_clarity_action', 'B'), '=' + ag('r_clarity_action', 'C'), '', '0.00', 'arrow');
  kvRow(r++, '⑤ 主体的に行動する（主体的行動スコア 1〜4）', '=' + ag('action_avg', 'B'), '=' + ag('action_avg', 'C'), '1=全く行動していない／4=継続して行動した', '0.00');
  kvRow(r++, '　↓ 主体的行動と進路状況の関係（r）', '=' + ag('r_action_status', 'B'), '=' + ag('r_action_status', 'C'), '', '0.00', 'arrow');
  kvRow(r++, '⑥ 進路が具体化する（具体的進路決定率）', '=' + ag('concrete_rate', 'B'), '=' + ag('concrete_rate', 'C'), '「具体的な進路を決めた」「実際に始めた」の割合', '0.0%');
  // 矢印行の「読み方」を、お子様のrから自動判定する式に置き換える
  const flowStart = 11;
  [[flowStart + 2, 'r_self_axis'], [flowStart + 4, 'r_axis_clarity'], [flowStart + 6, 'r_clarity_action'], [flowStart + 8, 'r_action_status']].forEach(a => {
    const rowN = a[0];
    sh.getRange(rowN, 8, 1, 6).setFormula(readCorr_('F' + rowN, ag('n_d3', 'B')));
  });
  sh.getRange(r, 2, 1, 12).merge().setValue('r は「一緒に動く傾向の強さ」です（0.5以上＝強い、0.3以上＝ある程度）。Nが少ない間は参考値で、因果を意味しません。詳細は クロス集計 シートへ。')
    .setFontColor('#666666').setFontSize(9).setWrap(true);
  r += 2;

  // 3. スコアの推移（3時点）
  title(r++, '3. 5つのスコアの推移（鑑定前 → 鑑定直後 → 3ヶ月後）');
  const scoreTable = (who, col, label) => {
    const hdr = ['スコア（' + label + '）', '鑑定前', '鑑定直後', '3ヶ月後', '前→直後', '直後→3ヶ月', '前→3ヶ月', '判定', '「改善」割合'];
    sh.getRange(r, 2, 1, 2).merge().setValue(hdr[0]);
    for (let i = 1; i < hdr.length; i++) sh.getRange(r, 3 + i).setValue(hdr[i]);
    sh.getRange(r, 2, 1, 10).setBackground('#f3f3f3').setFontWeight('bold').setHorizontalAlignment('center').setWrap(true);
    sh.setRowHeight(r, 36); r++;
    const first = r;
    CORE_SCORES.forEach(s => {
      const lab = s.key === 'anx' ? '不安の少なさ（＋＝不安が軽くなった）' : s.label;
      sh.getRange(r, 2, 1, 2).merge().setValue(lab).setWrap(true);
      sh.getRange(r, 4, 1, 3).setFormulas([['=' + ag(s.key + '_base', col), '=' + ag(s.key + '_imm', col), '=' + ag(s.key + '_post', col)]]).setNumberFormat('0.00');
      sh.getRange(r, 7, 1, 3).setFormulas([['=' + ag(s.key + '_d1', col), '=' + ag(s.key + '_d2', col), '=' + ag(s.key + '_d3', col)]]).setNumberFormat('+0.00;-0.00;0.00');
      sh.getRange(r, 10).setFormula(judgeF('I' + r, !!s.single));
      sh.getRange(r, 11).setFormula('=' + ag(s.key + '_up3', col)).setNumberFormat('0%');
      sh.getRange(r, 4, 1, 8).setHorizontalAlignment('center');
      sh.setRowHeight(r, 28); r++;
    });
    colorJudge('J' + first + ':J' + (r - 1));
    r++;
  };
  scoreTable('c', 'B', 'お子様');
  scoreTable('p', 'C', '保護者');
  sh.getRange(r - 1, 2, 1, 12).merge().setValue('判定：変化量（鑑定前→3ヶ月後）が +しきい値以上＝改善／−しきい値以下＝低下／その間＝変化なし（しきい値は「設定」シート）。')
    .setFontColor('#666666').setFontSize(9).setWrap(true);
  r++;

  // 4. 行動・結果
  title(r++, '4. 主体的な行動と進路の結果（3ヶ月後）');
  header3(r++, '指標', 'お子様', '保護者', '定義');
  kvRow(r++, '主体的行動スコア（平均 1〜4）', '=' + ag('action_avg', 'B'), '=' + ag('action_avg', 'C'), '行動の強さ。1=全く／2=少し／3=何度か／4=継続して', '0.00');
  kvRow(r++, '行動率（少しでも行動した）', '=' + ag('act_rate', 'B'), '=' + ag('act_rate', 'C'), 'スコア2以上の割合', '0.0%');
  kvRow(r++, '継続して行動した割合', '=' + ag('act_cont', 'B'), '=' + ag('act_cont', 'C'), 'スコア4の割合', '0.0%');
  kvRow(r++, '方向性決定率', '=' + ag('dir_rate', 'B'), '=' + ag('dir_rate', 'C'), '進路の候補が決まった以上', '0.0%');
  kvRow(r++, '具体的進路決定率', '=' + ag('concrete_rate', 'B'), '=' + ag('concrete_rate', 'C'), '具体的な進路を決めた／実際に始めた', '0.0%');
  r++;

  // 5. 鑑定の活用・影響
  title(r++, '5. 鑑定の活用・影響（本人が感じた度合い）');
  header3(r++, '指標', 'お子様', '保護者', '定義');
  kvRow(r++, '鑑定活用率', '=' + ag('use_rate', 'B'), '', '鑑定で知った特徴を進路を考えるとき意識した（3または4）。お子様のみ', '0.0%');
  kvRow(r++, '鑑定影響率（主観評価）', '=' + ag('impact_rate', 'B'), '=' + ag('impact_rate', 'C'), '鑑定がなかった場合と比べ影響があったと感じる（3または4）', '0.0%');
  kvRow(r++, '保護者の向き合い方が変わった割合', '', '=' + ag('selfchange_rate', 'C'), '保護者のみ', '0.0%');
  r++;

  // 6. 「鑑定がなかった場合」
  title(r++, '6. 「もし鑑定を受けていなかったら」の回答分布（人数）');
  header3(r++, '選択肢', 'お子様', '保護者', '');
  CF_OPTIONS.forEach((lab, i) => kvRow(r++, lab, '=' + ag('cf_' + i, 'B'), '=' + ag('cf_' + i, 'C'), '', '0'));
  kvRow(r++, '具体的な影響を感じた割合', '=' + ag('cf_effect', 'B'), '=' + ag('cf_effect', 'C'),
    '「今とあまり変わらない」「その他」以外を選んだ割合。主観評価であり、因果の証明ではありません', '0.0%');
  r++;

  // 7. 公開用の表現例
  title(r++, '7. 実績として使うときの表現例（自動生成・Nが少ないときは公開しないでください）');
  const guard = (nRef) => 'IF(N(' + nRef + ')<KAGAMI_MIN_N,"【参考：Nが少ないため公開は控える】","")';
  [
    '=IF(ISNUMBER(' + ag('act_rate', 'B') + '),' + guard(ag('n_post', 'B')) + '&"鑑定後3ヶ月で"&TEXT(' + ag('act_rate', 'B') + ',"0%")&"の方が進路について自分から行動しました（お子様回答・N="&' + ag('n_post', 'B') + '&"）","")',
    '=IF(ISNUMBER(' + ag('use_rate', 'B') + '),' + guard(ag('n_post', 'B')) + '&TEXT(' + ag('use_rate', 'B') + ',"0%")&"の方が、鑑定で整理した自分の特徴を進路選択の参考にしています（お子様回答・N="&' + ag('n_post', 'B') + '&"）","")',
    '=IF(N(' + ag('self_d3', 'B') + ')>0,' + guard(ag('n_d3', 'B')) + '&"鑑定前と比べて、3ヶ月後の自己理解スコアが平均"&TEXT(' + ag('self_d3', 'B') + ',"0.00")&"ポイント上昇しました（お子様回答・N="&' + ag('n_d3', 'B') + '&"）","（自己理解スコアが上昇していないため、この表現は使えません）")',
    '=IF(ISNUMBER(' + ag('cf_effect', 'B') + '),' + guard(ag('cf_total', 'B')) + '&TEXT(' + ag('cf_effect', 'B') + ',"0%")&"の方が、「鑑定を受けていなかったら進路について遅れていた／行動が少なかった／分からないままだった」と感じています（本人の主観評価・N="&' + ag('cf_total', 'B') + '&"）","")',
  ].forEach(f => {
    sh.getRange(r, 2, 1, 12).merge().setFormula(f).setWrap(true).setVerticalAlignment('middle');
    sh.setRowHeight(r, 30); r++;
  });
  sh.getRange(r, 2, 1, 12).merge().setValue('NG例：「鑑定を受ければ進路が決まります」「鑑定によって必ず人生が変わります」などの断定表現')
    .setFontColor('#990000').setFontSize(9);
  r += 2;

  // 8. グラフ
  title(r++, '8. グラフ');
  const ch = reg._chart;
  const rng = (c) => aggS.getRange(c.row, 6, c.n, c.cols);
  const base = (type, c, ttl, w, h, row, col) => sh.newChart().setChartType(type).addRange(rng(c)).setNumHeaders(1)
    .setPosition(row, col, 0, 0).setOption('title', ttl).setOption('width', w).setOption('height', h)
    .setOption('legend', { position: 'bottom' });
  const W = 640, H = 320, step = 17;
  let cr = r;
  sh.insertChart(base(Charts.ChartType.COLUMN, ch.b1, 'グラフ1｜5つのスコアの推移：鑑定前→直後→3ヶ月後（お子様）', W, H, cr, 2)
    .setOption('vAxis', { viewWindow: { min: 1, max: 4 }, title: '平均（1〜4）' })
    .setOption('colors', ['#bdbdbd', '#9ecae1', '#2171b5']).build());
  sh.insertChart(base(Charts.ChartType.COLUMN, ch.b2, 'グラフ2｜5つのスコアの推移：鑑定前→直後→3ヶ月後（保護者）', W, H, cr, 8)
    .setOption('vAxis', { viewWindow: { min: 1, max: 4 }, title: '平均（1〜4）' })
    .setOption('colors', ['#bdbdbd', '#fdd0a2', '#e6550d']).build());
  cr += step;
  sh.insertChart(base(Charts.ChartType.COLUMN, ch.b3, 'グラフ3｜進路状況（人数）', W, H, cr, 2)
    .setOption('colors', ['#2171b5', '#e6550d']).build());
  sh.insertChart(base(Charts.ChartType.COLUMN, ch.b5, 'グラフ4｜「もし鑑定を受けていなかったら」の回答分布', W, H, cr, 8)
    .setOption('colors', ['#2171b5', '#e6550d']).build());
  cr += step;
  sh.insertChart(base(Charts.ChartType.BAR, ch.b4, 'グラフ5｜3ヶ月間の行動内容（お子様・複数回答）', W, 440, cr, 2)
    .setOption('legend', { position: 'none' }).setOption('colors', ['#2171b5']).build());
  sh.insertChart(base(Charts.ChartType.COLUMN, ch.b6, 'グラフ6｜鑑定活用度と主体的行動スコアの関係（お子様）', W, H, cr, 8)
    .setOption('vAxis', { viewWindow: { min: 1, max: 4 }, title: '主体的行動スコア平均（1〜4）' })
    .setOption('colors', ['#2171b5', '#bdbdbd']).build());
  sh.setConditionalFormatRules(rules);
  sh.setFrozenRows(3);
}

// ############################################################################
// ## 15. フォームURL・README
// ############################################################################

function buildUrlSheet_(ss, state) {
  const sh = resetSheet_(ss, SHEET.URLS);
  const head = ['フォーム', '回答者', '時期', '回答用URL（配布用）', '編集用URL（管理者のみ）', '回答先シート', 'フォームID'];
  const rows = FORM_ORDER.map(k => {
    const spec = specByKey_(k);
    const f = FormApp.openById(state.forms[spec.key]);
    return [spec.key + '｜' + spec.title, spec.whoLabel, spec.surveyType, f.getPublishedUrl(), f.getEditUrl(), spec.sheetName, f.getId()];
  });
  sh.getRange(1, 1, 1, head.length).setValues([head]);
  styleHeader_(sh.getRange(1, 1, 1, head.length));
  sh.getRange(2, 1, rows.length, head.length).setValues(rows).setVerticalAlignment('top');
  [300, 70, 80, 420, 420, 130, 300].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.getRange(rows.length + 3, 1).setValue('※ 配布は「回答用URL」ではなく、対象者管理シートの「事前入力URL」（IDが自動入力される）を推奨します。編集用URLは共有しないでください。')
    .setFontColor('#990000');
  sh.setFrozenRows(1);
}

function showFormUrls() {
  const st = getState_();
  if (!st) { log_('未作成です。'); return; }
  FORM_ORDER.forEach(k => {
    const spec = specByKey_(k);
    try {
      const f = FormApp.openById(st.forms[spec.key]);
      log_(spec.key + ' ' + spec.title + '\n  回答用: ' + f.getPublishedUrl() + '\n  編集用: ' + f.getEditUrl());
    } catch (e) { log_(spec.key + ': 取得失敗 ' + e); }
  });
  try { log_('スプレッドシート: ' + SpreadsheetApp.openById(st.ssId).getUrl()); } catch (e) { /* noop */ }
}

function buildReadmeSheet_(ss) {
  const sh = resetSheet_(ss, SHEET.README);
  const L = [
    ['KAGAMI 計測システム README', 'title'],
    ['鑑定前 → 鑑定直後 → 3ヶ月後 の3時点を同じ対象者IDで結び、「鑑定 → 自己理解 → 判断軸 → 進路の明確さ → 主体的な行動 → 進路の具体化」の流れを数字で検証します。', ''],
    ['', ''],
    ['■ 運用の流れ', 'h'],
    ['1. 対象者ID発行：Apps Script で issueSubjectIds() を実行（発行数は「設定」シート）。対象者管理にIDと事前入力URLが並びます。', ''],
    ['2. 鑑定前：「事前入力URL E（子ども）／F（保護者）」を送る。', ''],
    ['3. 鑑定当日：「事前入力URL A／B」を送る。対象者管理の「鑑定日」を入力すると3ヶ月後の案内予定日（目安）が出ます。', ''],
    ['4. 3ヶ月後：「事前入力URL C／D」を送る。', ''],
    ['5. 回答が送信されると自動で 回答ログ・個人別分析・全体集計・クロス集計・ケーススタディ・ダッシュボード が更新されます。', ''],
    ['', ''],
    ['■ シートの役割', 'h'],
    ['ダッシュボード：検証の流れ・3時点のスコア・行動・鑑定の影響／対象者管理：ID・属性・回答状況／鑑定前・鑑定直後・3ヶ月後の各シート：フォームの生回答（編集しない）', ''],
    ['回答ログ：回答者区分・アンケート種別・回答日時つきの縦持ちデータ／個人別分析：ID別の3時点・変化量・判定／全体集計：全指標／クロス集計：分析1〜8／ケーススタディ／質問一覧／設定／フォームURL', ''],
    ['', ''],
    ['■ 数値の見方', 'h'],
    ['・状態の質問はすべて4段階（1=全くそう思わない〜4=とてもそう思う）。数字が大きいほど良い状態。「不安の少なさ」も大きいほど不安が少ない。', ''],
    ['・変化量：鑑定前→直後（鑑定による直後の変化）／直後→3ヶ月後（変化の維持・発展）／鑑定前→3ヶ月後（最終的な変化）。判定のしきい値は設定シートで変更可。', ''],
    ['・主体的行動スコア：1=全く行動していない／2=少し行動した／3=何度か行動した／4=継続して行動した。行動の強さを平均で見ます。', ''],
    ['・鑑定影響率と「鑑定がなかった場合」は、本人が感じた影響（主観評価）であり、因果関係の証明ではありません。', ''],
    ['・相関係数 r は「一緒に動く傾向の強さ」です。人数(N)が少ないうちは参考値として扱ってください。', ''],
    ['', ''],
    ['■ 注意', 'h'],
    ['・回答シート・回答ログ・個人別分析の「入力列」は自動更新されます。手で書き換えないでください。', ''],
    ['・全フォームでお名前・メールアドレスを聞き、対象者管理（空欄のみ）と個人別分析に転記します。集計はIDで結びます。共有範囲は最小限にしてください。', ''],
    ['・ID未登録の回答は個人別分析で「未登録（要確認）」と表示されます。同じIDが同じフォームに複数回答した場合は最新の1件を集計します。', ''],
    ['・広告・LPでは断定表現を使わず、ダッシュボード7の表現例のように実データに基づいて書いてください。', ''],
  ];
  L.forEach((l, i) => {
    const c = sh.getRange(i + 1, 1).setValue(l[0]).setWrap(true).setVerticalAlignment('top');
    if (l[1] === 'title') c.setFontSize(18).setFontWeight('bold').setFontColor('#1f3a5f');
    if (l[1] === 'h') c.setFontWeight('bold').setBackground('#d9e2f3');
  });
  sh.setColumnWidth(1, 980);
}

// ############################################################################
// ## 16. 回答ポータル（1つのサイトから「お子様／保護者」→「鑑定前／鑑定直後／3ヶ月後」を選んで回答）
// ############################################################################
// 使い方：Apps Script の「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
//   次のユーザーとして実行：自分 ／ アクセスできるユーザー：全員 → 発行されたURLを配布する。
// フォームを更新しても、このURLは変わりません（コードを変えたときは「デプロイを管理」で新バージョンに更新）。

function doGet() {
  const st = getState_();
  if (!st || !st.forms) return HtmlService.createHtmlOutput('システムが未作成です。');
  const map = {};
  FORM_SPECS.forEach(spec => {
    try { map[spec.who + '_' + spec.phase] = FormApp.openById(st.forms[spec.key]).getPublishedUrl(); } catch (e) { /* noop */ }
  });
  const html = [
    '<!DOCTYPE html><html lang="ja"><head><base target="_top"><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>KAGAMI アンケート</title><style>',
    'body{margin:0;font-family:"Hiragino Sans","Noto Sans JP",sans-serif;background:#f4f6fb;color:#222}',
    '.wrap{max-width:720px;margin:0 auto;padding:24px 16px}',
    'h1{font-size:22px;color:#1f3a5f;margin:8px 0}.lead{color:#555;font-size:14px;margin-bottom:20px}',
    '.card{background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,.1);margin-bottom:16px}',
    '.btns{display:flex;gap:12px;flex-wrap:wrap}',
    'button{flex:1;min-width:160px;padding:16px;font-size:16px;border:2px solid #1f3a5f;border-radius:10px;background:#fff;color:#1f3a5f;cursor:pointer}',
    'button:hover,button.on{background:#1f3a5f;color:#fff}',
    'small{color:#777;display:block;margin-top:4px;font-size:12px;font-weight:normal}',
    '.back{background:none;border:none;color:#1f3a5f;text-decoration:underline;font-size:14px;min-width:0;padding:4px;flex:none}',
    'iframe{width:100%;height:80vh;border:0;border-radius:8px;background:#fff}',
    '.hide{display:none}</style></head><body><div class="wrap">',
    '<h1>KAGAMI 進路・自己理解アンケート</h1>',
    '<p class="lead">ご回答の種類をお選びください。正解・不正解はありません。</p>',
    '<div id="s1" class="card"><b>① どなたの回答ですか？</b><div class="btns" style="margin-top:12px">',
    '<button onclick="pick(\'c\')">お子様<small>ご本人の回答</small></button>',
    '<button onclick="pick(\'p\')">保護者様<small>お子様の保護者の回答</small></button></div></div>',
    '<div id="s2" class="card hide"><button class="back" onclick="back1()">← 選び直す</button><br><b id="who"></b>',
    '<div style="margin-top:8px"><b>② いつのアンケートですか？</b></div><div class="btns" style="margin-top:12px">',
    '<button onclick="go(\'base\')">鑑定前<small>鑑定を受ける前</small></button>',
    '<button onclick="go(\'imm\')">鑑定直後<small>鑑定を受けた直後</small></button>',
    '<button onclick="go(\'post\')">3ヶ月後<small>鑑定から3ヶ月後</small></button></div></div>',
    '<div id="s3" class="card hide"><button class="back" onclick="back2()">← 選び直す</button> ',
    '<a id="ext" target="_blank" style="font-size:13px;margin-left:12px">別のタブで開く</a><div id="ttl" style="margin:8px 0;font-weight:bold"></div>',
    '<iframe id="fr"></iframe></div>',
    '</div><script>',
    'var U=' + JSON.stringify(map) + ';var who="";',
    'var WL={c:"お子様",p:"保護者様"},PL={base:"鑑定前",imm:"鑑定直後",post:"3ヶ月後"};',
    'function $(i){return document.getElementById(i)}',
    'function pick(w){who=w;$("s1").className="card hide";$("s2").className="card";$("who").textContent="ご回答者：" + WL[w]}',
    'function back1(){$("s2").className="card hide";$("s1").className="card"}',
    'function go(p){var u=U[who+"_"+p];if(!u){alert("このアンケートは準備中です");return}',
    '$("s2").className="card hide";$("s3").className="card";$("ttl").textContent=WL[who]+"｜"+PL[p]+"アンケート";',
    '$("fr").src=u+(u.indexOf("?")<0?"?":"&")+"embedded=true";$("ext").href=u;window.scrollTo(0,0)}',
    'function back2(){$("fr").src="about:blank";$("s3").className="card hide";$("s2").className="card"}',
    '</script></body></html>',
  ].join('');
  return HtmlService.createHtmlOutput(html).setTitle('KAGAMI アンケート')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
