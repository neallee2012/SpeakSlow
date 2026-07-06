// 執行：node --test test/asrManager.test.js
// asrManager 本身不 require electron，但依任務慣例統一掛 require hook（無害）。
const Module = require("module");
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "electron") return { app: { getPath: () => "C:/tmp/test-userdata" } };
  return origRequire.apply(this, arguments);
};

const { test } = require("node:test");
const assert = require("node:assert");
const AsrManager = require("../src/helpers/asrManager");

const silentLogger = { info() {}, warn() {}, error() {} };

// 手工 spy：記錄呼叫參數，回傳固定值
function spy(returnValue) {
  const fn = (...args) => {
    fn.calls.push(args);
    return Promise.resolve(returnValue);
  };
  fn.calls = [];
  return fn;
}

function makeMocks() {
  const sherpa = {
    transcribeAudio: spy({ success: true, via: "sherpa.transcribeAudio" }),
    transcribeFilePath: spy({ success: true, via: "sherpa.transcribeFilePath" }),
    precogStart: spy({ success: true, via: "sherpa.precogStart" }),
    precogFeed: spy({ success: true, via: "sherpa.precogFeed" }),
    precogAbort: spy({ success: true, via: "sherpa.precogAbort" }),
    streamingStart: spy({ success: true, via: "sherpa.streamingStart" }),
    streamingFeed: spy({ success: true, via: "sherpa.streamingFeed" }),
    streamingEnd: spy({ success: true, via: "sherpa.streamingEnd" }),
    preloadStreamingModel: spy({ success: true, via: "sherpa.preload" }),
  };
  const azure = {
    transcribeAudio: spy({ success: true, via: "azure.transcribeAudio" }),
    transcribeFilePath: spy({ success: true, via: "azure.transcribeFilePath" }),
    streamingStart: spy({ success: true, via: "azure.streamingStart" }),
    streamingFeed: spy({ success: true, via: "azure.streamingFeed" }),
    streamingEnd: spy({ success: true, via: "azure.streamingEnd" }),
  };
  return { sherpa, azure };
}

function makeManager(provider, mocks = makeMocks()) {
  const databaseManager = {
    getSetting: async (k) => (k === "asr_provider" ? provider : undefined),
  };
  const mgr = new AsrManager(mocks.sherpa, mocks.azure, databaseManager, silentLogger);
  return { mgr, ...mocks };
}

// ---- transcribeAudio 路由 ----

test("transcribeAudio: provider=local → sherpa（帶原始參數）", async () => {
  const { mgr, sherpa, azure } = makeManager("local");
  const blob = Buffer.from("wav");
  const options = { no_persist: true };
  const r = await mgr.transcribeAudio(blob, options);
  assert.strictEqual(r.via, "sherpa.transcribeAudio");
  assert.strictEqual(sherpa.transcribeAudio.calls.length, 1);
  assert.strictEqual(sherpa.transcribeAudio.calls[0][0], blob);
  assert.strictEqual(sherpa.transcribeAudio.calls[0][1], options);
  assert.strictEqual(azure.transcribeAudio.calls.length, 0);
});

test("transcribeAudio: provider=azure → azureAsrManager", async () => {
  const { mgr, sherpa, azure } = makeManager("azure");
  const blob = Buffer.from("wav");
  const r = await mgr.transcribeAudio(blob, {});
  assert.strictEqual(r.via, "azure.transcribeAudio");
  assert.strictEqual(azure.transcribeAudio.calls.length, 1);
  assert.strictEqual(azure.transcribeAudio.calls[0][0], blob);
  assert.strictEqual(sherpa.transcribeAudio.calls.length, 0);
});

test("transcribeAudio: 設定缺失（undefined）→ 預設 local", async () => {
  const { mgr, sherpa } = makeManager(undefined);
  const r = await mgr.transcribeAudio(Buffer.from("wav"), {});
  assert.strictEqual(r.via, "sherpa.transcribeAudio");
  assert.strictEqual(sherpa.transcribeAudio.calls.length, 1);
});

test("transcribeAudio: getSetting 丟錯 → 安全退回 local", async () => {
  const mocks = makeMocks();
  const databaseManager = {
    getSetting: async () => {
      throw new Error("db down");
    },
  };
  const mgr = new AsrManager(mocks.sherpa, mocks.azure, databaseManager, silentLogger);
  const r = await mgr.transcribeAudio(Buffer.from("wav"), {});
  assert.strictEqual(r.via, "sherpa.transcribeAudio");
});

// ---- transcribeFilePath 路由 ----

test("transcribeFilePath: local → sherpa / azure → azure", async () => {
  {
    const { mgr, sherpa, azure } = makeManager("local");
    const r = await mgr.transcribeFilePath("/tmp/a.wav", { x: 1 });
    assert.strictEqual(r.via, "sherpa.transcribeFilePath");
    assert.deepStrictEqual(sherpa.transcribeFilePath.calls[0], ["/tmp/a.wav", { x: 1 }]);
    assert.strictEqual(azure.transcribeFilePath.calls.length, 0);
  }
  {
    const { mgr, sherpa, azure } = makeManager("azure");
    const r = await mgr.transcribeFilePath("/tmp/b.wav", {});
    assert.strictEqual(r.via, "azure.transcribeFilePath");
    assert.strictEqual(azure.transcribeFilePath.calls[0][0], "/tmp/b.wav");
    assert.strictEqual(sherpa.transcribeFilePath.calls.length, 0);
  }
});

// ---- precog：azure 短路 no-op，local 走 sherpa ----

test("precog*: azure → 短路 {success:true, skipped:true}，不碰 sherpa", async () => {
  const { mgr, sherpa } = makeManager("azure");
  assert.deepStrictEqual(await mgr.precogStart("profile-x"), { success: true, skipped: true });
  assert.deepStrictEqual(await mgr.precogFeed("QUJD"), { success: true, skipped: true, results: [] });
  assert.deepStrictEqual(await mgr.precogAbort(), { success: true, skipped: true });
  assert.strictEqual(sherpa.precogStart.calls.length, 0);
  assert.strictEqual(sherpa.precogFeed.calls.length, 0);
  assert.strictEqual(sherpa.precogAbort.calls.length, 0);
});

test("precog*: local → 路由到 sherpa（帶原始參數）", async () => {
  const { mgr, sherpa } = makeManager("local");
  assert.strictEqual((await mgr.precogStart("profile-x")).via, "sherpa.precogStart");
  assert.deepStrictEqual(sherpa.precogStart.calls[0], ["profile-x"]);
  assert.strictEqual((await mgr.precogFeed("QUJD")).via, "sherpa.precogFeed");
  assert.deepStrictEqual(sherpa.precogFeed.calls[0], ["QUJD"]);
  assert.strictEqual((await mgr.precogAbort()).via, "sherpa.precogAbort");
});

// ---- streaming：azure 走 azureAsrManager（sidecar 串流），local 走 sherpa ----

test("streaming*: azure → 路由到 azureAsrManager（帶原始參數），不碰 sherpa", async () => {
  const { mgr, sherpa, azure } = makeManager("azure");
  const options = { sampleRate: 16000 };
  assert.strictEqual((await mgr.streamingStart(options)).via, "azure.streamingStart");
  assert.strictEqual(azure.streamingStart.calls[0][0], options);
  const chunk = "QUJD"; // base64 PCM
  assert.strictEqual((await mgr.streamingFeed(chunk, false)).via, "azure.streamingFeed");
  assert.deepStrictEqual(azure.streamingFeed.calls[0], [chunk, false]);
  assert.strictEqual((await mgr.streamingEnd()).via, "azure.streamingEnd");
  assert.strictEqual(azure.streamingEnd.calls.length, 1);
  assert.strictEqual(sherpa.streamingStart.calls.length, 0);
  assert.strictEqual(sherpa.streamingFeed.calls.length, 0);
  assert.strictEqual(sherpa.streamingEnd.calls.length, 0);
});

test("streaming*: local → 路由到 sherpa（帶原始參數）", async () => {
  const { mgr, sherpa } = makeManager("local");
  const options = { profile: "meeting" };
  assert.strictEqual((await mgr.streamingStart(options)).via, "sherpa.streamingStart");
  assert.strictEqual(sherpa.streamingStart.calls[0][0], options);
  const chunk = Buffer.from("pcm");
  assert.strictEqual((await mgr.streamingFeed(chunk, true)).via, "sherpa.streamingFeed");
  assert.deepStrictEqual(sherpa.streamingFeed.calls[0], [chunk, true]);
  assert.strictEqual((await mgr.streamingEnd()).via, "sherpa.streamingEnd");
});

test("preloadStreamingModel: azure 短路 skipped / local 路由 sherpa", async () => {
  {
    const { mgr, sherpa } = makeManager("azure");
    assert.deepStrictEqual(await mgr.preloadStreamingModel(), { success: true, skipped: true });
    assert.strictEqual(sherpa.preloadStreamingModel.calls.length, 0);
  }
  {
    const { mgr, sherpa } = makeManager("local");
    assert.strictEqual((await mgr.preloadStreamingModel()).via, "sherpa.preload");
    assert.strictEqual(sherpa.preloadStreamingModel.calls.length, 1);
  }
});
