// 算命学の鑑定 お申込みフォーム: 申込完了メールの自動送信
// Google Apps Script のウェブアプリとして公開して使う(手順は apps-script/README.md)

const OWNER_EMAIL = 'kagami.3588@gmail.com';   // 控えの送り先
const SENDER_NAME = 'KAGAMI';
const SUBJECT = '鑑定お申し込み完了';
const BASE_FEE = 30000;
const EXTRA_FEE = 10000;
const MAX_EXTRA = 10;

// フォームのページを表示する(ウェブアプリのURLを開くと申込フォームが出る)
function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('算命学の鑑定 お申込み')
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
    // 同じアドレスへの連続送信を防ぐ(10分に1通)
    const cache = CacheService.getScriptCache();
    const key = 'sent:' + email.toLowerCase();
    if (cache.get(key)) return reply_({ ok: true, skipped: true });
    cache.put(key, '1', 600);

    const body = buildBody_(d, extras);
    MailApp.sendEmail({
      to: email,
      bcc: OWNER_EMAIL,
      subject: SUBJECT,
      body: body,
      name: SENDER_NAME,
    });
    return reply_({ ok: true });
  } catch (err) {
    return reply_({ ok: false, error: String(err) });
  }
}

function buildBody_(d, extras) {
  const n = extras.length;
  const total = BASE_FEE + n * EXTRA_FEE;
  const yen = v => v.toLocaleString('en-US') + '円';
  const v = x => String(x || '').trim() || '(未入力)';
  const lines = [
    `${v(d.name)} 様`,
    '',
    'この度は、算命学の鑑定にお申し込みいただき、ありがとうございます。',
    'お申し込みを確認しました。',
    '今後のご連絡は、公式LINEにてお送りします。',
    '',
    '■お申し込み内容',
    `お名前：${v(d.name)}`,
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
    lines.push(`追加${i + 1}：${v(p.name)} / ${v(p.gender)} / ${v(p.birth)} / ${v(p.rel)}`);
  });
  lines.push(
    '',
    '■鑑定料',
    `${yen(BASE_FEE)}` + (n ? ` + 追加${n}名 ${yen(n * EXTRA_FEE)}` : ''),
    `お支払い合計：${yen(total)}`,
    '',
    '■お振込先',
    'お振込先は、公式LINEのトーク画面でご案内しています。',
    'LINEに届いていない場合は、公式LINEからお知らせください。',
    '',
    '■オンラインでの鑑定をご希望の方へ',
    '前日までに、個別LINEにてリンクを発行します。',
    '',
    '※追加の方はレポートを作成して、お申込み者にのみ、その方について聞きたいことをお答えします。追加の方との面談は行いません。',
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
