/**
 * ============================================================================
 * KAGAMI｜子どもの進路・自己理解支援アンケート 計測システム（Google Apps Script）
 * ============================================================================
 * 目的：
 *   「悩み → 自己理解 → 判断軸 → 進路の明確化 → 行動 → 結果」の流れを、
 *   鑑定直後と3ヶ月後の同一質問で測定し、変化量としてKAGAMIの価値を示す。
 *
 * 使い方（詳細は README.md）：
 *   1) script.google.com で新規プロジェクトを作り、このファイルを貼り付ける
 *   2) setupKagamiSystem() を実行（初回のみ。承認画面で許可）
 *   3) 実行ログ、または「フォームURL」シートで4つのフォームURLを確認
 *
 * 主な実行関数：
 *   setupKagamiSystem()      初回構築（作成済みなら何も複製せず案内だけ出す）
 *   updateKagamiSystem()     既存システムの更新（シート・数式・グラフを再生成。回答は消えない）
 *   createNewKagamiSystem()  あえて「別の新しいシステム」を作る（旧IDは履歴に残す）
 *   issueSubjectIds()        対象者IDを発行（設定シートの発行数ぶん）＋事前入力URLを作成
 *   fillPrefilledUrls()      未作成の事前入力URLを補完
 *   recalculateAll()         回答ログ・個人別分析を再計算（回答送信時は自動実行）
 *   showFormUrls()           4フォームのURLをログに表示
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
  DEFAULT_THRESHOLD: 0.25,   // 改善／低下の判定しきい値
  DEFAULT_MIN_N: 30,         // 「傾向」として解釈してよい最小人数
  DEFAULT_ISSUE_COUNT: 10,   // issueSubjectIds() で一度に発行する数
  FOLLOWUP_DAYS: 90,         // 3ヶ月後アンケートの案内予定日（鑑定日＋日数）
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
  SHEET.README, SHEET.DASH, SHEET.SUBJECTS, SHEET.A, SHEET.B, SHEET.C, SHEET.D,
  SHEET.PERSON, SHEET.AGG, SHEET.CROSS, SHEET.CASE, SHEET.LOG, SHEET.QLIST, SHEET.SETTINGS, SHEET.URLS,
];

/** 判定ラベル */
const JUDGE = { UP: '改善', FLAT: '変化なし', DOWN: '低下' };

// ############################################################################
// ## 2. 質問定義（ここを編集すれば質問を変更できます）
// ############################################################################

// ---- 選択肢セット -----------------------------------------------------------
/** 基本の4段階評価（中央の「どちらともいえない」は置かない／大きいほど良い） */
const SCALE4 = ['全くそう思わない', 'あまりそう思わない', 'まあそう思う', 'とてもそう思う'];
const ACTION4 = ['全く行動していない', 'あまり行動していない', '何度か行動した', '継続的に行動した'];
const CHANGE4 = ['ほとんど変化していない', '少し変化した', 'かなり変化した', '大きく変化した'];
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

const CHILD_ACTIONS = [
  '学校について調べた', '職業について調べた', '大学・専門学校・高校などを調べた',
  'オープンキャンパス・説明会に参加した', '職場・仕事について調べた', '実際に仕事や活動を体験した',
  '資格や勉強を始めた', '家族と進路について話した', '先生・学校・専門家などに相談した',
  '興味のあることを実際にやってみた', '進路の候補を絞った', '進路を決めた', '特に何もしていない', 'その他',
];
const PARENT_CHANGES = [
  '子どもが自分の興味について話すようになった', '子どもが自分の得意・苦手について話すようになった',
  '子どもが進路について自分から話すようになった', '学校や仕事について調べるようになった',
  'オープンキャンパス・説明会などに参加した', '新しいことを体験するようになった',
  '家族と進路について話す機会が増えた', '進路の候補が見えてきた', '進路の候補を絞ることができた',
  '進路を決めた', '実際に進学・就職・活動を始めた', '特に大きな変化はない', 'その他',
];
const PARENT_REFERRALS = [
  '子どもの進路に悩んでいる保護者', '子ども自身が進路に悩んでいる家庭', '子どもの得意・不得意を理解したい保護者',
  '子どもとの進路の話し合いが難しい家庭', '進路を決めることに不安を感じている家庭', 'その他',
];

// ---- スコア（比較対象の5指標＋補助指標） --------------------------------------
const CORE_SCORES = [
  { key: 'self', label: '自己理解' },
  { key: 'axis', label: '判断軸' },
  { key: 'clarity', label: '進路明確度' },
  { key: 'decide', label: '自己決定・前向き' },
  { key: 'anx', label: '不安の少なさ' }, // 数字が大きい＝不安が少ない（逆転項目は作らない）
];
const EXTRA_SCORES = [
  { key: 'value', label: '鑑定への納得・参考度（直後・補助）' },
  { key: 'talk', label: '親子の進路対話（補助）' },
  { key: 'usage', label: '鑑定の活用度（3ヶ月後・補助）' },
];
const ALL_SCORE_KEYS = CORE_SCORES.concat(EXTRA_SCORES).map(s => s.key);

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
const RELATION = (label) => ({ q: 2, type: 'single', text: 'あなたとの関係', choices: [label], role: ROLE.LINK, required: true });
const FREE_TEXT = (q, text, long) => ({ q: q, type: 'text', text: text, key: 'text', long: !!long, required: false, role: ROLE.FREE });
const CHECKS = (q, text, choices, key, role, required) =>
  ({ q: q, type: 'checkbox', text: text, choices: choices, key: key, role: role, required: required !== false,
     help: '当てはまるものをすべて選んでください。' });

const PICK_HELP = '正解・不正解はありません。今の気持ちに一番近いものを選んでください。';

/** 4つのフォーム定義。who: c=お子様 / p=保護者、phase: pre=鑑定直後 / post=3ヶ月後 */
const FORM_SPECS = [
  // ========================= FORM A 鑑定直後｜お子様 =========================
  {
    key: 'A', who: 'c', phase: 'pre', sheetName: SHEET.A, whoLabel: 'お子様', surveyType: '鑑定直後',
    title: 'KAGAMI｜鑑定直後アンケート｜お子様',
    description: '今日の面談で「自分のこと」を知って、これからの進路を考えるきっかけになったかを知るためのアンケートです。\n' +
      '正解・不正解はありません。今の気持ちに一番近いものを選んでください。（所要時間：約5分）\n' +
      '名前・住所・電話番号などは聞きません。',
    sections: [
      { title: '基本情報', items: [idItem(), RELATION('お子様本人')] },
      { title: '鑑定後の現在の自己理解', help: PICK_HELP, items: [
        ord(3, '自分の得意なこと・苦手なことを理解している', ROLE.SELF, { score: 'self', pair: 'S1' }),
        ord(4, '自分が力を発揮しやすい環境を理解している', ROLE.SELF, { score: 'self', pair: 'S2' }),
        ord(5, '自分が大切にしたい価値観を理解している', ROLE.SELF, { score: 'self', pair: 'S3' }),
        ord(6, '自分の性格や行動の特徴を、自分の言葉で説明できる', ROLE.SELF, { score: 'self', pair: 'S4' }),
        ord(7, '自分に合わない環境や、無理をしやすい環境を理解している', ROLE.SELF, { score: 'self', pair: 'S5' }),
      ] },
      { title: '進路を考えるための判断軸', help: PICK_HELP, items: [
        ord(8, '進路を選ぶときに、自分が大切にしたいことが分かっている', ROLE.AXIS, { score: 'axis', pair: 'A1' }),
        ord(9, '周囲の意見だけではなく、自分の考えで進路を考えられる', ROLE.AXIS, { score: 'axis', pair: 'A2' }),
        ord(10, '「自分に合っているか」という視点で進路を考えられる', ROLE.AXIS, { score: 'axis', pair: 'A3' }),
        ord(11, '進路について迷ったとき、何を基準に考えればよいか分かっている', ROLE.AXIS, { score: 'axis', pair: 'A4' }),
      ] },
      { title: '進路の明確さ', help: PICK_HELP, items: [
        ord(12, '自分がどのような方向に進みたいのか、以前よりイメージできている', ROLE.CLARITY, { score: 'clarity', pair: 'C1' }),
        ord(13, '自分に合いそうな進路や選択肢を具体的に考えられる', ROLE.CLARITY, { score: 'clarity', pair: 'C2' }),
        ord(14, '次に何を調べたり、経験したりすればよいか分かっている', ROLE.CLARITY, { score: 'clarity', pair: 'C3' }),
      ] },
      { title: '自己決定・将来への気持ち', help: PICK_HELP, items: [
        ord(15, '自分の進路について、自分で決めていけそうだと感じる', ROLE.DECIDE, { score: 'decide', pair: 'D1' }),
        ord(16, '自分の将来について前向きに考えられる', ROLE.DECIDE, { score: 'decide', pair: 'D2' }),
        ord(17, '将来や進路について感じている不安は少ない', ROLE.ANX, { score: 'anx', pair: 'N1' }),
        ord(18, '「自分は自分のままでいい」と思える', ROLE.DECIDE, { score: 'decide', pair: 'D3' }),
      ] },
      { title: '今回の鑑定について', help: PICK_HELP, items: [
        ord(19, '今回の鑑定内容に納得できた', ROLE.USE, { score: 'value' }),
        ord(20, '今回の鑑定で知った自分の特徴は、今後の進路を考えるうえで参考になりそうだ', ROLE.USE, { score: 'value' }),
        ord(21, '今回の面談は、自分の進路について考えるきっかけになった', ROLE.USE, { score: 'value' }),
        FREE_TEXT(22, '今回の面談で、特に印象に残った気づきがあれば教えてください。（任意）', false),
      ] },
    ],
  },

  // ========================= FORM B 鑑定直後｜保護者様 =========================
  {
    key: 'B', who: 'p', phase: 'pre', sheetName: SHEET.B, whoLabel: '保護者', surveyType: '鑑定直後',
    title: 'KAGAMI｜鑑定直後アンケート｜保護者様',
    description: '本日の面談を通じて、お子様への理解や進路への向き合い方がどう整理されたかを知るためのアンケートです。\n' +
      '正解・不正解はありません。現在のお気持ちに最も近いものをお選びください。（所要時間：約5分）\n' +
      'お名前・ご住所・電話番号などはお聞きしません。',
    sections: [
      { title: '基本情報', items: [idItem(), RELATION('保護者')] },
      { title: 'お子様への理解', help: PICK_HELP, items: [
        ord(3, '子どもの得意なこと・苦手なことを理解している', ROLE.SELF, { score: 'self', pair: 'S1' }),
        ord(4, '子どもが力を発揮しやすい環境を理解している', ROLE.SELF, { score: 'self', pair: 'S2' }),
        ord(5, '子どもが大切にしたい価値観を理解している', ROLE.SELF, { score: 'self', pair: 'S3' }),
        ord(6, '子どもの性格や行動の特徴を、以前より理解できている', ROLE.SELF, { score: 'self', pair: 'S4' }),
        ord(7, '子どもが無理をしやすい環境や、合わない環境を理解している', ROLE.SELF, { score: 'self', pair: 'S5' }),
      ] },
      { title: '保護者としての進路への向き合い方', help: PICK_HELP, items: [
        ord(8, '子どもの進路を考えるときに、大切にすべきことが整理できている', ROLE.AXIS, { score: 'axis', pair: 'A1' }),
        ord(9, '子どもの意思を尊重しながら進路を考えられる', ROLE.AXIS, { score: 'axis', pair: 'A2' }),
        ord(10, '「子どもに合っているか」という視点で進路を考えられる', ROLE.AXIS, { score: 'axis', pair: 'A3' }),
        ord(11, '子どもの進路について迷ったとき、何を基準に考えればよいか分かっている', ROLE.AXIS, { score: 'axis', pair: 'A4' }),
      ] },
      { title: '進路の明確さ', help: PICK_HELP, items: [
        ord(12, '子どもがどのような方向に進むとよいのか、以前よりイメージできている', ROLE.CLARITY, { score: 'clarity', pair: 'C1' }),
        ord(13, '子どもに合いそうな進路や選択肢を具体的に考えられる', ROLE.CLARITY, { score: 'clarity', pair: 'C2' }),
        ord(14, '今後、子どもにどんな経験や情報が必要なのか分かっている', ROLE.CLARITY, { score: 'clarity', pair: 'C3' }),
      ] },
      { title: '将来への気持ち・親子関係', help: PICK_HELP, items: [
        ord(15, '子ども自身が進路を決めていけそうだと感じる', ROLE.DECIDE, { score: 'decide', pair: 'D1' }),
        ord(16, '子どもの将来について前向きに考えられる', ROLE.DECIDE, { score: 'decide', pair: 'D2' }),
        ord(17, '子どもの進路について感じている不安は少ない', ROLE.ANX, { score: 'anx', pair: 'N1' }),
        ord(18, '子どもと進路について話しやすくなった', ROLE.TALK, { score: 'talk', pair: 'T1' }),
      ] },
      { title: '今回の鑑定について', help: PICK_HELP, items: [
        ord(19, '今回の鑑定内容に納得できた', ROLE.USE, { score: 'value' }),
        ord(20, '今回の鑑定で知った子どもの特徴は、今後の進路を考えるうえで参考になりそうだ', ROLE.USE, { score: 'value' }),
        ord(21, '今回の面談は、子どもの進路について考えるきっかけになった', ROLE.USE, { score: 'value' }),
        FREE_TEXT(22, '今回の面談で、新しく気づいたことがあれば教えてください。（任意）', true),
      ] },
    ],
  },

  // ========================= FORM C 3ヶ月後｜お子様 =========================
  {
    key: 'C', who: 'c', phase: 'post', sheetName: SHEET.C, whoLabel: 'お子様', surveyType: '3ヶ月後',
    title: 'KAGAMI｜3ヶ月後アンケート｜お子様',
    description: '鑑定から3ヶ月がたちました。この3ヶ月での「自分のこと」や「進路」についての変化を教えてください。\n' +
      '正解・不正解はありません。今の気持ちに一番近いものを選んでください。（所要時間：約7分）\n' +
      '名前・住所・電話番号などは聞きません。',
    sections: [
      { title: '基本情報', items: [idItem()] },
      { title: '現在の自己理解', help: PICK_HELP, items: [
        ord(2, '現在、自分の得意なこと・苦手なことを理解している', ROLE.SELF, { score: 'self', pair: 'S1' }),
        ord(3, '現在、自分が力を発揮しやすい環境を理解している', ROLE.SELF, { score: 'self', pair: 'S2' }),
        ord(4, '現在、自分が大切にしたい価値観を理解している', ROLE.SELF, { score: 'self', pair: 'S3' }),
        ord(5, '現在、自分の性格や行動の特徴を、自分の言葉で説明できる', ROLE.SELF, { score: 'self', pair: 'S4' }),
        ord(6, '現在、自分に合わない環境や、無理をしやすい環境を理解している', ROLE.SELF, { score: 'self', pair: 'S5' }),
      ] },
      { title: '現在の判断軸', help: PICK_HELP, items: [
        ord(7, '現在、進路を選ぶときに、自分が大切にしたいことが分かっている', ROLE.AXIS, { score: 'axis', pair: 'A1' }),
        ord(8, '現在、周囲の意見だけではなく、自分の考えで進路を考えられる', ROLE.AXIS, { score: 'axis', pair: 'A2' }),
        ord(9, '現在、「自分に合っているか」という視点で進路を考えられる', ROLE.AXIS, { score: 'axis', pair: 'A3' }),
        ord(10, '現在、進路について迷ったとき、何を基準に考えればよいか分かっている', ROLE.AXIS, { score: 'axis', pair: 'A4' }),
      ] },
      { title: '現在の進路の明確さ', help: PICK_HELP, items: [
        ord(11, '現在、自分がどのような方向に進みたいのかイメージできている', ROLE.CLARITY, { score: 'clarity', pair: 'C1' }),
        ord(12, '現在、自分に合いそうな進路や選択肢を具体的に考えられる', ROLE.CLARITY, { score: 'clarity', pair: 'C2' }),
        ord(13, '現在、次に何を調べたり、経験したりすればよいか分かっている', ROLE.CLARITY, { score: 'clarity', pair: 'C3' }),
      ] },
      { title: '現在の自己決定・将来への気持ち', help: PICK_HELP, items: [
        ord(14, '現在、自分の進路について、自分で決めていけそうだと感じる', ROLE.DECIDE, { score: 'decide', pair: 'D1' }),
        ord(15, '現在、自分の将来について前向きに考えられる', ROLE.DECIDE, { score: 'decide', pair: 'D2' }),
        ord(16, '現在、将来や進路について感じている不安は少ない', ROLE.ANX, { score: 'anx', pair: 'N1' }),
        ord(17, '現在、「自分は自分のままでいい」と思える', ROLE.DECIDE, { score: 'decide', pair: 'D3' }),
      ] },
      { title: '鑑定内容の活用', help: PICK_HELP, items: [
        ord(18, '鑑定で知った自分の特徴を、進路について考えるときに意識した', ROLE.USE, { score: 'usage', key: 'use' }),
        ord(19, '鑑定で知った「自分に合う環境」や「大切にしたいこと」を、進路選択の参考にした', ROLE.USE, { score: 'usage' }),
        ord(20, '鑑定で知った内容を、家族や周囲の人との進路の話に活用した', ROLE.USE, { score: 'usage' }),
      ] },
      { title: '実際の行動', items: [
        ord(21, 'この3ヶ月間で、進路について自分から行動した', ROLE.ACT, { choices: ACTION4, key: 'action' }),
        CHECKS(22, 'この3ヶ月間で行ったことをすべて選んでください。', CHILD_ACTIONS, 'actions', ROLE.ACT),
      ] },
      { title: '3ヶ月間で起きた変化', items: [
        ord(23, 'この3ヶ月間で、進路についての自分の考えはどの程度変化しましたか？', ROLE.RESULT, { choices: CHANGE4, key: 'change' }),
        ord(24, '現在の進路の状況を教えてください。', ROLE.RESULT, { choices: STATUS6, key: 'status' }),
        ord(25, '今回の鑑定は、現在の進路を考えるうえで役に立ったと思う', ROLE.IMPACT, { key: 'useful' }),
        ord(26, '今回の鑑定がなかった場合と比べて、進路について考えるきっかけや行動に影響があったと思う', ROLE.IMPACT, { key: 'impact' }),
        FREE_TEXT(27, 'この3ヶ月間で、一番大きかった変化や気づきがあれば教えてください。（任意）', true),
      ] },
    ],
  },

  // ========================= FORM D 3ヶ月後｜保護者様 =========================
  {
    key: 'D', who: 'p', phase: 'post', sheetName: SHEET.D, whoLabel: '保護者', surveyType: '3ヶ月後',
    title: 'KAGAMI｜3ヶ月後アンケート｜保護者様',
    description: '鑑定から3ヶ月がたちました。この3ヶ月でのお子様の変化と、保護者としての向き合い方についてお聞かせください。\n' +
      '正解・不正解はありません。現在のお気持ちに最も近いものをお選びください。（所要時間：約7分）\n' +
      'お名前・ご住所・電話番号などはお聞きしません。',
    sections: [
      { title: '基本情報', items: [idItem()] },
      { title: '現在のお子様への理解', help: PICK_HELP, items: [
        ord(2, '現在、子どもの得意なこと・苦手なことを理解している', ROLE.SELF, { score: 'self', pair: 'S1' }),
        ord(3, '現在、子どもが力を発揮しやすい環境を理解している', ROLE.SELF, { score: 'self', pair: 'S2' }),
        ord(4, '現在、子どもが大切にしたい価値観を理解している', ROLE.SELF, { score: 'self', pair: 'S3' }),
        ord(5, '現在、子どもの性格や行動の特徴を理解している', ROLE.SELF, { score: 'self', pair: 'S4' }),
        ord(6, '現在、子どもが無理をしやすい環境や、合わない環境を理解している', ROLE.SELF, { score: 'self', pair: 'S5' }),
      ] },
      { title: '現在の進路への向き合い方', help: PICK_HELP, items: [
        ord(7, '現在、子どもの進路を考えるときに、大切にすべきことが整理できている', ROLE.AXIS, { score: 'axis', pair: 'A1' }),
        ord(8, '現在、子どもの意思を尊重しながら進路を考えられる', ROLE.AXIS, { score: 'axis', pair: 'A2' }),
        ord(9, '現在、「子どもに合っているか」という視点で進路を考えられる', ROLE.AXIS, { score: 'axis', pair: 'A3' }),
        ord(10, '現在、子どもの進路について迷ったとき、何を基準に考えればよいか分かっている', ROLE.AXIS, { score: 'axis', pair: 'A4' }),
      ] },
      { title: '現在の進路の明確さ', help: PICK_HELP, items: [
        ord(11, '現在、子どもがどのような方向に進むとよいのかイメージできている', ROLE.CLARITY, { score: 'clarity', pair: 'C1' }),
        ord(12, '現在、子どもに合いそうな進路や選択肢を具体的に考えられる', ROLE.CLARITY, { score: 'clarity', pair: 'C2' }),
        ord(13, '現在、子どもにどんな経験や情報が必要なのか分かっている', ROLE.CLARITY, { score: 'clarity', pair: 'C3' }),
      ] },
      { title: '現在の親子関係・将来への気持ち', help: PICK_HELP, items: [
        ord(14, '現在、子ども自身が進路を決めていけそうだと感じる', ROLE.DECIDE, { score: 'decide', pair: 'D1' }),
        ord(15, '現在、子どもの将来について前向きに考えられる', ROLE.DECIDE, { score: 'decide', pair: 'D2' }),
        ord(16, '現在、子どもの進路について感じている不安は少ない', ROLE.ANX, { score: 'anx', pair: 'N1' }),
        ord(17, '現在、子どもと進路について話しやすい', ROLE.TALK, { score: 'talk', pair: 'T1' }),
      ] },
      { title: '鑑定内容の活用', help: PICK_HELP, items: [
        ord(18, '子どもが鑑定で知った自分の特徴を、進路について考えるときに意識していると感じる', ROLE.USE, { score: 'usage', key: 'use' }),
        ord(19, '鑑定で整理した「子どもに合う環境」や「大切にしたいこと」が、実際の進路選択の参考になった', ROLE.USE, { score: 'usage' }),
        ord(20, '鑑定内容をもとに、子どもとの進路についての会話が増えた', ROLE.USE, { score: 'usage' }),
      ] },
      { title: '実際の変化', items: [
        ord(21, 'この3ヶ月間で、子どもが進路について自分から行動したと感じる', ROLE.ACT, { choices: ACTION4, key: 'action' }),
        CHECKS(22, 'この3ヶ月間で見られた変化をすべて選んでください。', PARENT_CHANGES, 'changes', ROLE.ACT),
        ord(23, '現在のお子様の進路の状況を教えてください。', ROLE.RESULT, { choices: STATUS6, key: 'status' }),
        ord(24, '今回の鑑定は、現在のお子様の進路を考えるうえで役に立ったと思う', ROLE.IMPACT, { key: 'useful' }),
        ord(25, '今回の鑑定がなかった場合と比べて、お子様の進路についての考え方や行動に影響があったと思う', ROLE.IMPACT, { key: 'impact' }),
        ord(26, '今回の面談を通じて、保護者としての子どもへの向き合い方が変わった', ROLE.IMPACT, { key: 'selfchange' }),
        CHECKS(27, '今回の面談後、このようなサービスをどのような方に紹介したいと思いますか？', PARENT_REFERRALS, 'refer', ROLE.USE, false),
        FREE_TEXT(28, 'この3ヶ月間で、一番大きかったお子様の変化や、保護者としての気づきがあれば教えてください。（任意）', true),
      ] },
    ],
  },
];

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

function idPattern_() { return '^' + APP.ID_PREFIX + '-[0-9]{' + APP.ID_DIGITS + '}$'; }

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

// ############################################################################
// ## 4. 設定の自己検証（設計チェック1〜6を自動で確認）
// ############################################################################

function validateConfig_() {
  const errors = [];
  const NEUTRAL = ['どちらともいえない', 'どちらでもない', 'ふつう', '普通', 'わからない'];
  const REVERSE_HINT = ['強い', '多い', '感じない'];

  FORM_SPECS.forEach(spec => {
    const items = flatItems_(spec);
    const titles = {};
    items.forEach((it, i) => {
      // Q番号が連番か
      if (it.q !== i + 1 + (items[0].q - 1)) errors.push(spec.key + ' Q' + it.q + ': Q番号が連番ではありません');
      // タイトル重複（回答シートの見出しで列を特定するため）
      if (titles[it.text]) errors.push(spec.key + ' Q' + it.q + ': 質問文が重複しています');
      titles[it.text] = true;
      // 中央選択肢の禁止（チェック3）
      (it.choices || []).forEach(c => { if (NEUTRAL.indexOf(c) >= 0) errors.push(spec.key + ' Q' + it.q + ': 中央選択肢「' + c + '」は使えません'); });
      // 5段階の禁止（チェック2）
      if (it.type === 'ordinal' && it.choices.length > 6) errors.push(spec.key + ' Q' + it.q + ': 選択肢が多すぎます');
      if (it.score && CORE_SCORES.some(s => s.key === it.score)) {
        if (it.choices !== SCALE4) errors.push(spec.key + ' Q' + it.q + ': 比較対象の質問は4段階評価(SCALE4)にしてください');
        if (it.score === 'anx' && it.text.indexOf('少ない') < 0) errors.push(spec.key + ' Q' + it.q + ': 不安は「少ない」表現にしてください（逆転項目禁止）');
      }
      if (it.type === 'ordinal' && it.choices === SCALE4 && REVERSE_HINT.some(w => it.text.indexOf('不安が' + w) >= 0)) {
        errors.push(spec.key + ' Q' + it.q + ': 逆転項目の可能性があります');
      }
      // 鑑定前の悩みを3ヶ月後で再度聞かない（チェック6）
      if (spec.phase === 'post' && it.text.indexOf('鑑定前') >= 0) errors.push(spec.key + ' Q' + it.q + ': 3ヶ月後で「鑑定前」を聞いてはいけません');
    });
    if (items[0].type !== 'id') errors.push(spec.key + ': 先頭は対象者IDにしてください');
  });

  // 鑑定直後↔3ヶ月後で比較ペアが対応しているか（チェック1）
  [['A', 'C'], ['B', 'D']].forEach(pr => {
    const pre = flatItems_(specByKey_(pr[0])).filter(i => i.pair && CORE_SCORES.some(s => s.key === i.score));
    const post = flatItems_(specByKey_(pr[1])).filter(i => i.pair && CORE_SCORES.some(s => s.key === i.score));
    const preMap = {}; pre.forEach(i => preMap[i.pair] = i.score);
    const postMap = {}; post.forEach(i => postMap[i.pair] = i.score);
    Object.keys(preMap).forEach(p => { if (postMap[p] !== preMap[p]) errors.push(pr[0] + '↔' + pr[1] + ': 比較ペア ' + p + ' が対応していません'); });
    Object.keys(postMap).forEach(p => { if (preMap[p] !== postMap[p]) errors.push(pr[0] + '↔' + pr[1] + ': 比較ペア ' + p + ' が対応していません'); });
  });

  if (errors.length) throw new Error('設定エラー:\n' + errors.join('\n'));
  log_('設定チェック OK（比較ペア対応・4段階・中央選択肢なし・逆転項目なし・鑑定前の悩みを再質問していない）');
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

/** 既存システムを更新（シート・数式・グラフを再生成。回答データは消えない）。 */
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

  // --- 2) 設定・対象者管理（先に作る：他シートの数式が名前付き範囲を参照するため） ---
  buildSettings_(ss);
  buildLogSheet_(ss);   // 対象者管理の回答状況が参照するため先に作る（存在しないシートの参照は #REF! になる）
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

function tryDo_(fn) { try { fn(); } catch (e) { log_('（スキップ）' + e); } }

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
    ['KAGAMI_THRESHOLD', '改善／低下の判定しきい値', APP.DEFAULT_THRESHOLD,
      '変化量(3ヶ月後−鑑定直後)が +しきい値以上で「改善」、−しきい値以下で「低下」、その間は「変化なし」。'],
    ['KAGAMI_MIN_N', '傾向として解釈する最小人数(N)', APP.DEFAULT_MIN_N,
      'これ未満のときダッシュボードに注意を表示します。断定表現は使わないでください。'],
    ['KAGAMI_ISSUE_COUNT', 'ID発行数（issueSubjectIds用）', APP.DEFAULT_ISSUE_COUNT,
      'issueSubjectIds() を実行すると、この数だけ新しい対象者IDを発行します。'],
    ['KAGAMI_FOLLOWUP_DAYS', '3ヶ月後案内までの日数', APP.FOLLOWUP_DAYS,
      '対象者管理の「鑑定日」＋この日数＝3ヶ月後アンケートの案内予定日。'],
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
  sh.setColumnWidth(1, 260); sh.setColumnWidth(2, 90); sh.setColumnWidth(3, 640);
  sh.setFrozenRows(2);
}

const SUBJ = { FIRST: 2, COLS: ['対象者ID', '発行日', '鑑定日（入力）', '3ヶ月後案内予定日', '学年区分（任意）',
  '初回アンケートの主な悩み（カテゴリ）', '初回アンケートの悩み（要約）', '事例掲載の許可',
  'メモ（個人を特定する情報は書かない）', '直後・子ども', '直後・保護者', '3ヶ月後・子ども', '3ヶ月後・保護者',
  '事前入力URL｜A 直後・子ども', '事前入力URL｜B 直後・保護者', '事前入力URL｜C 3ヶ月後・子ども', '事前入力URL｜D 3ヶ月後・保護者'] };

function buildSubjects_(ss) {
  const sh = getOrCreate_(ss, SHEET.SUBJECTS);
  const n = APP.MAX_SUBJECTS;
  ensureSize_(sh, n + 1, SUBJ.COLS.length);
  sh.getRange(1, 1, 1, SUBJ.COLS.length).setValues([SUBJ.COLS]);
  styleHeader_(sh.getRange(1, 1, 1, SUBJ.COLS.length));
  sh.setRowHeight(1, 48);
  sh.setFrozenRows(1); sh.setFrozenColumns(1);

  const last = n + 1;
  // 案内予定日
  const dateF = [], statF = [];
  for (let r = 2; r <= last; r++) {
    dateF.push(['=IF(AND($A' + r + '<>"",ISNUMBER($C' + r + ')),$C' + r + '+KAGAMI_FOLLOWUP_DAYS,"")']);
    const row = [];
    [['お子様', '鑑定直後'], ['保護者', '鑑定直後'], ['お子様', '3ヶ月後'], ['保護者', '3ヶ月後']].forEach(p => {
      row.push('=IF($A' + r + '="","",IF(COUNTIFS(\'' + SHEET.LOG + '\'!$B:$B,$A' + r + ',\'' + SHEET.LOG + '\'!$C:$C,"' + p[0] +
        '",\'' + SHEET.LOG + '\'!$D:$D,"' + p[1] + '")>0,"✓",""))');
    });
    statF.push(row);
  }
  sh.getRange(2, 4, n, 1).setFormulas(dateF);
  sh.getRange(2, 10, n, 4).setFormulas(statF);
  sh.getRange(2, 1, n, 1).setNumberFormat('@');
  sh.getRange(2, 2, n, 1).setNumberFormat('yyyy/mm/dd');
  sh.getRange(2, 3, n, 2).setNumberFormat('yyyy/mm/dd');
  sh.getRange(2, 8, n, 1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['○', '×'], true).setAllowInvalid(true).build());
  sh.getRange(2, 10, n, 4).setHorizontalAlignment('center').setFontColor('#38761d').setFontWeight('bold');
  sh.getRange(1, 5, 1, 5).setBackground('#38761d'); // 手入力列を緑で区別
  sh.getRange(1, 14, 1, 4).setBackground('#7f6000');
  [110, 90, 100, 110, 100, 180, 220, 90, 220, 70, 70, 80, 80, 160, 160, 160, 160].forEach((w, i) => sh.setColumnWidth(i + 1, w));
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
  const startRow = lastIdx + 3; // 2行目始まり＋次の空き行
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
  const urlRange = sh.getRange(2, 14, n, 4);
  const urls = urlRange.getValues();
  const keys = ['A', 'B', 'C', 'D'];
  let changed = false;
  keys.forEach((k, ci) => {
    let form, idItem = null;
    const need = idVals.some((r, i) => normalizeId_(r[0]) && !urls[i][ci]);
    if (!need) return;
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
  FORM_SPECS.forEach(spec => {
    flatItems_(spec).forEach(it => {
      const sc = CORE_SCORES.concat(EXTRA_SCORES).filter(s => s.key === it.score)[0];
      rows.push([
        spec.key + '｜' + spec.surveyType + '｜' + spec.whoLabel, 'Q' + it.q, it.text,
        { id: '記述(ID)', single: '単一選択', ordinal: '4段階/順序選択', checkbox: '複数選択', text: it.long ? '長文記述' : '短文記述' }[it.type],
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
  CORE_SCORES.map(s => s.label), ['納得・参考度(補助)', '親子対話(補助)', '鑑定活用度(補助)'],
  ['行動(1-4)', '進路状況(1-6)', '鑑定活用Q18(1-4)', '鑑定影響(1-4)', '最新回答', 'ID登録']);

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
        } else if ((it.type === 'checkbox' || it.type === 'text') && it.key) {
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
  SpreadsheetApp.flush();
  log_('再計算完了：回答 ' + responses.length + ' 件 / 最新 ' + Object.keys(latest).length + ' 件');
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
    return [rec.ts, rec.id, rec.spec.whoLabel, rec.spec.surveyType, rec.spec.key + ' ' + rec.spec.title]
      .concat(ALL_SCORE_KEYS.map(k => rec.scores[k] !== undefined ? rec.scores[k] : ''))
      .concat([rec.keys.action !== undefined ? rec.keys.action : '', rec.keys.status !== undefined ? rec.keys.status : '',
        rec.keys.use !== undefined ? rec.keys.use : '', rec.keys.impact !== undefined ? rec.keys.impact : '',
        isLatest, regSet[rec.id] ? '登録済' : '未登録（要確認）']);
  });
  ensureSize_(sh, rows.length + 1, LOG_HEAD.length);
  sh.getRange(2, 1, rows.length, LOG_HEAD.length).setValues(rows);
  sh.getRange(2, 1, rows.length, 1).setNumberFormat('yyyy/mm/dd hh:mm');
}

// ############################################################################
// ## 10. 個人別分析
// ############################################################################

const PERSON = { BAND: 1, HEAD: 2, FIRST: 3 };
PERSON.LAST = PERSON.FIRST + APP.MAX_SUBJECTS - 1;

let _pcols = null;
/** 個人別分析の列定義（kind: input=スクリプトが書く／formula=数式） */
function pcols_() {
  if (_pcols) return _pcols;
  const cols = [];
  const add = (key, label, kind, group, fmt) => cols.push({ key: key, label: label, kind: kind, group: group, fmt: fmt || '' });
  const PH = { pre: '鑑定直後', post: '3ヶ月後', d: '変化量（3ヶ月後−直後）', j: '判定' };
  add('id', '対象者ID', 'input', '基本'); add('reg', 'ID登録', 'input', '基本');
  [['c', 'お子様'], ['p', '保護者']].forEach(w => {
    ['pre', 'post', 'd', 'j'].forEach(ph => {
      CORE_SCORES.forEach(s => add(w[0] + '_' + ph + '_' + s.key, s.label,
        (ph === 'd' || ph === 'j') ? 'formula' : 'input', w[1] + '｜' + PH[ph],
        ph === 'd' ? '+0.00;-0.00;0.00' : (ph === 'j' ? '' : '0.00')));
    });
  });
  CORE_SCORES.forEach(s => add('gap_' + s.key, s.label, 'formula', '親子差（3ヶ月後：保護者−お子様）', '+0.00;-0.00;0.00'));
  add('match_status', '進路状況の一致(1=一致)', 'formula', '親子差（3ヶ月後：保護者−お子様）');
  add('c_pre_value', 'お子様 納得・参考度', 'input', '補助｜鑑定直後', '0.00');
  add('p_pre_value', '保護者 納得・参考度', 'input', '補助｜鑑定直後', '0.00');
  add('p_pre_talk', '保護者 親子対話(直後)', 'input', '補助｜親子対話', '0.00');
  add('p_post_talk', '保護者 親子対話(3ヶ月後)', 'input', '補助｜親子対話', '0.00');
  add('p_d_talk', '保護者 親子対話の変化', 'formula', '補助｜親子対話', '+0.00;-0.00;0.00');
  [['c', 'お子様'], ['p', '保護者']].forEach(w => {
    const g = w[1] + '｜3ヶ月後の行動・結果';
    add(w[0] + '_use', '鑑定活用(1-4)', 'input', g);
    add(w[0] + '_action', '行動(1-4)', 'input', g);
    add(w[0] + '_status', '進路状況(1-6)', 'input', g);
    add(w[0] + '_useful', '役に立った(1-4)', 'input', g);
    add(w[0] + '_impact', '鑑定影響(1-4)', 'input', g);
  });
  add('c_change', 'お子様 考えの変化(1-4)', 'input', 'お子様｜3ヶ月後の行動・結果');
  add('p_selfchange', '保護者 向き合い方の変化(1-4)', 'input', '保護者｜3ヶ月後の行動・結果');
  add('c_actions', 'お子様 行動内容（複数）', 'input', '複数回答・自由記述（最新回答）', '@');
  add('p_changes', '保護者 見られた変化（複数）', 'input', '複数回答・自由記述（最新回答）', '@');
  add('p_refer', '保護者 紹介したい方（複数）', 'input', '複数回答・自由記述（最新回答）', '@');
  add('c_pre_text', 'お子様 直後の気づき', 'input', '複数回答・自由記述（最新回答）', '@');
  add('p_pre_text', '保護者 直後の気づき', 'input', '複数回答・自由記述（最新回答）', '@');
  add('c_post_text', 'お子様 3ヶ月後の変化・気づき', 'input', '複数回答・自由記述（最新回答）', '@');
  add('p_post_text', '保護者 3ヶ月後の変化・気づき', 'input', '複数回答・自由記述（最新回答）', '@');
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
  if ((m = /^([cp])_d_(\w+)$/.exec(key))) {
    const post = A(m[1] + '_post_' + m[2]), pre = A(m[1] + '_pre_' + m[2]);
    return '=IF(AND(ISNUMBER(' + post + '),ISNUMBER(' + pre + ')),ROUND(' + post + '-' + pre + ',4),"")';
  }
  if ((m = /^([cp])_j_(\w+)$/.exec(key))) {
    const d = A(m[1] + '_d_' + m[2]);
    return '=IF(ISNUMBER(' + d + '),IF(' + d + '>=KAGAMI_THRESHOLD,"' + JUDGE.UP + '",IF(' + d + '<=-KAGAMI_THRESHOLD,"' + JUDGE.DOWN + '","' + JUDGE.FLAT + '")),"")';
  }
  if ((m = /^gap_(\w+)$/.exec(key))) {
    const p = A('p_post_' + m[1]), c = A('c_post_' + m[1]);
    return '=IF(AND(ISNUMBER(' + p + '),ISNUMBER(' + c + ')),ROUND(' + p + '-' + c + ',4),"")';
  }
  if (key === 'match_status') {
    return '=IF(AND(ISNUMBER(' + A('c_status') + '),ISNUMBER(' + A('p_status') + ')),IF(' + A('c_status') + '=' + A('p_status') + ',1,0),"")';
  }
  if (key === 'p_d_talk') {
    return '=IF(AND(ISNUMBER(' + A('p_post_talk') + '),ISNUMBER(' + A('p_pre_talk') + ')),ROUND(' + A('p_post_talk') + '-' + A('p_pre_talk') + ',4),"")';
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
    sh.setColumnWidth(c.idx, c.fmt === '@' ? 220 : (c.key === 'id' ? 100 : 82));
  });
  sh.setColumnWidth(2, 110);

  // 判定列の色分け
  const jRanges = cols.filter(c => /_j_/.test(c.key)).map(c => sh.getRange(PERSON.FIRST, c.idx, N, 1));
  const rules = [];
  jRanges.forEach(rg => {
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(JUDGE.UP).setBackground('#d9ead3').setRanges([rg]).build());
    rules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(JUDGE.DOWN).setBackground('#f4cccc').setRanges([rg]).build());
  });
  sh.setConditionalFormatRules(rules);
  sh.setFrozenRows(PERSON.HEAD);
  sh.setFrozenColumns(2);
  sh.getRange(PERSON.HEAD, 1).setNote('このシートの「入力列」はスクリプトが自動で更新します。手入力しないでください。\n変化量・判定・親子差は数式です。');
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
  Object.keys(latest).forEach(k => {
    const rec = latest[k];
    const w = rec.spec.who, ph = rec.spec.phase;
    const o = byId[rec.id] = byId[rec.id] || {};
    Object.keys(rec.scores).forEach(sk => { o[w + '_' + ph + '_' + sk] = rec.scores[sk]; });
    Object.keys(rec.keys).forEach(kk => {
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

function buildAggSheet_(ss) {
  const sh = resetSheet_(ss, SHEET.AGG);
  ensureSize_(sh, 120, 12);
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

  // --- 基本数値 ---
  section('1. 基本数値'); head('指標', 'お子様', '保護者', '定義');
  line('subjects', '鑑定人数（対象者管理のID数）', "=COUNTA('" + SHEET.SUBJECTS + "'!$A$2:$A$" + (APP.MAX_SUBJECTS + 1) + ')', '', '対象者管理に登録されたID数', INT);
  line('n_pre', '鑑定直後アンケート 回答者数', '=COUNT(' + pr_('c_pre_self') + ')', '=COUNT(' + pr_('p_pre_self') + ')', '同一ID・同一フォームは最新の1件のみ集計', INT);
  line('n_post', '3ヶ月後アンケート 回答者数', '=COUNT(' + pr_('c_action') + ')', '=COUNT(' + pr_('p_action') + ')', '同上', INT);
  line('n_any_post', '3ヶ月後アンケート 回答対象者数（子ども・保護者いずれか）',
    '=SUMPRODUCT(--((ISNUMBER(' + pr_('c_action') + ')+ISNUMBER(' + pr_('p_action') + '))>0))', '', '', INT);
  line('resp_rate', '3ヶ月後回答率（鑑定人数に対する割合）',
    '=IFERROR(B' + (rows.length) + '/B' + reg.subjects + ',"")', '', '子ども・保護者いずれかが回答した割合', PCT);
  line('resp_rate_s', '　（内訳）3ヶ月後回答率', '=IFERROR(B' + reg.n_post + '/B' + reg.subjects + ',"")', '=IFERROR(C' + reg.n_post + '/B' + reg.subjects + ',"")', '回答者区分ごと', PCT);
  line('n_matched', '変化を算出できる人数（直後・3ヶ月後の両方に回答）', '=COUNT(' + pr_('c_d_self') + ')', '=COUNT(' + pr_('p_d_self') + ')', '変化量の分母になる人数(N)', INT);

  // --- スコア ---
  section('2. スコアの変化（4段階：数字が大きいほど良い状態）');
  head('指標', 'お子様', '保護者', '定義');
  CORE_SCORES.forEach(s => {
    const f = (w, what) => {
      const d = pr_(w + '_d_' + s.key);
      if (what === 'pre') return '=IFERROR(AVERAGEIFS(' + pr_(w + '_pre_' + s.key) + ',' + d + ',">-10"),"")';
      if (what === 'post') return '=IFERROR(AVERAGEIFS(' + pr_(w + '_post_' + s.key) + ',' + d + ',">-10"),"")';
      if (what === 'delta') return '=IFERROR(AVERAGE(' + d + '),"")';
      const j = pr_(w + '_j_' + s.key);
      const lab = { up: JUDGE.UP, flat: JUDGE.FLAT, down: JUDGE.DOWN }[what];
      return '=IFERROR(COUNTIF(' + j + ',' + q_(lab) + ')/COUNT(' + d + '),"")';
    };
    const note = s.key === 'anx' ? '＋＝不安が軽くなった（数字が大きいほど不安が少ない）' : '';
    line(s.key + '_pre', s.label + '｜鑑定直後（平均）', f('c', 'pre'), f('p', 'pre'), '直後・3ヶ月後の両方に回答した人のみ', NUM);
    line(s.key + '_post', s.label + '｜3ヶ月後（平均）', f('c', 'post'), f('p', 'post'), '', NUM);
    line(s.key + '_delta', s.label + '｜平均変化量', f('c', 'delta'), f('p', 'delta'), note, DELTA);
    line(s.key + '_up', s.label + '｜「改善」の割合', f('c', 'up'), f('p', 'up'), '変化量≧+しきい値', PCT);
    line(s.key + '_flat', s.label + '｜「変化なし」の割合', f('c', 'flat'), f('p', 'flat'), '', PCT);
    line(s.key + '_down', s.label + '｜「低下」の割合', f('c', 'down'), f('p', 'down'), '変化量≦−しきい値', PCT);
  });
  line('value_pre', '参考｜鑑定直後の納得・参考度（平均）', '=IFERROR(AVERAGE(' + pr_('c_pre_value') + '),"")', '=IFERROR(AVERAGE(' + pr_('p_pre_value') + '),"")', '満足度のみで価値判断しないための参考値', NUM);
  line('talk_pre', '参考｜親子の進路対話（直後・平均）', '', '=IFERROR(AVERAGE(' + pr_('p_pre_talk') + '),"")', '保護者のみ', NUM);
  line('talk_post', '参考｜親子の進路対話（3ヶ月後・平均）', '', '=IFERROR(AVERAGE(' + pr_('p_post_talk') + '),"")', '保護者のみ', NUM);
  line('talk_delta', '参考｜親子の進路対話の平均変化量', '', '=IFERROR(AVERAGE(' + pr_('p_d_talk') + '),"")', '保護者のみ', DELTA);

  // --- 行動・結果 ---
  section('3. 行動・結果（3ヶ月後）'); head('指標', 'お子様', '保護者', '定義');
  line('act_rate', '行動率', rate(pr_('c_action'), 3), rate(pr_('p_action'), 3), '「進路について自分から行動した」で3(何度か)または4(継続的)', PCT);
  line('act_cont', '継続行動率', rate(pr_('c_action'), 4), rate(pr_('p_action'), 4), '4(継続的に行動した)の割合', PCT);
  line('dir_rate', '方向性決定率', rate(pr_('c_status'), STATUS_DIRECTION_MIN), rate(pr_('p_status'), STATUS_DIRECTION_MIN), '進路状況が「候補がいくつか決まった」以上', PCT);
  line('concrete_rate', '具体的進路決定率', rate(pr_('c_status'), STATUS_CONCRETE_MIN), rate(pr_('p_status'), STATUS_CONCRETE_MIN), '「具体的な進路を決めた」「実際に始めた」', PCT);

  section('4. 進路状況の分布（人数）'); head('進路状況', 'お子様', '保護者', '');
  STATUS6.forEach((lab, i) => line('status_' + (i + 1), STATUS_SHORT[i] + '：' + lab,
    '=COUNTIF(' + pr_('c_status') + ',' + (i + 1) + ')', '=COUNTIF(' + pr_('p_status') + ',' + (i + 1) + ')', '', INT));

  section('5. 3ヶ月間の行動内容（お子様・複数回答）'); head('行動内容', '人数', '回答者に対する割合', '');
  CHILD_ACTIONS.forEach((lab, i) => {
    const r = pr_('c_actions');
    line('ca_' + i, lab, '=COUNTIF(' + r + ',"*' + lab + '*")', '=IFERROR(B' + (rows.length + 1) + '/COUNTIF(' + r + ',"?*"),"")', '', INT);
    fmts.push({ n: rows.length, fmt: INT, col: 2 }); fmts.push({ n: rows.length, fmt: PCT, col: 3 });
  });
  section('6. 3ヶ月間に見られた変化（保護者・複数回答）'); head('見られた変化', '人数', '回答者に対する割合', '');
  PARENT_CHANGES.forEach((lab, i) => {
    const r = pr_('p_changes');
    line('pc_' + i, lab, '=COUNTIF(' + r + ',"*' + lab + '*")', '=IFERROR(B' + (rows.length + 1) + '/COUNTIF(' + r + ',"?*"),"")', '', INT);
    fmts.push({ n: rows.length, fmt: INT, col: 2 }); fmts.push({ n: rows.length, fmt: PCT, col: 3 });
  });

  section('7. 鑑定の活用・影響（本人が感じた度合い）'); head('指標', 'お子様', '保護者', '定義');
  line('use_rate', '鑑定活用率', rate(pr_('c_use'), 3), rate(pr_('p_use'), 3), '「鑑定で知った特徴を進路を考えるとき意識した」で3または4', PCT);
  line('impact_rate', '鑑定影響率（主観評価）', rate(pr_('c_impact'), 3), rate(pr_('p_impact'), 3), '「鑑定がなかった場合と比べ影響があった」で3または4。因果の証明ではなく本人の感じた影響度', PCT);
  line('useful_rate', '「役に立った」割合', rate(pr_('c_useful'), 3), rate(pr_('p_useful'), 3), '「現在の進路を考えるうえで役に立った」で3または4', PCT);
  line('selfchange_rate', '保護者の向き合い方が変わった割合', '', rate(pr_('p_selfchange'), 3), '保護者のみ', PCT);
  line('change_rate', '考えが「かなり／大きく変化」した割合', rate(pr_('c_change'), 3), '', 'お子様のみ（変化の方向は問わない）', PCT);

  section('8. お子様と保護者の差（3ヶ月後・同じ家庭内）'); head('指標', '平均差(保護者−子ども)', '', '');
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
  sh.setColumnWidth(1, 430); sh.setColumnWidth(2, 110); sh.setColumnWidth(3, 110); sh.setColumnWidth(4, 420);
  sh.getRange(1, 2, rows.length, 2).setHorizontalAlignment('right');
  sh.setFrozenRows(2);

  // --- グラフ用データ（F列以降） ---
  const ref = (k) => '=B' + reg[k]; // 子ども
  const refP = (k) => '=C' + reg[k];
  const chart = {};
  let r0 = 3;
  // グラフ1：5スコアの 直後→3ヶ月後
  const b1 = [['スコア', 'お子様 鑑定直後', 'お子様 3ヶ月後', '保護者 鑑定直後', '保護者 3ヶ月後']];
  CORE_SCORES.forEach(s => b1.push([s.label, ref(s.key + '_pre'), ref(s.key + '_post'), refP(s.key + '_pre'), refP(s.key + '_post')]));
  sh.getRange(r0, 6, b1.length, 5).setValues(b1); chart.c1 = { row: r0, n: b1.length, cols: 5 };
  sh.getRange(r0 + 1, 7, 5, 4).setNumberFormat(NUM);
  sh.getRange(r0 - 1, 6).setValue('▼ グラフ用データ').setFontWeight('bold');
  r0 += b1.length + 2;
  // グラフ5：子ども／保護者の変化量
  const b5 = [['スコア', 'お子様 変化量', '保護者 変化量']];
  CORE_SCORES.forEach(s => b5.push([s.label, ref(s.key + '_delta'), refP(s.key + '_delta')]));
  sh.getRange(r0, 6, b5.length, 3).setValues(b5); chart.c5 = { row: r0, n: b5.length, cols: 3 };
  sh.getRange(r0 + 1, 7, 5, 2).setNumberFormat(DELTA);
  r0 += b5.length + 2;
  // グラフ2：進路状況
  const b2 = [['進路状況', 'お子様', '保護者']];
  STATUS_SHORT.forEach((lab, i) => b2.push([lab, ref('status_' + (i + 1)), refP('status_' + (i + 1))]));
  sh.getRange(r0, 6, b2.length, 3).setValues(b2); chart.c2 = { row: r0, n: b2.length, cols: 3 };
  r0 += b2.length + 2;
  // グラフ3：行動内容（お子様）
  const b3 = [['行動内容', '人数']];
  CHILD_ACTIONS.forEach((lab, i) => b3.push([lab, ref('ca_' + i)]));
  sh.getRange(r0, 6, b3.length, 2).setValues(b3); chart.c3 = { row: r0, n: b3.length, cols: 2 };
  r0 += b3.length + 2;
  // グラフ4：鑑定活用度×行動率（お子様）
  const b4 = [['鑑定活用度（Q18）', '行動率', '人数']];
  SCALE4.forEach((lab, i) => {
    const c = pr_('c_use'), a = pr_('c_action');
    b4.push([(i + 1) + ' ' + lab,
      '=IFERROR(COUNTIFS(' + c + ',' + (i + 1) + ',' + a + ',">=3")/COUNTIFS(' + c + ',' + (i + 1) + ',' + a + ',">=1"),"")',
      '=COUNTIFS(' + c + ',' + (i + 1) + ',' + a + ',">=1")']);
  });
  sh.getRange(r0, 6, b4.length, 3).setValues(b4); chart.c4 = { row: r0, n: b4.length, cols: 3 };
  sh.getRange(r0 + 1, 7, 4, 1).setNumberFormat(PCT);
  for (let c = 6; c <= 10; c++) sh.setColumnWidth(c, c === 6 ? 230 : 120);

  reg._chart = chart;
  return reg;
}

// ############################################################################
// ## 12. クロス集計（分析A〜F）
// ############################################################################

function buildCrossSheet_(ss) {
  const sh = resetSheet_(ss, SHEET.CROSS);
  ensureSize_(sh, 200, 8);
  const rows = []; const sections = []; const heads = []; const pcts = []; const nums = [];
  const push = (arr) => { while (arr.length < 7) arr.push(''); rows.push(arr); return rows.length; };
  const NOTE = (r) => '=IF(B' + r + '<KAGAMI_MIN_N,"参考値（Nが少ない）","")';

  push(['クロス集計（分析A〜F）']);
  push(['※ 各グループの人数(N)が少ないうちは傾向として扱わず、「参考値」としてください。相関は因果を意味しません。']);

  /** 変化の判定ごと／段階ごとに「結果」を集計する汎用テーブル */
  const table = (title, who, groupKey, groups, kind) => {
    const wl = who === 'c' ? 'お子様' : '保護者';
    sections.push(push([title + '（' + wl + '回答）']));
    const g = pr_(groupKey);
    let h;
    if (kind === 'act') h = ['グループ', '人数(N)', '行動した人数(3-4)', '行動率', '継続行動した人数(4)', '継続行動率', '注意'];
    else if (kind === 'status') h = ['グループ', '人数(N)', '方向性決定の人数', '方向性決定率', '具体的進路決定の人数', '具体的進路決定率', '注意'];
    else h = ['グループ', '人数(N)', '進路明確度の平均変化量', '「改善」の割合', '', '', '注意'];
    heads.push(push(h));
    groups.forEach(gr => {
      const n = rows.length + 1;
      let o;
      if (kind === 'act') {
        const a = pr_(who + '_action');
        o = [gr.label, '=COUNTIFS(' + g + ',' + gr.crit + ',' + a + ',">=1")',
          '=COUNTIFS(' + g + ',' + gr.crit + ',' + a + ',">=3")', '=IFERROR(C' + n + '/B' + n + ',"")',
          '=COUNTIFS(' + g + ',' + gr.crit + ',' + a + ',">=4")', '=IFERROR(E' + n + '/B' + n + ',"")', NOTE(n)];
        pcts.push('D' + n, 'F' + n);
      } else if (kind === 'status') {
        const s = pr_(who + '_status');
        o = [gr.label, '=COUNTIFS(' + g + ',' + gr.crit + ',' + s + ',">=1")',
          '=COUNTIFS(' + g + ',' + gr.crit + ',' + s + ',">=' + STATUS_DIRECTION_MIN + '")', '=IFERROR(C' + n + '/B' + n + ',"")',
          '=COUNTIFS(' + g + ',' + gr.crit + ',' + s + ',">=' + STATUS_CONCRETE_MIN + '")', '=IFERROR(E' + n + '/B' + n + ',"")', NOTE(n)];
        pcts.push('D' + n, 'F' + n);
      } else {
        const d = pr_(who + '_d_clarity'), j = pr_(who + '_j_clarity');
        o = [gr.label, '=COUNTIFS(' + g + ',' + gr.crit + ',' + d + ',">-10")',
          '=IFERROR(AVERAGEIFS(' + d + ',' + g + ',' + gr.crit + '),"")',
          '=IFERROR(COUNTIFS(' + g + ',' + gr.crit + ',' + j + ',' + q_(JUDGE.UP) + ')/B' + n + ',"")', '', '', NOTE(n)];
        nums.push('C' + n); pcts.push('D' + n);
      }
      push(o);
    });
    push(['']);
  };
  const judgeGroups = [JUDGE.UP, JUDGE.FLAT, JUDGE.DOWN].map(l => ({ label: l, crit: q_(l) }));
  const levelGroups = SCALE4.map((l, i) => ({ label: (i + 1) + ' ' + l, crit: String(i + 1) }));

  ['c', 'p'].forEach(w => {
    const wl = w === 'c' ? '【お子様】' : '【保護者】';
    push([wl]); sections.push(rows.length);
    table('分析A｜自己理解の変化 × 行動率', w, w + '_j_self', judgeGroups, 'act');
    table('分析B｜判断軸の変化 × 進路決定率', w, w + '_j_axis', judgeGroups, 'status');
    table('分析C｜進路明確度の変化 × 具体的進路決定率', w, w + '_j_clarity', judgeGroups, 'status');
    table('分析D｜鑑定活用度(Q18) × 行動率', w, w + '_use', levelGroups, 'act');
    table('分析E｜鑑定影響度 × 進路明確度の変化', w, w + '_impact', levelGroups, 'delta');
  });

  // 分析F：子どもの回答 × 保護者の回答
  sections.push(push(['分析F｜お子様の回答 × 保護者の回答']));
  heads.push(push(['指標', 'お子様', '保護者', '差（保護者−お子様）', '備考']));
  CORE_SCORES.forEach(s => {
    const n = rows.length + 1;
    push([s.label + '｜3ヶ月後スコア（平均）', '=IFERROR(AVERAGE(' + pr_('c_post_' + s.key) + '),"")', '=IFERROR(AVERAGE(' + pr_('p_post_' + s.key) + '),"")',
      '=IFERROR(AVERAGE(' + pr_('gap_' + s.key) + '),"")', '差は同じ家庭どうしの平均差']);
    nums.push('B' + n, 'C' + n, 'D' + n);
  });
  CORE_SCORES.forEach(s => {
    const n = rows.length + 1;
    push([s.label + '｜平均変化量', '=IFERROR(AVERAGE(' + pr_('c_d_' + s.key) + '),"")', '=IFERROR(AVERAGE(' + pr_('p_d_' + s.key) + '),"")',
      '=IFERROR(C' + n + '-B' + n + ',"")', '']);
    nums.push('B' + n, 'C' + n, 'D' + n);
  });
  [['行動率', 'action', 3], ['方向性決定率', 'status', STATUS_DIRECTION_MIN], ['具体的進路決定率', 'status', STATUS_CONCRETE_MIN],
   ['鑑定活用率', 'use', 3], ['鑑定影響率（主観）', 'impact', 3]].forEach(m => {
    const n = rows.length + 1;
    push([m[0], '=IFERROR(COUNTIF(' + pr_('c_' + m[1]) + ',">=' + m[2] + '")/COUNT(' + pr_('c_' + m[1]) + '),"")',
      '=IFERROR(COUNTIF(' + pr_('p_' + m[1]) + ',">=' + m[2] + '")/COUNT(' + pr_('p_' + m[1]) + '),"")', '=IFERROR(C' + n + '-B' + n + ',"")', '']);
    pcts.push('B' + n, 'C' + n, 'D' + n);
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
  if (nums.length) sh.getRangeList(nums).setNumberFormat('+0.00;-0.00;0.00');
  [260, 90, 130, 130, 130, 130, 140].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.setFrozenRows(2);
}

// ############################################################################
// ## 13. ケーススタディ用データ
// ############################################################################

function buildCaseSheet_(ss) {
  const sh = resetSheet_(ss, SHEET.CASE);
  const N = APP.MAX_SUBJECTS;
  const F = PERSON.FIRST;
  const P = (k) => SHEET_Q_(SHEET.PERSON) + '!' + pcol_(k).letter;
  const subj = (colLetter, r) => 'IFERROR(INDEX(' + SHEET_Q_(SHEET.SUBJECTS) + '!$' + colLetter + '$2:$' + colLetter + '$' + (APP.MAX_SUBJECTS + 1) +
    ',MATCH($A' + r + ',' + SHEET_Q_(SHEET.SUBJECTS) + '!$A$2:$A$' + (APP.MAX_SUBJECTS + 1) + ',0)),"")';
  const statusChoose = (cell) => 'IF(ISNUMBER(' + cell + '),CHOOSE(' + cell + ',' + STATUS6.map(q_).join(',') + '),"")';
  const actionMark = (cell) => 'IF(ISNUMBER(' + cell + '),CHOOSE(' + cell + ',"×","△","○","◎継続"),"")';

  const defs = [
    ['対象者ID', (r) => '=IF(' + P('id') + (F + r) + '="","",' + P('id') + (F + r) + ')', 100],
    ['学年区分', (r) => '=IF($A' + (3 + r) + '="","",' + subj('E', 3 + r) + ')', 80],
    ['初回アンケートの主な悩み（カテゴリ）', (r) => '=IF($A' + (3 + r) + '="","",' + subj('F', 3 + r) + ')', 160],
    ['初回アンケートの悩み（要約）', (r) => '=IF($A' + (3 + r) + '="","",' + subj('G', 3 + r) + ')', 220],
    ['自己理解の変化(子)', (r) => '=IF($A' + (3 + r) + '="","",' + P('c_d_self') + (F + r) + ')', 80],
    ['判断軸の変化(子)', (r) => '=IF($A' + (3 + r) + '="","",' + P('c_d_axis') + (F + r) + ')', 80],
    ['進路明確度の変化(子)', (r) => '=IF($A' + (3 + r) + '="","",' + P('c_d_clarity') + (F + r) + ')', 80],
    ['自己決定・前向きの変化(子)', (r) => '=IF($A' + (3 + r) + '="","",' + P('c_d_decide') + (F + r) + ')', 90],
    ['不安の少なさの変化(子)', (r) => '=IF($A' + (3 + r) + '="","",' + P('c_d_anx') + (F + r) + ')', 90],
    ['行動(子)', (r) => '=IF($A' + (3 + r) + '="","",' + actionMark(P('c_action') + (F + r)) + ')', 70],
    ['進路結果(子)', (r) => '=IF($A' + (3 + r) + '="","",' + statusChoose(P('c_status') + (F + r)) + ')', 180],
    ['鑑定活用(子 1-4)', (r) => '=IF($A' + (3 + r) + '="","",' + P('c_use') + (F + r) + ')', 80],
    ['鑑定影響(子 1-4)', (r) => '=IF($A' + (3 + r) + '="","",' + P('c_impact') + (F + r) + ')', 80],
    ['進路明確度の変化(保護者)', (r) => '=IF($A' + (3 + r) + '="","",' + P('p_d_clarity') + (F + r) + ')', 90],
    ['進路結果(保護者)', (r) => '=IF($A' + (3 + r) + '="","",' + statusChoose(P('p_status') + (F + r)) + ')', 180],
    ['鑑定影響(保護者 1-4)', (r) => '=IF($A' + (3 + r) + '="","",' + P('p_impact') + (F + r) + ')', 90],
    ['3ヶ月間に行ったこと(子)', (r) => '=IF($A' + (3 + r) + '="","",' + P('c_actions') + (F + r) + ')', 260],
    ['3ヶ月間に見られた変化(保護者)', (r) => '=IF($A' + (3 + r) + '="","",' + P('p_changes') + (F + r) + ')', 260],
    ['鑑定直後の気づき(子)', (r) => '=IF($A' + (3 + r) + '="","",' + P('c_pre_text') + (F + r) + ')', 260],
    ['鑑定直後の気づき(保護者)', (r) => '=IF($A' + (3 + r) + '="","",' + P('p_pre_text') + (F + r) + ')', 260],
    ['3ヶ月後の変化・気づき(子)', (r) => '=IF($A' + (3 + r) + '="","",' + P('c_post_text') + (F + r) + ')', 280],
    ['3ヶ月後の変化・気づき(保護者)', (r) => '=IF($A' + (3 + r) + '="","",' + P('p_post_text') + (F + r) + ')', 280],
    ['事例掲載の許可', (r) => '=IF($A' + (3 + r) + '="","",' + subj('H', 3 + r) + ')', 80],
  ];
  ensureSize_(sh, F + N, defs.length);
  sh.getRange('A1').setValue('ケーススタディ用データ（実際の回答のみを表示。ストーリーの自動生成は行いません）');
  styleTitle_(sh.getRange('A1'));
  sh.getRange(2, 1, 1, defs.length).setValues([defs.map(d => d[0])]);
  styleHeader_(sh.getRange(2, 1, 1, defs.length));
  sh.setRowHeight(2, 48);
  defs.forEach((d, ci) => {
    const f = [];
    for (let r = 0; r < N; r++) f.push([d[1](r)]);
    sh.getRange(3, ci + 1, N, 1).setFormulas(f);
    sh.setColumnWidth(ci + 1, d[2]);
  });
  sh.getRange(3, 5, N, 5).setNumberFormat('+0.00;-0.00;0.00');
  sh.getRange(3, 14, N, 1).setNumberFormat('+0.00;-0.00;0.00');
  sh.getRange(3, 17, N, 6).setWrap(true).setVerticalAlignment('top');
  sh.setFrozenRows(2); sh.setFrozenColumns(1);
  sh.getRange('A2').setNote('「鑑定前の悩み」は3ヶ月後には再質問しません。初回アンケートの内容を 対象者管理 の F・G 列に転記してください。\n掲載の許可が「○」のものだけを外部で使用してください。');
}

function SHEET_Q_(name) { return "'" + name + "'"; }

// ############################################################################
// ## 14. ダッシュボード
// ############################################################################

function buildDashboard_(ss, reg) {
  const sh = resetSheet_(ss, SHEET.DASH);
  const aggS = ss.getSheetByName(SHEET.AGG);
  ensureSize_(sh, 130, 13);
  sh.setHiddenGridlines(true);
  const ag = (k, c) => "'" + SHEET.AGG + "'!$" + c + '$' + reg[k];
  sh.setColumnWidth(1, 14);
  for (let c = 2; c <= 13; c++) sh.setColumnWidth(c, 112);

  const title = (row, text) => {
    const rg = sh.getRange(row, 2, 1, 12).merge();
    rg.setValue(text).setBackground('#1f3a5f').setFontColor('#ffffff').setFontWeight('bold').setFontSize(12).setVerticalAlignment('middle');
    sh.setRowHeight(row, 28);
  };
  const GREEN = '#d9ead3', RED = '#f4cccc';

  // タイトル
  sh.getRange('B1:M1').merge().setValue('KAGAMI 成果ダッシュボード').setFontSize(22).setFontWeight('bold').setFontColor('#1f3a5f');
  sh.setRowHeight(1, 40);
  sh.getRange('B2:M2').merge().setValue('悩み → 自己理解 → 判断軸 → 進路の明確化 → 行動 → 結果。数値は回答者の自己評価・報告に基づき、因果関係の証明ではありません。')
    .setFontColor('#666666').setWrap(true);
  sh.getRange('B3:M3').merge().setFormula('=IF(N(' + ag('n_matched', 'B') + ')<KAGAMI_MIN_N,"⚠ 変化を算出できる人数が "&N(' + ag('n_matched', 'B') +
    ')&" 名（目安 "&KAGAMI_MIN_N&" 名未満）です。現時点の数値は参考値であり、傾向や効果として断定しないでください。","")')
    .setFontColor('#990000').setFontWeight('bold').setWrap(true);
  sh.setRowHeight(3, 30);

  // 1. 基本数値（カード）
  title(5, '1. 基本数値');
  const cards = [
    ['鑑定人数', '=' + ag('subjects', 'B'), '0'],
    ['鑑定直後 回答数（子ども／保護者）', '=' + ag('n_pre', 'B') + '&" / "&' + ag('n_pre', 'C'), '@'],
    ['3ヶ月後 回答数（子ども／保護者）', '=' + ag('n_post', 'B') + '&" / "&' + ag('n_post', 'C'), '@'],
    ['3ヶ月後 回答率', '=' + ag('resp_rate', 'B'), '0.0%'],
  ];
  cards.forEach((c, i) => {
    const col = 2 + i * 3;
    sh.getRange(6, col, 1, 3).merge().setValue(c[0]).setFontColor('#666666').setHorizontalAlignment('center').setFontSize(10).setWrap(true);
    const v = sh.getRange(7, col, 1, 3).merge();
    v.setFormula(c[1]).setFontSize(26).setFontWeight('bold').setHorizontalAlignment('center').setFontColor('#1f3a5f').setBackground('#eef3fb');
    if (c[2] !== '@') v.setNumberFormat(c[2]);
  });
  sh.setRowHeight(7, 52);

  // 2. 変化
  title(9, '2. 鑑定直後 → 3ヶ月後の変化（4段階・数字が大きいほど良い）');
  const h2 = ['スコア', 'お子様\n鑑定直後', 'お子様\n3ヶ月後', 'お子様\n変化量', 'お子様\n判定', '保護者\n鑑定直後', '保護者\n3ヶ月後', '保護者\n変化量', '保護者\n判定', 'お子様\n「改善」割合', '保護者\n「改善」割合'];
  sh.getRange(10, 2, 1, h2.length).setValues([h2]);
  sh.getRange(10, 2, 1, h2.length).setBackground('#f3f3f3').setFontWeight('bold').setHorizontalAlignment('center').setWrap(true);
  sh.setRowHeight(10, 40);
  CORE_SCORES.forEach((s, i) => {
    const r = 11 + i;
    const lab = s.key === 'anx' ? '不安の少なさ（＋＝不安が軽くなった）' : s.label;
    const judge = (c) => '=IF(ISNUMBER(' + c + r + '),IF(' + c + r + '>=KAGAMI_THRESHOLD,"' + JUDGE.UP + '",IF(' + c + r + '<=-KAGAMI_THRESHOLD,"' + JUDGE.DOWN + '","' + JUDGE.FLAT + '")),"-")';
    sh.getRange(r, 2, 1, 11).setFormulas([[
      lab,
      '=' + ag(s.key + '_pre', 'B'), '=' + ag(s.key + '_post', 'B'), '=' + ag(s.key + '_delta', 'B'), judge('E'),
      '=' + ag(s.key + '_pre', 'C'), '=' + ag(s.key + '_post', 'C'), '=' + ag(s.key + '_delta', 'C'), judge('I'),
      '=' + ag(s.key + '_up', 'B'), '=' + ag(s.key + '_up', 'C'),
    ]]);
    sh.getRange(r, 3, 1, 2).setNumberFormat('0.00');
    sh.getRange(r, 5).setNumberFormat('+0.00;-0.00;0.00');
    sh.getRange(r, 7, 1, 2).setNumberFormat('0.00');
    sh.getRange(r, 9).setNumberFormat('+0.00;-0.00;0.00');
    sh.getRange(r, 11, 1, 2).setNumberFormat('0%');
    sh.getRange(r, 3, 1, 11).setHorizontalAlignment('center');
    sh.getRange(r, 2).setWrap(true);
    sh.setRowHeight(r, 30);
  });
  const dashRules = [];
  ['F11:F15', 'J11:J15'].forEach(a => {
    const rg = sh.getRange(a);
    dashRules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(JUDGE.UP).setBackground(GREEN).setRanges([rg]).build());
    dashRules.push(SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(JUDGE.DOWN).setBackground(RED).setRanges([rg]).build());
  });
  sh.setConditionalFormatRules(dashRules);
  sh.getRange('B16:M16').merge().setValue('判定：平均変化量が +しきい値以上＝改善／−しきい値以下＝低下／その間＝変化なし（しきい値は「設定」シート）。変化量は直後・3ヶ月後の両方に回答した人のみで計算。')
    .setFontColor('#666666').setFontSize(9).setWrap(true);

  // 3. 行動
  title(18, '3. 行動・結果（3ヶ月後）');
  sh.getRange('B19:F19').setValues([['指標', '', '', 'お子様', '保護者']]).setBackground('#f3f3f3').setFontWeight('bold');
  [['行動率', 'act_rate', '進路について自分から行動した（何度か＋継続的）'], ['継続行動率', 'act_cont', '継続的に行動した'],
   ['方向性決定率', 'dir_rate', '進路の候補が決まった以上'], ['具体的進路決定率', 'concrete_rate', '具体的な進路を決めた／実際に始めた']].forEach((m, i) => {
    const r = 20 + i;
    sh.getRange(r, 2, 1, 3).merge().setValue(m[0] + '　' + '（' + m[2] + '）').setWrap(true);
    sh.getRange(r, 5).setFormula('=' + ag(m[1], 'B')).setNumberFormat('0.0%');
    sh.getRange(r, 6).setFormula('=' + ag(m[1], 'C')).setNumberFormat('0.0%');
    sh.getRange(r, 5, 1, 2).setHorizontalAlignment('center').setFontWeight('bold').setFontSize(13);
    sh.setRowHeight(r, 30);
  });

  // 4. 鑑定価値
  title(25, '4. 鑑定の活用・影響（本人が感じた度合い）');
  sh.getRange('B26:F26').setValues([['指標', '', '', 'お子様', '保護者']]).setBackground('#f3f3f3').setFontWeight('bold');
  [['鑑定活用率', 'use_rate', '鑑定で知った特徴を進路を考えるとき意識した'],
   ['鑑定影響率（主観評価）', 'impact_rate', '鑑定がなかった場合と比べ影響があったと感じる'],
   ['「役に立った」割合', 'useful_rate', '現在の進路を考えるうえで役に立った']].forEach((m, i) => {
    const r = 27 + i;
    sh.getRange(r, 2, 1, 3).merge().setValue(m[0] + '　' + '（' + m[2] + '）').setWrap(true);
    sh.getRange(r, 5).setFormula('=' + ag(m[1], 'B')).setNumberFormat('0.0%');
    sh.getRange(r, 6).setFormula('=' + ag(m[1], 'C')).setNumberFormat('0.0%');
    sh.getRange(r, 5, 1, 2).setHorizontalAlignment('center').setFontWeight('bold').setFontSize(13);
    sh.setRowHeight(r, 30);
  });
  sh.getRange('H19:M23').merge().setValue('※ 「鑑定影響率」は因果関係を証明した数字ではなく、本人・保護者が主観的に感じた影響度です。')
    .setFontColor('#990000').setWrap(true).setVerticalAlignment('top');

  // 5. 公開用の表現例（断定しない）
  title(31, '5. 実績として使うときの表現例（自動生成・Nが少ないときは公開しないでください）');
  const guard = (nRef) => 'IF(N(' + nRef + ')<KAGAMI_MIN_N,"【参考：Nが少ないため公開は控える】","")';
  const sentences = [
    '=IF(ISNUMBER(' + ag('act_rate', 'B') + '),' + guard(ag('n_post', 'B')) + '&"鑑定後3ヶ月で"&TEXT(' + ag('act_rate', 'B') + ',"0%")&"の方が進路について具体的な行動を起こしました（お子様回答・N="&' + ag('n_post', 'B') + '&"）","")',
    '=IF(ISNUMBER(' + ag('use_rate', 'B') + '),' + guard(ag('n_post', 'B')) + '&TEXT(' + ag('use_rate', 'B') + ',"0%")&"の方が、鑑定で整理した自分の特徴を進路選択の参考にしています（お子様回答・N="&' + ag('n_post', 'B') + '&"）","")',
    '=IF(N(' + ag('self_delta', 'B') + ')>0,' + guard(ag('n_matched', 'B')) + '&"鑑定後、自己理解スコアが平均"&TEXT(' + ag('self_delta', 'B') + ',"0.00")&"ポイント上昇しました（お子様回答・N="&' + ag('n_matched', 'B') + '&"）","（自己理解スコアが上昇していないため、この表現は使えません）")',
    '=IF(ISNUMBER(' + ag('impact_rate', 'B') + '),' + guard(ag('n_post', 'B')) + '&TEXT(' + ag('impact_rate', 'B') + ',"0%")&"の方が、鑑定が進路について考えるきっかけや行動に影響したと感じています（本人の主観評価・N="&' + ag('n_post', 'B') + '&"）","")',
  ];
  sentences.forEach((f, i) => {
    sh.getRange(32 + i, 2, 1, 12).merge().setFormula(f).setWrap(true).setVerticalAlignment('middle');
    sh.setRowHeight(32 + i, 30);
  });
  sh.getRange('B36:M36').merge().setValue('NG例：「鑑定を受ければ進路が決まります」「鑑定によって必ず人生が変わります」などの断定表現')
    .setFontColor('#990000').setFontSize(9);

  // 6. グラフ
  title(38, '6. グラフ');
  const ch = reg._chart;
  const rng = (c) => aggS.getRange(c.row, 6, c.n, c.cols);
  const base = (type, c, ttl, w, h, row, col) => sh.newChart().setChartType(type).addRange(rng(c)).setNumHeaders(1)
    .setPosition(row, col, 0, 0).setOption('title', ttl).setOption('width', w).setOption('height', h)
    .setOption('legend', { position: 'bottom' });
  const W = 640, H = 320;
  sh.insertChart(base(Charts.ChartType.COLUMN, ch.c1, 'グラフ1｜5つのスコアの変化（鑑定直後 → 3ヶ月後）', W, H, 39, 2)
    .setOption('vAxis', { viewWindow: { min: 1, max: 4 }, title: '平均（1〜4）' })
    .setOption('colors', ['#9ecae1', '#2171b5', '#fdd0a2', '#e6550d']).build());
  sh.insertChart(base(Charts.ChartType.COLUMN, ch.c2, 'グラフ2｜進路状況（人数）', W, H, 39, 8)
    .setOption('colors', ['#2171b5', '#e6550d']).build());
  sh.insertChart(base(Charts.ChartType.BAR, ch.c3, 'グラフ3｜3ヶ月間の行動内容（お子様・複数回答）', W, 420, 56, 2)
    .setOption('legend', { position: 'none' }).setOption('colors', ['#2171b5']).build());
  sh.insertChart(base(Charts.ChartType.COLUMN, ch.c4, 'グラフ4｜鑑定活用度と行動率の関係（お子様）', W, H, 56, 8)
    .setOption('legend', { position: 'none' }).setOption('vAxis', { viewWindow: { min: 0, max: 1 }, format: '0%' })
    .setOption('colors', ['#2171b5']).build());
  sh.insertChart(base(Charts.ChartType.COLUMN, ch.c5, 'グラフ5｜お子様と保護者の比較（スコアの変化量）', W, H, 78, 2)
    .setOption('colors', ['#2171b5', '#e6550d']).build());
  sh.setFrozenRows(3);
}

// ############################################################################
// ## 15. フォームURL・README
// ############################################################################

function buildUrlSheet_(ss, state) {
  const sh = resetSheet_(ss, SHEET.URLS);
  const head = ['フォーム', '回答者', '時期', '回答用URL（配布用）', '編集用URL（管理者のみ）', '回答先シート', 'フォームID'];
  const rows = FORM_SPECS.map(spec => {
    const f = FormApp.openById(state.forms[spec.key]);
    return [spec.key + '｜' + spec.title, spec.whoLabel, spec.surveyType, f.getPublishedUrl(), f.getEditUrl(), spec.sheetName, f.getId()];
  });
  sh.getRange(1, 1, 1, head.length).setValues([head]);
  styleHeader_(sh.getRange(1, 1, 1, head.length));
  sh.getRange(2, 1, rows.length, head.length).setValues(rows).setVerticalAlignment('top');
  [300, 70, 80, 420, 420, 130, 300].forEach((w, i) => sh.setColumnWidth(i + 1, w));
  sh.getRange(7, 1).setValue('※ 配布は「回答用URL」ではなく、対象者管理シートの「事前入力URL」（IDが自動入力される）を推奨します。編集用URLは共有しないでください。')
    .setFontColor('#990000');
  sh.setFrozenRows(1);
}

function showFormUrls() {
  const st = getState_();
  if (!st) { log_('未作成です。'); return; }
  FORM_SPECS.forEach(spec => {
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
    ['このシステムは「感想」ではなく「変化」を取るためのものです。悩み → 自己理解 → 判断軸 → 進路の明確化 → 行動 → 結果を、同じ対象者IDで追跡します。', ''],
    ['', ''],
    ['■ 運用の流れ', 'h'],
    ['1. 対象者ID発行：Apps Script で issueSubjectIds() を実行（発行数は「設定」シート）。対象者管理にIDと事前入力URLが並びます。', ''],
    ['2. 鑑定当日：「事前入力URL A（子ども）／B（保護者）」を送る。対象者管理の「鑑定日」を入力すると3ヶ月後の案内予定日が出ます。', ''],
    ['3. 3ヶ月後：「事前入力URL C（子ども）／D（保護者）」を送る。', ''],
    ['4. 回答が送信されると自動で 回答ログ・個人別分析・全体集計・クロス集計・ケーススタディ・ダッシュボード が更新されます。', ''],
    ['', ''],
    ['■ シートの役割', 'h'],
    ['ダッシュボード：成果の一覧とグラフ／対象者管理：ID・属性・回答状況／鑑定直後_子ども・鑑定直後_保護者・3ヶ月後_子ども・3ヶ月後_保護者：フォームの生回答（編集しない）', ''],
    ['回答ログ：回答者区分・アンケート種別・回答日時つきの縦持ちデータ（BI/追加分析用）／個人別分析：ID別の直後・3ヶ月後・変化量・判定', ''],
    ['全体集計：全指標の計算結果／クロス集計：分析A〜F／ケーススタディ：ID別の事例一覧／質問一覧：全質問と目的／設定：しきい値など／フォームURL：4フォームのURL', ''],
    ['', ''],
    ['■ 数値の見方', 'h'],
    ['・すべて4段階（1=全くそう思わない〜4=とてもそう思う）。数字が大きいほど良い状態です。「不安の少なさ」も大きいほど不安が少ない状態です。', ''],
    ['・変化量＝3ヶ月後−鑑定直後。+0.25以上＝改善／−0.25以下＝低下／その間＝変化なし（しきい値は設定シートで変更可）。', ''],
    ['・鑑定影響率は「鑑定がなかった場合と比べた本人の主観評価」であり、因果関係の証明ではありません。', ''],
    ['・人数(N)が少ないうちは傾向として断定せず「参考値」として扱ってください。', ''],
    ['', ''],
    ['■ 注意', 'h'],
    ['・生回答シート(③〜⑥)・回答ログ・個人別分析の「入力列」は自動更新されます。手で書き換えないでください。', ''],
    ['・ID未登録の回答は個人別分析で「未登録（要確認）」と表示されます（入力ミスの発見用）。', ''],
    ['・同じIDが同じフォームに複数回答した場合は、最新の1件を集計します。', ''],
    ['・広告・LPでは「鑑定を受ければ進路が決まる」等の断定表現を使わず、ダッシュボード5の表現例のように実データに基づいて書いてください。', ''],
    ['・個人名・連絡先などの個人情報は、このスプレッドシートに入力しないでください（IDのみで管理）。', ''],
  ];
  L.forEach((l, i) => {
    const c = sh.getRange(i + 1, 1).setValue(l[0]).setWrap(true).setVerticalAlignment('top');
    if (l[1] === 'title') c.setFontSize(18).setFontWeight('bold').setFontColor('#1f3a5f');
    if (l[1] === 'h') c.setFontWeight('bold').setBackground('#d9e2f3');
  });
  sh.setColumnWidth(1, 980);
}
