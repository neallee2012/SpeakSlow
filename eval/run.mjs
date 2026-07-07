#!/usr/bin/env node
/**
 * AI 潤飾 Eval Harness — 主考官
 *
 * 用「生產同一份 prompt」（直接 require src/helpers/aiPrompts.js）考潤飾模型，
 * 三層打分：①確定性斷言（P1 gate）②期望比對 ③LLM 裁判（Kimi-K2.5，主觀科）。
 *
 * 用法：
 *   node eval/run.mjs                     # 全題庫、預設模型、含裁判
 *   node eval/run.mjs --model X           # A/B 換受測模型（deployment 名）
 *   node eval/run.mjs --runs 3            # 穩定性：同題多跑，統計不一致率
 *   node eval/run.mjs --no-judge          # 只跑確定性層（零 LLM 裁判成本）
 *   node eval/run.mjs --only 保護 --limit 5
 *
 * 認證：az CLI session（同 sidecar 的 azure_cli 流），tenant 16b3c013。
 */
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { buildPrompts, SYSTEM_PROMPT } = require("../src/helpers/aiPrompts.js");

// ---- config ----
const args = process.argv.slice(2);
const arg = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const has = (name) => args.includes(`--${name}`);

const TENANT = "16b3c013-d300-468d-ac64-7eda0820b6d3";
const CLASSIC_BASE = "https://foundryweus2.cognitiveservices.azure.com";
const V1_URL = "https://foundryweus2.services.ai.azure.com/openai/v1/chat/completions";
const MODEL = arg("model", "FW-MiniMax-M2.5"); // 受測（生產潤飾模型）
const JUDGE = arg("judge", "Kimi-K2.5");       // 裁判（不同家族，主觀科用）
const RUNS = parseInt(arg("runs", "1"), 10);
const LIMIT = parseInt(arg("limit", "0"), 10);
const ONLY = arg("only", "");
const NO_JUDGE = has("no-judge");
const CASES_PATH = arg("cases", path.join(__dirname, "cases", "core.jsonl"));
const CONCURRENCY = 4;

// ---- auth（同 sidecar 的 azure_cli 流）----
function getToken() {
  return execFileSync(
    "az",
    ["account", "get-access-token", "--resource", "https://cognitiveservices.azure.com",
     "--tenant", TENANT, "--query", "accessToken", "-o", "tsv"],
    { encoding: "utf-8", shell: true }
  ).trim();
}
const TOKEN = getToken();

// ---- LLM 呼叫（含 429/503 一次退避重試，鏡射 sidecar 行為）----
async function chat(url, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if ((r.status === 429 || r.status === 503) && attempt < 2) {
      const wait = parseFloat(r.headers.get("retry-after")) || 2 * (attempt + 1);
      await new Promise((res) => setTimeout(res, Math.min(wait, 10) * 1000));
      continue;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const data = await r.json();
    return data.choices?.[0]?.message?.content ?? "";
  }
}

// 受測：與 aiTextProcessor.processTextWithAI 完全同參數（classic deployments 路由）
async function polish(input, model) {
  const url = `${CLASSIC_BASE}/openai/deployments/${model}/chat/completions?api-version=2024-10-21`;
  return chat(url, {
    model,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildPrompts(input).optimize },
    ],
    temperature: 0.3,
    max_tokens: 2000,
    stream: false,
  });
}

// 裁判：Kimi-K2.5（reasoning 模型——max_tokens 給足，答案取 content 內的 JSON）
async function judge(input, output) {
  const prompt = `你是語音聽寫潤飾品質的裁判。以下是 ASR 辨識原文與 AI 潤飾後的輸出，請就兩個維度打 1-5 分（5 最好）：
- fluency（順暢度）：輸出讀起來是否自然通順、像人寫的
- fidelity（保意）：是否 100% 保留原意（重要資訊、數字、立場、專有名詞未被改變或遺失；刪贅字/修錯字不扣分，改變意思重扣）

【辨識原文】${input}
【潤飾輸出】${output}

只輸出一行 JSON，格式：{"fluency":N,"fidelity":N,"reason":"十五字內理由"}`;
  const content = await chat(V1_URL, {
    model: JUDGE,
    messages: [{ role: "user", content: prompt }],
    temperature: 0,
    max_tokens: 4096,
  });
  const m = content.match(/\{[^{}]*"fluency"[^{}]*\}/);
  if (!m) return { fluency: null, fidelity: null, reason: "judge 未回 JSON" };
  try { return JSON.parse(m[0]); } catch { return { fluency: null, fidelity: null, reason: "judge JSON 解析失敗" }; }
}

// ---- 第 1 層：確定性斷言 ----
function assertCase(c, out) {
  const fails = [];
  const o = out ?? "";
  for (const s of c.must_keep || []) if (!o.includes(s)) fails.push(`缺必留「${s}」`);
  for (const s of c.must_remove || []) if (o.includes(s)) fails.push(`未移除「${s}」`);
  for (const s of c.must_not_contain || []) if (o.includes(s)) fails.push(`出現禁詞「${s}」`);
  if (c.must_contain_any && !c.must_contain_any.some((s) => o.includes(s)))
    fails.push(`缺任一「${c.must_contain_any.join("/")}」`);
  if (c.expected !== undefined && o.trim() !== c.expected) fails.push(`期望「${c.expected}」得「${o.trim().slice(0, 20)}」`);
  if (c.max_len !== undefined && o.trim().length > c.max_len) fails.push(`超長（${o.trim().length}>${c.max_len}，疑腦補）`);
  // 誤刪警戒：輸出遠短於輸入（清單/空輸入類除外）
  const warn =
    !["清單", "空輸入"].includes(c.cat) && o.trim().length < c.input.length * 0.35
      ? `輸出過短（${o.trim().length}/${c.input.length}），疑誤刪`
      : null;
  return { pass: fails.length === 0, fails, warn };
}

// ---- 主流程 ----
async function main() {
  const cases = fs.readFileSync(CASES_PATH, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter((c) => !ONLY || c.cat === ONLY)
    .slice(0, LIMIT || undefined);
  const promptHash = createHash("sha256").update(SYSTEM_PROMPT + buildPrompts("__X__").optimize).digest("hex").slice(0, 12);
  console.log(`受測=${MODEL} 裁判=${NO_JUDGE ? "(關)" : JUDGE} 題數=${cases.length} runs=${RUNS} promptHash=${promptHash}\n`);

  const results = [];
  let idx = 0;
  async function worker() {
    while (idx < cases.length) {
      const c = cases[idx++];
      const outs = [];
      for (let r = 0; r < RUNS; r++) {
        try { outs.push((await polish(c.input, MODEL)).trim()); }
        catch (e) { outs.push(`__ERROR__ ${e.message}`); }
      }
      const out = outs[0];
      const det = out.startsWith("__ERROR__") ? { pass: false, fails: [out.slice(0, 80)], warn: null } : assertCase(c, out);
      const distinct = new Set(outs.map((s) => s.replace(/\s+/g, ""))).size;
      let jd = null;
      if (!NO_JUDGE && !out.startsWith("__ERROR__") && !["空輸入"].includes(c.cat)) {
        try { jd = await judge(c.input, out); } catch (e) { jd = { fluency: null, fidelity: null, reason: `judge錯誤:${e.message.slice(0, 40)}` }; }
      }
      results.push({ ...c, output: out, outputs: RUNS > 1 ? outs : undefined, det, distinct, judge: jd });
      const mark = det.pass ? "✅" : "❌";
      const jstr = jd ? ` 順${jd.fluency}/意${jd.fidelity}` : "";
      const sstr = RUNS > 1 ? ` 版本${distinct}/${RUNS}` : "";
      console.log(`${mark} [${c.cat}] ${c.id}${jstr}${sstr}${det.pass ? "" : "  ← " + det.fails.join("；")}${det.warn ? "  ⚠ " + det.warn : ""}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // ---- 記分卡 ----
  const byCat = {};
  for (const r of results) {
    const b = (byCat[r.cat] ||= { total: 0, pass: 0, flu: [], fid: [], unstable: 0 });
    b.total++; if (r.det.pass) b.pass++;
    if (r.judge?.fluency) b.flu.push(r.judge.fluency);
    if (r.judge?.fidelity) b.fid.push(r.judge.fidelity);
    if (r.distinct > 1) b.unstable++;
  }
  const avg = (a) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : "-");
  console.log("\n================= 記分卡 =================");
  console.log("考科        通過      順暢  保意" + (RUNS > 1 ? "  不穩定" : ""));
  for (const [cat, b] of Object.entries(byCat)) {
    const gate = cat === "保護" || cat === "腦補哨兵" ? (b.pass === b.total ? "" : "  🚨 P1-GATE") : "";
    console.log(`${cat.padEnd(6, "　")} ${String(b.pass).padStart(2)}/${b.total}     ${avg(b.flu)}   ${avg(b.fid)}${RUNS > 1 ? `    ${b.unstable}/${b.total}` : ""}${gate}`);
  }
  const totPass = results.filter((r) => r.det.pass).length;
  const allFlu = results.flatMap((r) => (r.judge?.fluency ? [r.judge.fluency] : []));
  const allFid = results.flatMap((r) => (r.judge?.fidelity ? [r.judge.fidelity] : []));
  console.log("------------------------------------------");
  console.log(`總計 ${totPass}/${results.length}（${((totPass / results.length) * 100).toFixed(0)}%） 順暢 ${avg(allFlu)}/5 保意 ${avg(allFid)}/5`);

  // ---- 存檔（趨勢追蹤）----
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const outFile = path.join(__dirname, "results", `${ts}_${MODEL}.jsonl`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const header = { _meta: true, ts, model: MODEL, judge: NO_JUDGE ? null : JUDGE, runs: RUNS, promptHash, total: results.length, pass: totPass };
  fs.writeFileSync(outFile, [header, ...results].map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\n結果已存：${path.relative(process.cwd(), outFile)}`);
}

main().catch((e) => { console.error("FATAL:", e.message); process.exit(1); });
