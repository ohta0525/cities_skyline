// dist/ のビルドを、ダブルクリックで開ける 1 つの HTML ファイルにまとめる。
// 使い方：npm run build:single → download/mizuho-city.html
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const dist = 'dist';
let html = readFileSync(join(dist, 'index.html'), 'utf8');
const assets = readdirSync(join(dist, 'assets'));

html = html.replace(/<link rel="stylesheet"[^>]*href="\.\/assets\/([^"]+\.css)"[^>]*>/g, (_, f) =>
  `<style>${readFileSync(join(dist, 'assets', f), 'utf8')}</style>`);
html = html.replace(/<script type="module"[^>]*src="\.\/assets\/([^"]+\.js)"[^>]*><\/script>/g, (_, f) => {
  // スクリプトの中の「</script」で HTML が切れないようにする
  const js = readFileSync(join(dist, 'assets', f), 'utf8').replace(/<\/script/gi, '<\\/script');
  return `<script type="module">${js}</script>`;
});
if (/src="\.\/assets\//.test(html) || /href="\.\/assets\//.test(html)) {
  console.error('まとめきれないファイルがあります:', assets.join(', '));
  process.exit(1);
}
mkdirSync('download', { recursive: true });
const out = join('download', 'mizuho-city.html');
writeFileSync(out, html);
console.log(`${out}（${Math.round(html.length / 1024)} KB）`);
