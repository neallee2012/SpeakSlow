const { test } = require("node:test");
const assert = require("node:assert");

const load = () => import("../src/helpers/azureCliCommand.mjs");

test("Azure CLI command: Windows uses safely quoted PowerShell environment assignment", async () => {
  const { buildAzureCliLoginCommand } = await load();
  const result = buildAzureCliLoginCommand({
    configDir: "C:\\Users\\O'Neil\\Dollar$User\\azure-cli",
    tenant: "contoso.onmicrosoft.com",
    platform: "win32",
  });
  assert.strictEqual(result.error, "");
  assert.strictEqual(result.shellLabel, "PowerShell");
  assert.ok(result.command.startsWith("$env:AZURE_CONFIG_DIR='C:\\Users\\O''Neil\\Dollar$User\\azure-cli'; az login"));
  assert.ok(result.command.endsWith("--tenant contoso.onmicrosoft.com"));
});

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
