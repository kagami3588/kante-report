/**
 * 算命学×自己理解・他者理解・キャリア形成 研究アンケート — 実装(Google Apps Script)
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
  DB_NAME: '研究アンケート回答DB',
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
  roster: ['研究用ID', '申込日時', '保護者名', 'メールアドレス', 'お子さまの呼び名', '鑑定日(yyyy-mm-dd)', '参加状況(参加中/辞退/完了)', 'T0送信日時', 'T1送信日時', 'T2送信日時', '申込時の連絡事項', 'メモ'],
  pending: ['受付日時', '保護者名', 'メールアドレス', 'お子さまの呼び名', '要確認の理由', '申込時の連絡事項'],
  sendlog: ['日時', '研究用ID', '時点', '送信先', '結果'],
  submissions: ['submission_id', '回答日時', '研究用ID', '回答者区分', 'フォームID', '時点', '分析採用', 'フラグ', '回答数', '未回答数', '非表示数', '自由記述あり数', 'テスト'],
  long: ['submission_id', '研究用ID', '回答者区分', 'フォームID', '時点', '設問ID', '回答内容', '数値コード', '回答日時', '状態', '自由記述あり', '分析採用'],
  options: ['submission_id', '研究用ID', 'フォームID', '設問ID', '選択肢'],
  reminders: ['日付', '研究用ID', 'フォームID', '回目', '通知先'],
  safety: ['受信日時', '研究用ID', 'フォームID', '理由', '通知先', '通知結果', '対応期限', '対応状況', '対応日時', '対応担当者', '対応メモ(研究データと分けて管理)']
};

// ======================================================================
// 純粋ロジック(Apps Script API に依存しない。node で単体テストする)
// ======================================================================

function parseQid_(title) {
  var m = /^([A-Za-z0-9_\-]+)\.\s/.exec(String(title));
  return m ? m[1] : null;
}

function qTitle_(q) { return q.id + '. ' + q.text; }

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

function normEmail_(s) { return String(s || '').trim().toLowerCase(); }
function normName_(s) { return String(s || '').replace(/[\s　]+/g, '').toLowerCase(); }
function isEmail_(s) { return /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/.test(String(s || '').trim()); }

/** 次の研究用ID(F0001形式)。テストIDは数えない */
function nextId_(ids) {
  var max = 0;
  (ids || []).forEach(function (i) {
    var m = /^F([0-9]{4})$/.exec(String(i));
    if (m && String(i) !== CONFIG.TEST_ID) max = Math.max(max, Number(m[1]));
  });
  return 'F' + ('0000' + (max + 1)).slice(-4);
}

/**
 * 申込フォームの送信を処理する。
 * namedValues: { 設問タイトル: [値] }  existing: [{id, email, nickname}]
 * 問題がなければ名簿の行を返し、問題があれば「申込要確認」の行を返す(研究用IDは発行しない)
 */
function processApplication_(namedValues, existing, tsIso) {
  var qs = SURVEY.apply.blocks.filter(function (b) { return b.type === 'q'; });
  var a = {};
  qs.forEach(function (q) {
    var raw = namedValues[qTitle_(q)];
    var v = Array.isArray(raw) ? raw[0] : raw;
    a[q.id] = (v === undefined || v === null) ? '' : String(v).trim();
  });
  var problems = [];
  if (!a.AP1) problems.push('保護者名が未入力');
  if (!a.AP4) problems.push('お子さまの呼び名が未入力');
  if (!isEmail_(a.AP2)) problems.push('メールアドレスの形式が不正');
  else if (normEmail_(a.AP2) !== normEmail_(a.AP3)) problems.push('メールアドレスが確認欄と一致しない');
  ['CONSENT', 'CONSENT_CHILD', 'CONSENT_PI', 'CONSENT_ANON'].forEach(function (id) { if (!a[id]) problems.push('同意未確認:' + id); });
  var dup = (existing || []).some(function (e) { return normEmail_(e.email) === normEmail_(a.AP2) && normName_(e.nickname) === normName_(a.AP4); });
  if (dup) problems.push('重複申込(同じメールアドレスと呼び名がすでに登録済み)');
  if (problems.length) {
    return { ok: false, reason: problems.join(' / '), pendingRow: [tsIso, a.AP1, a.AP2, a.AP4, problems.join(' / '), a.AP5] };
  }
  var id = nextId_((existing || []).map(function (e) { return e.id; }));
  return { ok: true, id: id, name: a.AP1, email: a.AP2, nickname: a.AP4, row: [id, tsIso, a.AP1, a.AP2, a.AP4, '', '参加中', '', '', '', a.AP5, ''] };
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

var LINK_TIMES = ['T0', 'T1', 'T2'];
function isParticipating_(status) { var s = String(status || '').trim(); return s === '' || s === '参加中'; }

/**
 * リンクを送る対象を選ぶ。
 * rows: [{row, id, email, status, sessionDate:'yyyy-MM-dd'|'', sent:{T0,T1,T2}}]
 * selectedSet が無い場合の条件: T0=鑑定日が入力済み/T1=鑑定日を過ぎた(当日を含む)/T2=鑑定の90日後以降。いずれも未送信
 */
function linksDue_(rows, time, today, selectedSet) {
  return rows.filter(function (r) {
    if (!r.id || r.id === CONFIG.TEST_ID || !isEmail_(r.email) || !isParticipating_(r.status)) return false;
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

function buildLinkEmail_(time, p, urls) {
  var dead = {
    T0: p.sessionDate ? '鑑定日(' + p.sessionDate + ')の前日までに' : '鑑定の前日までに',
    T1: '鑑定の当日から3日以内に',
    T2: 'ご都合のよいときに(鑑定から約3か月後の前後2週間ほどの間に)'
  }[time];
  var times = { T0: 'お子さま 約8〜10分／保護者 約6〜8分', T1: 'お子さま 約10分／保護者 約6分', T2: 'お子さま 約9〜10分／保護者 約7分' }[time];
  var body = p.name + ' 様\n\n' +
    (time === 'T0' ? 'このたびは、お申込みありがとうございます。' : 'いつもご協力ありがとうございます。') + '\n' +
    TIME_LABEL[time] + 'のアンケートをご案内します。' + dead + 'ご回答ください。(所要時間の目安:' + times + ')\n\n' +
    '■ お子さま用(' + p.nickname + 'さん)\n' + urls.child + '\n\n' +
    '■ 保護者用\n' + urls.parent + '\n\n' +
    '【お願い】\n' +
    '・お子さま用は、お子さまご本人が回答してください。\n' +
    '・お子さま用と保護者用は、別の端末(または別の場所)で、それぞれ回答してください。お互いの回答を、見たり、聞き出したりしないでください。\n' +
    '・できれば最後まで答えていただけると、とても助かります。答えにくい質問は、飛ばしても大丈夫です。途中でやめたくなったら、やめても大丈夫です。\n' +
    '・リンクは、他の方に転送しないでください。\n\n' +
    'ご不明な点や、気になることがあれば、このメールにご返信ください。\n\n' +
    CONFIG.SENDER_NAME + '\n' + CONFIG.CONTACT_MAIL;
  return { subject: '【アンケートのご案内】' + TIME_LABEL[time] + 'のアンケート', body: body };
}

function buildReceiptEmail_(formKey, p) {
  var who = SURVEY.forms[formKey].role === 'child' ? 'お子さま用' : '保護者用';
  var tl = TIME_LABEL[SURVEY.forms[formKey].time];
  return {
    subject: '【アンケートを受け付けました】' + who + '(' + tl + ')',
    body: p.name + ' 様\n\n' + who + '(' + tl + ')のアンケートへのご回答を、受け付けました。ありがとうございました。\n' +
      '※ご回答の内容は、このメールには記載していません。\n\nご不明な点や、気になることがあれば、このメールにご返信ください。\n\n' + CONFIG.SENDER_NAME + '\n' + CONFIG.CONTACT_MAIL
  };
}

function buildApplyReceiptEmail_(p) {
  return {
    subject: '【お申込みを受け付けました】算命学の鑑定プロジェクト',
    body: p.name + ' 様\n\nお申込みありがとうございます。お申込みを受け付けました。(お子さまの呼び名:' + p.nickname + ')\n\n' +
      '・日程の調整は、運営から改めてご連絡します。\n・アンケートのご案内は、日程が決まったあとに、このメールアドレスにお送りします。\n' +
      '・このメールに心当たりがない場合は、お手数ですが、ご返信ください。\n\n' + CONFIG.SENDER_NAME + '\n' + CONFIG.CONTACT_MAIL
  };
}

// ======================================================================
// フォーム構築(Apps Script)
// ======================================================================

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
    var title = qTitle_(b);
    if (b.kind === 'id') {
      it = form.addTextItem().setTitle(title);
      it.setValidation(FormApp.createTextValidation().requireTextMatchesPattern(SURVEY.idPattern).setHelpText('F0001 の形式です。専用リンクから開くと自動で入力されます。').build());
      it.setRequired(true);
    } else if (b.kind === 'email') {
      it = form.addTextItem().setTitle(title);
      it.setValidation(FormApp.createTextValidation().requireTextIsEmail().build());
      it.setRequired(!!b.required);
    } else if (b.kind === 'text1') {
      it = form.addTextItem().setTitle(title);
      it.setRequired(!!b.required);
    } else if (b.kind === 'consent') {
      it = form.addCheckboxItem().setTitle(title);
      it.setChoices([it.createChoice(b.choices[0])]);
      it.setRequired(!!b.required);
    } else if (b.kind === 'age') {
      it = form.addTextItem().setTitle(title);
      it.setValidation(FormApp.createTextValidation().requireNumberBetween(5, 25).setHelpText('数字(歳)で入力してください。').build());
      it.setRequired(false);
    } else if (b.kind === 'text') {
      it = form.addParagraphTextItem().setTitle(title);
      it.setRequired(false);
      if (b.note) it.setHelpText(b.note);
    } else if (b.kind === 'multi') {
      it = form.addCheckboxItem().setTitle(title);
      it.setChoices(choicesOf_(b).map(function (c) { return it.createChoice(c); }));
      it.setRequired(false);
      if (b.exclusive) it.setHelpText('「' + b.exclusive + '」を選ぶときは、他の項目は選ばないでください。');
    } else {
      it = form.addMultipleChoiceItem().setTitle(title);
      it.setChoices(choicesOf_(b).map(function (c) { return it.createChoice(c); }));
      it.setRequired(false);
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

function setup() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SS_ID')) throw new Error('すでにセットアップ済みです。やり直す場合は、スクリプトプロパティ SS_ID・REG_SS_ID・FORM_IDS を削除してください(既存の回答は消えません)。');
  var errors = validateSurveyDefinition_();
  if (errors.length) throw new Error('設問定義にエラーがあります:\n' + errors.join('\n'));
  var reg = SpreadsheetApp.getActiveSpreadsheet();
  if (!reg) throw new Error('このスクリプトは、台帳にするスプレッドシートの「拡張機能 → Apps Script」から作成してください。');

  var db = SpreadsheetApp.create(CONFIG.DB_NAME);
  props.setProperty('SS_ID', db.getId());
  props.setProperty('REG_SS_ID', reg.getId());

  var formIds = {};
  SURVEY.formKeys.forEach(function (key) {
    var before = db.getSheets().map(function (s) { return s.getSheetId(); });
    var form = buildForm_(key, db);
    formIds[key] = form.getId();
    renameNewSheet_(db, before, 'resp_' + key);
  });
  var beforeReg = reg.getSheets().map(function (s) { return s.getSheetId(); });
  var applyForm = buildFormFromDef_(SURVEY.apply, reg, SURVEY.apply.confirm);
  formIds.APPLY = applyForm.getId();
  renameNewSheet_(reg, beforeReg, 'resp_APPLY');
  props.setProperty('FORM_IDS', JSON.stringify(formIds));

  initDbSheets_(db);
  initRegSheets_(reg);
  ScriptApp.newTrigger('onFormSubmit').forSpreadsheet(db).onFormSubmit().create();
  ScriptApp.newTrigger('onApplySubmit').forSpreadsheet(reg).onFormSubmit().create();
  ScriptApp.newTrigger('checkOverdue').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('checkReminders').timeBased().everyDays(1).atHour(9).create();

  Logger.log('台帳: ' + reg.getUrl());
  Logger.log('回答DB: ' + db.getUrl());
  Logger.log('申込フォーム(公開用): ' + applyForm.getPublishedUrl());
  Logger.log('申込フォーム(編集): ' + applyForm.getEditUrl());
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
    ['このファイルについて', '', 'この台帳には個人情報(お名前・メールアドレス)が入っています。運営のみに共有してください。研究の分析には、別ファイルの「' + CONFIG.DB_NAME + '」を使います'],
    ['注意', '', '回答DBは、研究担当者のみに共有してください。子ども・保護者・鑑定師には共有しないでください'],
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
  function ds(d) { return (d instanceof Date) ? Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd') : String(d || '').trim(); }
  return v.map(function (r, i) {
    return { row: i + 2, id: String(r[0]).trim(), name: String(r[2]).trim(), email: String(r[3]).trim(), nickname: String(r[4]).trim(),
      sessionDate: ds(r[5]), status: r[6], sent: { T0: ds(r[7]), T1: ds(r[8]), T2: ds(r[9]) } };
  }).filter(function (r) { return r.id; });
}

var formCache_ = {};
/** 研究用ID入力済みの専用リンク */
function getPrefilledUrl_(formKey, id) {
  if (!formCache_[formKey]) {
    var f = FormApp.openById(getFormIds_()[formKey]);
    formCache_[formKey] = { form: f, item: f.getItems(FormApp.ItemType.TEXT).filter(function (i) { return i.getTitle().indexOf('RID. ') === 0; })[0] };
  }
  var c = formCache_[formKey];
  return c.form.createResponse().withItemResponse(c.item.asTextItem().createResponse(id)).toPrefilledUrl();
}

function sendMail_(to, subject, body) {
  MailApp.sendEmail({ to: to, subject: subject, body: body, name: CONFIG.SENDER_NAME, replyTo: CONFIG.CONTACT_MAIL });
}

// ======================================================================
// 申込・送信
// ======================================================================

/** 申込フォームの送信時: 研究用IDを発行して名簿に登録し、受付確認メールを送る */
function onApplySubmit(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var reg = e.range.getSheet().getParent();
    var tsIso = nowStr_();
    var existing = readRoster_(reg).map(function (r) { return { id: r.id, email: r.email, nickname: r.nickname }; });
    var res = processApplication_(e.namedValues, existing, tsIso);
    var op = opMail_(reg);
    if (res.ok) {
      reg.getSheetByName(SHEETS.roster).appendRow(res.row);
      var mail = buildApplyReceiptEmail_(res);
      var result = '送信済み';
      try { sendMail_(res.email, mail.subject, mail.body); } catch (err) { result = '【送信失敗】' + err; }
      reg.getSheetByName(SHEETS.sendlog).appendRow([tsIso, res.id, '申込受付', res.email, result]);
      if (op) sendMail_(op, '[研究アンケート] 新しい申込がありました(' + res.id + ')', res.id + ' / ' + res.name + ' / お子さま:' + res.nickname + '\n日程調整のうえ、名簿の「鑑定日」を入力してください。\n' + reg.getUrl());
    } else {
      reg.getSheetByName(SHEETS.pending).appendRow(res.pendingRow);
      if (op) sendMail_(op, '[研究アンケート] 確認が必要な申込があります', '理由: ' + res.reason + '\n「申込要確認」シートをご確認ください。(研究用IDは発行していません)\n' + reg.getUrl());
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

/** 確認ダイアログのあと、対象の家庭にアンケートのリンクをメールで送る(ボタン=メニューから実行) */
function sendLinks_(time, mode) {
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
  var list = due.slice(0, 20).map(function (d) { return d.id + ' ' + d.name + ' <' + d.email + '>' + (d.sessionDate ? ' 鑑定日:' + d.sessionDate : ''); }).join('\n');
  var ans = ui.alert('送信の確認', due.length + '家庭に、' + TIME_LABEL[time] + 'のアンケートのリンク(子ども用・保護者用)を、メールで送ります。\n\n' + list + (due.length > 20 ? '\n…ほか' + (due.length - 20) + '家庭' : '') + '\n\n送ってよろしいですか?', ui.ButtonSet.YES_NO);
  if (ans !== ui.Button.YES) return;

  var sh = reg.getSheetByName(SHEETS.roster);
  var log = reg.getSheetByName(SHEETS.sendlog);
  var col = 8 + LINK_TIMES.indexOf(time);
  var ok = 0, ng = 0;
  due.forEach(function (d) {
    var stamp = nowStr_();
    try {
      var mail = buildLinkEmail_(time, d, { child: getPrefilledUrl_('C' + 'T' + time.charAt(1), d.id), parent: getPrefilledUrl_('P' + 'T' + time.charAt(1), d.id) });
      sendMail_(d.email, mail.subject, mail.body);
      sh.getRange(d.row, col).setValue(stamp);
      log.appendRow([stamp, d.id, time, d.email, '送信済み']);
      ok++;
    } catch (err) {
      log.appendRow([stamp, d.id, time, d.email, '【失敗】' + err]);
      ng++;
    }
  });
  ui.alert('送信が終わりました', '送信できた家庭: ' + ok + ' / 失敗: ' + ng + '\n(結果は「送信ログ」シートで確認できます)', ui.ButtonSet.OK);
}


/** 削除のお申し出があったとき: 研究用IDの回答データを、回答DB(生の回答・Long・LongOptions・Submissions)から削除し、名簿の個人情報も消す */
function deleteFamilyData() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt('削除する研究用ID', '削除を申し出た家庭の研究用ID(例:F0001)を入力してください。この操作は元に戻せません。', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var id = r.getResponseText().trim();
  if (!new RegExp(SURVEY.idPattern).test(id)) { ui.alert('研究用IDの形式が正しくありません(F0001 の形式)'); return; }
  var reg = regSS_();
  var db = dbSS_();
  var fam = readRoster_(reg).filter(function (x) { return x.id === id; })[0];
  if (!fam) { ui.alert('名簿に ' + id + ' が見つかりません'); return; }
  var ans = ui.alert('削除の確認', id + '(' + fam.name + ' 様 / お子さま:' + fam.nickname + ')の、アンケートの回答データをすべて削除し、名簿の個人情報(お名前・メールアドレス・お子さまの呼び名)を消去します。\n\n元に戻せません。実行しますか?', ui.ButtonSet.YES_NO);
  if (ans !== ui.Button.YES) return;
  var total = 0;
  db.getSheets().forEach(function (sh) {
    var name = sh.getName();
    if (sh.getLastRow() < 2) return;
    var vals = sh.getDataRange().getValues();
    var idCol = -1;
    if (name === SHEETS.long || name === SHEETS.options || name === SHEETS.submissions) idCol = vals[0].indexOf('研究用ID');
    else if (name.indexOf('resp_') === 0) vals[0].forEach(function (h, i) { if (String(h).indexOf('RID.') === 0) idCol = i; });
    if (idCol < 0) return;
    var res = dropRowsById_(vals, idCol, id);
    if (!res.removed) return;
    total += res.removed;
    sh.clearContents();
    sh.getRange(1, 1, res.kept.length, res.kept[0].length).setValues(res.kept);
  });
  var rsh = reg.getSheetByName(SHEETS.roster);
  rsh.getRange(fam.row, 3, 1, 3).clearContent();
  rsh.getRange(fam.row, 7).setValue('削除済み');
  rsh.getRange(fam.row, 12).setValue('削除のお申し出により、' + todayStr_() + ' に回答データと個人情報を削除');
  reg.getSheetByName(SHEETS.sendlog).appendRow([nowStr_(), id, '削除', '', '回答データ' + total + '行・個人情報を削除']);
  ui.alert('削除しました', '回答DBから ' + total + ' 行を削除し、名簿の個人情報を消去しました。(安全対応ログ・送信ログに残る研究用IDの記録は、必要に応じて手動で整理してください)', ui.ButtonSet.OK);
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

    // 受付確認メール(回答内容は載せない)。登録済みの家庭の、最初の送信のみ
    var fam = byId[res.rid];
    if (!res.isTest && res.adopted && fam && isEmail_(fam.email) && res.flags.indexOf('ID形式不正') === -1) {
      var mail = buildReceiptEmail_(key, { name: fam.name });
      var result = '送信済み';
      try { sendMail_(fam.email, mail.subject, mail.body); } catch (err) { result = '【送信失敗】' + err; }
      reg.getSheetByName(SHEETS.sendlog).appendRow([tsIso, res.rid, key + ' 受付確認', fam.email, result]);
    }
  } finally {
    lock.releaseLock();
  }
}

/** 安全対応担当者へ通知(回答内容は含めない。研究用ID・フォーム・理由のみ) */
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
      sendMail_(to.join(','), '[研究アンケート] 確認が必要な回答があります(' + res.rid + ' / ' + key + ')',
        '研究用ID: ' + res.rid + '\nフォーム: ' + key + '\n受信: ' + tsIso + '\n理由:\n- ' + res.reasons.join('\n- ') +
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
      var due = new Date(String(r[6]).replace(' ', 'T') + ':00+09:00').getTime();
      if (!isNaN(due) && now > due) { overdue.push(r[1] + '(' + r[2] + ')'); sh.getRange(i + 2, 8).setValue('期限超過・未対応'); }
    }
  });
  if (overdue.length && to.length) {
    sendMail_(to.join(','), '[研究アンケート] 対応期限を過ぎた確認依頼があります', '次の確認依頼が、24時間以内に「対応済」になっていません:\n- ' + overdue.join('\n- ') + '\n' + reg.getUrl());
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
  sub.forEach(function (r) { if (r[6] === 'TRUE') adopted[r[2] + '|' + r[4]] = true; });
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
  sendMail_(to, '[研究アンケート] 本日のリマインド対象 ' + due.length + '件(' + today + ')',
    '次の家庭・フォームが未回答です。声かけをお願いします。リマインドは1つのフォームにつき最大2回です。\n' +
    '辞退された家庭には送らないでください(名簿の「参加状況」を「辞退」にすると、通知が止まります)。\n\n' + lines.join('\n') +
    '\n\n--- 文面の例(強制にならないようにしてください) ---\nアンケートへのご協力ありがとうございます。まだ回答がお済みでないようでしたら、お時間のあるときに、できる範囲でご回答いただけると助かります。答えにくい質問は飛ばしていただいて大丈夫です。\n' + reg.getUrl());
}

// ======================================================================
// 集計・出力
// ======================================================================

function buildSummary() {
  var ss = dbSS_();
  var sh = ss.getSheetByName(SHEETS.summary);
  var data = ss.getSheetByName(SHEETS.long).getDataRange().getValues();
  var head = data.shift();
  var ix = {}; head.forEach(function (h, i) { ix[h] = i; });
  var agg = {};
  data.forEach(function (r) {
    if (r[ix['分析採用']] !== 'TRUE') return;
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

/** CSV出力(UTF-8 BOM付き)。個人情報は含まない回答DBのみ。Drive のフォルダ「研究アンケート_CSV出力」に保存 */
function exportCsv() {
  var ss = dbSS_();
  var folders = DriveApp.getFoldersByName('研究アンケート_CSV出力');
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder('研究アンケート_CSV出力');
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
      if (r[ix['フォームID']] !== k || r[ix['分析採用']] !== 'TRUE') return;
      var s = r[ix['submission_id']];
      var o = bySid[s] = bySid[s] || { rid: r[ix['研究用ID']], ts: r[ix['回答日時']], v: {} };
      var st = r[ix['状態']];
      o.v[r[ix['設問ID']]] = st === '回答' ? (r[ix['数値コード']] !== '' ? r[ix['数値コード']] : r[ix['回答内容']]) : (st === '非表示(分岐)' ? 'NA_HIDDEN' : '');
    });
    var rows = [['研究用ID', '回答日時'].concat(ids)];
    Object.keys(bySid).forEach(function (s) { rows.push([bySid[s].rid, bySid[s].ts].concat(ids.map(function (id) { return bySid[s].v[id] === undefined ? '' : bySid[s].v[id]; }))); });
    save('wide_' + k, rows);
  });
  Logger.log('CSVを保存しました: ' + folder.getUrl());
}

// ======================================================================
// テスト(Apps Script 上で実行)
// ======================================================================

function runStaticTests() {
  var reg = regSS_();
  var res = [];
  function add(name, ok, detail) { res.push([name, ok ? 'OK' : 'NG', detail || '']); }
  var errors = validateSurveyDefinition_();
  add('A/B 設問定義の整合性(尺度・回答したくない・学年・設問数)', errors.length === 0, errors.join(' / '));
  var formIds = getFormIds_();
  var defs = {};
  SURVEY.formKeys.forEach(function (k) { defs[k] = SURVEY.forms[k]; });
  defs.APPLY = SURVEY.apply;
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
  var apply = FormApp.openById(formIds.APPLY);
  var reqConsent = apply.getItems().filter(function (i) { return i.getTitle().indexOf('CONSENT') === 0; });
  add('APPLY 同意の4項目がすべて必須', reqConsent.length === 4 && reqConsent.every(function (i) { return i.asCheckboxItem().isRequired(); }), String(reqConsent.length));
  var sh = reg.getSheetByName(SHEETS.tests);
  sh.getRange(2, 1, Math.max(sh.getLastRow(), 2), 3).clearContent();
  sh.getRange(2, 1, res.length, 3).setValues(res);
  var ng = res.filter(function (r) { return r[1] === 'NG'; }).length;
  Logger.log('静的テスト: ' + (res.length - ng) + ' OK / ' + ng + ' NG');
}

/** テスト送信(研究用ID F9999)。実行後1分ほど待ってから verifyDataTests() を実行する */
function runDataTests() {
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
  var db = dbSS_();
  var reg = regSS_();
  var long = db.getSheetByName(SHEETS.long).getDataRange().getValues();
  var head = long.shift(); var ix = {}; head.forEach(function (h, i) { ix[h] = i; });
  function find(form, qid) {
    return long.filter(function (r) { return r[ix['研究用ID']] === CONFIG.TEST_ID && r[ix['フォームID']] === form && r[ix['設問ID']] === qid; });
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
  add('D: 重複送信(PT1)で2件目に重複フラグ・分析採用FALSE', sub.filter(function (r) { return r[2] === CONFIG.TEST_ID && r[4] === 'PT1'; }).some(function (r) { return r[6] === 'FALSE' && String(r[7]).indexOf('重複送信') !== -1; }));
  var safety = reg.getSheetByName(SHEETS.safety).getDataRange().getValues();
  add('D: F8=3 で安全対応ログ(台帳)に記録', safety.some(function (r) { return r[1] === CONFIG.TEST_ID && String(r[3]).indexOf('F8') !== -1; }));
  var sh = reg.getSheetByName(SHEETS.tests);
  sh.getRange(sh.getLastRow() + 1, 1, res.length, 3).setValues(res);
  var ng = res.filter(function (r) { return r[1] === 'NG'; }).length;
  Logger.log('データテスト: ' + (res.length - ng) + ' OK / ' + ng + ' NG(結果は台帳のテスト結果シート)');
}
