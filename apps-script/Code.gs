// 算命学の鑑定 お申込みフォーム: 申込完了メールの自動送信
// Google Apps Script のウェブアプリとして公開して使う(手順は apps-script/README.md)

const OWNER_EMAIL = 'kagami.3588@gmail.com';   // 控えの送り先
const SENDER_NAME = 'KAGAMI';
const SUBJECT = '鑑定お申し込み完了';
const BASE_FEE = 30000;
const EXTRA_FEE = 10000;
const MAX_EXTRA = 10;
const SHEET_ID = '17ZT9FAZiVv2hxrQzhTxWKu6RDysLiVgkoJQMc2peNJI';   // 申込内容を記録するスプレッドシート
const HEADERS = ['受付日時', '申込コード', '名前', 'フリガナ', '性別', '生年月日', 'メールアドレス', 'Instagram',
  '紹介者', '鑑定で見てほしいこと', '自由記入', '追加人数', '追加の方', '鑑定料合計', '入金確認', '鑑定日', 'メモ'];
const BANK = [
  '普通預金',
  '金融機関名：PayPay銀行',
  '支店名：005ビジネス営業部',
  '口座番号：7332659',
  '口座名義：エンリアライズハヤシリュウスケ',
];

// フォームのページを表示する(ウェブアプリのURLを開くと申込フォームが出る)
// ?page=hayami を付けると、宿命早見のページを表示する
function doGet(e) {
  const hayami = e && e.parameter && e.parameter.page === 'hayami';
  return HtmlService.createHtmlOutputFromFile(hayami ? 'hayami' : 'index')
    .setTitle(hayami ? '宿命早見' : '算命学の鑑定 お申込み')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function doPost(e) {
  try {
    const d = JSON.parse(e.postData.contents);
    const email = String(d.email || '').trim();
    const extras = Array.isArray(d.extras) ? d.extras.slice(0, MAX_EXTRA) : [];

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !String(d.name || '').trim()) {
      return reply_({ ok: false, error: 'invalid' });
    }
    // 同じアドレスへの連続送信を防ぐ(1分に1通。二重クリック対策)
    const cache = CacheService.getScriptCache();
    const key = 'sent:' + email.toLowerCase();
    if (cache.get(key)) {
      console.log('skipped (rate limit): ' + email);
      return reply_({ ok: true, skipped: true });
    }
    cache.put(key, '1', 60);

    // 申込内容を記録する(失敗してもメールは送る)
    try { appendRow_(d, extras, email); } catch (errSheet) { console.error('sheet error: ' + errSheet); }

    const body = buildBody_(d, extras);
    MailApp.sendEmail({
      to: email,
      bcc: OWNER_EMAIL,
      subject: SUBJECT,
      body: body,
      name: SENDER_NAME,
    });
    console.log('sent: ' + email);
    return reply_({ ok: true });
  } catch (err) {
    console.error('error: ' + err);
    // 失敗に気づけるよう、林さんにもお知らせする
    try {
      MailApp.sendEmail(OWNER_EMAIL, '【申込メール送信エラー】', String(err) + '\n\n' + (e && e.postData ? e.postData.contents : ''));
    } catch (err2) {}
    return reply_({ ok: false, error: String(err) });
  }
}

// 初回に1度、エディタから実行して、権限の承認と見出し行の作成をする
function setup() {
  getSheet_();
}

function getSheet_() {
  const sheet = SpreadsheetApp.openById(SHEET_ID).getSheets()[0];
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    // 生年月日などが数値や日付に変わらないよう、文字列の形式にする
    sheet.getRange(1, 1, sheet.getMaxRows(), HEADERS.length).setNumberFormat('@');
  }
  return sheet;
}

function appendRow_(d, extras, email) {
  const n = extras.length;
  const v = x => String(x || '').trim();
  const people = extras.map((p, i) =>
    `${i + 1}. ${v(p.name)}(${v(p.kana)}) / ${v(p.gender)} / ${v(p.birth)} / ${v(p.rel)}`).join('\n');
  const row = [
    Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss'),
    '申込コードP' + (n < 10 ? '0' + n : String(n)),
    v(d.name), v(d.kana), v(d.gender), v(d.birth), email, v(d.insta),
    v(d.referrer), v(d.wish), v(d.free), n + '名', people,
    (BASE_FEE + n * EXTRA_FEE) + '円', '', '', '',
  ];
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    getSheet_().appendRow(row);
  } finally {
    lock.releaseLock();
  }
}

// 宿命早見の意味文を、スプレッドシートの「早見の意味」シートから読み込む
// シートの列: A=区分(日干 / 日支) B=キー(甲, 乙…/ 子, 丑…) C=意味
function getMeanings() {
  const out = {};
  try {
    const sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName('早見の意味');
    if (!sheet) return out;
    sheet.getDataRange().getValues().forEach((r, i) => {
      const kind = String(r[0]).trim(), key = String(r[1]).trim(), text = String(r[2]).trim();
      if (i > 0 && kind && key && text) out[kind + ':' + key] = text;
    });
  } catch (err) {
    console.error('meanings error: ' + err);
  }
  return out;
}

function buildBody_(d, extras) {
  const n = extras.length;
  const total = BASE_FEE + n * EXTRA_FEE;
  const code = '申込コードP' + (n < 10 ? '0' + n : String(n));
  const yen = v => v.toLocaleString('en-US') + '円';
  const v = x => String(x || '').trim() || '(未入力)';
  const lines = [
    `${v(d.name)} 様`,
    '',
    'この度は、算命学の鑑定にお申し込みいただき、ありがとうございます。',
    'お申し込みを確認しました。',
    '今後のご連絡は、公式LINEにてお送りします。',
    '',
    '■申込コード',
    code,
    'まだ公式LINEに送っていない場合は、',
    'この申込コードを、そのまま公式LINEにお送りください。',
    '',
    '■お申し込み内容',
    `お名前：${v(d.name)}（${v(d.kana)}）`,
    `性別：${v(d.gender)}`,
    `生年月日：${v(d.birth)}`,
    `メールアドレス：${email_(d)}`,
    `Instagram：${v(d.insta)}`,
    `紹介者：${v(d.referrer)}`,
    `鑑定で見てほしいこと：${v(d.wish)}`,
    `自由記入：${v(d.free)}`,
    '',
    `■追加でレポートの作成を希望される方：${n}名`,
  ];
  extras.forEach((p, i) => {
    lines.push(`追加${i + 1}：${v(p.name)}（${v(p.kana)}） / ${v(p.gender)} / ${v(p.birth)} / ${v(p.rel)}`);
  });
  lines.push(
    '',
    '■鑑定料',
    `${yen(BASE_FEE)}` + (n ? ` + 追加${n}名 ${yen(n * EXTRA_FEE)}` : ''),
    `お支払い合計：${yen(total)}`,
    '',
    '■お振込先',
  );
  BANK.forEach(l => lines.push(l));
  lines.push(
    '',
    'お振込み後、公式LINEに「振り込みました」とお送りください。',
    '',
    '■オンラインでの鑑定をご希望の方へ',
    '前日までに、個別LINEにてリンクを発行します。',
    '',
    '※追加の方はレポートを作成して、',
    'お申込み者にのみ、その方について聞きたいことをお答えします。',
    '追加の方との面談は行いません。',
    '',
    'ご不明な点は、公式LINEのトーク画面からお問い合わせください。',
    '',
    '運営：KAGAMI',
    '責任者：林 竜輔'
  );
  return lines.join('\n');
}

function email_(d) { return String(d.email || '').trim(); }

function reply_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
