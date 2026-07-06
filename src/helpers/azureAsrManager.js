/**
 * AzureAsrManager — Azure 語音辨識後端（batch）。
 *
 * 對齊 sherpaManager 的回傳形狀，讓下游（DB、貼上、歷史）零改。實作上把音訊
 * WAV 交給本地 sidecar 的 /v1/audio/transcriptions（內部轉呼 Azure Speech Fast
 * Transcription + mai-transcribe-1）。只做 batch；串流/precog 由 asrManager 短路。
 *
 *   audioBlob(WAV) ──► sidecar.transcribe ──► {text, segments?} ──► sherpa 形狀
 */
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { app } = require("electron");
const { normalizeTerms } = require("./azureTermNormalizer");

class AzureAsrManager {
  constructor(sidecarManager, databaseManager, logger = console) {
    this.sidecar = sidecarManager;
    this.databaseManager = databaseManager;
    this.logger = logger;
  }

  _toBuffer(audioBlob) {
    if (Buffer.isBuffer(audioBlob)) return audioBlob;
    if (audioBlob instanceof ArrayBuffer) return Buffer.from(audioBlob);
    if (audioBlob instanceof Uint8Array) return Buffer.from(audioBlob);
    if (typeof audioBlob === "string") return Buffer.from(audioBlob, "base64");
    if (audioBlob && audioBlob.buffer) return Buffer.from(audioBlob.buffer);
    throw new Error(`不支援的音頻資料類型: ${typeof audioBlob}`);
  }

  // 與 sherpaManager._persistAudioInBackground 一致：背景複製，供「重新辨識」。
  _persistAudio(buffer) {
    try {
      const audioDir = path.join(app.getPath("userData"), "audio");
      const destPath = path.join(audioDir, `rec_${crypto.randomUUID()}.wav`);
      fs.promises
        .mkdir(audioDir, { recursive: true })
        .then(() => fs.promises.writeFile(destPath, buffer))
        .catch((e) => this.logger.warn && this.logger.warn("保存錄音檔失敗:", e?.message || e));
      return destPath;
    } catch (e) {
      return null;
    }
  }

  // 簡→繁（台灣標準字 + 慣用語）。mai-transcribe-1 多語模式輸出簡體，需轉繁以符合
  // SpeakSlow 的核心定位。用專案既有的 opencc-js（Node 端），不依賴 sherpa Python。
  _converter() {
    if (this.__conv === undefined) {
      try {
        const OpenCC = require("opencc-js");
        this.__conv = OpenCC.Converter({ from: "cn", to: "twp" });
      } catch (e) {
        this.logger.warn && this.logger.warn("opencc-js 載入失敗，Azure 轉寫不轉繁:", e?.message || e);
        this.__conv = null;
      }
    }
    return this.__conv;
  }

  // 後處理鏈（單一出口）：簡轉繁（依模式）→ 確定性專有名詞標準化（可關）。
  //
  //   sidecar 回傳 ──► [OpenCC 簡轉繁]* ──► [alias→canonical 標準化]* ──► 貼上/歷史
  //                    * zh-tw-stt 原生繁體跳過      * azure_term_normalization 可關
  //
  // 設定只在這裡讀一次（不逐段重查 DB）；回傳同步套用函式 {text, applied}。
  async _postProcessor() {
    const mode = (await this.databaseManager.getSetting("azure_asr_mode")) || "zh-tw-stt";
    const convertOff = (await this.databaseManager.getSetting("convert_transcription")) === false;
    const normOn = (await this.databaseManager.getSetting("azure_term_normalization")) !== false;
    // zh-tw-stt 原生輸出台灣繁體 → 免 OpenCC；mai 模式輸出簡體 → 需轉繁（除非使用者關掉）
    const conv = mode === "zh-tw-stt" || convertOff ? null : this._converter();
    return (t) => {
      if (!t) return { text: t, applied: [] };
      let tw = t;
      if (conv) {
        try {
          tw = conv(t);
        } catch (e) {
          /* 轉繁失敗保留原文 */
        }
      }
      return normOn ? normalizeTerms(tw) : { text: tw, applied: [] };
    };
  }

  // 共用後處理入口：transcribeAudio / transcribeFilePath 都走這裡（DRY 單一出口）。
  // 就地更新 data 的 text / raw_text / normalization_applied，逐段套用保留 timestamp。
  async _applyPostProcessing(data) {
    const original = data.text || "";
    data.raw_text = original;
    const post = await this._postProcessor();
    const top = post(original);
    data.text = top.text;
    data.normalization_applied = top.applied;
    if (Array.isArray(data.segments)) {
      for (const s of data.segments) s.text = post(s.text).text;
    }
    if (top.applied.length) {
      this.logger.info && this.logger.info(`[azureAsr] 標準化 ${top.applied.length} 處: ${top.applied.map((a) => `${a.from}→${a.to}`).join(", ")}`);
    }
    return data;
  }

  _toSherpaShape(data, audioPath) {
    const text = (data.text || "").trim();
    return {
      success: true,
      text,
      segments: data.segments || null, // Fast Transcription 的 phrases→segments（可能為 null）
      raw_text: data.raw_text || text,
      normalization_applied: data.normalization_applied || [], // debug：哪些 alias 被標準化
      confidence: typeof data.confidence === "number" ? data.confidence : 0.9,
      language: data.language || "auto",
      duration: 0,
      audio_path: audioPath,
    };
  }

  async transcribeAudio(audioBlob, options = {}) {
    let buffer;
    try {
      buffer = this._toBuffer(audioBlob);
    } catch (e) {
      return { success: false, error: e.message };
    }
    if (!buffer.length) return { success: false, error: "音頻資料為空" };

    try {
      this.logger.info && this.logger.info(`[azureAsr] 送 sidecar 轉寫, bytes=${buffer.length}`);
      const data = await this.sidecar.transcribe(buffer, {});
      this.logger.info && this.logger.info(`[azureAsr] sidecar 回傳 text="${(data.text || "").slice(0, 50)}"`);
      await this._applyPostProcessing(data);
      const audioPath = options && options.no_persist ? null : this._persistAudio(buffer);
      return this._toSherpaShape(data, audioPath);
    } catch (error) {
      this.logger.error && this.logger.error("Azure 轉寫失敗:", error?.message || error);
      let msg = error.message || "Azure 轉寫失敗";
      if (/ECONNREFUSED|fetch failed|sidecar/i.test(msg)) msg = "Azure sidecar 未就緒或登入失敗：" + msg;
      return { success: false, error: msg };
    }
  }

  async transcribeFilePath(filePath, options = {}) {
    try {
      const buffer = await fs.promises.readFile(filePath);
      const data = await this.sidecar.transcribe(buffer, {});
      await this._applyPostProcessing(data);
      return this._toSherpaShape(data, filePath);
    } catch (error) {
      return { success: false, error: error.message || "Azure 重新辨識失敗" };
    }
  }

  async checkStatus() {
    try {
      const st = await this.sidecar.getAuthStatus();
      return {
        installed: true,
        server_ready: !!st.signedIn,
        models_initialized: !!st.signedIn,
        provider: "azure",
        signedIn: !!st.signedIn,
        username: st.username || null,
      };
    } catch (e) {
      return { installed: true, server_ready: false, provider: "azure", error: e.message };
    }
  }
}

module.exports = AzureAsrManager;
