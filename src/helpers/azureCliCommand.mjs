const TENANT_GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const TENANT_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

function quotePowerShell(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function quotePosix(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

function buildPowerShellLogin(configDir, login) {
  return [
    "& {",
    "$speakSlowHadAzureConfigDir = Test-Path Env:AZURE_CONFIG_DIR;",
    "$speakSlowPreviousAzureConfigDir = $env:AZURE_CONFIG_DIR;",
    "try {",
    `$env:AZURE_CONFIG_DIR=${quotePowerShell(configDir)};`,
    login,
    "} finally {",
    "if ($speakSlowHadAzureConfigDir) {",
    "$env:AZURE_CONFIG_DIR = $speakSlowPreviousAzureConfigDir",
    "} else {",
    "Remove-Item Env:AZURE_CONFIG_DIR -ErrorAction SilentlyContinue",
    "}",
    "}",
    "}",
  ].join(" ");
}

export function buildAzureCliLoginCommand({ configDir, tenant = "", platform = "win32" } = {}) {
  const shellLabel = platform === "win32" ? "PowerShell" : "Terminal";
  if (!configDir) return { command: "", error: "", shellLabel };

  const normalizedTenant = String(tenant).trim();
  const tenantSafe = !normalizedTenant
    || TENANT_GUID_RE.test(normalizedTenant)
    || TENANT_NAME_RE.test(normalizedTenant);
  if (!tenantSafe) {
    return {
      command: "",
      error: "Tenant 格式無效：請填 GUID 或租戶網域",
      shellLabel,
    };
  }

  const tenantArg = normalizedTenant ? ` --tenant ${normalizedTenant}` : "";
  const login = `az login --scope https://cognitiveservices.azure.com/.default${tenantArg}`;
  const command = platform === "win32"
    ? buildPowerShellLogin(configDir, login)
    : `AZURE_CONFIG_DIR=${quotePosix(configDir)} ${login}`;
  return { command, error: "", shellLabel };
}
