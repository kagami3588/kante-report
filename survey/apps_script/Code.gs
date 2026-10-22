/**
 * 算命学×自己理解・他者理解・キャリア形成 調査アンケート — 実装(Google Apps Script)
 *
 * 使い方:
 *   1. 台帳にする新しいスプレッドシートを作り、「拡張機能 → Apps Script」を開く
 *   2. Survey.gs・Code.gs・appsscript.json を貼り付ける
 *   3. setup() を実行(権限を許可)→ 申込フォーム、6つのアンケートフォーム、回答DB(別のスプレッドシート)が作られる
 *   4. 台帳の「設定」シートに、安全対応担当者のメールを入力する
 *   5. 申込フォームの公開URLを、募集する相手に案内する(ログに出る)
 *   6. 日程が決まったら、台帳の「名簿」の「鑑定日」を入力 → メニュー「アンケート運用」からリンクを送る
 *   7. runStaticTests() → runDataTests() →(1分後)verifyDataTests() で動作を確認する
 */

var CONFIG = {
  DB_NAME: '調査アンケート回答DB',
  REG_NAME: '調査台帳',
  CONTACT_TEXT: '運営の連絡先:kagami.3588@gmail.com',
  CONTACT_MAIL: 'kagami.3588@gmail.com',
  SENDER_NAME: 'KAGAMI',
  TEST_ID: 'F9999',
  T2_AFTER_DAYS: 90
};

// 台帳(このスクリプトを作成したスプレッドシート。個人情報・運用用)と、回答DB(別のスプレッドシート。IDだけ)を分ける
var SHEETS = {
  // 台帳
  roster: '名簿',
  settings: '設定',
  safety: '安全対応ログ',
  reminders: 'リマインドログ',
  sendlog: '送信ログ',
  pending: '申込要確認',
  tests: 'テスト結果',
  // 回答DB
  submissions: 'Submissions',
  long: 'Long',
  options: 'LongOptions',
  summary: '集計',
  codebook: 'コードブック'
};

var HEAD = {
  roster: ['調査用ID', '申込日時', '保護者名(申込者名)', '保護者(申込者)の性別', '保護者(申込者)の生年月日', '保護者(申込者)メール', 'LINE検索ID', 'Instagram', '公式LINE追加', '紹介者', 'お子様名', 'お子様の性別', 'お子様の生年月日', 'お子様メール', '鑑定日(yyyy-mm-dd)', '参加状況(参加中/辞退/完了)', 'T0送信日時', 'T1送信日時', 'T2送信日時', '追加鑑定の対象者名', '追加鑑定の希望', '連絡事項(保護者・申込者)', 'お子様の連絡事項', 'メモ', '区分', '法人名', '部署・役職', '電話番号', '鑑定を受ける人数', '鑑定を受ける方(名前・性別・生年月日)', '請求書・領収書の宛名', 'ご希望の内容', 'プラン'],
  pending: ['受付日時', '区分', '名前', 'メールアドレス', 'お子様名 / 法人名', '要確認の理由', '連絡事項'],
  sendlog: ['日時', '調査用ID', '時点', '送信先', '結果'],
  submissions: ['submission_id', '回答日時', '調査用ID', '回答者区分', 'フォームID', '時点', '分析採用', 'フラグ', '回答数', '未回答数', '非表示数', '自由記述あり数', 'テスト'],
  long: ['submission_id', '調査用ID', '回答者区分', 'フォームID', '時点', '設問ID', '回答内容', '数値コード', '回答日時', '状態', '自由記述あり', '分析採用'],
  options: ['submission_id', '調査用ID', 'フォームID', '設問ID', '選択肢'],
  reminders: ['日付', '調査用ID', 'フォームID', '回目', '通知先'],
  safety: ['受信日時', '調査用ID', 'フォームID', '理由', '通知先', '通知結果', '対応期限', '対応状況', '対応日時', '対応担当者', '対応メモ(調査データと分けて管理)']
};

// ======================================================================
// 純粋ロジック(Apps Script API に依存しない。node で単体テストする)
// ======================================================================

function parseQid_(title) {
  var m = /^([A-Za-z0-9_\-]+)\.\s/.exec(String(title));
  return m ? m[1] : null;
}

function qTitle_(q) { return q.id + '. ' + q.text; }

/** 申込フォームは、回答者に設問番号を見せない(題名は文言のみ)。回答を受け取るときに、文言から「ID. 文言」の形へ戻す */
function applyTitleParts_(q) {
  var m = /^(.*?)[(（]([^()（）]*)[)）]$/.exec(String(q.text));
  if ((q.kind === 'katakana' || q.kind === 'text') && m && m[1]) return { title: m[1], hint: '(' + m[2] + ')' };
  return { title: q.text, hint: '' };
}

function normalizeApplyNamed_(def, namedValues) {
  var out = {};
  Object.keys(namedValues || {}).forEach(function (k) { out[k] = namedValues[k]; });
  def.blocks.forEach(function (b) {
    if (b.type === 'q' && out[qTitle_(b)] === undefined && namedValues && namedValues[applyTitleParts_(b).title] !== undefined) out[qTitle_(b)] = namedValues[applyTitleParts_(b).title];
  });
  return out;
}

function questionsOf_(formKey) {
  return SURVEY.forms[formKey].blocks.filter(function (b) { return b.type === 'q'; });
}

function choicesOf_(q) {
  if (q.choices) return q.choices;
  if (q.scale && SCALES[q.scale]) return SCALES[q.scale];
  if (q.scale && CODEBOOK_EXTRA[q.scale] && CODEBOOK_EXTRA[q.scale].choices) return CODEBOOK_EXTRA[q.scale].choices;
  return null;
}

function codesOf_(q) {
  if (q.scale === 'YESNO') return CODEBOOK_EXTRA.YESNO;
  if (q.scale && CODEBOOK_EXTRA[q.scale] && CODEBOOK_EXTRA[q.scale].codes) return CODEBOOK_EXTRA[q.scale].codes;
  return null;
}

/** 回答文字列 → 数値コード。数値化できないものは null(欠測として扱う) */
function codeOf_(q, value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  var v = String(value).trim();
  if (q.kind === 'age') { var n = Number(v); return isNaN(n) ? null : n; }
  if (q.kind !== 'single') return null;
  var map = codesOf_(q);
  if (map && Object.prototype.hasOwnProperty.call(map, v)) return map[v];
  var m = /^([0-9]+)：/.exec(v);
  return m ? Number(m[1]) : null;
}

function splitMulti_(q, raw) {
  if (!raw) return [];
  var ch = choicesOf_(q) || [];
  var parts = String(raw).split(', ').map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
  return parts.filter(function (p) { return ch.indexOf(p) !== -1; });
}

function roleOf_(formKey) { return SURVEY.forms[formKey].role === 'child' ? '子ども' : '保護者'; }

/** 安全対応ルール(暫定。専門家確認後に確定する) */
var SAFETY_RULES = [
  { form: 'CT2', id: 'F8', type: 'minCode', min: 3, label: 'F8 鑑定による不安・気がかりが続いている(3以上)' },
  { form: 'CT2', id: 'F7', type: 'equals', value: 'はい', label: 'F7 やってみたかったことを諦めた・避けた' },
  { form: 'PT2', id: 'PF6', type: 'minCode', min: 3, label: 'PF6 保護者に現在も気がかりがある(3以上)' },
  { form: 'PT2', id: 'PF2', type: 'equals', value: 'はい', label: 'PF2 子どもを望まない方向へ誘導・選択を制限した' },
  { form: 'CT1', id: 'D17', type: 'nonEmpty', label: 'D17 気になること・不安・納得できなかったことの記載あり' },
  { form: 'CT2', id: 'F7-1', type: 'nonEmpty', label: 'F7-1 諦めた・避けた内容の記載あり' },
  { form: 'CT2', id: 'F10', type: 'nonEmpty', label: 'F10 気になること・困ったことの記載あり' },
  { form: 'PT2', id: 'PF2-1', type: 'nonEmpty', label: 'PF2-1 誘導・制限の内容の記載あり' }
];

function safetyReasons_(formKey, answers) {
  var out = [];
  var qs = {};
  questionsOf_(formKey).forEach(function (q) { qs[q.id] = q; });
  SAFETY_RULES.forEach(function (r) {
    if (r.form !== formKey) return;
    var q = qs[r.id];
    var v = answers[r.id];
    if (!q || v === undefined || v === null || String(v).trim() === '') return;
    if (r.type === 'nonEmpty') out.push(r.label);
    else if (r.type === 'equals' && String(v).trim() === r.value) out.push(r.label);
    else if (r.type === 'minCode') { var c = codeOf_(q, v); if (c !== null && c >= r.min && c !== 8) out.push(r.label); }
  });
  return out;
}

/**
 * 1件の送信を、分析用データに変換する。
 * namedValues: { 設問タイトル: [値] }  ctx: { isRegistered(id), hasPrior(id, formKey) }
 */
function processSubmission_(formKey, namedValues, tsIso, sid, ctx) {
  var def = SURVEY.forms[formKey];
  var qs = questionsOf_(formKey);
  var answers = {};
  var flags = [];
  qs.forEach(function (q) {
    var raw = namedValues[qTitle_(q)];
    var v = Array.isArray(raw) ? raw[0] : raw;
    answers[q.id] = (v === undefined || v === null) ? '' : String(v).trim();
  });

  var rid = answers.RID || '';
  var isTest = rid === CONFIG.TEST_ID;
  if (!new RegExp(SURVEY.idPattern).test(rid)) flags.push('ID形式不正');
  else if (!isTest && ctx && ctx.isRegistered && !ctx.isRegistered(rid)) flags.push('ID未登録');

  var hasPrior = !!(ctx && ctx.hasPrior && ctx.hasPrior(rid, formKey));
  if (hasPrior) flags.push('重複送信');
  var adopted = !hasPrior;

  var rows = [], optionRows = [];
  var nAns = 0, nMiss = 0, nHidden = 0, nFree = 0;
  qs.forEach(function (q) {
    if (q.system) return;
    var v = answers[q.id];
    var status;
    if (v !== '') {
      status = '回答';
      if (q.hiddenWhen && answers[q.hiddenWhen.id] === q.hiddenWhen.value) {
        flags.push('非表示設問に回答あり:' + q.id);
      }
    } else if (q.hiddenWhen && answers[q.hiddenWhen.id] === q.hiddenWhen.value) {
      status = '非表示(分岐)';
    } else {
      status = '未回答';
    }
    if (status === '回答') nAns++; else if (status === '未回答') nMiss++; else nHidden++;
    var isFree = (q.kind === 'text' && v !== '') ? 1 : 0;
    nFree += isFree;
    var code = (status === '回答') ? codeOf_(q, v) : null;

    if (q.kind === 'multi' && v !== '') {
      var sel = splitMulti_(q, v);
      if (q.exclusive && sel.indexOf(q.exclusive) !== -1 && sel.length > 1) flags.push('排他矛盾:' + q.id);
      sel.forEach(function (o) { optionRows.push([sid, rid, formKey, q.id, o]); });
      v = sel.join(' | ');
    }
    rows.push([sid, rid, roleOf_(formKey), formKey, def.time, q.id, v, code === null ? '' : code, tsIso, status, isFree, adopted ? 'TRUE' : 'FALSE']);
  });

  var submission = [sid, tsIso, rid, roleOf_(formKey), formKey, def.time, adopted ? 'TRUE' : 'FALSE', flags.join(' / '), nAns, nMiss, nHidden, nFree, isTest ? 'TRUE' : 'FALSE'];
  var reasons = safetyReasons_(formKey, answers);
  return { rid: rid, isTest: isTest, adopted: adopted, flags: flags, submission: submission, rows: rows, optionRows: optionRows, reasons: reasons, answers: answers };
}

/** リマインド: 鑑定日からの日数で最大2回。T0=-5・-3日、T1=+1・+3日、T2=+93・+97日(T2案内は+90日ごろ) */
var REMINDER_RULES = { T0: [-5, -3], T1: [1, 3], T2: [93, 97] };

function dayDiff_(a, b) {
  var pa = String(a).split('-'), pb = String(b).split('-');
  return Math.round((Date.UTC(+pa[0], +pa[1] - 1, +pa[2]) - Date.UTC(+pb[0], +pb[1] - 1, +pb[2])) / 86400000);
}

/**
 * roster: [{id, sessionDate:'yyyy-MM-dd', status}]  adoptedKeys: {'F0001|CT0': true}  today:'yyyy-MM-dd'
 * 参加中(または空欄)・鑑定日が入力済み・未回答のフォームだけを対象にする。辞退・完了・テストIDは対象外。
 */
function remindersDue_(roster, adoptedKeys, today) {
  var out = [];
  roster.forEach(function (r) {
    if (!r.id || !r.sessionDate || r.id === CONFIG.TEST_ID) return;
    if (r.status && String(r.status).trim() !== '' && String(r.status).trim() !== '参加中') return;
    var d = dayDiff_(today, r.sessionDate);
    SURVEY.formKeys.forEach(function (k) {
      var days = REMINDER_RULES[SURVEY.forms[k].time];
      var n = days.indexOf(d);
      if (n === -1 || adoptedKeys[r.id + '|' + k]) return;
      out.push({ id: r.id, form: k, nth: n + 1, offset: d });
    });
  });
  return out;
}

/** 設問定義の整合性チェック(エラー文字列の配列。空なら問題なし) */
function validateSurveyDefinition_() {
  var errors = [];
  var expectedCount = { CT0: 29, CT1: 17, CT2: 17, PT0: 13, PT1: 9, PT2: 9 };
  SURVEY.formKeys.forEach(function (key) {
    var def = SURVEY.forms[key];
    if (!def) { errors.push(key + ': 定義なし'); return; }
    var seen = {};
    var content = 0;
    if (/回答したくない/.test(def.intro) || /学年/.test(def.intro)) errors.push(key + ': 説明文に不適切な語が含まれる');
    def.blocks.forEach(function (b, idx) {
      if (b.type !== 'q') return;
      if (seen[b.id]) errors.push(key + ': 設問IDの重複 ' + b.id);
      seen[b.id] = true;
      if (!b.system) content++;
      var text = b.text + ' ' + (choicesOf_(b) || []).join(' ');
      if (/回答したくない/.test(text)) errors.push(key + ' ' + b.id + ': 「回答したくない」が含まれる');
      if (/学年/.test(text) && !b.system) errors.push(key + ' ' + b.id + ': 学年を尋ねている');
      if (b.kind === 'single' && !choicesOf_(b)) errors.push(key + ' ' + b.id + ': 選択肢が未定義');
      if (b.exclusive && (choicesOf_(b) || []).indexOf(b.exclusive) === -1) errors.push(key + ' ' + b.id + ': 排他選択肢が選択肢にない');
      if (b.scale === 'L4' && choicesOf_(b).join('|') !== SCALES.L4.join('|')) errors.push(key + ' ' + b.id + ': 4段階の選択肢が仕様と異なる');
      if (b.scale === 'FREQ4' && choicesOf_(b).join('|') !== SCALES.FREQ4.join('|')) errors.push(key + ' ' + b.id + ': 頻度の選択肢が仕様と異なる');
      if (b.hiddenWhen) {
        var gate = def.blocks.filter(function (x) { return x.type === 'q' && x.id === b.hiddenWhen.id; })[0];
        if (!gate) errors.push(key + ' ' + b.id + ': hiddenWhenの参照先なし ' + b.hiddenWhen.id);
        else if (!gate.gate) errors.push(key + ' ' + b.id + ': 参照先がgateではない ' + gate.id);
      }
      if (b.gate) {
        // gateの後に、conditionalページ→非conditionalページが続くこと
        var j = idx + 1, sawCond = false, target = null;
        for (; j < def.blocks.length; j++) {
          var nb = def.blocks[j];
          if (nb.type === 'page') { if (nb.conditional) sawCond = true; else { target = nb; break; } }
        }
        if (!sawCond) errors.push(key + ' ' + b.id + ': 条件ページがない');
        // 条件ページがフォームの末尾まで続く場合、スキップ先は「送信」になる(許容)
      }
    });
    if (expectedCount[key] !== content) errors.push(key + ': 設問数が仕様と異なる(期待' + expectedCount[key] + ' / 実際' + content + ')');
  });
  return errors;
}

/** 設問一覧(コードブック)の行を作る */
function buildCodebookRows_() {
  var relMap = {};
  REL_PAIRS.forEach(function (p) {
    (relMap[p[0]] = relMap[p[0]] || []).push(p[1] + '[' + p[2] + ']');
    (relMap[p[1]] = relMap[p[1]] || []).push(p[0] + '[' + p[2] + ']');
  });
  var rows = [['設問ID', 'フォームID', '回答者', '時点', 'セクション', '設問文', '回答形式', '選択肢(コード)', '排他選択肢', '表示条件', '測定軸', '何を測る設問か', '比較する設問(A/B/R)', '主な分析']];
  SURVEY.formKeys.forEach(function (key) {
    var def = SURVEY.forms[key];
    var section = '';
    def.blocks.forEach(function (b) {
      if (b.type === 'page') { section = b.title; return; }
      if (b.system) return;
      var ch = choicesOf_(b);
      var codes = codesOf_(b);
      var chText = '';
      if (b.kind === 'multi') chText = ch.join(' / ');
      else if (ch) chText = ch.map(function (c) {
        var cd = codeOf_(b, c);
        return c + (cd === null ? '' : '=' + cd);
      }).join(' / ');
      else if (b.kind === 'age') chText = '数値入力(5〜25、任意)';
      else if (b.kind === 'text') chText = '自由記述(任意)';
      var typeText = { single: '単一選択', multi: '複数選択', text: '自由記述', age: '数値' }[b.kind];
      var cond = b.hiddenWhen ? (b.hiddenWhen.id + '=' + b.hiddenWhen.value + ' のときは非表示') : '';
      var analysis;
      if (b.kind === 'text') analysis = '自由記述のテーマ分析(2名でコーディング)。数値回答の理由づけ';
      else if (b.kind === 'multi') analysis = '選択肢ごとの人数・割合(合計は100%を超える場合あり)';
      else if (b.kind === 'age') analysis = '年齢別の層別集計';
      else if (def.time === 'T0') analysis = 'T0の水準(分布・中央値)。T1・T2の関連設問と並置(差分にしない)。年齢別、親子比較(A/Bの区別に従う)';
      else if (def.time === 'T1') analysis = 'T1内の分布。T0の水準別の気づきの差(探索)。満足度とは別集計';
      else analysis = 'T2内の分布。T0の関連設問と並置。否定的影響は肯定的変化と別集計';
      if (b.risk) analysis += '。否定的影響として件数・割合を必ず報告';
      rows.push([b.id, key, roleOf_(key), def.time, section, b.text, typeText, chText, b.exclusive || '',
        cond + (b.gate ? (cond ? ' / ' : '') + 'ゲート(「' + b.gate.skip + '」で後続の条件設問を非表示)' : ''),
        b.axis, b.purpose || '', (relMap[b.id] || []).join(', '), analysis]);
    });
  });
  return rows;
}

function csvEscape_(v) {
  var s = (v === null || v === undefined) ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv_(rows) { return rows.map(function (r) { return r.map(csvEscape_).join(','); }).join('\r\n'); }

// ======================================================================
// 申込・送信・受付確認の純粋ロジック(node で単体テストする)
// ======================================================================

/** スプレッドシートから読むと、"TRUE"/"FALSE" の文字は真偽値(true/false)に、日時の文字は日付(Date)に変換されている。どちらの形でも扱えるようにする */
function isDate_(v) { return Object.prototype.toString.call(v) === '[object Date]'; }
function isTrue_(v) { return v === true || String(v).toUpperCase() === 'TRUE'; }
function isFalse_(v) { return v === false || String(v).toUpperCase() === 'FALSE'; }
function cellStr_(v) {
  if (isDate_(v)) return new Date(v.getTime() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  return v === undefined || v === null ? '' : String(v);
}
/** 「yyyy-MM-dd HH:mm」の文字、またはDateを、ミリ秒に(日本時間)。読めなければNaN */
function dueMs_(v) {
  if (isDate_(v)) return v.getTime();
  return new Date(String(v).trim().replace(' ', 'T') + (String(v).trim().length <= 16 ? ':00' : '') + '+09:00').getTime();
}

function normEmail_(s) { return String(s || '').trim().toLowerCase(); }
function normName_(s) { return String(s || '').replace(/[\s　]+/g, '').toLowerCase(); }
function isEmail_(s) { return /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(String(s || '').trim()); }

/** 次の調査用ID(F0001形式)。テストIDは数えない */
function nextId_(ids, prefix) {
  prefix = prefix || 'F';
  var max = 0;
  var re = new RegExp('^' + prefix + '([0-9]{4})$');
  (ids || []).forEach(function (i) {
    var m = re.exec(String(i));
    if (m && String(i) !== CONFIG.TEST_ID) max = Math.max(max, Number(m[1]));
  });
  return prefix + ('0000' + (max + 1)).slice(-4);
}

/**
 * 申込フォームの送信を処理する。
 * namedValues: { 設問タイトル: [値] }  existing: [{id, email, childName}]
 * 問題がなければ名簿の行を返し、問題があれば「申込要確認」の行を返す(調査用IDは発行しない)
 */
function isBirthDate_(s) {
  s = String(s || '').trim();
  if (!/^[0-9]{8}$/.test(s)) return false;
  var y = Number(s.slice(0, 4)), m = Number(s.slice(4, 6)), d = Number(s.slice(6, 8));
  var dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 1900 && dt.getTime() <= Date.now();
}
function isKatakana_(s) { return /^[\u30A1-\u30FA\u30FC\u30FB\s\u3000]+$/.test(String(s || '').trim()); }

function processCareerApplication_(namedValues, existing, tsIso) {
  var qs = SURVEY.apply.blocks.filter(function (b) { return b.type === 'q'; });
  var a = {};
  qs.forEach(function (q) {
    var raw = namedValues[qTitle_(q)];
    var v = Array.isArray(raw) ? raw[0] : raw;
    a[q.id] = (v === undefined || v === null) ? '' : String(v).trim();
  });
  var problems = [];
  if (!a.AP1) problems.push('保護者名が未入力');
  if (GENDERS.indexOf(a.AP6) === -1) problems.push('保護者の性別が未選択');
  if (!isBirthDate_(a.AP7)) problems.push('保護者の生年月日が不正(8桁の数字。例:20000218)');
  if (!isEmail_(a.AP2)) problems.push('保護者のメールアドレスの形式が不正');
  else if (normEmail_(a.AP2) !== normEmail_(a.AP3)) problems.push('保護者のメールアドレスが確認欄と一致しない');
  if (!a.AP8) problems.push('LINE検索IDが未入力');
  if (!a.AP10) problems.push('公式LINEの追加が未確認');
  if (!isKatakana_(a.AP11)) problems.push('紹介者氏名がカタカナではない(いない場合は「ナシ」)');
  if (!a.CH1) problems.push('お子様の名前が未入力');
  if (GENDERS.indexOf(a.CH2) === -1) problems.push('お子様の性別が未選択');
  if (!isBirthDate_(a.CH3)) problems.push('お子様の生年月日が不正(8桁の数字。例:20100315)');
  if (!isEmail_(a.CH4)) problems.push('お子様のメールアドレスの形式が不正');
  else if (normEmail_(a.CH4) !== normEmail_(a.CH5)) problems.push('お子様のメールアドレスが確認欄と一致しない');
  if (a.EX2 && !a.EX1) problems.push('追加の鑑定の対象者名が未入力');
  if (a.EX2 && EXTRA_PLANS.indexOf(a.EX2) === -1) problems.push('追加の鑑定の希望内容が不正');
  if (!a.CONSENT_ALL) problems.push('同意未確認');
  var dup = (existing || []).filter(function (e) { return (e.category || 'career') === 'career'; }).some(function (e) { return normEmail_(e.email) === normEmail_(a.AP2) && normName_(e.childName) === normName_(a.CH1); });
  if (dup) problems.push('重複申込(同じ保護者メールとお子様名がすでに登録済み)');
  if (problems.length) {
    return { ok: false, reason: problems.join(' / '), pendingRow: [tsIso, CATEGORY_LABEL.career, a.AP1, a.AP2, a.CH1, problems.join(' / '), a.AP5] };
  }
  var id = nextId_((existing || []).map(function (e) { return e.id; }), 'F');
  var row = [id, tsIso, a.AP1, a.AP6, a.AP7, a.AP2, a.AP8, a.AP9, a.AP10, a.AP11, a.CH1, a.CH2, a.CH3, a.CH4, '', '参加中', '', '', '', a.EX1, a.EX2, a.AP5, a.CH6, '', 'career', '', '', '', '', '', '', '', ''];
  return { ok: true, category: 'career', id: id, name: a.AP1, email: a.AP2, childName: a.CH1, childEmail: a.CH4, row: row };
}

function readAnswers_(formDef, namedValues) {
  var a = {};
  formDef.blocks.filter(function (b) { return b.type === 'q'; }).forEach(function (q) {
    var raw = namedValues[qTitle_(q)];
    var v = Array.isArray(raw) ? raw[0] : raw;
    a[q.id] = (v === undefined || v === null) ? '' : String(v).trim();
  });
  return a;
}

function blankRow_() { var r = []; for (var i = 0; i < 33; i++) r.push(''); return r; }

/** 一般鑑定者用の申込を処理する */
function processGeneralApplication_(namedValues, existing, tsIso) {
  var a = readAnswers_(SURVEY.applyG, namedValues);
  var problems = [];
  if (!a.GE1) problems.push('名前が未入力');
  if (GENDERS.indexOf(a.GE2) === -1) problems.push('性別が未選択');
  if (!isBirthDate_(a.GE3)) problems.push('生年月日が不正(8桁の数字。例:20000218)');
  if (!isEmail_(a.GE4)) problems.push('メールアドレスの形式が不正');
  else if (normEmail_(a.GE4) !== normEmail_(a.GE5)) problems.push('メールアドレスが確認欄と一致しない');
  if (!a.GE6) problems.push('LINE検索IDが未入力');
  if (!a.GE8) problems.push('公式LINEの追加が未確認');
  if (!isKatakana_(a.GE9)) problems.push('紹介者氏名がカタカナではない(いない場合は「ナシ」)');
  if (!a.CONSENT_ALL) problems.push('同意未確認');
  var dup = (existing || []).filter(function (e) { return e.category === 'general'; }).some(function (e) { return normEmail_(e.email) === normEmail_(a.GE4) && normName_(e.name) === normName_(a.GE1); });
  if (dup) problems.push('重複申込(同じメールと名前がすでに登録済み)');
  if (problems.length) return { ok: false, reason: problems.join(' / '), pendingRow: [tsIso, CATEGORY_LABEL.general, a.GE1, a.GE4, '', problems.join(' / '), a.GE11] };
  var id = nextId_((existing || []).map(function (e) { return e.id; }), 'G');
  var row = blankRow_();
  row[RC.id] = id; row[RC.ts] = tsIso; row[RC.pname] = a.GE1; row[RC.pgender] = a.GE2; row[RC.pbirth] = a.GE3; row[RC.pemail] = a.GE4;
  row[RC.line] = a.GE6; row[RC.insta] = a.GE7; row[RC.officialLine] = a.GE8; row[RC.referrer] = a.GE9; row[RC.status] = '参加中';
  row[RC.pnote] = a.GE11; row[RC.category] = 'general'; row[RC.request] = a.GE10;
  return { ok: true, category: 'general', id: id, name: a.GE1, email: a.GE4, row: row };
}

/** 法人鑑定者用の申込を処理する */
function processCorpApplication_(namedValues, existing, tsIso) {
  var a = readAnswers_(SURVEY.applyB, namedValues);
  var problems = [];
  if (!a.CO1) problems.push('法人名が未入力');
  if (!a.CO3) problems.push('担当者名が未入力');
  if (!isEmail_(a.CO4)) problems.push('メールアドレスの形式が不正');
  else if (normEmail_(a.CO4) !== normEmail_(a.CO5)) problems.push('メールアドレスが確認欄と一致しない');
  if (!/^[0-9]{9,13}$/.test(String(a.CO6).replace(/[\-\s]/g, ''))) problems.push('電話番号が不正');
  if (!a.CO7) problems.push('LINE検索IDが未入力');
  if (!a.CO8) problems.push('公式LINEの追加が未確認');
  if (!isKatakana_(a.CO9)) problems.push('紹介者氏名がカタカナではない(いない場合は「ナシ」)');
  var plan = findPlan_(a.CO10);
  if (!plan) problems.push('ご希望のプランが未選択');
  if (!a.CO11) problems.push('鑑定を受ける方の情報が未入力');
  if (!a.CONSENT_ALL) problems.push('同意未確認');
  var dup = (existing || []).filter(function (e) { return e.category === 'corp'; }).some(function (e) { return normEmail_(e.email) === normEmail_(a.CO4) && normName_(e.company) === normName_(a.CO1); });
  if (dup) problems.push('重複申込(同じメールと法人名がすでに登録済み)');
  if (problems.length) return { ok: false, reason: problems.join(' / '), pendingRow: [tsIso, CATEGORY_LABEL.corp, a.CO3, a.CO4, a.CO1, problems.join(' / '), a.CO14] };
  var id = nextId_((existing || []).map(function (e) { return e.id; }), 'B');
  var lines = a.CO11.split(/\r?\n/).filter(function (x) { return x.trim() !== ''; }).length;
  var row = blankRow_();
  row[RC.id] = id; row[RC.ts] = tsIso; row[RC.pname] = a.CO3; row[RC.pemail] = a.CO4; row[RC.line] = a.CO7; row[RC.officialLine] = a.CO8; row[RC.referrer] = a.CO9;
  row[RC.status] = '参加中'; row[RC.pnote] = a.CO14; row[RC.category] = 'corp'; row[RC.company] = a.CO1; row[RC.dept] = a.CO2; row[RC.phone] = a.CO6;
  row[RC.headcount] = String(plan.headcount); row[RC.plan] = plan.label; row[RC.targets] = a.CO11; row[RC.invoice] = a.CO13; row[RC.request] = a.CO12;
  if (lines !== plan.headcount) row[RC.memo] = 'プラン(' + plan.label + ')の人数(' + plan.headcount + ')と、記入された行数(' + lines + ')が一致しません。確認してください。';
  return { ok: true, category: 'corp', id: id, name: a.CO3, email: a.CO4, company: a.CO1, plan: plan, row: row };
}

/** 区分に応じて申込を処理する */
function processApplication_(namedValues, existing, tsIso, category) {
  category = category || 'career';
  if (category === 'general') return processGeneralApplication_(namedValues, existing, tsIso);
  if (category === 'corp') return processCorpApplication_(namedValues, existing, tsIso);
  return processCareerApplication_(namedValues, existing, tsIso);
}

/** 指定IDの行を除く。values: 2次元配列(1行目は見出し)、idCol: ID列の添字。戻り値: {kept, removed(件数)} */
function dropRowsById_(values, idCol, id) {
  var kept = [values[0]];
  var removed = 0;
  for (var i = 1; i < values.length; i++) {
    if (String(values[i][idCol]).trim() === id) removed++; else kept.push(values[i]);
  }
  return { kept: kept, removed: removed };
}

// 名簿の列の位置(0始まり。シートの列番号は +1)
var RC = { id: 0, ts: 1, pname: 2, pgender: 3, pbirth: 4, pemail: 5, line: 6, insta: 7, officialLine: 8, referrer: 9, cname: 10, cgender: 11, cbirth: 12, cemail: 13, session: 14, status: 15, T0: 16, T1: 17, T2: 18, exName: 19, exPlan: 20, pnote: 21, cnote: 22, memo: 23, category: 24, company: 25, dept: 26, phone: 27, headcount: 28, targets: 29, invoice: 30, request: 31, plan: 32 };

var LINK_TIMES = ['T0', 'T1', 'T2'];
function isParticipating_(status) { var s = String(status || '').trim(); return s === '' || s === '参加中'; }

/**
 * リンクを送る対象を選ぶ。
 * rows: [{row, id, email, status, sessionDate:'yyyy-MM-dd'|'', sent:{T0,T1,T2}}]
 * selectedSet が無い場合の条件: T0=鑑定日が入力済み/T1=鑑定日を過ぎた(当日を含む)/T2=鑑定の90日後以降。いずれも未送信
 */
function linksDue_(rows, time, today, selectedSet) {
  return rows.filter(function (r) {
    if (!r.id || r.id === CONFIG.TEST_ID || (r.category && r.category !== 'career') || !isEmail_(r.email) || !isEmail_(r.childEmail) || !isParticipating_(r.status)) return false;
    if (r.sent && r.sent[time]) return false;
    if (selectedSet) return !!selectedSet[r.row];
    if (!r.sessionDate) return false;
    if (time === 'T0') return true;
    var d = dayDiff_(today, r.sessionDate);
    if (time === 'T1') return d >= 0;
    return d >= CONFIG.T2_AFTER_DAYS;
  });
}

var TIME_LABEL = { T0: '鑑定前', T1: '鑑定直後', T2: '鑑定から約3か月後' };

/** 保護者宛(保護者用リンク)と、お子様宛(お子様用リンク)の、2通を作る */
function buildLinkEmails_(time, p, urls) {
  var dead = {
    T0: p.sessionDate ? '鑑定日(' + p.sessionDate + ')の前日までに' : '鑑定の前日までに',
    T1: '鑑定の当日から3日以内に',
    T2: 'ご都合のよいときに(鑑定から約3か月後の前後2週間ほどの間に)'
  }[time];
  var timesP = { T0: '約6〜8分', T1: '約6分', T2: '約7分' }[time];
  var timesC = { T0: '約8〜10分', T1: '約10分', T2: '約9〜10分' }[time];
  var subject = '【アンケートのご案内】' + TIME_LABEL[time] + 'のアンケート';
  var foot = '\n\n' + CONFIG.SENDER_NAME + '\n' + CONFIG.CONTACT_MAIL;
  var parent = {
    subject: subject,
    body: p.name + ' 様\n\n' + (time === 'T0' ? 'このたびは、お申込みありがとうございます。' : 'いつもご協力ありがとうございます。') + '\n' +
      TIME_LABEL[time] + 'のアンケート(保護者用)をご案内します。' + dead + 'ご回答ください。(所要時間の目安:' + timesP + ')\n\n' +
      '■ 保護者用アンケート\n' + urls.parent + '\n\n' +
      '【お願い】\n' +
      '・お子様用のアンケートのリンクは、お子様ご本人のメールアドレスにお送りしています。お子様の回答は、見たり、聞き出したりしないでください。\n' +
      '・できれば最後まで答えていただけると、とても助かります。答えにくい質問は、飛ばしても大丈夫です。途中でやめたくなったら、やめても大丈夫です。\n' +
      '・リンクは、他の方に転送しないでください。\n\nご不明な点や、気になることがあれば、このメールにご返信ください。' + foot
  };
  var child = {
    subject: subject,
    body: p.childName + ' さん\n\n' + TIME_LABEL[time] + 'のアンケートのご案内です。' + dead + '答えてください。(所要時間の目安:' + timesC + ')\n\n' +
      '■ アンケート\n' + urls.child + '\n\n' +
      '【お願い】\n' +
      '・正解はありません。思ったとおりに答えてください。\n' +
      '・お父さん・お母さんとは、別の場所(または別の端末)で、ひとりで答えてください。答えは、お父さん・お母さんには見せません。\n' +
      '・できれば最後まで答えてもらえると、とても助かります。答えにくい質問は、飛ばしても大丈夫です。途中でやめたくなったら、やめても大丈夫です。やめても、困ることはありません。\n' +
      '・リンクは、他の人に送らないでください。\n\n気になることがあれば、このメールに返信してください。' + foot
  };
  return { parent: parent, child: child };
}

/** 受付確認メール。お子様用はお子様のメールへ、保護者用は保護者のメールへ。回答内容は載せない */
function buildReceiptEmail_(formKey, p) {
  var isChild = SURVEY.forms[formKey].role === 'child';
  var tl = TIME_LABEL[SURVEY.forms[formKey].time];
  var foot = '\n\n' + CONFIG.SENDER_NAME + '\n' + CONFIG.CONTACT_MAIL;
  if (isChild) {
    return {
      subject: '【アンケートを受け付けました】' + tl,
      body: p.childName + ' さん\n\n' + tl + 'のアンケートへの回答を、受け付けました。ありがとうございました。\n(答えの内容は、このメールには書いていません。)\n\n気になることがあれば、このメールに返信してください。' + foot
    };
  }
  return {
    subject: '【アンケートを受け付けました】保護者用(' + tl + ')',
    body: p.name + ' 様\n\n保護者用(' + tl + ')のアンケートへのご回答を、受け付けました。ありがとうございました。\n※ご回答の内容は、このメールには記載していません。\n\nご不明な点や、気になることがあれば、このメールにご返信ください。' + foot
  };
}

function escHtml_(s) {
  return String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 申込の受付確認メール(文字版と、見た目を整えたHTML版)。お振込先・鑑定料・次のステップ・公式LINEを載せる */
function buildApplyReceiptEmail_(p, category) {
  var foot = '\n\n' + CONFIG.SENDER_NAME + '\n' + CONFIG.CONTACT_MAIL;
  var who, detail;
  if (category === 'corp') { who = p.name + ' 様'; detail = ['法人名:' + p.company, 'ご担当者:' + p.name]; }
  else if (category === 'career') { who = p.name + ' 様'; detail = ['保護者:' + p.name, 'お子様:' + p.childName + ' さん']; }
  else { who = p.name + ' 様'; detail = ['お名前:' + p.name]; }
  var plan = (category === 'corp') ? (p.plan || null) : null;
  var steps = ['日程の調整は、運営から改めてご連絡します。'];
  if (category === 'career') steps.push('アンケートのご案内は、日程が決まったあとに、保護者様とお子様のそれぞれのメールアドレスにお送りします。');
  steps.push('このメールに心当たりがない場合は、お手数ですが、ご返信ください。');

  var text = who + '\n\nお申込みありがとうございます。お申込みを受け付けました。\n\n' +
    '■ お申込み内容\n' + detail.join('\n') + '\n\n' +
    '■ 鑑定料・お振込先\n' + feeLines_(category, plan).join('\n') + '\n\n' + bankLines_().join('\n') + '\nお支払い方法は、口座振込のみです。\n\n' +
    '■ 次のステップ\n' + steps.map(function (x) { return '・' + x; }).join('\n') + '\n\n' +
    '■ 林 竜輔の公式LINE\nまだ追加していない方は、こちらから追加してください。\n' + LINE_URL + foot;

  var box = 'background:#f6f7f9;border-radius:10px;padding:14px 18px;margin:18px 0;';
  var row = function (a, b) { return '<tr><td style="padding:3px 14px 3px 0;color:#6b7785;white-space:nowrap;">' + escHtml_(a) + '</td><td style="padding:3px 0;">' + escHtml_(b) + '</td></tr>'; };
  var kv = function (lines) { return lines.map(function (l) { var i = l.indexOf(':'); return i < 0 ? row('', l) : row(l.slice(0, i), l.slice(i + 1)); }).join(''); };
  var html = '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Hiragino Sans\',\'Noto Sans JP\',sans-serif;color:#1f2933;line-height:1.75;max-width:560px;margin:0 auto;padding:20px 16px;">' +
    '<div style="font-size:12px;letter-spacing:.08em;color:#6b7785;">KAGAMI</div>' +
    '<h2 style="font-size:20px;margin:4px 0 16px;color:#1f2933;">お申込みを受け付けました</h2>' +
    '<p style="margin:0 0 6px;">' + escHtml_(who) + '</p>' +
    '<p style="margin:0;">お申込みありがとうございます。内容を確認のうえ、運営から改めてご連絡します。</p>' +
    '<div style="' + box + '"><div style="font-weight:700;margin-bottom:6px;">お申込み内容</div><table style="border-collapse:collapse;font-size:14px;">' + kv(detail) + '</table></div>' +
    '<div style="border:2px solid #2e6da4;border-radius:10px;padding:14px 18px;margin:18px 0;">' +
    '<div style="font-weight:700;margin-bottom:6px;color:#2e6da4;">鑑定料・お振込先</div>' +
    '<div style="font-size:22px;font-weight:700;margin:2px 0 8px;">' + escHtml_(feeLines_(category, plan).filter(function (l) { return l.indexOf('鑑定料:') === 0; }).map(function (l) { return l.replace('鑑定料:', ''); }).join(' / ') || feeLines_(category, plan).join(' ')) + '</div>' +
    (category === 'corp' && !plan ? '' : '') +
    '<table style="border-collapse:collapse;font-size:14px;">' + kv(bankLines_()) + '</table>' +
    '<div style="font-size:12px;color:#6b7785;margin-top:8px;">お支払い方法は、口座振込のみです。</div></div>' +
    '<div style="margin:18px 0;"><div style="font-weight:700;margin-bottom:4px;">次のステップ</div><ol style="margin:0;padding-left:20px;">' + steps.map(function (x) { return '<li>' + escHtml_(x) + '</li>'; }).join('') + '</ol></div>' +
    '<div style="' + box + 'text-align:center;"><div style="margin-bottom:10px;">林 竜輔の公式LINEを、まだ追加していない方は、こちらから追加してください。</div>' +
    '<a href="' + escHtml_(LINE_URL) + '" style="display:inline-block;background:#06c755;color:#ffffff;text-decoration:none;font-weight:700;padding:11px 26px;border-radius:24px;">公式LINEを追加する</a></div>' +
    '<p style="font-size:13px;color:#6b7785;margin:18px 0 0;">ご不明な点があれば、このメールにご返信ください。<br>' + escHtml_(CONFIG.SENDER_NAME) + '(' + escHtml_(CONFIG.CONTACT_MAIL) + ')</p></div>';
  return { subject: '【お申込みを受け付けました】算命学の鑑定', body: text, html: html };
}

// ======================================================================
// フォーム構築(Apps Script)
// ======================================================================

/** 入力チェックの設定に失敗しても、フォームの作成を止めない(受付後に、運営側のプログラムでも同じ確認をしている) */
function setValidationSafe_(item, validation) {
  try { item.setValidation(validation); }
  catch (e) { Logger.log('【注意】入力チェックを設定できませんでした: ' + item.getTitle() + ' (' + e + ')。回答は受け付けたあとに、運営側のプログラムでも確認します。'); }
}

function buildFormFromDef_(def, ss, confirmMessage) {
  var form = FormApp.create(def.title);
  form.setDescription(def.intro);
  form.setCollectEmail(false);
  form.setAllowResponseEdits(false);
  form.setLimitOneResponsePerUser(false);
  form.setProgressBar(true);
  form.setShowLinkToRespondAgain(false);
  form.setPublishingSummary(false);
  form.setShuffleQuestions(false);
  form.setConfirmationMessage(confirmMessage || ('ご回答ありがとうございました。気になることがあれば、いつでもご連絡ください。' + CONFIG.CONTACT_TEXT));

  var pages = [];
  var pendingGates = [];
  var firstBlock = true;

  def.blocks.forEach(function (b) {
    if (b.type === 'page') {
      var item;
      if (firstBlock) {
        item = form.addSectionHeaderItem().setTitle(b.title);
        if (b.desc) item.setHelpText(b.desc);
      } else {
        item = form.addPageBreakItem().setTitle(b.title);
        if (b.desc) item.setHelpText(b.desc);
      }
      pages.push({ block: b, item: item, isHeader: firstBlock });
      firstBlock = false;
      return;
    }
    firstBlock = false;
    var it;
    var hint = def.category ? applyTitleParts_(b).hint : '';
    var title = def.category ? applyTitleParts_(b).title : qTitle_(b);
    if (b.kind === 'id') {
      it = form.addTextItem().setTitle(title);
      setValidationSafe_(it, FormApp.createTextValidation().requireTextMatchesPattern(SURVEY.idPattern).setHelpText('F0001 の形式です。専用リンクから開くと自動で入力されます。').build());
      it.setRequired(true);
    } else if (b.kind === 'email') {
      it = form.addTextItem().setTitle(title);
      setValidationSafe_(it, FormApp.createTextValidation().requireTextIsEmail().build());
      it.setRequired(!!b.required);
    } else if (b.kind === 'text1') {
      it = form.addTextItem().setTitle(title);
      it.setRequired(!!b.required);
    } else if (b.kind === 'birth') {
      it = form.addTextItem().setTitle(title);
      setValidationSafe_(it, FormApp.createTextValidation().requireTextMatchesPattern('^[0-9]{8}$').setHelpText('8桁の数字で入力してください。(例:20000218)').build());
      it.setRequired(!!b.required);
    } else if (b.kind === 'int') {
      it = form.addTextItem().setTitle(title);
      setValidationSafe_(it, FormApp.createTextValidation().requireTextMatchesPattern('^[0-9]{1,3}$').setHelpText('半角の数字で入力してください。').build());
      it.setRequired(!!b.required);
    } else if (b.kind === 'phone') {
      it = form.addTextItem().setTitle(title);
      setValidationSafe_(it, FormApp.createTextValidation().requireTextMatchesPattern('^[0-9\\-]{9,13}$').setHelpText('半角の数字(ハイフンは省略可)で入力してください。').build());
      it.setRequired(!!b.required);
    } else if (b.kind === 'katakana') {
      it = form.addTextItem().setTitle(title);
      setValidationSafe_(it, FormApp.createTextValidation().requireTextMatchesPattern('^[ァ-ヺー・\\s\u3000]+$').setHelpText('カタカナで入力してください。(いない場合は「ナシ」)').build());
      if (hint) it.setHelpText(hint);
      it.setRequired(!!b.required);
    } else if (b.kind === 'consent' || b.kind === 'check') {
      it = form.addCheckboxItem().setTitle(title);
      it.setChoices([it.createChoice(b.choices[0])]);
      if (b.help) it.setHelpText(b.help);
      it.setRequired(!!b.required);
    } else if (b.kind === 'age') {
      it = form.addTextItem().setTitle(title);
      setValidationSafe_(it, FormApp.createTextValidation().requireNumberBetween(5, 25).setHelpText('数字(歳)で入力してください。').build());
      it.setRequired(false);
    } else if (b.kind === 'text') {
      it = form.addParagraphTextItem().setTitle(title);
      it.setRequired(!!b.required);
      if (b.note || hint) it.setHelpText([b.note, hint].filter(Boolean).join('\n'));
    } else if (b.kind === 'multi') {
      it = form.addCheckboxItem().setTitle(title);
      it.setChoices(choicesOf_(b).map(function (c) { return it.createChoice(c); }));
      it.setRequired(false);
      if (b.exclusive) it.setHelpText('「' + b.exclusive + '」を選ぶときは、他の項目は選ばないでください。');
    } else {
      it = form.addMultipleChoiceItem().setTitle(title);
      it.setChoices(choicesOf_(b).map(function (c) { return it.createChoice(c); }));
      it.setRequired(!!b.required);
      if (b.gate) pendingGates.push({ item: it, q: b, pageIndex: pages.length - 1 });
    }
  });

  pendingGates.forEach(function (g) {
    var target = null;
    for (var j = g.pageIndex + 1; j < pages.length; j++) {
      if (!pages[j].block.conditional) { target = pages[j].item; break; }
    }
    var choices = choicesOf_(g.q).map(function (c) {
      if (c !== g.q.gate.skip) return g.item.createChoice(c, FormApp.PageNavigationType.CONTINUE);
      return target ? g.item.createChoice(c, target) : g.item.createChoice(c, FormApp.PageNavigationType.SUBMIT);
    });
    g.item.setChoices(choices);
  });

  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
  return form;
}

function buildForm_(key, ss) { return buildFormFromDef_(SURVEY.forms[key], ss); }

function renameNewSheet_(ss, beforeIds, name) {
  SpreadsheetApp.flush();
  ss.getSheets().forEach(function (s) { if (beforeIds.indexOf(s.getSheetId()) === -1) s.setName(name); });
}

/** セットアップをやり直す前に実行する(記録された設定だけを消す。作成済みのファイルやフォームは消えません) */
function resetSetup() {
  ownerOnly_();
  var props = PropertiesService.getScriptProperties();
  ['SS_ID', 'REG_SS_ID', 'FORM_IDS'].forEach(function (k) { props.deleteProperty(k); });
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  Logger.log('設定とトリガーを消しました。作成済みのスプレッドシートやフォームは、ドライブから手動で削除してください。そのあと setup() を実行できます。');
}

function setup() {
  ownerOnly_();
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SS_ID')) throw new Error('すでにセットアップ済みです。やり直す場合は、スクリプトプロパティ SS_ID・REG_SS_ID・FORM_IDS を削除してください(既存の回答は消えません)。');
  var errors = validateSurveyDefinition_();
  if (errors.length) throw new Error('設問定義にエラーがあります:\n' + errors.join('\n'));
  var reg = SpreadsheetApp.getActiveSpreadsheet();
  var standalone = !reg;
  if (standalone) reg = SpreadsheetApp.create(CONFIG.REG_NAME);

  var db = SpreadsheetApp.create(CONFIG.DB_NAME);

  var formIds = {};
  SURVEY.formKeys.forEach(function (key) {
    var before = db.getSheets().map(function (s) { return s.getSheetId(); });
    var form;
    try { form = buildForm_(key, db); } catch (e) { throw new Error(key + ' のフォームの作成に失敗しました: ' + e); }
    formIds[key] = form.getId();
    renameNewSheet_(db, before, 'resp_' + key);
  });
  var applyUrls = [];
  [['APPLY', SURVEY.apply, 'resp_APPLY'], ['APPLY_G', SURVEY.applyG, 'resp_APPLY_G'], ['APPLY_B', SURVEY.applyB, 'resp_APPLY_B']].forEach(function (x) {
    var beforeReg = reg.getSheets().map(function (s) { return s.getSheetId(); });
    var af;
    try { af = buildFormFromDef_(x[1], reg, x[1].confirm); } catch (e) { throw new Error(x[0] + ' の申込フォームの作成に失敗しました: ' + e); }
    formIds[x[0]] = af.getId();
    renameNewSheet_(reg, beforeReg, x[2]);
    applyUrls.push(CATEGORY_LABEL[x[1].category] + ' 申込フォーム(公開用): ' + af.getPublishedUrl());
  });
  props.setProperty('SS_ID', db.getId());
  props.setProperty('REG_SS_ID', reg.getId());
  props.setProperty('FORM_IDS', JSON.stringify(formIds));

  initDbSheets_(db);
  initRegSheets_(reg);
  ScriptApp.newTrigger('onFormSubmit').forSpreadsheet(db).onFormSubmit().create();
  ScriptApp.newTrigger('onApplySubmit').forSpreadsheet(reg).onFormSubmit().create();
  ScriptApp.newTrigger('checkOverdue').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('checkReminders').timeBased().everyDays(1).atHour(9).create();

  if (standalone) Logger.log('※このスクリプトはスプレッドシートに紐づいていないため、台帳を自動で作りました。台帳のメニュー「アンケート運用」は使えません。リンクの送信・鑑定日の入力などは、確認サイト(ウェブアプリ)の画面で行ってください。');
  Logger.log('台帳: ' + reg.getUrl());
  Logger.log('回答DB: ' + db.getUrl());
  applyUrls.forEach(function (u) { Logger.log(u); });
}

function mkSheet_(ss, name, header) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (header) { sh.clear(); sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold'); sh.setFrozenRows(1); }
  return sh;
}

function initDbSheets_(db) {
  mkSheet_(db, SHEETS.submissions, HEAD.submissions);
  mkSheet_(db, SHEETS.long, HEAD.long);
  mkSheet_(db, SHEETS.options, HEAD.options);
  mkSheet_(db, SHEETS.summary, ['(buildSummary() を実行すると作成されます)']);
  var cb = mkSheet_(db, SHEETS.codebook, null);
  cb.clear();
  var rows = buildCodebookRows_();
  cb.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  cb.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
  cb.setFrozenRows(1);
}

function initRegSheets_(reg) {
  mkSheet_(reg, SHEETS.roster, HEAD.roster);
  var settings = mkSheet_(reg, SHEETS.settings, ['項目', '値', '説明']);
  settings.getRange(2, 1, 5, 3).setValues([
    ['安全対応担当者メール', '', '回答に確認が必要な内容があった場合の通知先(1名)'],
    ['安全対応担当者メール(代理)', '', '担当者不在時の通知先'],
    ['このファイルについて', '', 'この台帳には個人情報(お名前・メールアドレス)が入っています。運営のみに共有してください。調査の分析には、別ファイルの「' + CONFIG.DB_NAME + '」を使います'],
    ['注意', '', '回答DBは、調査担当者のみに共有してください。子ども・保護者・鑑定師には共有しないでください'],
    ['運営メール(通知先)', CONFIG.CONTACT_MAIL, '新しい申込・毎朝9時のリマインド一覧が届きます。辞退した家庭は、名簿の「参加状況」を「辞退」にしてください(送信・リマインドが止まります)']
  ]);
  mkSheet_(reg, SHEETS.safety, HEAD.safety);
  mkSheet_(reg, SHEETS.reminders, HEAD.reminders);
  mkSheet_(reg, SHEETS.sendlog, HEAD.sendlog);
  mkSheet_(reg, SHEETS.pending, HEAD.pending);
  mkSheet_(reg, SHEETS.tests, ['テスト', '結果', '詳細']);
}

function regSS_() { return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('REG_SS_ID')); }
function dbSS_() { return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SS_ID')); }
function getFormIds_() { return JSON.parse(PropertiesService.getScriptProperties().getProperty('FORM_IDS')); }
function todayStr_() { return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'); }
function nowStr_() { return Utilities.formatDate(new Date(), 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ss"); }
function opMail_(reg) { return String(reg.getSheetByName(SHEETS.settings).getRange('B6').getValue()).trim(); }

function readRoster_(reg) {
  var v = reg.getSheetByName(SHEETS.roster).getDataRange().getValues();
  v.shift();
  function ds(d) { return isDate_(d) ? Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd') : String(d || '').trim(); }
  function ts(d) { return isDate_(d) ? Utilities.formatDate(d, 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ss") : String(d || '').trim(); }
  function t(x) { return String(x === undefined || x === null ? '' : x).trim(); }
  return v.map(function (r, i) {
    return { row: i + 2, id: t(r[RC.id]), appliedAt: ts(r[RC.ts]), name: t(r[RC.pname]), pGender: t(r[RC.pgender]), pBirth: t(r[RC.pbirth]), email: t(r[RC.pemail]),
      line: t(r[RC.line]), insta: t(r[RC.insta]), officialLine: t(r[RC.officialLine]), referrer: t(r[RC.referrer]),
      childName: t(r[RC.cname]), cGender: t(r[RC.cgender]), cBirth: t(r[RC.cbirth]), childEmail: t(r[RC.cemail]),
      sessionDate: ds(r[RC.session]), status: r[RC.status], sent: { T0: ts(r[RC.T0]), T1: ts(r[RC.T1]), T2: ts(r[RC.T2]) },
      exName: t(r[RC.exName]), exPlan: t(r[RC.exPlan]), pNote: t(r[RC.pnote]), cNote: t(r[RC.cnote]), memo: t(r[RC.memo]),
      category: t(r[RC.category]) || 'career', company: t(r[RC.company]), dept: t(r[RC.dept]), phone: t(r[RC.phone]), headcount: t(r[RC.headcount]),
      targets: t(r[RC.targets]), invoice: t(r[RC.invoice]), request: t(r[RC.request]), plan: t(r[RC.plan]) };
  }).filter(function (r) { return r.id; });
}

var formCache_ = {};
/** 調査用ID入力済みの専用リンク */
function getPrefilledUrl_(formKey, id) {
  if (!formCache_[formKey]) {
    var f = FormApp.openById(getFormIds_()[formKey]);
    formCache_[formKey] = { form: f, item: f.getItems(FormApp.ItemType.TEXT).filter(function (i) { return i.getTitle().indexOf('RID. ') === 0; })[0] };
  }
  var c = formCache_[formKey];
  return c.form.createResponse().withItemResponse(c.item.asTextItem().createResponse(id)).toPrefilledUrl();
}

function sendMail_(to, subject, body, html) {
  var o = { to: to, subject: subject, body: body, name: CONFIG.SENDER_NAME, replyTo: CONFIG.CONTACT_MAIL };
  if (html) o.htmlBody = html;
  MailApp.sendEmail(o);
}

// ======================================================================
// 申込・送信
// ======================================================================

/** 申込フォームの送信時: 調査用IDを発行して名簿に登録し、受付確認メールを送る */
function onApplySubmit(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = e.range.getSheet();
    var reg = sheet.getParent();
    var category = { resp_APPLY: 'career', resp_APPLY_G: 'general', resp_APPLY_B: 'corp' }[sheet.getName()];
    if (!category) return;
    var tsIso = nowStr_();
    var existing = readRoster_(reg).map(function (r) { return { id: r.id, email: r.email, childName: r.childName, name: r.name, company: r.company, category: r.category }; });
    var res = processApplication_(normalizeApplyNamed_(SURVEY[{ career: 'apply', general: 'applyG', corp: 'applyB' }[category]], e.namedValues), existing, tsIso, category);
    var label = CATEGORY_LABEL[category];
    if (res.ok) {
      finishApplication_(reg, category, res, tsIso);
    } else {
      reg.getSheetByName(SHEETS.pending).appendRow(res.pendingRow);
      var op = opMail_(reg);
      if (op) sendMail_(op, '[調査アンケート] 確認が必要な申込があります(' + label + ')', '理由: ' + res.reason + '\n「申込要確認」シートをご確認ください。(IDは発行していません)\n' + reg.getUrl());
    }
  } finally {
    lock.releaseLock();
  }
}

function getSelectedRows_(reg) {
  var sh = reg.getActiveSheet();
  var set = {};
  if (sh.getName() !== SHEETS.roster) return set;
  var rg = reg.getActiveRange();
  if (!rg) return set;
  for (var r = rg.getRow(); r < rg.getRow() + rg.getNumRows(); r++) if (r >= 2) set[r] = true;
  return set;
}

function sendT0All() { sendLinks_('T0', null); }
function sendT1All() { sendLinks_('T1', null); }
function sendT2All() { sendLinks_('T2', null); }
function sendT0Selected() { sendLinks_('T0', 'selected'); }
function sendT1Selected() { sendLinks_('T1', 'selected'); }
function sendT2Selected() { sendLinks_('T2', 'selected'); }

/** 対象の家庭に、保護者宛・お子様宛のリンクをメールで送り、送信日時を名簿に記録する(メニューとサイトの共通処理) */
function sendLinksToFamilies_(reg, time, due) {
  var sh = reg.getSheetByName(SHEETS.roster);
  var log = reg.getSheetByName(SHEETS.sendlog);
  var col = RC.T0 + 1 + LINK_TIMES.indexOf(time);
  var ok = 0, ng = 0;
  due.forEach(function (d) {
    var stamp = nowStr_();
    var okParent = false, okChild = false;
    try {
      var mails = buildLinkEmails_(time, d, { child: getPrefilledUrl_('CT' + time.charAt(1), d.id), parent: getPrefilledUrl_('PT' + time.charAt(1), d.id) });
      try { sendMail_(d.email, mails.parent.subject, mails.parent.body); okParent = true; log.appendRow([stamp, d.id, time + ' 保護者宛', d.email, '送信済み']); } catch (e1) { log.appendRow([stamp, d.id, time + ' 保護者宛', d.email, '【失敗】' + e1]); }
      try { sendMail_(d.childEmail, mails.child.subject, mails.child.body); okChild = true; log.appendRow([stamp, d.id, time + ' お子様宛', d.childEmail, '送信済み']); } catch (e2) { log.appendRow([stamp, d.id, time + ' お子様宛', d.childEmail, '【失敗】' + e2]); }
    } catch (err) {
      log.appendRow([stamp, d.id, time, '', '【リンク作成に失敗】' + err]);
    }
    if (okParent && okChild) { sh.getRange(d.row, col).setValue(stamp); ok++; } else { ng++; }
  });
  return { ok: ok, ng: ng };
}

/** 確認ダイアログのあと、対象の家庭にアンケートのリンクをメールで送る(ボタン=メニューから実行) */
function sendLinks_(time, mode) {
  ownerOnly_();
  var reg = regSS_();
  var ui = SpreadsheetApp.getUi();
  var selected = (mode === 'selected') ? getSelectedRows_(reg) : null;
  if (mode === 'selected' && !Object.keys(selected).length) { ui.alert('「名簿」シートで、送りたい家庭の行を選んでから実行してください。'); return; }
  var rows = readRoster_(reg);
  var due = linksDue_(rows, time, todayStr_(), selected);
  if (!due.length) {
    ui.alert('送る対象の家庭はありません', TIME_LABEL[time] + 'のアンケートの、送信条件に合う家庭がありません。\n\n' +
      (mode === 'selected' ? '(選択した家庭は、送信済み・辞退・メールアドレス未入力のいずれかです)' :
        { T0: '条件:「鑑定日」が入力済みで、T0を未送信、参加中の家庭', T1: '条件:鑑定日が今日以前で、T1を未送信、参加中の家庭', T2: '条件:鑑定日から' + CONFIG.T2_AFTER_DAYS + '日以上たち、T2を未送信、参加中の家庭' }[time]), ui.ButtonSet.OK);
    return;
  }
  var quota = MailApp.getRemainingDailyQuota();
  if (quota < due.length) { ui.alert('今日の送信上限に足りません', '残りの送信可能数: ' + quota + '通 / 必要: ' + due.length + '通。明日以降に実行してください。', ui.ButtonSet.OK); return; }
  var list = due.slice(0, 20).map(function (d) { return d.id + ' ' + d.name + ' <' + d.email + '> / お子様:' + d.childName + ' <' + d.childEmail + '>' + (d.sessionDate ? ' 鑑定日:' + d.sessionDate : ''); }).join('\n');
  var ans = ui.alert('送信の確認', due.length + '家庭に、' + TIME_LABEL[time] + 'のアンケートのリンク(子ども用・保護者用)を、メールで送ります。\n\n' + list + (due.length > 20 ? '\n…ほか' + (due.length - 20) + '家庭' : '') + '\n\n送ってよろしいですか?', ui.ButtonSet.YES_NO);
  if (ans !== ui.Button.YES) return;

  var res = sendLinksToFamilies_(reg, time, due);
  var ok = res.ok, ng = res.ng;
  ui.alert('送信が終わりました', '保護者・お子様の両方に送れた家庭: ' + ok + ' / 一部または全部が失敗: ' + ng + '\n(結果は「送信ログ」シートで確認できます。失敗した家庭は、送信日時が空欄のままなので、もう一度実行できます。ただし、すでに届いた宛先には重複して届きます)', ui.ButtonSet.OK);
}


/** 指定IDの回答データ(回答DB)と、名簿の個人情報を削除する(メニューとサイトの共通処理)。削除した回答DBの行数を返す */
function deleteFamilyCore_(reg, db, fam) {
  var id = fam.id;
  var total = 0;
  db.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (sh.getLastRow() < 2) return;
    var vals = sh.getDataRange().getValues();
    var idCol = -1;
    if (name === SHEETS.long || name === SHEETS.options || name === SHEETS.submissions) idCol = vals[0].indexOf('調査用ID');
    else if (name.indexOf('resp_') === 0) vals[0].forEach(function (h, i) { if (String(h).indexOf('RID.') === 0) idCol = i; });
    if (idCol < 0) return;
    var res = dropRowsById_(vals, idCol, id);
    if (!res.removed) return;
    total += res.removed;
    sh.clearContents();
    sh.getRange(1, 1, res.kept.length, res.kept[0].length).setValues(res.kept);
  });
  var rsh = reg.getSheetByName(SHEETS.roster);
  rsh.getRange(fam.row, RC.pname + 1, 1, RC.cemail - RC.pname + 1).clearContent();
  rsh.getRange(fam.row, RC.exName + 1, 1, 4).clearContent();
  rsh.getRange(fam.row, RC.company + 1, 1, RC.request - RC.company + 1).clearContent();
  rsh.getRange(fam.row, RC.status + 1).setValue('削除済み');
  rsh.getRange(fam.row, RC.memo + 1).setValue('削除のお申し出により、' + todayStr_() + ' に回答データと個人情報を削除');
  reg.getSheetByName(SHEETS.sendlog).appendRow([nowStr_(), id, '削除', '', '回答データ' + total + '行・個人情報を削除']);
  return total;
}

/** 削除のお申し出があったとき(メニューから): 調査用IDの回答データを回答DBから削除し、名簿の個人情報も消す */
function deleteFamilyData() {
  ownerOnly_();
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('削除するID', '削除を申し出た方のID(例:F0001)を入力してください。この操作は元に戻せません。', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var id = r.getResponseText().trim();
  if (!/^[FGB][0-9]{4}$/.test(id)) { ui.alert('IDの形式が正しくありません(F0001・G0001・B0001 の形式)'); return; }
  var reg = regSS_();
  var fam = readRoster_(reg).filter(function (x) { return x.id === id; })[0];
  if (!fam) { ui.alert('名簿に ' + id + ' が見つかりません'); return; }
  var ans = ui.alert('削除の確認', id + '(' + fam.name + ' 様)の、アンケートの回答データをすべて削除し、名簿の個人情報を消去します。\n\n元に戻せません。実行しますか?', ui.ButtonSet.YES_NO);
  if (ans !== ui.Button.YES) return;
  var total = deleteFamilyCore_(reg, dbSS_(), fam);
  ui.alert('削除しました', '回答DBから ' + total + ' 行を削除し、名簿の個人情報を消去しました。(安全対応ログ・送信ログに残るIDの記録は、必要に応じて手動で整理してください)', ui.ButtonSet.OK);
}

function onOpen() {
  SpreadsheetApp.getUi().createMenu('アンケート運用')
    .addItem('T0(鑑定前)のリンクを送る — 鑑定日が入力済みの家庭', 'sendT0All')
    .addItem('T1(鑑定直後)のリンクを送る — 鑑定日を過ぎた家庭', 'sendT1All')
    .addItem('T2(約3か月後)のリンクを送る — 鑑定の90日後以降の家庭', 'sendT2All')
    .addSeparator()
    .addItem('選択した家庭に T0 を送る', 'sendT0Selected')
    .addItem('選択した家庭に T1 を送る', 'sendT1Selected')
    .addItem('選択した家庭に T2 を送る', 'sendT2Selected')
    .addSeparator()
    .addItem('削除のお申し出があった家庭のデータを削除する', 'deleteFamilyData')
    .addSeparator()
    .addItem('今日のリマインド対象を確認する', 'checkReminders')
    .addItem('集計を更新する', 'buildSummary')
    .addItem('CSVを出力する', 'exportCsv')
    .addToUi();
}

// ======================================================================
// 回答の受信(回答DB)
// ======================================================================

function onFormSubmit(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var sheet = e.range.getSheet();
    var name = sheet.getName();
    if (name.indexOf('resp_') !== 0) return;
    var key = name.replace('resp_', '');
    if (!SURVEY.forms[key]) return;
    var db = sheet.getParent();
    var reg = regSS_();
    var tsIso = nowStr_();
    var sid = key + '-' + Utilities.getUuid().slice(0, 8);

    var roster = readRoster_(reg);
    var byId = {};
    roster.forEach(function (r) { byId[r.id] = r; });
    var subSheet = db.getSheetByName(SHEETS.submissions);
    var prior = {};
    if (subSheet.getLastRow() > 1) {
      subSheet.getRange(2, 3, subSheet.getLastRow() - 1, 3).getValues().forEach(function (r) { prior[r[0] + '|' + r[2]] = true; });
    }
    var ctx = {
      isRegistered: function (id) { return !!byId[id]; },
      hasPrior: function (id, k) { return !!prior[id + '|' + k]; }
    };
    var res = processSubmission_(key, e.namedValues, tsIso, sid, ctx);

    subSheet.appendRow(res.submission);
    var longSheet = db.getSheetByName(SHEETS.long);
    if (res.rows.length) longSheet.getRange(longSheet.getLastRow() + 1, 1, res.rows.length, HEAD.long.length).setValues(res.rows);
    var optSheet = db.getSheetByName(SHEETS.options);
    if (res.optionRows.length) optSheet.getRange(optSheet.getLastRow() + 1, 1, res.optionRows.length, HEAD.options.length).setValues(res.optionRows);

    if (res.reasons.length) notifySafety_(reg, db.getUrl(), res, key, tsIso);

    // 受付確認メール(回答内容は載せない)。登録済みの家庭の、最初の送信のみ。お子様用はお子様のメール、保護者用は保護者のメールへ
    var fam = byId[res.rid];
    var toAddr = fam ? (SURVEY.forms[key].role === 'child' ? fam.childEmail : fam.email) : '';
    if (!res.isTest && res.adopted && fam && isEmail_(toAddr) && res.flags.indexOf('ID形式不正') === -1) {
      var mail = buildReceiptEmail_(key, { name: fam.name, childName: fam.childName });
      var result = '送信済み';
      try { sendMail_(toAddr, mail.subject, mail.body); } catch (err) { result = '【送信失敗】' + err; }
      reg.getSheetByName(SHEETS.sendlog).appendRow([tsIso, res.rid, key + ' 受付確認', toAddr, result]);
    }
  } finally {
    lock.releaseLock();
  }
}

/** 安全対応担当者へ通知(回答内容は含めない。調査用ID・フォーム・理由のみ) */
function notifySafety_(reg, dbUrl, res, key, tsIso) {
  var settings = reg.getSheetByName(SHEETS.settings);
  var to = [String(settings.getRange('B2').getValue()).trim(), String(settings.getRange('B3').getValue()).trim()].filter(function (s) { return s !== ''; });
  var due = new Date(Date.now() + 24 * 3600 * 1000);
  var dueStr = Utilities.formatDate(due, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  var result;
  if (res.isTest) result = 'テスト送信のためメール送信なし';
  else if (!to.length) result = '【未送信】通知先が未設定です(設定シートに入力してください)';
  else {
    try {
      sendMail_(to.join(','), '[調査アンケート] 確認が必要な回答があります(' + res.rid + ' / ' + key + ')',
        '調査用ID: ' + res.rid + '\nフォーム: ' + key + '\n受信: ' + tsIso + '\n理由:\n- ' + res.reasons.join('\n- ') +
        '\n\n対応期限: ' + dueStr + '(受信後24時間以内)\n回答内容は、回答DBの該当行を直接ご確認ください。このメールには回答内容を記載していません。\n台帳(連絡先): ' + reg.getUrl() + '\n回答DB: ' + dbUrl);
      result = '送信済み';
    } catch (err) { result = '【送信失敗】' + err; }
  }
  reg.getSheetByName(SHEETS.safety).appendRow([tsIso, res.rid, key, res.reasons.join(' / '), to.join(','), result, dueStr, '未対応', '', '', '']);
}

/** 24時間を超えて未対応の通知がある場合、再通知する(毎時実行) */
function checkOverdue() {
  var reg = regSS_();
  var sh = reg.getSheetByName(SHEETS.safety);
  if (sh.getLastRow() < 2) return;
  var settings = reg.getSheetByName(SHEETS.settings);
  var to = [String(settings.getRange('B2').getValue()).trim(), String(settings.getRange('B3').getValue()).trim()].filter(function (s) { return s !== ''; });
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, HEAD.safety.length).getValues();
  var now = Date.now();
  var overdue = [];
  vals.forEach(function (r, i) {
    if (r[7] === '未対応' && String(r[1]) !== CONFIG.TEST_ID) {
      var due = dueMs_(r[6]);
      if (!isNaN(due) && now > due) { overdue.push(r[1] + '(' + r[2] + ')'); sh.getRange(i + 2, 8).setValue('期限超過・未対応'); }
    }
  });
  if (overdue.length && to.length) {
    sendMail_(to.join(','), '[調査アンケート] 対応期限を過ぎた確認依頼があります', '次の確認依頼が、24時間以内に「対応済」になっていません:\n- ' + overdue.join('\n- ') + '\n' + reg.getUrl());
  }
}

/** 毎朝9時に、その日にリマインドする家庭の一覧を運営にメールする(家庭へ直接は送らない) */
function checkReminders() {
  var reg = regSS_();
  var db = dbSS_();
  var today = todayStr_();
  var roster = readRoster_(reg);
  var sub = db.getSheetByName(SHEETS.submissions).getDataRange().getValues();
  sub.shift();
  var adopted = {};
  sub.forEach(function (r) { if (isTrue_(r[6])) adopted[r[2] + '|' + r[4]] = true; });
  var due = remindersDue_(roster, adopted, today);
  if (!due.length) return;
  var byId = {};
  roster.forEach(function (r) { byId[r.id] = r; });
  var to = opMail_(reg);
  var lines = due.map(function (d) {
    var f = byId[d.id] || {};
    return d.id + ' ' + (f.name || '') + ' <' + (f.email || '') + '> / ' + d.form + '(' + (d.form.charAt(0) === 'C' ? '子ども' : '保護者') + ')/ ' + d.nth + '回目\n  ' + getPrefilledUrl_(d.form, d.id);
  });
  var log = reg.getSheetByName(SHEETS.reminders);
  due.forEach(function (d) { log.appendRow([today, d.id, d.form, d.nth, to]); });
  if (!to) { Logger.log('通知先(設定シートB6)が未設定です'); return; }
  sendMail_(to, '[調査アンケート] 本日のリマインド対象 ' + due.length + '件(' + today + ')',
    '次の家庭・フォームが未回答です。声かけをお願いします。リマインドは1つのフォームにつき最大2回です。\n' +
    '辞退された家庭には送らないでください(名簿の「参加状況」を「辞退」にすると、通知が止まります)。\n\n' + lines.join('\n') +
    '\n\n--- 文面の例(強制にならないようにしてください) ---\nアンケートへのご協力ありがとうございます。まだ回答がお済みでないようでしたら、お時間のあるときに、できる範囲でご回答いただけると助かります。答えにくい質問は飛ばしていただいて大丈夫です。\n' + reg.getUrl());
}


// ======================================================================
// 申込データを確認するサイト(ウェブアプリ)
// ======================================================================

/** 次にやること(運営向け)。resp: {CT0:ts,...}(分析採用の送信) */
function nextAction_(f, resp, today) {
  if (!isParticipating_(f.status)) return String(f.status || '') === '削除済み' ? '(削除済み)' : '(' + f.status + ')';
  if (!f.sessionDate) return '日程調整 → 鑑定日を入力';
  var d = dayDiff_(today, f.sessionDate);
  if (f.category && f.category !== 'career') {
    if (d < 0) return '鑑定待ち(' + (-d) + '日後)';
    return '鑑定日を過ぎました(完了にする場合は、参加状況を「完了」に)';
  }
  function both(t) { return !!(resp['CT' + t.charAt(1)] && resp['PT' + t.charAt(1)]); }
  if (!f.sent.T0) return 'T0のリンクを送る';
  if (!both('T0')) return 'T0の回答待ち';
  if (d < 0) return '鑑定待ち(' + (-d) + '日後)';
  if (!f.sent.T1) return 'T1のリンクを送る';
  if (!both('T1')) return 'T1の回答待ち';
  if (d < CONFIG.T2_AFTER_DAYS) return 'T2待ち(あと' + (CONFIG.T2_AFTER_DAYS - d) + '日)';
  if (!f.sent.T2) return 'T2のリンクを送る';
  if (!both('T2')) return 'T2の回答待ち';
  return '完了';
}

/**
 * ダッシュボード用のデータを組み立てる。
 * roster: readRoster_の結果  pending: [[受付日時, 保護者名, メール, お子様名, 理由, 連絡事項]]
 * subs: Submissionsの行(見出しなし)  safety: 安全対応ログの行(見出しなし)
 */
function buildDashboardData_(roster, pending, subs, safety, today) {
  var respBy = {};
  subs.forEach(function (r) {
    if (!isTrue_(r[6]) || isTrue_(r[12])) return;
    (respBy[r[2]] = respBy[r[2]] || {})[r[4]] = cellStr_(r[1]);
  });
  var families = roster.map(function (f) {
    var resp = respBy[f.id] || {};
    return { id: f.id, category: f.category || 'career', appliedAt: f.appliedAt, name: f.name, pGender: f.pGender, pBirth: f.pBirth, email: f.email, line: f.line, insta: f.insta,
      officialLine: f.officialLine, referrer: f.referrer, childName: f.childName, cGender: f.cGender, cBirth: f.cBirth, childEmail: f.childEmail,
      sessionDate: f.sessionDate, status: String(f.status || '参加中'), sent: f.sent, resp: resp, exName: f.exName, exPlan: f.exPlan,
      pNote: f.pNote, cNote: f.cNote, memo: f.memo, company: f.company, dept: f.dept, phone: f.phone, headcount: f.headcount,
      targets: f.targets, invoice: f.invoice, request: f.request, plan: f.plan, next: nextAction_(f, resp, today) };
  });
  var active = roster.filter(function (f) { return isParticipating_(f.status); });
  var careerActive = active.filter(function (f) { return (f.category || 'career') === 'career'; });
  function cnt(time) { return linksDue_(roster, time, today, null).length; }
  function responded(time) {
    return careerActive.filter(function (f) { var r = respBy[f.id] || {}; return r['CT' + time.charAt(1)] && r['PT' + time.charAt(1)]; }).length;
  }
  var by = {};
  ['career', 'general', 'corp'].forEach(function (c) {
    var all = roster.filter(function (f) { return (f.category || 'career') === c; });
    var act = all.filter(function (f) { return isParticipating_(f.status); });
    by[c] = { total: all.length, active: act.length, noSession: act.filter(function (f) { return !f.sessionDate; }).length };
  });
  var safetyOpen = safety.filter(function (r) { return r[7] !== '対応済'; });
  return {
    generatedAt: today,
    summary: {
      total: roster.length, active: active.length, by: by,
      withdrawn: roster.filter(function (f) { return String(f.status || '').trim() === '辞退'; }).length,
      deleted: roster.filter(function (f) { return String(f.status || '').trim() === '削除済み'; }).length,
      pending: pending.length,
      noSession: active.filter(function (f) { return !f.sessionDate; }).length,
      toSend: { T0: cnt('T0'), T1: cnt('T1'), T2: cnt('T2') },
      responded: { T0: responded('T0'), T1: responded('T1'), T2: responded('T2') },
      careerActive: careerActive.length,
      safetyOpen: safetyOpen.length,
      extraRequests: roster.filter(function (f) { return f.exName || f.exPlan; }).length
    },
    families: families.sort(function (a, b) { return a.appliedAt < b.appliedAt ? 1 : -1; }),
    pending: pending.map(function (r) { return { at: cellStr_(r[0]), category: r[1], name: r[2], email: r[3], child: r[4], reason: r[5], note: r[6] }; }),
    safety: safetyOpen.map(function (r) { return { at: cellStr_(r[0]), id: r[1], form: r[2], reason: r[3], due: cellStr_(r[6]), status: r[7] }; })
  };
}

/** 見てよい人かを判定する。ウェブアプリは「自分のみ」で公開する想定の、二重の確認 */
function isAllowedViewer_(active, effective, allowed) {
  var a = String(active || '').trim().toLowerCase();
  if (!a) return false;
  if (a === String(effective || '').trim().toLowerCase()) return true;
  return (allowed || []).some(function (x) { return String(x || '').trim().toLowerCase() === a; });
}

/** JSONを<script>に埋め込むときのエスケープ(</script>や<!--で壊れない・注入されない) */
function safeJson_(obj) {
  return JSON.stringify(obj).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}


// ======================================================================
// 確認サイトからの操作(メニューが使えない場合でも、サイトだけで運用できる)
// ======================================================================

function isIsoDate_(s) {
  s = String(s || '').trim();
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) return false;
  var y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
  var dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 2020 && y <= 2100;
}

var ALLOWED_STATUS = ['参加中', '辞退', '完了'];

function apiGuard_() {
  var reg = regSS_();
  if (!isAllowedViewer_(Session.getActiveUser().getEmail(), Session.getEffectiveUser().getEmail(), [opMail_(reg)])) throw new Error('権限がありません');
  return reg;
}

function dashboardData_(reg) {
  var db = dbSS_();
  function rows(ss, name) { var sh = ss.getSheetByName(name); if (!sh || sh.getLastRow() < 2) return []; return sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues(); }
  return buildDashboardData_(readRoster_(reg), rows(reg, SHEETS.pending), rows(db, SHEETS.submissions), rows(reg, SHEETS.safety), todayStr_());
}

function findFamily_(reg, id) {
  id = String(id || '').trim();
  if (!/^[FGB][0-9]{4}$/.test(id)) throw new Error('IDの形式が正しくありません');
  var fam = readRoster_(reg).filter(function (x) { return x.id === id; })[0];
  if (!fam) throw new Error('名簿に ' + id + ' が見つかりません');
  return fam;
}

/** 最新のデータを返す(サイトの更新用) */
function apiData() { return dashboardData_(apiGuard_()); }

/** 鑑定日を入力・変更する。空文字で消去 */
function apiSetSessionDate(id, date) {
  var reg = apiGuard_();
  var fam = findFamily_(reg, id);
  date = String(date || '').trim();
  if (date !== '' && !isIsoDate_(date)) throw new Error('日付は yyyy-mm-dd の形式で入力してください(例:2026-11-10)');
  var cell = reg.getSheetByName(SHEETS.roster).getRange(fam.row, RC.session + 1);
  cell.setNumberFormat('@');
  cell.setValue(date);
  return dashboardData_(reg);
}

/** 参加状況を変更する(参加中/辞退/完了) */
function apiSetStatus(id, status) {
  var reg = apiGuard_();
  var fam = findFamily_(reg, id);
  if (ALLOWED_STATUS.indexOf(status) === -1) throw new Error('参加状況が正しくありません');
  if (String(fam.status) === '削除済み') throw new Error('削除済みの方は変更できません');
  reg.getSheetByName(SHEETS.roster).getRange(fam.row, RC.status + 1).setValue(status);
  return dashboardData_(reg);
}

/** アンケートのリンクを送る(進路相談用のみ)。ids を渡すとその家庭だけ(日付の条件なし)、渡さなければ条件に合う家庭すべて */
function apiSendLinks(time, ids) {
  var reg = apiGuard_();
  if (LINK_TIMES.indexOf(time) === -1) throw new Error('時点が正しくありません');
  var selected = null;
  if (ids && ids.length) {
    var rows = readRoster_(reg);
    selected = {};
    ids.forEach(function (id) { var f = rows.filter(function (x) { return x.id === String(id); })[0]; if (f) selected[f.row] = true; });
  }
  var due = linksDue_(readRoster_(reg), time, todayStr_(), selected);
  if (!due.length) return { sent: 0, ng: 0, message: '送る対象の家庭はありません(送信済み・辞退・メール未入力・鑑定日の条件を満たしていません)', data: dashboardData_(reg) };
  var quota = MailApp.getRemainingDailyQuota();
  if (quota < due.length * 2) throw new Error('今日の送信上限に足りません(残り' + quota + '通 / 必要:' + due.length * 2 + '通)');
  var res = sendLinksToFamilies_(reg, time, due);
  return { sent: res.ok, ng: res.ng, message: TIME_LABEL[time] + 'のリンクを、' + res.ok + '家庭に送りました' + (res.ng ? '(失敗:' + res.ng + '家庭。「送信ログ」を確認してください)' : ''), data: dashboardData_(reg) };
}

/** 削除のお申し出があった方のデータを削除する */
function apiDeleteFamily(id) {
  var reg = apiGuard_();
  var fam = findFamily_(reg, id);
  if (String(fam.status) === '削除済み') throw new Error('すでに削除済みです');
  var total = deleteFamilyCore_(reg, dbSS_(), fam);
  return { message: id + ' の回答データ(' + total + '行)と個人情報を削除しました', data: dashboardData_(reg) };
}

var DASHBOARD_HTML = [
  '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>申込・進捗ダッシュボード</title>',
  '<style>',
  ':root{--bg:#f6f7f9;--fg:#1f2933;--mut:#6b7785;--card:#fff;--line:#dfe3e8;--acc:#2e6da4;--warn:#b45309;--bad:#b42318;--ok:#1a7f4b}',
  '@media(prefers-color-scheme:dark){:root{--bg:#14181d;--fg:#e6e9ee;--mut:#9aa6b2;--card:#1d232a;--line:#2d3640;--acc:#6aa6dc;--warn:#e0a458;--bad:#f08a80;--ok:#6fcf97}}',
  '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,"Hiragino Sans","Noto Sans JP",sans-serif}',
  'main{max-width:1200px;margin:0 auto;padding:16px}h1{font-size:18px;margin:0 0 4px}.sub{color:var(--mut);margin-bottom:12px}',
  '.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-bottom:14px}',
  '.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px}.card b{display:block;font-size:22px}.card span{color:var(--mut);font-size:12px}',
  '.card.warn b{color:var(--warn)}.card.bad b{color:var(--bad)}',
  '.tabs{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}.tabs button{border:1px solid var(--line);background:var(--card);color:var(--fg);padding:6px 12px;border-radius:6px;cursor:pointer;font:inherit}',
  '.tabs button.on{background:var(--acc);color:#fff;border-color:var(--acc)}',
  '.tools{display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap}input,select{background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:6px 8px;font:inherit}input{flex:1;min-width:180px}',
  '.wrap{overflow-x:auto;background:var(--card);border:1px solid var(--line);border-radius:8px}table{border-collapse:collapse;width:100%;min-width:760px}',
  'th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{color:var(--mut);font-weight:600;font-size:12px;white-space:nowrap}',
  'tr.row{cursor:pointer}tr.row:hover{background:rgba(46,109,164,.08)}tr.det td{background:var(--bg)}',
  '.dl{display:grid;grid-template-columns:160px 1fr;gap:2px 12px}.dl dt{color:var(--mut)}.dl dd{margin:0;word-break:break-all;white-space:pre-wrap}',
  '.tag{display:inline-block;padding:1px 8px;border-radius:10px;font-size:12px;border:1px solid var(--line)}.tag.ok{color:var(--ok);border-color:var(--ok)}.tag.warn{color:var(--warn);border-color:var(--warn)}.tag.bad{color:var(--bad);border-color:var(--bad)}',
  '.dot{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:3px;border:1px solid var(--mut)}.dot.on{background:var(--ok);border-color:var(--ok)}.dot.sent{background:var(--warn);border-color:var(--warn)}',
  '.empty{padding:24px;text-align:center;color:var(--mut)}.note{color:var(--mut);font-size:12px;margin-top:10px}',
  '.msg{margin:0 0 10px;padding:0;color:var(--ok);min-height:0}.msg.bad{color:var(--bad)}.msg:not(:empty){padding:8px 10px;border:1px solid var(--line);border-radius:6px;background:var(--card)}',
  '.acts{display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:10px;padding-top:10px;border-top:1px dashed var(--line)}.acts label{color:var(--mut);font-size:12px}',
  'button.act{border:1px solid var(--acc);background:var(--card);color:var(--acc);padding:4px 10px;border-radius:6px;cursor:pointer;font:inherit}button.act.danger{border-color:var(--bad);color:var(--bad)}button.act:disabled{opacity:.5;cursor:default}',
  '.bulk{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px}',
  '</style></head><body><main>',
  '<h1>申込・進捗ダッシュボード</h1><div class="sub" id="sub"></div>',
  '<div class="cards" id="cards"></div>',
  '<div class="tabs" id="tabs"></div>',
  '<div class="tools" id="tools"><input id="q" placeholder="名前・ID・法人名・メール・LINE・紹介者で検索"><select id="st"><option value="">すべての状況</option><option value="参加中">参加中</option><option value="辞退">辞退</option><option value="完了">完了</option><option value="削除済み">削除済み</option></select></div>',
  '<div class="msg" id="msg"></div><div class="bulk" id="bulk"></div>',
  '<div class="wrap" id="view"></div>',
  '<div class="note">行をクリックすると、詳細と操作(鑑定日の入力・参加状況の変更・リンクの送信・削除)が開きます。ボタンは、1回目で確認、2回目で実行します。個人情報を含むため、画面を他の人に見せたり、URLを共有したりしないでください。</div>',
  '</main><script>',
  'var DATA=__DATA__;',
  'var CATS=[["career","進路相談用"],["general","一般鑑定者用"],["corp","法人鑑定者用"]];',
  'function el(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e}',
  'var tab="career",openId="",busy=false;',
  'function msg(t,bad){var m=document.getElementById("msg");m.textContent=t;m.className="msg"+(bad?" bad":"")}',
  'function call(name,args){if(!window.google||!google.script||!google.script.run){msg("この画面では操作できません。Apps Scriptのウェブアプリとして開いてください。",true);return}if(busy)return;busy=true;msg("処理中…");var r=google.script.run.withSuccessHandler(function(res){busy=false;DATA=(res&&res.data)?res.data:res;msg((res&&res.message)?res.message:"保存しました");render()}).withFailureHandler(function(e){busy=false;msg("エラー: "+(e&&e.message?e.message:e),true)});r[name].apply(r,args)}',
  'function armBtn(label,fn,cls){var b=el("button","act"+(cls?" "+cls:""),label),t=null;b._armed=false;b.onclick=function(ev){if(ev&&ev.stopPropagation)ev.stopPropagation();if(b._armed){clearTimeout(t);b._armed=false;b.textContent=label;fn();return}b._armed=true;b.textContent="もう一度押すと実行";t=setTimeout(function(){b._armed=false;b.textContent=label},5000)};return b}',
  'function actions(f){var a=el("div","acts"),gone=f.status==="削除済み";',
  'var l1=el("label",null,"鑑定日");a.appendChild(l1);var di=el("input");di.type="date";di.value=f.sessionDate||"";di.disabled=gone;a.appendChild(di);var sv=el("button","act","保存");sv.disabled=gone;sv.onclick=function(ev){if(ev&&ev.stopPropagation)ev.stopPropagation();call("apiSetSessionDate",[f.id,di.value])};a.appendChild(sv);',
  'var l2=el("label",null,"参加状況");a.appendChild(l2);var se=el("select");["参加中","辞退","完了"].forEach(function(x){var o=el("option",null,x);o.value=x;if(f.status===x)o.selected=true;se.appendChild(o)});se.disabled=gone;a.appendChild(se);var sv2=el("button","act","保存");sv2.disabled=gone;sv2.onclick=function(ev){if(ev&&ev.stopPropagation)ev.stopPropagation();call("apiSetStatus",[f.id,se.value])};a.appendChild(sv2);',
  'if(f.category==="career"&&!gone){["T0","T1","T2"].forEach(function(t){a.appendChild(armBtn(t+"のリンクを送る",function(){call("apiSendLinks",[t,[f.id]])}))})}',
  'if(!gone)a.appendChild(armBtn("データを削除",function(){call("apiDeleteFamily",[f.id])},"danger"));return a}',
  'function renderBulk(){var b=document.getElementById("bulk");b.innerHTML="";if(tab!=="career")return;var s=DATA.summary;["T0","T1","T2"].forEach(function(t){var n=s.toSend[t];var x=armBtn(t+"のリンクを、条件に合う全家庭に送る ("+n+")",function(){call("apiSendLinks",[t,null])});x.disabled=!n;b.appendChild(x)})}',
  'function card(l,v,k){var d=el("div","card"+(k?" "+k:""));d.appendChild(el("b",null,String(v)));d.appendChild(el("span",null,l));return d}',
  'function renderCards(){var s=DATA.summary,c=document.getElementById("cards");c.innerHTML="";',
  'CATS.forEach(function(x){var b=s.by[x[0]];c.appendChild(card(x[1]+"(参加中)",b.active,b.noSession?"warn":""))});',
  'c.appendChild(card("要確認の申込",s.pending,s.pending?"bad":""));c.appendChild(card("鑑定日が未入力",s.noSession,s.noSession?"warn":""));',
  'c.appendChild(card("進路相談:T0を送れる",s.toSend.T0,s.toSend.T0?"warn":""));c.appendChild(card("進路相談:T1を送れる",s.toSend.T1,s.toSend.T1?"warn":""));c.appendChild(card("進路相談:T2を送れる",s.toSend.T2,s.toSend.T2?"warn":""));',
  'c.appendChild(card("T0 回答済み",s.responded.T0+" / "+s.careerActive));c.appendChild(card("T1 回答済み",s.responded.T1+" / "+s.careerActive));c.appendChild(card("T2 回答済み",s.responded.T2+" / "+s.careerActive));',
  'c.appendChild(card("未対応の安全確認",s.safetyOpen,s.safetyOpen?"bad":""));c.appendChild(card("追加の鑑定の希望",s.extraRequests));c.appendChild(card("辞退・削除済み",s.withdrawn+s.deleted));',
  'document.getElementById("sub").textContent="更新: "+DATA.generatedAt+" 時点 / 申込 全"+s.total+"件"}',
  'function renderTabs(){var t=document.getElementById("tabs");t.innerHTML="";var items=CATS.map(function(x){return [x[0],x[1]+" ("+DATA.summary.by[x[0]].total+")"]});items.push(["pend","要確認の申込 ("+DATA.pending.length+")"]);items.push(["saf","安全確認 ("+DATA.safety.length+")"]);items.forEach(function(x){var b=el("button",tab===x[0]?"on":"",x[1]);b.onclick=function(){tab=x[0];render()};t.appendChild(b)})}',
  'function dots(f,t){var n=t.charAt(1),c=!!f.resp["CT"+n],p=!!f.resp["PT"+n],w=el("span");var a=el("span","dot"+(c?" on":f.sent[t]?" sent":""));a.title="子ども "+(c?"回答済み":f.sent[t]?"送信済み・未回答":"未送信");var b=el("span","dot"+(p?" on":f.sent[t]?" sent":""));b.title="保護者 "+(p?"回答済み":f.sent[t]?"送信済み・未回答":"未送信");w.appendChild(el("span",null,t+" "));w.appendChild(a);w.appendChild(b);w.appendChild(document.createTextNode("  "));return w}',
  'function fields(f){var base=[["ID",f.id],["区分",f.category==="career"?"進路相談用":f.category==="general"?"一般鑑定者用":"法人鑑定者用"],["申込日時",f.appliedAt]];var mid;',
  'if(f.category==="career")mid=[["保護者",f.name+"("+f.pGender+" / "+f.pBirth+")"],["保護者メール",f.email],["LINE検索ID",f.line],["Instagram",f.insta||"-"],["公式LINE追加",f.officialLine||"-"],["紹介者",f.referrer],["お子様",f.childName+"("+f.cGender+" / "+f.cBirth+")"],["お子様メール",f.childEmail],["追加の鑑定",(f.exName||"-")+" "+(f.exPlan||"")],["保護者の連絡事項",f.pNote||"-"],["お子様の連絡事項",f.cNote||"-"]];',
  'else if(f.category==="general")mid=[["お名前",f.name+"("+f.pGender+" / "+f.pBirth+")"],["メール",f.email],["LINE検索ID",f.line],["Instagram",f.insta||"-"],["公式LINE追加",f.officialLine||"-"],["紹介者",f.referrer],["ご希望の内容",f.request||"-"],["自由記入欄",f.pNote||"-"]];',
  'else mid=[["法人名",f.company],["部署・役職",f.dept||"-"],["ご担当者",f.name],["メール",f.email],["電話番号",f.phone],["LINE検索ID",f.line],["公式LINE追加",f.officialLine||"-"],["紹介者",f.referrer],["プラン",f.plan||"-"],["鑑定を受ける人数",f.headcount],["鑑定を受ける方",f.targets],["ご希望の内容",f.request||"-"],["請求書・領収書の宛名",f.invoice||"-"],["自由記入欄",f.pNote||"-"]];',
  'var tail=[["鑑定日",f.sessionDate||"未入力"],["参加状況",f.status]];if(f.category==="career")tail.push(["送信日時 T0/T1/T2",[f.sent.T0,f.sent.T1,f.sent.T2].map(function(x){return x||"-"}).join(" / ")]);tail.push(["メモ",f.memo||"-"]);return base.concat(mid,tail)}',
  'function dl(f){var d=el("dl","dl");fields(f).forEach(function(r){d.appendChild(el("dt",null,r[0]));d.appendChild(el("dd",null,r[1]))});return d}',
  'function renderFam(v){var q=document.getElementById("q").value.trim().toLowerCase(),st=document.getElementById("st").value;',
  'var rows=DATA.families.filter(function(f){if(f.category!==tab)return false;if(st&&f.status!==st)return false;if(!q)return true;return [f.id,f.name,f.childName,f.company,f.email,f.childEmail,f.line,f.insta,f.referrer].join(" ").toLowerCase().indexOf(q)>=0});',
  'if(!rows.length){v.appendChild(el("div","empty","該当する申込はありません"));return}',
  'var career=tab==="career",t=el("table"),h=el("tr");var heads=career?["ID","申込日","保護者 / お子様","鑑定日","進捗(● 子ども・保護者)","次にやること","状況"]:tab==="corp"?["ID","申込日","法人名 / ご担当者","人数","鑑定日","次にやること","状況"]:["ID","申込日","お名前","鑑定日","次にやること","状況"];heads.forEach(function(x){h.appendChild(el("th",null,x))});t.appendChild(h);',
  'rows.forEach(function(f){var r=el("tr","row");r.appendChild(el("td",null,f.id));r.appendChild(el("td",null,(f.appliedAt||"").slice(0,10)));',
  'if(career)r.appendChild(el("td",null,f.name+" / "+f.childName));else if(tab==="corp")r.appendChild(el("td",null,f.company+" / "+f.name));else r.appendChild(el("td",null,f.name));',
  'if(tab==="corp")r.appendChild(el("td",null,f.headcount));r.appendChild(el("td",null,f.sessionDate||"未入力"));',
  'if(career){var p=el("td");["T0","T1","T2"].forEach(function(x){p.appendChild(dots(f,x))});r.appendChild(p)}',
  'var n=el("td"),tg=el("span","tag"+(/送る|入力/.test(f.next)?" warn":/完了/.test(f.next)?" ok":""),f.next);n.appendChild(tg);r.appendChild(n);',
  'var s=el("td"),sg=el("span","tag"+(f.status==="参加中"?" ok":" bad"),f.status);s.appendChild(sg);r.appendChild(s);',
  'var d=el("tr","det");d.style.display="none";var dc=el("td");dc.colSpan=heads.length;dc.appendChild(dl(f));dc.appendChild(actions(f));d.appendChild(dc);if(openId===f.id)d.style.display="";r.onclick=function(){var show=d.style.display==="none";d.style.display=show?"":"none";openId=show?f.id:""};t.appendChild(r);t.appendChild(d)});v.appendChild(t)}',
  'function renderPend(v){if(!DATA.pending.length){v.appendChild(el("div","empty","要確認の申込はありません"));return}var t=el("table"),h=el("tr");["受付日時","区分","名前","メール","お子様 / 法人名","理由","連絡事項"].forEach(function(x){h.appendChild(el("th",null,x))});t.appendChild(h);DATA.pending.forEach(function(p){var r=el("tr");[p.at,p.category,p.name,p.email,p.child,p.reason,p.note].forEach(function(x){r.appendChild(el("td",null,x||""))});t.appendChild(r)});v.appendChild(t)}',
  'function renderSaf(v){if(!DATA.safety.length){v.appendChild(el("div","empty","未対応の安全確認はありません"));return}var t=el("table"),h=el("tr");["受信日時","調査用ID","フォーム","理由","対応期限","状況"].forEach(function(x){h.appendChild(el("th",null,x))});t.appendChild(h);DATA.safety.forEach(function(p){var r=el("tr");[p.at,p.id,p.form,p.reason,p.due,p.status].forEach(function(x){r.appendChild(el("td",null,x||""))});t.appendChild(r)});v.appendChild(t)}',
  'function render(){renderCards();renderTabs();renderBulk();var v=document.getElementById("view");v.innerHTML="";document.getElementById("tools").style.display=(tab==="pend"||tab==="saf")?"none":"";if(tab==="pend")renderPend(v);else if(tab==="saf")renderSaf(v);else renderFam(v)}',
  'document.getElementById("q").oninput=render;document.getElementById("st").onchange=render;render();',
  '</script></body></html>'
].join('\n');

function dashboardPage_(data) {
  return DASHBOARD_HTML.replace('__DATA__', function () { return safeJson_(data); });
}

/** ウェブアプリ: 管理者が開くと申込・進捗のダッシュボード。それ以外の人(公開のデプロイ)が開くと申込ページ。?page=apply で、管理者も申込ページを確認できる */
function doGet(e) {
  var props = PropertiesService.getScriptProperties();
  if (!props.getProperty('REG_SS_ID')) return HtmlService.createHtmlOutput('セットアップが済んでいません。setup() を実行してください。');
  var page = (e && e.parameter && e.parameter.page) || '';
  var reg = regSS_();
  var ok = isAllowedViewer_(Session.getActiveUser().getEmail(), Session.getEffectiveUser().getEmail(), [opMail_(reg)]);
  if (page === 'apply' || !ok) {
    return HtmlService.createHtmlOutput(applyPage_()).setTitle('算命学の鑑定 お申込み').addMetaTag('viewport', 'width=device-width, initial-scale=1');
  }
  return HtmlService.createHtmlOutput(dashboardPage_(dashboardData_(reg))).setTitle('申込・進捗ダッシュボード').addMetaTag('viewport', 'width=device-width, initial-scale=1');
}


// ======================================================================
// 申込用の専用サイト(公開ページ)。Googleフォームと同じ名簿・通知の仕組みに入れる
// ======================================================================

/** 管理者だけが実行できる操作の入口で呼ぶ。公開ページ(誰でも開ける)から、google.script.run で呼ばれても、拒否する */
function ownerOnly_() {
  var a = String(Session.getActiveUser().getEmail() || '').trim().toLowerCase();
  var e = String(Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  if (!a || a !== e) throw new Error('この操作は、管理者のみ実行できます');
}

var SITE_CATEGORIES = [
  { key: 'career', def: 'apply', label: '親子', sub: '保護者さまとお子様の、お申込み', desc: 'お子様の進路・自己理解のための鑑定です。調査アンケートへのご協力をお願いしています。', fee: '鑑定料 30,000円' },
  { key: 'general', def: 'applyG', label: '個人', sub: 'ご自身の、お申込み', desc: 'ご自身の鑑定のお申込みです。', fee: '鑑定料 30,000円' },
  { key: 'corp', def: 'applyB', label: '法人・団体', sub: '会社・団体の、お申込み', desc: '代表の方、または代表と幹部の方の鑑定のお申込みです。', fee: '代表のみ 50,000円 / 代表+幹部2名 100,000円' }
];

/** 公開サイトに埋め込むデータ(設問の定義だけ。お振込先は、申込のあとにだけ返す) */
function publicSiteData_() {
  return {
    line: LINE_URL, contact: CONTACT_MAIL,
    cats: SITE_CATEGORIES.map(function (c) {
      var d = SURVEY[c.def];
      return {
        key: c.key, label: c.label, sub: c.sub, desc: c.desc, fee: c.fee,
        blocks: d.blocks.map(function (b) {
          if (b.type === 'page') return { type: 'page', title: b.title, desc: b.desc || '', conditional: !!b.conditional };
          var parts = applyTitleParts_(b);
          return { type: 'q', id: b.id, text: parts.title, kind: b.kind, required: !!b.required, choices: b.choices || null, help: [b.help, parts.hint].filter(Boolean).join('\n'), gate: !!b.gate };
        })
      };
    })
  };
}

/** 申込の回答(設問ID→値)を、安全な形に整える。知らない項目は捨て、長さを制限し、同意は選択肢の文字に直す */
function sanitizeAnswers_(category, answers) {
  var def = SURVEY[(SITE_CATEGORIES.filter(function (c) { return c.key === category; })[0] || {}).def];
  if (!def) throw new Error('区分が正しくありません');
  var out = {};
  answers = answers || {};
  def.blocks.filter(function (b) { return b.type === 'q'; }).forEach(function (q) {
    var v = answers[q.id];
    if (q.kind === 'consent' || q.kind === 'check') { out[q.id] = (v === true || v === 'true' || v === q.choices[0]) ? q.choices[0] : ''; return; }
    v = (v === undefined || v === null) ? '' : String(v);
    v = v.replace(/\u0000/g, '').trim();
    if (v.length > (q.kind === 'text' ? 3000 : 300)) v = v.slice(0, q.kind === 'text' ? 3000 : 300);
    if (q.kind === 'single' && v !== '' && (q.choices || []).indexOf(v) === -1) v = '';
    out[q.id] = v;
  });
  return out;
}

function answersToNamedValues_(category, answers) {
  var def = SURVEY[(SITE_CATEGORIES.filter(function (c) { return c.key === category; })[0] || {}).def];
  var nv = {};
  def.blocks.filter(function (b) { return b.type === 'q'; }).forEach(function (q) { nv[qTitle_(q)] = [answers[q.id] === undefined ? '' : answers[q.id]]; });
  return nv;
}

function friendlyReasons_(reason) {
  return String(reason).split(' / ').map(function (r) {
    if (/^同意未確認/.test(r)) return '必須の同意の項目に、チェックをお願いします';
    if (/^重複申込/.test(r)) return 'すでに、同じ内容のお申込みを受け付けています。ご不明な点は、' + CONTACT_MAIL + ' までご連絡ください';
    return r;
  });
}

/** 一定の時間内の送信回数を制限する(連続送信・いたずらの防止)。cache は CacheService のキャッシュ */
function rateLimited_(cache, key, max, ttlSec) {
  var n = Number(cache.get(key) || 0);
  if (n >= max) return true;
  cache.put(key, String(n + 1), ttlSec);
  return false;
}


var APPLY_HTML = '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
'<title>算命学の鑑定 お申込み | KAGAMI</title><style>' +
':root{--bg:#f7f5f0;--card:#fff;--ink:#2b2a33;--mute:#6f6c78;--line:#e4e0d6;--accent:#2f4a7d;--accent2:#8a6d3b;--err:#b3261e;--ok:#2e7d4f}' +
'@media(prefers-color-scheme:dark){:root{--bg:#17161c;--card:#211f28;--ink:#eceaf2;--mute:#a4a1b0;--line:#34313e;--accent:#8fb0ee;--accent2:#d6b676;--err:#ff8a80;--ok:#7bd69d}}' +
'*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.75 "Hiragino Sans","Yu Gothic",Meiryo,sans-serif}' +
'header{text-align:center;padding:40px 16px 20px}header .brand{letter-spacing:.4em;color:var(--accent2);font-size:13px}header h1{font:600 24px/1.5 "Hiragino Mincho ProN","Yu Mincho",serif;margin:6px 0}header p{color:var(--mute);margin:0;font-size:14px}' +
'main{max-width:680px;margin:0 auto;padding:0 16px 64px}.tabs{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:12px 0 18px}' +
'.tab{border:1px solid var(--line);background:var(--card);border-radius:12px;padding:12px 6px;text-align:center;cursor:pointer;font:inherit;color:var(--ink)}.tab b{display:block;font-size:15px}.tab small{color:var(--mute);font-size:11px;line-height:1.3;display:block}.tab.on{border:2px solid var(--accent);padding:11px 5px}' +
'.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px;margin-bottom:16px}.card h2{font-size:17px;margin:0 0 6px;color:var(--accent)}.desc{white-space:pre-wrap;color:var(--mute);font-size:14px;margin:0 0 12px}' +
'.fee{display:inline-block;background:rgba(138,109,59,.12);color:var(--accent2);border-radius:999px;padding:2px 12px;font-size:13px;margin-top:6px}' +
'.q{margin:18px 0 0}.q label.t{display:block;font-weight:600;font-size:15px}.req{color:var(--err);font-size:12px;margin-left:6px}.help{color:var(--mute);font-size:13px;margin-top:2px;white-space:pre-wrap}.help a{color:var(--accent)}' +
'input[type=text],input[type=email],input[type=tel],textarea{width:100%;font:inherit;padding:11px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);color:var(--ink);margin-top:6px}textarea{min-height:96px}input:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:1px}' +
'.opt{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid var(--line);border-radius:10px;margin-top:6px;cursor:pointer;background:var(--bg)}.opt input{margin-top:6px}' +
'.err{color:var(--err);font-size:13px;margin-top:4px;display:none}.q.bad .err{display:block}.q.bad input[type=text],.q.bad input[type=email],.q.bad input[type=tel],.q.bad textarea,.q.bad .opt{border-color:var(--err)}' +
'.btn{display:block;width:100%;border:0;border-radius:12px;background:var(--accent);color:#fff;font:600 16px inherit;padding:15px;cursor:pointer}.btn:disabled{opacity:.5}@media(prefers-color-scheme:dark){.btn{color:#101018}}' +
'.hp{position:absolute;left:-9999px;height:0;overflow:hidden}.banner{border-radius:10px;padding:12px 14px;margin-bottom:14px;background:rgba(179,38,30,.1);color:var(--err);font-size:14px;display:none;white-space:pre-wrap}' +
'.bank{background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:14px 16px;font-size:15px;white-space:pre-wrap}.big{font-size:26px;font-weight:700;color:var(--accent)}.line{display:block;text-align:center;background:#06c755;color:#fff;border-radius:12px;padding:14px;text-decoration:none;font-weight:600;margin-top:10px}.ok{color:var(--ok);font-size:34px;text-align:center}' +
'footer{text-align:center;color:var(--mute);font-size:12px;padding:10px 16px 40px}</style></head><body>' +
'<header><div class="brand">KAGAMI</div><h1>算命学の鑑定 お申込み</h1><p>必要事項を入力して、送信してください。送信後に、お振込先をご案内します。</p></header>' +
'<main><div id="app"></div></main><footer id="foot"></footer>' +
'<script>var SITE = __DATA__;' +
'var el=function(t,c,x){var e=document.createElement(t);if(c)e.className=c;if(x!==undefined)e.textContent=x;return e;};' +
'var cur=null,fields={},app=document.getElementById("app");' +
'function linkify(box,text){String(text).split(/(https?:\\/\\/[^\\s]+)/).forEach(function(p){if(/^https?:/.test(p)){var a=el("a","",p);a.href=p;a.target="_blank";a.rel="noopener";box.appendChild(a);}else box.appendChild(document.createTextNode(p));});}' +
'var checks={email:function(v){return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(v);},birth:function(v){if(!/^[0-9]{8}$/.test(v))return false;var y=+v.slice(0,4),m=+v.slice(4,6),d=+v.slice(6,8),t=new Date(y,m-1,d);return y>1900&&t.getFullYear()===y&&t.getMonth()===m-1&&t.getDate()===d&&t<=new Date();},phone:function(v){return /^[0-9\\-]{9,13}$/.test(v);},katakana:function(v){return /^[ァ-ヺー・\\s　]+$/.test(v);},int:function(v){return /^[0-9]{1,3}$/.test(v);}};' +
'var msg={email:"メールアドレスの形式が正しくありません",birth:"生年月日は8桁の半角数字で入力してください(例:20000218)",phone:"電話番号は、数字とハイフンで入力してください",katakana:"カタカナで入力してください",int:"半角数字で入力してください"};' +
'function show(key){cur=SITE.cats.filter(function(c){return c.key===key;})[0];fields={};app.innerHTML="";' +
' var tabs=el("div","tabs");SITE.cats.forEach(function(c){var b=el("button","tab"+(c.key===key?" on":""));b.type="button";b.appendChild(el("b","",c.label));b.appendChild(el("small","",c.sub));b.onclick=function(){show(c.key);window.scrollTo(0,0);};tabs.appendChild(b);});app.appendChild(tabs);' +
' var banner=el("div","banner");app.appendChild(banner);var card=null;' +
' cur.blocks.forEach(function(b,i){if(b.type==="page"){if(b.conditional)return;card=el("div","card");card.appendChild(el("h2","",b.title));if(b.desc)card.appendChild(el("div","desc",b.desc));if(i===0){card.appendChild(el("span","fee",cur.fee));}app.appendChild(card);return;}' +
'  if(b.id==="AP_VIEW")return;if(!card){card=el("div","card");app.appendChild(card);}' +
'  var q=el("div","q"),l=el("label","t",b.text);if(b.required){l.appendChild(el("span","req","必須"));}q.appendChild(l);if(b.help){var h=el("div","help");linkify(h,b.help);q.appendChild(h);}' +
'  var f={b:b,q:q,get:null};' +
'  if(b.kind==="single"){var name="r_"+b.id;(b.choices||[]).forEach(function(c){var lab=el("label","opt"),r=document.createElement("input");r.type="radio";r.name=name;r.value=c;lab.appendChild(r);lab.appendChild(el("span","",c));q.appendChild(lab);});f.get=function(){var x=q.querySelector("input:checked");return x?x.value:"";};}' +
'  else if(b.kind==="consent"||b.kind==="check"){var lab=el("label","opt"),r=document.createElement("input");r.type="checkbox";lab.appendChild(r);lab.appendChild(el("span","",b.choices[0]));q.appendChild(lab);f.get=function(){return r.checked?b.choices[0]:"";};}' +
'  else{var inp=b.kind==="text"?document.createElement("textarea"):document.createElement("input");if(b.kind!=="text")inp.type=b.kind==="email"?"email":b.kind==="phone"?"tel":"text";if(b.kind==="birth")inp.inputMode="numeric";inp.autocomplete="off";q.appendChild(inp);f.get=function(){return inp.value.trim();};}' +
'  q.appendChild(el("div","err"));card.appendChild(q);fields[b.id]=f;});' +
' var hp=el("div","hp");var hpi=document.createElement("input");hpi.type="text";hpi.tabIndex=-1;hpi.autocomplete="off";hp.appendChild(hpi);app.appendChild(hp);' +
' var btn=el("button","btn","同意して、送信する");btn.type="button";app.appendChild(btn);' +
' btn.onclick=function(){var ans={},bad=null;Object.keys(fields).forEach(function(id){var f=fields[id],v=f.get(),e=null;ans[id]=v;if(f.b.required&&!v)e=f.b.kind==="consent"||f.b.kind==="check"?"チェックをお願いします":"入力してください";else if(v&&checks[f.b.kind]&&!checks[f.b.kind](v))e=msg[f.b.kind];f.q.classList.toggle("bad",!!e);f.q.querySelector(".err").textContent=e||"";if(e&&!bad)bad=f.q;});' +
'  ["AP2:AP3","CH4:CH5","GE4:GE5","CO4:CO5"].forEach(function(p){var a=p.split(":");if(fields[a[0]]&&ans[a[0]]&&ans[a[1]]&&ans[a[0]]!==ans[a[1]]){var f=fields[a[1]];f.q.classList.add("bad");f.q.querySelector(".err").textContent="上のメールアドレスと一致していません";if(!bad)bad=f.q;}});' +
'  if(bad){banner.style.display="block";banner.textContent="入力内容を、ご確認ください(赤い項目)";bad.scrollIntoView({behavior:"smooth",block:"center"});return;}' +
'  banner.style.display="none";btn.disabled=true;btn.textContent="送信しています…";' +
'  google.script.run.withSuccessHandler(function(r){if(r&&r.ok){done(r);}else{btn.disabled=false;btn.textContent="同意して、送信する";banner.style.display="block";banner.textContent=((r&&r.errors)||["送信できませんでした"]).join("\\n");window.scrollTo(0,0);}}).withFailureHandler(function(){btn.disabled=false;btn.textContent="同意して、送信する";banner.style.display="block";banner.textContent="送信できませんでした。通信状況をご確認のうえ、もう一度お試しください。";}).submitApplication(cur.key,ans,hpi.value);};' +
'}' +
'function done(r){app.innerHTML="";var c=el("div","card");c.appendChild(el("div","ok","✓"));c.appendChild(el("h2","","お申込みを受け付けました"));c.appendChild(el("div","desc",r.silent?"":(r.email||"")+" 宛に、受付確認のメールをお送りしました。届かない場合は、迷惑メールのフォルダもご確認ください。"));' +
' if(!r.silent){c.appendChild(el("h2","","鑑定料・お振込先"));var b=el("div","bank");b.appendChild(el("div","big",(r.fee||[])[0]||""));var rest=(r.fee||[]).slice(1).concat([""]).concat(r.bank||[]);b.appendChild(document.createTextNode(rest.join("\\n")));c.appendChild(b);c.appendChild(el("div","desc","お支払い方法は、口座振込のみです。日程の調整は、運営から改めてご連絡します。"));' +
' c.appendChild(el("div","desc","林 竜輔の公式LINEを、まだ追加していない方は、こちらから追加してください。"));var a=el("a","line","公式LINEを追加する");a.href=r.line;a.target="_blank";a.rel="noopener";c.appendChild(a);}' +
' app.appendChild(c);window.scrollTo(0,0);}' +
'document.getElementById("foot").textContent="運営: KAGAMI / 責任者: " + "' + RESPONSIBLE + '" + " / お問い合わせ: " + SITE.contact;' +
'var qs=(location.search||"").match(/cat=(career|general|corp)/);show(qs?qs[1]:SITE.cats[0].key);' +
'</script></body></html>';

function applyPage_() {
  return APPLY_HTML.replace('__DATA__', function () { return safeJson_(publicSiteData_()); });
}

/** 申込を名簿に登録し、受付確認メール(お振込先つき)を申込者に、新規申込の通知を運営に送る(フォーム・専用サイトの共通処理) */
function finishApplication_(reg, category, res, tsIso) {
  reg.getSheetByName(SHEETS.roster).appendRow(res.row);
  var mail = buildApplyReceiptEmail_(res, category);
  var result = '送信済み';
  try { sendMail_(res.email, mail.subject, mail.body, mail.html); } catch (err) { result = '【送信失敗】' + err; }
  var label = CATEGORY_LABEL[category];
  reg.getSheetByName(SHEETS.sendlog).appendRow([tsIso, res.id, '申込受付(' + label + ')', res.email, result]);
  var op = opMail_(reg);
  var who = category === 'corp' ? res.company + ' / 担当:' + res.name + ' / ' + (res.plan ? res.plan.label : '') : (category === 'career' ? '保護者:' + res.name + ' / お子様:' + res.childName : res.name);
  if (op) sendMail_(op, '[調査アンケート] 新しい申込がありました(' + label + ' / ' + res.id + ')', res.id + ' / ' + who + '\n日程調整のうえ、名簿の「鑑定日」を入力してください。\n' + reg.getUrl());
  return result;
}

/** 専用サイトからの申込(誰でも呼べる)。入力を確認し、問題があれば修正点を返し、問題なければ登録して、お振込先を返す */
function submitApplication(category, answers, honeypot) {
  if (['career', 'general', 'corp'].indexOf(category) === -1) throw new Error('区分が正しくありません');
  if (honeypot) return { ok: true, silent: true };
  var clean = sanitizeAnswers_(category, answers);
  var cache = CacheService.getScriptCache();
  if (rateLimited_(cache, 'apply_all_' + Math.floor(Date.now() / 60000), 40, 120)) return { ok: false, errors: ['ただいま、混み合っています。しばらくしてから、もう一度お試しください'] };
  var emailKey = String(clean.AP2 || clean.GE4 || clean.CO4 || '').toLowerCase();
  if (emailKey && rateLimited_(cache, 'apply_mail_' + emailKey.slice(0, 80), 5, 3600)) return { ok: false, errors: ['同じメールアドレスからの送信が多すぎます。しばらくしてから、もう一度お試しください'] };
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var reg = regSS_();
    var existing = readRoster_(reg).map(function (r) { return { id: r.id, email: r.email, childName: r.childName, name: r.name, company: r.company, category: r.category }; });
    var tsIso = nowStr_();
    var res = processApplication_(answersToNamedValues_(category, clean), existing, tsIso, category);
    if (!res.ok) return { ok: false, errors: friendlyReasons_(res.reason) };
    finishApplication_(reg, category, res, tsIso);
    var plan = res.plan || null;
    return { ok: true, fee: feeLines_(category, plan), bank: bankLines_(), line: LINE_URL, email: res.email };
  } finally {
    lock.releaseLock();
  }
}

// ======================================================================
// 集計・出力
// ======================================================================

function buildSummary() {
  ownerOnly_();
  var ss = dbSS_();
  var sh = ss.getSheetByName(SHEETS.summary);
  var data = ss.getSheetByName(SHEETS.long).getDataRange().getValues();
  var head = data.shift();
  var ix = {}; head.forEach(function (h, i) { ix[h] = i; });
  var agg = {};
  data.forEach(function (r) {
    if (!isTrue_(r[ix['分析採用']])) return;
    var k = r[ix['フォームID']] + '|' + r[ix['設問ID']];
    var a = agg[k] = agg[k] || { form: r[ix['フォームID']], qid: r[ix['設問ID']], n: 0, ans: 0, miss: 0, hid: 0, codes: [], dist: {} };
    a.n++;
    var st = r[ix['状態']];
    if (st === '回答') { a.ans++; var v = String(r[ix['回答内容']]); a.dist[v] = (a.dist[v] || 0) + 1; var c = r[ix['数値コード']]; if (c !== '' && c !== 8) a.codes.push(Number(c)); }
    else if (st === '未回答') a.miss++; else a.hid++;
  });
  var text = {};
  SURVEY.formKeys.forEach(function (k) { questionsOf_(k).forEach(function (q) { text[k + '|' + q.id] = q.text; }); });
  var out = [['フォームID', '設問ID', '設問文', '採用送信数', '回答数', '未回答数', '非表示数', '平均(数値コード、8除く)', '中央値', '分布(回答内容=人数。複数選択は選択肢ごと)']];
  Object.keys(agg).sort().forEach(function (k) {
    var a = agg[k];
    var mean = a.codes.length ? Math.round(a.codes.reduce(function (s, x) { return s + x; }, 0) / a.codes.length * 100) / 100 : '';
    var med = '';
    if (a.codes.length) { var s2 = a.codes.slice().sort(function (x, y) { return x - y; }); var m = Math.floor(s2.length / 2); med = s2.length % 2 ? s2[m] : (s2[m - 1] + s2[m]) / 2; }
    var dist = Object.keys(a.dist).map(function (d) { return d.length > 40 ? d.slice(0, 40) + '…=' + a.dist[d] : d + '=' + a.dist[d]; }).join('; ');
    out.push([a.form, a.qid, text[k] || '', a.n, a.ans, a.miss, a.hid, mean, med, dist]);
  });
  sh.clear();
  sh.getRange(1, 1, out.length, out[0].length).setValues(out);
  sh.getRange(1, 1, 1, out[0].length).setFontWeight('bold');
  sh.setFrozenRows(1);
}

/** CSV出力(UTF-8 BOM付き)。個人情報は含まない回答DBのみ。Drive のフォルダ「調査アンケート_CSV出力」に保存 */
function exportCsv() {
  ownerOnly_();
  var ss = dbSS_();
  var folders = DriveApp.getFoldersByName('調査アンケート_CSV出力');
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder('調査アンケート_CSV出力');
  var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm');
  function save(name, rows) {
    folder.createFile(Utilities.newBlob('﻿' + toCsv_(rows), 'text/csv', name + '_' + stamp + '.csv'));
  }
  save('long', ss.getSheetByName(SHEETS.long).getDataRange().getValues());
  save('long_options', ss.getSheetByName(SHEETS.options).getDataRange().getValues());
  save('submissions', ss.getSheetByName(SHEETS.submissions).getDataRange().getValues());
  save('codebook', buildCodebookRows_());
  var longRows = ss.getSheetByName(SHEETS.long).getDataRange().getValues();
  var head = longRows.shift();
  var ix = {}; head.forEach(function (h, i) { ix[h] = i; });
  SURVEY.formKeys.forEach(function (k) {
    var ids = questionsOf_(k).filter(function (q) { return !q.system; }).map(function (q) { return q.id; });
    var bySid = {};
    longRows.forEach(function (r) {
      if (r[ix['フォームID']] !== k || !isTrue_(r[ix['分析採用']])) return;
      var s = r[ix['submission_id']];
      var o = bySid[s] = bySid[s] || { rid: r[ix['調査用ID']], ts: r[ix['回答日時']], v: {} };
      var st = r[ix['状態']];
      o.v[r[ix['設問ID']]] = st === '回答' ? (r[ix['数値コード']] !== '' ? r[ix['数値コード']] : r[ix['回答内容']]) : (st === '非表示(分岐)' ? 'NA_HIDDEN' : '');
    });
    var rows = [['調査用ID', '回答日時'].concat(ids)];
    Object.keys(bySid).forEach(function (s) { rows.push([bySid[s].rid, bySid[s].ts].concat(ids.map(function (id) { return bySid[s].v[id] === undefined ? '' : bySid[s].v[id]; }))); });
    save('wide_' + k, rows);
  });
  Logger.log('CSVを保存しました: ' + folder.getUrl());
}

// ======================================================================
// テスト(Apps Script 上で実行)
// ======================================================================

function runStaticTests() {
  ownerOnly_();
  var reg = regSS_();
  var res = [];
  function add(name, ok, detail) { res.push([name, ok ? 'OK' : 'NG', detail || '']); }
  var errors = validateSurveyDefinition_();
  add('A/B 設問定義の整合性(尺度・回答したくない・学年・設問数)', errors.length === 0, errors.join(' / '));
  var formIds = getFormIds_();
  var defs = {};
  SURVEY.formKeys.forEach(function (k) { defs[k] = SURVEY.forms[k]; });
  defs.APPLY = SURVEY.apply;
  defs.APPLY_G = SURVEY.applyG;
  defs.APPLY_B = SURVEY.applyB;
  Object.keys(defs).forEach(function (k) {
    var form = FormApp.openById(formIds[k]);
    var items = form.getItems();
    var titles = items.map(function (i) { return i.getTitle(); });
    var qs = defs[k].blocks.filter(function (b) { return b.type === 'q'; });
    add(k + ' 「回答したくない」なし', !titles.join(' ').match(/回答したくない/));
    var mcBad = [];
    items.forEach(function (i) {
      if (i.getType() === FormApp.ItemType.MULTIPLE_CHOICE) {
        var q = qs.filter(function (x) { return qTitle_(x) === i.getTitle(); })[0];
        if (!q) return;
        var got = i.asMultipleChoiceItem().getChoices().map(function (c) { return c.getValue(); }).join('|');
        if (got !== choicesOf_(q).join('|')) mcBad.push(q.id);
      }
    });
    add(k + ' 選択肢が仕様どおり', mcBad.length === 0, mcBad.join(','));
    var gateBad = [];
    qs.filter(function (q) { return q.gate; }).forEach(function (q) {
      var it = items.filter(function (i) { return i.getTitle() === qTitle_(q); })[0].asMultipleChoiceItem();
      var skip = it.getChoices().filter(function (c) { return c.getValue() === q.gate.skip; })[0];
      var other = it.getChoices().filter(function (c) { return c.getValue() !== q.gate.skip; })[0];
      var skipType = skip.getPageNavigationType();
      if (skipType !== FormApp.PageNavigationType.GO_TO_PAGE && skipType !== FormApp.PageNavigationType.SUBMIT) gateBad.push(q.id + ':skip');
      if (other.getPageNavigationType() !== FormApp.PageNavigationType.CONTINUE) gateBad.push(q.id + ':cont');
    });
    add(k + ' 分岐(ゲート)のナビゲーション', gateBad.length === 0, gateBad.join(','));
    add(k + ' 学年を尋ねる設問がない', !titles.join(' ').match(/学年/));
  });
  // 同意は申込フォームのみ
  ['CT0', 'PT0'].forEach(function (k) {
    add(k + ' 同意項目がない(同意は申込フォームのみ)', FormApp.openById(formIds[k]).getItems().every(function (i) { return i.getTitle().indexOf('CONSENT') !== 0; }));
  });
  ['APPLY', 'APPLY_G', 'APPLY_B'].forEach(function (k) {
    var reqConsent = FormApp.openById(formIds[k]).getItems().filter(function (i) { return i.getTitle() === '上の内容について'; });
    add(k + ' 同意のチェック(全てに同意しました)が1つで必須', reqConsent.length === 1 && reqConsent[0].asCheckboxItem().isRequired(), String(reqConsent.length));
  });
  var sh = reg.getSheetByName(SHEETS.tests);
  sh.getRange(2, 1, Math.max(sh.getLastRow(), 2), 3).clearContent();
  sh.getRange(2, 1, res.length, 3).setValues(res);
  var ng = res.filter(function (r) { return r[1] === 'NG'; }).length;
  Logger.log('静的テスト: ' + (res.length - ng) + ' OK / ' + ng + ' NG');
}

/** テスト送信(調査用ID F9999)。実行後1分ほど待ってから verifyDataTests() を実行する */
function runDataTests() {
  ownerOnly_();
  var formIds = getFormIds_();
  function submit(key, map) {
    var form = FormApp.openById(formIds[key]);
    var resp = form.createResponse();
    form.getItems().forEach(function (it) {
      var q = questionsOf_(key).filter(function (x) { return qTitle_(x) === it.getTitle(); })[0];
      if (!q || map[q.id] === undefined) return;
      var v = map[q.id];
      if (q.kind === 'multi') resp.withItemResponse(it.asCheckboxItem().createResponse(Array.isArray(v) ? v : [v]));
      else if (q.kind === 'single') resp.withItemResponse(it.asMultipleChoiceItem().createResponse(v));
      else if (q.kind === 'text' || q.kind === 'id' || q.kind === 'age') resp.withItemResponse((q.kind === 'text' ? it.asParagraphTextItem() : it.asTextItem()).createResponse(String(v)));
    });
    resp.submit();
  }
  submit('CT0', { RID: CONFIG.TEST_ID, A1: '13', S1: '3：少しそう思う', 'B2-1': 'いいえ', B1: ['特にない', '新しいことを始めた'] });
  submit('CT2', { RID: CONFIG.TEST_ID, F1: 'わからない', F4_1: 'はい', F5_1: '3：ある程度きっかけになった', F4_2: 'いいえ', F8: '3：少し続いている' });
  submit('PT1', { RID: CONFIG.TEST_ID, PD1: '4：とてもそう思う' });
  submit('PT1', { RID: CONFIG.TEST_ID, PD1: '2：あまりそう思わない' });
  Logger.log('テスト送信しました。1分ほど待ってから verifyDataTests() を実行してください。');
}

function verifyDataTests() {
  ownerOnly_();
  var db = dbSS_();
  var reg = regSS_();
  var long = db.getSheetByName(SHEETS.long).getDataRange().getValues();
  var head = long.shift(); var ix = {}; head.forEach(function (h, i) { ix[h] = i; });
  function find(form, qid) {
    return long.filter(function (r) { return r[ix['調査用ID']] === CONFIG.TEST_ID && r[ix['フォームID']] === form && r[ix['設問ID']] === qid; });
  }
  var sub = db.getSheetByName(SHEETS.submissions).getDataRange().getValues(); sub.shift();
  var res = [];
  function add(name, ok, detail) { res.push([name, ok ? 'OK' : 'NG', detail || '']); }
  add('D: B2-1=いいえ → B2-2が「非表示(分岐)」', find('CT0', 'B2-2').some(function (r) { return r[ix['状態']] === '非表示(分岐)'; }));
  add('D: 未回答(S2)は「未回答」で、数値に置換されない', find('CT0', 'S2').some(function (r) { return r[ix['状態']] === '未回答' && r[ix['数値コード']] === ''; }));
  add('D: F4_2=いいえ → F5_2が「非表示(分岐)」', find('CT2', 'F5_2').some(function (r) { return r[ix['状態']] === '非表示(分岐)'; }));
  add('D: F4_1=はい → F5_1が「回答」', find('CT2', 'F5_1').some(function (r) { return r[ix['状態']] === '回答'; }));
  add('D: F1「わからない」は欠測ではなくコード8', find('CT2', 'F1').some(function (r) { return r[ix['数値コード']] === 8; }));
  add('D: 排他矛盾(B1)のフラグ', sub.some(function (r) { return r[2] === CONFIG.TEST_ID && r[4] === 'CT0' && String(r[7]).indexOf('排他矛盾:B1') !== -1; }));
  add('D: 重複送信(PT1)で2件目に重複フラグ・分析採用FALSE', sub.filter(function (r) { return r[2] === CONFIG.TEST_ID && r[4] === 'PT1'; }).some(function (r) { return isFalse_(r[6]) && String(r[7]).indexOf('重複送信') !== -1; }));
  var safety = reg.getSheetByName(SHEETS.safety).getDataRange().getValues();
  add('D: F8=3 で安全対応ログ(台帳)に記録', safety.some(function (r) { return r[1] === CONFIG.TEST_ID && String(r[3]).indexOf('F8') !== -1; }));
  var sh = reg.getSheetByName(SHEETS.tests);
  sh.getRange(sh.getLastRow() + 1, 1, res.length, 3).setValues(res);
  var ng = res.filter(function (r) { return r[1] === 'NG'; }).length;
  Logger.log('データテスト: ' + (res.length - ng) + ' OK / ' + ng + ' NG(結果は台帳のテスト結果シート)');
}
