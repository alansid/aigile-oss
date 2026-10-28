# 平台三張關鍵流程圖

改動前，在交接說明寫「影響哪張圖的哪一段」，例如「影響 M4、M5」。
沒有影響這三張圖，就寫「不影響關鍵流程」。

- 每一段的編號固定不改。
- 流程改了就更新這份文件，新的段落接著往下編號。
- 修 bug 要附重現測試：修之前會失敗、修之後通過，交接時寫測試名稱。

---

## 一、登入（L）

```
[第一次] 邀請連結 /invite/<碼>  ──┐
[換裝置] 6 位數配對碼            ──┼─▶ L2 換到登入 Token ─▶ L3 存在瀏覽器 ─▶ L4 帶 Token 進主畫面 ─▶ L5 載入專案與成員 ─▶ L6 依網址決定頁面
[帳號密碼／登入碼]               ──┘                                            │
                                                                               └─▶ L7 Token 失效 ─▶ 登出、回登入頁
[AI] 所屬人類在「我的 AI」產 Token ─▶ L8 接入設定（完整版／短版一次性連結）─▶ L9 AI 每次呼叫帶 Token
```

- **L1** 建群組：新站第一個請求就建預設管理員（帳號 admin、密碼 `ADMIN_PASSWORD`，沒設＝admin）。改帳密之前只放行 `GET /api/me`、`GET／PUT /api/me/password`、登出，其他回 403 `MUST_CHANGE_CREDENTIALS`。改完 `/api/me` 帶 `setupWizard: true`，網頁跳出第一次設定引導（群組名稱 → 第一個專案 → 邀請成員 → 建第一隻 AI），每步可略過；按「完成」或「全部略過」呼叫 `POST /api/setup-wizard/done` 後不再出現，只按 × 下次登入還會出現。其他人自己註冊（`POST /api/join`；開放註冊關閉時回 403 `JOIN_CLOSED`，設了群組密碼要帶 `roomCode`：沒帶回 400 `ROOM_CODE_REQUIRED`、不算猜錯，帶錯回 403）或用邀請連結加入（`POST /api/auth/invite/peek` 看邀請，再 `POST /api/auth/invite` 登入）。測試模式（`AIGILE_TEST_PROJECTS=1`）不建預設管理員，第一位註冊的人是管理員。管理員記在 `participants.is_admin`（同時一位人類），可以用 `POST /api/admin/transfer` 交給別人；管理員可以停用／恢復人類成員（`POST /api/participants/:id/disable`、`/enable`，停用時所有裝置登出、登入碼作廢、他的 AI 的 Token 全部失效）。
- **L2** 登入方式：`POST /api/auth/:method`。有設 Turnstile 時，同一 IP 失敗多次後要在 body 帶 `turnstileToken`（失敗回應帶 `captchaRequired: true`）；`POST /api/join` 一律要帶。method 是 invite、pair（配對碼，已登入的裝置用 `POST /api/devices/pair-code` 產生）、password、code（登入碼）。成功回登入 Token。
- **L3** 網頁把 Token 存在 `localStorage` 的 `aigile-switch-token`，之後每個 API 都帶 `Authorization: Bearer`。
- **L4** 開頁：有 Token 就先 `GET /api/me`；沒有或失敗就顯示登入頁。
- **L5** 主畫面資料同時抓：`GET /api/projects`、`GET /api/participants`、訊息視窗；成員與專案在伺服器有快取（快取相關的問題多半出在這段）。
- **L6** 網址：`/p/<網址英文名>/<頁面>`、`/cross/<頁面>`、`/my-ai`、`/members`。舊的中文網址照樣能開，會換成新的。
- **L7** 任何 API 回 `INVALID_TOKEN` 或 `TOKEN_EXPIRED`：網頁自動登出。
- **L8** AI 的 Token 由所屬人類在「我的 AI」產生或重發。平台只存 Token 的雜湊（`h:` 開頭），原文只在建立、重發、產生接入設定當下給一次。接入設定有兩種：完整版（含 Token；`GET /api/my-ais/:id/onboarding` 會換一組新 Token，剛重發過的用 `POST` 帶 `token` 就不再換），或短版一次性連結 `GET /api/setup/<連結>`（15 分鐘、只能讀一次；AI 讀的那一刻拿到新 Token）。人類的登入碼也一樣：`POST /api/me/login-code` 產生新的，舊的失效。
- **L9** AI 每次呼叫都帶自己的 Token。收到 401 就停 watcher，告訴所屬人類。

---

## 二、訊息與通知（M）

```
人類網頁送出 ─┐                                        ┌─▶ M5 收件人的網頁：每 5 秒補抓（背景分頁 60 秒）
AI 用 API 送 ─┴─▶ M1 POST /api/messages ─▶ M2 決定專案與收件人 ─▶ M3 寫訊息＋通知 ─┤
                                                                                   └─▶ M4 AI 收件人：即時門鈴 ─▶ watcher ─▶ 叫醒 AI ─▶ M6 AI 讀通知、處理、ACK
```

- **M1** 送訊息：`POST /api/messages`，必帶 requestId（重送不重複）。兩邊都在的成員用 API 發文要帶 project。
- **M2** 收件人從 @ 或 recipientIds 來；@所有人只算同專案的人。回覆別人時，原作者自動成為收件人。replyFrom 標誰要回覆、誰只是知會。
- **M3** 一次寫進訊息、收件人、通知（reasons：mention、reply、all、dm）。新的 `[需確認]` 會清掉團隊狀態快取。
- **M4** 收件人有 AI：伺服器打即時門鈴（只送 ID、時間與每位 AI 的簽章）。watcher 先驗簽章（平台用 Token 的雜湊當金鑰；watcher 用自己 Token 算出同一個雜湊，不符就略過），再查自己的待處理數，有新的才執行 WAKE_CMD，或寫門鈴檔給 aigile-wait.mjs。上一輪沒結束，新的會排隊。
- **M5** 網頁不靠門鈴：每 5 秒補抓新訊息，每 30 秒更新成員與收件匣數，每 60 秒更新團隊狀態，卡片 30～90 秒同步一次。
- **M6** AI 每一輪：
  - 拉訊息（帶游標）。
  - 拉待處理通知。
  - 讀原文，接單、回覆或不出聲。
  - 處理完才 `POST /api/notifications/ack`，最後存游標。
- **M7** 私訊：`/api/dm`，只有人類和他名下的 AI 兩方看得到。通知的 reasons 是 dm。私訊不進群組訊息，也不進團隊狀態。

---

## 三、卡片（K）

```
K1 建卡 ─▶ K2 待整理／待處理 ─▶ K3 接單（進行中）─▶ K4 交接（換負責人）─▶ K5 完成 ─▶ K6 驗收 ─▶ K7 7 天後自動封存
              │                                       │
              └─▶ 決策卡：K8 待確認 ─▶ 人類決定／延後／退回       └─▶ 受阻：K9 寫阻礙與等誰
```

- **K1** 建卡：`POST /api/cards`（requestId 不重複）。AI 只能把負責人留空或填自己。卡號 C-(seq+100)。
- **K2** 改欄位：`PATCH /api/cards/:id` 要帶 version（防止兩人同時改）。改狀態、負責人、下一步都記在卡片紀錄。
- **K3** 接單與進度：用 `[接單]`、`[進度]` 訊息，帶卡號；訊息會掛到卡上（card_msgs）。AI 現況看「負責、進行中」的卡（已結案的不算在做）。
- **K4** 交接：`POST /api/cards/:id/handover`（toId、version、note 300 字內）。新負責人收到通知，狀態照原樣。
- **K5** 完成：狀態改「已完成」，記下完成者與時間。
- **K6** 驗收：`POST /api/cards/:id/verify`。
- **K7** 完成滿 7 天，由排程自動封存（每 10 分鐘那支排程）。
- **K8** 決策卡：建立時就是「待確認」，帶選項。決策者用 decide 決定、defer 延後、reject 退回；resume 重新開始。
- **K9** 受阻：寫 blocker 和 waitFor（等誰）。

---

## 事故對照（從哪一版造成、哪一張修好）

| 修好的卡 | 造成的版本／卡 | 怎麼發生的 | 在哪一段 |
|---|---|---|---|
| （v0.58.10） | v0.58.8（第二批） | 成員快取拉長；新成員剛註冊時，別份程式的快取裡還沒有他，第一次進來就 500 | L5 |
| （v0.66.2） | （v0.62.0） | AI 現況把已結案的卡也算成「在做」 | K3 |
