// 執行：node --test test/sidecarManager.test.js
// sidecarManager 在頂層 require('electron') → 先掛 require hook mock。
// mock 的 app 沒有 .on，constructor 內的 app.on 會丟 TypeError，但被 try/catch 吃掉（測試環境預期行為）。
const Module = require("module");
const origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "electron") return { app: { getPath: () => "C:/tmp/test-userdata" } };
  return origRequire.apply(this, arguments);
};

const { test } = require("node:test");
const assert = require("node:assert");
const SidecarManager = require("../src/helpers/sidecarManager");

const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

function makeManager(settings = {}) {
  const databaseManager = { getSetting: async (k) => settings[k] };
  return new SidecarManager(databaseManager, silentLogger);
}

// ---- _buildEnv ----

test("_buildEnv: 設定缺席時套用預設值", async () => {
  const mgr = makeManager({});
  mgr.secret = "test-secret-abc";
  const env = await mgr._buildEnv();
  assert.strictEqual(env.AZURE_ENDPOINT, "https://foundryweus2.cognitiveservices.azure.com");
  assert.strictEqual(env.AZURE_ASR_MODE, "zh-tw-stt");
  assert.strictEqual(env.AZURE_ASR_MODEL, "mai-transcribe-1");
  assert.strictEqual(env.AZURE_CHAT_API_VERSION, "2024-10-21");
  assert.strictEqual(env.AZURE_ASR_API_VERSION, "2025-10-15");
  assert.strictEqual(env.AZURE_ASR_LOCALES, "[]");
  assert.strictEqual(env.AZURE_AUTH_FLOW, "interactive");
  assert.strictEqual(env.AZURE_PHRASE_LIST_ENABLED, "true"); // 預設開，且是字串
  assert.strictEqual(env.AZURE_PHRASE_BUNDLES, "ai_governance,ai_harness,azure_cloud");
  assert.strictEqual(env.AZURE_PHRASE_EXTRA, "");
  assert.strictEqual(env.SIDECAR_HOST, "127.0.0.1");
  assert.strictEqual(env.SIDECAR_PORT, "0");
  assert.strictEqual(env.SIDECAR_SECRET, "test-secret-abc"); // 等於 instance secret
  assert.ok(env.SIDECAR_RECORD_PATH.includes("azure-entra-record.json"));
  assert.strictEqual(env.PYTHONIOENCODING, "utf-8");
  assert.strictEqual(env.PYTHONUNBUFFERED, "1");
});

test("_buildEnv: 已設定的值覆蓋預設；phrase_list=false → 字串 'false'", async () => {
  const mgr = makeManager({
    azure_endpoint: "https://custom.cognitiveservices.azure.com",
    azure_tenant_id: "tid-123",
    azure_client_id: "cid-456",
    azure_asr_mode: "mai-transcribe",
    azure_phrase_list_enabled: false,
    azure_phrase_bundles: "azure_cloud",
    azure_phrase_extra: "SpeakSlow,OpenClaw",
  });
  mgr.secret = "s2";
  const env = await mgr._buildEnv();
  assert.strictEqual(env.AZURE_ENDPOINT, "https://custom.cognitiveservices.azure.com");
  assert.strictEqual(env.AZURE_TENANT_ID, "tid-123");
  assert.strictEqual(env.AZURE_CLIENT_ID, "cid-456");
  assert.strictEqual(env.AZURE_ASR_MODE, "mai-transcribe");
  assert.strictEqual(env.AZURE_PHRASE_LIST_ENABLED, "false"); // boolean → 字串
  assert.strictEqual(env.AZURE_PHRASE_BUNDLES, "azure_cloud");
  assert.strictEqual(env.AZURE_PHRASE_EXTRA, "SpeakSlow,OpenClaw");
  assert.strictEqual(env.SIDECAR_SECRET, "s2");
});

// ---- transcribe（monkeypatch global.fetch；ready=true 讓 ensureStarted 短路）----

function primeReady(mgr) {
  mgr.ready = true;
  mgr.port = 45678;
  mgr.secret = "s3cr3t";
}

test("transcribe: sidecar 回 429 → 丟出友善節流訊息", async () => {
  const mgr = makeManager({});
  primeReady(mgr);
  const friendly = "Azure 語音服務忙碌中（節流），已重試仍失敗，稍候幾秒再試。（HTTP 429）";
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 429,
    json: async () => ({ error: { message: friendly } }),
  });
  try {
    await assert.rejects(mgr.transcribe(Buffer.from("RIFF")), (err) => {
      assert.strictEqual(err.message, friendly);
      return true;
    });
  } finally {
    global.fetch = origFetch;
  }
});

test("transcribe: 成功 → 回傳 sidecar 的 JSON；URL 與授權標頭正確", async () => {
  const mgr = makeManager({});
  primeReady(mgr);
  const origFetch = global.fetch;
  let seenUrl = null;
  let seenOpts = null;
  global.fetch = async (url, opts) => {
    seenUrl = url;
    seenOpts = opts;
    return { ok: true, json: async () => ({ text: "hi" }) };
  };
  try {
    const wav = Buffer.from("RIFFdata");
    const data = await mgr.transcribe(wav, {});
    assert.deepStrictEqual(data, { text: "hi" });
    assert.strictEqual(seenUrl, "http://127.0.0.1:45678/v1/audio/transcriptions");
    assert.strictEqual(seenOpts.method, "POST");
    assert.strictEqual(seenOpts.headers.Authorization, "Bearer s3cr3t");
    assert.strictEqual(seenOpts.headers["Content-Type"], "audio/wav");
    assert.strictEqual(seenOpts.body, wav);
  } finally {
    global.fetch = origFetch;
  }
});

test("transcribe: options.locales 追加到 query string", async () => {
  const mgr = makeManager({});
  primeReady(mgr);
  const origFetch = global.fetch;
  let seenUrl = null;
  global.fetch = async (url) => {
    seenUrl = url;
    return { ok: true, json: async () => ({ text: "ok" }) };
  };
  try {
    await mgr.transcribe(Buffer.from("RIFF"), { locales: "zh-TW,en-US" });
    assert.strictEqual(
      seenUrl,
      "http://127.0.0.1:45678/v1/audio/transcriptions?locales=zh-TW%2Cen-US"
    );
  } finally {
    global.fetch = origFetch;
  }
});

test("transcribe: 非 JSON 錯誤 body → 退回『轉寫失敗 HTTP <status>』", async () => {
  const mgr = makeManager({});
  primeReady(mgr);
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok: false,
    status: 503,
    json: async () => {
      throw new Error("not json");
    },
  });
  try {
    await assert.rejects(mgr.transcribe(Buffer.from("RIFF")), /轉寫失敗 HTTP 503/);
  } finally {
    global.fetch = origFetch;
  }
});
