const AITextProcessor = require("./aiTextProcessor");
const SidecarManager = require("./sidecarManager");
const AzureAsrManager = require("./azureAsrManager");
const AsrManager = require("./asrManager");

class IPCHandlers {
  constructor(managers) {
    this.environmentManager = managers.environmentManager;
    this.databaseManager = managers.databaseManager;
    this.clipboardManager = managers.clipboardManager;
    this.sherpaManager = managers.sherpaManager;
    this.windowManager = managers.windowManager;
    this.hotkeyManager = managers.hotkeyManager;
    this.typelessManager = managers.typelessManager;
    this.logger = managers.logger; // 添加logger引用

    // Azure 整合（path ②）：本地 sidecar + 切換式 ASR facade。
    // sherpa 仍是預設；只有 asr_provider===azure / ai_provider_mode===azure_sidecar 時才會啟動 sidecar。
    this.sidecarManager = new SidecarManager(this.databaseManager, this.logger);
    this.azureAsrManager = new AzureAsrManager(this.sidecarManager, this.databaseManager, this.logger);
    this.asrManager = new AsrManager(this.sherpaManager, this.azureAsrManager, this.databaseManager, this.logger);
    this.aiProcessor = new AITextProcessor(this.databaseManager, this.logger, this.sidecarManager);

    // 跟踪F2热键注册状态
    this.f2RegisteredSenders = new Set();

    this.setupHandlers();
  }

  setupHandlers() {
    // 各領域 IPC handler 註冊模組（行為與原單一檔案完全相同，僅搬移位置）
    require("./ipc/transcription")(this);
    require("./ipc/database")(this);
    require("./ipc/dictionary")(this);
    require("./ipc/ai")(this);
    require("./ipc/azure")(this);
    require("./ipc/window")(this);
    require("./ipc/hotkeys")(this);
    require("./ipc/system")(this);
    require("./ipc/emoji")(this);
  }


}

module.exports = IPCHandlers;
