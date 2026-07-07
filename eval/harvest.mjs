#!/usr/bin/env node
/**
 * 從你的真實聽寫歷史（transcriptions.db，唯讀）提名 eval 候選題。
 *
 * 挑「潤飾前後有差異」的紀錄——那些是潤飾真正出手的案例，最值得進題庫。
 * 輸出候選 JSONL 到 stdout；人工挑選、補上 must_keep/must_remove 標註後
 * 貼進 eval/cases/harvested.jsonl。
 *
 * 實作註記：repo 的 better-sqlite3 被 rebuild 成 Electron ABI（系統 Node 載不動），
 * 所以這裡借 python 內建 sqlite3 讀（唯讀、零額外依賴）。
 *
 * 用法：node eval/harvest.mjs [--limit 20]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 防呆：負數/0/非數字回退 20；上限 200（SQLite 的 LIMIT -1 = 整庫傾倒）
const limit = (() => {
  const i = process.argv.indexOf("--limit");
  const v = i >= 0 ? parseInt(process.argv[i + 1], 10) : 20;
  return Math.min(Math.max(Number.isFinite(v) ? v : 20, 1), 200);
})();

// 多行 python 走暫存檔執行（Windows 下 -c 的引號轉義是地獄，直接繞開）
const py = `
import sqlite3, os, json, sys
sys.stdout.reconfigure(encoding="utf-8")
db_path = os.path.join(os.path.expanduser("~"), "AppData", "Roaming", "聲聲慢", "transcriptions.db")
db = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
rows = db.execute(
    "SELECT id, raw_text, processed_text FROM transcriptions "
    "WHERE raw_text IS NOT NULL AND raw_text != '' "
    "AND processed_text IS NOT NULL AND processed_text != raw_text "
    "ORDER BY id DESC LIMIT ?", (${limit},)).fetchall()
print(json.dumps([{"id": r[0], "raw": r[1], "processed": r[2]} for r in rows], ensure_ascii=False))
`;
// 專屬暫存目錄（不可預測路徑）+ 不經 shell 執行（python.exe 由 PATH 直接解析）
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "speakslow-harvest-"));
const tmp = path.join(tmpDir, "query.py");
fs.writeFileSync(tmp, py, "utf-8");
let rows;
try {
  rows = JSON.parse(execFileSync("python", [tmp], { encoding: "utf-8", env: { ...process.env, PYTHONUTF8: "1" } }));
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
console.error(`# 提名 ${rows.length} 筆（潤飾有出手的歷史紀錄）`);
console.error(`# 人工補上 must_keep/must_remove/must_not_contain 後貼進 eval/cases/harvested.jsonl\n`);
for (const r of rows) {
  console.log(
    JSON.stringify({
      id: `hist-${r.id}`,
      cat: "真題",
      input: r.raw,
      notes: `歷史潤飾輸出（僅參考，非標準答案）：${(r.processed || "").slice(0, 60)}`,
    })
  );
}
