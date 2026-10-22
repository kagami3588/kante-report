// Survey.gs と Code.gs を1つにまとめた AllInOne.gs を作る(Apps Script に貼り付けるファイルを1つにするため)
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..', 'apps_script');
const out = '// このファイルは tools/bundle.js で自動生成しています(Survey.gs + Code.gs)。\n// Apps Script には、このファイルと appsscript.json の2つを貼り付ければ動きます。\n\n' +
  fs.readFileSync(path.join(root, 'Survey.gs'), 'utf8') + '\n\n' + fs.readFileSync(path.join(root, 'Code.gs'), 'utf8');
fs.writeFileSync(path.join(root, 'AllInOne.gs'), out, 'utf8');
console.log('AllInOne.gs: ' + out.split('\n').length + ' lines');
