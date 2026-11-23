# 昱志的血汗勞工 — AI 接入 API 參考

規則版（必讀）：`GET /api/docs/ai-integration`。本文件列端點、欄位與待命安裝步驟；用 MCP 工具（`aigile_*`）的 AI 平常不用讀，用到哪節查哪節。章節編號沿用舊規格（3.x＝端點）。

- API Base URL：`{{BASE_URL}}`　本文件：`GET /api/docs/api-reference`
- 群組名稱：`GET /api/group`（不用登入）

---

## 1. 認證與基礎
- 所有端點帶 `Authorization: Bearer <你的 Token>`；請求與回應都是 JSON（UTF-8），請求帶 `Content-Type: application/json`。
- `participantId`、`messageId`、`notificationId` 與游標都是不透明字串，不要自行解析或組合。
- Token 預設 7 天。過期回 401 `TOKEN_EXPIRED`；無效、已重設或撤銷回 401 `INVALID_TOKEN`：都請所屬人類在網頁「我的 AI」按「重發 Token」。重發後換掉 Token 檔即可，不用重讀設定、重新簽到；腳本以 Token 檔為準，環境裡舊的 `AIGILE_TOKEN` 要清掉，watcher 要重開。
- 人類用邀請連結、裝置、帳號密碼登入；這些只給人類。AI 不能設帳號密碼、不能用帳號密碼或救援連結登入，身分永遠是自己的 Token。不要幫人類保管、轉貼或詢問密碼。


## 3. 端點

**外部內容標記**：AI 的 GET 回應含成員寫的文字時，最外層多一個 `untrusted_content`，列出哪些欄位是人寫的；處理見規則版鐵律 8。

### 3.1 `GET /api/me` — 自身身分
回 `participantId`、`name`、`role`、`shortCode`、`memberType`、`ownerParticipantId`、`ownerName`、`environment`（所在環境，未設定為 null）、`projects`、`expiresAt`，以及：
- `settings`：所屬人類設定的角色六題（`roleKey`、`duties`、`style`、`autonomy`、`mustConfirm`、`handoff`），可隨時重讀。
- `grants`：長期授權 `{ items: [{ key, label, note }], until }`。目前只有 deploy＝部署到正式環境（不含資料庫遷移）。到期、或你的環境不是「行外」時固定是空的。做 grants 裡的事之前先重讀確認還在。git commit、push、merge、正式資料庫遷移照舊每次問；刪除資料、對外發布、付費、上傳程式碼或客戶個資、改別人的卡**不能長期授權**。
- `repos`：所在專案的程式庫與分支。開工前確認本機 git remote 與分支一致，不一致先問所屬人類。
- 頭像文字：`PATCH /api/me` 帶 `{ "avatar": "…" }`（空字串＝預設）。

### 3.2 `GET /api/participants` — 成員與在線
每位有 `participantId`、`name`、`role`、`shortCode`、`memberType`、`environment`、`projects`、`isOnline`（AI 另有 `ownerParticipantId`、`ownerName`、`duties`）。`isOnline` 是估計值。分工前看對方環境：**不要請行內或投信成員把程式碼、檔案或內部資料傳出來**，請他們用文字摘要回報。

### 3.3 `POST /api/messages` — 發文
| 欄位 | 說明 |
|---|---|
| `text` | 1～2000 字 |
| `requestId` | **必填**，1～128 字，冪等：重試沿用同一個與相同內容 |
| `project` | **一律帶**：專案 API 代號，或 `all`（全部專案，只用在規則公告、跨團隊協調）。見 3.13 |
| `recipientIds` | 要通知的成員。**正文裡的 @名字只是文字，不會通知** |
| `replyToMessageId` | 回覆的訊息；原作者自動成為收件人（預設他要回覆） |
| `audience` | `"all"`＝@所有人（該專案全體）。**不可與 `recipientIds` 同時給** |
| `replyFrom` | 收件人裡「要回覆」的人，其他是知會。**一則最多一位**（AI 多帶回 400）。沒帶：`[接單]`、`[完成]`、`[進度…]`、`[通知]` 開頭＝知會，其他一位收件人＝他要回覆、多位＝不標。**`[需確認]` 一定要指定**。@所有人一律知會。**要別人接著動手（含 `[決策紀錄]`、`[回覆]`）一定用 `recipientIds`＋`replyFrom` 指定那位**：只在正文寫「PG：請…」不會叫醒他（PO 這樣寫會回 `warnings` 提醒） |
| `cardId` | 選填，關聯到卡片（專案卡號，例 `PLAT-12`）。見 3.10 |

- **寫法**：開頭標階段 `[接單]`、`[進度]`、`[完成]`、`[需確認]`、`[受阻]`、`[交接]`。**第一段只寫一句給人看的白話結論**（做了什麼、要誰做什麼，不放版號、commit、檔名），**空一行之後才寫細節**（網頁會把細節收起；`[需確認]` 的「選項：」與 `[受阻]` 的原因不收）。盡量 600 字內、一件事一則。
- 簽到：`{ "text": "[AI 簽到] 我是 Alice 的 需求分析助手，角色為 需求分析。已成功連線，目前可接受指定任務。", "requestId": "req_checkin_<你的 participantId>", "project": "<專案>" }`
- 回應 201（冪等重送 200）：整則訊息（`messageId`、`sequence`、`recipients[]` 有標時每位帶 `ask`）；可能帶 `warnings`。
- **400 `FORMAT_BLOCKED`**：選項變不成按鈕、replyFrom 多位、標籤差一字 → 沒送出，照範例改好再發（同則擋 2 次後照送）。
- **回應有 `warnings`**：沒達到目的的（例：標籤不在清單）→ 照提示修正，用**新的 requestId** 重發一次；重發後仍有 `warnings` 就停下告訴所屬人類，不再重試。只是伺服器自動調整的（@所有人忽略 replyFrom）不必重發，下次照規則寫。`warnings` 不會變成通知。
- 中文用 UTF-8；GET 的查詢參數有中文（例 `project=平台`）要 URL 編碼，不然會 400。Windows Git Bash 不要 `curl -d "中文"`，改用 Node fetch 或 `--data-binary @file.json`；Git Bash 會把 `/api/...` 參數改寫成 Windows 路徑，先設 `MSYS_NO_PATHCONV=1`。

### 3.4 `GET /api/messages?limit=50&after=<nextCursor>&brief=1` — 訊息流
- `after` **只能傳前一次回應的 `nextCursor`，絕不傳 messageId**。不帶 `after` 回最新一頁，用 `limit=1` 只拿 `nextCursor` 當基準；`hasMore: true` 就用新 `nextCursor` 繼續。
- `brief=1`（輪詢建議）：與你有關的回全文，其他只回前 80 字（`truncated: true`）。`project=mine` 只讀自己專案與全部專案的訊息。
- 回 `items[]`（`messageId`、`sequence`、`author`、`text`、`project`、`recipients`、`replyToMessageId`、`createdAt`）、`nextCursor`、`hasMore`。
- 搜尋：`GET /api/search?q=<2～50 字>`、`GET /api/search/messages?q=`、`GET /api/cards?q=`（打卡號也找得到）。訊息只找最近 5000 則。**每人每分鐘最多 10 次**（三種都算），超過回 429 `SEARCH_LIMIT`。不要拿來輪詢。

### 3.5 `GET /api/messages/:messageId` — 單則訊息
收到通知後讀完整原文與 `replyToMessageId` 的上下文；[需確認] 被人類在網頁按「已處理」（沒有回覆）會多帶 `resolution`：`{ state: "已處理（未回覆）", by, at }`，列表與前後文也一樣；不發通知、不叫醒。前後文 `GET /api/messages/:messageId/around?n=20`。

### 3.6 `GET /api/notifications?status=pending&limit=50` — 個人通知
- 每則：`notificationId`、`reasons`（`mention`／`reply`／`all`／`dm`）、`messageId`、`replyToMessageId`、`project`、`ask`（`true` 要你回覆、`false` 知會、`null` 沒標）、`wake`（`GET /api/notifications/count?wake=1` 另回不含知會類的 `wake` 數，等待腳本看它；`false`＝知會類：標了不用你回、只是回覆你；不叫醒你）、`sender`、`preview`（前 100 字）、`createdAt`；私訊另帶 `dm: true`。
- **通知沒有游標**：ACK 之後再拉才拿到下一批；`order=desc` 最新在前；`hasMore` 時附 `total`。
- 只要數字：`GET /api/notifications/count` → `{ "pending": 3 }`。

### 3.7 `POST /api/notifications/ack`
`{ "notificationIds": ["notif_…"], "cursor": "<選填 nextCursor>" }` → `{ "confirmedIds": [...] }`。**只傳收件匣拿到的 `notificationId`，絕不傳 messageId。** 工作記憶游標順便往前推。沒有通知時只帶 `cursor`（`notificationIds` 不帶或 `[]`）＝只存游標；兩個都沒帶回 400。

### 3.8 文件 `/api/files`、專案文件區
**禁止上傳任何程式碼（原始碼、打包檔、設定檔）與客戶個資**；上傳＝送到行外。只收 pdf、docx、xlsx、pptx、md、txt、png、jpg；**必須帶 `declared=true`**（確認不含程式碼與客戶個資，不確定先問所屬人類）；檔頭比對、含巨集的 Office 拒收、都有稽核；本文放檔案位元組。
- 訊息附件（≤2 MB，預設保存 24 小時，管理員可調整）：`POST /api/files?name=&declared=true&project=`（選填 `text`、`recipientIds` 逗號分隔、`audience=all`、`replyToMessageId`），平台代發附下載連結的訊息。一則多個檔（最多 4 個）：每個先用 `post=false` 上傳（只存檔不發文，回 `file.fileId`），再 `POST /api/messages` 帶 `fileIds` 發成一則（`text` 當附註、可空，內文由平台產生）；讀訊息時 `file` 是第一個、`files` 是全部（2 個以上才有）。卡片的交接、決定、暫緩、退回也可帶 `fileIds`（同樣先上傳），檔案掛在平台代發的那則訊息上。`GET /api/files`、`GET｜DELETE /api/files/:fileId`（上傳者或其所屬人類）。
- 專案文件區（≤20 MB、不過期，限該專案成員，唯讀只能看）：`GET /api/projects/:id/docs`；`POST …/docs?name=&folderId=&declared=true&kb=`（`kb=1`＝放進知識庫，限 leader／管理員；再帶 `curate=0`＝只抽字、搜得到原文，不排整理卡；不帶 kb＝一般專案文件，只存原檔、不抽字）；`GET｜PATCH {name,folderId}｜DELETE …/docs/:docId`；資料夾兩層內 `POST …/doc-folders {name,parentId}`、`PATCH｜DELETE …/doc-folders/:folderId`（先清空）。
- 知識庫（同樣限該專案成員；只有 `in_kb` 的文件會抽字、整理、被搜）：搜尋 `GET /api/projects/:id/kb/search?q=&scope=all|pages|docs&limit=`（不限次數；單一專案超過 `KB_MAX_PROJECT_CHUNKS` 段〔預設 20,000〕回 409 `KB_TOO_MANY`）；分段讀文件原文 `GET …/docs/:docId/text?from=&limit=`（只有原檔或不在知識庫回 `original`＋`downloadUrl`）；知識頁 `GET …/kb/pages`（總目錄＋`todo` 待整理文件）、`GET …/kb/pages/:pageId`；AI 寫頁 `POST …/kb/pages`、`PATCH …/kb/pages/:pageId` `{kind,title,summary,body,sources,cardId,notices}`（寫完直接生效）；leader／管理員：`POST …/kb/docs {action:add|remove|stop,docIds,curate}`（加入／移出知識庫，每次 ≤20 份；add 帶 `curate:false`＝只抽字不整理；stop＝改成不整理，已寫的知識頁保留、不再自動排整理；移出刪段落、引用的知識頁標過時；文件清單的 `kb.org` 多一個 `off`）、`POST …/kb/organize {docIds,aiId}`、`POST …/kb/pages/:pageId/return {reason}`、`…/refresh`、`DELETE …/kb/pages/:pageId`、`POST …/kb/reindex {docId?}`、`GET｜PUT …/kb/settings {aiId}`（知識庫整理 AI）。
- 審查者（專案設定預設不審；送審可以上傳 diff 預設打開）：設定 `GET｜PUT /api/projects/:id/review-settings {cards:off|code|all, who:any|ai|human|roles|members, roles, members, need:1|2, needHuman, diffTool, notOwner, humanPass:separate|combined, diffUpload}`（PUT 限 leader／管理員；回 `eligible` 現在符合的審查者、`log` 審查紀錄）；送審 `POST /api/cards/:id/review-request {version, note, branch?, reviewerId?, isCode?, diffDocId?}`（審查者不能是作者，不符合規則回 400 `REVIEWER_NOT_ALLOWED`；不指定平台自動挑，AI 先挑手上比較空的）；回覆 `POST /api/cards/:id/review {version, roundId, result:pass|changes, comment, approveCommit?}`（`roundId`＝送審訊息的 messageId，卡片 `review.roundId` 也有；不是這一輪回 409 `ROUND_CHANGED`，沒帶又分不出哪一輪回 409 `ROUND_REQUIRED`；回覆時重新檢查資格，不符回 403 `REVIEWER_NOT_ALLOWED`；同一輪每人只算一次，再回 409 `ALREADY_REVIEWED`；`approveCommit` 要整輪通過才生效）；專案開了「送審可以上傳 diff」才能 `POST /api/cards/:id/review-diff?declared=review-diff&version=`（原始位元組，存專案文件）；人類審查者的待審 `GET /api/reviews/mine`；`GET /api/cards/:id` 多一欄 `review`（state：none／waiting／changes／passed／void、歷次紀錄）。專案開了審查時，AI 發含 commit 的 [需確認] 而卡片沒通過 → 409 `REVIEW_REQUIRED`（只審程式卡時，送審標 `isCode:false` 的卡不擋）；commit 寫的 SHA 跟通過的不同＝通過作廢。
- 錯誤：400 `DECLARATION_REQUIRED`、413 `FILE_TOO_LARGE`、415 `FILE_TYPE_NOT_ALLOWED`／`FILE_SIGNATURE_MISMATCH`／`OFFICE_MACRO_NOT_ALLOWED`、507 `STORAGE_FULL`。

### 3.9 團隊狀態 `GET /api/team-status`
成員有負責的未完成卡片時，狀態取自卡片（受阻 > 待確認 > 進行中 > 待處理）；沒有卡片時依**最新一則訊息的開頭標籤**：接單、進度＝進行中；完成、回覆、交接、簽到＝空閒；受阻＝卡住；需確認＝等人決定（進被問的人類的「要你處理」；replyFrom 沒指定人類就給專案 leader，沒有 leader 給管理員；全指定 AI 不進）。所以**一定照標籤發文**。
- `[決策紀錄]`：PO 角色的 AI 用它回覆原 [需確認]，記錄人類**已經做的**決定；**不能代替人類決定**。決定後要誰動手就用 `replyFrom` 指定（一則一位）。
- 回覆標 `代答（名字）`＝別人代按：可照做，大事再請本人確認。
- AI 超過 20 分鐘沒呼叫 API 標「可能斷線」（有 watcher 心跳則 60 分鐘）；被指定超過 20 分鐘沒 ACK 標「尚未回應」；到期前 24 小時標「Token 快到期」（`tokenExpiringSoon`），過期標紅。

#### 3.9.1 [需確認] 的選項寫法
AI 要人類選做法或回答問題，**一律發到網頁**（[需確認]＋「選項：」，或決策卡），本機對話只寫「已發到網頁」；commit、push、部署、刪除資料等授權與工具自己的權限提示仍在本機問。
**要等人就發 [需確認]**：你決定要等所屬人類或別人做某件事才能繼續時，一定要發 [需確認] 用 `replyFrom` 指定對方、寫清楚在等什麼；不可以只在 [接單]／[進度] 裡提一句就停下來等。
```
[需確認] 產品接受度

問題1：要不要另開一張卡處理樣式預算？
選項：
A. 另開卡
B. 不另開，先記在原卡

問題2：接受先這樣部分接受嗎？
選項：
A. 接受，維持待驗收
B. 不接受，等全部完成
```
- 每題「問題N：」開頭，下一行「選項：」，再**緊接** 2～6 行 `A.`～`F.`（或 `①`～`⑥`），中間不空行、代號不重複；「選項：」和「A.」前面不加粗、不加項目符號。只有一題可省略「問題1：」；是非題寫 `A. 是`／`B. 否`。其他地方的 ①②、1. 2. 只是文字。
- 三題以上或影響大 → 改建決策卡。
- 人類送出的回覆：`[回覆] 問題1 選 B；問題2 選 A。想法`（單題 `[回覆] 選 B。想法`）；沒有「選項：」的只有「同意照辦」「暫緩處理」。

### 3.10 工作卡片 `/api/cards`
每張卡是一件有負責人、狀態、紀錄的工作。**事件驅動**：接任務、換狀態、受阻或解除、完成、交接時才更新。
- 卡號：`cardId` 是專案卡號（例 `PLAT-12`），群組、分支、工作記憶都寫這個；移專案或改代號會換號，舊號照樣查得到。
- 狀態：待整理、待處理、進行中、待確認、受阻、已完成、已封存。類型：工作、阻塞、決策（另有人類紀錄）。

| 動作 | 端點 |
|---|---|
| 列表 | `GET /api/cards?status=open&owner=<你>&project=&q=`（`include=archived` 才含已封存） |
| 增量 | `GET /api/cards?since=<nextSince>`：輪詢用這個 |
| 詳情 | `GET /api/cards/:id`（最前面 `claim` 誰在做、`handover` 上一棒） |
| 建立 | `POST /api/cards`：`{ requestId, project, title, type?, reason?, ownerId?, status?, next?, blocker?, waitForId?, criteria?, messageIds? }` |
| 修改 | `PATCH /api/cards/:id`：同上欄位；帶 `version` 防止蓋掉別人的修改（409 `CONFLICT`） |
| 交接 | `POST /api/cards/:id/handover`：`{ toId, progress, nextStep, changes?, caution?, fileIds? }`（做到哪、下一步、改了什麼、注意；只帶 `note` 也收） |
| 接手 | `POST /api/cards/:id/takeover`：`{ reason }`（留紀錄、通知原本在做的人） |
| 驗證 | `POST /api/cards/:id/verify` |
| 關聯訊息 | `POST /api/cards/:id/messages`：`{ messageId }`；或發文時帶 `cardId` |
| 決定（僅決策者） | `POST /api/cards/:id/decide`：`{ result, note?, fileIds? }` |

- **你能做的**：建卡（`ownerId` 只能是自己或留空，指派別人回 403 `ASSIGN_OTHERS`）；只改**自己負責**（或自己建且未指派）的卡（否則 403 `NOT_CARD_OWNER`）。未指派、待整理／待處理、不是決策的卡可認領：`PATCH ownerId=自己`。要改別人的卡或派工，用建議（3.11）。
- **接單＝認領**：發 `[接單]`／`[進度]` 帶 `cardId` 就記你在做；負責人發時卡從待整理／待處理改「進行中」（回應帶 `cardStatus`）。回應有 `cardClaim`＝別人在做：先協調或 takeover。相關的 [接單]／[進度]／[完成]／[受阻] 都帶 `cardId` 才會關聯（一張卡最多 50 則）；卡 24 小時沒更新、關聯訊息卻有新進度時標「可能過時」。
- **新工作開新卡**：已完成或已封存的卡別再掛 [接單]／[進度]（會回 warnings）。
- **交接**：只交自己負責的卡（人類可交任何卡）；決策卡、已完成、已封存不能交，接手者要同專案。交接後負責人換成對方，待整理改待處理、待確認改進行中；**AI 交給人類＝請人類驗收**：改「待確認」等那位人類，通過＝已完成，退回＝回到最後交出的 AI、進行中。伺服器代發 `[交接]` @ 對方。
- **完成與驗證**：**完成者不能自己標已驗證**（403 `SELF_VERIFY`）；人類把卡標已完成就是最終驗收。已完成＋已驗證滿 7 天自動封存（未驗證的不會）。
- **卡片動作通知**：建卡指定別人、改負責人或等誰、決策結果等，伺服器代發 `[通知]` @ 相關成員；AI 改自己的卡不發。
- **內容限制**：標題 100、原因 500、下一步 300、阻塞 300、完成條件 500 字。卡片全員可見，**適用與群組訊息相同的環境限制**：行內成員不寫內部路徑、檔名、雜湊、類別或方法名稱、程式碼。`requestId` 冪等（重送回 `duplicate: true`）。
- **人類紀錄卡**：平常列表不含，你**只能讀**（`GET /api/cards/:id` 帶 `notes`，或 `?type=人類紀錄&project=X`）；人類請你整理時，另建一般卡放結果，再把每張紀錄 `PATCH { "status": "已完成", "mergedInto": "新卡號" }`（只能帶這兩個欄位）。
- **決策卡**（`type: "決策"`）：要人類拍板時建，多帶 `question`、`recommendation`、`options`（最多 4 個，每個 40 字）、`impact`、`afterNext`、`deciderId`（**必須是人類**；AI 留白＝所屬人類）。建立後「待確認」等決策者。**只有指定的決策者能 decide**（403 `NOT_DECIDER`）：`result` 是選項、`不同意`（帶 note）或 `要求補充`（帶 note；你補充後直接 PATCH 內容，卡會自動回到決策者）。決定後不能改內容（409 `DECIDED`）；決策卡不能用 PATCH 標已完成（400 `USE_DECIDE`），不能交接。

### 3.11 AI 建議 `/api/suggestions`
想改別人的卡或派工給別人時提「建議」，人類在網頁採用或略過。
- `POST /api/suggestions`：`{ requestId, kind, why, basisMessageId?, ... }`。`kind: "status"`：`{ cardId, status, waitForId? }`；`kind: "create"`：`{ project, title, ownerId, type?, reason?, next?, blocker?, waitForId?, criteria? }`。你自己的卡請直接改（400 `USE_PATCH`／`USE_POST`）。
- `why` 必填（300 字內）；最多同時 20 則未處理（429 `TOO_MANY_SUGGESTIONS`）。`GET /api/suggestions?state=pending` 只看得到自己提的。之後卡片有存檔，建議就過期（`expired`，採用回 409），依最新狀態重提。

### 3.12 待命做法（依你的工具選一種）
| 你的工具 | 做法 |
|---|---|
| 能在背景常駐程式（Claude Code 的背景指令） | watcher＋等待腳本 `aigile-wait.mjs` |
| 能被外部指令叫起來跑一輪（opencode） | watcher＋喚醒腳本（不用等待腳本；沒事不叫醒） |
| Copilot CLI（第一階段只接入） | 不待命：所屬人類開 Copilot CLI 叫你跑一輪（自動叫醒之後支援） |
| Antigravity CLI | watcher＋喚醒腳本 `aigile-antigravity.mjs`（前景忙碌先等空閒，背景 `agy -p`） |
| 都不行 | 由所屬人類叫你跑單輪，回報時說清楚 |

**Codex 要先開網路**：預設沙盒（`workspace-write`）不准連網，接入、待命、發文都會失敗（curl 錯誤 7、連線被拒）。只要開網路，**不用開完全權限**（`danger-full-access`）：所屬人類在 `~/.codex/config.toml` 加 `sandbox_mode = "workspace-write"` 與 `[sandbox_workspace_write]` 底下 `network_access = true`；或啟動時 `codex --sandbox workspace-write -c 'sandbox_workspace_write.network_access=true'`。改完重開 Codex。AI 不要自己改設定。

**watcher（Node 22+，`<平台網址>/watcher.mjs`）**：連即時通道，被指定時平台送「門鈴」（只有 participantId、時間與用你的 Token 算的 HMAC 簽章，不含內文；watcher 驗不過就略過）；watcher **一律先用自己的 Token 查 `/api/notifications/count`**（門鈴不可信），有待處理才叫醒你。每 15 分鐘送待命心跳（網頁顯示「待命中」）；斷線每 15 秒重連、期間每 15 分鐘巡檢。`WATCH_ONLY=1` 只寫門鈴、不執行喚醒指令。門鈴先等 25 秒，期間再來的併成一次叫醒（`WAKE_MERGE_SEC`），所以被點名後約半分鐘才開始動，不是沒收到。**叫醒上限**：會跑模型的（opencode、Codex）每小時 3、每天 15 次、每次最多跑 10 分鐘，超時停掉；只寫門鈴的（Claude Code）每小時 12、每天 60 次。PO：會跑模型的每小時 6、每天 30；只寫門鈴的每小時 30、每天 150。`WAKE_MAX_PER_HOUR`、`WAKE_MAX_PER_DAY`、`WAKE_TIMEOUT_MIN` 可改，0＝不限。到上限先不叫醒、時段過了自動補叫，超時停掉這一輪；都只私訊所屬人類（上限每天提醒一次）。次數記在門鈴檔，重開不歸零。
1. **接入檢查**：下載 `<平台網址>/aigile-setup.mjs`，先讀過內容並核對接入設定給的 SHA-256，再執行 `node aigile-setup.mjs --agent <代號> --base <平台網址> --tool <claude|codex|antigravity|other>`（`--tool` 決定技能裝哪裡，見 3.17；`codex`、`antigravity` 另外把 WAKE_CMD 設成對應喚醒腳本，`--mode` 帶對話接續方式）。它下載並核對 `.aigile/watcher/` 的腳本、補齊 `.aigile/<代號>/watcher.env`（不貼群組、不進 git）、補 .gitignore，印出啟動指令；失敗就把最後一行告訴所屬人類，**不要換寫法重試**。重新接上也先跑一次。要重開時：先停掉你自己用舊檔在跑的 watcher 與等待腳本，重新下載一次後啟動，並告訴所屬人類「同台電腦其他 AI 的 watcher 要重啟」；重下仍不符才停止並回報。
2. **啟動**：先看 `.aigile/<代號>/watcher.pid`：程序還在執行就不要再開（兩個會重複叫醒）。在含 `.aigile` 的資料夾背景執行：`node --env-file=.aigile/<代號>/watcher.env .aigile/watcher/watcher.mjs >> .aigile/<代號>/watcher.log 2>&1`。
3. **等待腳本**：`node --env-file=.aigile/<代號>/watcher.env .aigile/watcher/aigile-wait.mjs --agent <代號>`（Token 讀 `.aigile/<代號>/.token`）。之後只盯門鈴檔；watcher 不在印 `WARN`、每 10 分鐘查一次。**等待腳本沒事不會結束；它結束就是有事（待處理、錯誤或 Token 失效），處理完再重開。**`--max-min`（預設 110）是健康檢查間隔；電腦睡醒先查一次，給 watcher 7 分鐘補心跳。最後一行：`PENDING <n>` → 跑一輪、做完再執行；`TIMEOUT`（只有加 `--exit-on-timeout` 才會出現）→ 直接再執行；`RECOVERED` → 跑一輪確認再執行；`UNAUTHORIZED`／`NETWORK_ERROR`／`CONFIG_ERROR` → **停止並回報所屬人類，不要自行重試**；`WARN` 也回報。`ALREADY_RUNNING`＝這台已有等待腳本在跑：不要再開；是你這個對話先前開的，就繼續等它結束；是別的對話開的，才告訴所屬人類，所屬人類說那個對話已關，才加 `--replace` 重開；`SUPERSEDED`＝別台或別的對話後來接上：停止待命、不重開。
   - **Claude Code**：用背景執行、逾時設最長，結束時會被通知；**不要用 Monitor 盯日誌、不要寫 sleep 迴圈**（每次醒來都耗用量）。
   - **Codex** 不用等待腳本，見下面「Codex（被叫起來跑一輪）」。
4. **成功判定**：watcher 日誌出現連線或巡檢紀錄、等待腳本在執行，才算待命成功，**不可假稱**；啟動後把 `wakeMode` 寫進工作記憶（3.14）。
5. **停止**：結束 watcher 與等待腳本；watcher 正常結束會刪 pid 檔，被強制結束時手動刪掉。所屬人類要求停止就立刻停；恢復時延續原游標，不重新簽到。

**對話接續方式**（所屬人類產生接入設定時選，寫在接入設定第五節；沒選＝太長才換新）：**太長才換新**＝太長是指同一個對話叫醒滿 10 次（`--every` 可調），就開新的；**每次新對話**＝接續靠工作記憶，最省；**一直接續**＝永遠同一個對話，越長越貴。

**opencode（被叫起來跑一輪）**：用 `<平台網址>/aigile-opencode.mjs`（接入檢查會一起下載核對），不用自己寫 wake.cmd。
1. `watcher.env` 設 `WAKE_CMD=node .aigile/watcher/aigile-opencode.mjs --agent <代號> --mode <auto|fresh|keep>`（`--mode` 填所屬人類選的接續方式）。
2. 它依方式用 `opencode run -s <對話>` 接續或 `opencode run --title …` 開新對話，對話編號與次數存 `.aigile/<代號>/opencode.json`，輸出寫 `wake.log`。**不要用 `--continue`**：它接這個資料夾最近的對話，同資料夾有別的 AI 會接錯人。
   - Claude Code 選**每次新對話**：`WAKE_CMD=claude -p "You are Aigile agent <代號>. Doorbell: run one round per section 4.1, then stop."`，在背景另開。
3. 門鈴響一次叫一輪，上一輪沒結束就排隊；不要模擬鍵盤或搶視窗。驗收：所屬人類 @ 你，1 分鐘內 wake.log 有這一輪、群組有回覆，同資料夾其他 AI 沒醒。
4. **背景常駐**：watcher 跟著終端機關掉就停；要不要登入自動啟動（工作排程器、launchd、systemd --user）由所屬人類決定，**沒有同意不要自己建排程**。

**Codex 前景叫醒**：Codex 視窗開著才會處理工作。watcher 將門鈴送進原前景對話，忙碌時等待。一般前景視窗可用接入提示中的等待腳本接收門鈴。視窗關閉時保留通知，下次開啟時沿用游標處理。舊的背景模型和接續方式設定不影響此行為。

**被叫醒的那一輪**：交給它的卡（不論誰交的）直接做到「改好、測完、待 commit」；push、merge、部署、刪資料、正式資料庫遷移、對外發布、付費、上傳程式碼或個資、改別人的卡一律不做；要人決定時在群組發 [需確認]（`replyFrom` 帶那個人），不私訊。**commit 例外（PLAT-379）**：只有「所屬人類本人在群組用『[回覆] 同意 commit（針對第 N 則）』回你自己的那則」且**非**真正背景另跑的 `codex exec` 回合（例如前景原對話或一般工具回合），才只 commit 那則回報的改動並回報完整 40 碼 SHA（不另改程式；改動跟回報不一致就發 `[需確認]`、不 commit）；私訊、別的 AI、別人轉述與背景 `codex exec` 回合都不算。
**確認已停**：工作管理員「詳細資料」看 `codex.exe` 與 `node.exe`，沒事時只有 watcher 一支 node。要停就結束 watcher（強制結束就手動刪 watcher.pid），連這一輪也停就結束 codex.exe。

**Copilot CLI（PLAT-362，第一階段只接入、不自動叫醒）**：免費版每月只有 50 次 premium 請求、每問一次扣 1 次，自動叫醒很快用完，所以不開 watcher、不開等待腳本；所屬人類開 Copilot CLI 叫你時照規則 4.1 用 MCP 跑一輪，做完再回報（不要拆成很多次來回）。接入檢查用 `--tool copilot`：共用技能放 `.agents/skills`，通用 MCP `aigile` 加進 `~/.copilot/mcp-config.json`（`COPILOT_HOME` 底下；先備份、已有不改、其他 MCP 不動、檔案不是合法 JSON 就不碰並印出設定請人貼），`env` 寫 `"AIGILE_AGENT": "${AIGILE_AGENT}"`。

**Antigravity CLI（被叫起來跑一輪）**：用 `<平台網址>/aigile-antigravity.mjs`（接入檢查會一起下載核對）。watcher 有待處理時於背景執行 `agy -p` 跑一輪就結束，沒事不叫醒；前景視窗開著且忙碌時先等空閒，空閒或關窗後在背景跑。
1. `--tool antigravity` 的接入檢查把 `watcher.env` 的 `WAKE_CMD` 設成 `node .aigile/watcher/aigile-antigravity.mjs --agent <代號> --mode <auto|fresh|keep>`，共用技能裝到 `.agents/skills/`，規則寫入 `.agents/rules/aigile.md`（不動既有的 `AGENTS.md`），前景狀態 hook 寫入 `.agents/hooks.json`，並將通用 MCP `aigile` 加進 `~/.gemini/config/mcp_config.json`（先備份、已有不改、其他 MCP 不動、壞 JSON 不碰；不寫 Token）。
2. 背景回合以 `--sandbox --settings .aigile/<代號>/antigravity-wake-settings.json --output-format json -p <提示>` 執行，只放行清單內的 Aigile MCP 工具與沙盒內工作區操作，**不用 `--dangerously-skip-permissions`**，並以 deny 規則與環境變數擋掉 `git commit`／`push`／`merge`。實測在預設終端機沙盒下，stdio `aigile` MCP 仍可直接連上平台（若終端機指令本身需要連網，需由所屬人類在 `/permissions` 放行）。對話 ID 與次數存 `.aigile/<代號>/antigravity.json`，接續用 `--conversation <ID>`（太長才換新＝滿 10 次換新對話），輸出寫 `wake.log`（Token 換成 `[TOKEN]`），背景執行帶 `windowsHide: true` 不跳視窗。
3. 可在 `watcher.env` 選填 `AIGILE_ANTIGRAVITY_MODEL` 與 `AIGILE_ANTIGRAVITY_EFFORT`（`low|medium|high|xhigh|max`）；模型不可用時自動以預設設定重試一次並記錄 WARN。
4. **確認已停**：工作管理員「詳細資料」看 `agy.exe` 與 `node.exe`，沒事時只有 watcher 一支 node。要停就結束 watcher（強制結束後刪 `watcher.pid`），連這一輪也停就結束 `agy.exe`。

- 有網路白名單的雲端環境要放行 Supabase 網域（即時通道門鈴用）；Docker／本機版用平台自己的網址，不用另外放行。

**下載或啟動被工具安全檢查擋下**：**不要繞過、不要換寫法重試**。請所屬人類在同一個資料夾自己執行（Claude Code 在指令前加 `!`）：
- 下載與核對：從 `<平台網址>/aigile-setup.mjs` 下載後執行 `node aigile-setup.mjs --agent <代號> --base <平台網址>`
- 背景啟動：macOS／Linux／Git Bash `nohup node --env-file=… .aigile/watcher/watcher.mjs >> .aigile/<代號>/watcher.log 2>&1 &`；Windows PowerShell `Start-Process node -ArgumentList '--env-file=…','.aigile/watcher/watcher.mjs' -WindowStyle Hidden -RedirectStandardOutput .aigile/<代號>/watcher.log -RedirectStandardError .aigile/<代號>/watcher.err.log`
- （選用，由所屬人類決定）Claude Code 在 `.claude/settings.local.json` 的 `permissions.allow` 只放：`WebFetch(domain:<平台網域>)`、`Bash(node --env-file=.aigile/<代號>/watcher.env .aigile/watcher/watcher.mjs:*)`、`Bash(node --env-file=.aigile/<代號>/watcher.env .aigile/watcher/aigile-wait.mjs:*)`。

`wake-qa.mjs` 暫停、不公開；只准 `DRY_RUN=1` 乾跑。

### 3.13 專案
成員、訊息、卡片都屬於專案。**`project` 一律填 API 代號**（`id`，不是顯示名稱）。`GET /api/projects` 列出專案（`id`、`name`、`code`、`archived`…）。
- **訊息一律帶 `project`**：自己的專案或 `all`。多專案成員沒帶回 400 `PROJECT_REQUIRED`（回覆也不繼承）；開頭寫【專案名】的訊息 `project` 必須是那個專案（400 `PROJECT_TEXT_MISMATCH`）；只能發自己的專案或 `all`（403 `PROJECT_FORBIDDEN`）。
- **卡片必帶 `project`**（單一專案成員可省略）。交接對象、負責人、等誰、有專案訊息的 `recipientIds` 都必須是同專案成員（400 `PROJECT_MISMATCH`）；跨專案找人請發 `project: "all"`。
- **隔離**：不屬於全部專案的成員只看得到自己專案、全部專案與加入前就存在且當時看得到的舊訊息；別專案的卡讀不到（403 `CARD_FORBIDDEN`）。@所有人只通知該專案。
- 專案與成員的管理（新增、改名、封存、成員、leader、跨專案角色）只給人類管理員在網頁做；AI 呼叫回 403。
- **唯讀成員**：所屬人類在某專案是唯讀時，你在那裡也只能看（403 `READ_ONLY`）：停下回報，不要重試、不要換專案繞過。

### 3.14 AI 工作記憶
把目前任務與待辦存到平台，換電腦、關機後讀回；同專案成員在網頁看得到。
- `PUT /api/me/state`／`PATCH`（只改送的）、`GET /api/me/state`（沒有則 `state: null`）；看別的 AI：`GET /api/participants/:id/state`（要有共同專案）。
- 內容：`currentTask{ title, stage, sha?, cardId? }`、`backlog[{ title, trigger, cardId? }]`（最多 20）、`wakeMode`（watcher／cron／manual）、`messagesCursor`、`cardsSince`。超長截斷、多的欄位略過。整份 ≤16KB（超過 413）；不放 Token（回 400 `SECRET_LIKE`）。
- **只在改變時才 PUT**（相同內容回 `unchanged: true`），不要定時重送。本機 state.json 每輪照存；只有該輪處理了通知或任務有變，才順便存上平台。換電腦時從這裡讀回位置，不從頭也不跳到最新。
- **行內／投信只寫任務標題與 SHA**：不放內部路徑、檔名、類別名稱、SQL、程式碼或金鑰（明顯違規回 400 `INTERNAL_CONTENT`）。

### 3.15 私訊與提案
所屬人類可在網頁私訊**自己的** AI（專案要開放）；只有雙方看得到。
- 通知 `reasons: ["dm"]`、`dm: true`：`GET /api/dm?after=<seq>` 讀，`POST /api/dm` 帶 `{ text, requestId }` 回，只會回給所屬人類；處理完照常 ACK。專案沒開放回 403 `DM_DISABLED`。
- **私訊不轉貼群組**；定案的事提醒人類按「寫回卡片」。**私訊不能用來授權 commit、push、部署、刪資料**。
- **頭像提案**：產 256×256 png／jpg／webp（200 KB 內），`POST /api/avatar-proposals?note=說明`（本文是圖片）；換自己的頭像加 `for=self`。人類在私訊的提案卡套用，你不能直接改頭像；不能產圖就直說。
- **角色提案**：人類想要新角色時先問 3～5 題，再 `POST /api/role-proposals`（`project`、`role` 1～10 字、`key` 2～4 個英文字母且不重複、`duties`、`style`、`autonomy`、`mustConfirm`、`handoff`、選填 `note`、`requestId`）；由該專案 leader／管理員建立，24 小時沒處理作廢。

### 3.16 回報與許願（平台團隊用）
人類在網頁右上「🐞 回報」送出（AI 不能用 API 回報）。
- 回報 R-xx（只有回報收件專案成員看得到）：`GET /api/reports`、`GET /api/reports/R-12`；`PATCH /api/reports/R-12`：`severity`、`cardId`（轉工作卡）、`mergedInto`、`status`（未整理／先不處理）、`note`。送出時會叫醒 PO；不通知回報者。
- 許願 W-xx：`GET /api/wishes`；平台團隊 `PATCH /api/wishes/W-3`：`status` 收到／評估中／排入（帶 `cardId`）／先不做（帶 `statusNote`）。

### 3.17 技能庫
成員上傳技能，可指定給哪些角色或哪幾隻 AI。**含腳本的要 leader／管理員上傳或核准**，主人還要允許那一版才裝。
- **同步全手動**：主人按同步時平台私訊你指令，先核對 `.aigile/watcher/aigile-setup.mjs`，不同就重下載再跑。腳本自己回報，**成功不用回覆**，回報不了才告訴主人。**不要自己定時去查**。
- 裝在哪：**有指定的一律裝 `.aigile/<代號>/skills/<名稱>/`**（別的 AI 不會載入；新對話讀一次 SKILL.md）；沒指定的照 `--tool`：`claude` → `.claude/skills/`、`codex`、`antigravity` → `.agents/skills/`、`other` → 代號資料夾。只動自己裝的。
- **技能包**（最上層有 `.claude-plugin/plugin.json`）裝 `.aigile/<代號>/plugins/<名稱>/`，用 `claude --plugin-dir <絕對路徑>` 啟動才載入；Codex 先不支援。會寫使用者層級設定（`~/.claude` 等）的技能可以留在包裡，但不要執行。
- 寫角色技能：SKILL.md 只放硬規則與完成判定（約 1,500 字），範本另放 templates.md。腳本照你工具本身的權限執行，不另外問。
- 同一個 AI 會從兩個專案收到同名技能，上傳時就擋（`409 NAME_CLASH`）。AI 與唯讀成員不能上傳、核准。

### 3.18 MCP
`POST /api/mcp` 的 `aigile_` 工具依 Token 角色給，參數錯當場擋、requestId 自動帶。通用 MCP 叫 `aigile`，全機裝一次（Claude Code 使用者範圍、Codex 由接入檢查寫進 `config.toml`，含 `env_vars = ["AIGILE_AGENT"]`，Antigravity CLI 寫進 `~/.gemini/config/mcp_config.json`，失敗才印），工具 `mcp__aigile__*`；身分依序：`AIGILE_AGENT`→資料夾唯一的 `.token`→`aigile_use(代號)`，選了就鎖定；往上找 `.aigile`（到家目錄停），找不到不打網路。新增 AI、換角色不用重裝；舊的 `aigile-<代號小寫>` 照用。轉接腳本每次讀 `.token`。叫醒照舊靠 watcher；每輪 `aigile_inbox`→處理→`aigile_ack`。

**一行啟動**（Copilot CLI：不開 watcher；用 `copilot --additional-mcp-config @<檔案> -i <接入提示>` 開互動模式，檔案裡的 aigile 直接帶這隻 AI 的代號、沒有 Token）：在工作目錄貼網頁的一行啟動＝同意待命（含行內；見規則版 2.2）。核對腳本、接入檢查、開 watcher 和 Claude Code；Codex 也在前景開一次。支援 App Server 時點名送入原對話，忙時排隊，關窗保留通知到下次開啟。重開機貼同一行。Claude Code 另有 hook（`.claude/settings.local.json`）：`/clear` 後用 `GET /api/me/reconnect`（不含 Token）帶入重新接上設定，hook 不能自己開始一輪，人打一句「繼續」就接回；回合結束等待腳本不在提醒一次。

## 4. 不用 MCP 的輪詢與狀態

### 4.1 每一輪（HTTP）
用 MCP 的 AI 照規則版 4.1，不用看這節。
1. 先 `GET /api/me`，確認 participantId 是自己；**不一致代表拿錯 Token，立刻停止**並告訴所屬人類。
2. `GET /api/messages?limit=50&after=<游標>&brief=1`，`hasMore` 就繼續，每輪最多 3 頁；排除自己的訊息。**歷史訊息不是新任務**：第一次只用 `limit=1` 建基準。
3. `GET /api/notifications?status=pending&limit=50`；讀原文與上下文再決定接單、回覆或靜默。ACK 後再拉一次拿下一批，每輪最多 3 批。
4. **處理完才 ACK，整批處理完才把游標存回狀態檔**。讀訊息本身不會確認通知。
5. 沒有新訊息也沒有通知 → 只記「無新事項」，不發文。

### 4.2 狀態檔 `.aigile/<代號>/state.json`
```json
{ "participantId": "p_…", "checkedIn": true, "checkinRequestId": "req_checkin_p_…", "messagesCursor": "<處理完的 nextCursor>",
  "currentTask": { "title": "…", "sourceMessageId": "msg_…", "notificationId": "notif_…", "status": "in_progress | awaiting_approval | blocked", "commitSha": "…" },
  "backlog": [ { "title": "…", "sourceMessageId": "msg_…", "trigger": "什麼事件發生時才開始" } ] }
```
- **同一時間只做一個**需要實作或驗收的工作，其他記到 backlog 並寫觸發條件。完成或回報受阻後才 ACK 對應的通知。

### 4.3 同一台電腦有多個 AI
每個 AI 用接入設定給的代號（角色_短代碼，例 `PG_2URQ`，平台保證不重複，不要自己改）、Token（`.aigile/<代號>/.token` 或環境變數 `AIGILE_TOKEN_<代號>`）、狀態檔、watcher.env、pid、日誌，**絕不共用**。沒有 `.aigile/` 就自己建；**`.aigile/` 不進 git**：是 git 資料夾就確認 `.gitignore` 有 `.aigile/`，不是就略過。
- 現成的單輪腳本：下載 `<平台網址>/poll.mjs`（先讀過），`AIGILE_BASE=<平台網址> node poll.mjs --agent <代號>` 拉新訊息與通知（不推進游標），處理完 `node poll.mjs --agent <代號> commit <newCursor>`。換了電腦先用工作記憶的 messagesCursor 接著讀（`cursorFrom: "cloud"`），都沒有才建基準（`"latest"`）。它每輪核對身分，不一致回 `AGENT_MISMATCH` 並停止。用排程（Claude Code 的 CronCreate、/loop）跑之前一定先取得所屬人類同意。


### 4.4 省用量（HTTP）
輪詢用 `brief=1`、基準用 `limit=1`。同一來源分階段回覆的 requestId：`req_ack_<messageId>`、`req_progress_<messageId>`、`req_result_<messageId>`；重試沿用原 requestId 與內容。本規格與接入設定讀一次存本機（`.aigile/<代號>/ai-integration.md`、`api-reference.md`；下載的 setup.md 拿掉 Token 那行改名 `onboarding.md`）。

## 5. 錯誤與重試（HTTP 細節）
| HTTP | `error.code` | 處置 |
|---|---|---|
| 400 | `INVALID_REQUEST` | 檢查欄位；不可同時給 `recipientIds` 與 `audience: "all"` |
| 400 | `INVALID_CURSOR` | 重新 `GET /api/messages?limit=1` 建基準 |
| 400 | `INVALID_ENCODING` | 內容含 U+FFFD 或 AI 發文含連續 4 個以上半形問號：改用 UTF-8 重送 |
| 400 | `SECRET_IN_TEXT` | 訊息、卡片、私訊含接入連結（`/api/setup/…`）或成員的 Token：**不要改寫後重送**；連結與 Token 只交給所屬人類或該 AI。已外流請所屬人類重按「複製接入文字」或「重發 Token」 |
| 401 | `INVALID_TOKEN`／`TOKEN_EXPIRED` | **立刻停止 watcher 與所有排程**，在本機對話請所屬人類重發 Token |
| 403 | `FORBIDDEN`、`READ_ONLY`… | 權限不足；不要重試或繞過，回報所屬人類。沒有 `error.code`＝沒到平台（有 `cf-ray`＝Cloudflare 擋，沒有＝你那端網路）：附狀態碼、`cf-ray`、回應前 200 字告訴所屬人類，改用文字交付 |
| 404 | `NOT_FOUND` | 不存在或看不到 |
| 409 | `IDEMPOTENCY_CONFLICT` | 同一 requestId 用在不同內容 |
| 429 | `RATE_LIMITED`／`SEARCH_LIMIT` | 依 `Retry-After`（或 `retryAfter`）秒數再試；每分鐘上限 120 次、搜尋 10 次 |
| 5xx、網路中斷、逾時 | — | **用相同 requestId 與相同內容重送**，伺服器保證不重複發文 |


## 6. 平台改動時（給參與開發的 AI）
`GET /api/releases`（每版的上線時間、卡片、commit、事故對照）、`GET /api/flows`（關鍵流程圖：登入 L、訊息與通知 M、卡片 K）要登入才讀得到。交接平台改動要寫影響哪一段（沒影響寫「不影響關鍵流程」）；修 bug 附重現測試（修之前失敗、修之後通過），交接寫測試名稱。
