/**
 * AI 文字處理服務 — 從 ipcHandlers 抽出。
 * 職責：呼叫 OpenAI 相容 API 做潤飾（processTextWithAI）、測試連線（checkAIStatus）。
 * Prompt 內容見 aiPrompts.js。
 */
const { buildPrompts, SYSTEM_PROMPT, stripAIPreamble, isMeltdownOutput } = require("./aiPrompts");

class AITextProcessor {
  constructor(databaseManager, logger = console, sidecarManager = null) {
    this.databaseManager = databaseManager;
    this.logger = logger;
    // Azure sidecar（path ②）。null 時走原有 OpenAI 相容流程（DeepSeek/OpenAI/Ollama）。
    this.sidecarManager = sidecarManager;
  }

  // 若處於 Azure sidecar 模式，覆寫 {apiKey, baseUrl, model} 指向本地 sidecar（Entra ID 在 sidecar 內）。
  // 回傳 null 表示不是 sidecar 模式，呼叫端維持原邏輯。
  async _resolveSidecarConfig(fallback) {
    const aiMode = await this.databaseManager.getSetting('ai_provider_mode');
    if (aiMode !== 'azure_sidecar' || !this.sidecarManager) return null;
    await this.sidecarManager.ensureStarted();
    return {
      apiKey: this.sidecarManager.getSecret(),
      baseUrl: this.sidecarManager.getBaseUrl(),
      model: (await this.databaseManager.getSetting('azure_chat_deployment')) || fallback.model,
    };
  }

  // 砍前言/代碼框：委派 aiPrompts.stripAIPreamble（與 eval harness 共用同一份，
  // 考卷評的才是使用者實際拿到的文字）
  _stripAIPreamble(s) {
    return stripAIPreamble(s);
  }

  // AI文本处理方法（customPrompt 不為空時直接用它當 user 訊息，供操作模式 freeform 用）
  async processTextWithAI(text, mode = 'optimize', customPrompt = null) {
    try {
      // 从数据库设置或環境變數获取API密钥
      let apiKey = await this.databaseManager.getSetting('ai_api_key');
      let baseUrl = await this.databaseManager.getSetting('ai_base_url');
      let model = await this.databaseManager.getSetting('ai_model');

      // Azure sidecar 模式優先：改打本地 sidecar（Entra ID），其餘流程不變
      let sidecarCfg;
      try {
        sidecarCfg = await this._resolveSidecarConfig({ model });
      } catch (e) {
        return { success: false, error: 'Azure sidecar 啟動失敗：' + e.message };
      }
      if (sidecarCfg) {
        apiKey = sidecarCfg.apiKey;
        baseUrl = sidecarCfg.baseUrl;
        model = sidecarCfg.model;
      } else if (!apiKey && process.env.DEEPSEEK_API_KEY) {
        // 使用環境變數作為預設值（DeepSeek）
        apiKey = process.env.DEEPSEEK_API_KEY;
        baseUrl = baseUrl || 'https://api.deepseek.com';
        model = model || 'deepseek-chat';
      }

      if (!apiKey) {
        return {
          success: false,
          error: '请先在设置页面配置AI API密钥'
        };
      }

      // 使用者自訂風格指示（設定頁「潤飾風格指示」，附加式，不影響核心防線）
      const styleInstructions = (await this.databaseManager.getSetting('ai_style_instructions')) || '';
      const prompts = buildPrompts(text, styleInstructions);

      // baseUrl 和 model 已在函數開頭定義（支援環境變數 fallback）

      const requestData = {
        model: model,
        messages: [
          {
            role: 'system',
            content: SYSTEM_PROMPT
          },
          {
            role: 'user',
            content: customPrompt || prompts[mode] || prompts.optimize
          }
        ],
        temperature: 0.3,
        max_tokens: 2000,
        stream: false
      };

      // 確保 baseUrl 不會重複添加 /chat/completions
      let apiEndpoint = baseUrl;
      if (!apiEndpoint.endsWith('/chat/completions')) {
        apiEndpoint = `${apiEndpoint}/chat/completions`;
      }

      // 常規 log 不含 messages 全文（logManager 會 JSON 序列化進檔案——沒開 debug
      // 也把整份 prompt 寫進 log 檔，等於 debug 開關沒守門）。全文只走下面的 debug 區塊。
      this.logger.info('AI文本处理请求:', {
        baseUrl: apiEndpoint,
        model,
        mode,
        inputText: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
        requestData: {
          ...requestData,
          messages: `[${requestData.messages.length} messages, 全文見 debug_log_ai_prompts]`
        }
      });

      // debug_log_ai_prompts 開啟時：把「實際送出的完整 prompt」全文寫進 log。
      // 用途：驗證風格指示/字典注入後模型真正收到什麼。預設關（每句多 ~3KB log）。
      try {
        if ((await this.databaseManager.getSetting('debug_log_ai_prompts')) === true) {
          this.logger.info('AI 完整請求 [debug_log_ai_prompts]:\n' +
            '===== system =====\n' + requestData.messages[0].content +
            '\n===== user =====\n' + requestData.messages[1].content +
            '\n===== end =====');
        }
      } catch (e) { /* debug log 失敗不影響主流程 */ }

      // 60 秒逾時：AI 端點掛住時不能讓整個潤飾流程永遠卡死
      const response = await fetch(apiEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestData),
        signal: AbortSignal.timeout(60000)
      });

      if (!response.ok) {
        const errorText = await response.text();
        let errorData = { error: response.statusText };
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { error: errorText || response.statusText };
        }
        throw new Error(errorData.error?.message || errorData.error || `API error: ${response.status}`);
      }

      const data = await response.json();

      this.logger.info('AI文本处理响应:', {
        status: response.status,
        data: data,
        usage: data.usage
      });

      if (data.choices && data.choices.length > 0) {
        const stripped = this._stripAIPreamble(data.choices[0].message.content);
        const finishReason = data.choices[0].finish_reason;
        // 輸出失控保護：模型崩潰（重複迴圈/洩漏思考/回顯 prompt）時，寧可貼回
        // 原始轉錄，也不能把一大團垃圾灌進使用者視窗。
        let finalText = stripped;
        if (isMeltdownOutput(text, stripped, finishReason)) {
          this.logger.warn('AI 輸出異常（疑失控/洩漏），回退原始轉錄:', {
            inputLen: text.length, outputLen: stripped.length, finishReason
          });
          finalText = text;
        }
        const result = {
          success: true,
          text: finalText,
          usage: data.usage,
          model: model
        };

        this.logger.info('AI文本处理结果:', {
          originalText: text.substring(0, 100) + (text.length > 100 ? '...' : ''),
          optimizedText: result.text.substring(0, 100) + (result.text.length > 100 ? '...' : ''),
          usage: result.usage
        });
        
        return result;
      } else {
        this.logger.error('AI API返回数据格式错误:', response.data);
        return {
          success: false,
          error: 'AI API返回数据格式错误'
        };
      }
    } catch (error) {
      this.logger.error('AI文本处理失败:', {
        message: error.message,
        stack: error.stack,
        name: error.name
      });

      // 注意：這裡用的是原生 fetch，沒有 axios 的 error.response/error.code
      let errorMessage;
      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        errorMessage = 'AI 請求逾時，請檢查網路或服務狀態';
      } else if (/ENOTFOUND|ECONNREFUSED|fetch failed/i.test(error.message || '')) {
        errorMessage = '無法連線到 AI 服務，請檢查網路與 API 端點';
      } else {
        errorMessage = error.message || '文字處理失敗';
      }

      return {
        success: false,
        error: errorMessage
      };
    }
  }

  // 检查AI状态
  async checkAIStatus(testConfig = null) {
    try {
      this.logger.info('开始测试AI配置...', testConfig ? '使用临时配置' : '使用已保存配置');
      
      // 如果提供了测试配置，使用测试配置；否则使用已保存的配置
      let apiKey, baseUrl, model;
      
      if (testConfig) {
        apiKey = testConfig.ai_api_key;
        baseUrl = testConfig.ai_base_url || 'https://api.openai.com/v1';
        model = testConfig.ai_model || 'gpt-3.5-turbo';
        this.logger.info('使用临时测试配置:', { baseUrl, model, apiKeyLength: apiKey?.length || 0 });
      } else {
        apiKey = await this.databaseManager.getSetting('ai_api_key');
        baseUrl = await this.databaseManager.getSetting('ai_base_url') || 'https://api.openai.com/v1';
        model = await this.databaseManager.getSetting('ai_model') || 'gpt-3.5-turbo';

        // Azure sidecar 模式優先（Entra ID 在 sidecar 內）
        let sidecarCfg = null;
        try {
          sidecarCfg = await this._resolveSidecarConfig({ model });
        } catch (e) {
          return { available: false, error: 'Azure sidecar 啟動失敗', details: e.message };
        }
        if (sidecarCfg) {
          apiKey = sidecarCfg.apiKey;
          baseUrl = sidecarCfg.baseUrl;
          model = sidecarCfg.model;
          this.logger.info('使用 Azure sidecar 配置:', { baseUrl, model });
        } else if (!apiKey && process.env.DEEPSEEK_API_KEY) {
          // 使用環境變數作為預設值（DeepSeek）
          apiKey = process.env.DEEPSEEK_API_KEY;
          baseUrl = 'https://api.deepseek.com';
          model = 'deepseek-chat';
          this.logger.info('使用環境變數 DEEPSEEK_API_KEY');
        }

        this.logger.info('使用已保存配置:', { baseUrl, model, apiKeyLength: apiKey?.length || 0 });
      }

      if (!apiKey) {
        this.logger.warn('AI测试失败: 未配置API密钥');
        return {
          available: false,
          error: '未配置API密钥',
          details: '请输入AI API密钥'
        };
      }
      
      this.logger.info('AI配置信息:', {
        baseUrl: baseUrl,
        model: model,
        apiKeyLength: apiKey.length
      });
      
      // 发送一个更有意义的测试请求
      const testMessage = '请回复"测试成功"来确认AI服务正常工作';
      const requestData = {
        model: model,
        messages: [
          {
            role: 'user',
            content: testMessage
          }
        ],
        max_tokens: 50,
        temperature: 0.1
      };

      this.logger.info('发送AI测试请求:', requestData);

      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestData),
        signal: AbortSignal.timeout(20000) // 連線測試 20 秒逾時
      });

      this.logger.info('AI API响应状态:', response.status);

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error('AI API错误响应:', errorText);
        
        let errorData = { error: response.statusText };
        try {
          errorData = JSON.parse(errorText);
        } catch {
          errorData = { error: errorText || response.statusText };
        }
        
        let errorMessage = errorData.error?.message || errorData.error || `HTTP ${response.status}`;
        if (response.status === 401) {
          errorMessage = 'API密钥无效或已过期';
        } else if (response.status === 403) {
          errorMessage = 'API密钥权限不足';
        } else if (response.status === 429) {
          errorMessage = 'API调用频率超限';
        } else if (response.status === 500) {
          errorMessage = 'AI服务器内部错误';
        }
        
        throw new Error(errorMessage);
      }

      const data = await response.json();
      this.logger.info('AI API成功响应:', data);

      if (!data.choices || data.choices.length === 0) {
        throw new Error('AI API返回格式异常：缺少choices字段');
      }

      const aiResponse = data.choices[0].message?.content || '';
      this.logger.info('AI回复内容:', aiResponse);

      return {
        available: true,
        model: model,
        status: 'connected',
        response: aiResponse,
        usage: data.usage,
        details: `成功连接到 ${model}，响应时间正常`
      };
    } catch (error) {
      this.logger.error('AI配置测试失败:', error);
      
      let errorMessage = '连接失败';
      if (error.message.includes('401')) {
        errorMessage = 'API密钥无效';
      } else if (error.message.includes('403')) {
        errorMessage = 'API密钥权限不足';
      } else if (error.message.includes('429')) {
        errorMessage = 'API调用频率超限';
      } else if (error.message.includes('ENOTFOUND')) {
        errorMessage = '无法连接到AI服务器，请检查网络和Base URL';
      } else if (error.message.includes('ECONNREFUSED')) {
        errorMessage = '连接被拒绝，请检查Base URL是否正确';
      } else if (error.message.includes('timeout')) {
        errorMessage = '请求超时，请检查网络连接';
      } else {
        errorMessage = error.message || '未知错误';
      }

      return {
        available: false,
        error: errorMessage,
        details: `测试失败原因: ${error.message}`
      };
    }
  }
}

module.exports = AITextProcessor;
