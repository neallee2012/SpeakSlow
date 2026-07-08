/**
 * SidecarManager — 管理本地 Azure sidecar（OpenAI 相容 proxy）行程的生命週期。
 *
 * 與 sherpaManager 同樣的 spawn 模式：開發模式用 python 跑 sidecar/aoai_proxy.py，
 * 打包版直接跑 PyInstaller 的 aoai_proxy(.exe)。sidecar 綁 127.0.0.1，啟動時印出
 * 「SIDECAR_READY ... port=N」，我們解析出實際 port。
 *
 *   SpeakSlow main ── http://127.0.0.1:<port>/v1 ──► sidecar ── Entra ──► Azure
 *
 * 認證細節（Entra 登入、token 續期、雙服務 scope）全在 sidecar，這裡只負責
 * 啟動 / 健康 / 重啟 / 關閉，並把 baseUrl + 本地密鑰交給呼叫端。
 */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { app } = require("electron");

class SidecarManager {
  constructor(databaseManager, logger = console) {
    this.databaseManager = databaseManager;
    this.logger = logger;
    this.proc = null;
    this.port = null;
    this.ready = false;
    this.secret = null;
    this._startPromise = null;

    // app 退出時收掉 sidecar（避免殘留行程）
    try {
      app.on("will-quit", () => this.stop());
    } catch (e) {
      /* 測試環境沒有 app，忽略 */
    }
  }

  status() {
    return { running: !!this.proc, ready: this.ready, port: this.port };
  }

  getBaseUrl() {
    if (!this.port) return null;
    return `http://127.0.0.1:${this.port}/v1`;
  }

  getSecret() {
    return this.secret;
  }

  _authHeaders(extra = {}) {
    return { Authorization: `Bearer ${this.secret}`, ...extra };
  }

  // 解析要跑哪個 sidecar：打包版用獨立 exe，開發版用有裝 azure-identity/requests 的 python。
  _resolveCommand() {
    const isPackaged = app?.isPackaged && process.env.NODE_ENV !== "development";
    if (isPackaged) {
      const exe = path.join(
        process.resourcesPath,
        "azure-sidecar",
        process.platform === "win32" ? "aoai_proxy.exe" : "aoai_proxy"
      );
      return { command: exe, args: [], cwd: path.dirname(exe), exists: fs.existsSync(exe) };
    }
    // 開發模式：sidecar 的 python 需有 azure-identity/requests（見 sidecar/requirements.txt）。
    // 不用 sherpa 的嵌入式 python（沒有這些套件）。優先 sidecar 自己的 venv，再退系統 python。
    const projectRoot = path.join(__dirname, "..", "..");
    const script = path.join(projectRoot, "sidecar", "aoai_proxy.py");
    const candidates =
      process.platform === "win32"
        ? [
            path.join(projectRoot, "sidecar", ".venv", "Scripts", "python.exe"),
            path.join(projectRoot, ".venv", "Scripts", "python.exe"),
            "python",
            "python3",
          ]
        : [
            path.join(projectRoot, "sidecar", ".venv", "bin", "python"),
            path.join(projectRoot, ".venv", "bin", "python"),
            "python3",
            "python",
          ];
    let python = candidates.find((p) => p.includes(path.sep) && fs.existsSync(p));
    if (!python) python = process.platform === "win32" ? "python" : "python3";
    return { command: python, args: [script], cwd: path.join(projectRoot, "sidecar"), exists: fs.existsSync(script) };
  }

  async _buildEnv() {
    const get = async (k, d = "") => {
      const v = await this.databaseManager.getSetting(k);
      return v === undefined || v === null ? d : v;
    };
    const recordPath = path.join(app.getPath("userData"), "azure-entra-record.json");
    return {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUNBUFFERED: "1",
      AZURE_ENDPOINT: await get("azure_endpoint", "https://foundryweus2.cognitiveservices.azure.com"),
      AZURE_TENANT_ID: await get("azure_tenant_id"),
      AZURE_CLIENT_ID: await get("azure_client_id"),
      AZURE_CHAT_DEPLOYMENT: await get("azure_chat_deployment"),
      AZURE_CHAT_API_VERSION: await get("azure_chat_api_version", "2024-10-21"),
      AZURE_ASR_MODE: await get("azure_asr_mode", "zh-tw-stt"),
      AZURE_ASR_MODEL: await get("azure_asr_model", "mai-transcribe-1"),
      AZURE_ASR_API_VERSION: await get("azure_asr_api_version", "2025-10-15"),
      AZURE_ASR_LOCALES: await get("azure_asr_locales", "[]"),
      AZURE_AUTH_FLOW: await get("azure_auth_flow", "interactive"),
      // Phrase List（只在 zh-tw-stt 經典路徑生效；改設定後 saveSettings 會 restart sidecar 重載）
      AZURE_PHRASE_LIST_ENABLED: String((await get("azure_phrase_list_enabled", true)) !== false),
      AZURE_PHRASE_BUNDLES: await get("azure_phrase_bundles", "ai_governance,ai_harness,azure_cloud"),
      AZURE_PHRASE_EXTRA: await get("azure_phrase_extra", ""),
      // 串流辨識（Speech SDK aad token）：resource id + region
      AZURE_RESOURCE_ID: await get(
        "azure_resource_id",
        "/subscriptions/fd50f208-ec1f-4985-85e0-5cb476436ca3/resourceGroups/newfoundry01/providers/Microsoft.CognitiveServices/accounts/foundryweus2"
      ),
      AZURE_SPEECH_REGION: await get("azure_speech_region", "westus2"),
      // debug_log_ai_prompts 開啟時，sidecar 也記轉寫請求 definition（phrases 只記數量、
      // token/secret 絕不記）——與 Node 端「完整 AI 請求」同一顆開關
      SIDECAR_DEBUG: (await get("debug_log_ai_prompts", false)) === true ? "1" : "",
      SIDECAR_HOST: "127.0.0.1",
      SIDECAR_PORT: "0",
      SIDECAR_SECRET: this.secret,
      SIDECAR_RECORD_PATH: recordPath,
    };
  }

  async ensureStarted() {
    if (this.ready) return true;
    if (this._startPromise) return this._startPromise;
    const p = this._start().finally(() => {
      if (this._startPromise === p) this._startPromise = null; // 只清自己，避免清掉 restart 後的新啟動
    });
    this._startPromise = p;
    return p;
  }

  async _start() {
    const { command, args, cwd, exists } = this._resolveCommand();
    if (!exists) {
      throw new Error(`Azure sidecar 未找到（${command} ${args.join(" ")}）。開發模式請先在 sidecar/ 安裝相依。`);
    }
    const tenant = await this.databaseManager.getSetting("azure_tenant_id");
    const client = await this.databaseManager.getSetting("azure_client_id");
    if (!tenant || !client) {
      throw new Error("Azure 尚未設定 tenant_id / client_id，請先到設定頁填入");
    }

    this.secret = crypto.randomBytes(24).toString("hex");
    const env = await this._buildEnv();

    this.logger.info && this.logger.info("啟動 Azure sidecar", { command, args, cwd });

    return new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env, cwd });
      this.proc = child;

      child.stdout.on("data", (data) => {
        for (const line of data.toString().split("\n")) {
          const t = line.trim();
          if (!t) continue;
          this.logger.debug && this.logger.debug("sidecar stdout", { line: t });
          const m = t.match(/^SIDECAR_READY\b.*?\bport=(\d+)/);
          if (m && !settled) {
            this.port = parseInt(m[1], 10);
            this.ready = true;
            settled = true;
            this.logger.info && this.logger.info("Azure sidecar 就緒", { port: this.port });
            resolve(true);
          }
          // device-code 流程的代碼會印在這裡，方便顯示
          if (/DEVICE CODE:/.test(t)) {
            this.logger.info && this.logger.info(t);
          }
        }
      });

      child.stderr.on("data", (data) => {
        this.logger.warn && this.logger.warn("sidecar stderr", { err: data.toString() });
      });

      child.on("close", (code) => {
        this.logger.warn && this.logger.warn("Azure sidecar 退出", { code });
        // 只清「當前」行程的狀態：restart() 後舊行程的 close 晚到，不能清掉剛啟動的新行程
        if (this.proc === child) {
          this.proc = null;
          this.ready = false;
          this.port = null;
        }
        if (!settled) {
          settled = true;
          reject(new Error(`Azure sidecar 啟動失敗（exit ${code}）`));
        }
      });

      child.on("error", (error) => {
        this.logger.error && this.logger.error("Azure sidecar 行程錯誤", error);
        if (this.proc === child) {
          this.proc = null;
          this.ready = false;
        }
        if (!settled) {
          settled = true;
          reject(error);
        }
      });

      setTimeout(() => {
        if (!settled) {
          settled = true;
          this.logger.warn && this.logger.warn("Azure sidecar 啟動超時");
          this.stop();
          reject(new Error("Azure sidecar 啟動超時"));
        }
      }, 30000);
    });
  }

  stop() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch (e) {
        /* ignore */
      }
    }
    this.proc = null;
    this.ready = false;
    this.port = null;
  }

  // 設定變更後重啟（拿新的 endpoint/deployment/auth flow）
  async restart() {
    this.stop();
    this._startPromise = null; // 丟棄進行中的舊啟動（child 已被 stop kill），強制重新啟動
    return this.ensureStarted();
  }

  // ---- 對 sidecar 的 HTTP 呼叫 ----
  async signIn() {
    await this.ensureStarted();
    const r = await fetch(`${this.getBaseUrl()}/auth/login`, { method: "POST", headers: this._authHeaders() });
    return r.json();
  }

  async getAuthStatus() {
    await this.ensureStarted();
    const r = await fetch(`${this.getBaseUrl()}/auth/status`, { headers: this._authHeaders() });
    return r.json();
  }

  // wavBuffer: Node Buffer of WAV bytes. options.locales: 可選覆寫
  async transcribe(wavBuffer, options = {}) {
    await this.ensureStarted();
    let url = `${this.getBaseUrl()}/audio/transcriptions`;
    if (options.locales) url += `?locales=${encodeURIComponent(options.locales)}`;
    const r = await fetch(url, {
      method: "POST",
      headers: this._authHeaders({ "Content-Type": "audio/wav" }),
      body: wavBuffer,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error((data && data.error && data.error.message) || `轉寫失敗 HTTP ${r.status}`);
    }
    return data;
  }

  // ---- 串流辨識（鏡射 sherpa 的 request/response 協定；sidecar 內部用 Speech SDK）----
  // 錯誤映射同 transcribe()：non-ok → throw。sidecar 串流路由的 error 是字串
  // （{"success":false,"error":"..."}），也相容 OpenAI 形狀的 {error:{message}}。
  async _streamPost(action, body, label) {
    await this.ensureStarted();
    const r = await fetch(`${this.getBaseUrl()}/stream/${action}`, {
      method: "POST",
      headers: this._authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg =
        data && data.error && (typeof data.error === "string" ? data.error : data.error.message);
      throw new Error(msg || `${label}失敗 HTTP ${r.status}`);
    }
    return data;
  }

  // POST /v1/stream/init → {success, sessionId}
  async streamInit(sampleRate) {
    return this._streamPost("init", { sample_rate: sampleRate || 16000 }, "串流初始化");
  }

  // POST /v1/stream/feed → {success, partialText}
  async streamFeed(sessionId, audioB64, isFinal) {
    return this._streamPost(
      "feed",
      { session_id: sessionId, audio_data: audioB64, is_final: !!isFinal },
      "串流送音"
    );
  }

  // POST /v1/stream/end → {success, finalText, rawText}
  async streamEnd(sessionId) {
    return this._streamPost("end", { session_id: sessionId }, "串流結束");
  }
}

module.exports = SidecarManager;
