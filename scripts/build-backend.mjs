// 用 PyInstaller 打包 Python 後端為 onedir exe。
// 優先用專案內的 .venv python（裡面才有 PyInstaller + sherpa_onnx），
// 找不到才退回系統 `python`。這樣 `npm run dist:win` 不會再因為
// 裸 `python` 指到沒裝 PyInstaller 的直譯器而「靜默失敗打包出舊版」。
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  path.join(root, ".venv", "Scripts", "python.exe"), // Windows venv
  path.join(root, ".venv", "bin", "python3"), // POSIX venv
  path.join(root, ".venv", "bin", "python"),
];
const py = candidates.find(existsSync) || "python";
console.log(`[build:backend] python: ${py}`);

// 先確認這支 python 真的有 PyInstaller，否則早點報清楚的錯
const check = spawnSync(py, ["-c", "import PyInstaller"], { cwd: root });
if (check.status !== 0) {
  console.error(
    `[build:backend] 這支 python 沒有 PyInstaller：${py}\n` +
      `請先安裝後端依賴： npm run prepare:python`
  );
  process.exit(1);
}

const args = [
  "-m", "PyInstaller", "--onedir", "--noconfirm", "--clean",
  "--collect-all", "sherpa_onnx",
  "--collect-all", "opencc",
  "--collect-all", "edge_tts",
  "--collect-all", "aiohttp",
  "--collect-all", "certifi",
  "--hidden-import", "edge_tts",
  "--distpath", "build_pyi/dist",
  "--workpath", "build_pyi/work",
  "--specpath", "build_pyi",
  "sherpa_server.py",
];
const r = spawnSync(py, args, { stdio: "inherit", cwd: root });
if ((r.status ?? 1) !== 0) process.exit(r.status ?? 1);

// === Azure sidecar（path ②）===
// 只有 build python 有 azure-identity 才打包；否則警告但不擋 sherpa 打包成功，
// 讓沒用 Azure 的人照常出 dist（boring-by-default，不破壞既有流程）。
const hasAzure = spawnSync(py, ["-c", "import azure.identity, requests"], { cwd: root });
if (hasAzure.status !== 0) {
  console.warn(
    "[build:backend] 跳過 Azure sidecar 打包（這支 python 缺 azure-identity/requests）。\n" +
      "  打包版將沒有 Azure 功能。要啟用： npm run prepare:python（已含 azure-identity requests）。"
  );
  process.exit(0);
}
console.log("[build:backend] 打包 Azure sidecar (aoai_proxy.py)...");
const sidecarArgs = [
  "-m", "PyInstaller", "--onedir", "--noconfirm", "--clean",
  "--name", "aoai_proxy",
  "--collect-all", "azure.identity",
  "--collect-all", "azure.core",
  "--collect-all", "msal",
  "--collect-all", "msal_extensions",
  "--collect-all", "requests",
  "--collect-all", "certifi",
  // 把 Phrase List 詞庫一起打包進 onedir（執行期 _MEIPASS/phrases）
  "--add-data", `${path.join(root, "sidecar", "phrases")}${process.platform === "win32" ? ";" : ":"}phrases`,
  "--distpath", "build_pyi/dist",
  "--workpath", "build_pyi/work",
  "--specpath", "build_pyi",
  path.join(root, "sidecar", "aoai_proxy.py"),
];
const r2 = spawnSync(py, sidecarArgs, { stdio: "inherit", cwd: root });
process.exit(r2.status ?? 1);
