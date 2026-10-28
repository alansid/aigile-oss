# 參與開發

謝謝你願意幫忙！這份文件說明怎麼在本機跑起來、怎麼測試、送 PR 前要注意什麼。參與本專案請遵守[行為準則](CODE_OF_CONDUCT.md)。

## 本機開發

需要 Node.js 22.13 以上（建議 24）。程式只用 Node 內建模組，**不需要 `npm install`**。

```bash
npm start      # http://localhost:3000，資料存在 ./data
```

第一次打開會自動建好「預設專案」和管理員帳號 admin／admin（第一次登入要先改帳號和密碼）。測試模式（`AIGILE_TEST_PROJECTS=1`，或直接呼叫 `createApp`）不建預設管理員，第一位註冊的人就是管理員。

## 測試

```bash
npm test                 # 全部測試（約 4 分鐘），最後列出沒過的
npm test -- skill        # 只跑檔名含 skill 的測試
node scripts/<名稱>-test.js   # 單獨跑一支
```

- 測試會在暫存資料夾開獨立的本機伺服器，不會碰你的 `./data`。
- 需要兩個專案的測試會設 `AIGILE_TEST_PROJECTS=1`，讓伺服器先建「預設專案」「第二專案」兩個固定代號的專案。
- 檔名結尾是 `-ui-test.js` 的是畫面測試，會用無頭的 Chrome 或 Edge；找不到瀏覽器就自動略過。
- 測試只呼叫本機的程式，**不要**寫會連到正式環境的測試。

## 送 PR 前

1. `npm test` 全部通過。
2. 新功能或修 bug 附一支測試：修 bug 的測試要在修正前會失敗。
3. 改了給 AI 看的規則（`docs/ai-integration.md` 或接入設定），注意字數上限：規格 20,000 字內、接入設定 5,000 字內（`doc-rules-test` 會檢查）。
4. 註解只說明程式在做什麼、為什麼這樣做；不要寫人名、內部卡號或對話編號。
5. 改了 `public/` 底下給 AI 下載的腳本（`watcher.mjs`、`aigile-setup.mjs` 等），雜湊會自動重算，不用手改。
6. 新增或修改網頁上的中文（`public/app.js`、`index.html`、伺服器回的錯誤訊息），要在 `public/i18n/en.js` 補英文（中文原文當 key，用詞照開頭的用詞表）；`node scripts/i18n-scan.js` 列出還沒翻的，`i18n-test` 會擋。訊息內文、協定標籤（`[接單]`、`[完成]`…）不翻。

## 資料表變更

以 1.0 的 `src/schema.sql` 為基準，改資料表一定要兩件一起做：

1. 在 `migrations/` 新增 `NNN_說明.sql`：三位數編號接著最後一個（001 起）、英文小寫說明，例 `001_add_nickname.sql`。已經發佈的升級檔只增不改；要修就再加一個。
2. 把 `src/schema.sql` 改成最新的完整結構（全新的站直接用它建表，現有升級會標成已套、不重跑），全部用 `IF NOT EXISTS`。

- Docker／本機（`node server.js`）啟動時自動套沒套過的，每個升級一個交易；失敗會整個回復、印出檔名與原因、停止啟動。已套過的記在資料庫的 `schema_migrations` 表。
- Cloudflare D1：`npm run cf:db:migrate` 一次套完（`npm run deploy` 也會先跑）；`-- --local` 對本機模擬的 D1。
- 測試：`migrations-test` 會檢查全新站、從 1.0 升級、重複啟動不重跑、失敗回復；`schema-test` 檢查 `schema.sql` 有包含升級檔加的每個欄位與索引。新增升級檔時在 `migrations-test` 或另一支測試裡驗一次「舊資料升級後還在、程式讀得到新欄位」。

## 發佈後要人工確認

測試沒辦法真的按「部署到 Cloudflare」與連 GitHub，第一次公開 push 或改了 `wrangler.toml`、`package.json` 的 `deploy`／`cloudflare` 後，用一個沒部署過的 Cloudflare 帳號實際走一次：

1. 打開 README 的「Deploy to Cloudflare」按鈕，確認它讀到這個 repo，並列出 D1（`DB`）與 R2（`DOCS`）要新建、說明文字是 `package.json` 的 `cloudflare.bindings`。
2. 確認有要你填 `ADMIN_PASSWORD`、`ROOM_CODE`（來自 `.dev.vars.example`）。
3. 建置紀錄裡 `npm run deploy` 有跑 `node scripts/migrate.js`（印出「全新的 D1：建立資料表」與「完成：資料庫版本 N」），而且成功。
4. 部署完開網址，用 admin 和你填的密碼登入，會要你改帳號密碼，改完出現「第一次設定」。
5. 上傳一份專案文件、下載回來（確認 R2 綁定有效）；發一則訊息、建一張卡。
6. 帳號沒開通 R2 時按鈕會怎樣：照 README 刪掉 `[[r2_buckets]]` 後能部署、其他功能正常。
7. 管理頁「有新版本」：在 GitHub 發一個比目前版本新的 release，管理員打開「成員與權限 › 系統」看得到提示（一天查一次，可設 `UPDATE_CHECK=0` 關掉）。

## 授權

送出的貢獻以本專案的 [MIT 授權](LICENSE) 釋出。
