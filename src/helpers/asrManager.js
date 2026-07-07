/**
 * AsrManager — 唯一的 ASR 切換接縫（local sherpa | azure）。
 *
 * 依 `asr_provider` 設定把「會因後端不同而不同」的方法分派出去；其餘 sherpa 專屬
 * 方法（熱詞、模型、狀態、重啟）不在這層，transcription.js 仍直接呼 ctx.sherpaManager。
 *
 *   asr_provider = local  → 全部走 sherpaManager（現況，預設）
 *   asr_provider = azure  → transcribe / streaming 走 azureAsrManager
 *                           （streaming 由 sidecar 的 Speech SDK 連續辨識承接）；
 *                           precog no-op（sherpa 專屬最佳化）
 */
class AsrManager {
  constructor(sherpaManager, azureAsrManager, databaseManager, logger = console) {
    this.sherpa = sherpaManager;
    this.azure = azureAsrManager;
    this.databaseManager = databaseManager;
    this.logger = logger;
  }

  async _provider() {
    try {
      return (await this.databaseManager.getSetting("asr_provider")) || "local";
    } catch (e) {
      return "local";
    }
  }

  async _isAzure() {
    return (await this._provider()) === "azure";
  }

  async transcribeAudio(audioBlob, options = {}) {
    const provider = await this._provider();
    const n = (audioBlob && (audioBlob.length || audioBlob.byteLength)) || "?";
    this.logger.info && this.logger.info(`[asrManager] transcribeAudio provider=${provider} bytes=${n}`);
    return provider === "azure"
      ? this.azure.transcribeAudio(audioBlob, options)
      : this.sherpa.transcribeAudio(audioBlob, options);
  }

  async transcribeFilePath(filePath, options = {}) {
    return (await this._isAzure())
      ? this.azure.transcribeFilePath(filePath, options)
      : this.sherpa.transcribeFilePath(filePath, options);
  }

  // precog（邊錄邊算）是 sherpa 專屬最佳化；Azure 模式短路成 no-op，不啟動 sherpa。
  async precogStart(profile) {
    if (await this._isAzure()) return { success: true, skipped: true };
    return this.sherpa.precogStart(profile);
  }

  async precogFeed(audioB64) {
    if (await this._isAzure()) return { success: true, skipped: true, results: [] };
    return this.sherpa.precogFeed(audioB64);
  }

  async precogAbort() {
    if (await this._isAzure()) return { success: true, skipped: true };
    return this.sherpa.precogAbort();
  }

  // streaming：兩個後端同形狀（request/response 協定），依 provider 路由。
  async streamingStart(options = {}) {
    return (await this._isAzure())
      ? this.azure.streamingStart(options)
      : this.sherpa.streamingStart(options);
  }

  async streamingFeed(audioChunk, isFinal = false) {
    return (await this._isAzure())
      ? this.azure.streamingFeed(audioChunk, isFinal)
      : this.sherpa.streamingFeed(audioChunk, isFinal);
  }

  async streamingEnd() {
    return (await this._isAzure()) ? this.azure.streamingEnd() : this.sherpa.streamingEnd();
  }

  // Azure 無模型可預載（sidecar 依需啟動）→ 維持 no-op skipped。
  async preloadStreamingModel() {
    if (await this._isAzure()) return { success: true, skipped: true };
    return this.sherpa.preloadStreamingModel();
  }
}

module.exports = AsrManager;
