// Builds a single-file standalone HTML (inlines styles.css, script.js, logo) and prints sizes.
import fs from 'fs';
import path from 'path';

const root = process.argv[2] || '.';
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

let html = read('index.html');
const css = read('styles.css');
const js = read('script.js');
const logo = fs.readFileSync(path.join(root, 'logo.jpg')).toString('base64');
const logoUri = `data:image/jpeg;base64,${logo}`;

html = html.replace(/<link rel="stylesheet" href="styles.css" \/>/, `<style>\n${css}\n</style>`);
html = html.replace(/<script src="script\.js"><\/script>/, `<script>\n${js}\n</script>`);
html = html.replace(/src="logo\.jpg"/g, `src="${logoUri}"`);
html = html.replace(/href="logo\.jpg"/g, `href="${logoUri}"`);
html = html.replace('<title>', '<!-- FlowSync standalone build: single file, no local assets required -->\n<title>');

const out = path.join(root, 'flowsync-standalone.html');
fs.writeFileSync(out, html);
console.log('wrote', out, (Buffer.byteLength(html) / 1024).toFixed(1) + ' KB');
console.log('logo inlined:', (logo.length / 1024).toFixed(1) + ' KB base64');
console.log('css bytes:', css.length, 'js bytes:', js.length);
