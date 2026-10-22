// サイトからの操作(API)と画面の操作を、メモリ上のスプレッドシートのモックで検証する
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const root = path.join(__dirname, '..', 'apps_script');
const code = fs.readFileSync(path.join(root, 'Survey.gs'), 'utf8') + '\n' + fs.readFileSync(path.join(root, 'Code.gs'), 'utf8');

class Sheet {
  constructor(name, header, id) { this.name = name; this.values = header ? [header.slice()] : []; this.id = id; this.parent = null; }
  getName() { return this.name; } setName(n) { this.name = n; } getSheetId() { return this.id; } getParent() { return this.parent; }
  getLastRow() { return this.values.length; }
  getLastColumn() { return Math.max(1, ...this.values.map(r => r.length)); }
  getDataRange() { const self = this; return { getValues: () => self.values.map(r => r.slice()) }; }
  appendRow(r) { this.values.push(r.slice()); return this; }
  clearContents() { this.values = []; return this; } clear() { this.values = []; return this; }
  getRange(r, c, nr, nc) {
    const self = this;
    if (typeof r === 'string') { const m = /^([A-Z])([0-9]+)$/.exec(r); c = m[1].charCodeAt(0) - 64; r = Number(m[2]); }
    nr = nr || 1; nc = nc || 1;
    return {
      getValue: () => { const v = (self.values[r - 1] || [])[c - 1]; return v === undefined ? '' : v; },
      getValues: () => { const out = []; for (let i = 0; i < nr; i++) { const row = []; for (let j = 0; j < nc; j++) row.push((self.values[r - 1 + i] || [])[c - 1 + j] === undefined ? '' : self.values[r - 1 + i][c - 1 + j]); out.push(row); } return out; },
      setValue: (v) => { while (self.values.length < r) self.values.push([]); const row = self.values[r - 1]; while (row.length < c) row.push(''); row[c - 1] = v; },
      setValues: (vs) => { vs.forEach((vr, i) => { while (self.values.length < r + i) self.values.push([]); const row = self.values[r - 1 + i]; vr.forEach((v, j) => { while (row.length < c + j) row.push(''); row[c - 1 + j] = v; }); }); },
      clearContent: () => { for (let i = 0; i < nr; i++) { const row = self.values[r - 1 + i]; if (row) for (let j = 0; j < nc; j++) if (row[c - 1 + j] !== undefined) row[c - 1 + j] = ''; } },
      setNumberFormat: () => {}, setFontWeight: () => ({ })
    };
  }
}
class SS {
  constructor(id) { this.id = id; this.sheets = []; this.n = 0; }
  add(name, header) { const s = new Sheet(name, header, ++this.n); s.parent = this; this.sheets.push(s); return s; }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  getSheets() { return this.sheets; } getId() { return this.id; } getUrl() { return 'https://sheets.example/' + this.id; }
}

function makeEnv(activeEmail) {
  const sent = [], cache = {};
  const reg = new SS('reg'), db = new SS('db');
  const ctxEnv = { console, Logger: { log() {} } };
  const env = vm.createContext(ctxEnv);
  vm.runInContext(code, env);
  const H = (n) => vm.runInContext('HEAD.' + n, env);
  const roster = reg.add('名簿', H('roster'));
  const settings = reg.add('設定', ['項目', '値', '説明']);
  settings.values.push(['安全', 'safe@example.com'], ['代理', ''], ['', ''], ['', ''], ['運営メール', 'op@example.com'], ['アンケートサイトURL', 'https://site.example/exec?page=survey']);
  const sendlog = reg.add('送信ログ', H('sendlog'));
  reg.add('申込要確認', H('pending')); reg.add('安全対応ログ', H('safety'));
  const subs = db.add('Submissions', H('submissions')), long = db.add('Long', H('long')), opts = db.add('LongOptions', H('options'));
  const resp = db.add('resp_CT0', ['タイムスタンプ', '調査用ID(運営から届いた専用リンクで自動入力されます。変更しないでください)', 'S1. x']);
  const rc = (n) => vm.runInContext('RC.' + n, env);
  function addFamily(o) {
    const row = new Array(34).fill('');
    Object.entries({ id: 'F0001', ts: '2026-11-01T10:00:00', pname: '山田 花子', pgender: '女性', pbirth: '19850612', pemail: 'hanako@example.com', line: 'hana', officialLine: '追加しました', referrer: 'ナシ',
      cname: '山田 太郎', cgender: '男性', cbirth: '20100315', cemail: 'taro@example.com', status: '参加中', category: 'career' }).forEach(([k, v]) => { row[rc(k)] = (o && o[k] !== undefined) ? o[k] : v; });
    Object.keys(o || {}).forEach(k => { row[rc(k)] = o[k]; });
    roster.values.push(row);
  }
  const stores = { SS_ID: 'db', REG_SS_ID: 'reg', FORM_IDS: JSON.stringify({ CT0: 'f1', CT1: 'f2', CT2: 'f3', PT0: 'f4', PT1: 'f5', PT2: 'f6' }) };
  Object.assign(ctxEnv, {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => stores[k] }) },
    SpreadsheetApp: { openById: (id) => (id === 'reg' ? reg : db), flush() {} },
    Session: { getActiveUser: () => ({ getEmail: () => activeEmail }), getEffectiveUser: () => ({ getEmail: () => 'me@example.com' }) },
    MailApp: { sendEmail: (o) => { sent.push(o); }, getRemainingDailyQuota: () => 100 },
    CacheService: { getScriptCache: () => ({ get: (k) => (cache[k] === undefined ? null : cache[k]), put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; } }) },
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    HtmlService: { createHtmlOutput: (h) => { const o = { html: h, setTitle(x) { o.title = x; return o; }, addMetaTag() { return o; } }; return o; } },
    Utilities: {
      getUuid: () => require('crypto').randomUUID(),
      formatDate: (d, tz, fmt) => { const j = new Date(d.getTime() + 9 * 3600 * 1000).toISOString(); return fmt.indexOf('HH') !== -1 ? j.slice(0, 19) : j.slice(0, 10); }
    },
    FormApp: { ItemType: { TEXT: 'TEXT' }, openById: (id) => ({ getItems: () => [{ getTitle: () => '調査用ID(運営から届いた専用リンクで自動入力されます。変更しないでください)', asTextItem: () => ({ createResponse: (v) => ({ id: v }) }) }], createResponse: () => ({ withItemResponse: (r) => ({ toPrefilledUrl: () => 'https://forms.example/' + id + '?rid=' + r.id }) }) }) }
  });
  return { env, reg, db, roster, sendlog, subs, long, opts, resp, sent, addFamily, rc, run: (e) => vm.runInContext(e, env) };
}

let pass = 0, fail = 0;
function t(name, cond, detail) { if (cond) { pass++; console.log('OK  ' + name); } else { fail++; console.log('NG  ' + name + (detail ? '  -> ' + detail : '')); } }
function throws(fn) { try { fn(); return null; } catch (e) { return e.message; } }

{ // 鑑定日の入力
  const E = makeEnv('me@example.com'); E.addFamily({});
  E.run('apiSetSessionDate')('F0001', '2026-11-10');
  t('API: 鑑定日を入力できる(名簿に保存)', E.roster.values[1][E.rc('session')] === '2026-11-10');
  t('API: 鑑定日の形式が不正(2026/11/10)ならエラー', /yyyy-mm-dd/.test(throws(() => E.run('apiSetSessionDate')('F0001', '2026/11/10')) || ''));
  t('API: 存在しない日付(2026-02-30)ならエラー', !!throws(() => E.run('apiSetSessionDate')('F0001', '2026-02-30')));
  E.run('apiSetSessionDate')('F0001', '');
  t('API: 空文字で鑑定日を消去', E.roster.values[1][E.rc('session')] === '');
  t('API: 名簿にないIDはエラー', /見つかりません/.test(throws(() => E.run('apiSetSessionDate')('F0009', '2026-11-10')) || ''));
  t('API: IDの形式が不正ならエラー', !!throws(() => E.run('apiSetSessionDate')("F0001'; DROP", '2026-11-10')));
  const d = E.run('apiSetStatus')('F0001', '辞退');
  t('API: 参加状況の変更と、更新後のデータの返却', E.roster.values[1][E.rc('status')] === '辞退' && d.families[0].status === '辞退');
  t('API: 不正な参加状況はエラー', !!throws(() => E.run('apiSetStatus')('F0001', '削除済み')));
}
{ // 権限
  const E = makeEnv('other@example.com'); E.addFamily({});
  t('API: 本人でも運営でもない閲覧者は拒否', /権限がありません/.test(throws(() => E.run('apiData')()) || '') && /権限がありません/.test(throws(() => E.run('apiSetStatus')('F0001', '辞退')) || ''));
  const E2 = makeEnv(''); E2.addFamily({});
  t('API: 匿名(メール不明)は拒否', !!throws(() => E2.run('apiData')()));
  const E3 = makeEnv('op@example.com'); E3.addFamily({});
  t('API: 設定シートの運営メールは許可', !throws(() => E3.run('apiData')()));
}
{ // リンクの送信
  const E = makeEnv('me@example.com'); E.addFamily({}); E.addFamily({ id: 'F0002', pname: '田中', pemail: 'tanaka@example.com', cemail: 'c2@example.com', cname: '次郎' }); E.addFamily({ id: 'G0001', category: 'general', cemail: '' });
  E.run('apiSetSessionDate')('F0001', '2026-11-10');
  let r = E.run('apiSendLinks')('T0', null);
  t('API送信: 鑑定日が入力済みの家庭(F0001)だけに、保護者宛1通・お子様宛1通', r.sent === 1 && E.sent.length === 2 && E.sent[0].to === 'hanako@example.com' && E.sent[1].to === 'taro@example.com');
  t('API送信: 案内メールに、アンケートサイトのURLと、入力するメールアドレスが載る(Googleフォームのリンクは載らない)', /site\.example\/exec\?page=survey/.test(E.sent[0].body) && /hanako@example\.com/.test(E.sent[0].body) && !/forms\.example|docs\.google\.com\/forms/.test(E.sent[0].body) && /site\.example\/exec\?page=survey/.test(E.sent[1].body) && /taro@example\.com/.test(E.sent[1].body) && !/hanako@example\.com/.test(E.sent[1].body));
  const E0 = makeEnv('me@example.com'); E0.addFamily({}); E0.run('apiSetSessionDate')('F0001', '2026-11-10'); E0.reg.getSheetByName('設定').values[6][1] = '';
  t('API送信: 設定B7(アンケートサイトのURL)が空欄なら、メールを送らずに止め、理由を知らせる(送信済みにもならない)', /B7/.test(throws(() => E0.run('apiSendLinks')('T0', null)) || '') && E0.sent.length === 0 && E0.roster.values[1][E0.rc('T0')] === '');
  E0.reg.getSheetByName('設定').values[6][1] = 'https://site.example/exec';
  t('API送信: B7に ?page=survey がない場合も止める', /形式/.test(throws(() => E0.run('apiSendLinks')('T0', null)) || '') && E0.sent.length === 0);
  t('API送信: 送信日時(T0)が名簿に記録される', String(E.roster.values[1][E.rc('T0')]).length > 10 && E.roster.values[2][E.rc('T0')] === '');
  t('API送信: 送信ログに保護者宛・お子様宛が記録される', E.sendlog.values.length === 3);
  r = E.run('apiSendLinks')('T0', null);
  t('API送信: 2回目は送信済みのため送らない(二重送信なし)', r.sent === 0 && E.sent.length === 2);
  r = E.run('apiSendLinks')('T0', ['F0002']);
  t('API送信: 選んだ家庭には、鑑定日が未入力でも送れる', r.sent === 1 && E.sent.length === 4);
  r = E.run('apiSendLinks')('T0', ['G0001']);
  t('API送信: 一般・法人の家庭には送らない', r.sent === 0 && E.sent.length === 4);
  t('API送信: 時点が不正ならエラー', !!throws(() => E.run('apiSendLinks')('T9', null)));
  E.run('apiSetStatus')('F0002', '辞退');
  E.roster.values[2][E.rc('T0')] = '';
  r = E.run('apiSendLinks')('T0', ['F0002']);
  t('API送信: 辞退した家庭には送らない', r.sent === 0);
}
{ // 削除
  const E = makeEnv('me@example.com'); E.addFamily({}); E.addFamily({ id: 'F0002', pname: '田中', pemail: 'tanaka@example.com', cname: '次郎' });
  E.subs.values.push(['s1', 't', 'F0001', '子ども', 'CT0', 'T0', 'TRUE', '', 1, 0, 0, 0, 'FALSE'], ['s2', 't', 'F0002', '子ども', 'CT0', 'T0', 'TRUE', '', 1, 0, 0, 0, 'FALSE']);
  E.long.values.push(['s1', 'F0001', '子ども', 'CT0', 'T0', 'S1', '3', 3, 't', '回答', 0, 'TRUE'], ['s2', 'F0002', '子ども', 'CT0', 'T0', 'S1', '2', 2, 't', '回答', 0, 'TRUE']);
  E.opts.values.push(['s1', 'F0001', 'CT0', 'B1', 'a']);
  E.resp.values.push(['2026-11-03', 'F0001', '3'], ['2026-11-03', 'F0002', '2']);
  const r = E.run('apiDeleteFamily')('F0001');
  t('削除: 回答DBの Submissions・Long・LongOptions・生の回答から F0001 の行だけが消える', E.subs.values.length === 2 && E.subs.values[1][2] === 'F0002' && E.long.values.length === 2 && E.long.values[1][1] === 'F0002' && E.opts.values.length === 1 && E.resp.values.length === 2 && E.resp.values[1][1] === 'F0002');
  const row = E.roster.values[1];
  t('削除: 名簿の個人情報(名前・メール・生年月日・LINE・お子様)が消え、IDは残り、状況=削除済み', row[E.rc('id')] === 'F0001' && row[E.rc('pname')] === '' && row[E.rc('pemail')] === '' && row[E.rc('pbirth')] === '' && row[E.rc('line')] === '' && row[E.rc('cname')] === '' && row[E.rc('cemail')] === '' && row[E.rc('status')] === '削除済み');
  t('削除: 他の家庭(F0002)の名簿は変わらない', E.roster.values[2][E.rc('pname')] === '田中');
  t('削除: 削除の記録(送信ログ)が残る。メッセージを返す', E.sendlog.values.some(x => x[2] === '削除') && /削除しました/.test(r.message));
  t('削除: 削除済みの再削除はエラー。削除済みへの状況変更も不可', !!throws(() => E.run('apiDeleteFamily')('F0001')) && !!throws(() => E.run('apiSetStatus')('F0001', '参加中')));
  t('削除: 削除済みの家庭には、リンクを送らない', E.run('apiSendLinks')('T0', ['F0001']).sent === 0);
}
{ // 画面の操作(クライアント)
  const E = makeEnv('me@example.com'); E.addFamily({}); E.run('apiSetSessionDate')('F0001', '2026-11-10');
  const data = E.run('apiData')();
  const page = E.run('dashboardPage_')(data);
  const src = page.slice(page.indexOf('<script>') + 8, page.lastIndexOf('</script>'));
  const mk = (tag) => { const e = { tag, children: [], style: {}, _text: '', className: '', disabled: false, value: '', appendChild(c) { this.children.push(c); return c; }, set innerHTML(v) { this.children = []; this._text = ''; }, get innerHTML() { return ''; }, set textContent(v) { this._text = String(v); }, get textContent() { return this._text; }, set colSpan(v) {} }; return e; };
  const ids = {}; const doc = { createElement: mk, createTextNode: (x) => { const e = mk('#text'); e._text = x; return e; }, getElementById: (id) => ids[id] || (ids[id] = mk(id)) };
  ids.q = mk('q'); ids.st = mk('st');
  const calls = [];
  const gsr = () => { let ok, ng; const o = { withSuccessHandler: (f) => { ok = f; return o; }, withFailureHandler: (f) => { ng = f; return o; } }; ['apiSetSessionDate', 'apiSetStatus', 'apiSendLinks', 'apiDeleteFamily', 'apiEndSession'].forEach(n => { o[n] = (...a) => { calls.push([n, a]); ok({ message: n + ' ok', data }); }; }); return o; };
  const win = vm.createContext({ document: doc, window: {}, google: { script: { run: null } }, setTimeout: () => 1, clearTimeout: () => {} });
  win.window.google = win.google; win.google.script.run = gsr();
  vm.runInContext(src, win);
  const all = (n) => [n._text].concat(...n.children.map(all)).join('|');
  const findAll = (n, f, out = []) => { if (f(n)) out.push(n); n.children.forEach(c => findAll(c, f, out)); return out; };
  const bulk = findAll(ids.bulk, n => n.tag === 'button' && /T0のリンクを、条件に合う全家庭に送る/.test(n._text))[0];
  t('画面: 進路相談用のタブに、T0・T1・T2の一括送信ボタン', findAll(ids.bulk, n => n.tag === 'button').length === 3 && !!bulk);
  bulk.onclick();
  t('画面: 1回目のクリックでは実行されず、確認表示になる', calls.length === 0 && /もう一度押すと実行/.test(bulk._text));
  bulk.onclick();
  t('画面: 2回目のクリックで apiSendLinks("T0", null) が呼ばれ、結果のメッセージが出る', calls.length === 1 && calls[0][0] === 'apiSendLinks' && calls[0][1][0] === 'T0' && calls[0][1][1] === null && /apiSendLinks ok/.test(ids.msg._text));
  const det = findAll(ids.view, n => n.className === 'acts')[0];
  t('画面: 詳細に、鑑定日・参加状況の入力と、個別の送信・削除ボタン', !!det && findAll(det, n => n.tag === 'input').length === 1 && findAll(det, n => n.tag === 'select').length === 1 && findAll(det, n => n.tag === 'button' && /リンクを送る/.test(n._text)).length === 3 && findAll(det, n => n.tag === 'button' && /データを削除/.test(n._text)).length === 1);
  const inp = findAll(det, n => n.tag === 'input')[0]; inp.value = '2026-12-01';
  findAll(det, n => n.tag === 'button' && n._text === '保存')[0].onclick();
  t('画面: 鑑定日の保存で apiSetSessionDate("F0001", "2026-12-01")', calls.some(c => c[0] === 'apiSetSessionDate' && c[1][0] === 'F0001' && c[1][1] === '2026-12-01'));
  const endBtn = findAll(findAll(ids.view, n => n.className === 'acts')[0], n => n.tag === 'button' && /セッション終了/.test(n._text))[0];
  t('画面: 詳細に「セッション終了(アンケートを送る)」ボタンがあり、2回押して apiEndSession が呼ばれる', !!endBtn && (endBtn.onclick(), !calls.some(c => c[0] === 'apiEndSession')) && (endBtn.onclick(), calls.some(c => c[0] === 'apiEndSession' && c[1][0] === 'F0001')));
  const del = findAll(findAll(ids.view, n => n.className === 'acts')[0], n => n.tag === 'button' && /データを削除/.test(n._text))[0];
  del.onclick();
  t('画面: 削除ボタンも、1回目は確認表示のみ', !calls.some(c => c[0] === 'apiDeleteFamily'));
  del.onclick();
  t('画面: 削除ボタンの2回目で apiDeleteFamily("F0001")', calls.some(c => c[0] === 'apiDeleteFamily' && c[1][0] === 'F0001'));
  const noRun = vm.createContext({ document: (() => { const i2 = {}; return { createElement: mk, createTextNode: (x) => { const e = mk('#text'); e._text = x; return e; }, getElementById: (id) => i2[id] || (i2[id] = mk(id)) }; })(), window: {}, google: undefined, setTimeout: () => 1, clearTimeout: () => {} });
  vm.runInContext(src, noRun);
  t('画面: ウェブアプリ以外で開いた場合でも描画はエラーにならない', true);
}
{ // 台帳が無い場合のsetup(単独のスクリプト)
  const E = makeEnv('me@example.com');
  const made = [];
  vm.runInContext('1', E.env);
  const props = {};
  Object.assign(E.env, {
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => props[k], setProperty: (k, v) => { props[k] = v; } }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => null, create: (n) => { made.push(n); const ss = new SS(n === '調査台帳' ? 'reg2' : 'db2'); ss.getUrl = () => 'u'; return ss; }, openById: () => null, flush() {} }
  });
  const msg = throws(() => E.run('setup')());
  t('単独のスクリプトで setup() を実行すると、台帳を自動で作ろうとする(「紐づいていません」のエラーにならない)', made[0] === '調査台帳' && !/紐づいていません/.test(msg || ''), msg);
}

{ // マニフェスト(権限と、ウェブアプリの公開範囲)
  const mf = JSON.parse(fs.readFileSync(path.join(root, 'appsscript.json'), 'utf8'));
  const used = [
    ['Session.getEffectiveUser / getActiveUser', /Session\.get(Effective|Active)User/, 'https://www.googleapis.com/auth/userinfo.email'],
    ['MailApp', /MailApp\./, 'https://www.googleapis.com/auth/script.send_mail'],
    ['ScriptApp.newTrigger', /ScriptApp\./, 'https://www.googleapis.com/auth/script.scriptapp'],
    ['FormApp', /FormApp\./, 'https://www.googleapis.com/auth/forms'],
    ['SpreadsheetApp', /SpreadsheetApp\./, 'https://www.googleapis.com/auth/spreadsheets'],
    ['DriveApp', /DriveApp\./, 'https://www.googleapis.com/auth/drive'],
    ['SpreadsheetApp.getUi(メニュー・ダイアログ)', /getUi\(\)/, 'https://www.googleapis.com/auth/script.container.ui']
  ];
  used.forEach(([name, re, scope]) => { if (re.test(code)) t('マニフェストに必要な権限がある: ' + name, mf.oauthScopes.indexOf(scope) !== -1, scope); });
  t('ウェブアプリの既定の公開範囲は「自分のみ」・実行者は「自分」', mf.webapp && mf.webapp.access === 'MYSELF' && mf.webapp.executeAs === 'USER_DEPLOYING');
}


{ // 専用サイト(公開の申込ページ)
  const GE = { GE1: '佐藤 一郎', GE2: '男性', GE3: '19800101', GE4: 'ichiro@example.com', GE5: 'ichiro@example.com', GE6: 'ichiro_line', GE8: '追加しました', GE9: 'ナシ', CONSENT_ALL: '全てに同意しました' };
  const E = makeEnv('');
  const r = E.run('submitApplication')('general', GE, '');
  t('サイト申込(一般): 受付 → G0001・名簿に34列で登録', r.ok && E.roster.values.length === 2 && E.roster.values[1][0] === 'G0001' && E.roster.values[1].length === 34);
  t('サイト申込: 完了画面に鑑定料・お振込先・LINEを返す', /30,000円/.test(r.fee.join()) && /7332659/.test(r.bank.join()) && r.line === 'https://lin.ee/ewijo32');
  t('サイト申込: 申込者に受付メール(HTMLつき・お振込先入り)と、運営に通知', E.sent.some(m => m.to === 'ichiro@example.com' && /7332659/.test(m.body) && /7332659/.test(m.htmlBody)) && E.sent.some(m => m.to === 'op@example.com'));
  t('サイト申込: 送信ログに記録', E.sendlog.values.some(x => /申込受付/.test(x[2])));
  const r2 = E.run('submitApplication')('general', Object.assign({}, GE, { CONSENT_ALL: '' }), '');
  t('サイト申込: 同意なし → 修正点を返し、登録しない', !r2.ok && /同意/.test(r2.errors.join()) && E.roster.values.length === 2);
  const r3 = E.run('submitApplication')('general', GE, '');
  t('サイト申込: 同じ内容の重複申込は登録しない', !r3.ok && E.roster.values.length === 2);
  const r4 = E.run('submitApplication')('general', Object.assign({}, GE, { GE4: 'x@example.com' }), 'bot');
  t('サイト申込: 隠し欄に入力があれば(ボット)黙って捨てる', r4.ok && r4.silent && E.roster.values.length === 2);
  t('サイト申込: 区分が不正ならエラー', !!throws(() => E.run('submitApplication')('hack', GE, '')));
  const rb = E.run('submitApplication')('corp', { CO1: '株式会社サンプル', CO3: '鈴木 花子', CO4: 'suzuki@sample.co.jp', CO5: 'suzuki@sample.co.jp', CO6: '03-1234-5678', CO7: 'l', CO8: '追加しました', CO9: 'ナシ', CO10: '追加なし(代表のみ)', CO11: '鈴木 花子/女性/19800101', CONSENT_ALL: '全てに同意しました', EVIL: 'x' }, '');
  t('サイト申込(法人): プラン代表のみ → 50,000円、プランが名簿に入る、知らない項目は捨てる', rb.ok && /50,000円/.test(rb.fee.join()) && E.roster.values[2][E.rc('plan')] === '代表のみ 50,000円');
  const E2 = makeEnv('');
  let n = 0; for (let i = 0; i < 8; i++) { const x = E2.run('submitApplication')('general', Object.assign({}, GE, { GE1: 'n' + i, GE4: 'same@example.com', GE5: 'same@example.com' }), ''); if (!x.ok && /多すぎ/.test((x.errors || []).join())) n++; }
  t('サイト申込: 同じメールからの連続送信は制限される', n >= 1);
}
{ // 権限(公開ページから管理用の関数は呼べない)
  const guarded = ['setup', 'resetSetup', 'runStaticTests', 'runDataTests', 'verifyDataTests', 'buildSummary', 'exportCsv', 'deleteFamilyData'];
  const E = makeEnv('');
  t('管理用の関数(setup・削除・集計など)は、管理者以外が呼ぶと拒否される', guarded.every(f => /管理者のみ/.test(throws(() => E.run(f)()) || '')));
  const E2 = makeEnv('me@example.com');
  t('管理者本人なら、権限の確認を通る', !throws(() => E2.run('ownerOnly_')()));
}
{ // ページの出し分け
  const A = makeEnv(''); const run = (e) => A.run(e); const pa = A.run('doGet')({ parameter: { cat: 'career' } });
  t('公開(閲覧者のメール不明)で開くと、申込ページが出る(ダッシュボードは出ない)', /お申込み/.test(pa.title) && !/dashboard/i.test(pa.title) && /submitApplication/.test(pa.html) && !/F0001/.test(pa.html));
  const O = makeEnv('me@example.com'); O.addFamily({});
  t('管理者が開くとダッシュボード、?page=apply なら申込ページ', /ダッシュボード/.test(O.run('doGet')({ parameter: {} }).title) && /お申込み/.test(O.run('doGet')({ parameter: { page: 'apply' } }).title));
  t('申込ページには、お振込先(口座番号)が含まれない(申込後にだけ表示)', !/7332659/.test(pa.html));
  const pc = A.run('doGet')({ parameter: { cat: 'corp' } }), pg2 = A.run('doGet')({ parameter: { cat: 'general' } }), pn = A.run('doGet')({ parameter: {} });
  t('区分ごとのURL: 進路の申込ページには、法人・個人の項目やプラン(50,000円/100,000円)が含まれない', !/50,000円|100,000円|株式会社|法人名/.test(pa.html) && /お子様/.test(pa.html));
  t('区分ごとのURL: 法人の申込ページには、進路・個人の項目が含まれない(お子様・追加の鑑定)', !/お子様|追加の鑑定/.test(pc.html) && /50,000円/.test(pc.html));
  t('区分ごとのURL: 個人の申込ページには、法人のプランが含まれない', !/50,000円|100,000円|法人名|お子様/.test(pg2.html));
  t('区分の指定がない(または不正な)URLでは、フォームの設問を一切出さず、案内文だけ', !/"id":"(GE|AP|CO|CONSENT)/.test(pn.html) && !/"id":"(GE|AP|CO|CONSENT)/.test(A.run('doGet')({ parameter: { cat: 'x' } }).html) && /ご案内したURL/.test(pn.html));
  t('タイトルに、親子プラン・個人プラン・法人プランが入る(ページ・フォーム・受付メール)', /親子プラン/.test(pa.title) && /法人プラン/.test(pc.title) && /個人プラン/.test(pg2.title) && /親子プラン/.test(run('SURVEY.apply.title')) && /個人プラン/.test(run('SURVEY.applyG.title')) && /法人プラン/.test(run('SURVEY.applyB.title')) && /法人プラン/.test(run("buildApplyReceiptEmail_({ name: 'a', company: 'b' }, 'corp').subject")));
  t('ページの下に「版」が表示される(反映の確認用)', /2026-10-22-f/.test(pa.html) && /2026-10-22-f/.test(pn.html));
  t('管理者でも、?cat= を付ければ、その区分の申込ページが開く', /お申込み/.test(O.run('doGet')({ parameter: { cat: 'general' } }).title));
  const src = pa.html.slice(pa.html.indexOf('<script>') + 8, pa.html.lastIndexOf('</script>'));
  let ok = true; try { new Function(src); } catch (e) { ok = false; console.log(e.message); }
  t('申込ページのスクリプトに構文エラーがない', ok);
}

{ // 題名に番号を付けない申込フォームの回答を、内部の形に戻す
  const E = makeEnv('');
  const hint = E.run("applyTitleParts_(SURVEY.applyG.blocks.find(b => b.id === 'GE9'))");
  t('紹介者・自由記入欄の(…)の説明は、題名から外し、フォームの説明文にする', hint.title === '紹介者氏名' && hint.hint === '(カタカナ。いらっしゃらない場合は「ナシ」とご入力ください)' && E.run("applyTitleParts_(SURVEY.applyG.blocks.find(b => b.id === 'GE11'))").title === '自由記入欄' && E.run("applyTitleParts_(SURVEY.applyG.blocks.find(b => b.id === 'GE4'))").hint === '');
  const nv = { '保護者さまの名前(フルネーム)': ['山田 花子'], 'お子様の名前(フルネーム)': ['山田 太郎'] };
  const out = E.run('normalizeApplyNamed_')(E.run('SURVEY.apply'), nv);
  t('申込フォーム: 題名が文言のみでも、内部の「ID. 文言」に戻して処理できる', out['AP1. 保護者さまの名前(フルネーム)'][0] === '山田 花子' && out['CH1. お子様の名前(フルネーム)'][0] === '山田 太郎');
  t('申込フォームの題名に、設問番号(AP1.など)が付かない', E.run("SURVEY.apply.blocks.filter(b => b.type === 'q').map(b => b.text).every(x => !/^[A-Z_0-9]+\\.\\s/.test(x))"));
  const seen = {}; let dup = false; E.run("SURVEY.apply.blocks.filter(b => b.type === 'q').map(b => applyTitleParts_(b).title)").forEach(x => { if (seen[x]) dup = true; seen[x] = 1; });
  t('申込フォーム内で、設問の文言が重複しない(番号なしでも区別できる)', !dup);
}

{ // アンケートの回答サイト(メールアドレスで入室)
  const E = makeEnv('');
  E.addFamily({}); // F0001: 保護者 hanako@example.com / お子様 taro@example.com
  const login = (m) => E.run('surveyLogin')(m);
  let r = login('taro@example.com');
  t('サイト入室: 案内を送る前は、アンケートが出ない(登録済みでも、同じ案内文)', !r.ok && /見つかりません/.test(r.message));
  t('サイト入室: メールの形式が不正ならエラー・未登録も同じ案内文(登録の有無を教えない)', !login('xxx').ok && /見つかりません/.test(login('nobody@example.com').message));
  E.roster.values[1][E.rc('T0')] = '2026-11-01T10:00:00';
  r = login('Taro@Example.com');
  t('サイト入室: お子様のメールアドレス(大文字小文字は区別しない)で、お子様用T0(CT0)が出る', r.ok && r.def.key === 'CT0' && r.who === '山田 太郎' && /^[0-9a-f]{64}$/.test(r.token));
  const ids = r.def.blocks.filter(b => b.type === 'q').map(b => b.id);
  t('サイト入室: 調査用IDは画面に出ない。設問・ページの題名に番号(D1.・A.)が付かない', ids.indexOf('RID') === -1 && r.def.blocks.every(b => !/^[A-Z][A-Za-z0-9_\-]*\.\s/.test(b.title || b.text)));
  const rp = login('hanako@example.com');
  t('サイト入室: 保護者のメールアドレスなら、保護者用T0(PT0)が出る', rp.ok && rp.def.key === 'PT0');
  // 送信
  const fullAns = (def) => { const a = {}; def.blocks.filter(b => b.type === 'q' && b.required).forEach(q => { a[q.id] = q.kind === 'multi' ? [q.choices[q.choices.length - 1]] : q.kind === 'age' ? '13' : q.choices[0]; }); return a; };
  const ans = Object.assign(fullAns(r.def), { EVIL: 'x' });
  const missing = E.run('surveySubmit')(r.token, { A1: '13' });
  t('サイト送信: 未回答の必須の設問があると、記録せずに、案内を返す', !missing.ok && /まだ答えていない質問/.test(missing.message) && E.subs.values.length === 1);
  const before = E.subs.values.length;
  const sr = E.run('surveySubmit')(r.token, ans);
  const row = E.subs.values[E.subs.values.length - 1];
  t('サイト送信: 回答DBに記録(調査用ID=F0001、フォーム=CT0)・長い形式の回答も入る', sr.ok && E.subs.values.length === before + 1 && row[2] === 'F0001' && row[4] === 'CT0' && E.long.values.length > 1 && E.long.values.some(x => x[1] === 'F0001' && x[5] === 'S1' && x[7] === 4));
  t('サイト送信: お子様に受付確認メールが届く(回答内容は載らない)', E.sent.some(m => m.to === 'taro@example.com' && /受け付け/.test(m.subject + m.body)) && !E.sent.some(m => /少しそう思う/.test(m.body)));
  const again = E.run('surveySubmit')(r.token, ans);
  t('サイト送信: 同じ合い鍵での2回目は受け付けない(二重送信なし)', !again.ok && E.subs.values.length === before + 1);
  r = login('taro@example.com');
  t('サイト入室: 回答したあとは「回答ありがとう・いまのアンケートはなし」', !r.ok && r.done === true && /ありません/.test(r.message));
  E.roster.values[1][E.rc('T1')] = '2026-11-10T10:00:00';
  r = login('taro@example.com');
  t('サイト入室: 次の案内(T1)を送ると、続けて、お子様用T1(CT1)が出る(進捗に合わせて変わる)', r.ok && r.def.key === 'CT1');
  t('サイト送信: 偽の合い鍵は拒否', !E.run('surveySubmit')('0'.repeat(64), ans).ok && !E.run('surveySubmit')('zz', ans).ok);
  // 辞退・削除済み
  E.roster.values[1][E.rc('status')] = '辞退';
  t('サイト入室: 辞退した家庭は入れない', !login('taro@example.com').ok);
  // 回数制限
  const E2 = makeEnv(''); let blocked = false;
  for (let i = 0; i < 14; i++) { const x = E2.run('surveyLogin')('probe@example.com'); if (/何度も/.test(x.message || '')) blocked = true; }
  t('サイト入室: 同じメールアドレスの連続入力は、回数が制限される', blocked);
  // 回答の整形
  const nv = E.run('sanitizeSurveyAnswers_')('CT0', 'F0001', { A1: 'abc', S1: '偽の選択肢', B2: 'x', 'B2-2': ['家族との会話', '偽', 'わからない'] });
  t('回答の整形: 年齢は数字のみ・選択肢にない値は空・複数選択は有効な選択肢だけ。「わからない」(排他)は単独になる', nv['A1. あなたの年齢を教えてください。'][0] === '' && nv['S1. 自分の性格や特徴について理解している。'][0] === '' && nv[Object.keys(nv).find(k => /^RID\./.test(k))][0] === 'F0001');
  // 案内メール(サイトURL)
  const mails = E.run('buildLinkEmails_')('T0', { name: '山田 花子', email: 'hanako@example.com', childName: '太郎', childEmail: 'taro@example.com', sessionDate: '' }, { site: true, child: 'https://site.example/exec?page=survey', parent: 'https://site.example/exec?page=survey' });
  t('案内メール(サイト版): ページのURLと、入力するメールアドレスを載せる', /page=survey/.test(mails.parent.body) && /hanako@example\.com/.test(mails.parent.body) && /taro@example\.com/.test(mails.child.body) && !/forms\.example/.test(mails.child.body));
  // 公開ページ
  const pg = E.run('doGet')({ parameter: { page: 'survey' } });
  t('公開ページ ?page=survey で、アンケートのページが出る', /アンケート/.test(pg.title) && /surveyLogin/.test(pg.html) && !/7332659/.test(pg.html));
  const src = pg.html.slice(pg.html.indexOf('<script>') + 8, pg.html.lastIndexOf('</script>'));
  let ok = true; try { new Function(src); } catch (e) { ok = false; console.log(e.message); }
  t('アンケートのページのスクリプトに構文エラーがない', ok);
}

{ // アンケート画面(クライアント): ログイン→各ページ→分岐→送信
  const E = makeEnv('');
  const def = E.run('surveyClientDef_')('CT2');
  const pg = E.run('surveyPage_')();
  const src = pg.slice(pg.indexOf('<script>') + 8, pg.lastIndexOf('</script>'));
  const mk = (tag) => { const e = { tag, children: [], style: {}, _text: '', className: '', disabled: false, value: '', checked: false, classList: { toggle() {}, add() {}, remove() {} }, querySelector() { return null; }, scrollIntoView() {}, appendChild(c) { this.children.push(c); return c; }, set innerHTML(v) { this.children = []; this._text = ''; }, get innerHTML() { return ''; }, set textContent(v) { this._text = String(v); }, get textContent() { return this._text; } }; return e; };
  const ids = { app: mk('app'), foot: mk('foot') };
  const doc = { createElement: mk, getElementById: (id) => ids[id] || (ids[id] = mk(id)) };
  const calls = []; let pending = null;
  const run = { withSuccessHandler(f) { pending = { ok: f }; return run; }, withFailureHandler(f) { pending.ng = f; return run; }, surveyLogin(v) { calls.push(['login', v]); }, surveySubmit(tok, a) { calls.push(['submit', tok, a]); } };
  const win = vm.createContext({ document: doc, window: { pageYOffset: 0, scrollTo() {} }, google: { script: { run } }, alert: (m) => calls.push(['alert', m]) });
  win.window.scrollTo = () => {}; win.scrollTo = () => {}; win.pageYOffset = 0;
  vm.runInContext(src, win);
  const find = (n, f, out = []) => { if (f(n)) out.push(n); n.children.forEach(c => find(c, f, out)); return out; };
  const text = (n) => [n._text].concat(...n.children.map(text)).join('|');
  const btn = (label) => find(ids.app, n => n.tag === 'button' && n._text === label)[0];
  const input = find(ids.app, n => n.tag === 'input')[0];
  input.value = 'taro@example.com'; btn('はじめる').onclick();
  t('画面(アンケート): メールアドレスを入れて「はじめる」で surveyLogin が呼ばれる', calls[0][0] === 'login' && calls[0][1] === 'taro@example.com');
  pending.ok({ ok: false, message: '見つかりません' });
  t('画面(アンケート): 入れなかったときは、案内文が表示される', /見つかりません/.test(text(ids.app)));
  btn('はじめる').onclick(); pending.ok({ ok: true, token: 'T'.repeat(64), who: '太郎', def });
  t('画面(アンケート): 入室すると、アンケートの題名と説明・「はじめる」ボタンが出る', /算命学の鑑定についてのアンケート/.test(text(ids.app)) && !!btn('アンケートをはじめる'));
  btn('アンケートをはじめる').onclick();
  t('画面(アンケート): 最初のページと進捗バー・「つぎへ」が出る(「もどる」は出ない)', find(ids.app, n => n.className === 'prog').length === 1 && !!btn('つぎへ →') && !btn('← もどる'));
  // ゲート: CT2のうち行動の質問に「いいえ」→ 追加のページは出ない
  const firstCond = def.blocks.findIndex(b => b.type === 'page' && b.conditional);
  const gateQ = def.blocks.find(b => b.type === 'q' && b.gate);
  let steps = 0, sawCond = false;
  const condTitle = def.blocks[firstCond].title;
  btn('つぎへ →').onclick();
  t('画面(アンケート): 必須の設問が未回答のままだと、つぎへ進めず、案内が出る', find(ids.app, n => n.className === 'err').length > 0 && /ご回答をお願いします/.test(text(ids.app)) && find(ids.app, n => n.className === 'prog').length === 1 && !btn('← もどる'));
  while (btn('つぎへ →') && steps < 60) {
    const groups = {};
    find(ids.app, n => n.tag === 'input' && n.type === 'radio').forEach(r => { (groups[r.name] = groups[r.name] || []).push(r); });
    Object.values(groups).forEach(g => { const pick = g.find(r => r.value === 'いいえ') || g[0]; pick.checked = true; pick.onchange(); });
    find(ids.app, n => n.tag === 'input' && n.type === 'checkbox').forEach(cb => { if (!cb.checked) { cb.checked = true; cb.onchange(); } });
    find(ids.app, n => n.tag === 'input' && n.type === 'text').forEach(i => { i.value = '13'; i.oninput(); });
    if (text(ids.app).indexOf(condTitle) !== -1) sawCond = true;
    btn('つぎへ →').onclick(); steps++;
  }
  t('画面(アンケート): 「いいえ」を選ぶと、追加の質問のページは出ない(分岐)', steps > 3 && !sawCond);
  t('画面(アンケート): 最後のページは「送信する」', !!btn('送信する') && !!btn('← もどる'));
  btn('送信する').onclick();
  const sub = calls.filter(c => c[0] === 'submit')[0];
  t('画面(アンケート): 送信で surveySubmit(合い鍵, 回答) が呼ばれ、非表示の設問の回答は含まれない', !!sub && sub[1] === 'T'.repeat(64) && sub[2][gateQ.id] === 'いいえ' && !Object.keys(sub[2]).some(k => { const q = def.blocks.find(b => b.id === k); return q && q.hiddenWhen && sub[2][q.hiddenWhen.id] === q.hiddenWhen.value; }));
  pending.ok({ ok: true });
  t('画面(アンケート): 送信が済むと、お礼の画面が出る', /ご回答ありがとうございました/.test(text(ids.app)));
}
{ // セッション終了ボタン
  const E = makeEnv('me@example.com'); E.addFamily({}); E.addFamily({ id: 'G0001', category: 'general', cemail: '' });
  const r = E.run('apiEndSession')('F0001');
  t('セッション終了: 終了日時が名簿に記録され、鑑定直後(T1)のリンクが、保護者とお子様に1通ずつ届く', String(E.roster.values[1][E.rc('ended')]).length > 10 && String(E.roster.values[1][E.rc('T1')]).length > 10 && E.sent.length === 2 && E.sent.some(m => m.to === 'hanako@example.com') && E.sent.some(m => m.to === 'taro@example.com') && /鑑定直後/.test(E.sent[0].subject) && /送りました/.test(r.message));
  const r2 = E.run('apiEndSession')('F0001');
  t('セッション終了: 2回目は、T1を二重に送らない', E.sent.length === 2 && /すでに送信済み/.test(r2.message));
  t('セッション終了: 進路相談以外・辞退した家庭・存在しないIDはエラー', !!throws(() => E.run('apiEndSession')('G0001')) && !!throws(() => E.run('apiEndSession')('F0099')));
  E.addFamily({ id: 'F0002', pemail: 'p2@example.com', cemail: 'c2@example.com', status: '辞退' });
  t('セッション終了: 辞退した家庭は送らない', !!throws(() => E.run('apiEndSession')('F0002')) && E.sent.length === 2);
  const E3 = makeEnv('other@example.com'); E3.addFamily({});
  t('セッション終了: 管理者以外は呼べない', /権限がありません/.test(throws(() => E3.run('apiEndSession')('F0001')) || ''));
  const d = E.run('apiData')();
  t('ダッシュボードのデータに、セッション終了日時が入る', !!d.families.find(f => f.id === 'F0001').ended);
}
{ // 診断
  const logs = []; const E = makeEnv('me@example.com'); E.env.Logger = { log: (m) => logs.push(m) };
  E.addFamily({}); E.addFamily({ id: 'F0002', pemail: 'q@example.com', cemail: 'r@example.com' }); E.roster.values[1][E.rc('T0')] = '2026-11-01T10:00:00';
  E.run('diagnoseSurvey')();
  const out = logs.join('\n');
  t('診断: 見ている台帳・回答DBのURLと、各家庭の状況(案内の送信有無)が出る。メールは一部を伏せる', /sheets\.example\/reg/.test(out) && /sheets\.example\/db/.test(out) && /F0001.*T0:済.*入室できる/.test(out) && /F0002.*T0:未.*T0のリンクを送る/.test(out) && /h\*\*\*@example\.com/.test(out) && !/hanako@example\.com/.test(out));
  const E2 = makeEnv('other@example.com');
  t('診断: 管理者以外は実行できない', /管理者のみ/.test(throws(() => E2.run('diagnoseSurvey')()) || ''));
}
console.log('\n' + pass + ' passed / ' + fail + ' failed');
process.exit(fail ? 1 : 0);
