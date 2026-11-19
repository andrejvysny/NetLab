// The app is published as ONE html file. Hosts that inject markup look for the first "</head>" / "<body" text,
// so those sequences must not appear inside the inlined JavaScript. Escaping them inside string literals is a no-op for JS.
import { readFileSync, writeFileSync } from 'node:fs';

const file = new URL('../dist/index.html', import.meta.url);
let html = readFileSync(file, 'utf8');
const open = html.indexOf('<script type="module"');
const bodyStart = html.indexOf('>', open) + 1;
const end = html.lastIndexOf('</script>');
if (open < 0 || end < bodyStart) throw new Error('postbuild: inline module script not found');
let js = html.slice(bodyStart, end);
const before = js.length;
js = js
  .replace(/<\/(head|body|html|script|style|title)>/gi, '<\\/$1>')
  .replace(/<(head|body|html)([\s>])/gi, '\\x3c$1$2')
  .replace(/<!DOCTYPE/gi, '\\x3c!DOCTYPE');
html = html.slice(0, bodyStart) + js + html.slice(end);
const licenses = ['Lexend','Atkinson','JetBrainsMono'].map(n => n + '\n' + readFileSync(new URL(`../src/ui/fonts/${n}/LICENSE`,import.meta.url),'utf8')).join('\n\n');
const text = licenses.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
html = html.replace('</body>', () => '<template id="bundled-font-notices"><pre>' + text + '</pre></template>\n</body>');
writeFileSync(file, html);
console.log(`postbuild: escaped markup sequences in inline script (${before} → ${js.length} chars)`);
