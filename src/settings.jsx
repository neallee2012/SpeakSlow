import React, { useState, useEffect, useRef } from "react";
import ReactDOM from "react-dom/client";
import "./index.css";
import { toast, Toaster } from "sonner";
import { Settings, Save, Eye, EyeOff, X, Loader2, TestTube, CheckCircle, XCircle, Mic, Shield, Globe, Keyboard, Sparkles, BookText, Tag, History, Info, Heart, Smile } from "lucide-react";
import { usePermissions } from "./hooks/usePermissions";
import PermissionCard from "./components/ui/permission-card";
import HotkeySettings from "./components/HotkeySettings";
import HotwordsManager from "./components/HotwordsManager";
import DictionaryManager from "./components/DictionaryManager";
import EmojiManager from "./components/EmojiManager";
import HistoryView from "./components/HistoryView";
import { useTranslation, LanguageProvider } from "./i18n";

// 設定面板左側分頁（依重要性排序）
const SETTINGS_TABS = [
  { id: 'general', labelKey: 'settings.tabs.general', icon: Settings },
  { id: 'history', labelKey: 'settings.tabs.history', icon: History },
  { id: 'ai', labelKey: 'settings.tabs.ai', icon: Sparkles },
  { id: 'azure', labelKey: 'settings.tabs.azure', label: 'Azure', icon: Globe },
  { id: 'hotkeys', labelKey: 'settings.tabs.hotkeys', icon: Keyboard },
  { id: 'hotwords', labelKey: 'settings.tabs.hotwords', icon: Tag },
  { id: 'dictionary', labelKey: 'settings.tabs.dictionary', icon: BookText },
  { id: 'emoji', labelKey: 'settings.tabs.emoji', icon: Smile },
  { id: 'permissions', labelKey: 'settings.tabs.permissions', icon: Shield },
  { id: 'about', labelKey: 'settings.tabs.about', icon: Info },
];

const SettingsPage = () => {
  const { t, language, setLanguage, languages } = useTranslation();
  const [activeTab, setActiveTab] = useState('general');

  const [settings, setSettings] = useState({
    ai_api_key: "",
    ai_base_url: "https://api.openai.com/v1",
    ai_model: "gpt-4o-mini",
    enable_ai_optimization: false,
    ai_style_instructions: "",   // 潤飾風格指示（附加式，注入 optimize prompt）
    debug_log_ai_prompts: false,  // 記錄完整 AI 請求（prompt 全文 + sidecar 轉寫 definition）
    enable_notifications: true,
    enable_streaming_mode: false,
    language: "zh-TW",
    convert_transcription: true,
    asr_profile: "standard",          // 效能模式：standard（最準）/ fast（弱 CPU）
    mic_device_id: "",                // 指定麥克風（空=系統預設）
    mic_auto_gain: true,              // 自動增益（AGC）
    // 錄音完成後動作設定（自動貼上已固定開啟，僅保留「自動送出 Enter」）
    auto_enter_after_paste: false,    // 貼上後自動送出（完全信任模式）
    // 視窗控制設定
    window_always_on_top: true,       // 視窗置頂
    minimize_to_tray: true,           // 縮小到系統托盤
    close_to_tray: true,              // 關閉到系統托盤
    // ===== Azure 整合（path ②：本地 sidecar）=====
    asr_provider: "local",            // 語音辨識：local sherpa（預設）/ azure
    ai_provider_mode: "openai",       // AI 潤飾：openai 相容（預設）/ azure_sidecar
    azure_endpoint: "https://foundryweus2.cognitiveservices.azure.com",
    azure_tenant_id: "16b3c013-d300-468d-ac64-7eda0820b6d3",
    azure_client_id: "4441a9d4-c9fe-400a-9873-ed18beef03c1",
    azure_chat_deployment: "FW-MiniMax-M2.5",  // 潤飾用的 chat deployment 名
    azure_chat_api_version: "2024-10-21",
    azure_asr_mode: "zh-tw-stt",      // zh-tw-stt（經典STT原生繁體，預設）/ mai-transcribe（多語+OpenCC）
    azure_asr_model: "mai-transcribe-1",  // 僅 mai-transcribe 模式生效
    azure_asr_api_version: "2025-10-15",
    azure_asr_locales: "[]",          // 空：zh-tw-stt→["zh-TW","en-US"]；mai→多語自動
    azure_auth_flow: "interactive",   // interactive（彈瀏覽器）/ device_code
    azure_phrase_list_enabled: true,  // Phrase List 術語強化（只在 zh-tw-stt 經典模式生效）
    azure_phrase_extra: "",           // 自訂熱詞（一行一個，或 ; 分隔）
    azure_term_normalization: true,   // 確定性專有名詞標準化（azureAsrManager 後處理）
    azure_custom_corrections: "",    // 自訂修正字典（一行一條「錯字=>正字」，辨識後確定性替換）
    azure_resource_id: "/subscriptions/fd50f208-ec1f-4985-85e0-5cb476436ca3/resourceGroups/newfoundry01/providers/Microsoft.CognitiveServices/accounts/foundryweus2",  // 串流用 ARM resource id（aad token auth）
    azure_speech_region: "westus2"    // 串流用 Speech region
  });
  
  const [customModel, setCustomModel] = useState(false);
  
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showApiKey, setShowApiKey] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState(null);
  const [micDevices, setMicDevices] = useState([]); // 可選的麥克風清單
  const [azureAuthPending, setAzureAuthPending] = useState(false);
  const [azurePendingDeviceCode, setAzurePendingDeviceCode] = useState("");
  const azureAuthPollRef = useRef({ cancelled: false, timer: null });

  // 权限管理
  const showAlert = (alert) => {
    toast(alert.title, {
      description: alert.description,
      duration: 4000,
    });
  };

  const {
    micPermissionGranted,
    accessibilityPermissionGranted,
    requestMicPermission,
    testAccessibilityPermission,
  } = usePermissions(showAlert);

  // 加载设置
  useEffect(() => {
    loadSettings();
  }, []);

  useEffect(() => {
    return () => stopAzureAuthPolling();
  }, []);

  // 列出可選的麥克風（已授權的話會有名稱；沒授權則只有編號）
  useEffect(() => {
    const loadMics = async () => {
      try {
        if (!navigator.mediaDevices?.enumerateDevices) return;
        const devices = await navigator.mediaDevices.enumerateDevices();
        setMicDevices(devices.filter((d) => d.kind === 'audioinput' && d.deviceId && d.deviceId !== 'communications'));
      } catch (e) { /* ignore */ }
    };
    loadMics();
    navigator.mediaDevices?.addEventListener?.('devicechange', loadMics);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', loadMics);
  }, []);

  const loadSettings = async () => {
    try {
      setLoading(true);
      if (window.electronAPI) {
        const allSettings = await window.electronAPI.getAllSettings();
        const loadedSettings = {
          ai_api_key: allSettings.ai_api_key || "",
          ai_base_url: allSettings.ai_base_url || "https://api.openai.com/v1",
          ai_model: allSettings.ai_model || "gpt-4o-mini",
          enable_ai_optimization: allSettings.enable_ai_optimization === true, // 默认为false
          ai_style_instructions: (allSettings.ai_style_instructions || "").slice(0, 2000), // 與 buildPrompts 同上限，存/用一致
          debug_log_ai_prompts: allSettings.debug_log_ai_prompts === true,
          enable_notifications: allSettings.enable_notifications !== false, // 默认为true
          enable_streaming_mode: allSettings.enable_streaming_mode === true, // 默認關閉
          language: allSettings.language || "zh-TW", // 默认繁体中文
          convert_transcription: allSettings.convert_transcription !== false, // 默认转换
          asr_profile: allSettings.asr_profile || "standard",
          mic_device_id: allSettings.mic_device_id || "",
          mic_auto_gain: allSettings.mic_auto_gain !== false,
          // 錄音完成後動作設定
          auto_enter_after_paste: allSettings.auto_enter_after_paste === true, // 默認不自動送出
          // 視窗控制設定
          window_always_on_top: allSettings.window_always_on_top !== false, // 默認置頂
          minimize_to_tray: allSettings.minimize_to_tray !== false, // 默認縮小到托盤
          close_to_tray: allSettings.close_to_tray !== false, // 默認關閉到托盤
          // 視窗透明度（0.3~1）：之前漏在白名單外 → 開設定永遠顯示 100%（與實際脫鉤）
          window_opacity: (() => {
            const v = Number(allSettings.window_opacity);
            return Number.isFinite(v) && v > 0 ? Math.max(0.3, Math.min(1, v)) : 1;
          })(),
          // ===== Azure 整合 =====
          asr_provider: allSettings.asr_provider || "local",
          ai_provider_mode: allSettings.ai_provider_mode || "openai",
          azure_endpoint: allSettings.azure_endpoint || "https://foundryweus2.cognitiveservices.azure.com",
          azure_tenant_id: allSettings.azure_tenant_id || "16b3c013-d300-468d-ac64-7eda0820b6d3",
          azure_client_id: allSettings.azure_client_id || "4441a9d4-c9fe-400a-9873-ed18beef03c1",
          azure_chat_deployment: allSettings.azure_chat_deployment || "FW-MiniMax-M2.5",
          azure_chat_api_version: allSettings.azure_chat_api_version || "2024-10-21",
          azure_asr_mode: allSettings.azure_asr_mode || "zh-tw-stt",
          azure_asr_model: allSettings.azure_asr_model || "mai-transcribe-1",
          azure_asr_api_version: allSettings.azure_asr_api_version || "2025-10-15",
          azure_asr_locales: allSettings.azure_asr_locales || "[]",
          azure_auth_flow: allSettings.azure_auth_flow || "interactive",
          azure_phrase_list_enabled: allSettings.azure_phrase_list_enabled !== false,
          azure_phrase_extra: allSettings.azure_phrase_extra || "",
          azure_term_normalization: allSettings.azure_term_normalization !== false,
          azure_custom_corrections: allSettings.azure_custom_corrections || "",
          azure_resource_id: allSettings.azure_resource_id || "/subscriptions/fd50f208-ec1f-4985-85e0-5cb476436ca3/resourceGroups/newfoundry01/providers/Microsoft.CognitiveServices/accounts/foundryweus2",
          azure_speech_region: allSettings.azure_speech_region || "westus2"
        };
        setSettings(prev => ({ ...prev, ...loadedSettings }));
        
        // 检查是否使用自定义模型
        const predefinedModels = ["deepseek-v4-flash", "deepseek-v4-pro", "deepseek-chat", "deepseek-reasoner", "gpt-4o", "gpt-4o-mini", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro", "gemini-3.5-flash", "qwen2.5", "qwen2.5:3b", "llama3.2"];
        setCustomModel(!predefinedModels.includes(loadedSettings.ai_model));
      }
    } catch (error) {
      console.error("加载设置失败:", error);
      toast.error(t('settings.loadFailed'));
    } finally {
      setLoading(false);
    }
  };

  // 保存设置
  const saveSettings = async () => {
    try {
      setSaving(true);
      if (window.electronAPI) {
        // 保存每个设置项
        await window.electronAPI.setSetting('ai_api_key', settings.ai_api_key);
        await window.electronAPI.setSetting('ai_base_url', settings.ai_base_url);
        await window.electronAPI.setSetting('ai_model', settings.ai_model);
        await window.electronAPI.setSetting('enable_ai_optimization', settings.enable_ai_optimization);
        await window.electronAPI.setSetting('ai_style_instructions', (settings.ai_style_instructions || '').slice(0, 2000));
        await window.electronAPI.setSetting('debug_log_ai_prompts', settings.debug_log_ai_prompts === true);

        // ===== Azure 整合設定 =====
        // 兩類鍵分開對待：sidecar-env 鍵改了才需要重啟 sidecar；Node 端後處理鍵
        // （標準化開關、自訂修正字典）每次轉寫都重讀設定，存了即生效，不用重啟
        // （重啟會清掉 sidecar 的 token 快取，下一句白付 1-3 秒 az 子行程）。
        const SIDECAR_ENV_KEYS = ['asr_provider','ai_provider_mode','azure_endpoint','azure_tenant_id','azure_client_id','azure_chat_deployment','azure_chat_api_version','azure_asr_mode','azure_asr_model','azure_asr_api_version','azure_asr_locales','azure_auth_flow','azure_phrase_list_enabled','azure_phrase_extra','azure_resource_id','azure_speech_region'];
        const NODE_ONLY_KEYS = ['azure_term_normalization','azure_custom_corrections'];
        // debug_log_ai_prompts 同時影響 sidecar env（SIDECAR_DEBUG）→ 列入重啟判定
        SIDECAR_ENV_KEYS.push('debug_log_ai_prompts');
        let sidecarDirty = false;
        for (const k of [...SIDECAR_ENV_KEYS, ...NODE_ONLY_KEYS]) {
          const prev = await window.electronAPI.getSetting(k);
          if (SIDECAR_ENV_KEYS.includes(k) && prev !== settings[k]) sidecarDirty = true;
          await window.electronAPI.setSetting(k, settings[k]);
        }
        // 只有啟用 Azure 且 sidecar-env 鍵真的變動時才重啟（失敗不擋存檔）
        if (sidecarDirty && (settings.asr_provider === 'azure' || settings.ai_provider_mode === 'azure_sidecar')) {
          try { await window.electronAPI.azureSidecarRestart?.(); } catch (e) { /* ignore */ }
        }

        toast.success(t('settings.saveSuccess'));
      }
    } catch (error) {
      console.error("保存设置失败:", error);
      toast.error(t('settings.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  // 处理输入变化
  const handleInputChange = (key, value) => {
    setSettings(prev => ({
      ...prev,
      [key]: value
    }));
  };

  // 視窗透明度：即時套用 + 持久化（IPC 端會存設定）
  const handleOpacityChange = async (value) => {
    setSettings(prev => ({ ...prev, window_opacity: value }));
    try { await window.electronAPI?.setWindowOpacity?.(value); } catch (e) { /* ignore */ }
  };

  // 通用：改一個設定值並即時存檔（給下拉選單等用）
  const handleSettingChange = async (key, value) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    try { await window.electronAPI?.setSetting?.(key, value); } catch (e) { /* ignore */ }
  };

  const stopAzureAuthPolling = () => {
    const poll = azureAuthPollRef.current;
    poll.cancelled = true;
    if (poll.timer) clearTimeout(poll.timer);
    azureAuthPollRef.current = { cancelled: true, timer: null };
  };

  const startAzureAuthPolling = (initial = {}) => {
    stopAzureAuthPolling();
    const poll = { cancelled: false, timer: null };
    azureAuthPollRef.current = poll;
    const deadline = Date.now() + 180000;
    setAzureAuthPending(true);
    setAzurePendingDeviceCode(initial.pendingDeviceCode || "");
    if (initial.pendingDeviceCode) {
      toast.message(initial.pendingDeviceCode, { duration: 20000 });
    } else {
      toast.message('等待裝置碼登入，取得代碼中…', { duration: 8000 });
    }

    const finish = () => {
      poll.cancelled = true;
      if (poll.timer) clearTimeout(poll.timer);
      setAzureAuthPending(false);
      setAzurePendingDeviceCode("");
    };

    const pollStatus = async () => {
      if (poll.cancelled) return;
      if (Date.now() > deadline) {
        finish();
        toast.error('登入逾時，請重新按「用 Microsoft 登入」');
        return;
      }
      try {
        const r = await window.electronAPI.azureAuthStatus();
        if (poll.cancelled) return;
        if (r?.pending) {
          if (r.pendingDeviceCode) setAzurePendingDeviceCode(r.pendingDeviceCode);
          poll.timer = setTimeout(pollStatus, 2000);
          return;
        }
        if (r?.signedIn) {
          finish();
          toast.success('已登入 ' + (r.username || r.mode || ''));
          return;
        }
        if (r?.error) {
          finish();
          toast.error('登入失敗：' + (r.error?.message || r.error));
          return;
        }
        poll.timer = setTimeout(pollStatus, 2000);
      } catch (e) {
        // 舊輪詢的請求在取消/換新後才 reject：不能 finish()（會清掉新輪詢的 pending UI）
        // 也不能 setState（可能已 unmount）。stopAzureAuthPolling 會把舊 poll 標 cancelled，
        // 檢查它同時涵蓋 unmount 與重複點擊兩種情境（Copilot delta P2）。
        if (poll.cancelled) return;
        finish();
        toast.error('登入失敗：' + (e?.message || e));
      }
    };

    poll.timer = setTimeout(pollStatus, initial.pendingDeviceCode ? 2000 : 500);
  };

  // 处理开关切换并自动保存
  const handleToggleChange = async (key, value) => {
    setSettings(prev => ({
      ...prev,
      [key]: value
    }));

    // 立即保存开关状态
    try {
      if (window.electronAPI) {
        await window.electronAPI.setSetting(key, value);
        // 根据不同的设置项显示不同的提示
        if (key === 'enable_ai_optimization') {
          toast.success(value ? t('notifications.aiEnabled') : t('notifications.aiDisabled'));
        } else if (key === 'enable_notifications') {
          toast.success(value ? t('notifications.enabled') : t('notifications.disabled'));
        } else if (key === 'enable_streaming_mode') {
          toast.success(value ? t('settings.streamingEnabled') : t('settings.streamingDisabled'));
          // 當啟用串流模式時，預載串流模型以減少首次錄音延遲
          if (value) {
            toast.info(t('settings.streamingPreloading'));
            window.electronAPI.preloadStreamingModel()
              .then(result => {
                if (result.success) {
                  if (result.already_loaded) {
                    toast.success(t('settings.streamingModelReady'));
                  } else {
                    toast.success(t('settings.streamingPreloadComplete'));
                  }
                } else {
                  toast.error(t('settings.streamingPreloadFailed', { error: result.error || t('settings.testFailedDesc') }));
                }
              })
              .catch(err => {
                console.error('預載串流模型失敗:', err);
                toast.error(t('settings.streamingPreloadFailedSlow'));
              });
          }
        } else if (key === 'window_always_on_top') {
          // 視窗置頂需要即時應用
          await window.electronAPI.setAlwaysOnTop(value);
          toast.success(value ? t('settings.alwaysOnTopEnabled') : t('settings.alwaysOnTopDisabled'));
        } else if (key === 'minimize_to_tray') {
          toast.success(value ? t('settings.minimizeToTrayEnabled') : t('settings.minimizeToTrayDisabled'));
        } else if (key === 'close_to_tray') {
          toast.success(value ? t('settings.closeToTrayEnabled') : t('settings.closeToTrayDisabled'));
        }
        // 設定變更會透過 IPC 自動廣播到所有視窗
      }
    } catch (error) {
      console.error("保存设置失败:", error);
      toast.error(t('settings.saveFailed'));
    }
  };

  // Gemini（OpenAI 相容端點）
  const applyGeminiConfig = () => {
    setSettings(prev => ({
      ...prev,
      ai_base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
      ai_model: "gemini-2.5-flash",
      // 換到不同供應商就清空 key（別帶著別家的 key 打 Gemini → 一定失敗）
      ai_api_key: prev.ai_base_url === "https://generativelanguage.googleapis.com/v1beta/openai" ? prev.ai_api_key : ""
    }));
    setCustomModel(true);
    toast.info(t('settings.configApplied', { provider: 'Gemini' }));
  };

  // Ollama（本地 LLM，免 API key、全離線）
  const applyOllamaConfig = () => {
    setSettings(prev => ({
      ...prev,
      ai_base_url: "http://localhost:11434/v1",
      ai_api_key: prev.ai_api_key || "ollama",
      ai_model: "qwen2.5"
    }));
    setCustomModel(true);
    toast.info(t('settings.configApplied', { provider: t('settings.ollamaLocal') }));
  };

  // 重置为OpenAI配置
  const resetToOpenAI = () => {
    setSettings(prev => ({
      ...prev,
      ai_base_url: "https://api.openai.com/v1",
      ai_model: "gpt-4o-mini",
      ai_api_key: prev.ai_base_url === "https://api.openai.com/v1" ? prev.ai_api_key : ""
    }));
    setCustomModel(false);
    toast.info(t('settings.configApplied', { provider: t('settings.openaiConfig') }));
  };

  // 应用DeepSeek配置
  const applyDeepSeekConfig = () => {
    setSettings(prev => ({
      ...prev,
      ai_base_url: "https://api.deepseek.com",
      ai_model: "deepseek-v4-flash",
      ai_api_key: prev.ai_base_url === "https://api.deepseek.com" ? prev.ai_api_key : ""
    }));
    setCustomModel(false);
    toast.info(t('settings.configApplied', { provider: 'DeepSeek' }));
  };

  // 测试AI配置
  const testAIConfiguration = async () => {
    try {
      setTesting(true);
      setTestResult(null);
      
      // 验证当前输入的配置
      if (!settings.ai_api_key.trim()) {
        setTestResult({
          available: false,
          error: t('settings.configIncompleteDesc'),
          details: t('settings.configIncompleteDesc')
        });
        toast.error(t('settings.configIncomplete'), {
          description: t('settings.configIncompleteDesc')
        });
        return;
      }
      
      if (window.electronAPI) {
        // 使用当前页面的配置进行测试，而不是已保存的配置
        const testConfig = {
          ai_api_key: settings.ai_api_key.trim(),
          ai_base_url: settings.ai_base_url.trim() || 'https://api.openai.com/v1',
          ai_model: settings.ai_model.trim() || 'gpt-4o-mini'
        };
        
        const result = await window.electronAPI.checkAIStatus(testConfig);
        setTestResult(result);
        
        if (result.available) {
          toast.success(t('settings.testSuccess'), {
            description: t('settings.testSuccessDesc', { model: result.model || '?' })
          });
        } else {
          toast.error(t('settings.testFailed'), {
            description: result.error || t('settings.testFailedDesc')
          });
        }
      }
    } catch (error) {
      console.error("测试AI配置失败:", error);
      setTestResult({
        available: false,
        error: error.message || t('settings.testFailed')
      });
      toast.error(t('settings.testFailed'), {
        description: error.message || t('settings.testFailedDesc')
      });
    } finally {
      setTesting(false);
    }
  };

  // 关闭窗口
  const handleClose = () => {
    if (window.electronAPI) {
      window.electronAPI.hideSettingsWindow();
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center">
        <div className="flex items-center space-x-3">
          <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
          <span className="text-gray-700 dark:text-gray-300">{t('common.loading')}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-gradient-to-br from-slate-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 flex flex-col">
      {/* 标题栏 - 固定（可拖曳，取代原生標題列）*/}
      <div className="draggable bg-white/80 dark:bg-gray-800/80 backdrop-blur-sm border-b border-gray-200 dark:border-gray-700 px-6 py-4 flex-shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <Settings className="w-5 h-5 text-blue-600" />
            <h1 className="text-lg font-bold text-gray-900 dark:text-gray-100 chinese-title">{t('settings.title')}</h1>
          </div>
          <button
            onClick={handleClose}
            className="non-draggable p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
          >
            <X className="w-5 h-5 text-gray-500 dark:text-gray-400" />
          </button>
        </div>
      </div>

      {/* 主要內容：左側分頁 + 右側內容 */}
      <div className="flex-1 flex min-h-0">
        {/* 側邊欄分頁 */}
        <nav className="w-44 flex-shrink-0 overflow-y-auto border-r border-gray-200 dark:border-gray-700 bg-white/40 dark:bg-gray-800/40 py-3">
          {SETTINGS_TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-left transition-colors ${
                  activeTab === tab.id
                    ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border-r-2 border-blue-500 font-medium'
                    : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700/50'
                }`}
              >
                <Icon className="w-4 h-4 flex-shrink-0" />
                {tab.label || t(tab.labelKey)}
              </button>
            );
          })}
        </nav>

        {/* 內容區 - 可滾動 */}
        <div className="flex-1 overflow-y-auto min-h-0">
          <div className="max-w-2xl mx-auto p-6 pb-8">
            {activeTab === 'permissions' && (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 mb-6">
            <div className="p-6">
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 chinese-title">
                  {t('settings.permissions')}
                </h2>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                  {t('settings.permissionsDesc')}
                </p>
              </div>

              <div className="space-y-2">
                <PermissionCard
                  icon={Mic}
                  title={t('settings.micPermission')}
                  description={t('settings.micPermissionDesc')}
                  granted={micPermissionGranted}
                  onRequest={requestMicPermission}
                  buttonText={t('settings.testMic')}
                />

                <PermissionCard
                  icon={Shield}
                  title={t('settings.accessibilityPermission')}
                  description={t('settings.accessibilityPermissionDesc')}
                  granted={accessibilityPermissionGranted}
                  onRequest={testAccessibilityPermission}
                  buttonText={t('settings.testPermission')}
                />
              </div>
            </div>
          </div>

            )}

            {activeTab === 'general' && (<>
          {/* 一般设置部分 */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 mb-6">
            <div className="p-6">
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 chinese-title">
                  {t('settings.generalSettings')}
                </h2>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                  {t('settings.generalDescription')}
                </p>
              </div>

              <div className="space-y-4">
                {/* 语言选择 */}
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium text-gray-800 dark:text-gray-200 flex items-center gap-2">
                      <Globe className="w-4 h-4" />
                      {t('settings.language')}
                    </label>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {t('settings.languageDesc')}
                    </p>
                  </div>
                  <select
                    value={settings.language}
                    onChange={async (e) => {
                      const newLang = e.target.value;
                      handleInputChange('language', newLang);
                      await setLanguage(newLang);
                      if (window.electronAPI) {
                        await window.electronAPI.setSetting('language', newLang);
                      }
                      window.dispatchEvent(new Event('language-changed'));
                      // 使用新語言顯示通知，避免異步狀態更新導致顯示舊語言
                      const message =
                        newLang === 'zh-TW' ? '語言已切換' :
                        newLang === 'zh-CN' ? '语言已切换' :
                        'Language changed';
                      toast.success(message);
                    }}
                    className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  >
                    <option value="zh-TW">繁體中文</option>
                    <option value="zh-CN">简体中文</option>
                    <option value="en">English</option>
                  </select>
                </div>

                {/* 麥克風選擇（空=系統預設） */}
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <label className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      {t('settings.micDevice')}
                    </label>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {t('settings.micDeviceDesc')}
                    </p>
                  </div>
                  <select
                    value={settings.mic_device_id || ''}
                    onChange={async (e) => {
                      const v = e.target.value;
                      handleInputChange('mic_device_id', v);
                      if (window.electronAPI) await window.electronAPI.setSetting('mic_device_id', v);
                      toast.success(t('settings.micDeviceChanged'));
                    }}
                    className="max-w-[55%] px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 truncate"
                  >
                    <option value="">{t('settings.micDeviceDefault')}</option>
                    {micDevices.map((d, i) => (
                      <option key={d.deviceId} value={d.deviceId}>{d.label || `${t('settings.micDevice')} ${i + 1}`}</option>
                    ))}
                  </select>
                </div>

                {/* 自動增益（AGC）：好麥克風可關掉，避免靜音時放大噪音導致幻聽 */}
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      {t('settings.micAgc')}
                    </label>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {t('settings.micAgcDesc')}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings.mic_auto_gain !== false}
                    onClick={() => handleToggleChange('mic_auto_gain', !(settings.mic_auto_gain !== false))}
                    className={`${
                      settings.mic_auto_gain !== false ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
                    } relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2`}
                  >
                    <span
                      aria-hidden="true"
                      className={`${
                        settings.mic_auto_gain !== false ? 'translate-x-4' : 'translate-x-0'
                      } inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`}
                    />
                  </button>
                </div>

                {/* 效能模式：標準（最準）/ 快速（弱 CPU 機器） */}
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      {t('settings.asrProfile')}
                    </label>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {t('settings.asrProfileDesc')}
                    </p>
                  </div>
                  <select
                    value={settings.asr_profile || 'standard'}
                    onChange={async (e) => {
                      const v = e.target.value;
                      handleInputChange('asr_profile', v);
                      if (window.electronAPI) {
                        await window.electronAPI.setSetting('asr_profile', v);
                      }
                      toast.success(t('settings.asrProfileChanged'));
                    }}
                    className="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  >
                    <option value="standard">{t('settings.asrProfileStandard')}</option>
                    <option value="fast">{t('settings.asrProfileFast')}</option>
                  </select>
                </div>

                {/* 转换识别结果 */}
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      {t('settings.convertTranscription')}
                    </label>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {t('settings.convertTranscriptionDesc')}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings.convert_transcription}
                    onClick={() => handleToggleChange('convert_transcription', !settings.convert_transcription)}
                    className={`${
                      settings.convert_transcription ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
                    } relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2`}
                  >
                    <span
                      aria-hidden="true"
                      className={`${
                        settings.convert_transcription ? 'translate-x-4' : 'translate-x-0'
                      } inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`}
                    />
                  </button>
                </div>

                {/* 通知开关 */}
                <div className="flex items-center justify-between">
                  <div>
                    <label htmlFor="notifications-toggle" className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      {t('settings.notifications')}
                    </label>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {t('settings.notificationsDesc')}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings.enable_notifications}
                    onClick={() => handleToggleChange('enable_notifications', !settings.enable_notifications)}
                    className={`${
                      settings.enable_notifications ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
                    } relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2`}
                  >
                    <span
                      aria-hidden="true"
                      className={`${
                        settings.enable_notifications ? 'translate-x-4' : 'translate-x-0'
                      } inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`}
                    />
                  </button>
                </div>

                {/* 串流辨識模式開關 */}
                <div className="flex items-center justify-between">
                  <div>
                    <label htmlFor="streaming-toggle" className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      {t('settings.streamingMode')}
                    </label>
                    <p className="text-xs text-orange-500 dark:text-orange-400 mt-0.5">
                      {t('settings.streamingModeDesc')}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings.enable_streaming_mode}
                    onClick={() => handleToggleChange('enable_streaming_mode', !settings.enable_streaming_mode)}
                    className={`${
                      settings.enable_streaming_mode ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
                    } relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2`}
                  >
                    <span
                      aria-hidden="true"
                      className={`${
                        settings.enable_streaming_mode ? 'translate-x-4' : 'translate-x-0'
                      } inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`}
                    />
                  </button>
                </div>

              </div>
            </div>
          </div>

          {/* 視窗控制設定 */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 mb-6">
            <div className="p-6">
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 chinese-title">
                  {t('settings.windowControl')}
                </h2>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                  {t('settings.windowControlDesc')}
                </p>
              </div>

              <div className="space-y-4">
                {/* 視窗置頂開關 */}
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      {t('settings.alwaysOnTop')}
                    </label>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {t('settings.alwaysOnTopDesc')}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings.window_always_on_top}
                    onClick={() => handleToggleChange('window_always_on_top', !settings.window_always_on_top)}
                    className={`${
                      settings.window_always_on_top ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
                    } relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2`}
                  >
                    <span
                      aria-hidden="true"
                      className={`${
                        settings.window_always_on_top ? 'translate-x-4' : 'translate-x-0'
                      } inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`}
                    />
                  </button>
                </div>

                {/* 視窗透明度滑桿（迷你 / 一般面板共用） */}
                <div>
                  <div className="flex items-center justify-between mb-0.5">
                    <label className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      {t('settings.windowOpacity')}
                    </label>
                    <span className="text-xs text-gray-500 dark:text-gray-400 tabular-nums">
                      {Math.round((settings.window_opacity ?? 1) * 100)}%
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">
                    {t('settings.windowOpacityDesc')}
                  </p>
                  <input
                    type="range"
                    min="30"
                    max="100"
                    step="5"
                    value={Math.round((settings.window_opacity ?? 1) * 100)}
                    onChange={(e) => handleOpacityChange(Number(e.target.value) / 100)}
                    className="w-full accent-blue-600 cursor-pointer"
                  />
                </div>

                {/* 縮小到托盤開關 */}
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      {t('settings.minimizeToTray')}
                    </label>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {t('settings.minimizeToTrayDesc')}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings.minimize_to_tray}
                    onClick={() => handleToggleChange('minimize_to_tray', !settings.minimize_to_tray)}
                    className={`${
                      settings.minimize_to_tray ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
                    } relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2`}
                  >
                    <span
                      aria-hidden="true"
                      className={`${
                        settings.minimize_to_tray ? 'translate-x-4' : 'translate-x-0'
                      } inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`}
                    />
                  </button>
                </div>

                {/* 關閉到托盤開關 */}
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      {t('settings.closeToTray')}
                    </label>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {t('settings.closeToTrayDesc')}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings.close_to_tray}
                    onClick={() => handleToggleChange('close_to_tray', !settings.close_to_tray)}
                    className={`${
                      settings.close_to_tray ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
                    } relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2`}
                  >
                    <span
                      aria-hidden="true"
                      className={`${
                        settings.close_to_tray ? 'translate-x-4' : 'translate-x-0'
                      } inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`}
                    />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* 錄音完成後動作設定 */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 mb-6">
            <div className="p-6">
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 chinese-title">
                  {t('settings.afterRecording')}
                </h2>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                  {t('settings.afterRecordingDesc')}
                </p>
              </div>

              <div className="space-y-4">
                {/* 自動貼上：已固定開啟（不再提供開關，避免關掉後 TypeLess 失效） */}
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      {t('settings.autoPaste')}
                    </label>
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                      {t('settings.autoPasteDesc')}
                    </p>
                  </div>
                  <span className="text-xs font-medium text-green-600 dark:text-green-400 whitespace-nowrap">{t('settings.alwaysOn')}</span>
                </div>

                {/* 貼上後自動送出開關（完全信任模式） */}
                <div className="flex items-center justify-between">
                  <div>
                    <label className="text-sm font-medium text-gray-800 dark:text-gray-200">
                      {t('settings.autoEnter')}
                    </label>
                    <p className="text-xs text-orange-500 dark:text-orange-400 mt-0.5">
                      {t('settings.autoEnterDesc')}
                    </p>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={settings.auto_enter_after_paste}
                    onClick={() => handleToggleChange('auto_enter_after_paste', !settings.auto_enter_after_paste)}
                    className={`${
                      settings.auto_enter_after_paste ? 'bg-orange-500' : 'bg-gray-300 dark:bg-gray-600'
                    } cursor-pointer relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-orange-500 focus:ring-offset-2`}
                  >
                    <span
                      aria-hidden="true"
                      className={`${
                        settings.auto_enter_after_paste ? 'translate-x-4' : 'translate-x-0'
                      } inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`}
                    />
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* 操作模式 / 朗讀設定 */}
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 mb-6">
            <div className="p-6 space-y-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 chinese-title">
                    {t('settings.commandSection')}
                  </h2>
                  <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                    {t('settings.commandSectionDesc')}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => window.electronAPI?.openNotes?.()}
                  className="shrink-0 px-3 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                >
                  {t('settings.openNotes')}
                </button>
              </div>

              {/* 朗讀語音 */}
              <div>
                <label className="text-sm font-medium text-gray-800 dark:text-gray-200">
                  {t('settings.ttsVoice')}
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 mb-1.5">
                  {t('settings.ttsVoiceDesc')}
                </p>
                <select
                  value={settings.tts_voice || 'zh-TW-HsiaoChenNeural'}
                  onChange={(e) => handleSettingChange('tts_voice', e.target.value)}
                  className="w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                >
                  <option value="zh-TW-HsiaoChenNeural">{t('settings.ttsVoiceHsiaoChen')}</option>
                  <option value="zh-TW-HsiaoYuNeural">{t('settings.ttsVoiceHsiaoYu')}</option>
                  <option value="zh-TW-YunJheNeural">{t('settings.ttsVoiceYunJhe')}</option>
                </select>
              </div>

              {/* 朗讀語速 */}
              <div>
                <label className="text-sm font-medium text-gray-800 dark:text-gray-200">
                  {t('settings.ttsRate')}
                </label>
                <select
                  value={settings.tts_rate || '+0%'}
                  onChange={(e) => handleSettingChange('tts_rate', e.target.value)}
                  className="mt-1.5 w-full px-3 py-2 text-sm rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                >
                  <option value="-25%">{t('settings.ttsRateSlow')}</option>
                  <option value="+0%">{t('settings.ttsRateNormal')}</option>
                  <option value="+25%">{t('settings.ttsRateFast')}</option>
                </select>
              </div>

              {/* 自由指令開關 */}
              <div className="flex items-center justify-between">
                <div className="pr-3">
                  <label className="text-sm font-medium text-gray-800 dark:text-gray-200">
                    {t('settings.freeformCommand')}
                  </label>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    {t('settings.freeformCommandDesc')}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={settings.command_freeform_enabled !== false}
                  onClick={() => handleToggleChange('command_freeform_enabled', settings.command_freeform_enabled === false)}
                  className={`${
                    settings.command_freeform_enabled !== false ? 'bg-sky-500' : 'bg-gray-300 dark:bg-gray-600'
                  } relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none`}
                >
                  <span
                    aria-hidden="true"
                    className={`${
                      settings.command_freeform_enabled !== false ? 'translate-x-4' : 'translate-x-0'
                    } inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`}
                  />
                </button>
              </div>
            </div>
          </div>

            </>)}

            {activeTab === 'history' && (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700">
            <div className="p-5 h-[calc(100vh-7rem)]">
              <HistoryView />
            </div>
          </div>
            )}

            {activeTab === 'hotkeys' && (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 mb-6">
            <div className="p-6">
              <HotkeySettings />
            </div>
          </div>

            )}

            {activeTab === 'hotwords' && (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 mb-6">
            <div className="p-6">
              <HotwordsManager t={t} />
            </div>
          </div>

            )}

            {activeTab === 'dictionary' && (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 mb-6">
            <div className="p-6">
              <DictionaryManager t={t} />
            </div>
          </div>

            )}

            {activeTab === 'emoji' && (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 mb-6">
            <div className="p-6">
              <EmojiManager t={t} />
            </div>
          </div>

            )}

            {activeTab === 'ai' && (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700">
            <div className="p-6">
              <div className="mb-4">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 chinese-title">
                  {t('settings.aiConfig')}
                </h2>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                 {t('settings.aiConfigDesc')}
               </p>
              </div>

             <div className="space-y-4">
               {/* AI优化开关 */}
               <div className="flex items-center justify-between pt-4">
                 <label htmlFor="ai-optimization-toggle" className="text-sm font-medium text-gray-800 dark:text-gray-200">
                   {t('settings.enableAI')}
                 </label>
                 <button
                   type="button"
                   role="switch"
                   aria-checked={settings.enable_ai_optimization}
                   onClick={() => handleToggleChange('enable_ai_optimization', !settings.enable_ai_optimization)}
                   className={`${
                     settings.enable_ai_optimization ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
                   } relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2`}
                 >
                   <span
                     aria-hidden="true"
                     className={`${
                       settings.enable_ai_optimization ? 'translate-x-4' : 'translate-x-0'
                     } inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`}
                   />
                 </button>
               </div>

               {/* 潤飾風格指示（附加式：只能加個人偏好，動不了保意/腦補核心防線） */}
               <div>
                 <label className="block text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">潤飾風格指示（選填）</label>
                 <textarea value={settings.ai_style_instructions || ''} onChange={(e) => handleInputChange('ai_style_instructions', e.target.value)}
                   rows={4} maxLength={2000}
                   placeholder={"用你自己的話告訴 AI 你的偏好，一行一條，例如：\n語氣直接，不要加敬語\n「這樣子」「的部分」一律刪掉\n英文術語與縮寫保留原文\n結尾不要自動加句號"}
                   className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100" />
                 <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                   附加在內建規則之後、只影響措辭風格——保留原意、不腦補等核心防線不受影響。儲存即生效（下一句聽寫開始套用）。
                 </p>
               </div>

               {/* Debug：記錄完整 AI 請求（prompt 全文） */}
               <div className="flex items-center justify-between">
                 <div>
                   <label className="text-sm font-medium text-gray-800 dark:text-gray-200">記錄完整 AI 請求（debug）</label>
                   <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">開啟後 log 會包含每次送出的 prompt 全文（system + user）與 sidecar 轉寫請求；驗證風格指示/字典注入用。金鑰與 token 永不記錄。</p>
                 </div>
                 <button type="button" role="switch" aria-checked={settings.debug_log_ai_prompts === true}
                   onClick={() => handleToggleChange('debug_log_ai_prompts', !settings.debug_log_ai_prompts)}
                   className={`${settings.debug_log_ai_prompts ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'} relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2`}>
                   <span aria-hidden="true" className={`${settings.debug_log_ai_prompts ? 'translate-x-4' : 'translate-x-0'} inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out`} />
                 </button>
               </div>

               {/* API Key */}
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('settings.apiKey')} *
                  </label>
                  <div className="relative">
                    <input
                      type={showApiKey ? "text" : "password"}
                      value={settings.ai_api_key}
                      onChange={(e) => handleInputChange('ai_api_key', e.target.value)}
                      placeholder={t('settings.apiKeyPlaceholder')}
                      className="w-full px-3 py-2 pr-10 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                    />
                    <button
                      type="button"
                      onClick={() => setShowApiKey(!showApiKey)}
                      className="absolute right-3 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                    >
                      {showApiKey ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t('settings.apiKeyDesc')}
                  </p>
                  <button
                    type="button"
                    onClick={() => window.electronAPI?.openExternal?.('https://jeffrey0117.github.io/SpeakSlow/#/guide')}
                    className="mt-1 text-xs text-blue-500 hover:underline"
                  >
                    {t('settings.aiSetupHelp')} →
                  </button>
                </div>

                {/* Base URL */}
                <div>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">
                    {t('settings.baseUrl')}
                  </label>
                  <input
                    type="url"
                    value={settings.ai_base_url}
                    onChange={(e) => handleInputChange('ai_base_url', e.target.value)}
                    placeholder="https://api.openai.com/v1"
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                  />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t('settings.baseUrlDesc')}
                  </p>
                </div>

                {/* Model */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="block text-xs font-medium text-gray-700 dark:text-gray-300">
                      {t('settings.aiModel')}
                    </label>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <button
                        type="button"
                        onClick={applyDeepSeekConfig}
                        className="text-xs px-2 py-0.5 bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-400 rounded hover:bg-purple-200 dark:hover:bg-purple-900/50 transition-colors"
                      >
                        DeepSeek
                      </button>
                      <button
                        type="button"
                        onClick={applyGeminiConfig}
                        className="text-xs px-2 py-0.5 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 rounded hover:bg-amber-200 dark:hover:bg-amber-900/50 transition-colors"
                      >
                        Gemini
                      </button>
                      <button
                        type="button"
                        onClick={resetToOpenAI}
                        className="text-xs px-2 py-0.5 bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400 rounded hover:bg-blue-200 dark:hover:bg-blue-900/50 transition-colors"
                      >
                        OpenAI
                      </button>
                      <button
                        type="button"
                        onClick={applyOllamaConfig}
                        className="text-xs px-2 py-0.5 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 rounded hover:bg-green-200 dark:hover:bg-green-900/50 transition-colors"
                      >
                        {t('settings.ollamaLocal')}
                      </button>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center space-x-2">
                      <input
                        type="radio"
                        id="predefined-model"
                        name="model-type"
                        checked={!customModel}
                        onChange={() => setCustomModel(false)}
                        className="w-3 h-3 text-blue-600 border-gray-300 focus:ring-blue-500"
                      />
                      <label htmlFor="predefined-model" className="text-xs text-gray-700 dark:text-gray-300">
                        {t('settings.predefinedModel')}
                      </label>
                    </div>
                    
                    {!customModel && (
                      <select
                        value={settings.ai_model}
                        onChange={(e) => {
                          const model = e.target.value;
                          // 根據模型自動設定對應的 base URL
                          let baseUrl = settings.ai_base_url;
                          let providerName = '';

                          if (model.startsWith('deepseek')) {
                            baseUrl = 'https://api.deepseek.com';
                            providerName = 'DeepSeek';
                          } else if (model.startsWith('gpt')) {
                            baseUrl = 'https://api.openai.com/v1';
                            providerName = 'OpenAI';
                          } else if (model.startsWith('gemini')) {
                            baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';
                            providerName = 'Gemini';
                          } else if (model.startsWith('qwen') || model.startsWith('llama') || model.startsWith('gemma')) {
                            baseUrl = 'http://localhost:11434/v1';
                            providerName = t('settings.ollamaLocal');
                          }

                          // 換到「不同供應商」就清空 key（Ollama 用 dummy），
                          // 避免帶著別家的 key（那串星號）去打新供應商 → 失敗。
                          const providerChanged = baseUrl !== settings.ai_base_url;
                          const isOllama = baseUrl.includes('localhost:11434');
                          setSettings(prev => ({
                            ...prev,
                            ai_model: model,
                            ai_base_url: baseUrl,
                            ...(providerChanged ? { ai_api_key: isOllama ? (prev.ai_api_key || 'ollama') : '' } : {})
                          }));

                          if (providerName) {
                            toast.info(t('settings.providerEndpointSet', { provider: providerName }));
                          }
                        }}
                        className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                      >
                        <optgroup label={t('settings.modelGroups.deepseek')}>
                          <option value="deepseek-v4-flash">{t('settings.modelOptions.deepseekChat')}</option>
                          <option value="deepseek-v4-pro">DeepSeek V4 Pro (推理)</option>
                        </optgroup>
                        <optgroup label="OpenAI">
                          <option value="gpt-4o-mini">GPT-4o Mini</option>
                          <option value="gpt-4o">GPT-4o</option>
                        </optgroup>
                        <optgroup label="Gemini">
                          <option value="gemini-2.5-flash">{t('settings.modelOptions.geminiFlash')}</option>
                          <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash-Lite</option>
                          <option value="gemini-2.5-pro">{t('settings.modelOptions.geminiPro')}</option>
                          <option value="gemini-3.5-flash">Gemini 3.5 Flash</option>
                        </optgroup>
                        <optgroup label={t('settings.modelGroups.ollama')}>
                          <option value="qwen2.5">{t('settings.modelOptions.qwen')}</option>
                          <option value="qwen2.5:3b">{t('settings.modelOptions.qwenFast')}</option>
                          <option value="llama3.2">Llama 3.2</option>
                        </optgroup>
                      </select>
                    )}
                    
                    <div className="flex items-center space-x-2">
                      <input
                        type="radio"
                        id="custom-model"
                        name="model-type"
                        checked={customModel}
                        onChange={() => setCustomModel(true)}
                        className="w-3 h-3 text-blue-600 border-gray-300 focus:ring-blue-500"
                      />
                      <label htmlFor="custom-model" className="text-xs text-gray-700 dark:text-gray-300">
                        {t('settings.customModel')}
                      </label>
                    </div>

                    {customModel && (
                      <input
                        type="text"
                        value={settings.ai_model}
                        onChange={(e) => handleInputChange('ai_model', e.target.value)}
                        placeholder={t('settings.customModelPlaceholder')}
                        className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
                      />
                    )}
                  </div>

                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t('settings.aiModelDesc')}
                  </p>
                </div>
              </div>

              {/* 测试结果显示 */}
              {testResult && (
                <div className={`mt-4 p-3 rounded-lg border ${
                  testResult.available
                    ? 'bg-green-50 border-green-200 dark:bg-green-900/20 dark:border-green-800'
                    : 'bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800'
                }`}>
                  <div className="flex items-center space-x-2">
                    {testResult.available ? (
                      <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-400" />
                    ) : (
                      <XCircle className="w-5 h-5 text-red-600 dark:text-red-400" />
                    )}
                    <span className={`font-medium ${
                      testResult.available
                        ? 'text-green-800 dark:text-green-200'
                        : 'text-red-800 dark:text-red-200'
                    }`}>
                      {testResult.available ? t('settings.testSuccess') : t('settings.testFailed')}
                    </span>
                  </div>

                  {testResult.available && (
                    <div className="mt-2 space-y-1">
                      {testResult.model && (
                        <p className="text-xs text-green-700 dark:text-green-300">
                          {t('settings.testSuccessDesc', { model: testResult.model })}
                        </p>
                      )}
                      {testResult.details && (
                        <p className="text-xs text-green-700 dark:text-green-300">
                          {testResult.details}
                        </p>
                      )}
                      {testResult.response && (
                        <p className="text-xs text-green-700 dark:text-green-300">
                          AI: {testResult.response}
                        </p>
                      )}
                      {testResult.usage && (
                        <p className="text-xs text-green-600 dark:text-green-400">
                          Token: {testResult.usage.total_tokens || 'N/A'}
                        </p>
                      )}
                    </div>
                  )}

                  {!testResult.available && (
                    <div className="mt-2 space-y-1">
                      {testResult.error && (
                        <p className="text-xs text-red-700 dark:text-red-300">
                          {t('common.error')}: {testResult.error}
                        </p>
                      )}
                      {testResult.details && (
                        <p className="text-xs text-red-600 dark:text-red-400">
                          {testResult.details}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* 操作按钮 */}
              <div className="flex items-center justify-between mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
                <div className="flex flex-col">
                  <button
                    onClick={testAIConfiguration}
                    disabled={testing}
                    className="flex items-center space-x-2 px-3 py-1.5 text-sm bg-green-600 hover:bg-green-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {testing ? (
                      <Loader2 className="w-3 h-3 animate-spin" />
                    ) : (
                      <TestTube className="w-3 h-3" />
                    )}
                    <span>{testing ? t('settings.testing') : t('settings.testConfig')}</span>
                  </button>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    {t('settings.testConfigDesc')}
                  </p>
                </div>

                <button
                  onClick={saveSettings}
                  disabled={saving || (!settings.ai_api_key && settings.ai_provider_mode !== 'azure_sidecar')}
                  className="flex items-center space-x-2 px-4 py-1.5 text-sm bg-blue-600 hover:bg-blue-700 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Save className="w-3 h-3" />
                  )}
                  <span>{saving ? t('settings.saving') : t('settings.saveSettings')}</span>
                </button>
              </div>
            </div>
          </div>

            )}

            {activeTab === 'azure' && (
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700">
            <div className="p-6 space-y-4">
              <div>
                <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 chinese-title">Azure（Foundry 模型 + 語音辨識）</h2>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-1">
                  透過本地 sidecar 以 Microsoft Entra ID 連到你的 Azure 資源。音訊/文字只經過你機器上的 sidecar，再到你的 Azure。
                </p>
              </div>

              <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-3 text-xs text-amber-800 dark:text-amber-300">
                使用順序：① 填好下方欄位（chat deployment 必填）→ ② 按右下「儲存」→ ③ 點「用 Microsoft 登入」。之後 token 自動續期、重開免重登。
              </div>

              {/* AI 潤飾走 Azure */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium text-gray-800 dark:text-gray-200">AI 潤飾走 Azure Foundry</label>
                  <p className="text-xs text-gray-500 dark:text-gray-400">關閉時用「AI」分頁的 OpenAI 相容設定</p>
                </div>
                <button type="button" role="switch" aria-checked={settings.ai_provider_mode === 'azure_sidecar'}
                  onClick={() => handleInputChange('ai_provider_mode', settings.ai_provider_mode === 'azure_sidecar' ? 'openai' : 'azure_sidecar')}
                  className={`${settings.ai_provider_mode === 'azure_sidecar' ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'} relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors`}>
                  <span aria-hidden="true" className={`${settings.ai_provider_mode === 'azure_sidecar' ? 'translate-x-4' : 'translate-x-0'} inline-block h-4 w-4 transform rounded-full bg-white shadow transition`} />
                </button>
              </div>

              {/* 語音辨識走 Azure */}
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-medium text-gray-800 dark:text-gray-200">語音辨識走 Azure（mai-transcribe-1）</label>
                  <p className="text-xs text-gray-500 dark:text-gray-400">支援批次與即時串流辨識；本地 sherpa 仍是預設</p>
                </div>
                <button type="button" role="switch" aria-checked={settings.asr_provider === 'azure'}
                  onClick={() => {
                    const next = settings.asr_provider === 'azure' ? 'local' : 'azure';
                    setSettings(prev => ({ ...prev, asr_provider: next }));
                  }}
                  className={`${settings.asr_provider === 'azure' ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'} relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors`}>
                  <span aria-hidden="true" className={`${settings.asr_provider === 'azure' ? 'translate-x-4' : 'translate-x-0'} inline-block h-4 w-4 transform rounded-full bg-white shadow transition`} />
                </button>
              </div>

              {/* 語音辨識引擎 */}
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">語音辨識引擎</label>
                <select value={settings.azure_asr_mode} onChange={(e) => handleInputChange('azure_asr_mode', e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100">
                  <option value="zh-tw-stt">經典 STT・zh-TW（原生繁體，推薦）</option>
                  <option value="mai-transcribe">MAI-Transcribe 多語（簡體 + OpenCC 轉繁）</option>
                </select>
                <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                  zh-TW：原生台灣繁體、免 OpenCC，中英混用為片語級。MAI：多語自動偵測、輸出簡體再轉繁。下方「ASR model / locales」僅 MAI 模式生效。
                </p>
              </div>

              {/* 術語強化：Phrase List + 確定性標準化（只在 zh-TW 經典模式生效） */}
              <div className="space-y-2 rounded-lg border border-gray-200 dark:border-gray-700 p-3">
                <label className="flex items-center justify-between text-xs font-medium text-gray-700 dark:text-gray-300">
                  <span>片語清單 Phrase List（術語辨識強化）</span>
                  <input type="checkbox" checked={settings.azure_phrase_list_enabled !== false}
                    onChange={(e) => handleInputChange('azure_phrase_list_enabled', e.target.checked)} />
                </label>
                <label className="flex items-center justify-between text-xs font-medium text-gray-700 dark:text-gray-300">
                  <span>專有名詞標準化（確定性字典）</span>
                  <input type="checkbox" checked={settings.azure_term_normalization !== false}
                    onChange={(e) => handleInputChange('azure_term_normalization', e.target.checked)} />
                </label>
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">自訂熱詞（一行一個，或用 ; 分隔）</label>
                  <textarea value={settings.azure_phrase_extra || ''} onChange={(e) => handleInputChange('azure_phrase_extra', e.target.value)}
                    rows={3} placeholder={"例如：\nContoso\n專案代號 Falcon"}
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100" />
                </div>
                <div>
                  <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">自訂修正字典（一行一條「錯字=&gt;正字」，辨識後 100% 替換）</label>
                  <textarea value={settings.azure_custom_corrections || ''} onChange={(e) => handleInputChange('azure_custom_corrections', e.target.value)}
                    rows={3} placeholder={"例如：\n論視=>潤飾\n船流=>串流"}
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100" />
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
                    熱詞是「提高聽對的機率」，這裡是「聽錯後的確定性修正」——頑固的同音錯字加一條規則就永久根治。# 開頭為註解；「正字」留空＝刪除該詞。儲存即生效。
                  </p>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400">
                  只在「經典 STT・zh-TW」模式生效。Phrase List 強化術語「被聽對」（內建 AI 治理 / AI Harness / Azure 雲端詞庫，上限 500 詞）；標準化用確定性字典統一產品名（如 azure open ai → Azure OpenAI）。注意：高密度中英混雜仍可能有語言判別誤差，Phrase List 無法修正語言判別。
                </p>
              </div>

              {/* 欄位 */}
              {[
                ['azure_endpoint', 'Endpoint', 'https://foundryweus2.cognitiveservices.azure.com'],
                ['azure_tenant_id', 'Tenant ID', ''],
                ['azure_client_id', 'Client ID', ''],
                ['azure_chat_deployment', 'Chat deployment（潤飾模型，必填）', '例如 gpt-4o'],
                ['azure_chat_api_version', 'Chat api-version', '2024-10-21'],
                ['azure_asr_model', 'ASR model', 'mai-transcribe-1'],
                ['azure_asr_api_version', 'ASR api-version', '2025-10-15'],
                ['azure_asr_locales', 'ASR locales（JSON，空=多語）', '[] 或 ["zh-TW"]'],
                ['azure_resource_id', 'Resource ID（串流用 ARM id）', '/subscriptions/.../accounts/foundryweus2'],
                ['azure_speech_region', 'Speech region（串流用）', 'westus2'],
              ].map(([key, label, ph]) => (
                <div key={key}>
                  <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">{label}</label>
                  <input type="text" value={settings[key]} onChange={(e) => handleInputChange(key, e.target.value)} placeholder={ph}
                    className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100" />
                </div>
              ))}

              {/* 登入方式 */}
              <div>
                <label className="block text-xs font-medium text-gray-700 dark:text-gray-300 mb-1">登入方式</label>
                <select value={settings.azure_auth_flow} onChange={(e) => handleInputChange('azure_auth_flow', e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100">
                  <option value="interactive">互動瀏覽器（彈出登入頁）</option>
                  <option value="device_code">裝置碼（microsoft.com/devicelogin）</option>
                  <option value="azure_cli">Azure CLI（用 az login，免彈窗）</option>
                </select>
              </div>

              {/* 動作 */}
              <div className="flex flex-wrap gap-2 pt-2">
                <button type="button"
                  onClick={saveSettings}
                  disabled={saving}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors disabled:opacity-50">
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  <span>{saving ? '儲存中…' : '儲存設定'}</span>
                </button>
                <button type="button"
                  onClick={async () => {
                    toast.message('儲存設定並登入…');
                    try {
                      await saveSettings(); // 先把目前欄位存進 DB，sidecar 才讀得到
                      const r = await window.electronAPI.azureSignIn();
                      if (r?.signedIn) {
                        stopAzureAuthPolling();
                        setAzureAuthPending(false);
                        setAzurePendingDeviceCode("");
                        toast.success('已登入 ' + (r.username || r.mode || ''));
                      }
                      else if (r?.pending) startAzureAuthPolling(r);
                      else if (r?.pendingDeviceCode) toast.message(r.pendingDeviceCode, { duration: 20000 });
                      else toast.error('登入失敗：' + (r?.error?.message || r?.error || '未知'));
                    } catch (e) { toast.error('登入失敗：' + (e?.message || e)); }
                  }}
                  className="px-3 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors">
                  用 Microsoft 登入
                </button>
                <button type="button"
                  onClick={async () => {
                    try {
                      const r = await window.electronAPI.azureAuthStatus();
                      if (r?.signedIn) {
                        stopAzureAuthPolling();
                        setAzureAuthPending(false);
                        setAzurePendingDeviceCode("");
                        toast.success('已登入 ' + (r.username || r.mode || ''));
                      }
                      else if (r?.pending) startAzureAuthPolling(r);
                      else toast.error('未登入：' + (r?.error?.message || r?.error || '未知'));
                    } catch (e) { toast.error(e.message); }
                  }}
                  className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200">
                  查登入狀態
                </button>
                <button type="button"
                  onClick={async () => {
                    toast.message('儲存並測試 AI…');
                    try {
                      await saveSettings();
                      const r = await window.electronAPI.azureTestChat();
                      if (r?.available) toast.success('AI 正常：' + (r.model || ''));
                      else toast.error('AI 測試失敗：' + (r?.error || r?.details || '未知'));
                    } catch (e) { toast.error(e.message); }
                  }}
                  className="px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200">
                  測試 AI
                </button>
              </div>
              {azureAuthPending && (
                <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-xs text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-100">
                  <div className="flex items-center gap-2 font-medium">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>等待 Microsoft 裝置碼登入完成…</span>
                  </div>
                  {azurePendingDeviceCode ? (
                    <div className="mt-2 whitespace-pre-wrap rounded bg-white/80 p-2 font-mono text-[11px] text-blue-950 dark:bg-gray-900/70 dark:text-blue-100">
                      {azurePendingDeviceCode}
                    </div>
                  ) : (
                    <p className="mt-2 text-blue-700 dark:text-blue-200">正在取得裝置碼，請稍候…</p>
                  )}
                </div>
              )}
              <p className="text-xs text-gray-400">改完設定記得按右下角「儲存」，sidecar 會自動重啟套用新值。</p>
            </div>
          </div>
            )}

            {activeTab === 'about' && (
            <div className="space-y-4 max-w-xl">
              {/* 專案 */}
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 p-5 text-center">
                <img
                  src="./icon.png"
                  alt={t('settings.aboutTab.logoAlt')}
                  className="w-20 h-20 mx-auto mb-3 rounded-2xl shadow-md"
                  draggable="false"
                />
                <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 brand-title">
                  {t('appName')} <span className="text-base font-normal text-gray-400">{t('settings.aboutTab.brandSub')}</span>
                </h2>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('settings.aboutTab.tagline')}</p>
                <p className="text-[11px] text-gray-400 mt-2">v1.0.1 · Apache License 2.0</p>
              </div>

              {/* 作者 */}
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 p-5">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-2">{t('settings.aboutTab.authorTitle')}</h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">{t('settings.aboutTab.authorPrefix')}<strong>{t('settings.aboutTab.authorName')}</strong>{t('settings.aboutTab.authorSuffix')}</p>
                <a href="https://github.com/Jeffrey0117/SpeakSlow" target="_blank" rel="noreferrer"
                   className="inline-block text-xs text-blue-500 hover:underline mt-2">
                  GitHub · Jeffrey0117/speakslow
                </a>
              </div>

              {/* 致謝 */}
              <div className="bg-white dark:bg-gray-800 rounded-xl shadow-lg border border-gray-200 dark:border-gray-700 p-5">
                <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200 mb-3 flex items-center gap-1.5">
                  <Heart className="w-4 h-4 text-red-400" /> {t('settings.aboutTab.acknowledgements')}
                </h3>
                <ul className="text-xs text-gray-600 dark:text-gray-400 space-y-2 leading-relaxed">
                  <li>• <a href="https://github.com/yan5xu/ququ" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">ququ (yan5xu)</a> — {t('settings.aboutTab.ackQuqu')}</li>
                  <li>• <a href="https://github.com/k2-fsa/sherpa-onnx" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">sherpa-onnx (k2-fsa)</a> — {t('settings.aboutTab.ackSherpa')}</li>
                  <li>• <a href="https://wisprflow.ai/" target="_blank" rel="noreferrer" className="text-blue-500 hover:underline">Wispr Flow</a> — {t('settings.aboutTab.ackWispr')}</li>
                </ul>
              </div>
            </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// 导出组件供App.jsx使用
export { SettingsPage };

// 如果是直接访问settings.html，则渲染应用
if (document.getElementById("settings-root")) {
  const root = ReactDOM.createRoot(document.getElementById("settings-root"));
  root.render(
    <LanguageProvider>
      <SettingsPage />
      <Toaster />
    </LanguageProvider>
  );
}