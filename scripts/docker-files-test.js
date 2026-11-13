// 驗收測試：Docker 與 docker compose 一行啟動、發佈映像、CI 三平台（檔案內容檢查；測試不跑 Docker、不連 GitHub）
// 實際 build 與啟動在開發時驗過：docker compose up 後 admin 登入、非 root、資料在 volume、重啟資料還在、ADMIN_PASSWORD、健康檢查
// 1. Dockerfile：Node 22 官方映像、非 root 執行、資料在 /data volume、啟動 server.js、有健康檢查
// 2. docker-compose.yml：3000 埠、volume、ADMIN_PASSWORD 等環境變數有設才帶
// 3. .dockerignore 排除 data、.aigile、node_modules、密鑰檔
// 4. README 的快速開始是 Docker，本機第二、Cloudflare 放後面
// 5. 打 v* 標籤自動建 amd64／arm64 映像推到 ghcr.io，標版本號與 latest；README 中英文都有「不用 clone 直接用映像」（docker run 與 compose，資料掛 volume）
// 6. CI 在 ubuntu、windows、macos 跑全部測試（Node 22），檢查 checkout 是 LF、找得到瀏覽器
// 用法：node scripts/docker-files-test.js
import fs from 'node:fs';
import assert from 'node:assert';

const read = f => fs.readFileSync(new URL('../' + f, import.meta.url), 'utf8');
try {
  const df = read('Dockerfile');
  assert.match(df, /^FROM node:22(-alpine|-slim)?\s*$/m, 'Node 22 官方映像');
  assert.match(df, /^USER node\s*$/m, '非 root 執行');
  assert.ok(df.indexOf('USER node') > df.indexOf('chown node:node /data'), '先把 /data 給 node 使用者再切換');
  assert.match(df, /DATA_DIR=\/data/, '資料放 /data');
  assert.match(df, /VOLUME \["\/data"\]/, '/data 是 volume');
  assert.match(df, /EXPOSE 3000/);
  assert.match(df, /HEALTHCHECK[\s\S]*\/api\/health/, '健康檢查');
  assert.match(df, /CMD \["node", "server\.js"\]/);
  assert.ok(!df.split(/\r?\n/).some(l => !l.trim().startsWith('#') && /npm (install|ci)/.test(l)), '零相依，不用 npm install');

  const dc = read('docker-compose.yml');
  assert.match(dc, /"\$\{HOST_PORT:-3000\}:3000"/, '3000 埠（可換）');
  assert.match(dc, /aigile-data:\/data/, '資料放 volume');
  assert.match(dc, /^volumes:\s*\n\s+aigile-data:/m, '宣告 volume');
  for (const v of ['ADMIN_PASSWORD', 'ROOM_CODE', 'OPEN_JOIN', 'UPDATE_CHECK']) assert.match(dc, new RegExp(`^\\s+- ${v}\\s*$`, 'm'), `${v} 有設才帶進容器`);
  assert.ok(!dc.split(/\r?\n/).some(l => !l.trim().startsWith('#') && /ADMIN_PASSWORD\s*[:=]\s*\S/.test(l)), 'compose 裡不寫死密碼');

  const di = read('.dockerignore').split(/\r?\n/).map(l => l.trim());
  for (const x of ['data/', '.aigile/', 'node_modules/', '.git/', '.env', '.dev.vars']) assert.ok(di.includes(x), '.dockerignore 排除 ' + x);

  const readme = read('README.md');
  assert.match(readme, /## 快速開始（Docker）[\s\S]*docker compose up -d[\s\S]*## 本機啟動[\s\S]*## 進階：部署到 Cloudflare/, 'README：Docker 第一、本機第二、Cloudflare 放後面');
  const rel = read('.github/workflows/release.yml');
  assert.match(rel, /^on:\s*\n\s+push:\s*\n\s+tags: \['v\*'\]/m, '發佈：打 v* 標籤觸發');
  assert.match(rel, /^\s+packages: write\s*$/m, '發佈：GITHUB_TOKEN 可寫 packages');
  for (const a of ['docker/login-action@', 'docker/metadata-action@', 'docker/build-push-action@', 'docker/setup-qemu-action@', 'docker/setup-buildx-action@']) assert.ok(rel.includes('uses: ' + a), '發佈用 ' + a);
  assert.match(rel, /registry: ghcr\.io/, '發佈：登入 ghcr.io');
  assert.match(rel, /images: ghcr\.io\/\$\{\{ github\.repository \}\}/, '發佈：映像名 ghcr.io/<owner>/<repo>');
  assert.match(rel, /type=semver,pattern=\{\{version\}\}/, '發佈：標版本號（v1.0.3 → 1.0.3）');
  assert.match(rel, /latest=auto/, '發佈：標 latest');
  assert.match(rel, /platforms: linux\/amd64,linux\/arm64/, '發佈：amd64 與 arm64');
  assert.ok(rel.indexOf('/api/health') > 0 && rel.indexOf('/api/health') < rel.indexOf('push: true'), '發佈：推之前先啟動檢查健康');
  assert.match(rel, /GITHUB_REF_NAME#v[\s\S]*package\.json|package\.json[\s\S]*GITHUB_REF_NAME#v/, '發佈：標籤要等於 package.json 版本');
  for (const [f, title, compose] of [['README.md', '不用 clone', '用 compose'], ['README.en.md', 'Without cloning', 'With compose']]) {
    const r = read(f), i = r.indexOf(title);
    assert.ok(i > 0, f + '：有「不用 clone 直接用映像」');
    const sec = r.slice(i, r.indexOf('</details>', i));
    assert.match(sec, /docker run -d[^\n]*-v aigile-data:\/data[\s\S]*?ghcr\.io\/alansid\/aigile-oss:latest/, f + '：docker run 掛 volume、用 ghcr 映像');
    assert.ok(sec.includes(compose), f + '：有 compose 寫法');
    assert.match(sec, /image: ghcr\.io\/alansid\/aigile-oss:latest[\s\S]*- aigile-data:\/data[\s\S]*^volumes:\s*\n\s+aigile-data:/m, f + '：compose 用 ghcr 映像、資料掛 volume');
  }

  const ci = read('.github/workflows/ci.yml');
  assert.match(ci, /os: \[ubuntu-latest, windows-latest, macos-latest\]/, 'CI：三個平台');
  assert.match(ci, /runs-on: \$\{\{ matrix\.os \}\}/, 'CI：照 matrix 跑');
  assert.match(ci, /fail-fast: false/, 'CI：一個平台失敗其他照跑');
  assert.match(ci, /node-version: 22/, 'CI：Node 22');
  assert.match(ci, /git ls-files --eol[\s\S]*w\/crlf/, 'CI：檢查 checkout 是 LF');
  assert.match(ci, /findBrowser/, 'CI：找不到瀏覽器就失敗，不默默略過畫面測試');
  assert.match(ci, /npm test/);
  console.log('docker-files-test：全部通過');
} catch (e) {
  console.error('docker-files-test 失敗：', e.message);
  process.exitCode = 1;
}
