# Azure Foundry + 切換式 Azure ASR + OpenClaw 整合規格

> 狀態：計畫已 review（對抗式驗證）、決策已鎖定，待實作。
> 對象：在現有 SpeakSlow（Electron + React + 內嵌 Python sherpa-onnx）上延伸。
> 產出來源：`/plan-eng-review`，含 9-agent 研究 + 對抗式驗證 workflow。

---

## 0. 鎖定的決策（Locked Decisions）

| # | 決策 | 選定 | 理由 |
|---|------|------|------|
| D1 | 建置策略 | Fork 後延伸現有 repo | ASR/貼上/熱鍵已是 solved，兩個新需求是獨立接點 |
| D2 | Azure 用途 | ① Foundry LLM 潤飾層 + ② 切換式 Azure ASR（本地 sherpa 保留為預設） | 兩者皆可，本地永遠是 fallback |
| D3 | Azure 認證/接法 | **本地 sidecar proxy**（OpenAI 相容），非 Electron 內嵌 MSAL | 收斂三件事到一支已驗證的 proxy，SpeakSlow 近乎零改；躲掉 4~5 個硬風險 |
| D4 | 部署拓撲 | Azure 能力**本機自足、與 OpenClaw VM 解耦**；sidecar 跟 `sherpa_server` 一樣 bundle/spawn | VM 關機也能用；client 本來就在筆電端 |
| D5 | 登入流程 | 預設 **InteractiveBrowserCredential + 持久化 token 快取**；device-code 為設定可切的 fallback | UX 佳且 `azure-identity` 自動續期＝低維護 |
| D6 | 模型 | 全部 **設定可換**；ASR = **Azure Speech Fast Transcription + `mai-transcribe-1`**（多語自動偵測 + OpenCC 轉繁），chat = 設定指定的 deployment | 保留彈性；採用使用者指定的 mai-transcribe-1 |
| D7 | OpenClaw | 本輪只做**設計 + token 安全模型**，不落地實作 | gateway 綁 localhost 不可達 + token=RCE，需先解 reachability 與 per-user token |

**已提供的環境參數（2026-06）：**
- Entra app（public client）：`client_id = 4441a9d4-c9fe-400a-9873-ed18beef03c1`、`tenant_id = 16b3c013-d300-468d-ac64-7eda0820b6d3`
- Azure 資源 endpoint：`https://foundryweus2.cognitiveservices.azure.com/`（West US 2，已是 custom-subdomain → Entra 直接可用，**不需再開不可逆 subdomain**）
- ASR：Fast Transcription `POST /speechtotext/transcriptions:transcribe?api-version=2025-10-15`，`definition.enhancedMode.model = mai-transcribe-1`
- **驗證結論**：Fast Transcription 用**純 `Authorization: Bearer`**（非 `aad#` 包裝）；單一 scope `cognitiveservices.azure.com/.default` 同時涵蓋 chat + 轉寫 → 一次登入、一組憑證。
- 待補：chat deployment 名；確認 app reg 已開「Allow public client flows」+ redirect URI `http://localhost`；RBAC（見 §6）。

---

## 1. 目標與非目標

**目標**
- SpeakSlow 的 AI 文字優化層可接 Azure Foundry/Azure OpenAI 上的模型，透過 **Entra ID** 認證。
- 新增「Azure 語音辨識」作為**可切換**的 ASR 後端，本地 sherpa-onnx 保留為預設。
- 整套（含 Azure）在**使用者筆電本機自足**運行，不依賴 OpenClaw VM。
- 為「語音 → OpenClaw agent」整合產出可落地的設計與安全模型。

**非目標（本期明確排除）**
- 不重寫本地 ASR / VAD / 貼上 / 熱鍵子系統。
- 不在 Electron 主行程內嵌 MSAL 原生模組（改用 sidecar）。
- 不做 Azure **串流** ASR（即時 partial）；Azure 模式為 batch-only，串流固定走本地。
- 不在本期落地 OpenClaw 整合程式（只設計）。
- 不開啟 Azure Speech 的 custom subdomain（走 `/audio/transcriptions` 路線即可避開）。

---

## 2. 架構總覽

```
                        使用者筆電（離線於 VM 也能運行）
 ┌───────────────────────────────────────────────────────────────┐
 │ SpeakSlow (Electron main + React renderer)                      │
 │                                                                 │
 │  錄音(renderer) ─16k mono Int16 PCM─► [asrManager facade]        │
 │                                          │                      │
 │                          ┌───────────────┴───────────────┐      │
 │                          ▼ (asr_provider=local, 預設)      ▼ (azure) │
 │                   sherpaManager(現況)            azureAsrManager(新)  │
 │                   stdin/stdout JSON               multipart POST     │
 │                          │                            │            │
 │                          ▼                            │            │
 │                   sherpa_server.exe                   │            │
 │                   (內嵌 Python, 本地模型)              │            │
 │                                                       │            │
 │  AI 潤飾: aiTextProcessor ──► ai_base_url ────────────┼──┐         │
 │                              (= http://127.0.0.1:PORT/v1) │        │
 └───────────────────────────────────────────────────────┼──┼───────┘
                                                          ▼  ▼
                       ┌─────────────────────────────────────────────┐
                       │ 本地 sidecar proxy (新; 內嵌 Python, PyInstaller)│
                       │ 綁 127.0.0.1:PORT，要求本地共享密鑰 Bearer        │
                       │  POST /v1/chat/completions   ─► Azure chat 部署   │
                       │  POST /v1/audio/transcriptions ─► Azure 轉寫部署   │
                       │  GET  /healthz / /v1/auth/status / login          │
                       │ Entra ID: InteractiveBrowserCredential (快取/續期) │
                       │ scope: cognitiveservices.azure.com/.default        │
                       └───────────────────────┬─────────────────────────┘
                                               ▼
                          Azure Foundry / Azure OpenAI 資源
                          (classic deployment route + api-version)
 ════════════════════════════════════════════════════════════════════
  OpenClaw（獨立、可選、本期僅設計）
  SpeakSlow ──HTTPS──► VM /hooks/agent {message}  （per-user token）
```

**設計原則**：sidecar 是唯一接觸 Azure 認證細節的地方。SpeakSlow 對 Azure 只看到一個本地 OpenAI 相容端點。這把「Entra 登入、token 續期、雙 audience、Speech 認證」全部關在 sidecar 裡，SpeakSlow 端維持 thin client。

---

## 3. 元件 A — Foundry LLM 潤飾層

**接法**：把 AI 設定的 `ai_base_url` 指到 `http://127.0.0.1:<port>/v1`，`ai_model` 設為 Azure 的 chat deployment 名稱，`ai_api_key` 設為 sidecar 的本地共享密鑰（非 Azure key）。

**SpeakSlow 端改動（極小）**：
- `src/helpers/aiTextProcessor.js`：邏輯**不變**。它已經是 `${baseUrl}/chat/completions` + `Authorization: Bearer ${apiKey}`（[aiTextProcessor.js:73-95](src/helpers/aiTextProcessor.js)）。把 `apiKey` 當成本地密鑰送即可。
- 唯一需要留意：`_stripAIPreamble`、`temperature`、`max_tokens` 等維持原狀；Azure 回傳 `choices[0].message.content` 形狀一致。
- `checkAIStatus`（[:163-230](src/helpers/aiTextProcessor.js)）也指向 sidecar；測試連線改打 sidecar 的 `/v1/auth/status` 或一個 1-token 的 chat 測試。

> 結論：元件 A 幾乎是設定變更。Entra 的複雜度全在 sidecar。

---

## 4. 元件 B — 切換式 Azure ASR（batch）

**只做 batch**（錄完→停→送 WAV→文字）。這正好對應 SpeakSlow 的主流程，且躲開串流協定重構。Azure 模式下停用串流（切到 Azure 時 UI 自動關閉「串流/邊錄邊算」）。

**新增 `azureAsrManager`**（`src/helpers/azureAsrManager.js`）：
- 介面與 `sherpaManager` 對齊：`transcribeAudio(audioBlob, options)` 回傳 `{success, text, segments, raw_text, confidence, language, duration, audio_path}`。
- 實作：把 WAV bytes POST 到 sidecar 的 `http://127.0.0.1:<port>/v1/audio/transcriptions`（OpenAI 相容外觀），sidecar 內部轉呼 Azure Speech Fast Transcription。SpeakSlow 端只看到 `{text}`（+ 可選 segments）。
- **語言策略**：sidecar 預設 `definition.locales = []`（mai-transcribe-1 多語自動偵測，原生處理中英混用）→ 取回後走**既有 OpenCC `to_traditional`** 轉繁（SpeakSlow 既有管線，DRY）。`locales` 設定可換（要強制可填 `["zh-TW"]` 或 `["zh-CN"]`）。
- **segments 可保留**：Fast Transcription 回傳 `phrases[].offsetMilliseconds/durationMilliseconds` → sidecar 可映成 `segments`，**停頓斷行/SRT 在 Azure 模式也能用**（非 v1 必要，但可行）。
- **precog no-op**：Azure 模式下 `precogStart/Feed/Abort` 必須短路（不啟動 sherpa）。
- **斷網自動回退**：偵測 `navigator.onLine`／sidecar 健康檢查失敗 → 自動切回本地 sherpa 並提示。
- **延遲**：endpoint 在 West US 2，台灣 RTT 約 +150~200ms；batch 短句可接受，仍比串流體感差一點。本地為預設、Azure 為可切換。

**facade（單一接縫）**：在 `src/helpers/ipcHandlers.js` 組一個 `asrManager`，讀 `asr_provider` 後委派給 `sherpaManager` 或 `azureAsrManager`，掛到 `ctx`。`src/helpers/ipc/transcription.js` 把 `ctx.sherpaManager.*` 改成 `ctx.asrManager.*`（`transcribe-audio`、`transcribeFilePath`；streaming/precog 在 Azure 模式短路或固定走 local）。

---

## 5. 本地 sidecar 設計（核心新元件）

直接改寫你 OpenClaw repo 的 `docs/vm/helpers/aoai-proxy.py`，**把認證後端從 IMDS 換成 `azure-identity`**。

**監聽**：`127.0.0.1:<port>`，port 於 spawn 時選空閒埠並回報給 Electron（避免衝突）。要求 `Authorization: Bearer <local_secret>`（spawn 時隨機產生，只給 SpeakSlow），防止本機其他程式濫用。

**路由**：

| Path | 上游 | 備註 |
|------|------|------|
| `POST /v1/chat/completions` | `<endpoint>/openai/deployments/<chat_dep>/chat/completions?api-version=<v>` | body 透傳，移除/覆寫 `model` |
| `POST /v1/audio/transcriptions` | `<endpoint>/speechtotext/transcriptions:transcribe?api-version=2025-10-15` | 收 WAV → 組 Speech Fast Transcription multipart（`audio` + `definition` JSON，`enhancedMode.model=mai-transcribe-1`，`locales` 由設定帶入）→ 解析 `combinedPhrases[0].text`（+ 可選 `phrases[]`→segments）回成 OpenAI 形狀 |
| `GET /healthz` | — | 存活檢查 |
| `GET /v1/auth/status` | — | 回 `{signedIn, account, expiresOn}` |
| `POST /v1/auth/login` | — | 觸發互動登入 / 回 device code |
| (可選) `POST /v1/audio/speech` | Azure Speech TTS | 你既有功能，保留 |

**認證**：
```python
from azure.identity import InteractiveBrowserCredential, DeviceCodeCredential, TokenCachePersistenceOptions
cred = InteractiveBrowserCredential(
    tenant_id=TENANT, client_id=CLIENT_ID,
    cache_persistence_options=TokenCachePersistenceOptions(name="speakslow-azure"),
)
SCOPE = "https://cognitiveservices.azure.com/.default"   # 單一 scope 同時涵蓋 chat + 轉寫
token = cred.get_token(SCOPE).token   # azure-identity 自動快取 + 續期
```
- **單一 scope、單一角色、單一登入**同時涵蓋 chat 與 transcription（兩者都是 Azure OpenAI 資料平面）。
- token 快取持久化（Windows DPAPI），重啟免重登；過期自動續期（不需手寫 refresh-ahead）。
- `azure_auth_flow=device_code` 時改用 `DeviceCodeCredential`（顯示代碼到 microsoft.com/devicelogin）。

**設定來源**：spawn 時由 Electron 以環境變數帶入（仿你 systemd unit 的 `Environment=`）：`AZURE_ENDPOINT`、`AZURE_CHAT_DEPLOYMENT`、`AZURE_CHAT_API_VERSION`、`AZURE_ASR_MODEL`、`AZURE_ASR_API_VERSION`、`AZURE_ASR_LOCALES`、`AZURE_TENANT_ID`、`AZURE_CLIENT_ID`、`SIDECAR_PORT`、`SIDECAR_SECRET`、`AZURE_AUTH_FLOW`。

**生命週期**（仿 `sherpaManager`）：新增 `sidecarManager.js`：spawn / health poll / 崩潰重啟 / app 退出時 kill。僅在 `asr_provider===azure` 或 AI 走 Azure 時啟動（否則 lazy）。

---

## 6. Entra ID 前置（使用者一次性設定）

1. **public client app**（已建：`client_id=4441a9d4-…`、`tenant_id=16b3c013-…`）：開「Allow public client flows = Yes」、redirect URI `http://localhost` 必須註冊在 **「Mobile and desktop applications」platform**（不是 Web —— Web 平台的 redirect 不支援桌面 auth-code flow，登入會在換 token 時失敗）。
2. 對 `foundryweus2` 資源指派 RBAC（給登入的使用者身分）：
   - **Cognitive Services OpenAI User** — chat 潤飾用
   - **Cognitive Services Speech User** — Fast Transcription 用
   - （或用涵蓋兩者的 **Cognitive Services User**）
3. 在 SpeakSlow 設定頁填 endpoint / chat deployment / tenant / client。

> 因 `foundryweus2` 已是 custom-subdomain 資源、且 ASR 走 Fast Transcription **REST**（純 Bearer），**不需**再開不可逆 subdomain、不需 `aad#` 包裝、不需處理雙 audience、不需 Speech SDK —— 這些只有 path ①（in-app MSAL + Speech SDK）才會踩到。

---

## 7. SpeakSlow 端改動清單（接縫）

| 檔案 | 改動 | 規模 |
|------|------|------|
| `src/helpers/ipcHandlers.js` | 組 `asrManager` facade + `sidecarManager`，掛到 ctx | 中 |
| `src/helpers/ipc/transcription.js` | `ctx.sherpaManager.*` → `ctx.asrManager.*`；Azure 模式短路 streaming/precog | 小 |
| `src/helpers/azureAsrManager.js`（新） | batch 轉寫，回傳形狀對齊 sherpa | 中 |
| `src/helpers/sidecarManager.js`（新） | spawn/health/restart/kill 本地 proxy | 中 |
| `sidecar/aoai_proxy.py`（新，改自你的 aoai-proxy.py） | OpenAI 相容 → Azure，`azure-identity` 認證 | 中 |
| `src/helpers/aiTextProcessor.js` | 邏輯不變；測試連線改打 sidecar | 極小 |
| `src/helpers/database.js` | 無 schema 變更（泛用 key/value） | 無 |
| `src/settings.jsx` | 新增 ASR/Azure 分頁與欄位；登入按鈕 | 中 |
| `src/helpers/ipc/*` + `preload.js` | 新 IPC：`azure-sign-in`、`azure-status`、`sidecar-status` | 小 |
| `package.json` build | sidecar 納入 PyInstaller/extraResources | 小 |

**設定 UI 三處編輯點**（驗證確認，別漏）：`SETTINGS_TABS`、`loadSettings` 白名單、`saveSettings` 存檔清單（`src/settings.jsx`）。

---

## 8. 設定 schema（新增 key，全部可換）

```
asr_provider            = "local" | "azure"               (預設 local)
ai_provider_mode        = "openai" | "azure_sidecar"      (預設 openai)
azure_endpoint          = https://foundryweus2.cognitiveservices.azure.com/
azure_chat_deployment   = FW-MiniMax-M2.5                  (可換)
azure_chat_api_version  = 2024-10-21                      (chat 路由，可換)
azure_asr_model         = mai-transcribe-1                (可換)
azure_asr_api_version   = 2025-10-15                      (Fast Transcription)
azure_asr_locales       = []                              (空=多語自動；可填 ["zh-TW"]/["zh-CN"])
azure_tenant_id         = 16b3c013-d300-468d-ac64-7eda0820b6d3
azure_client_id         = 4441a9d4-c9fe-400a-9873-ed18beef03c1
azure_auth_flow         = "interactive" | "device_code"   (預設 interactive)
sidecar_port / sidecar_secret  (執行期產生)
```

---

## 9. 元件 C — OpenClaw（本期僅設計）

**接法**：SpeakSlow 指令模式新增 `kind:"openclaw"`，把文字 `POST https://<vm-domain>/hooks/agent`，body `{message, agentId?, sessionKey?}`，header `Authorization: Bearer <hooks_token>`。

**落地前必解（驗證標出的 blocker）**：
1. **可達性**：gateway `/hooks` 綁 `127.0.0.1:18789`，目前外部打不到。需在 VM 加 Caddy 反代 `/hooks → 127.0.0.1:18789`（或 SSH tunnel / Tailscale）。**這是 VM 端新增工作**。
2. **token = RCE**：VM `exec.security=full` + `acpx approve-all`，注入的 prompt 可在 VM 執行指令。→ **絕不可**把共用 token 打包進散佈的 .exe。
3. **per-user token 模型**：每位使用者各自於設定填自己的、可撤銷、以 `hooks.allowedAgentIds`/`allowedSessionKeyPrefixes` 限縮的 token。
4. **回傳路徑未設計**：agent 回覆如何回到桌面（deliver/channel 或輪詢）尚未設計。
5. **確認部署**：你這台是否 stock OpenClaw、hooks 是否啟用（需非空 token 才會啟動）。

本期交付：上述設計 + 一支獨立 spike 腳本（非 app 內）驗證 `/hooks/agent` 可達與認證，**不**進主程式。

---

## 10. 測試計畫（非協商）

- **Entra 60 分鐘以上 soak**：長 session token 自動續期、不中斷。
- **zh-TW vs zh-CN+OpenCC**：準度/標點 A/B，決定預設語言。
- **批次回傳形狀一致性**：`azureAsrManager` 與 `sherpaManager` 回傳欄位對齊，下游（DB、貼上、歷史）零改。
- **provider 切換**：local↔azure 來回切換無殘留 state；Azure 模式 precog/streaming 確實短路。
- **斷網/ sidecar 崩潰**：自動回退本地、提示明確。
- **本地安全**：sidecar 拒絕無 `<local_secret>` 的請求；只綁 127.0.0.1。
- **打包**：Windows 安裝後 sidecar PyInstaller 二進位可啟動、token 快取（DPAPI）持久化跨重啟。
- **OpenClaw spike**：token 絕不入 binary；per-user token 可撤銷驗證。

---

## 11. 打包與發佈

- sidecar 以 PyInstaller 打包成獨立二進位（仿 `sherpa_server`，`build:backend` 同機制），放 `extraResources`。
- `azure-identity` 及相依一併打包；**因 sidecar 是獨立行程，避開 Electron 原生模組 ABI 問題**（path ② 的打包優勢）。
- 安裝體積增加有限（azure-identity 純 Python）。
- 維持現有 Windows NSIS 流程。

---

## 12. 分階段與工作分解

```
Phase 0  你解鎖（純設定）：Entra app 註冊 + RBAC 角色；確認 chat/asr deployment 名與 endpoint；成本上限
Phase 1  sidecar 骨架：aoai_proxy.py + azure-identity 互動登入 + 快取，獨立驗證 chat & 轉寫各打通一次
Phase 2  元件 A：ai_base_url 指向 sidecar；checkAIStatus 改打 sidecar；端到端潤飾
Phase 3  sidecarManager 生命週期 + 設定 UI（三處編輯點）+ 新 IPC
Phase 4  元件 B 批次：asrManager facade + azureAsrManager + precog/streaming 短路 + zh 驗證 + 斷網回退
Phase 5  (延後) Azure 串流：需新事件推送 IPC，獨立評估
Phase 6  (延後/卡 Phase 0) 元件 C OpenClaw：先 VM 端開 /hooks 可達 + per-user token，再做 app 內單向送出
```

---

## 13. 風險登記簿

| 風險 | 嚴重度 | 緩解 |
|------|--------|------|
| OpenClaw hooks token 外洩 = VM RCE | Blocker | 不內嵌共用 token；per-user 可撤銷 scoped token；C 元件延後 |
| zh-TW 標點/ITN 缺 | 高 | zh-CN 辨識 + OpenCC 轉繁；A/B 驗證；本地仍為預設 |
| Azure 串流不相容現有同步協定 | 高 | v1 batch-only；串流固定走本地 |
| precog 每次錄音直打 sherpa | 中 | Azure 模式短路 precog |
| sidecar 本地被其他程式濫用 | 中 | 綁 127.0.0.1 + 隨機共享密鑰 Bearer |
| 成本（Azure 轉寫 ~USD1/小時） | 中 | 顯示用量；熱麥防呆；本地為預設 |
| sidecar 啟動失敗/崩潰 | 中 | health poll + 自動重啟 + 回退本地 |
| api-version 與轉寫模型相容性 | 低 | api-version 設定可換；Phase 1 驗證 |

---

## 14. 待你提供 / 開放問題

- ✅ Entra app（client/tenant）、✅ endpoint `foundryweus2`、✅ ASR=Fast Transcription+mai-transcribe-1、✅ chat deployment=`FW-MiniMax-M2.5`（已提供/已驗證；走 classic `/openai/deployments/` route，與你 aoai-proxy.py 對 Kimi 等目錄模型相同）

仍待補：
1. 確認 app reg 已開「Allow public client flows = Yes」+ redirect URI `http://localhost`。
2. RBAC：登入身分對 `foundryweus2` 是否已有 **Cognitive Services OpenAI User** + **Cognitive Services Speech User**（或 Cognitive Services User）。
3. 成本上限。
4. OpenClaw（延後）：VM 是否願意開 `/hooks` 反代；hooks 是否已啟用。

---

## GSTACK REVIEW REPORT

| Runs | Status | Findings |
|------|--------|----------|
| 自我審查（4 鏡頭：架構/品質/測試/效能） | ✅ done | 接縫 = asrManager facade + sidecar；AI 層近乎零改；設定 UI 三處編輯點；precog 須短路 |
| 9-agent 研究 workflow | ✅ done | 4 研究流 + 4 對抗式驗證 + 1 綜合 |
| 對抗式驗證（CROSS-MODEL absorbed） | ✅ done | 推翻：單 token 跨雙服務（錯，雙 audience）；Speech Entra 需不可逆 custom subdomain 與 aad# 包裝；zh-TW 無 ITN；OpenClaw 有 /hooks 但綁 localhost + token=RCE |
| Step 0 範圍挑戰 | ✅ done | 從零重寫否決；延伸現有 repo；sidecar 重用既有 embedded-Python 機制 |

**關鍵架構判斷**：選 path ②（本地 sidecar）而非 path ①（in-app MSAL）。sidecar 走 classic Azure deployment route + 單一 `cognitiveservices.azure.com/.default` scope，收斂 chat+轉寫於一登入一角色，並躲掉 custom-subdomain（不可逆）、aad# 包裝、雙 audience、Electron 原生模組 ABI 共 4~5 個 top risk。Azure ASR 走 `/audio/transcriptions`（batch），對應 SpeakSlow 主流程。

**VERDICT**: APPROVED — path ② 架構穩健、blast radius 受控（AI 層低、batch ASR 中）。元件 C（OpenClaw）維持延後，待 VM `/hooks` 可達性與 per-user token 安全模型解決。

NO UNRESOLVED DECISIONS
