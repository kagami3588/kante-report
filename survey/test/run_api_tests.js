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
  const sent = [];
  const reg = new SS('reg'), db = new SS('db');
  const ctxEnv = { console, Logger: { log() {} } };
  const env = vm.createContext(ctxEnv);
  vm.runInContext(code, env);
  const H = (n) => vm.runInContext('HEAD.' + n, env);
  const roster = reg.add('名簿', H('roster'));
  const settings = reg.add('設定', ['項目', '値', '説明']);
  settings.values.push(['安全', 'safe@example.com'], ['代理', ''], ['', ''], ['', ''], ['運営メール', 'op@example.com']);
  const sendlog = reg.add('送信ログ', H('sendlog'));
  reg.add('申込要確認', H('pending')); reg.add('安全対応ログ', H('safety'));
  const subs = db.add('Submissions', H('submissions')), long = db.add('Long', H('long')), opts = db.add('LongOptions', H('options'));
  const resp = db.add('resp_CT0', ['タイムスタンプ', 'RID. 研究用ID(運営から届いた専用リンクで自動入力されます。変更しないでください)', 'S1. x']);
  const rc = (n) => vm.runInContext('RC.' + n, env);
  function addFamily(o) {
    const row = new Array(32).fill('');
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
    Utilities: {
      getUuid: () => 'abcdef12-0000',
      formatDate: (d, tz, fmt) => { const j = new Date(d.getTime() + 9 * 3600 * 1000).toISOString(); return fmt.indexOf('HH') !== -1 ? j.slice(0, 19) : j.slice(0, 10); }
    },
    FormApp: { ItemType: { TEXT: 'TEXT' }, openById: (id) => ({ getItems: () => [{ getTitle: () => 'RID. x', asTextItem: () => ({ createResponse: (v) => ({ id: v }) }) }], createResponse: () => ({ withItemResponse: (r) => ({ toPrefilledUrl: () => 'https://forms.example/' + id + '?rid=' + r.id }) }) }) }
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
  t('API送信: 保護者宛には保護者用リンクのみ、お子様宛にはお子様用リンクのみ', /forms\.example\/f4\?rid=F0001/.test(E.sent[0].body) && !/forms\.example\/f1/.test(E.sent[0].body) && /forms\.example\/f1\?rid=F0001/.test(E.sent[1].body) && !/forms\.example\/f4/.test(E.sent[1].body));
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
  const gsr = () => { let ok, ng; const o = { withSuccessHandler: (f) => { ok = f; return o; }, withFailureHandler: (f) => { ng = f; return o; } }; ['apiSetSessionDate', 'apiSetStatus', 'apiSendLinks', 'apiDeleteFamily'].forEach(n => { o[n] = (...a) => { calls.push([n, a]); ok({ message: n + ' ok', data }); }; }); return o; };
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
    SpreadsheetApp: { getActiveSpreadsheet: () => null, create: (n) => { made.push(n); const ss = new SS(n === '研究台帳' ? 'reg2' : 'db2'); ss.getUrl = () => 'u'; return ss; }, openById: () => null, flush() {} }
  });
  const msg = throws(() => E.run('setup')());
  t('単独のスクリプトで setup() を実行すると、台帳を自動で作ろうとする(「紐づいていません」のエラーにならない)', made[0] === '研究台帳' && !/紐づいていません/.test(msg || ''), msg);
}

console.log('\n' + pass + ' passed / ' + fail + ' failed');
process.exit(fail ? 1 : 0);
