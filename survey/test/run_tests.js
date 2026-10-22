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
      const b = { requireTextMatchesPattern(p) { v.pattern = p; return b; }, requireNumberBetween(a, c) { v.range = [a, c]; return b; }, requireTextIsEmail() { v.email = true; return b; }, setHelpText() { return b; }, build() { return v; } };
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
  t(k + ' 進捗バーが有効(ページの題名に番号は付けない)', f.settings.progress === true && f.items.filter(i => i.type === 'PAGE').every(i => !/【\d+\/\d+】/.test(i.title)));
  t(k + ' 質問・ページの題名に、設問番号や区分の記号(D1.・A.)が付かない', f.items.every(i => !/^[A-Z][A-Za-z0-9_\-]*\.\s/.test(i.title)));
  // 質問の必須: RID/CONSENT以外は任意
  const badReq = f.items.filter(i => i.required && !/^(調査用ID|上の内容について)/.test(i.title) && i.type !== 'PAGE' && i.type !== 'HEADER').map(i => i.title);
  t(k + ' 同意・IDを除き、すべて任意回答(回答を強制しない)', badReq.length === 0, badReq.join(' | '));
  // ゲート
  const gates = run(`questionsOf_("${k}").filter(q=>q.gate).map(q=>q.id)`);
  for (const gid of gates) {
    const q = run(`questionsOf_("${k}").filter(q=>q.id==="${gid}")[0]`);
    const item = f.items.find(i => i.title === q.text);
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
      const hi = f.items.findIndex(i => i.title === hq.text);
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

// 10. 同意は申込フォームのみ
t('CT0・PT0に同意項目がない(同意は申込フォームのみ)', ['CT0', 'PT0'].every(k => run(`questionsOf_("${k}").filter(q=>q.kind==="consent").length`) === 0));
t('submissionsの列数が見出しと一致', run('HEAD.submissions.length') === 13 && vm.runInContext('processSubmission_', ctx)('CT0', nv('CT0', { RID: 'F0001' }), 't', 'x', ctxOk).submission.length === 13);

// 11. 申込フォーム
const ap = run('SURVEY.apply');
const apQs = ap.blocks.filter(b => b.type === 'q');
const consents = apQs.filter(q => q.kind === 'consent');
t('申込フォームの同意は「全てに同意しました」の1つのチェックだけで、必須', consents.length === 1 && consents[0].id === 'CONSENT_ALL' && consents[0].required && consents[0].choices[0] === '全てに同意しました');
const adultText = ap.intro + ap.blocks.filter(b => b.type === 'page' && !b.conditional).map(b => b.desc || '').join('\n') + consents.map(q => q.text).join('\n');
t('お子様向けの説明ページ(条件ページ・表示の選択)は、申込フォームにない(保護者の同意のみ)', !ap.blocks.some(b => b.conditional) && !apQs.some(q => q.id === 'AP_VIEW') && !/こたえたく ないときは/.test(adultText));
t('お子様向けの説明の文は、保護者向けの本文に混ざっていない', !/こたえたく ないときは|おとうさん・おかあさんとは、べつの/.test(adultText));
t('責任者が「林 竜輔」、連絡先が運営メール', /責任者:林 竜輔/.test(adultText) && /kagami\.3588@gmail\.com/.test(adultText));
t('鑑定のあとの回答は責任者の林 竜輔が確認する', /鑑定のあとのご回答は、責任者の林 竜輔が確認します/.test(adultText));
t('削除のお申し出の文', /ご回答の削除をご希望の場合は、下の連絡先まで、お申し出ください。お申し出があれば、削除します/.test(adultText));
t('途中でやめた場合の回答の活用・回答でみなし同意の文', /それまでにご回答いただいた分を、調査に活用させていただきます/.test(adultText) && /同意いただいたものとみなします/.test(adultText));
t('個人情報:責任を持ってお預かり、プロジェクト終了まで保管、鑑定の提供のため', /責任を持ってお預かりします/.test(adultText) && /このプロジェクトが終了するときまでを予定/.test(adultText) && /鑑定をご提供するため/.test(adultText));
t('回答は鑑定を行うまで確認しない', /鑑定を行うまで、確認しません/.test(adultText));
t('匿名にてアンケート結果を公開することへの同意(個人情報は公開しない)', /個人が特定されない匿名にてアンケート結果を公開することに同意いただけますか/.test(adultText) && /個人情報は、一切公開しません/.test(adultText));
t('同意の文面に費用・謝礼・補助金・データの利用範囲の記載がない', !/費用|謝礼|補助金|学会|論文|円/.test(adultText));
t('「回答したくない」「学年」が申込フォームに無い', !/回答したくない|学年/.test(adultText + apQs.map(q => q.text).join('')));
t('「保管期間は【要記入】」が残っていない', !/【要記入】/.test(adultText));
// 項目(ご依頼のとおり)
const byId = (id) => apQs.find(q => q.id === id);
t('保護者用の項目: 名前・性別・生年月日・メール・LINE検索ID・Instagram(任意)・公式LINE追加(チェック)・紹介者(カタカナ)・自由記入欄', ['AP1', 'AP6', 'AP7', 'AP2', 'AP8', 'AP9', 'AP10', 'AP11', 'AP5'].every(id => !!byId(id)) && byId('AP9').required === false && byId('AP10').kind === 'check' && byId('AP10').required === true && byId('AP11').kind === 'katakana');
t('保護者用の文言(フルネーム・生年月日の例20000218・LINE検索ID・公式LINE)', /名前\(フルネーム\)/.test(byId('AP1').text) && /20000218/.test(byId('AP7').text) && byId('AP8').text === 'LINE検索ID' && /林 竜輔の公式LINEを追加しましたか/.test(byId('AP10').text) && /Instagram/.test(byId('AP9').text) && /任意/.test(byId('AP9').text));
t('お子様用の項目: 名前・性別・生年月日・メール・自由記入欄', ['CH1', 'CH2', 'CH3', 'CH4', 'CH6'].every(id => !!byId(id)) && /20100315/.test(byId('CH3').text));
t('性別は個人情報の入力欄(保護者・お子様)にある', byId('AP6').text === '保護者さまの性別' && byId('CH2').text === 'お子様の性別' && JSON.stringify(byId('AP6').choices) === JSON.stringify(['男性', '女性']));
t('追加の鑑定: 名前(任意)・レポートのみ5,000円/オンライン鑑定希望10,000円(任意)', byId('EX1').required === false && byId('EX2').required === false && JSON.stringify(byId('EX2').choices) === JSON.stringify(['レポートのみ 5,000円', 'オンライン鑑定希望 10,000円']));
const order = apQs.map(q => q.id);
t('入力欄の順序: 説明書と同意(最初)→保護者用→お子様用→追加の鑑定', order.indexOf('CONSENT_ALL') < order.indexOf('AP1') && order.indexOf('AP1') < order.indexOf('CH1') && order.indexOf('CH1') < order.indexOf('EX1') && ap.blocks[0].type === 'page' && ap.blocks[0].title === '説明書と同意の確認' && ap.blocks[1].id === 'CONSENT_ALL');
t('セクション見出しが「保護者用」「お子様用」', ap.blocks.some(b => b.type === 'page' && b.title === '保護者用') && ap.blocks.some(b => b.type === 'page' && b.title === 'お子様用'));
t('同意書・説明書のリンク用の設定(CONSENT_DOC_URL)がある。空欄ならリンクを表示しない', run('typeof CONSENT_DOC_URL') === 'string' && !/https?:\/\//.test(ap.blocks.find(b => b.title === '説明書と同意の確認').desc));

const qt = (def, ...ids) => ids.map(id => run(`applyTitleParts_(SURVEY.${def}.blocks.find(b => b.id === '${id}')).title`));
const isQ = (def, re) => (i) => run(`SURVEY.${def}.blocks.filter(b => b.type === 'q' && /${re}/.test(b.id)).map(b => applyTitleParts_(b).title)`).indexOf(i.title) !== -1;
{ // 申込フォームの構築(モック)。申込フォームの題名には設問番号を付けない
  ctx.__ss = { getId: () => 'reg' };
  vm.runInContext('buildFormFromDef_(SURVEY.apply, __ss, SURVEY.apply.confirm)', ctx);
  const f = created[created.length - 1];
  t('申込フォーム構築', f.items.length > 10);
  const emailItems = f.items.filter(isQ('apply', '^(AP[23]|CH[45])$'));
  t('メールアドレス欄(保護者2・お子様2)にメール形式の検証', emailItems.length === 4 && emailItems.every(i => i.validation && i.validation.email));
  const bd = f.items.filter(isQ('apply', '^(AP7|CH3)$'));
  t('生年月日欄は8桁の数字の検証', bd.length === 2 && bd.every(i => i.validation && i.validation.pattern === '^[0-9]{8}$'));
  const kt = f.items.find(isQ('apply', '^AP11$'));
  t('紹介者欄はカタカナの検証(\\u の表記は使わず、文字そのもので書く)', !!kt && !!kt.validation && /ァ-ヺ/.test(kt.validation.pattern) && !/\\u/.test(kt.validation.pattern));
  t('同意のチェックは1つで必須', f.items.filter(isQ('apply', '^CONSENT')).length === 1 && f.items.filter(isQ('apply', '^CONSENT')).every(i => i.required));
  const line = f.items.find(isQ('apply', '^AP10$'));
  t('公式LINEの追加確認は必須のチェックボックス', line.type === 'CHECK' && line.required && line.choices[0].value === '追加しました');
  const insta = f.items.find(isQ('apply', '^AP9$'));
  t('Instagramは任意', insta.required === false);
  const ex = f.items.filter(isQ('apply', '^EX[12]$'));
  t('追加の鑑定は任意', ex.length === 2 && ex.every(i => !i.required));
  const nameReq = f.items.filter(isQ('apply', '^(AP1|AP6|AP8|AP11|CH1|CH2)$'));
  t('保護者名・性別・LINE ID・紹介者・お子様名・お子様の性別は必須', nameReq.length === 6 && nameReq.every(i => i.required));
}

// 12. 申込の処理
const NVA = (o) => { const base = { AP1: '山田 花子', AP6: '女性', AP7: '19850612', AP2: 'hanako@example.com', AP3: 'hanako@example.com', AP8: 'hanako_line', AP9: '', AP10: '追加しました', AP11: 'ナシ', AP5: '', CH1: '山田 太郎', CH2: '男性', CH3: '20100315', CH4: 'taro@example.com', CH5: 'taro@example.com', CH6: '', EX1: '', EX2: '', AP_VIEW: '', CONSENT: '同意します', CONSENT_CHILD: '同意します', CONSENT_ALL: '全てに同意しました', CONSENT_ANON: '同意します' }; const m = Object.assign(base, o); const out = {}; ap.blocks.filter(b => b.type === 'q').forEach(q => { out[q.id + '. ' + q.text] = [m[q.id] === undefined ? '' : m[q.id]]; }); return out; };
const pa = vm.runInContext('processApplication_', ctx);
let pr = pa(NVA({}), [], '2026-11-01T10:00:00');
t('申込OK → F0001を発行し、名簿の行(33列)を作る', pr.ok && pr.id === 'F0001' && pr.row.length === 33 && pr.row[0] === 'F0001' && pr.row[15] === '参加中' && pr.row[run('RC.category')] === 'career');
t('名簿の列の位置(RC)と行の内容が一致', pr.row[run('RC.pname')] === '山田 花子' && pr.row[run('RC.pgender')] === '女性' && pr.row[run('RC.pbirth')] === '19850612' && pr.row[run('RC.pemail')] === 'hanako@example.com' && pr.row[run('RC.line')] === 'hanako_line' && pr.row[run('RC.officialLine')] === '追加しました' && pr.row[run('RC.referrer')] === 'ナシ' && pr.row[run('RC.cname')] === '山田 太郎' && pr.row[run('RC.cgender')] === '男性' && pr.row[run('RC.cbirth')] === '20100315' && pr.row[run('RC.cemail')] === 'taro@example.com' && pr.row[run('RC.session')] === '' && pr.row[run('RC.status')] === '参加中');
t('名簿の見出し数 = 行の列数', run('HEAD.roster.length') === 33 && run('RC.memo') === 23 && run('RC.request') === 31 && run('RC.plan') === 32);
pr = pa(NVA({ EX1: '山田 次郎', EX2: 'レポートのみ 5,000円' }), [], 't');
t('追加の鑑定の名前と希望が名簿に入る', pr.ok && pr.row[run('RC.exName')] === '山田 次郎' && pr.row[run('RC.exPlan')] === 'レポートのみ 5,000円');
pr = pa(NVA({ EX2: 'オンライン鑑定希望 10,000円' }), [], 't');
t('追加の鑑定の希望だけで名前が空 → 要確認', !pr.ok && /対象者名が未入力/.test(pr.reason));
pr = pa(NVA({}), [{ id: 'F0001', email: 'x@example.com', childName: 'a' }, { id: 'F0007', email: 'y@example.com', childName: 'b' }, { id: 'F9999', email: 't@example.com', childName: 't' }], 't');
t('次のIDは最大値+1(F0008)。テストID(F9999)は数えない', pr.ok && pr.id === 'F0008');
pr = pa(NVA({ AP3: 'hanako@exampl.com' }), [], 't');
t('保護者メールが確認欄と不一致 → IDを発行せず要確認', !pr.ok && /保護者のメールアドレスが確認欄と一致しない/.test(pr.reason) && pr.pendingRow.length === 7 && pr.pendingRow[1] === '進路相談用');
pr = pa(NVA({ CH5: 'tar@example.com' }), [], 't');
t('お子様メールが確認欄と不一致 → 要確認', !pr.ok && /お子様のメールアドレスが確認欄と一致しない/.test(pr.reason));
pr = pa(NVA({ AP2: 'abc', AP3: 'abc' }), [], 't');
t('メール形式不正 → 要確認', !pr.ok && /形式が不正/.test(pr.reason));
pr = pa(NVA({ AP7: '2000-02-18' }), [], 't');
t('生年月日が8桁の数字ではない → 要確認', !pr.ok && /保護者の生年月日が不正/.test(pr.reason));
pr = pa(NVA({ AP7: '20000230' }), [], 't');
t('存在しない日付(2月30日)→ 要確認', !pr.ok);
pr = pa(NVA({ CH3: '20991231' }), [], 't');
t('未来の生年月日 → 要確認', !pr.ok && /お子様の生年月日が不正/.test(pr.reason));
pr = pa(NVA({ AP7: '20000218' }), [], 't');
t('生年月日 20000218(依頼の例)→ OK', pr.ok);
pr = pa(NVA({ AP11: 'yamada' }), [], 't');
t('紹介者がカタカナ以外 → 要確認', !pr.ok && /カタカナ/.test(pr.reason));
pr = pa(NVA({ AP11: 'ヤマダ　タロウ' }), [], 't');
t('紹介者がカタカナ(全角スペース可)→ OK', pr.ok);
pr = pa(NVA({ AP10: '' }), [], 't');
t('公式LINEの追加が未確認 → 要確認', !pr.ok && /公式LINE/.test(pr.reason));
pr = pa(NVA({ AP6: '' }), [], 't');
t('性別が未選択 → 要確認', !pr.ok && /保護者の性別/.test(pr.reason));
pr = pa(NVA({ CONSENT_ALL: '' }), [], 't');
t('必須の同意が欠けている → 要確認', !pr.ok && /同意未確認/.test(pr.reason));
pr = pa(NVA({}), [{ id: 'F0001', email: 'HANAKO@example.com ', childName: '山田　太郎 ' }], 't');
t('同じ保護者メールとお子様名(大文字小文字・空白を無視)→ 重複申込', !pr.ok && /重複申込/.test(pr.reason));
pr = pa(NVA({ CH1: '山田 花子', CH4: 'hana@example.com', CH5: 'hana@example.com' }), [{ id: 'F0001', email: 'hanako@example.com', childName: '山田 太郎' }], 't');
t('同じ保護者メールでも、お子様が別人(兄弟姉妹)なら別の家庭として登録', pr.ok && pr.id === 'F0002');
pr = pa(NVA({ AP1: '' }), [], 't');
t('保護者名が空 → 要確認', !pr.ok);
t('nextId_: 空なら F0001', run('nextId_([])') === 'F0001');

// 13. リンク送信の対象
const lr = vm.runInContext('linksDue_', ctx);
const base = (o) => Object.assign({ row: 2, id: 'F0001', email: 'a@example.com', childEmail: 'c@example.com', status: '参加中', sessionDate: '2026-11-10', sent: { T0: '', T1: '', T2: '' } }, o);
t('T0: 鑑定日が入力済み・未送信 → 対象', lr([base({})], 'T0', '2026-11-01').length === 1);
t('T0: 鑑定日が未入力 → 対象外', lr([base({ sessionDate: '' })], 'T0', '2026-11-01').length === 0);
t('T0: 送信済み → 対象外(二重送信しない)', lr([base({ sent: { T0: '2026-11-02T10:00:00' } })], 'T0', '2026-11-03').length === 0);
t('T1: 鑑定日の前 → 対象外、当日以降 → 対象', lr([base({})], 'T1', '2026-11-09').length === 0 && lr([base({})], 'T1', '2026-11-10').length === 1);
t('T2: 鑑定の89日後 → 対象外、90日後 → 対象', lr([base({})], 'T2', '2027-02-07').length === 0 && lr([base({})], 'T2', '2027-02-08').length === 1);
t('辞退・削除済みの家庭は対象外', lr([base({ status: '辞退' })], 'T0', '2026-11-01').length === 0 && lr([base({ status: '削除済み' })], 'T0', '2026-11-01').length === 0);
t('保護者またはお子様のメールが無い・不正 → 対象外', lr([base({ email: '' })], 'T0', '2026-11-01').length === 0 && lr([base({ childEmail: '' })], 'T0', '2026-11-01').length === 0 && lr([base({ email: 'abc' })], 'T0', '2026-11-01').length === 0);
t('テストIDは対象外', lr([base({ id: 'F9999' })], 'T0', '2026-11-01').length === 0);
t('選択した家庭は、日付の条件なしで対象(未送信・参加中・メールありのみ)', lr([base({ sessionDate: '' }), base({ row: 3, id: 'F0002' })], 'T0', '2026-11-01', { 2: true }).length === 1);
const em = vm.runInContext('buildLinkEmails_', ctx)('T0', { name: '山田 花子', childName: '山田 太郎', sessionDate: '2026-11-10' }, { child: 'https://forms.example/c', parent: 'https://forms.example/p' });
t('保護者宛: 保護者用リンクのみ(お子様用リンクを含まない)、お子様の回答を見ないお願い', /山田 花子 様/.test(em.parent.body) && /forms\.example\/p/.test(em.parent.body) && !/forms\.example\/c/.test(em.parent.body) && /見たり、聞き出したりしないでください/.test(em.parent.body) && /2026-11-10/.test(em.parent.body));
t('お子様宛: お子様用リンクのみ(保護者用リンクを含まない)、別の場所で、ひとりで答える案内', /山田 太郎 さん/.test(em.child.body) && /forms\.example\/c/.test(em.child.body) && !/forms\.example\/p/.test(em.child.body) && /別の場所/.test(em.child.body) && /ひとりで/.test(em.child.body));
t('リンクメールに費用・謝礼の記載がない', !/費用|謝礼|円/.test(em.parent.body + em.child.body));
const rcC = vm.runInContext('buildReceiptEmail_', ctx)('CT1', { name: '山田 花子', childName: '山田 太郎' });
const rcP = vm.runInContext('buildReceiptEmail_', ctx)('PT1', { name: '山田 花子', childName: '山田 太郎' });
t('受付確認メール: お子様用はお子様宛の文面、保護者用は保護者宛の文面。回答内容を含まない', /山田 太郎 さん/.test(rcC.body) && /山田 花子 様/.test(rcP.body) && /内容は、このメールには書いていません/.test(rcC.body) && /内容は、このメールには記載していません/.test(rcP.body) && !/D\d/.test(rcC.body + rcP.body));
const ar = vm.runInContext('buildApplyReceiptEmail_', ctx)({ name: '山田 花子', childName: '山田 太郎' });
t('申込の受付確認メール: 日程調整は改めて連絡する旨', /日程の調整は、運営から改めてご連絡します/.test(ar.body));
// 削除
const dr = vm.runInContext('dropRowsById_', ctx)([['h', '調査用ID'], ['a', 'F0001'], ['b', 'F0002'], ['c', 'F0001']], 1, 'F0001');
t('指定IDの行だけを削除(見出しと他の家庭は残す)', dr.removed === 2 && dr.kept.length === 2 && dr.kept[1][1] === 'F0002');


// 14. 申込を確認するサイト(ダッシュボード)
const na = vm.runInContext('nextAction_', ctx);
const F = (o) => Object.assign({ id: 'F0001', status: '参加中', sessionDate: '', sent: { T0: '', T1: '', T2: '' } }, o);
t('次にやること: 鑑定日が未入力', na(F({}), {}, '2026-11-01') === '日程調整 → 鑑定日を入力');
t('次にやること: T0を送る', na(F({ sessionDate: '2026-11-10' }), {}, '2026-11-01') === 'T0のリンクを送る');
t('次にやること: T0の回答待ち(片方だけ回答)', na(F({ sessionDate: '2026-11-10', sent: { T0: 'x' } }), { CT0: 'x' }, '2026-11-01') === 'T0の回答待ち');
t('次にやること: 鑑定待ち', /鑑定待ち\(9日後\)/.test(na(F({ sessionDate: '2026-11-10', sent: { T0: 'x' } }), { CT0: 'x', PT0: 'x' }, '2026-11-01')));
t('次にやること: 鑑定日以降はT1を送る', na(F({ sessionDate: '2026-11-10', sent: { T0: 'x' } }), { CT0: 'x', PT0: 'x' }, '2026-11-10') === 'T1のリンクを送る');
t('次にやること: T1の回答待ち', na(F({ sessionDate: '2026-11-10', sent: { T0: 'x', T1: 'x' } }), { CT0: 'x', PT0: 'x' }, '2026-11-11') === 'T1の回答待ち');
t('次にやること: T2待ち(あと日数)', /T2待ち\(あと\d+日\)/.test(na(F({ sessionDate: '2026-11-10', sent: { T0: 'x', T1: 'x' } }), { CT0: 'x', PT0: 'x', CT1: 'x', PT1: 'x' }, '2026-12-10')));
t('次にやること: 90日後にT2を送る', na(F({ sessionDate: '2026-11-10', sent: { T0: 'x', T1: 'x' } }), { CT0: 'x', PT0: 'x', CT1: 'x', PT1: 'x' }, '2027-02-08') === 'T2のリンクを送る');
t('次にやること: 完了', na(F({ sessionDate: '2026-11-10', sent: { T0: 'x', T1: 'x', T2: 'x' } }), { CT0: 'x', PT0: 'x', CT1: 'x', PT1: 'x', CT2: 'x', PT2: 'x' }, '2027-02-20') === '完了');
t('次にやること: 辞退・削除済みは対象外の表示', na(F({ status: '辞退' }), {}, 'x') === '(辞退)' && na(F({ status: '削除済み' }), {}, 'x') === '(削除済み)');

const rosterD = [
  { row: 2, id: 'F0001', appliedAt: '2026-11-01T10:00:00', name: '山田 花子', pGender: '女性', pBirth: '19850612', email: 'h@example.com', line: 'hana', insta: '', officialLine: '追加しました', referrer: 'ナシ', childName: '山田 太郎', cGender: '男性', cBirth: '20100315', childEmail: 't@example.com', sessionDate: '2026-11-10', status: '参加中', sent: { T0: '2026-11-02T09:00:00', T1: '', T2: '' }, exName: '', exPlan: '', pNote: '', cNote: '', memo: '' },
  { row: 3, id: 'F0002', appliedAt: '2026-11-05T10:00:00', name: '</script><b>x', pGender: '男性', pBirth: '19900101', email: 'x@example.com', line: 'x', insta: '', officialLine: '追加しました', referrer: 'ナシ', childName: 'b', cGender: '女性', cBirth: '20120101', childEmail: 'y@example.com', sessionDate: '', status: '', sent: { T0: '', T1: '', T2: '' }, exName: '山田 次郎', exPlan: 'レポートのみ 5,000円', pNote: '', cNote: '', memo: '' },
  { row: 4, id: 'F0003', appliedAt: '2026-11-06T10:00:00', name: 'c', pGender: '女性', pBirth: '19900101', email: 'c@example.com', line: 'c', insta: '', officialLine: '追加しました', referrer: 'ナシ', childName: 'c', cGender: '女性', cBirth: '20120101', childEmail: 'c2@example.com', sessionDate: '', status: '辞退', sent: { T0: '', T1: '', T2: '' }, exName: '', exPlan: '', pNote: '', cNote: '', memo: '' }
];
const subsD = [
  ['s1', '2026-11-03T10:00:00', 'F0001', '子ども', 'CT0', 'T0', 'TRUE', '', 1, 0, 0, 0, 'FALSE'],
  ['s2', '2026-11-03T11:00:00', 'F0001', '保護者', 'PT0', 'T0', 'TRUE', '', 1, 0, 0, 0, 'FALSE'],
  ['s3', '2026-11-03T12:00:00', 'F0001', '保護者', 'PT0', 'T0', 'FALSE', '重複送信', 1, 0, 0, 0, 'FALSE'],
  ['s4', 't', 'F9999', '子ども', 'CT0', 'T0', 'TRUE', '', 1, 0, 0, 0, 'TRUE']
];
const safD = [['2026-11-20T10:00:00', 'F0001', 'CT2', 'F8', 'a', '送信済み', '2026-11-21 10:00', '未対応', '', '', ''], ['2026-11-20T10:00:00', 'F0002', 'CT2', 'F7', 'a', '送信済み', 'd', '対応済', '', '', '']];
const dd = vm.runInContext('buildDashboardData_', ctx)(rosterD, [['2026-11-02T10:00:00', '進路相談用', 'z', 'z@example.com', 'q', 'メールが確認欄と一致しない', '']], subsD, safD, '2026-11-10');
t('ダッシュボード: 家庭数・参加中・辞退の集計', dd.summary.total === 3 && dd.summary.active === 2 && dd.summary.withdrawn === 1);
t('ダッシュボード: 要確認の申込・鑑定日未入力・未対応の安全確認・追加鑑定の希望', dd.summary.pending === 1 && dd.summary.noSession === 1 && dd.summary.safetyOpen === 1 && dd.summary.extraRequests === 1);
t('ダッシュボード: T0の回答済みは、子ども・保護者の両方が分析採用で回答した家庭のみ(重複・テストを数えない)', dd.summary.responded.T0 === 1 && dd.families.find(f => f.id === 'F0001').resp.CT0 && dd.families.find(f => f.id === 'F0001').resp.PT0);
t('ダッシュボード: 送れる家庭の数(T1=鑑定日10日・当日)', dd.summary.toSend.T1 === 1 && dd.summary.toSend.T0 === 0);
t('ダッシュボード: 申込日の新しい順', dd.families[0].id === 'F0003');
t('ダッシュボード: 状況が空欄なら「参加中」', dd.families.find(f => f.id === 'F0002').status === '参加中');
t('閲覧者の確認: 本人のみ許可、空(匿名)は不許可、許可リストは許可', run('isAllowedViewer_("a@x.com","A@x.com",[])') && !run('isAllowedViewer_("","a@x.com",[])') && !run('isAllowedViewer_("b@x.com","a@x.com",[])') && run('isAllowedViewer_("b@x.com","a@x.com",["B@x.com"])'));
const page = vm.runInContext('dashboardPage_', ctx)(dd);
t('ページに</script>を含む名前があっても、scriptタグが壊れない(エスケープ)', (page.match(/<\/script>/g) || []).length === 1 && page.indexOf('\\u003c/script\\u003e') !== -1);
const scriptSrc = page.slice(page.indexOf('<script>') + 8, page.lastIndexOf('</script>'));
let scriptOk = true; try { new vm.Script(scriptSrc); } catch (e) { scriptOk = false; console.log(e.message); }
t('ページのJavaScriptが構文エラーなし', scriptOk);
{ // 簡易DOMで描画を実行
  const mk = (tag) => { const e = { tag, children: [], style: {}, _text: '', className: '', appendChild(c) { this.children.push(c); return c; }, set innerHTML(v) { this.children = []; this._text = ''; }, get innerHTML() { return ''; }, set textContent(v) { this._text = String(v); }, get textContent() { return this._text; }, set colSpan(v) {}, value: '' }; return e; };
  const ids = {}; const doc = { createElement: mk, createTextNode: (x) => { const e = mk('#text'); e._text = x; return e; }, getElementById: (id) => ids[id] || (ids[id] = mk(id)) };
  ids.q = mk('q'); ids.st = mk('st');
  const win = vm.createContext({ document: doc });
  let err = null; try { vm.runInContext(scriptSrc, win); } catch (e) { err = e; }
  const all = (n) => [n._text].concat(...n.children.map(all)).join('|');
  const view = all(ids.view);
  t('ダッシュボード描画: エラーなく描画され、家庭の行・次にやること・進捗が出る', !err && /F0001/.test(view) && /山田 花子 \/ 山田 太郎/.test(view) && /T1のリンクを送る/.test(view) && /T0/.test(view), err && err.message);
  t('ダッシュボード描画: 注入された文字列はテキストとして扱われる(要素にならない)', /<\/script><b>x/.test(view));
  t('ダッシュボード描画: サマリーのカード', /進路相談用\(参加中\)/.test(all(ids.cards)) && /一般鑑定者用\(参加中\)/.test(all(ids.cards)) && /法人鑑定者用\(参加中\)/.test(all(ids.cards)) && /要確認の申込/.test(all(ids.cards)));
}


// 15. 一般鑑定者用・法人鑑定者用の申込フォーム
const apG = run('SURVEY.applyG'), apB = run('SURVEY.applyB');
const qG = apG.blocks.filter(b => b.type === 'q'), qB = apB.blocks.filter(b => b.type === 'q');
const textOf = (d) => d.intro + d.blocks.map(b => (b.desc || '') + (b.text || '')).join('\n');
t('3つの申込フォーム(進路相談用・一般鑑定者用・法人鑑定者用)と区分ラベル', run('SURVEY.applyFormKeys.join()') === 'APPLY,APPLY_G,APPLY_B' && run('CATEGORY_LABEL.career') === '進路相談用' && run('CATEGORY_LABEL.general') === '一般鑑定者用' && run('CATEGORY_LABEL.corp') === '法人鑑定者用');
t('一般・法人の申込フォームに、調査アンケート・調査参加の同意・お子様の項目がない', [apG, apB].every(d => !/調査|アンケート|お子様|お子さま|匿名の/.test(textOf(d))) && !qG.concat(qB).some(q => /^(CONSENT$|CONSENT_CHILD|CONSENT_ANON|CH\d|AP_VIEW)/.test(q.id)));
t('一般・法人の同意は、個人情報の利用(必須)', qG.filter(q => q.kind === 'consent').map(q => q.id).join() === 'CONSENT_ALL' && qB.filter(q => q.kind === 'consent').map(q => q.id).join() === 'CONSENT_ALL' && qG.concat(qB).filter(q => q.kind === 'consent').every(q => q.required));
t('一般・法人の個人情報の説明(責任を持って・鑑定のご提供・プロジェクト終了まで・削除の申し出・責任者)', [apG, apB].every(d => { const x = textOf(d); return /責任を持ってお預かりします/.test(x) && /鑑定をご提供するため/.test(x) && /このプロジェクトが終了するときまで/.test(x) && /お申し出があれば、削除します/.test(x) && /責任者:林 竜輔/.test(x); }));
t('一般の項目: 名前・性別・生年月日・メール・LINE検索ID・Instagram(任意)・公式LINE・紹介者(カタカナ)・自由記入欄', ['GE1', 'GE2', 'GE3', 'GE4', 'GE5', 'GE6', 'GE7', 'GE8', 'GE9', 'GE11'].every(id => qG.some(q => q.id === id)) && qG.find(q => q.id === 'GE7').required === false && qG.find(q => q.id === 'GE9').kind === 'katakana');
t('法人の項目: 法人名・部署・担当者・メール・電話・LINE・公式LINE・紹介者・人数・対象者・請求書宛名・自由記入欄', ['CO1', 'CO2', 'CO3', 'CO4', 'CO6', 'CO7', 'CO8', 'CO9', 'CO10', 'CO11', 'CO13', 'CO14'].every(id => qB.some(q => q.id === id)) && qB.find(q => q.id === 'CO2').required === false && qB.find(q => q.id === 'CO13').required === false);
t('一般・法人の説明文(同意の文面)に費用・謝礼・補助金の記載がない(鑑定料は、プランの選択肢とお振込先の案内にのみ表示)', ![apG, apB].some(d => /費用|謝礼|補助金|円/.test(d.intro + d.blocks.filter(b => b.type === 'page').map(b => b.desc || '').join('\n'))));
{
  ctx.__ss = { getId: () => 'reg' };
  for (const k of ['applyG', 'applyB']) {
    vm.runInContext(`buildFormFromDef_(SURVEY.${k}, __ss, SURVEY.${k}.confirm)`, ctx);
    const f = created[created.length - 1];
    t(k + ' フォーム構築・同意が必須のチェックボックス', f.items.length > 10 && f.items.filter(isQ(k, '^CONSENT')).every(i => i.required && i.type === 'CHECK'));
    t(k + ' メール欄にメール形式の検証・生年月日/カタカナ/電話/人数の検証', f.items.filter(i => i.validation && i.validation.email).length === 2 && f.items.filter(i => i.validation).length >= 4);
  }
  const fb = created[created.length - 1];
  const tg = fb.items.find(isQ('applyB', '^CO11$')), hc = fb.items.find(isQ('applyB', '^CO10$')), ph = fb.items.find(isQ('applyB', '^CO6$'));
  t('法人: 鑑定を受ける方の欄は必須の段落、プランは選択式、電話は数字とハイフン', tg.type === 'PARA' && tg.required && hc.type === 'MC' && ph.validation.pattern === '^[0-9\\-]{9,13}$');
}
const NVG = (o) => { const base = { GE1: '佐藤 一郎', GE2: '男性', GE3: '19800101', GE4: 'ichiro@example.com', GE5: 'ichiro@example.com', GE6: 'ichiro_line', GE7: '', GE8: '追加しました', GE9: 'ナシ', GE10: '', GE11: '', CONSENT_ALL: '全てに同意しました' }; const m = Object.assign(base, o); const out = {}; apG.blocks.filter(b => b.type === 'q').forEach(q => { out[q.id + '. ' + q.text] = [m[q.id] === undefined ? '' : m[q.id]]; }); return out; };
const NVB = (o) => { const base = { CO1: '株式会社サンプル', CO2: '総務部', CO3: '鈴木 花子', CO4: 'suzuki@sample.co.jp', CO5: 'suzuki@sample.co.jp', CO6: '03-1234-5678', CO7: 'suzuki_line', CO8: '追加しました', CO9: 'ナシ', CO10: '2名追加', CO11: '山田 太郎/男性/19850612\n田中 次郎/男性/19900101\n佐藤 三郎/男性/19800101', CO12: '', CO13: '株式会社サンプル 御中', CO14: '', CONSENT_ALL: '全てに同意しました' }; const m = Object.assign(base, o); const out = {}; apB.blocks.filter(b => b.type === 'q').forEach(q => { out[q.id + '. ' + q.text] = [m[q.id] === undefined ? '' : m[q.id]]; }); return out; };
let pg = pa(NVG({}), [], '2026-11-01T10:00:00', 'general');
t('一般の申込OK → G0001を発行し、区分=general、名簿の列に入る', pg.ok && pg.id === 'G0001' && pg.row.length === 33 && pg.row[run('RC.category')] === 'general' && pg.row[run('RC.pname')] === '佐藤 一郎' && pg.row[run('RC.pbirth')] === '19800101' && pg.row[run('RC.line')] === 'ichiro_line' && pg.row[run('RC.cname')] === '');
pg = pa(NVG({}), [{ id: 'F0005', category: 'career', email: 'a@example.com' }, { id: 'G0003', category: 'general', email: 'z@example.com', name: 'z' }], 't', 'general');
t('一般のIDは、進路(F)と別の連番(G0004)', pg.ok && pg.id === 'G0004');
pg = pa(NVG({ GE5: 'x@example.com' }), [], 't', 'general');
t('一般: メール不一致 → 要確認(7列)', !pg.ok && pg.pendingRow.length === 7 && pg.pendingRow[1] === '一般鑑定者用');
pg = pa(NVG({ CONSENT_ALL: '' }), [], 't', 'general');
t('一般: 個人情報の同意がない → 要確認', !pg.ok && /同意未確認/.test(pg.reason));
pg = pa(NVG({ GE9: 'sato' }), [], 't', 'general');
t('一般: 紹介者がカタカナ以外 → 要確認', !pg.ok);
pg = pa(NVG({}), [{ id: 'G0001', category: 'general', email: 'ICHIRO@example.com', name: '佐藤　一郎' }], 't', 'general');
t('一般: 同じメールと名前 → 重複申込', !pg.ok && /重複申込/.test(pg.reason));
pg = pa(NVG({}), [{ id: 'F0001', category: 'career', email: 'ichiro@example.com', childName: '佐藤 一郎' }], 't', 'general');
t('一般: 進路相談の登録と同じメールでも、重複扱いにしない', pg.ok);
let pb = pa(NVB({}), [], '2026-11-01T10:00:00', 'corp');
t('法人の申込OK → B0001、会社名・担当者・電話・人数・対象者・請求書宛名が名簿に入る', pb.ok && pb.id === 'B0001' && pb.row[run('RC.category')] === 'corp' && pb.row[run('RC.company')] === '株式会社サンプル' && pb.row[run('RC.pname')] === '鈴木 花子' && pb.row[run('RC.phone')] === '03-1234-5678' && pb.row[run('RC.headcount')] === '3' && pb.row[run('RC.plan')] === '代表+追加2名 100,000円' && /山田 太郎/.test(pb.row[run('RC.targets')]) && pb.row[run('RC.invoice')] === '株式会社サンプル 御中' && pb.row[run('RC.memo')] === '');
pb = pa(NVB({ CO10: '追加なし(代表のみ)' }), [], 't', 'corp');
t('法人: プランの人数と記入行数が違っても受け付け、メモで知らせる', pb.ok && /人数\(1\)と、記入された行数\(3\)が一致しません/.test(pb.row[run('RC.memo')]));
pb = pa(NVB({ CO10: '' }), [], 't', 'corp');
t('法人: プラン未選択 → 要確認', !pb.ok && /追加人数が未選択/.test(pb.reason));
pb = pa(NVB({ CO6: 'abc' }), [], 't', 'corp');
t('法人: 電話番号が不正 → 要確認', !pb.ok && /電話番号/.test(pb.reason));
pb = pa(NVB({ CONSENT_ALL: '' }), [], 't', 'corp');
t('法人: 同意のチェックがない → 要確認', !pb.ok && /同意未確認/.test(pb.reason));
pb = pa(NVB({ CO1: '' }), [], 't', 'corp');
t('法人: 法人名が空 → 要確認(5列目に法人名)', !pb.ok && pb.pendingRow[1] === '法人鑑定者用');
pb = pa(NVB({}), [{ id: 'B0001', category: 'corp', email: 'SUZUKI@sample.co.jp', company: '株式会社 サンプル' }], 't', 'corp');
t('法人: 同じメールと法人名 → 重複申込', !pb.ok && /重複申込/.test(pb.reason));
pb = pa(NVB({}), [{ id: 'B0001', category: 'corp', email: 'suzuki@sample.co.jp', company: '別の会社' }], 't', 'corp');
t('法人: 同じメールでも別の法人 → 別の申込として登録(B0002)', pb.ok && pb.id === 'B0002');

// 16. 区分の扱い(リンク送信・次にやること・ダッシュボード)
t('リンク送信の対象は進路相談用だけ(一般・法人は対象外)', lr([base({ category: 'general' })], 'T0', '2026-11-01').length === 0 && lr([base({ category: 'corp' })], 'T0', '2026-11-01').length === 0 && lr([base({ category: 'career' })], 'T0', '2026-11-01').length === 1 && lr([base({})], 'T0', '2026-11-01').length === 1);
t('次にやること(一般・法人): 鑑定日の入力 → 鑑定待ち → 鑑定日を過ぎた', na(F({ category: 'general' }), {}, '2026-11-01') === '日程調整 → 鑑定日を入力' && /鑑定待ち\(9日後\)/.test(na(F({ category: 'corp', sessionDate: '2026-11-10' }), {}, '2026-11-01')) && /鑑定日を過ぎました/.test(na(F({ category: 'general', sessionDate: '2026-11-10' }), {}, '2026-11-11')));
t('受付確認メール(一般・法人・進路)の文面', /佐藤 一郎 様/.test(vm.runInContext('buildApplyReceiptEmail_', ctx)({ name: '佐藤 一郎' }, 'general').body) && /法人名:株式会社サンプル/.test(vm.runInContext('buildApplyReceiptEmail_', ctx)({ name: '鈴木 花子', company: '株式会社サンプル' }, 'corp').body) && /お子様:太郎 さん/.test(vm.runInContext('buildApplyReceiptEmail_', ctx)({ name: '山田', childName: '太郎' }, 'career').body));
const rosterC = rosterD.concat([
  Object.assign({}, rosterD[0], { row: 5, id: 'G0001', category: 'general', name: '佐藤 一郎', childName: '', childEmail: '', sessionDate: '2026-11-20', sent: { T0: '', T1: '', T2: '' } }),
  Object.assign({}, rosterD[0], { row: 6, id: 'B0001', category: 'corp', name: '鈴木 花子', company: '株式会社サンプル', headcount: '2', targets: '山田 太郎/男性/19850612', childName: '', childEmail: '', sessionDate: '', sent: { T0: '', T1: '', T2: '' } })
]);
const dc = vm.runInContext('buildDashboardData_', ctx)(rosterC, [], subsD, safD, '2026-11-10');
t('ダッシュボード: 区分ごとの集計(進路3・一般1・法人1、うち辞退1)', dc.summary.by.career.total === 3 && dc.summary.by.career.active === 2 && dc.summary.by.general.total === 1 && dc.summary.by.corp.total === 1 && dc.summary.by.corp.noSession === 1);
t('ダッシュボード: T0〜T2の送信対象・回答済みは、進路相談用だけ', dc.summary.toSend.T0 === 0 && dc.summary.toSend.T1 === 1 && dc.summary.careerActive === 2 && dc.summary.responded.T0 === 1);
t('ダッシュボード: 各家庭に区分が入る(空欄は進路相談用)', dc.families.find(f => f.id === 'G0001').category === 'general' && dc.families.find(f => f.id === 'F0002').category === 'career');
{ // 区分のタブの描画
  const mk = (tag) => { const e = { tag, children: [], style: {}, _text: '', className: '', appendChild(c) { this.children.push(c); return c; }, set innerHTML(v) { this.children = []; this._text = ''; }, get innerHTML() { return ''; }, set textContent(v) { this._text = String(v); }, get textContent() { return this._text; }, set colSpan(v) {}, value: '' }; return e; };
  const ids = {}; const doc = { createElement: mk, createTextNode: (x) => { const e = mk('#text'); e._text = x; return e; }, getElementById: (id) => ids[id] || (ids[id] = mk(id)) };
  ids.q = mk('q'); ids.st = mk('st');
  const pageC = vm.runInContext('dashboardPage_', ctx)(dc);
  const srcC = pageC.slice(pageC.indexOf('<script>') + 8, pageC.lastIndexOf('</script>'));
  const win = vm.createContext({ document: doc });
  const all = (n) => [n._text].concat(...n.children.map(all)).join('|');
  vm.runInContext(srcC, win);
  const tabsTxt = all(ids.tabs);
  t('タブ: 進路相談用・一般鑑定者用・法人鑑定者用・要確認・安全確認', /進路相談用 \(3\)/.test(tabsTxt) && /一般鑑定者用 \(1\)/.test(tabsTxt) && /法人鑑定者用 \(1\)/.test(tabsTxt) && /要確認の申込/.test(tabsTxt) && /安全確認/.test(tabsTxt));
  t('進路相談用のタブ: 進路の家庭だけ(一般・法人を含まない)', /F0001/.test(all(ids.view)) && !/G0001|B0001/.test(all(ids.view)));
  ids.tabs.children.find(b => /一般鑑定者用/.test(b._text)).onclick();
  t('一般鑑定者用のタブ: 一般の申込だけ', /G0001/.test(all(ids.view)) && /佐藤 一郎/.test(all(ids.view)) && !/F0001|B0001/.test(all(ids.view)));
  ids.tabs.children.find(b => /法人鑑定者用/.test(b._text)).onclick();
  t('法人鑑定者用のタブ: 法人名・人数が出る', /B0001/.test(all(ids.view)) && /株式会社サンプル \/ 鈴木 花子/.test(all(ids.view)) && /人数/.test(all(ids.view)));
}


// 17. スプレッドシートから読んだ値の形(TRUE/FALSEは真偽値、日時はDateになる)
t('isTrue_/isFalse_: 文字・真偽値の両方', run('isTrue_(true)') && run('isTrue_("TRUE")') && !run('isTrue_(false)') && !run('isTrue_("FALSE")') && run('isFalse_(false)') && run('isFalse_("FALSE")') && !run('isFalse_(true)'));
t('cellStr_: Dateを日本時間の文字に。文字はそのまま', run('cellStr_(new Date(Date.UTC(2026, 9, 22, 4, 3, 12)))') === '2026-10-22 13:03:12' && run('cellStr_("abc")') === 'abc' && run('cellStr_(null)') === '');
t('dueMs_: 文字「2026-10-23 13:04」とDateのどちらも読める。不正はNaN', run('dueMs_("2026-10-23 13:04")') === Date.UTC(2026, 9, 23, 4, 4) && run('dueMs_(new Date(Date.UTC(2026, 9, 23, 4, 4)))') === Date.UTC(2026, 9, 23, 4, 4) && isNaN(run('dueMs_("abc")')));
{
  const subsB = [
    ['s1', new Date(Date.UTC(2026, 10, 3, 1, 0)), 'F0001', '子ども', 'CT0', 'T0', true, '', 1, 0, 0, 0, false],
    ['s2', new Date(Date.UTC(2026, 10, 3, 2, 0)), 'F0001', '保護者', 'PT0', 'T0', true, '', 1, 0, 0, 0, false],
    ['s3', 't', 'F0001', '保護者', 'PT0', 'T0', false, '重複送信', 1, 0, 0, 0, false],
    ['s4', 't', 'F9999', '子ども', 'CT0', 'T0', true, '', 1, 0, 0, 0, true]
  ];
  const safB = [[new Date(Date.UTC(2026, 10, 20, 1, 0)), 'F0001', 'CT2', 'F8', 'a', '送信済み', new Date(Date.UTC(2026, 10, 21, 1, 0)), '未対応', '', '', '']];
  const pendB = [[new Date(Date.UTC(2026, 10, 2, 1, 0)), '進路相談用', 'z', 'z@example.com', 'q', 'メール不一致', '']];
  const ddB = vm.runInContext('buildDashboardData_', ctx)(rosterD, pendB, subsB, safB, '2026-11-10');
  t('ダッシュボード: 分析採用が真偽値(true/false)でも、回答済みを数える。テスト(true)・重複(false)は除く', ddB.summary.responded.T0 === 1 && ddB.families.find(f => f.id === 'F0001').resp.CT0 === '2026-11-03 10:00:00');
  t('ダッシュボード: Dateの日時を、日本時間の文字で出す(受信・期限・受付)', ddB.safety[0].at === '2026-11-20 10:00:00' && ddB.safety[0].due === '2026-11-21 10:00:00' && ddB.pending[0].at === '2026-11-02 10:00:00');
}


console.log('\n' + pass + ' passed / ' + fail + ' failed');
process.exit(fail ? 1 : 0);

// 出力用: コードブックCSVを書き出す(--write 指定時)
