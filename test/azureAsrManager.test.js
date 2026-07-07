// 執行：node --test test/azureAsrManager.test.js
// azureAsrManager 在頂層 require('electron')，plain node 下會炸 → 先掛 require hook mock。
const Module = require("module");
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "electron") return { app: { getPath: () => "C:/tmp/test-userdata" } };
  return origRequire.apply(this, arguments);
};

const { test } = require("node:test");
const assert = require("node:assert");
const AzureAsrManager = require("../src/helpers/azureAsrManager");

const silentLogger = { info() {}, warn() {}, error() {} };

function makeManager({ settings = {}, sidecar = {} } = {}) {
  const databaseManager = { getSetting: async (k) => settings[k] };
  return new AzureAsrManager(sidecar, databaseManager, silentLogger);
}

// ---- _toBuffer ----

test("_toBuffer: Buffer 直接 passthrough（同一參考）", () => {
  const mgr = makeManager();
  const buf = Buffer.from("hello");
  assert.strictEqual(mgr._toBuffer(buf), buf);
});

test("_toBuffer: ArrayBuffer → Buffer（內容一致）", () => {
  const mgr = makeManager();
  const src = Buffer.from("abc");
  const ab = src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength);
  const out = mgr._toBuffer(ab);
  assert.ok(Buffer.isBuffer(out));
  assert.strictEqual(out.toString(), "abc");
});

test("_toBuffer: Uint8Array → Buffer（內容一致）", () => {
  const mgr = makeManager();
  const u8 = new Uint8Array([104, 105]); // "hi"
  const out = mgr._toBuffer(u8);
  assert.ok(Buffer.isBuffer(out));
  assert.strictEqual(out.toString(), "hi");
});

test("_toBuffer: base64 字串解碼", () => {
  const mgr = makeManager();
  const out = mgr._toBuffer(Buffer.from("wav-bytes").toString("base64"));
  assert.ok(Buffer.isBuffer(out));
  assert.strictEqual(out.toString(), "wav-bytes");
});

test("_toBuffer: 不支援的類型丟出錯誤", () => {
  const mgr = makeManager();
  assert.throws(() => mgr._toBuffer(12345), /不支援的音頻資料類型: number/);
});

// ---- _postProcessor / _applyPostProcessing ----

test("後處理 (a) zh-tw-stt 預設：無 OpenCC、標準化套用、timestamp 保留", async () => {
  const mgr = makeManager({ settings: { azure_asr_mode: "zh-tw-stt" } });
  const data = {
    text: "我們用 azure open ai 和 rbac",
    segments: [
      { start: 0, end: 1, text: "我們用 azure open ai" },
      { start: 1, end: 2, text: "和 rbac" },
    ],
  };
  await mgr._applyPostProcessing(data);
  assert.strictEqual(data.text, "我們用 Azure OpenAI 和 RBAC");
  assert.strictEqual(data.raw_text, "我們用 azure open ai 和 rbac");
  assert.strictEqual(data.normalization_applied.length, 2);
  assert.strictEqual(data.segments[0].text, "我們用 Azure OpenAI");
  assert.strictEqual(data.segments[1].text, "和 RBAC");
  // segment timestamp 不被後處理動到
  assert.strictEqual(data.segments[0].start, 0);
  assert.strictEqual(data.segments[0].end, 1);
  assert.strictEqual(data.segments[1].start, 1);
  assert.strictEqual(data.segments[1].end, 2);
});

test("後處理 (b) azure_term_normalization=false：文字不變、applied 空", async () => {
  const mgr = makeManager({ settings: { azure_term_normalization: false } });
  const data = { text: "azure open ai" };
  await mgr._applyPostProcessing(data);
  assert.strictEqual(data.text, "azure open ai");
  assert.deepStrictEqual(data.normalization_applied, []);
  assert.strictEqual(data.raw_text, "azure open ai");
});

test("後處理 (c) mai-transcribe：OpenCC 簡轉繁 + 標準化", async () => {
  const mgr = makeManager({ settings: { azure_asr_mode: "mai-transcribe" } });
  const data = { text: "今天天气很好，用 azure open ai" };
  await mgr._applyPostProcessing(data);
  assert.strictEqual(data.text, "今天天氣很好，用 Azure OpenAI");
  assert.strictEqual(data.raw_text, "今天天气很好，用 azure open ai");
  assert.strictEqual(data.normalization_applied.length, 1);
});

// ---- transcribeAudio ----

test("transcribeAudio: 空 buffer → 音頻資料為空", async () => {
  const mgr = makeManager();
  const r = await mgr.transcribeAudio(Buffer.alloc(0), { no_persist: true });
  assert.deepStrictEqual(r, { success: false, error: "音頻資料為空" });
});

test("transcribeAudio: sidecar fetch failed → 友善的『sidecar 未就緒』訊息", async () => {
  const mgr = makeManager({
    sidecar: {
      transcribe: async () => {
        throw new Error("fetch failed");
      },
    },
  });
  const r = await mgr.transcribeAudio(Buffer.from("RIFFxxxx"), { no_persist: true });
  assert.strictEqual(r.success, false);
  assert.ok(r.error.includes("sidecar 未就緒"), `期待友善訊息，實得: ${r.error}`);
  assert.ok(r.error.includes("fetch failed"), "原始錯誤保留在訊息尾");
});

test("transcribeAudio: 成功路徑（no_persist）→ sherpa 形狀 + 標準化後文字", async () => {
  const mgr = makeManager({
    sidecar: { transcribe: async () => ({ text: "azure open ai" }) },
  });
  const r = await mgr.transcribeAudio(Buffer.from("RIFFxxxx"), { no_persist: true });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.text, "Azure OpenAI");
  assert.strictEqual(r.raw_text, "azure open ai");
  assert.strictEqual(r.audio_path, null); // no_persist 不落地
  assert.strictEqual(r.confidence, 0.9);
});

// ---- _toSherpaShape ----

test("_toSherpaShape: 預設值補齊（confidence 0.9 / success true / applied []）", () => {
  const mgr = makeManager();
  const r = mgr._toSherpaShape({ text: " hi " }, "/a.wav");
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.text, "hi"); // trim
  assert.strictEqual(r.segments, null);
  assert.strictEqual(r.raw_text, "hi");
  assert.deepStrictEqual(r.normalization_applied, []);
  assert.strictEqual(r.confidence, 0.9);
  assert.strictEqual(r.language, "auto");
  assert.strictEqual(r.duration, 0);
  assert.strictEqual(r.audio_path, "/a.wav");
});

test("_toSherpaShape: 已有的 confidence / normalization_applied 不被覆蓋", () => {
  const mgr = makeManager();
  const applied = [{ from: "rbac", to: "RBAC" }];
  const r = mgr._toSherpaShape(
    { text: "x", confidence: 0.42, normalization_applied: applied, language: "zh" },
    null
  );
  assert.strictEqual(r.confidence, 0.42);
  assert.deepStrictEqual(r.normalization_applied, applied);
  assert.strictEqual(r.language, "zh");
  assert.strictEqual(r.audio_path, null);
});

// ---- 自訂修正字典（azure_custom_corrections）在後處理鏈中的位置 ----

test("後處理鏈：自訂修正字典先修錯字，再走內建標準化，applied 合併", async () => {
  const mgr = makeManager({
    settings: {
      azure_asr_mode: "zh-tw-stt",
      azure_custom_corrections: "論視=>潤飾\n# 註解行\n船流=>串流",
    },
  });
  const data = { text: "azure open ai 的論視與船流功能", segments: null };
  await mgr._applyPostProcessing(data);
  assert.strictEqual(data.text, "Azure OpenAI 的潤飾與串流功能");
  // applied：先字典（論視、船流）後內建（azure open ai）
  assert.deepStrictEqual(
    data.normalization_applied.map((a) => `${a.from}→${a.to}`),
    ["論視→潤飾", "船流→串流", "azure open ai→Azure OpenAI"]
  );
});

test("後處理鏈：內建標準化關閉時，自訂修正字典仍生效（使用者明確意圖）", async () => {
  const mgr = makeManager({
    settings: {
      azure_asr_mode: "zh-tw-stt",
      azure_term_normalization: false,
      azure_custom_corrections: "論視=>潤飾",
    },
  });
  const data = { text: "azure open ai 的論視功能", segments: null };
  await mgr._applyPostProcessing(data);
  assert.strictEqual(data.text, "azure open ai 的潤飾功能"); // 字典修了、內建沒動
});

test("後處理鏈：沒設定修正字典時行為不變", async () => {
  const mgr = makeManager({ settings: { azure_asr_mode: "zh-tw-stt" } });
  const data = { text: "我們用 rbac", segments: null };
  await mgr._applyPostProcessing(data);
  assert.strictEqual(data.text, "我們用 RBAC");
});

test("後處理鏈：跨段規則語義——頂層 text 權威修正，segments 各段獨立（不跨段改寫）", async () => {
  const mgr = makeManager({
    settings: { azure_asr_mode: "zh-tw-stt", azure_custom_corrections: "論視=>潤飾" },
  });
  // 「論」「視」被切在兩段：頂層合併文字可命中規則，segments 各自不含完整錯字
  const data = {
    text: "AI的論視功能",
    segments: [
      { start: 0, end: 1, text: "AI的論" },
      { start: 1, end: 2, text: "視功能" },
    ],
  };
  await mgr._applyPostProcessing(data);
  assert.strictEqual(data.text, "AI的潤飾功能");        // 頂層：修正生效
  assert.strictEqual(data.segments[0].text, "AI的論");   // 段落：各段獨立，跨段不強行改寫
  assert.strictEqual(data.segments[1].text, "視功能");
  assert.strictEqual(data.segments[0].start, 0);          // timestamp 結構不動
});
