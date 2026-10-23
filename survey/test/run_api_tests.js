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
  clearContents() { this.values = []; return this; } clear() { this.values = []; return this; } setFrozenRows() {}
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
  settings.values.push(['安全', 'safe@example.com'], ['代理', ''], ['', ''], ['', ''], ['運営メール', 'op@example.com'], ['アンケートサイトURL', 'https://site.example/exec?page=survey'], ['メールの自動配信', '有効'], ['', 7], ['', 3], ['', 1], ['', 0], ['', 90]);
  const sendlog = reg.add('送信ログ', H('sendlog'));
  reg.add('申込要確認', H('pending')); reg.add('安全対応ログ', H('safety'));
  const subs = db.add('Submissions', H('submissions')), long = db.add('Long', H('long')), opts = db.add('LongOptions', H('options'));
  const resp = db.add('resp_CT0', ['タイムスタンプ', '調査用ID(運営から届いた専用リンクで自動入力されます。変更しないでください)', 'S1. x']);
  const rc = (n) => vm.runInContext('RC.' + n, env);
  function addFamily(o) {
    const row = new Array(38).fill('');
    Object.entries({ id: 'F0001', ts: '2026-11-01T10:00:00', pname: '山田 花子', pgender: '女性', pbirth: '19850612', pemail: 'hanako@example.com', line: 'hana', officialLine: '追加しました', referrer: 'ナシ',
      cname: '山田 太郎', cgender: '男性', cbirth: '20100315', cemail: '', status: '参加中', category: 'career' }).forEach(([k, v]) => { row[rc(k)] = (o && o[k] !== undefined) ? o[k] : v; });
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

{ // 受講日の入力
  const E = makeEnv('me@example.com'); E.addFamily({});
  E.run('apiSetSessionDate')('F0001', '2026-11-10');
  t('API: 受講日を入力できる(名簿に保存)', E.roster.values[1][E.rc('session')] === '2026-11-10');
  t('API: 受講日の形式が不正(2026/11/10)ならエラー', /yyyy-mm-dd/.test(throws(() => E.run('apiSetSessionDate')('F0001', '2026/11/10')) || ''));
  t('API: 存在しない日付(2026-02-30)ならエラー', !!throws(() => E.run('apiSetSessionDate')('F0001', '2026-02-30')));
  E.run('apiSetSessionDate')('F0001', '');
  t('API: 空文字で受講日を消去', E.roster.values[1][E.rc('session')] === '');
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
  t('API送信: 受講日が入力済みの家庭(F0001)の申込者に、1通だけ届く(お子様のメールアドレスは使わない)', r.sent === 1 && E.sent.length === 1 && E.sent[0].to === 'hanako@example.com');
  t('API送信: 案内メールに、アンケートサイトのURLと、入力するメールアドレス、お子様のアンケートも同じページで答える旨が載る(Googleフォームのリンクは載らない)', /site\.example\/exec\?page=survey/.test(E.sent[0].body) && /hanako@example\.com/.test(E.sent[0].body) && /お子様用/.test(E.sent[0].body) && !/forms\.example|docs\.google\.com\/forms/.test(E.sent[0].body));
  const E0 = makeEnv('me@example.com'); E0.addFamily({}); E0.run('apiSetSessionDate')('F0001', '2026-11-10'); E0.reg.getSheetByName('設定').values[6][1] = '';
  t('API送信: 設定B7(アンケートサイトのURL)が空欄なら、メールを送らずに止め、理由を知らせる(送信済みにもならない)', /B7/.test(throws(() => E0.run('apiSendLinks')('T0', null)) || '') && E0.sent.length === 0 && E0.roster.values[1][E0.rc('T0')] === '');
  E0.reg.getSheetByName('設定').values[6][1] = 'https://site.example/exec';
  t('API送信: B7に ?page=survey がない場合も止める', /形式/.test(throws(() => E0.run('apiSendLinks')('T0', null)) || '') && E0.sent.length === 0);
  t('API送信: 送信日時(T0)が名簿に記録される', String(E.roster.values[1][E.rc('T0')]).length > 10 && E.roster.values[2][E.rc('T0')] === '');
  t('API送信: 送信ログに申込者宛が記録される', E.sendlog.values.length === 2);
  r = E.run('apiSendLinks')('T0', null);
  t('API送信: 2回目は送信済みのため送らない(二重送信なし)', r.sent === 0 && E.sent.length === 1);
  r = E.run('apiSendLinks')('T0', ['F0002']);
  t('API送信: 選んだ家庭には、受講日が未入力でも送れる', r.sent === 1 && E.sent.length === 2);
  r = E.run('apiSendLinks')('T0', ['G0001']);
  t('API送信: 一般・法人の家庭には送らない', r.sent === 0 && E.sent.length === 2);
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
  t('画面: 詳細に、受講日・参加状況の入力と、個別の送信・削除ボタン', !!det && findAll(det, n => n.tag === 'input').length === 1 && findAll(det, n => n.tag === 'select').length === 1 && findAll(det, n => n.tag === 'button' && /リンクを送る/.test(n._text)).length === 3 && findAll(det, n => n.tag === 'button' && /データを削除/.test(n._text)).length === 1);
  const inp = findAll(det, n => n.tag === 'input')[0]; inp.value = '2026-12-01';
  findAll(det, n => n.tag === 'button' && n._text === '保存')[0].onclick();
  t('画面: 受講日の保存で apiSetSessionDate("F0001", "2026-12-01")', calls.some(c => c[0] === 'apiSetSessionDate' && c[1][0] === 'F0001' && c[1][1] === '2026-12-01'));
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
  t('サイト申込(一般): 受付 → G0001・名簿に38列で登録', r.ok && E.roster.values.length === 2 && E.roster.values[1][0] === 'G0001' && E.roster.values[1].length === 38);
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
  t('区分ごとのURL: 法人の申込ページには、進路・個人の項目が含まれない(お子様・追加の受講)', !/お子様|追加の受講/.test(pc.html) && /50,000円/.test(pc.html));
  t('区分ごとのURL: 個人の申込ページには、法人のプランが含まれない', !/50,000円|100,000円|法人名|お子様/.test(pg2.html));
  t('区分の指定がない(または不正な)URLでは、フォームの設問を一切出さず、案内文だけ', !/"id":"(GE|AP|CO|CONSENT)/.test(pn.html) && !/"id":"(GE|AP|CO|CONSENT)/.test(A.run('doGet')({ parameter: { cat: 'x' } }).html) && /ご案内したURL/.test(pn.html));
  t('タイトルに、親子プラン・個人プラン・法人プランが入る(ページ・フォーム・受付メール)', /親子プラン/.test(pa.title) && /法人プラン/.test(pc.title) && /個人プラン/.test(pg2.title) && /親子プラン/.test(run('SURVEY.apply.title')) && /個人プラン/.test(run('SURVEY.applyG.title')) && /法人プラン/.test(run('SURVEY.applyB.title')) && /法人プラン/.test(run("buildApplyReceiptEmail_({ name: 'a', company: 'b' }, 'corp').subject")));
  t('ページの下に「版」が表示される(反映の確認用)', /2026-10-23-i/.test(pa.html) && /2026-10-23-i/.test(pn.html));
  t('管理者でも、?cat= を付ければ、その区分の申込ページが開く', /お申込み/.test(O.run('doGet')({ parameter: { cat: 'general' } }).title));
  const src = pa.html.slice(pa.html.indexOf('<script>') + 8, pa.html.lastIndexOf('</script>'));
  let ok = true; try { new Function(src); } catch (e) { ok = false; console.log(e.message); }
  t('申込ページのスクリプトに構文エラーがない', ok);
}

{ // 題名に番号を付けない申込フォームの回答を、内部の形に戻す
  const E = makeEnv('');
  const hint = E.run("applyTitleParts_(SURVEY.applyG.blocks.find(b => b.id === 'GE9'))");
  t('紹介者・自由記入欄の(…)の説明は、題名から外し、フォームの説明文にする', hint.title === '紹介者氏名' && hint.hint === '(カタカナ。いらっしゃらない場合は「ナシ」とご入力ください)' && E.run("applyTitleParts_(SURVEY.applyG.blocks.find(b => b.id === 'GE11'))").title === '自由記入欄' && E.run("applyTitleParts_(SURVEY.applyG.blocks.find(b => b.id === 'GE4'))").hint === '');
  const nv = { '申込者の名前(フルネーム)': ['山田 花子'], 'お子様の名前(フルネーム)': ['山田 太郎'] };
  const out = E.run('normalizeApplyNamed_')(E.run('SURVEY.apply'), nv);
  t('申込フォーム: 題名が文言のみでも、内部の「ID. 文言」に戻して処理できる', out['AP1. 申込者の名前(フルネーム)'][0] === '山田 花子' && out['CH1. お子様の名前(フルネーム)'][0] === '山田 太郎');
  t('申込フォームの題名に、設問番号(AP1.など)が付かない', E.run("SURVEY.apply.blocks.filter(b => b.type === 'q').map(b => b.text).every(x => !/^[A-Z_0-9]+\\.\\s/.test(x))"));
  const seen = {}; let dup = false; E.run("SURVEY.apply.blocks.filter(b => b.type === 'q').map(b => applyTitleParts_(b).title)").forEach(x => { if (seen[x]) dup = true; seen[x] = 1; });
  t('申込フォーム内で、設問の文言が重複しない(番号なしでも区別できる)', !dup);
}

{ // アンケートの回答サイト(申込者のメールアドレスで入室。同じアドレスで、回答者を切り替える)
  const E = makeEnv('');
  E.addFamily({}); // F0001: 申込者 hanako@example.com / お子様のメールアドレスは聞かない
  const login = (m) => E.run('surveyLogin')(m);
  let r = login('hanako@example.com');
  t('サイト入室: 案内を送る前は、アンケートが出ない(登録済みでも、同じ案内文)', !r.ok && /見つかりません/.test(r.message));
  t('サイト入室: メールの形式が不正ならエラー・未登録も同じ案内文(登録の有無を教えない)', !login('xxx').ok && /見つかりません/.test(login('nobody@example.com').message));
  E.roster.values[1][E.rc('T0')] = '2026-11-01T10:00:00';
  r = login('Hanako@Example.com');
  t('サイト入室: 申込者のメールアドレス(大文字小文字は区別しない)で入り、回答者(申込者・お子様)が選べる', r.ok && /^[0-9a-f]{64}$/.test(r.token) && r.options.length === 2 && r.options[0].role === 'parent' && r.options[1].role === 'child' && r.options.every(o => o.state === 'due' && o.form.charAt(1) === 'T0'.charAt(1) || o.state === 'due') && r.options[0].form === 'PT0' && r.options[1].form === 'CT0' && /太郎/.test(r.options[1].label));
  const fullAns = (def) => { const a = {}; def.blocks.filter(b => b.type === 'q' && b.required).forEach(q => { a[q.id] = q.kind === 'multi' ? [q.choices[q.choices.length - 1]] : q.kind === 'age' ? '13' : q.choices[0]; }); return a; };
  const stNoSel = E.run('surveySubmit')(r.token, {});
  t('サイト送信: 回答者を選ぶ前の送信は、受け付けない', !stNoSel.ok && /回答者を選んで/.test(stNoSel.message));
  t('サイト入室: 子ども用のメールアドレス(登録していない)では入れない', !login('taro@example.com').ok);
  const sc = E.run('surveyStart')(r.token, 'F0001', 'child');
  t('サイト開始: お子様を選ぶと、お子様用T0(CT0)が出る。調査用IDは画面に出ず、題名に番号が付かない', sc.ok && sc.def.key === 'CT0' && sc.who === '太郎' && sc.def.blocks.filter(b => b.type === 'q').every(b => b.id !== 'RID') && sc.def.blocks.every(b => !/^[A-Z][A-Za-z0-9_\-]*\.\s/.test(b.title || b.text)));
  const ans = Object.assign(fullAns(sc.def), { EVIL: 'x' });
  const missing = E.run('surveySubmit')(r.token, {});
  t('サイト送信: 未回答の必須の設問があると、記録せずに、案内を返す', !missing.ok && /まだ答えていない質問/.test(missing.message) && E.subs.values.length === 1);
  const before = E.subs.values.length;
  const sr = E.run('surveySubmit')(r.token, ans);
  const row = E.subs.values[E.subs.values.length - 1];
  t('サイト送信: お子様のアンケートが、回答DBに記録される(調査用ID=F0001、フォーム=CT0)。長い形式の回答も入る', sr.ok && E.subs.values.length === before + 1 && row[2] === 'F0001' && row[4] === 'CT0' && E.long.values.length > 1 && E.long.values.some(x => x[1] === 'F0001' && x[5] === 'S1' && x[7] === 4));
  t('サイト送信: 送信後の選択肢は、お子様=回答済み、申込者=回答できる(同じアドレスで、続けて切り替えられる)', sr.options.find(o => o.role === 'child').state === 'done' && sr.options.find(o => o.role === 'parent').state === 'due');
  t('サイト送信: 受付確認のメールは、申込者のアドレスに届く(お子様の回答でも)。回答内容は載らない', E.sent.some(m => m.to === 'hanako@example.com' && /お子様用/.test(m.subject) && /受け付け/.test(m.subject + m.body)) && !E.sent.some(m => /少しそう思う/.test(m.body)));
  const again = E.run('surveySubmit')(r.token, ans);
  t('サイト送信: 回答済みのあと、同じ合い鍵での再送信は受け付けない(二重送信なし)', !again.ok && E.subs.values.length === before + 1);
  const sp = E.run('surveyStart')(r.token, 'F0001', 'parent');
  t('サイト開始: 続けて申込者を選ぶと、申込者用T0(PT0)が出る', sp.ok && sp.def.key === 'PT0' && sp.who === '花子');
  const srp = E.run('surveySubmit')(r.token, fullAns(sp.def));
  t('サイト送信: 申込者の回答も記録され、すべて回答済みになる', srp.ok && srp.options.every(o => o.state === 'done') && E.subs.values.some(x => x[2] === 'F0001' && x[4] === 'PT0'));
  t('サイト開始: 回答済みの方は、もう一度選べない', !E.run('surveyStart')(r.token, 'F0001', 'child').ok && !E.run('surveyStart')(r.token, 'F0009', 'child').ok && !E.run('surveyStart')(r.token, 'F0001', 'x').ok);
  r = login('hanako@example.com');
  t('サイト入室: すべて回答したあとは「回答ありがとう・いまのアンケートはなし」', !r.ok && r.done === true && /ありません/.test(r.message));
  E.roster.values[1][E.rc('T1')] = '2026-11-10T10:00:00';
  r = login('hanako@example.com');
  t('サイト入室: 次の案内(T1)を送ると、続けて、申込者用T1(PT1)・お子様用T1(CT1)が選べる(進捗に合わせて変わる)', r.ok && r.options[0].form === 'PT1' && r.options[1].form === 'CT1');
  t('サイト送信: 偽の合い鍵は拒否', !E.run('surveySubmit')('0'.repeat(64), ans).ok && !E.run('surveySubmit')('zz', ans).ok && !E.run('surveyStart')('zz', 'F0001', 'parent').ok);
  // 辞退・削除済み
  E.roster.values[1][E.rc('status')] = '辞退';
  t('サイト入室: 辞退した家庭は入れない', !login('hanako@example.com').ok);
  // 回数制限
  const E2 = makeEnv(''); let blocked = false;
  for (let i = 0; i < 14; i++) { const x = E2.run('surveyLogin')('probe@example.com'); if (/何度も/.test(x.message || '')) blocked = true; }
  t('サイト入室: 同じメールアドレスの連続入力は、回数が制限される', blocked);
  // 回答の整形
  const nv = E.run('sanitizeSurveyAnswers_')('CT0', 'F0001', { S1: '偽の選択肢', B2: 'x', 'B2-2': ['家族との会話', '偽', 'わからない'] });
  const nvp = E.run('sanitizeSurveyAnswers_')('PT0', 'F0001', { PA2: '偽の学年' });
  const nvp2 = E.run('sanitizeSurveyAnswers_')('PT0', 'F0001', { PA2: '小学5年' });
  t('回答の整形: 学年は選択肢の値のみ・選択肢にない値は空・複数選択は有効な選択肢だけ。「わからない」(排他)は単独になる', nvp[Object.keys(nvp).find(k => /^PA2\./.test(k))][0] === '' && nvp2[Object.keys(nvp2).find(k => /^PA2\./.test(k))][0] === '小学5年' && nv['S1. 自分の性格や特徴について理解している。'][0] === '' && nv[Object.keys(nv).find(k => /^B2-2\./.test(k))][0] === 'わからない' && nv[Object.keys(nv).find(k => /^RID\./.test(k))][0] === 'F0001');
  // 案内メール(サイトURL)
  const mails = E.run('buildLinkEmails_')('T0', { name: '山田 花子', email: 'hanako@example.com', childName: '太郎', sessionDate: '' }, { parent: 'https://site.example/exec?page=survey' });
  t('案内メール(サイト版): ページのURLと、入力するメールアドレスを載せる', /page=survey/.test(mails.parent.body) && /hanako@example\.com/.test(mails.parent.body) && /回答する方\(申込者・お子様\)を選んで/.test(mails.parent.body) && !mails.child && !/forms\.example/.test(mails.parent.body));
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
  const run = { withSuccessHandler(f) { pending = { ok: f }; return run; }, withFailureHandler(f) { pending.ng = f; return run; }, surveyLogin(v) { calls.push(['login', v]); }, surveyStart(tok, id, role) { calls.push(['start', tok, id, role]); }, surveySubmit(tok, a) { calls.push(['submit', tok, a]); } };
  const win = vm.createContext({ document: doc, window: { pageYOffset: 0, scrollTo() {} }, google: { script: { run } }, alert: (m) => calls.push(['alert', m]) });
  win.window.scrollTo = () => {}; win.scrollTo = () => {}; win.pageYOffset = 0;
  vm.runInContext(src, win);
  const find = (n, f, out = []) => { if (f(n)) out.push(n); n.children.forEach(c => find(c, f, out)); return out; };
  const text = (n) => [n._text].concat(...n.children.map(text)).join('|');
  const btn = (label) => find(ids.app, n => n.tag === 'button' && n._text === label)[0];
  const input = find(ids.app, n => n.tag === 'input')[0];
  input.value = 'hanako@example.com'; btn('はじめる').onclick();
  t('画面(アンケート): 申込者のメールアドレスを入れて「はじめる」で surveyLogin が呼ばれる', calls[0][0] === 'login' && calls[0][1] === 'hanako@example.com');
  pending.ok({ ok: false, message: '見つかりません' });
  t('画面(アンケート): 入れなかったときは、案内文が表示される', /見つかりません/.test(text(ids.app)));
  const opts = [{ id: 'F0001', role: 'parent', label: '申込者(山田 花子 様)', state: 'due', time: 'T2', form: 'PT2' }, { id: 'F0001', role: 'child', label: 'お子様(山田 太郎 さん)', state: 'due', time: 'T2', form: 'CT2' }];
  btn('はじめる').onclick(); pending.ok({ ok: true, token: 'T'.repeat(64), options: opts });
  const bs = find(ids.app, n => n.tag === 'button' && /に回答する$/.test(n._text));
  t('画面(アンケート): 入室すると、申込者・お子様の、回答者の選択が出る(同じメールアドレスのまま切り替えられる)', bs.length === 2 && /申込者/.test(text(ids.app)) && /お子様\(山田 太郎/.test(text(ids.app)) && /お子様ご本人に/.test(text(ids.app)));
  bs[1].onclick();
  t('画面(アンケート): お子様を選ぶと surveyStart(合い鍵, ID, child) が呼ばれる', calls.some(c => c[0] === 'start' && c[1] === 'T'.repeat(64) && c[2] === 'F0001' && c[3] === 'child'));
  pending.ok({ ok: true, who: '太郎', def });
  t('画面(アンケート): 入室すると、アンケートの題名と説明・「はじめる」ボタンが出る', /対話プログラムについてのアンケート/.test(text(ids.app)) && !!btn('アンケートをはじめる'));
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
  pending.ok({ ok: true, options: [Object.assign({}, opts[0]), Object.assign({}, opts[1], { state: 'done' })] });
  t('画面(アンケート): 送信が済むと、お礼と、回答者の選択(お子様=回答済み・申込者=回答できる)に戻る', /ご回答ありがとうございました/.test(text(ids.app)) && /回答済み/.test(text(ids.app)) && find(ids.app, n => n.tag === 'button' && /に回答する$/.test(n._text)).length === 1);
}
{ // セッション終了ボタン
  const E = makeEnv('me@example.com'); E.addFamily({}); E.addFamily({ id: 'G0001', category: 'general', cemail: '' });
  const r = E.run('apiEndSession')('F0001');
  t('セッション終了: 終了日時が名簿に記録され、受講後(T1)のアンケートの案内が、申込者に1通届く', String(E.roster.values[1][E.rc('ended')]).length > 10 && String(E.roster.values[1][E.rc('T1')]).length > 10 && E.sent.length === 1 && E.sent[0].to === 'hanako@example.com' && /受講後/.test(E.sent[0].subject) && /送りました/.test(r.message));
  const r2 = E.run('apiEndSession')('F0001');
  t('セッション終了: 2回目は、T1を二重に送らない', E.sent.length === 1 && /すでに送信済み/.test(r2.message));
  t('セッション終了: 進路相談以外・辞退した家庭・存在しないIDはエラー', !!throws(() => E.run('apiEndSession')('G0001')) && !!throws(() => E.run('apiEndSession')('F0099')));
  E.addFamily({ id: 'F0002', pemail: 'p2@example.com', cemail: 'c2@example.com', status: '辞退' });
  t('セッション終了: 辞退した家庭は送らない', !!throws(() => E.run('apiEndSession')('F0002')) && E.sent.length === 1);
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
{ // 受講日に合わせた自動配信
  const E = makeEnv('me@example.com');
  const plan = (rows, today, done = {}, sch) => E.run('autoPlan_')(rows, sch || E.run('SCHEDULE_DEFAULT'), today, done).map(x => x.id + ':' + x.kind).join(',');
  const fam = (o) => Object.assign({ id: 'F0001', category: 'career', status: '参加中', email: 'p@example.com', childEmail: 'c@example.com', sessionDate: '2026-12-10', sent: { T0: '', T1: '', T2: '' } }, o || {});
  t('自動配信の計画: 鑑定の7日前 → リマインド', plan([fam()], '2026-12-03') === 'F0001:remind7');
  t('自動配信の計画: 鑑定の3日前 → 受講前アンケート(T0)の案内(リマインドは送信済みの場合)', plan([fam()], '2026-12-07', { 'F0001|remind7': true }) === 'F0001:T0');
  t('自動配信の計画: 鑑定の前日 → 前日リマインド', plan([fam({ sent: { T0: 'x', T1: '', T2: '' } })], '2026-12-09', { 'F0001|remind7': true }) === 'F0001:remind1');
  t('自動配信の計画: 受講日 → 受講後アンケート(T1)の案内', plan([fam({ sent: { T0: 'x', T1: '', T2: '' } })], '2026-12-10', { 'F0001|remind7': true, 'F0001|remind1': true }) === 'F0001:T1');
  t('自動配信の計画: 鑑定の90日後 → 3か月後アンケート(T2)。89日後はまだ', plan([fam({ sent: { T0: 'x', T1: 'x', T2: '' } })], '2027-03-10', { 'F0001|remind7': true, 'F0001|remind1': true }) === 'F0001:T2' && plan([fam({ sent: { T0: 'x', T1: 'x', T2: '' } })], '2027-03-09', { 'F0001|remind7': true, 'F0001|remind1': true }) === '');
  t('自動配信の計画: 日数が空く日は何もしない(鑑定の5日前)', plan([fam()], '2026-12-05', { 'F0001|remind7': true }) === '');
  t('自動配信の計画: 受講日の入力が遅れても(2日前)、受講前アンケートをすぐ送る。前日リマインドは、まだ', plan([fam()], '2026-12-08', { 'F0001|remind7': true }) === 'F0001:T0');
  t('自動配信の計画: 送信済み・辞退・受講日なし・メールなし・一般/法人・テストIDは対象外', plan([fam({ sent: { T0: 'x', T1: '', T2: '' } }), fam({ id: 'F0002', status: '辞退' }), fam({ id: 'F0003', sessionDate: '' }), fam({ id: 'F0004', email: '' }), fam({ id: 'G0001', category: 'general' }), fam({ id: 'F9999' })], '2026-12-07', { 'F0001|remind7': true }) === '');
  t('自動配信の計画: 設定で「無効」なら何も送らない。日数は設定で変えられる', plan([fam()], '2026-12-07', {}, { enabled: false, remind7: 7, t0: 3, remind1: 1, t1: 0, t2: 90 }) === '' && plan([fam()], '2026-12-05', { 'F0001|remind7': true }, { enabled: true, remind7: 7, t0: 5, remind1: 1, t1: 0, t2: 90 }) === 'F0001:T0');
  t('設定シートから、日数・有効/無効を読む(空欄・不正値は既定)', JSON.stringify(E.run('getSchedule_')(E.reg)) === JSON.stringify({ enabled: true, remind7: 7, t0: 3, remind1: 1, t1: 0, t2: 90 }));
  t('管理画面の予定: 受講日から、日付つきで出る', /2026-12-03 リマインド/.test(E.run('autoScheduleText_')(fam(), E.run('SCHEDULE_DEFAULT'), {})) && /2026-12-07 受講前アンケート/.test(E.run('autoScheduleText_')(fam(), E.run('SCHEDULE_DEFAULT'), {})) && /2027-03-10 3か月後アンケート/.test(E.run('autoScheduleText_')(fam(), E.run('SCHEDULE_DEFAULT'), {})) && /受講日を入力すると/.test(E.run('autoScheduleText_')(fam({ sessionDate: '' }), E.run('SCHEDULE_DEFAULT'), {})));
}
{ // 自動配信の実行(メールと記録)
  const E = makeEnv('me@example.com'); E.addFamily({});
  const today = E.run('todayStr_')();
  const setSession = (n) => { E.roster.values[1][E.rc('session')] = E.run('addDays_')(today, n); };
  setSession(3);
  let r = E.run('runAutomation_')(E.reg, E.db);
  t('自動配信: 鑑定の3日前に、受講前アンケートの案内が、申込者に1通届き、送信日時が記録される(リマインドも同時に1回)', E.sent.filter(m => /アンケートのご案内/.test(m.subject)).length === 1 && String(E.roster.values[1][E.rc('T0')]).length > 10 && E.sent.some(m => /受講日のご案内/.test(m.subject) && m.to === 'hanako@example.com') && E.sent.some(m => m.to === 'op@example.com' && /自動配信の結果/.test(m.subject)));
  const n = E.sent.length;
  E.run('runAutomation_')(E.reg, E.db);
  t('自動配信: 同じ日にもう一度実行しても、二重には送らない', E.sent.length === n);
  setSession(1);
  const before = E.sent.length;
  E.run('runAutomation_')(E.reg, E.db);
  const rem = E.sent.slice(before).filter(m => /明日は受講日/.test(m.subject));
  t('自動配信: 鑑定の前日に、前日リマインド(申込者宛)。受講前アンケートが未回答なら、回答のお願いが入る', rem.length === 1 && /まだお済みでない/.test(rem[0].body));
  setSession(0);
  E.run('runAutomation_')(E.reg, E.db);
  t('自動配信: 受講日に、受講後アンケート(T1)の案内が届く(送信日時が記録される)', String(E.roster.values[1][E.rc('T1')]).length > 10);
  E.roster.values[1][E.rc('session')] = E.run('addDays_')(today, -90);
  E.run('runAutomation_')(E.reg, E.db);
  t('自動配信: 鑑定の90日後に、3か月後アンケート(T2)の案内が届く', String(E.roster.values[1][E.rc('T2')]).length > 10);
  // B7 未入力
  const E2 = makeEnv('me@example.com'); E2.addFamily({}); E2.reg.getSheetByName('設定').values[6][1] = '';
  E2.roster.values[1][E2.rc('session')] = E2.run('addDays_')(E2.run('todayStr_')(), 3);
  const r2 = E2.run('runAutomation_')(E2.reg, E2.db);
  t('自動配信: B7(サイトのURL)が未入力なら、アンケートの案内は送らず、運営に知らせる(リマインドは送る)', E2.roster.values[1][E2.rc('T0')] === '' && E2.sent.some(m => /受講日のご案内/.test(m.subject)) && E2.sent.some(m => m.to === 'op@example.com' && /B7/.test(m.body)));
  // 無効
  const E3 = makeEnv('me@example.com'); E3.addFamily({}); E3.reg.getSheetByName('設定').values[7][1] = '無効';
  E3.roster.values[1][E3.rc('session')] = E3.run('addDays_')(E3.run('todayStr_')(), 3);
  E3.run('runAutomation_')(E3.reg, E3.db);
  t('自動配信: 設定が「無効」なら、何も送らない', E3.sent.length === 0);
  t('管理者以外は、自動配信を手動で実行できない', /管理者のみ/.test(throws(() => makeEnv('x@example.com').run('runAutomationNow')()) || ''));
}
{ // メール文面の編集
  const E = makeEnv('me@example.com');
  const defaults = E.run('getTemplates_')(E.reg);
  t('文面: 「メール文面」シートが無くても、既定の文面で動く(5種類。申込者宛のみ)', Object.keys(defaults).length === 5 && /{{宛名}}/.test(defaults.T0_parent.body));
  const sh = E.reg.add('メール文面', ['キー', '送り先', '件名', '本文', 'メモ']);
  sh.values.push(['T0_parent', '申込者', '【編集した件名】{{アンケート名}}', '{{宛名}}、編集した本文です。{{アンケートURL}} {{知らない差し込み}}', ''], ['remind1_child', 'お子様', '', '', '']);
  const m = E.run('buildLinkEmails_')('T0', { name: '山田 花子', email: 'h@example.com', childName: '太郎', sessionDate: '2026-12-10' }, { parent: 'https://site.example/x' }, E.run('getTemplates_')(E.reg));
  t('文面: シートで編集した件名・本文が使われ、{{差し込み}}が置きかわる。知らない差し込みは、そのまま残る', m.parent.subject === '【編集した件名】受講前' && m.parent.body === '山田 花子 様、編集した本文です。https://site.example/x {{知らない差し込み}}');
  t('文面: 空欄の項目は、既定の文面に戻る。他の文面は、変わらない', E.run('getTemplates_')(E.reg).remind1_parent.body === defaults.remind1_parent.body && /お子様ご本人に/.test(E.run('getTemplates_')(E.reg).T1_parent.body));
  t('文面: 既定の文面に、費用・謝礼・円の記載がない', !/費用|謝礼|円/.test(JSON.stringify(Object.values(defaults))));
}
{ // メールの折り返し・未回答の一言
  const E = makeEnv('me@example.com');
  E.run('sendMail_')('a@example.com', '件名', 'こんにちは。これは長い一文です。\n次の行です。\nhttps://site.example/exec?page=survey\n<script>x</script>');
  const m = E.sent[0];
  t('メール: HTML本文も付く(画面の幅に合わせて自然に折り返す)。改行は<br>、URLはリンク、記号は無害化される', /<br>/.test(m.htmlBody) && /<a href="https:\/\/site\.example\/exec\?page=survey">/.test(m.htmlBody) && !/<script>/.test(m.htmlBody) && /&lt;script&gt;/.test(m.htmlBody) && /line-height/.test(m.htmlBody) && /^こんにちは/.test(m.body));
  const p = { name: '山田 花子', email: 'h@example.com', childName: '太郎', childEmail: 'c@example.com', sessionDate: '2026-12-10' };
  const urls = { parent: 'https://site.example/x?page=survey' };
  const t0 = E.run('buildLinkEmails_')('T0', p, urls), t1 = E.run('buildLinkEmails_')('T1', p, urls);
  t('文面: 受講前アンケートの案内に、「未回答の方に関しては、算命学の鑑定結果には反映されません」の一言が入る。受講後(T1)には入らない', /※未回答の方に関しては、算命学の鑑定結果には反映されません。/.test(t0.parent.body) && !/反映されません/.test(t1.parent.body));
  t('文面: 一言が空の回(T1・T2)でも、空行が3つ以上続かない', !/\n{3,}/.test(t1.parent.body));
  const sentences = [t0.parent.body].join('\n').split('\n').filter(l => l.trim() !== '');
  const brokenMid = sentences.filter(l => /[ぁ-んァ-ン一-龠]$/.test(l) && !/^(■|【)/.test(l) && !/(様|さん)$/.test(l) && l.length > 28);
  t('文面: 文章の途中で改行しない(長い一文は、1行のまま)', brokenMid.length === 0, brokenMid.join(' | '));
}
{ // 追加の受講の料金(人数・お一人ずつ)
  const base = { PN0: 'パートナーは参加しない', AP1: '山田 花子', AP6: '女性', AP7: '19850612', AP2: 'ex1@example.com', AP3: 'ex1@example.com', AP8: 'l', AP10: '追加しました', AP11: 'ナシ', CH1: '山田 太郎', CH2: '男性', CH3: '20100315', CH4: 'ex2@example.com', CH5: 'ex2@example.com', CONSENT_ALL: '全てに同意しました' };
  const go = (o) => { const E = makeEnv(''); return { E, r: E.run('submitApplication')('career', Object.assign({}, base, o), '') }; };
  const { r: r0 } = go({});
  t('追加の受講なし: 鑑定料30,000円のみ', r0.ok && r0.fee.length === 1 && /30,000円/.test(r0.fee[0]));
  const { E, r: r1 } = go({ EX0: '2名', EX1: '山田 次郎/男性/19800101/大人の方・オンライン鑑定料(+20,000円)\n山田 三郎/男性/20150101/お子様・レポートのみ(+5,000円)' });
  t('追加2名(大人オンライン+20,000円・お子様レポート+5,000円): 合計55,000円が先頭、内訳に鑑定料・お一人ずつの内容・追加料金25,000円', r1.ok && r1.fee[0] === '合計:55,000円' && /鑑定料:30,000円/.test(r1.fee.join()) && /山田 次郎 さん\(大人の方・オンライン鑑定料/.test(r1.fee.join()) && /山田 三郎 さん\(お子様・レポートのみ/.test(r1.fee.join()) && /追加料金:25,000円/.test(r1.fee.join()));
  t('追加の受講: 受付メールの本文・HTMLに合計と内訳が入る。名簿に、名前・内容・原文が入る', E.sent.some(m => m.to === 'ex1@example.com' && /合計:55,000円/.test(m.body) && /55,000円/.test(m.htmlBody) && /追加料金/.test(m.htmlBody)) && E.roster.values[1][E.rc('exName')] === '山田 次郎、山田 三郎' && /山田 次郎\/男性\/19800101/.test(E.roster.values[1][E.rc('targets')]));
  t('追加の受講: 人数と入力数の不一致・内容の不正・追加なしなのに入力あり は受け付けない', !go({ EX0: '2名', EX1: '山田 次郎/男性/19800101/大人の方・レポート作成料(+5,000円)' }).r.ok && !go({ EX0: '1名', EX1: '山田 次郎/男性/19800101/偽の内容' }).r.ok && !go({ EX0: '追加なし', EX1: '山田 次郎/男性/19800101/大人の方・レポート作成料(+5,000円)' }).r.ok && !go({ EX0: '1名', EX1: '山田 次郎/男性/1980/大人の方・レポート作成料(+5,000円)' }).r.ok);
}
{ // パートナーの方のアンケート
  const E = makeEnv('');
  E.addFamily({ pjoin: 'はい', ppname: '山田 次郎', ppgender: '男性', ppbirth: '19830101' });
  E.roster.values[1][E.rc('T0')] = '2026-11-01T10:00:00';
  const r = E.run('surveyLogin')('hanako@example.com');
  t('パートナー: 参加する家庭は、回答者の選択肢が3つ(申込者・お子様・パートナーの方)', r.ok && r.options.map(o => o.role).join() === 'parent,child,partner' && /次郎 様/.test(r.options[2].label) && r.options[2].form === 'PP0');
  const fullAns = (def) => { const a = {}; def.blocks.filter(b => b.type === 'q' && b.required).forEach(q => { a[q.id] = q.kind === 'multi' ? [q.choices[q.choices.length - 1]] : q.kind === 'age' ? '13' : q.choices[0]; }); return a; };
  const sp = E.run('surveyStart')(r.token, 'F0001', 'partner');
  t('パートナー: 選ぶと、申込者用と同じ設問(受講の理由・目的を除く)のPP0が出る(題名は「パートナー用」)', sp.ok && sp.def.key === 'PP0' && sp.who === '次郎' && /パートナー用/.test(sp.def.title) && sp.def.blocks.filter(b => b.type === 'q').length === E.run('surveyClientDef_')('PT0').blocks.filter(b => b.type === 'q').length - 3);
  const sr = E.run('surveySubmit')(r.token, fullAns(sp.def));
  const row = E.subs.values[E.subs.values.length - 1];
  t('パートナー: 回答は、フォームID=PP0・回答者区分=パートナー・同じ調査用IDで記録される。申込者(PT0)とは別に数えられる', sr.ok && row[2] === 'F0001' && row[3] === 'パートナー' && row[4] === 'PP0' && sr.options.find(o => o.role === 'partner').state === 'done' && sr.options.find(o => o.role === 'parent').state === 'due');
  t('パートナー: 受付確認は申込者のアドレスに「パートナーの方用」として届く', E.sent.some(m => m.to === 'hanako@example.com' && /パートナーの方用/.test(m.subject)));
  const sp2 = E.run('surveyStart')(r.token, 'F0001', 'parent');
  const sr2 = E.run('surveySubmit')(r.token, fullAns(sp2.def));
  t('パートナー: 申込者の回答も、続けて同じアドレスで記録できる(別々の回答として、重複扱いにならない)', sr2.ok && E.subs.values.filter(x => x[2] === 'F0001' && /^(PT0|PP0)$/.test(x[4]) && x[6] === 'TRUE').length === 2);
  const E2 = makeEnv(''); E2.addFamily({ pjoin: 'いいえ' }); E2.roster.values[1][E2.rc('T0')] = '2026-11-01T10:00:00';
  const r2 = E2.run('surveyLogin')('hanako@example.com');
  t('パートナー: 参加しない家庭は、選択肢が2つだけ。パートナーとしては始められない', r2.options.length === 2 && !E2.run('surveyStart')(r2.token, 'F0001', 'partner').ok);
  // 申込サイト
  const E3 = makeEnv('');
  const base = { PN0: 'パートナーも参加する', PN1: '山田 次郎', PN2: '男性', PN3: '19830101', AP1: '山田 花子', AP6: '女性', AP7: '19850612', AP2: 'pn@example.com', AP3: 'pn@example.com', AP8: 'l', AP10: '追加しました', AP11: 'ナシ', CH1: '山田 太郎', CH2: '男性', CH3: '20100315', CONSENT_ALL: '全てに同意しました' };
  const a = E3.run('submitApplication')('career', base, '');
  t('パートナー: 申込サイトで「はい」+情報を送ると、名簿に入る', a.ok && E3.roster.values[1][E3.rc('pjoin')] === 'はい' && E3.roster.values[1][E3.rc('ppname')] === '山田 次郎');
  const E4 = makeEnv('');
  t('パートナー: 「はい」なのに情報がないと、受け付けない', !E4.run('submitApplication')('career', Object.assign({}, base, { PN1: '', AP2: 'pn2@example.com', AP3: 'pn2@example.com' }), '').ok);
  const pg = E3.run('doGet')({ parameter: { cat: 'career' } });
  t('パートナー: 申込ページに、参加の質問と、条件付きのパートナー情報(はい の場合のみ)がある', /パートナーの方も、本プロジェクトに参加しますか/.test(pg.html) && /パートナーの方の情報/.test(pg.html) && /"conditional":true/.test(pg.html));
}
{ // 設問にお名前(さん)を入れる
  const E = makeEnv('');
  E.addFamily({ pjoin: 'はい', ppname: '山田 次郎', ppgender: '男性', ppbirth: '19830101' });
  E.roster.values[1][E.rc('T0')] = '2026-11-01T10:00:00';
  const r = E.run('surveyLogin')('hanako@example.com');
  const texts = (def) => def.blocks.map(b => (b.text || '') + ' ' + (b.title || '') + ' ' + (b.desc || '')).join('\n') + '\n' + def.intro;
  const sp = E.run('surveyStart')(r.token, 'F0001', 'parent');
  t('お名前: 申込者用の設問に、お子様のお名前+さんが入る(「太郎さんの性格や特徴を理解している」)。{{ }}は残らない', /太郎さんの性格や特徴を理解している/.test(texts(sp.def)) && !/\{\{/.test(texts(sp.def)) && !/子ども/.test(sp.def.blocks.filter(b => b.type === 'q').map(b => b.text).join('')));
  const sc = E.run('surveyStart')(r.token, 'F0001', 'child');
  t('お名前: お子様用の設問では、「親」のかわりに、申込者のお名前+さん(「花子さんが何を大切にしているのか…」)。「親子」は変えない', /花子さんが何を大切にしているのか理解している/.test(texts(sc.def)) && /親子相互理解/.test(texts(sc.def)) && !/\{\{/.test(texts(sc.def)));
  const spp = E.run('surveyStart')(r.token, 'F0001', 'partner');
  t('お名前: パートナーの方の設問にも、お子様のお名前+さんが入る', /太郎さんの性格や特徴を理解している/.test(texts(spp.def)));
  t('お名前: 選択肢には、お名前を入れない(回答内容として保存されるため)', JSON.stringify(sp.def.blocks.filter(b => b.type === 'q').map(b => b.choices)).indexOf('山田') === -1);
  const fullAns = (def) => { const a = {}; def.blocks.filter(b => b.type === 'q' && b.required).forEach(q => { a[q.id] = q.kind === 'multi' ? [q.choices[q.choices.length - 1]] : q.kind === 'age' ? '13' : q.choices[0]; }); return a; };
  E.run('surveySubmit')(r.token, fullAns(spp.def));
  const dbText = JSON.stringify(E.subs.values) + JSON.stringify(E.long.values) + JSON.stringify(E.opts.values);
  t('お名前: 回答DB(Submissions・Long・LongOptions)には、お名前が入らない', dbText.indexOf('山田') === -1 && dbText.indexOf('次郎') === -1 && E.subs.values.some(x => x[3] === 'パートナー'));
  const nameless = E.run('surveyClientDef_')('PT0', {});
  t('お名前: 名前がないときは「お子様」と表示する(Googleフォーム版・名前未登録)', /お子様の性格や特徴を理解している/.test(texts(nameless)) && /申込者の方が何を大切にしている/.test(texts(E.run('surveyClientDef_')('CT0', {}))));
  t('お名前: コードブックの設問文は、名前なしの形(お子様)で出る', E.run('buildCodebookRows_')().some(r => /お子様の性格や特徴を理解している/.test(String(r[5]))) && !E.run('buildCodebookRows_')().some(r => /\{\{/.test(String(r[5]))));
}
{ // 受講の理由・目的(申込者のみ)
  const E = makeEnv('');
  E.addFamily({ pjoin: 'はい', ppname: '山田 次郎', ppgender: '男性', ppbirth: '19830101' });
  E.roster.values[1][E.rc('T0')] = '2026-11-01T10:00:00';
  const r = E.run('surveyLogin')('hanako@example.com');
  const qs = (def) => def.blocks.filter(b => b.type === 'q').map(b => b.id);
  const sa = E.run('surveyStart')(r.token, 'F0001', 'parent');
  t('受講の理由・目的: 申込者の受講前アンケートに、理由・目的(PW1)と理想の状態(PW2)が出る', qs(sa.def).indexOf('PW1') !== -1 && qs(sa.def).indexOf('PW2') !== -1 && /受講するに至った理由・目的/.test(JSON.stringify(sa.def)) && /受講後の理想の状態/.test(JSON.stringify(sa.def)));
  const sc = E.run('surveyStart')(r.token, 'F0001', 'child');
  const sp = E.run('surveyStart')(r.token, 'F0001', 'partner');
  t('受講の理由・目的: お子様用・パートナー用には出ない', qs(sc.def).indexOf('PW1') === -1 && qs(sp.def).indexOf('PW1') === -1 && qs(sp.def).indexOf('PW2') === -1);
  const ans = (def) => { const a = {}; def.blocks.filter(b => b.type === 'q' && b.required).forEach(q => { a[q.id] = q.kind === 'multi' ? [q.choices[q.choices.length - 1]] : q.kind === 'age' ? '13' : q.choices[0]; }); return a; };
  const e1 = E.run('surveyStart')(r.token, 'F0001', 'parent');
  const sr = E.run('surveySubmit')(r.token, Object.assign(ans(e1.def), { PW1: '対話の時間を持ちたいため', PW2: '家族で将来の話ができる' }));
  t('受講の理由・目的: 記述が自由記述として記録される(回答DBの Long に、自由記述フラグ付き)', sr.ok && E.long.values.some(x => x[5] === 'PW1' && /対話の時間/.test(String(x[6])) && String(x[10]) === '1') || E.long.values.some(x => x[5] === 'PW1' && /対話の時間/.test(String(x[6]))));
  const sr2 = E.run('surveyStart')(r.token, 'F0001', 'child');
  const srr = E.run('surveySubmit')(r.token, ans(sr2.def));
  t('受講の理由・目的: 空のままでも(任意)、回答できる。お子様用は、問題なく送信できる', srr.ok);
  t('申込者: 画面の呼び方が「申込者」になっている(「保護者」という言葉が、設問・案内に残らない)', !/保護者/.test(JSON.stringify(sa.def)) && !/保護者/.test(E.run('getTemplates_')(E.reg).T0_parent.body) && E.run('surveyOptions_')([E.run('readRoster_')(E.reg)[0]], {}).every(o => !/保護者/.test(o.label)));
}
{ // コードブックの更新
  const E = makeEnv('me@example.com');
  const cb = E.db.add('コードブック', null);
  cb.values = [['古い見出し'], ['古い行']];
  E.run('refreshCodebook')();
  t('コードブックの更新: 回答DBのコードブックが、現在の設問(申込者用・パートナー用を含む)で書き直される。お名前の差し込み記号は残らない', cb.values.length === E.run('buildCodebookRows_')().length && cb.values[0][0] === '設問ID' && cb.values.some(r => r[1] === 'PP0' && r[2] === 'パートナー') && cb.values.some(r => r[1] === 'PT0' && r[2] === '申込者') && !cb.values.some(r => /\{\{/.test(String(r[5]))) && !/古い/.test(JSON.stringify(cb.values)));
  t('コードブックの更新: 管理者以外は実行できない', /管理者のみ/.test(throws(() => makeEnv('x@example.com').run('refreshCodebook')()) || ''));
}
{ // お名前は、同じ文の中で1回だけ
  const E = makeEnv('');
  const named = (key, id, vars) => E.run('surveyClientDef_')(key, vars).blocks.find(b => b.id === id).text;
  const v = { child: '林 巫心', parent: '林 竜輔' };
  t('お名前: 同じ文でお名前が2回出るときは、2回目を「ご本人」にする(「巫心さんと自分の考え方が違うとき、ご本人がなぜそう考えるのか…」)', named('PT0', 'PO5', v) === '巫心さんと自分の考え方が違うとき、ご本人がなぜそう考えるのか理解しようとしている。');
  t('お名前: 「子ども自身の」も、2回目は「ご本人の」(「…考えるとき、ご本人の希望や気持ちを…」)', /^巫心さんが将来について考えるとき、ご本人の希望や気持ちを大切にしたいと思う。$/.test(named('PT0', 'PZ1', v)));
  t('お名前: 名前がないときも、1回目は「お子様」、2回目は「ご本人」', named('PT0', 'PO5', {}) === 'お子様と自分の考え方が違うとき、ご本人がなぜそう考えるのか理解しようとしている。');
  const all = ['CT0', 'CT1', 'CT2', 'PT0', 'PT1', 'PT2', 'PP0'].map(k => E.run('surveyClientDef_')(k, v).blocks.filter(b => b.type === 'q').map(b => b.text).join('\n')).join('\n');
  t('お名前: どの設問でも、同じ文に、お名前が2回出ない', !all.split('\n').some(l => (l.match(/巫心さん/g) || []).length > 1 || (l.match(/竜輔さん/g) || []).length > 1));
}
{ // 名前(下の名)だけを表示
  const E = makeEnv('');
  t('お名前(下の名): 「林 巫心」→「巫心」。スペース(全角も)で、姓と名を分ける。スペースがなければ、そのまま', E.run('givenName_')('林 巫心') === '巫心' && E.run('givenName_')('林　巫心') === '巫心' && E.run('givenName_')('林巫心') === '林巫心' && E.run('givenName_')('') === '');
  const d = E.run('surveyClientDef_')('PT0', { child: '林 巫心', parent: '林 竜輔' });
  const pg = d.blocks.filter(b => b.type === 'page').map(b => b.title);
  t('お名前(下の名): 設問・ページの題名に、苗字が出ない(「巫心さんの意思決定への支援」)', pg.indexOf('巫心さんの意思決定への支援') !== -1 && !/林/.test(JSON.stringify(d)));
  const pgApply = E.run('publicSiteData_')('career').cats[0].blocks.find(b => b.id === 'AP1');
  t('申込: お名前の欄に、「姓と名の間にスペース」の案内がある(申込者・お子様・パートナー)', /スペースを入れてください/.test(pgApply.help) && /スペースを入れてください/.test(E.run('publicSiteData_')('career').cats[0].blocks.find(b => b.id === 'CH1').help) && /スペースを入れてください/.test(E.run('publicSiteData_')('career').cats[0].blocks.find(b => b.id === 'PN1').help));
}
{ // 回答後の編集(申込者のみ)
  const E = makeEnv('');
  E.addFamily({ pjoin: 'はい', ppname: '山田 次郎', ppgender: '男性', ppbirth: '19830101' });
  E.roster.values[1][E.rc('T0')] = '2026-11-01T10:00:00';
  const login = () => E.run('surveyLogin')('hanako@example.com');
  const fullAns = (def) => { const a = {}; def.blocks.filter(b => b.type === 'q' && b.required).forEach(q => { a[q.id] = q.kind === 'multi' ? [q.choices[q.choices.length - 1]] : q.choices[0]; }); return a; };
  let r = login();
  const sp = E.run('surveyStart')(r.token, 'F0001', 'parent');
  const ans = Object.assign(fullAns(sp.def), { PW1: '最初の理由', PX2: 'はい', PX2t: '明るい' });
  const sr = E.run('surveySubmit')(r.token, ans);
  const popt = sr.options.find(o => o.role === 'parent');
  t('編集: 申込者は、回答済みのあとに「修正できる」(canEdit)。お子様・パートナーには、その表示がない', popt.state === 'done' && popt.canEdit === true && popt.editForm === 'PT0' && sr.options.filter(o => o.role !== 'parent').every(o => !o.canEdit));
  const before = E.subs.values.filter(x => x[2] === 'F0001' && x[4] === 'PT0').length;
  const ed = E.run('surveyStart')(r.token, 'F0001', 'parent', true);
  t('編集: 修正を始めると、前回の回答が入った状態(prior)で開く(選択・自由記述・複数選択とも)', ed.ok && ed.edit === true && ed.prior.PW1 === '最初の理由' && ed.prior.PX2 === 'はい' && ed.prior.PX2t === '明るい' && ed.prior.S1 === undefined && ed.def.key === 'PT0');
  const ans2 = Object.assign({}, ans, { PW1: '修正した理由', PX2: 'わからない' });
  delete ans2.PX2t;
  const er = E.run('surveySubmit')(r.token, ans2);
  const rows = E.subs.values.filter(x => x[2] === 'F0001' && x[4] === 'PT0');
  const longPW1 = E.long.values.filter(x => x[1] === 'F0001' && x[3] === 'PT0' && x[5] === 'PW1');
  t('編集: 修正を送信すると、前回の回答が置き換わる(回答の件数は増えない。新しい内容が1件だけ残る)', er.ok && er.edited === true && before === 1 && rows.length === 1 && longPW1.length === 1 && longPW1[0][6] === '修正した理由' && E.long.values.filter(x => x[1] === 'F0001' && x[3] === 'PT0' && x[5] === 'PX2t')[0][9] === '非表示(分岐)');
  t('編集: 修正後も、「回答済み」のまま(続けて、もう一度修正もできる)。お子様の回答には影響しない', er.options.find(o => o.role === 'parent').state === 'done' && E.run('surveyStart')(er.options ? r.token : r.token, 'F0001', 'parent', true).ok);
  t('編集: お子様・パートナーの方の回答は、回答後に開けない・修正できない(回答を見られないように)', !E.run('surveyStart')(r.token, 'F0001', 'child', true).ok && !E.run('surveyStart')(r.token, 'F0001', 'partner', true).ok && /開いたり、修正したり/.test(E.run('surveyStart')(r.token, 'F0001', 'child', true).message));
  const E2 = makeEnv(''); E2.addFamily({}); E2.roster.values[1][E2.rc('T0')] = '2026-11-01T10:00:00';
  const r2 = E2.run('surveyLogin')('hanako@example.com');
  t('編集: まだ回答していない申込者は、修正を始められない', !E2.run('surveyStart')(r2.token, 'F0001', 'parent', true).ok);
  const bad = E.run('surveyStart')('zz', 'F0001', 'parent', true);
  t('編集: 偽の合い鍵では開けない', !bad.ok);
}
{ // 画面: 回答済み → 修正
  const E = makeEnv('');
  const def = E.run('surveyClientDef_')('PT0', { child: '太郎', parent: '花子' });
  const pg = E.run('surveyPage_')();
  const src = pg.slice(pg.indexOf('<script>') + 8, pg.lastIndexOf('</script>'));
  const mk = (tag) => { const e = { tag, children: [], style: {}, _text: '', className: '', disabled: false, value: '', checked: false, classList: { toggle() {}, add() {}, remove() {} }, querySelector() { return null; }, scrollIntoView() {}, appendChild(c) { this.children.push(c); return c; }, set innerHTML(v) { this.children = []; this._text = ''; }, get innerHTML() { return ''; }, set textContent(v) { this._text = String(v); }, get textContent() { return this._text; } }; return e; };
  const ids = { app: mk('app'), foot: mk('foot') };
  const doc = { createElement: mk, getElementById: (id) => ids[id] || (ids[id] = mk(id)) };
  const calls = []; let pending = null;
  const run = { withSuccessHandler(f) { pending = { ok: f }; return run; }, withFailureHandler(f) { pending.ng = f; return run; }, surveyLogin(v) { calls.push(['login', v]); }, surveyStart(tok, id, role, edit) { calls.push(['start', id, role, edit]); }, surveySubmit(tok, a) { calls.push(['submit', a]); } };
  const win = vm.createContext({ document: doc, window: { pageYOffset: 0, scrollTo() {} }, google: { script: { run } }, alert() {} });
  win.window.scrollTo = () => {}; win.scrollTo = () => {};
  vm.runInContext(src, win);
  const find = (n, f, out = []) => { if (f(n)) out.push(n); n.children.forEach(c => find(c, f, out)); return out; };
  const text = (n) => [n._text].concat(...n.children.map(text)).join('|');
  find(ids.app, n => n.tag === 'input')[0].value = 'a@b.c'; find(ids.app, n => n.tag === 'button' && n._text === 'はじめる')[0].onclick();
  pending.ok({ ok: true, token: 'T'.repeat(64), options: [{ id: 'F0001', role: 'parent', label: '申込者(花子 様)', state: 'done', time: '', form: '', canEdit: true, editForm: 'PT0', editTime: 'T0' }, { id: 'F0001', role: 'child', label: 'お子様(太郎 さん)', state: 'due', time: 'T0', form: 'CT0' }] });
  const eb = find(ids.app, n => n.tag === 'button' && n._text === '回答を修正する');
  t('画面: 回答済みの申込者に「回答を修正する」ボタンが出る(お子様には出ない)', eb.length === 1 && /回答済み/.test(text(ids.app)));
  eb[0].onclick();
  t('画面: 押すと surveyStart(合い鍵, ID, parent, 修正=true) が呼ばれる', calls.some(c => c[0] === 'start' && c[1] === 'F0001' && c[2] === 'parent' && c[3] === true));
  pending.ok({ ok: true, edit: true, who: '花子', prior: { PA1: '母親', PW1: '前回の理由' }, def });
  const radios = find(ids.app, n => n.tag === 'input' && n.type === 'radio');
  const sel = radios.filter(r => r.checked).map(r => r.value);
  t('画面: 修正画面は、最初のページから開き、前回の選択が入っている(「母親」が選ばれている)', sel.indexOf('母親') !== -1 && !find(ids.app, n => n.tag === 'button' && n._text === 'アンケートをはじめる').length);
}
{ // お名前のスペース(必須)
  const E = makeEnv('');
  t('お名前: 姓と名の間のスペース(半角・全角)の有無を判定する', E.run('hasNameSpace_')('林 巫心') && E.run('hasNameSpace_')('林　巫心') && !E.run('hasNameSpace_')('林巫心') && !E.run('hasNameSpace_')(''));
  const base = { PN0: 'パートナーは参加しない', AP1: '林 竜輔', AP6: '男性', AP7: '20000218', AP2: 'sp@example.com', AP3: 'sp@example.com', AP8: 'l', AP10: '追加しました', AP11: 'ナシ', CH1: '林 巫心', CH2: '女性', CH3: '20120607', CONSENT_ALL: '全てに同意しました' };
  t('お名前: スペースがない申込者・お子様の名前は受け付けず、理由を知らせる', !E.run('submitApplication')('career', Object.assign({}, base, { AP1: '林竜輔' }), '').ok && /スペースを入れて/.test(E.run('submitApplication')('career', Object.assign({}, base, { CH1: '林巫心' }), '').errors.join()) && E.roster.values.length === 1);
  t('お名前: スペースがあれば受け付ける', E.run('submitApplication')('career', base, '').ok);
  const E2 = makeEnv('');
  t('お名前: パートナーの名前も、スペースが必要', !E2.run('submitApplication')('career', Object.assign({}, base, { AP2: 'sp2@example.com', AP3: 'sp2@example.com', PN0: 'パートナーも参加する', PN1: '林菜月', PN2: '女性', PN3: '19980406' }), '').ok);
}
console.log('\n' + pass + ' passed / ' + fail + ' failed');
process.exit(fail ? 1 : 0);
