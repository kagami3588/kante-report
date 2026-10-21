/**
 * 算命学×自己理解・他者理解・キャリア形成 研究アンケート — 実装(Google Apps Script)
 *
 * 使い方:
 *   1. script.google.com で新規プロジェクトを作成し、Survey.gs・Code.gs・appsscript.json を貼り付ける
 *   2. 下の CONFIG を設定する(安全対応担当者のメール、連絡先)
 *   3. setup() を実行(権限を許可)→ 6つのフォームと回答DB(スプレッドシート)が作られる
 *   4. 「参加者台帳」シートの A列に研究用ID(F0001 形式)を入力 → generateLinks() を実行
 *   5. runStaticTests() → runDataTests() →(1分後)verifyDataTests() を実行して結果を確認
 */

var CONFIG = {
  SS_NAME: '研究アンケート回答DB',
  CONTACT_TEXT: '運営の連絡先:kagami.3588@gmail.com',
  TEST_ID: 'F9999',
  OVERDUE_HOURS: 24
};

var SHEETS = {
  roster: '参加者台帳',
  settings: '設定',
  submissions: 'Submissions',
  long: 'Long',
  options: 'LongOptions',
  summary: '集計',
  safety: '安全対応ログ',
  links: 'リンク一覧',
  codebook: 'コードブック',
  tests: 'テスト結果',
  reminders: 'リマインドログ'
};

var HEAD = {
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

  if (def.blocks.some(function (b) { return b.type === 'q' && b.id === 'CONSENT'; }) && !answers.CONSENT) flags.push('同意未確認');

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
// フォーム構築(Apps Script)
// ======================================================================

function buildForm_(key, ss) {
  var def = SURVEY.forms[key];
  var form = FormApp.create(def.title);
  form.setDescription(def.intro);
  form.setCollectEmail(false);
  form.setAllowResponseEdits(false);
  form.setLimitOneResponsePerUser(false);
  form.setProgressBar(true);
  form.setShowLinkToRespondAgain(false);
  form.setPublishingSummary(false);
  form.setShuffleQuestions(false);
  form.setConfirmationMessage('ご回答ありがとうございました。気になることがあれば、いつでもご連絡ください。' + CONFIG.CONTACT_TEXT);

  var pages = [];       // {block, item}
  var pendingGates = []; // {gateItem, skip, pageIndexOfGate}
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
    var title = b.system ? (b.id + '. ' + b.text) : qTitle_(b);
    if (b.kind === 'id') {
      it = form.addTextItem().setTitle(title);
      it.setValidation(FormApp.createTextValidation().requireTextMatchesPattern(SURVEY.idPattern).setHelpText('F0001 の形式です。専用リンクから開くと自動で入力されます。').build());
      it.setRequired(true);
    } else if (b.kind === 'consent') {
      it = form.addCheckboxItem().setTitle(title);
      it.setChoices([it.createChoice(b.choices[0])]);
      it.setRequired(true);
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

  // ゲートのナビゲーション解決: 「はい」→ 続行(条件ページへ)、skip値 → 条件ページの次の非条件ページ
  pendingGates.forEach(function (g) {
    var target = null;
    for (var j = g.pageIndex + 1; j < pages.length; j++) {
      if (!pages[j].block.conditional) { target = pages[j].item; break; }
    }
    // 条件ページがフォーム末尾まで続く場合は、スキップ=送信
    var choices = choicesOf_(g.q).map(function (c) {
      if (c !== g.q.gate.skip) return g.item.createChoice(c, FormApp.PageNavigationType.CONTINUE);
      return target ? g.item.createChoice(c, target) : g.item.createChoice(c, FormApp.PageNavigationType.SUBMIT);
    });
    g.item.setChoices(choices);
  });

  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());
  return form;
}

function setup() {
  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('SS_ID')) throw new Error('すでにセットアップ済みです。やり直す場合は、スクリプトプロパティ SS_ID と FORM_IDS を削除してください(既存の回答は消えません)。');
  var errors = validateSurveyDefinition_();
  if (errors.length) throw new Error('設問定義にエラーがあります:\n' + errors.join('\n'));

  var ss = SpreadsheetApp.create(CONFIG.SS_NAME);
  props.setProperty('SS_ID', ss.getId());

  var formIds = {};
  SURVEY.formKeys.forEach(function (key) {
    var before = ss.getSheets().map(function (s) { return s.getSheetId(); });
    var form = buildForm_(key, ss);
    formIds[key] = form.getId();
    SpreadsheetApp.flush();
    var after = ss.getSheets();
    after.forEach(function (s) { if (before.indexOf(s.getSheetId()) === -1) s.setName('resp_' + key); });
  });
  props.setProperty('FORM_IDS', JSON.stringify(formIds));

  initSheets_(ss);
  ScriptApp.newTrigger('onFormSubmit').forSpreadsheet(ss).onFormSubmit().create();
  ScriptApp.newTrigger('checkOverdue').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('checkReminders').timeBased().everyDays(1).atHour(9).create();

  Logger.log('回答DB: ' + ss.getUrl());
  SURVEY.formKeys.forEach(function (k) { Logger.log(k + ' 編集: ' + FormApp.openById(formIds[k]).getEditUrl()); });
}

function initSheets_(ss) {
  function mk(name, header) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (header) { sh.clear(); sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold'); sh.setFrozenRows(1); }
    return sh;
  }
  var roster = mk(SHEETS.roster, ['研究用ID', '鑑定日(yyyy-mm-dd)', '参加状況(参加中/辞退/完了)', '登録日', '備考(個人名は書かない)']);
  var settings = mk(SHEETS.settings, ['項目', '値', '説明']);
  settings.getRange(2, 1, 5, 3).setValues([
    ['安全対応担当者メール', '', '回答に確認が必要な内容があった場合の通知先(1名)'],
    ['安全対応担当者メール(代理)', '', '担当者不在時の通知先'],
    ['同意・個人名の対応表の場所', '', '研究用IDと個人を結ぶ表は、この回答DBとは別の、アクセスを制限したファイルで管理してください'],
    ['注意', '', 'この回答DBは、研究担当者のみに共有してください。子ども・保護者・鑑定師には共有しないでください'],
    ['運営メール(リマインド通知先)', 'kagami.3588@gmail.com', '毎朝9時に、その日にリマインドする家庭の一覧が届きます。辞退した家庭は、参加者台帳の「参加状況」を「辞退」にしてください(リマインドが止まります)']
  ]);
  mk(SHEETS.submissions, HEAD.submissions);
  mk(SHEETS.long, HEAD.long);
  mk(SHEETS.options, HEAD.options);
  mk(SHEETS.safety, HEAD.safety);
  mk(SHEETS.reminders, HEAD.reminders);
  mk(SHEETS.summary, ['(buildSummary() を実行すると作成されます)']);
  mk(SHEETS.links, ['研究用ID', 'CT0', 'CT1', 'CT2', 'PT0', 'PT1', 'PT2']);
  mk(SHEETS.tests, ['テスト', '結果', '詳細']);
  var cb = mk(SHEETS.codebook, null);
  cb.clear();
  var rows = buildCodebookRows_();
  cb.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  cb.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
  cb.setFrozenRows(1);
}

function getSS_() { return SpreadsheetApp.openById(PropertiesService.getScriptProperties().getProperty('SS_ID')); }
function getFormIds_() { return JSON.parse(PropertiesService.getScriptProperties().getProperty('FORM_IDS')); }

/** 参加者台帳のIDごとに、6フォームの専用リンク(研究用ID入力済み)を作る */
function generateLinks() {
  var ss = getSS_();
  var ids = ss.getSheetByName(SHEETS.roster).getRange('A2:A').getValues().map(function (r) { return String(r[0]).trim(); }).filter(function (s) { return s !== ''; });
  var re = new RegExp(SURVEY.idPattern);
  var formIds = getFormIds_();
  var ridItems = {};
  SURVEY.formKeys.forEach(function (k) {
    var f = FormApp.openById(formIds[k]);
    ridItems[k] = { form: f, item: f.getItems(FormApp.ItemType.TEXT).filter(function (i) { return i.getTitle().indexOf('RID. ') === 0; })[0] };
  });
  var out = [];
  ids.forEach(function (id) {
    if (!re.test(id)) throw new Error('研究用IDの形式が不正です(F0001 形式): ' + id);
    var row = [id];
    SURVEY.formKeys.forEach(function (k) {
      var r = ridItems[k].form.createResponse().withItemResponse(ridItems[k].item.asTextItem().createResponse(id));
      row.push(r.toPrefilledUrl());
    });
    out.push(row);
  });
  var sh = ss.getSheetByName(SHEETS.links);
  sh.getRange(2, 1, Math.max(sh.getLastRow(), 2), 7).clearContent();
  if (out.length) sh.getRange(2, 1, out.length, 7).setValues(out);
  Logger.log(out.length + '家庭分のリンクを作成しました。子ども用(CT*)と保護者用(PT*)は、別々の連絡先に送ってください。');
}

// ======================================================================
// 送信時の処理
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
    var ss = sheet.getParent();
    var tsIso = Utilities.formatDate(new Date(), 'Asia/Tokyo', "yyyy-MM-dd'T'HH:mm:ss");
    var sid = key + '-' + Utilities.getUuid().slice(0, 8);

    var rosterIds = {};
    ss.getSheetByName(SHEETS.roster).getRange('A2:A').getValues().forEach(function (r) { var s = String(r[0]).trim(); if (s) rosterIds[s] = true; });
    var subSheet = ss.getSheetByName(SHEETS.submissions);
    var prior = {};
    if (subSheet.getLastRow() > 1) {
      subSheet.getRange(2, 3, subSheet.getLastRow() - 1, 3).getValues().forEach(function (r) { prior[r[0] + '|' + r[2]] = true; });
    }
    var ctx = {
      isRegistered: function (id) { return !!rosterIds[id]; },
      hasPrior: function (id, k) { return !!prior[id + '|' + k]; }
    };
    var res = processSubmission_(key, e.namedValues, tsIso, sid, ctx);

    subSheet.appendRow(res.submission);
    var longSheet = ss.getSheetByName(SHEETS.long);
    if (res.rows.length) longSheet.getRange(longSheet.getLastRow() + 1, 1, res.rows.length, HEAD.long.length).setValues(res.rows);
    var optSheet = ss.getSheetByName(SHEETS.options);
    if (res.optionRows.length) optSheet.getRange(optSheet.getLastRow() + 1, 1, res.optionRows.length, HEAD.options.length).setValues(res.optionRows);

    if (res.reasons.length) notifySafety_(ss, res, key, tsIso);
  } finally {
    lock.releaseLock();
  }
}

/** 安全対応担当者へ通知(回答内容は含めない。研究用ID・フォーム・理由のみ) */
function notifySafety_(ss, res, key, tsIso) {
  var settings = ss.getSheetByName(SHEETS.settings);
  var to = [String(settings.getRange('B2').getValue()).trim(), String(settings.getRange('B3').getValue()).trim()].filter(function (s) { return s !== ''; });
  var due = new Date(Date.now() + 24 * 3600 * 1000);
  var dueStr = Utilities.formatDate(due, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
  var result;
  if (res.isTest) result = 'テスト送信のためメール送信なし';
  else if (!to.length) result = '【未送信】通知先が未設定です(設定シートに入力してください)';
  else {
    try {
      MailApp.sendEmail(to.join(','), '[研究アンケート] 確認が必要な回答があります(' + res.rid + ' / ' + key + ')',
        '研究用ID: ' + res.rid + '\nフォーム: ' + key + '\n受信: ' + tsIso + '\n理由:\n- ' + res.reasons.join('\n- ') +
        '\n\n対応期限: ' + dueStr + '(受信後24時間以内)\n回答内容は、回答DBの該当行を直接ご確認ください。このメールには回答内容を記載していません。\n' + ss.getUrl());
      result = '送信済み';
    } catch (err) { result = '【送信失敗】' + err; }
  }
  var logSheet = ss.getSheetByName(SHEETS.safety);
  logSheet.appendRow([tsIso, res.rid, key, res.reasons.join(' / '), to.join(','), result, dueStr, '未対応', '', '', '']);
}

/** 24時間を超えて未対応の通知がある場合、再通知する(毎時実行) */
function checkOverdue() {
  var ss = getSS_();
  var sh = ss.getSheetByName(SHEETS.safety);
  if (sh.getLastRow() < 2) return;
  var settings = ss.getSheetByName(SHEETS.settings);
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
    MailApp.sendEmail(to.join(','), '[研究アンケート] 対応期限を過ぎた確認依頼があります', '次の確認依頼が、24時間以内に「対応済」になっていません:\n- ' + overdue.join('\n- ') + '\n' + ss.getUrl());
  }
}

/** 毎朝9時に、その日にリマインドする家庭の一覧を運営にメールする(家庭へ直接は送らない) */
function checkReminders() {
  var ss = getSS_();
  var today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  var rv = ss.getSheetByName(SHEETS.roster).getDataRange().getValues();
  rv.shift();
  var roster = rv.map(function (r) {
    var d = r[1];
    var ds = (d instanceof Date) ? Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd') : String(d).trim();
    return { id: String(r[0]).trim(), sessionDate: ds, status: r[2] };
  });
  var sub = ss.getSheetByName(SHEETS.submissions).getDataRange().getValues();
  sub.shift();
  var adopted = {};
  sub.forEach(function (r) { if (r[6] === 'TRUE') adopted[r[2] + '|' + r[4]] = true; });
  var due = remindersDue_(roster, adopted, today);
  if (!due.length) return;
  var links = {};
  var lv = ss.getSheetByName(SHEETS.links).getDataRange().getValues();
  lv.shift();
  lv.forEach(function (r) { links[r[0]] = { CT0: r[1], CT1: r[2], CT2: r[3], PT0: r[4], PT1: r[5], PT2: r[6] }; });
  var to = String(ss.getSheetByName(SHEETS.settings).getRange('B6').getValue()).trim();
  var lines = due.map(function (d) {
    return d.id + ' / ' + d.form + '(' + (d.form.charAt(0) === 'C' ? '子ども' : '保護者') + ')/ ' + d.nth + '回目\n  ' + ((links[d.id] || {})[d.form] || '(リンク一覧にリンクなし)');
  });
  var log = ss.getSheetByName(SHEETS.reminders);
  due.forEach(function (d) { log.appendRow([today, d.id, d.form, d.nth, to]); });
  if (!to) { Logger.log('リマインド通知先(設定シートB6)が未設定です'); return; }
  MailApp.sendEmail(to, '[研究アンケート] 本日のリマインド対象 ' + due.length + '件(' + today + ')',
    '次の家庭・フォームが未回答です。声かけをお願いします。リマインドは1つのフォームにつき最大2回です。\n' +
    '辞退された家庭には送らないでください(参加者台帳の「参加状況」を「辞退」にすると、通知が止まります)。\n\n' + lines.join('\n') +
    '\n\n--- 文面の例(強制にならないようにしてください) ---\nアンケートへのご協力ありがとうございます。まだ回答がお済みでないようでしたら、お時間のあるときに、できる範囲でご回答いただけると助かります。答えにくい質問は飛ばしていただいて大丈夫です。\n' + ss.getUrl());
}

/** 既にセットアップ済みの環境で、リマインドのトリガーだけ追加する場合に実行 */
function installReminderTrigger() {
  ScriptApp.newTrigger('checkReminders').timeBased().everyDays(1).atHour(9).create();
}

// ======================================================================
// 集計・出力
// ======================================================================

function buildSummary() {
  var ss = getSS_();
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

/** CSV出力(UTF-8 BOM付き)。Drive のフォルダ「研究アンケート_CSV出力」に保存 */
function exportCsv() {
  var ss = getSS_();
  var folders = DriveApp.getFoldersByName('研究アンケート_CSV出力');
  var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder('研究アンケート_CSV出力');
  var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmm');
  function save(name, rows) {
    var blob = Utilities.newBlob('﻿' + toCsv_(rows), 'text/csv', name + '_' + stamp + '.csv');
    folder.createFile(blob);
  }
  save('long', ss.getSheetByName(SHEETS.long).getDataRange().getValues());
  save('long_options', ss.getSheetByName(SHEETS.options).getDataRange().getValues());
  save('submissions', ss.getSheetByName(SHEETS.submissions).getDataRange().getValues());
  save('codebook', buildCodebookRows_());
  // フォーム別のワイド形式(採用送信のみ。1行=1送信、列=設問ID。値は数値コード、無ければ原文)
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
  var ss = getSS_();
  var res = [];
  function add(name, ok, detail) { res.push([name, ok ? 'OK' : 'NG', detail || '']); }
  var errors = validateSurveyDefinition_();
  add('A/B 設問定義の整合性(尺度・回答したくない・学年・設問数)', errors.length === 0, errors.join(' / '));
  var formIds = getFormIds_();
  SURVEY.formKeys.forEach(function (k) {
    var form = FormApp.openById(formIds[k]);
    var items = form.getItems();
    var titles = items.map(function (i) { return i.getTitle(); });
    add(k + ' 「回答したくない」なし', !titles.join(' ').match(/回答したくない/));
    var mcBad = [];
    items.forEach(function (i) {
      if (i.getType() === FormApp.ItemType.MULTIPLE_CHOICE) {
        var m = i.asMultipleChoiceItem();
        var q = questionsOf_(k).filter(function (x) { return qTitle_(x) === i.getTitle(); })[0];
        if (!q) return;
        var got = m.getChoices().map(function (c) { return c.getValue(); }).join('|');
        if (got !== choicesOf_(q).join('|')) mcBad.push(q.id);
      }
    });
    add(k + ' 選択肢が仕様どおり', mcBad.length === 0, mcBad.join(','));
    var gateBad = [];
    questionsOf_(k).filter(function (q) { return q.gate; }).forEach(function (q) {
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
  var sh = ss.getSheetByName(SHEETS.tests);
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
      var q = questionsOf_(key).filter(function (x) { return (x.system ? x.id + '. ' + x.text : qTitle_(x)) === it.getTitle(); })[0];
      if (!q || map[q.id] === undefined) return;
      var v = map[q.id];
      if (q.kind === 'multi' || q.kind === 'consent') resp.withItemResponse(it.asCheckboxItem().createResponse(Array.isArray(v) ? v : [v]));
      else if (q.kind === 'single') resp.withItemResponse(it.asMultipleChoiceItem().createResponse(v));
      else if (q.kind === 'text' || q.kind === 'id' || q.kind === 'age') resp.withItemResponse((q.kind === 'text' ? it.asParagraphTextItem() : it.asTextItem()).createResponse(String(v)));
    });
    resp.submit();
  }
  // T1: B2-1=いいえ → B2-2/B2-2o は非表示、B1に排他矛盾
  submit('CT0', { CONSENT: '同意します', RID: CONFIG.TEST_ID, A1: '13', S1: '3：少しそう思う', 'B2-1': 'いいえ', B1: ['特にない', '新しいことを始めた'] });
  // F4_2=いいえ → F5_2は非表示 / F8=3 → 安全通知
  submit('CT2', { RID: CONFIG.TEST_ID, F1: 'わからない', F4_1: 'はい', F5_1: '3：ある程度きっかけになった', F4_2: 'いいえ', F8: '3：少し続いている' });
  // 重複送信
  submit('PT1', { RID: CONFIG.TEST_ID, PD1: '4：とてもそう思う' });
  submit('PT1', { RID: CONFIG.TEST_ID, PD1: '2：あまりそう思わない' });
  Logger.log('テスト送信しました。1分ほど待ってから verifyDataTests() を実行してください。');
}

function verifyDataTests() {
  var ss = getSS_();
  var long = ss.getSheetByName(SHEETS.long).getDataRange().getValues();
  var head = long.shift(); var ix = {}; head.forEach(function (h, i) { ix[h] = i; });
  function find(form, qid) {
    return long.filter(function (r) { return r[ix['研究用ID']] === CONFIG.TEST_ID && r[ix['フォームID']] === form && r[ix['設問ID']] === qid; });
  }
  var sub = ss.getSheetByName(SHEETS.submissions).getDataRange().getValues(); sub.shift();
  var res = [];
  function add(name, ok, detail) { res.push([name, ok ? 'OK' : 'NG', detail || '']); }
  add('D: B2-1=いいえ → B2-2が「非表示(分岐)」', find('CT0', 'B2-2').some(function (r) { return r[ix['状態']] === '非表示(分岐)'; }));
  add('D: 未回答(S2)は「未回答」で、数値に置換されない', find('CT0', 'S2').some(function (r) { return r[ix['状態']] === '未回答' && r[ix['数値コード']] === ''; }));
  add('D: F4_2=いいえ → F5_2が「非表示(分岐)」', find('CT2', 'F5_2').some(function (r) { return r[ix['状態']] === '非表示(分岐)'; }));
  add('D: F4_1=はい → F5_1が「回答」', find('CT2', 'F5_1').some(function (r) { return r[ix['状態']] === '回答'; }));
  add('D: F1「わからない」は欠測ではなくコード8', find('CT2', 'F1').some(function (r) { return r[ix['数値コード']] === 8; }));
  add('D: 排他矛盾(B1)のフラグ', sub.some(function (r) { return r[2] === CONFIG.TEST_ID && r[4] === 'CT0' && String(r[7]).indexOf('排他矛盾:B1') !== -1; }));
  add('D: 重複送信(PT1)で2件目に重複フラグ・分析採用FALSE', sub.filter(function (r) { return r[2] === CONFIG.TEST_ID && r[4] === 'PT1'; }).some(function (r) { return r[6] === 'FALSE' && String(r[7]).indexOf('重複送信') !== -1; }));
  var safety = ss.getSheetByName(SHEETS.safety).getDataRange().getValues();
  add('D: F8=3 で安全対応ログに記録', safety.some(function (r) { return r[1] === CONFIG.TEST_ID && String(r[3]).indexOf('F8') !== -1; }));
  var sh = ss.getSheetByName(SHEETS.tests);
  var last = sh.getLastRow();
  sh.getRange(last + 1, 1, res.length, 3).setValues(res);
  var ng = res.filter(function (r) { return r[1] === 'NG'; }).length;
  Logger.log('データテスト: ' + (res.length - ng) + ' OK / ' + ng + ' NG(結果はテスト結果シート)');
}
