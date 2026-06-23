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

  async _toTraditional(text) {
    if (!text) return text;
    // zh-tw-stt 模式：經典 Azure Speech STT 已原生輸出台灣繁體，不需 OpenCC（避免重複處理）
    const mode = (await this.databaseManager.getSetting("azure_asr_mode")) || "zh-tw-stt";
    if (mode === "zh-tw-stt") return text;
    const convert = await this.databaseManager.getSetting("convert_transcription");
    if (convert === false) return text; // 使用者在設定關掉「簡轉繁」
    const conv = this._converter();
    try {
      return conv ? conv(text) : text;
    } catch (e) {
      return text;
    }
  }

  // 後處理鏈：_toTraditional（依模式）→ 確定性專有名詞標準化（azure_term_normalization 可關）。
  // 讀一次開關後回傳套用函式，避免逐段重複查設定。回傳 {text, applied}。
  async _postProcessor() {
    const normOn = (await this.databaseManager.getSetting("azure_term_normalization")) !== false;
    return async (t) => {
      const tw = await this._toTraditional(t);
      if (!normOn || !tw) return { text: tw, applied: [] };
      return normalizeTerms(tw);
    };
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
      const original = data.text || "";
      data.raw_text = original;
      const post = await this._postProcessor();
      const top = await post(original);
      data.text = top.text;
      data.normalization_applied = top.applied;
      if (Array.isArray(data.segments)) {
        for (const s of data.segments) s.text = (await post(s.text)).text;
      }
      if (top.applied.length) {
        this.logger.info && this.logger.info(`[azureAsr] 標準化 ${top.applied.length} 處: ${top.applied.map((a) => `${a.from}→${a.to}`).join(", ")}`);
      }
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
      const original = data.text || "";
      data.raw_text = original;
      const post = await this._postProcessor();
      const top = await post(original);
      data.text = top.text;
      data.normalization_applied = top.applied;
      if (Array.isArray(data.segments)) {
        for (const s of data.segments) s.text = (await post(s.text)).text;
      }
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
