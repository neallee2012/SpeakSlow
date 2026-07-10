const { test } = require("node:test");
const assert = require("node:assert");
const { spawnSync } = require("node:child_process");

const load = () => import("../src/helpers/azureCliCommand.mjs");

test("Azure CLI command: Windows safely scopes the PowerShell environment assignment", async () => {
  const { buildAzureCliLoginCommand } = await load();
  const result = buildAzureCliLoginCommand({
    configDir: "C:\\Users\\O'Neil\\Dollar$User\\azure-cli",
    tenant: "contoso.onmicrosoft.com",
    platform: "win32",
  });
  assert.strictEqual(result.error, "");
  assert.strictEqual(result.shellLabel, "PowerShell");
  assert.ok(result.command.startsWith("& { $speakSlowHadAzureConfigDir = Test-Path Env:AZURE_CONFIG_DIR;"));
  assert.ok(result.command.includes("$env:AZURE_CONFIG_DIR='C:\\Users\\O''Neil\\Dollar$User\\azure-cli';"));
  assert.ok(result.command.includes("az login --scope https://cognitiveservices.azure.com/.default --tenant contoso.onmicrosoft.com"));
  assert.ok(result.command.includes("finally"));
  assert.ok(result.command.includes("Remove-Item Env:AZURE_CONFIG_DIR"));
});

function runPowerShell(command, setup) {
  const script = [
    setup,
    "function az { Write-Output \"during=$env:AZURE_CONFIG_DIR\" }",
    command,
    'Write-Output "afterExists=$(Test-Path Env:AZURE_CONFIG_DIR)"',
    'Write-Output "after=$env:AZURE_CONFIG_DIR"',
  ].join("; ");
  const result = spawnSync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8" },
  );
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout.replace(/\r/g, "");
}

test(
  "Azure CLI command: Windows restores an existing AZURE_CONFIG_DIR",
  { skip: process.platform !== "win32" },
  async () => {
    const { buildAzureCliLoginCommand } = await load();
    const { command } = buildAzureCliLoginCommand({
      configDir: "C:\\Users\\O'Neil\\Dollar$User\\azure-cli",
      platform: "win32",
    });
    const output = runPowerShell(command, "$env:AZURE_CONFIG_DIR='C:\\original'");
    assert.match(output, /during=C:\\Users\\O'Neil\\Dollar\$User\\azure-cli/);
    assert.match(output, /afterExists=True/);
    assert.match(output, /after=C:\\original/);
  },
);

test(
  "Azure CLI command: Windows removes AZURE_CONFIG_DIR when it was originally absent",
  { skip: process.platform !== "win32" },
  async () => {
    const { buildAzureCliLoginCommand } = await load();
    const { command } = buildAzureCliLoginCommand({
      configDir: "C:\\SpeakSlow\\azure-cli",
      platform: "win32",
    });
    const output = runPowerShell(
      command,
      "Remove-Item Env:AZURE_CONFIG_DIR -ErrorAction SilentlyContinue",
    );
    assert.match(output, /during=C:\\SpeakSlow\\azure-cli/);
    assert.match(output, /afterExists=False/);
    assert.match(output, /after=\s*$/);
  },
);

test("Azure CLI command: macOS/Linux uses a POSIX environment assignment", async () => {
  const { buildAzureCliLoginCommand } = await load();
  const result = buildAzureCliLoginCommand({
    configDir: "/Users/o'neil/.speakslow/azure-cli",
    tenant: "00000000-0000-0000-0000-000000000000",
    platform: "darwin",
  });
  assert.strictEqual(result.shellLabel, "Terminal");
  assert.ok(result.command.startsWith("AZURE_CONFIG_DIR='/Users/o'\"'\"'neil/.speakslow/azure-cli' az login"));
  assert.ok(result.command.endsWith("--tenant 00000000-0000-0000-0000-000000000000"));
});

test("Azure CLI command: invalid tenant blocks command generation", async () => {
  const { buildAzureCliLoginCommand } = await load();
  const result = buildAzureCliLoginCommand({
    configDir: "/tmp/azure",
    tenant: "https://login.microsoftonline.com/tenant",
    platform: "linux",
  });
  assert.strictEqual(result.command, "");
  assert.match(result.error, /Tenant 格式無效/);
});
