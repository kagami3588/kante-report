// Apps Script のロジックを node で検証する(GASのAPIはモックで代替)
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const root = path.join(__dirname, '..', 'apps_script');
const code = fs.readFileSync(path.join(root, 'Survey.gs'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'Code.gs'), 'utf8');

// ---- FormApp モック(構造・分岐の検証用) ----
function makeFormApp() {
  const created = [];
  class Item {
    constructor(type, form) { this.type = type; this.form = form; this.title = ''; this.help = ''; this.required = false; this.choices = []; this.validation = null; }
    setTitle(t) { this.title = t; return this; }
    setHelpText(t) { this.help = t; return this; }
    setRequired(r) { this.required = r; return this; }
    setValidation(v) { this.validation = v; return this; }
    createChoice(value, nav) { return { value, nav }; }
    setChoices(c) { this.choices = c; return this; }
  }
  class Form {
    constructor(title) { this.title = title; this.items = []; this.settings = {}; }
    _add(type) { const it = new Item(type, this); this.items.push(it); return it; }
    addMultipleChoiceItem() { return this._add('MC'); }
    addCheckboxItem() { return this._add('CHECK'); }
    addTextItem() { return this._add('TEXT'); }
    addParagraphTextItem() { return this._add('PARA'); }
    addPageBreakItem() { return this._add('PAGE'); }
    addSectionHeaderItem() { return this._add('HEADER'); }
    setDescription(d) { this.settings.desc = d; return this; }
    setCollectEmail(v) { this.settings.collectEmail = v; return this; }
    setAllowResponseEdits(v) { this.settings.edits = v; return this; }
    setLimitOneResponsePerUser(v) { this.settings.limitOne = v; return this; }
    setProgressBar(v) { this.settings.progress = v; return this; }
    setShowLinkToRespondAgain(v) { this.settings.again = v; return this; }
    setPublishingSummary(v) { this.settings.summary = v; return this; }
    setShuffleQuestions(v) { this.settings.shuffle = v; return this; }
    setConfirmationMessage(m) { this.settings.confirm = m; return this; }
    setDestination() { this.settings.dest = true; return this; }
    getId() { return 'id-' + this.title; }
  }
  const FormApp = {
    PageNavigationType: { CONTINUE: 'CONTINUE', GO_TO_PAGE: 'GO_TO_PAGE', SUBMIT: 'SUBMIT' },
    DestinationType: { SPREADSHEET: 'SPREADSHEET' },
    createTextValidation() {
      const v = {};
      const b = { requireTextMatchesPattern(p) { v.pattern = p; return b; }, requireNumberBetween(a, c) { v.range = [a, c]; return b; }, setHelpText() { return b; }, build() { return v; } };
      return b;
    },
    create(title) { const f = new Form(title); created.push(f); return f; }
  };
  return { FormApp, created };
}

const { FormApp, created } = makeFormApp();
const ctx = vm.createContext({ FormApp, Logger: { log() {} }, console });
vm.runInContext(code, ctx);
const run = (expr) => vm.runInContext(expr, ctx);

let pass = 0, fail = 0;
function t(name, cond, detail) {
  if (cond) { pass++; console.log('OK  ' + name); }
  else { fail++; console.log('NG  ' + name + (detail ? '  -> ' + detail : '')); }
}

// 1. 設問定義の整合性
const errs = run('validateSurveyDefinition_()');
t('設問定義の整合性(尺度・回答したくない・学年・設問数・分岐参照)', errs.length === 0, errs.join(' / '));

// 2. 尺度の選択肢が仕様どおり
t('4段階の選択肢', JSON.stringify(run('SCALES.L4')) === JSON.stringify(['4：とてもそう思う', '3：少しそう思う', '2：あまりそう思わない', '1：全くそう思わない']));
t('頻度の選択肢', JSON.stringify(run('SCALES.FREQ4')) === JSON.stringify(['4：よくある', '3：ときどきある', '2：あまりない', '1：全くない']));
t('満足度の選択肢', JSON.stringify(run('SCALES.SAT4')) === JSON.stringify(['4：とても満足した', '3：少し満足した', '2：あまり満足しなかった', '1：全く満足しなかった']));

// 3. 全設問に「回答したくない」「学年」が無い
const all = run('SURVEY.formKeys.map(k => SURVEY.forms[k].intro + " " + SURVEY.forms[k].blocks.map(b => (b.text||"") + " " + (b.title||"") + " " + (choicesOf_(b)||[]).join(" ")).join(" ")).join(" ")');
t('すべての設問・選択肢・説明文に「回答したくない」が無い', !/回答したくない/.test(all));
t('学年を尋ねる文言が無い', !/学年/.test(all));
t('CT0に年齢の設問(A1)、PT0に子どもの年齢(PA2)', run('questionsOf_("CT0").some(q=>q.id==="A1"&&q.kind==="age")') && run('questionsOf_("PT0").some(q=>q.id==="PA2"&&q.kind==="age")'));

// 4. CT1の最初の設問はD1(満足度)
t('CT1の最初の設問がD1(満足度)', run('questionsOf_("CT1")[0].id') === 'D1');

// 5. フォーム構築(モック)と分岐ナビゲーション
for (const k of ['CT0', 'CT1', 'CT2', 'PT0', 'PT1', 'PT2']) {
  const ss = { getId: () => 'ss' };
  ctx.__ss = ss;
  const form = vm.runInContext(`buildForm_("${k}", __ss)`, ctx);
  const f = created[created.length - 1];
  t(k + ' フォーム構築', !!f && f.items.length > 0);
  t(k + ' 回答メール収集なし・編集不可・サマリー非公開', f.settings.collectEmail === false && f.settings.edits === false && f.settings.summary === false);
  const first = f.items[0];
  t(k + ' 先頭がページ区切りではない(Googleフォームの制約)', first.type !== 'PAGE');
  // 質問の必須: RID/CONSENT以外は任意
  const badReq = f.items.filter(i => i.required && !/^(RID|CONSENT)\./.test(i.title) && i.type !== 'PAGE' && i.type !== 'HEADER').map(i => i.title);
  t(k + ' 同意・IDを除き、すべて任意回答(回答を強制しない)', badReq.length === 0, badReq.join(' | '));
  // ゲート
  const gates = run(`questionsOf_("${k}").filter(q=>q.gate).map(q=>q.id)`);
  for (const gid of gates) {
    const q = run(`questionsOf_("${k}").filter(q=>q.id==="${gid}")[0]`);
    const item = f.items.find(i => i.title === gid + '. ' + q.text);
    const skip = item.choices.find(c => c.value === q.gate.skip);
    const cont = item.choices.find(c => c.value !== q.gate.skip);
    const toSubmit = skip.nav === 'SUBMIT';
    t(k + ' ' + gid + ' skip選択肢がページ移動または送信', toSubmit || (skip.nav && typeof skip.nav === 'object' && skip.nav.type === 'PAGE'));
    t(k + ' ' + gid + ' 継続選択肢はCONTINUE', cont.nav === 'CONTINUE');
    // skip先は、gateより後ろのページ(送信の場合は、条件ページが末尾まで続く)
    const gi = f.items.indexOf(item), ti = toSubmit ? f.items.length : f.items.indexOf(skip.nav);
    t(k + ' ' + gid + ' skip先がgateより後ろ', ti > gi);
    // gateと skip先の間に条件ページが1つ以上ある
    const between = f.items.slice(gi + 1, ti).filter(i => i.type === 'PAGE');
    t(k + ' ' + gid + ' 条件ページがgateとskip先の間にある', between.length >= 1);
    // 条件設問はgateとskip先の間にある
    const hidden = run(`questionsOf_("${k}").filter(q=>q.hiddenWhen&&q.hiddenWhen.id==="${gid}").map(q=>q.id)`);
    for (const hid of hidden) {
      const hq = run(`questionsOf_("${k}").filter(q=>q.id==="${hid}")[0]`);
      const hi = f.items.findIndex(i => i.title === hid + '. ' + hq.text);
      t(k + ' ' + hid + ' が' + gid + 'の条件ページ内にある', hi > gi && hi < ti);
    }
  }
}

// 6. 処理ロジック
const ctxOk = { isRegistered: id => id === 'F0001', hasPrior: () => false };
function nv(formKey, map) {
  const o = {};
  run(`questionsOf_("${formKey}")`).forEach(q => { const key = q.id + '. ' + q.text; o[key] = [map[q.id] === undefined ? '' : map[q.id]]; });
  return o;
}
// B2-1=いいえ → B2-2, B2-2o 非表示。未回答はNAでなく「未回答」。
let r = vm.runInContext('processSubmission_', ctx)('CT0', nv('CT0', { CONSENT: '同意します', RID: 'F0001', A1: '13', S1: '3：少しそう思う', 'B2-1': 'いいえ', B1: '特にない' }), '2026-11-01T10:00:00', 'sid1', ctxOk);
const st = id => r.rows.find(x => x[5] === id)[9];
const cd = id => r.rows.find(x => x[5] === id)[7];
t('B2-1=いいえ → B2-2は非表示(分岐)', st('B2-2') === '非表示(分岐)' && st('B2-2o') === '非表示(分岐)');
t('未回答S2は「未回答」、数値コードは空(0や1にしない)', st('S2') === '未回答' && cd('S2') === '');
t('S1=3：少しそう思う → コード3', cd('S1') === 3);
t('年齢A1=13 → コード13', cd('A1') === 13);
t('RID/CONSENTは分析対象の行に含まれない', !r.rows.some(x => x[5] === 'RID' || x[5] === 'CONSENT'));
t('正常な送信にフラグなし', r.flags.length === 0, r.flags.join(','));

// B2-1=はい → B2-2を表示。「わからない」と具体項目の同時選択は排他矛盾
r = vm.runInContext('processSubmission_', ctx)('CT0', nv('CT0', { CONSENT: '同意します', RID: 'F0001', 'B2-1': 'はい', 'B2-2': '家族との会話, わからない', B1: '自分の興味があることについて調べた, 特にない' }), 't', 'sid2', ctxOk);
t('B2-2「わからない」+他項目 → 排他矛盾', r.flags.indexOf('排他矛盾:B2-2') !== -1);
t('B1「特にない」+他項目 → 排他矛盾', r.flags.indexOf('排他矛盾:B1') !== -1);
t('複数選択は選択肢ごとにLongOptionsへ保存', r.optionRows.filter(o => o[3] === 'B2-2').length === 2);

// 非表示のはずの設問に回答がある
r = vm.runInContext('processSubmission_', ctx)('CT0', nv('CT0', { CONSENT: '同意します', RID: 'F0001', 'B2-1': 'いいえ', 'B2-2': '家族との会話' }), 't', 'sid3', ctxOk);
t('非表示設問への回答 → フラグ', r.flags.indexOf('非表示設問に回答あり:B2-2') !== -1);

// ID未登録・形式不正・重複・テストID
r = vm.runInContext('processSubmission_', ctx)('CT0', nv('CT0', { CONSENT: '同意します', RID: 'F0002' }), 't', 'sid4', ctxOk);
t('ID未登録フラグ', r.flags.indexOf('ID未登録') !== -1);
r = vm.runInContext('processSubmission_', ctx)('CT0', nv('CT0', { CONSENT: '同意します', RID: 'abc' }), 't', 'sid5', ctxOk);
t('ID形式不正フラグ', r.flags.indexOf('ID形式不正') !== -1);
r = vm.runInContext('processSubmission_', ctx)('CT1', nv('CT1', { RID: 'F0001', D1: '4：とても満足した' }), 't', 'sid6', { isRegistered: () => true, hasPrior: () => true });
t('重複送信 → 分析採用FALSE・フラグ', r.adopted === false && r.flags.indexOf('重複送信') !== -1 && r.rows.every(x => x[11] === 'FALSE'));
r = vm.runInContext('processSubmission_', ctx)('CT1', nv('CT1', { RID: 'F9999' }), 't', 'sid7', ctxOk);
t('テストID(F9999)は台帳に無くてもID未登録にならない', r.flags.indexOf('ID未登録') === -1 && r.isTest);

// CT2: F4/F5分岐
r = vm.runInContext('processSubmission_', ctx)('CT2', nv('CT2', { RID: 'F0001', F1: 'わからない', F4_1: 'はい', F5_1: '3：ある程度きっかけになった', F4_2: 'いいえ', F4_3: 'はい', F4_4: 'いいえ' }), 't', 'sid8', ctxOk);
const s8 = id => r.rows.find(x => x[5] === id)[9];
t('F4_1=はい・F5_1回答済み → 回答', s8('F5_1') === '回答');
t('F4_2=いいえ → F5_2は非表示(分岐)', s8('F5_2') === '非表示(分岐)');
t('F4_3=はい・F5_3未入力 → 未回答(非表示ではない)', s8('F5_3') === '未回答');
t('F4_4=いいえ → F5_4は非表示(分岐)', s8('F5_4') === '非表示(分岐)');
t('F1「わからない」→ コード8(欠測ではない)', r.rows.find(x => x[5] === 'F1')[7] === 8);
t('F4_1「はい」→ コード1、「いいえ」→ コード0', r.rows.find(x => x[5] === 'F4_1')[7] === 1 && r.rows.find(x => x[5] === 'F4_2')[7] === 0);

// F7/PF2の自由記述の分岐
r = vm.runInContext('processSubmission_', ctx)('CT2', nv('CT2', { RID: 'F0001', F7: 'いいえ' }), 't', 'sid9', ctxOk);
t('F7=いいえ → F7-1は非表示(分岐)', r.rows.find(x => x[5] === 'F7-1')[9] === '非表示(分岐)');
r = vm.runInContext('processSubmission_', ctx)('PT2', nv('PT2', { RID: 'F0001', PF2: 'はい', 'PF2-1': '本人の希望と違う学校を勧めた' }), 't', 'sid10', ctxOk);
t('PF2=はい → PF2-1は回答。自由記述あり=1', r.rows.find(x => x[5] === 'PF2-1')[9] === '回答' && r.rows.find(x => x[5] === 'PF2-1')[10] === 1);
r = vm.runInContext('processSubmission_', ctx)('PT2', nv('PT2', { RID: 'F0001', PF2: 'いいえ' }), 't', 'sid11', ctxOk);
t('PF2=いいえ → PF2-1は非表示(分岐)', r.rows.find(x => x[5] === 'PF2-1')[9] === '非表示(分岐)');

// 安全通知
r = vm.runInContext('processSubmission_', ctx)('CT2', nv('CT2', { RID: 'F0001', F8: '3：少し続いている' }), 't', 'sid12', ctxOk);
t('F8=3 → 確認依頼', r.reasons.length === 1 && /F8/.test(r.reasons[0]));
r = vm.runInContext('processSubmission_', ctx)('CT2', nv('CT2', { RID: 'F0001', F8: '2：以前はあったが、今は続いていない' }), 't', 'sid13', ctxOk);
t('F8=2(過去の不安のみ)→ 確認依頼なし', r.reasons.length === 0);
r = vm.runInContext('processSubmission_', ctx)('CT2', nv('CT2', { RID: 'F0001', F7: 'はい' }), 't', 'sid14', ctxOk);
t('F7=はい → 確認依頼', r.reasons.length === 1);
r = vm.runInContext('processSubmission_', ctx)('CT1', nv('CT1', { RID: 'F0001', D17: '少し不安でした' }), 't', 'sid15', ctxOk);
t('D17に記載 → 確認依頼', r.reasons.length === 1);
r = vm.runInContext('processSubmission_', ctx)('CT1', nv('CT1', { RID: 'F0001', D17: '' }), 't', 'sid16', ctxOk);
t('D17が空 → 確認依頼なし', r.reasons.length === 0);
r = vm.runInContext('processSubmission_', ctx)('PT2', nv('PT2', { RID: 'F0001', PF6: '4：強くある' }), 't', 'sid17', ctxOk);
t('PF6=4 → 確認依頼', r.reasons.length === 1);
t('確認依頼の理由に回答内容(自由記述の本文)を含めない', !/少し不安でした/.test(JSON.stringify(vm.runInContext('processSubmission_', ctx)('CT1', nv('CT1', { RID: 'F0001', D17: '少し不安でした' }), 't', 'sid18', ctxOk).reasons)));

// 7. コードブック
const cb = run('buildCodebookRows_()');
const expected = 29 + 17 + 17 + 13 + 9 + 9;
t('コードブックの行数 = 全設問数(' + expected + ')', cb.length - 1 === expected, String(cb.length - 1));
t('コードブックに「回答したくない」なし', !/回答したくない/.test(JSON.stringify(cb)));
const csv = run('toCsv_(buildCodebookRows_())');
t('CSV生成(カンマ・引用符のエスケープ)', csv.split('\r\n').length === cb.length);
t('コードブックの比較設問(S1→D2[R])', cb.find(x => x[0] === 'S1')[12].indexOf('D2[R]') !== -1);
t('A型の対応(R3↔PR1)', cb.find(x => x[0] === 'R3')[12].indexOf('PR1[A]') !== -1 && cb.find(x => x[0] === 'PR1')[12].indexOf('R3[A]') !== -1);

// 8. 設問数
const counts = run('SURVEY.formKeys.map(k => k + ":" + questionsOf_(k).filter(q=>!q.system).length).join(",")');
t('設問数 CT0=29 CT1=17 CT2=17 PT0=13 PT1=9 PT2=9', counts === 'CT0:29,CT1:17,CT2:17,PT0:13,PT1:9,PT2:9', counts);

// 9. リマインド
const rem = (roster, adopted, today) => vm.runInContext('remindersDue_', ctx)(roster, adopted, today);
const R1 = [{ id: 'F0001', sessionDate: '2026-11-10', status: '参加中' }];
let d = rem(R1, {}, '2026-11-05');
t('鑑定5日前 → T0の子ども・保護者(1回目)', d.length === 2 && d.every(x => x.nth === 1 && /T0|CT0|PT0/.test(x.form)));
d = rem(R1, {}, '2026-11-07');
t('鑑定3日前 → T0の2回目', d.length === 2 && d.every(x => x.nth === 2));
d = rem(R1, { 'F0001|CT0': true }, '2026-11-05');
t('回答済みのフォームにはリマインドしない', d.length === 1 && d[0].form === 'PT0');
d = rem(R1, {}, '2026-11-06');
t('対象日以外(鑑定4日前)は対象なし', d.length === 0);
d = rem(R1, {}, '2026-11-11');
t('鑑定+1日 → T1(1回目)', d.length === 2 && d.every(x => /T1$/.test(x.form) || /1$/.test(x.form)));
t('鑑定+103日は対象外(最大2回で終了)', rem(R1, {}, '2027-02-21').length === 0);
d = rem(R1, {}, '2027-02-11');
t('鑑定+93日 → T2(1回目)', d.length === 2 && d.every(x => /2$/.test(x.form)), JSON.stringify(d));
t('辞退した家庭にはリマインドしない', rem([{ id: 'F0001', sessionDate: '2026-11-10', status: '辞退' }], {}, '2026-11-05').length === 0);
t('完了した家庭にはリマインドしない', rem([{ id: 'F0001', sessionDate: '2026-11-10', status: '完了' }], {}, '2026-11-05').length === 0);
t('参加状況が空欄なら参加中として扱う', rem([{ id: 'F0001', sessionDate: '2026-11-10', status: '' }], {}, '2026-11-05').length === 2);
t('鑑定日が未入力の家庭は対象外', rem([{ id: 'F0001', sessionDate: '', status: '参加中' }], {}, '2026-11-05').length === 0);
t('テストIDは対象外', rem([{ id: 'F9999', sessionDate: '2026-11-10', status: '' }], {}, '2026-11-05').length === 0);
t('1フォームのリマインドは最大2回', JSON.stringify(run('REMINDER_RULES')) === JSON.stringify({ T0: [-5, -3], T1: [1, 3], T2: [93, 97] }));
t('月をまたぐ日数計算(2026-11-30 → 2026-12-02 = 2日)', run('dayDiff_("2026-12-02","2026-11-30")') === 2);

// 10. 匿名での感想利用の同意(任意)
r = vm.runInContext('processSubmission_', ctx)('CT0', nv('CT0', { CONSENT: '同意します', CONSENT_AD: '同意します', RID: 'F0001' }), 't', 'sid20', ctxOk);
t('匿名感想の同意あり → Submissionsに TRUE', r.submission[13] === 'TRUE' && r.flags.length === 0);
r = vm.runInContext('processSubmission_', ctx)('CT0', nv('CT0', { CONSENT: '同意します', RID: 'F0001' }), 't', 'sid21', ctxOk);
t('匿名感想の同意なし → FALSE。研究参加の同意だけで送信でき、フラグなし', r.submission[13] === 'FALSE' && r.flags.length === 0);
r = vm.runInContext('processSubmission_', ctx)('CT1', nv('CT1', { RID: 'F0001' }), 't', 'sid22', ctxOk);
t('同意ページのないフォームでは空欄', r.submission[13] === '');
t('CT0・PT0に研究参加の同意(必須)と匿名感想の同意(任意)の2項目', ['CT0', 'PT0'].every(k => run(`questionsOf_("${k}").filter(q=>q.kind==="consent").map(q=>q.id+":"+!!q.required).join(",")`) === 'CONSENT:true,CONSENT_AD:false'));
console.log('\n' + pass + ' passed / ' + fail + ' failed');
process.exit(fail ? 1 : 0);

// 出力用: コードブックCSVを書き出す(--write 指定時)
