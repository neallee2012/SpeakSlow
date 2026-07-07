// 執行：node --test test/azureAsrManagerStreaming.test.js
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

// 手工 spy：記錄呼叫參數，回傳固定值（或丟出 throws）
function spy(returnValue, { throws } = {}) {
  const fn = (...args) => {
    fn.calls.push(args);
    if (throws) return Promise.reject(throws);
    return Promise.resolve(returnValue);
  };
  fn.calls = [];
  return fn;
}

function makeSidecar(overrides = {}) {
  return {
    streamInit: spy({ success: true, sessionId: "sess-uuid-1" }),
    streamFeed: spy({ success: true, partialText: "部分結果" }),
    streamEnd: spy({ success: true, finalText: "最終結果", rawText: "最終結果" }),
    ...overrides,
  };
}

// zh-tw-stt 預設：原生繁體（不走 OpenCC）、azure_term_normalization 預設開
function makeManager(sidecar = makeSidecar(), settings = { azure_asr_mode: "zh-tw-stt" }) {
  const databaseManager = { getSetting: async (k) => settings[k] };
  return new AzureAsrManager(sidecar, databaseManager, silentLogger);
}

// ---- streamingStart ----

test("streamingStart: 成功 → 存下 session 並回 {success, sessionId}", async () => {
  const sidecar = makeSidecar();
  const mgr = makeManager(sidecar);
  const r = await mgr.streamingStart({ sampleRate: 16000 });
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.sessionId, "sess-uuid-1");
  assert.strictEqual(mgr.activeStreamSession, "sess-uuid-1");
  assert.deepStrictEqual(sidecar.streamInit.calls, [[16000]]);
});

test("streamingStart: 未帶 sampleRate → 預設 16000", async () => {
  const sidecar = makeSidecar();
  const mgr = makeManager(sidecar);
  await mgr.streamingStart();
  assert.deepStrictEqual(sidecar.streamInit.calls, [[16000]]);
});

test("streamingStart: sidecar 回 success:false → 不存 session", async () => {
  const sidecar = makeSidecar({ streamInit: spy({ success: false, error: "boom" }) });
  const mgr = makeManager(sidecar);
  const r = await mgr.streamingStart({});
  assert.strictEqual(r.success, false);
  assert.strictEqual(mgr.activeStreamSession, null);
});

test("streamingStart: sidecar 丟錯 → {success:false, error}", async () => {
  const sidecar = makeSidecar({
    streamInit: spy(null, { throws: new Error("Azure sidecar 啟動超時") }),
  });
  const mgr = makeManager(sidecar);
  const r = await mgr.streamingStart({});
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, "Azure sidecar 啟動超時");
  assert.strictEqual(mgr.activeStreamSession, null);
});

test("streamingStart: 已有活躍會話後重啟失敗 → 清掉殘留 session id（Copilot P1 回歸）", async () => {
  // 情境：session1 活躍 → 再 init 失敗（token 失效等）→ 舊 id 必已失效，
  // 不清會讓之後的 feed 拿殘留 id 打 404
  let calls = 0;
  const sidecar = makeSidecar({
    streamInit: async (...args) => {
      calls += 1;
      if (calls === 1) return { success: true, sessionId: "sess-uuid-1" };
      throw new Error("auth: token expired");
    },
  });
  const mgr = makeManager(sidecar);
  await mgr.streamingStart({});
  assert.strictEqual(mgr.activeStreamSession, "sess-uuid-1");
  const r = await mgr.streamingStart({});
  assert.strictEqual(r.success, false);
  assert.strictEqual(mgr.activeStreamSession, null); // 殘留 id 必須清掉
  const fr = await mgr.streamingFeed("QUJD", false);
  assert.strictEqual(fr.success, false); // 之後 feed 得到明確錯誤，而不是拿舊 id 打 404
});

// ---- streamingFeed ----

test("streamingFeed: 沒有活動會話 → 明確錯誤，不碰 sidecar", async () => {
  const sidecar = makeSidecar();
  const mgr = makeManager(sidecar);
  const r = await mgr.streamingFeed("QUJD", false);
  assert.deepStrictEqual(r, { success: false, error: "沒有活動的串流會話" });
  assert.strictEqual(sidecar.streamFeed.calls.length, 0);
});

test("streamingFeed: (sessionId, b64, isFinal) 透傳，回 partial_text（renderer 線上格式）", async () => {
  const sidecar = makeSidecar();
  const mgr = makeManager(sidecar);
  await mgr.streamingStart({});
  const r = await mgr.streamingFeed("QUJDRA==", true);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.partial_text, "部分結果"); // manager 輸出 snake_case（映射自 sidecar 的 partialText）
  assert.deepStrictEqual(sidecar.streamFeed.calls, [["sess-uuid-1", "QUJDRA==", true]]);
});

test("streamingFeed: sidecar 丟錯 → {success:false, error}（會話保留，可再試/收尾）", async () => {
  const sidecar = makeSidecar({ streamFeed: spy(null, { throws: new Error("HTTP 503") }) });
  const mgr = makeManager(sidecar);
  await mgr.streamingStart({});
  const r = await mgr.streamingFeed("QUJD", false);
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, "HTTP 503");
  assert.strictEqual(mgr.activeStreamSession, "sess-uuid-1");
});

// ---- streamingEnd ----

test("streamingEnd: 沒有活動會話 → 明確錯誤，不碰 sidecar", async () => {
  const sidecar = makeSidecar();
  const mgr = makeManager(sidecar);
  const r = await mgr.streamingEnd();
  assert.deepStrictEqual(r, { success: false, error: "沒有活動的串流會話" });
  assert.strictEqual(sidecar.streamEnd.calls.length, 0);
});

test("streamingEnd: 套標準化（final_text 標準化、raw_text 保留原文、applied=2）並清 session", async () => {
  const sidecar = makeSidecar({
    streamEnd: spy({
      success: true,
      finalText: "azure open ai 和 rbac",
      rawText: "azure open ai 和 rbac",
    }),
  });
  const mgr = makeManager(sidecar);
  await mgr.streamingStart({});
  const r = await mgr.streamingEnd();
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.final_text, "Azure OpenAI 和 RBAC");
  assert.strictEqual(r.raw_text, "azure open ai 和 rbac"); // 標準化前的原文保留
  assert.strictEqual(r.normalization_applied.length, 2);
  assert.strictEqual(mgr.activeStreamSession, null); // 會話已清
  assert.deepStrictEqual(sidecar.streamEnd.calls, [["sess-uuid-1"]]);
});

test("streamingEnd: azure_term_normalization=false → 文字不變、applied 空", async () => {
  const sidecar = makeSidecar({
    streamEnd: spy({ success: true, finalText: "azure open ai", rawText: "azure open ai" }),
  });
  const mgr = makeManager(sidecar, { azure_asr_mode: "zh-tw-stt", azure_term_normalization: false });
  await mgr.streamingStart({});
  const r = await mgr.streamingEnd();
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.final_text, "azure open ai");
  assert.strictEqual(r.raw_text, "azure open ai");
  assert.deepStrictEqual(r.normalization_applied, []);
});

test("streamingEnd: sidecar 丟錯 → {success:false, error}，session 仍被清掉", async () => {
  const sidecar = makeSidecar({ streamEnd: spy(null, { throws: new Error("fetch failed") }) });
  const mgr = makeManager(sidecar);
  await mgr.streamingStart({});
  const r = await mgr.streamingEnd();
  assert.strictEqual(r.success, false);
  assert.strictEqual(r.error, "fetch failed");
  assert.strictEqual(mgr.activeStreamSession, null);
});

test("streamingEnd: sidecar 回 success:false → 透傳錯誤，session 清掉、不做標準化", async () => {
  const sidecar = makeSidecar({ streamEnd: spy({ success: false, error: "會話不存在" }) });
  const mgr = makeManager(sidecar);
  await mgr.streamingStart({});
  const r = await mgr.streamingEnd();
  assert.deepStrictEqual(r, { success: false, error: "會話不存在" });
  assert.strictEqual(mgr.activeStreamSession, null);
});
