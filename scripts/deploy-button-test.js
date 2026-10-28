// 驗收測試：README「部署到 Cloudflare」按鈕（照官方 Deploy to Cloudflare 格式；測試不連 Cloudflare、不按按鈕）
// 1. README 有官方格式的按鈕，指向 github.com/alansid/aigile-oss；手動部署步驟還在
// 2. wrangler.toml 有 D1（DB）與 R2（DOCS）綁定，資源名稱有預設值（按鈕依此自動建立）
// 3. package.json 的 deploy 先跑 scripts/migrate.js（用綁定名稱 DB：全新的 D1 建表、舊的套升級），再部署
// 4. 要填的密鑰寫在 .dev.vars.example；package.json 的 cloudflare.bindings 有說明
// 5. CONTRIBUTING 列出 push 後要人工驗證的步驟
// 用法：node scripts/deploy-button-test.js
import fs from 'node:fs';
import assert from 'node:assert';

const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
try {
  const readme = read('README.md');
  assert.ok(readme.includes('[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/alansid/aigile-oss)'), '官方格式的按鈕');
  assert.match(readme, /### 手動部署[\s\S]*wrangler@4 d1 create[\s\S]*npm run deploy/, '手動部署步驟還在');

  const toml = read('wrangler.toml');
  assert.match(toml, /\[\[d1_databases\]\]\s*\nbinding = "DB"\s*\ndatabase_name = "aigile-switch"/, 'D1 綁定 DB、有預設名稱');
  assert.match(toml, /\[\[r2_buckets\]\]\s*\nbinding = "DOCS"\s*\nbucket_name = "aigile-switch-docs"/, 'R2 綁定 DOCS、有預設名稱');

  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.deploy, /&& node scripts\/migrate\.js && npx wrangler@4 deploy$/, 'deploy 先建資料表／套升級再部署');
  assert.match(read('scripts/migrate.js'), /'d1', 'execute', 'DB', where/, '升級指令用綁定名稱 DB（一鍵部署建出來的資料庫名稱不固定）');
  const schema = read('src/schema.sql');
  for (const stmt of schema.split(';').map(x => x.replace(/--.*$/gm, '').trim()).filter(Boolean)) {
    assert.match(stmt, /^(CREATE (TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS|INSERT OR IGNORE)/, 'schema.sql 每一句都能重跑：' + stmt.slice(0, 60));
  }
  for (const b of ['DB', 'DOCS', 'ADMIN_PASSWORD', 'ROOM_CODE']) assert.ok(pkg.cloudflare?.bindings?.[b]?.description, `cloudflare.bindings.${b} 有說明`);

  const vars = read('.dev.vars.example');
  assert.match(vars, /^ADMIN_PASSWORD=$/m, '要填 ADMIN_PASSWORD（不放預設值）');
  assert.match(vars, /^ROOM_CODE=$/m);
  assert.ok(!/^\.dev\.vars\.example$/m.test(read('.gitignore')), '.dev.vars.example 要進 git');

  assert.match(read('CONTRIBUTING.md'), /## 發佈後要人工確認[\s\S]*Deploy to Cloudflare[\s\S]*migrate\.js/, 'push 後要人工驗證的步驟');
  console.log('deploy-button-test：全部通過');
} catch (e) {
  console.error('deploy-button-test 失敗：', e.message);
  process.exitCode = 1;
}
