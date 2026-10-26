'use strict';
/* Inline the libraries and game scripts into one index.html for GitHub Pages:
 * one file means a phone can never mix an old script with a new page. */
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, ...p), 'utf8');

let html = read('src', 'page.html');
const parts = {
  '/*__PEERJS__*/': read('vendor', 'peerjs.min.js'),
  '/*__QRCODE__*/': read('vendor', 'qrcode.js'),
  '/*__ENGINE__*/': read('src', 'engine.js'),
  '/*__NET__*/': read('src', 'net.js'),
  '/*__UI__*/': read('src', 'ui.js')
};
for (const [marker, code] of Object.entries(parts)) {
  if (!html.includes(marker)) throw new Error('missing marker ' + marker);
  // a literal "</script" inside inlined code would end the tag early
  const safe = code.replace(/<\/script/gi, '<\\/script');
  html = html.replace(marker, () => safe);
}
const out = path.join(__dirname, process.argv[2] || 'index.html');
fs.writeFileSync(out, html);
console.log('built ' + path.relative(__dirname, out) + ' ' + (html.length / 1024).toFixed(1) + ' KB');
