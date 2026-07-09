const { ipcMain } = require("electron");

/**
 * Azure sidecar 相關 IPC：登入、狀態、重啟。設定頁的「用 Microsoft 登入」按鈕
 * 與 provider 切換會用到。所有處理都包 try/catch，不讓 sidecar 問題炸到 UI。
 */
module.exports = function register(ctx) {
  // 觸發 Entra 互動登入（彈瀏覽器）或回傳 device code
  ipcMain.handle("azure-sign-in", async () => {
    try {
      return { success: true, ...(await ctx.sidecarManager.signIn()) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 查目前登入狀態（signedIn / username / pendingDeviceCode）
  ipcMain.handle("azure-auth-status", async () => {
    try {
      return { success: true, ...(await ctx.sidecarManager.getAuthStatus()) };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 「獨立 az 登入」的解析路徑 + 現成登入指令（給設定頁顯示/複製）
  ipcMain.handle("azure-cli-config-dir", async () => {
    try {
      const dir = ctx.sidecarManager.getAzureCliConfigDir();
      const tenant = (await ctx.sidecarManager.databaseManager.getSetting("azure_tenant_id")) || "";
      // 一次登入到專屬目錄的 PowerShell 指令（互動瀏覽器流程，避開被 CA 擋的裝置碼）
      const loginCmd =
        `$env:AZURE_CONFIG_DIR="${dir}"; az login --scope https://cognitiveservices.azure.com/.default` +
        (tenant ? ` --tenant ${tenant}` : "");
      return { success: true, dir, loginCmd };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // sidecar 行程狀態（running / ready / port）
  ipcMain.handle("azure-sidecar-status", async () => {
    try {
      return { success: true, ...ctx.sidecarManager.status() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 設定變更後重啟 sidecar（換 endpoint/deployment/auth flow）
  ipcMain.handle("azure-sidecar-restart", async () => {
    try {
      await ctx.sidecarManager.restart();
      return { success: true, ...ctx.sidecarManager.status() };
    } catch (e) {
      return { success: false, error: e.message };
    }
  });

  // 測試：直接打 sidecar 的 chat（不看 AI 潤飾開關），驗證 chat deployment + Entra 通。
  // 在 Azure 分頁按「測試 AI」意圖很明確＝測 Azure，所以強制走 sidecar 並回真實錯誤。
  ipcMain.handle("azure-test-chat", async () => {
    try {
      await ctx.sidecarManager.ensureStarted();
      const base = ctx.sidecarManager.getBaseUrl();
      const secret = ctx.sidecarManager.getSecret();
      const dep = (await ctx.databaseManager.getSetting("azure_chat_deployment")) || "";
      if (!dep) return { available: false, error: "尚未填 chat deployment" };
      const resp = await fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: dep,
          messages: [{ role: "user", content: "請只回覆：測試成功" }],
          max_tokens: 500,
          temperature: 0,
        }),
        signal: AbortSignal.timeout(60000),
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.ok && data.choices && data.choices.length) {
        return { available: true, model: dep, response: data.choices[0].message?.content?.trim() };
      }
      return { available: false, error: (data.error && (data.error.message || data.error)) || `HTTP ${resp.status}` };
    } catch (e) {
      return { available: false, error: e.message };
    }
  });
};
