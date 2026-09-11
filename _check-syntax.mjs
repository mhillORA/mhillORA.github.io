import fs from 'fs';
import { parse } from 'acorn';

const html = fs.readFileSync('index.html', 'utf8');
const start = html.indexOf('<script type="module">');
const end = html.lastIndexOf('</script>');
const js = html.slice(start + '<script type="module">'.length, end);

try {
  parse(js, { ecmaVersion: 'latest', sourceType: 'module' });
  console.log('OK: module script parses');
} catch (e) {
  console.error('PARSE ERROR:', e.message);
  const line = e.loc?.line;
  if (line) {
    const lines = js.split('\n');
    for (let i = Math.max(0, line - 4); i < Math.min(lines.length, line + 3); i++) {
      console.log(`${i + 1}: ${lines[i]}`);
    }
  }
  process.exit(1);
}
