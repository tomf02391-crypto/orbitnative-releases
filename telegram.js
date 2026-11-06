'use strict';
/**
 * Telegram Bot API 封装
 *  - getUpdates 长轮询监听 /start <订单号> 完成用户绑定
 *  - createChatInviteLink(member_limit=1) 生成一次性邀请链接
 *  - sendMessage 私聊下发链接
 *
 * TG_API_BASE 环境变量可覆盖 API 地址（用于本地 Bot API Server 或测试）。
 */

const API_BASE = (process.env.TG_API_BASE || 'https://api.telegram.org').replace(/\/$/, '');

class TelegramBot {
  /**
   * @param {string} token        Bot Token（@BotFather 获取）
   * @param {string|number} chatId 目标群组/频道 ID（如 -100xxxxxxxxxx），Bot 须为管理员
   */
  constructor(token, chatId, logger = console) {
    this.token = token;
    this.targetChatId = chatId;
    this.log = logger;
    this.username = null;
    this.offset = 0;
    this.stopped = false;
  }

  async api(method, params = {}, timeoutMs = 20000) {
    const res = await fetch(`${API_BASE}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(`Telegram ${method} 失败: ${json.description || res.status}`);
    return json.result;
  }

  /** 启动时校验 Token 并获取机器人用户名 */
  async init() {
    const me = await this.api('getMe');
    this.username = me.username;
    return me;
  }

  /** 为某个订单创建一次性邀请链接（1 人使用后即失效，7 天过期） */
  async createInviteLink(orderId) {
    const result = await this.api('createChatInviteLink', {
      chat_id: this.targetChatId,
      member_limit: 1,
      expire_date: Math.floor(Date.now() / 1000) + 7 * 86400,
      name: `order_${orderId}`,
    });
    return result.invite_link;
  }

  async sendText(chatId, text) {
    return this.api('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true });
  }

  /**
   * 长轮询监听消息，识别 /start <16位订单号>
   * @param {(orderId: string, chatId: number, from: object) => Promise<void>} onStart
   */
  async pollLoop(onStart) {
    while (!this.stopped) {
      try {
        const updates = await this.api('getUpdates', {
          offset: this.offset,
          timeout: 25,
          allowed_updates: ['message'],
        }, 35000);
        for (const u of updates) {
          this.offset = u.update_id + 1;
          const msg = u.message;
          if (!msg || typeof msg.text !== 'string') continue;
          const m = msg.text.match(/^\/start(?:@\w+)?\s+([0-9a-f]{16})\s*$/);
          if (m) {
            try { await onStart(m[1], msg.chat.id, msg.from || {}); }
            catch (e) { this.log.warn('[TG] 处理绑定失败：', e.message); }
          } else if (msg.text.startsWith('/start')) {
            await this.sendText(msg.chat.id, '请使用支付页面生成的专属链接打开本机器人，以绑定你的订单。').catch(() => {});
          }
        }
      } catch (e) {
        this.log.warn('[TG] 消息轮询出错：', e.message);
        await new Promise(r => setTimeout(r, 5000));
      }
    }
  }

  stop() { this.stopped = true; }
}

module.exports = { TelegramBot };
