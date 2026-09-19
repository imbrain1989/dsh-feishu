// plugins/feishu/webhook.js
// 飞书自定义机器人 Webhook 客户端(零依赖,Node >= 18,内置 fetch)
//
// 用法:
//   import { sendText, sendPost, sendCard, makeClient } from './webhook.js';
//   await sendText('你好,飞书', { webhookUrl: process.env.FEISHU_WEBHOOK_URL });
//
// 官方文档:
//   https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot?lang=zh-CN

import { createHmac } from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 15000;
const HOOK_HOST = 'https://open.feishu.cn/open-apis/bot/v2/hook';

/**
 * 计算加签签名(飞书"安全设置 -> 加签")。
 * 算法:stringToSign = `${timestamp}\n${secret}`,
 *       sign = Base64(HMAC-SHA256(stringToSign, stringToSign))
 * @param {number} timestampSeconds 当前 Unix 秒级时间戳
 * @param {string} secret 加签密钥
 */
export function buildSign(timestampSeconds, secret) {
  const stringToSign = `${timestampSeconds}\n${secret}`;
  return createHmac('sha256', stringToSign).update(stringToSign).digest('base64');
}

/**
 * 向 Webhook 发送一个消息负载。
 * @param {object} opts
 * @param {string} opts.webhookUrl 机器人 Webhook 地址(形如 .../hook/xxxx)
 * @param {string} [opts.secret] 加签密钥;未启用加签时省略
 * @param {object} opts.payload 消息体,如 { msg_type: 'text', content: { text: '...' } }
 * @param {number} [opts.timeoutMs] 超时毫秒数
 * @returns {Promise<object>} 飞书返回的 JSON
 */
export async function sendToWebhook({ webhookUrl, secret, payload, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!webhookUrl) {
    throw new Error('缺少 webhookUrl:请在 .env 中配置 FEISHU_WEBHOOK_URL(飞书群 -> 群机器人 -> 自定义机器人)');
  }
  if (!payload || typeof payload !== 'object') {
    throw new Error('缺少 payload:消息体不能为空');
  }

  const body = { ...payload };
  if (secret) {
    const timestamp = Math.floor(Date.now() / 1000);
    body.timestamp = timestamp;
    body.sign = buildSign(timestamp, secret);
  }

  let res;
  try {
    res = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`无法连接飞书(${webhookUrl}):${err.message}`, { cause: err });
  }

  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON 响应,交由下面统一处理 */
  }

  if (!res.ok) {
    throw new Error(`飞书 HTTP ${res.status}:${text}`);
  }

  // 飞书成功返回 {"StatusCode":0,"StatusMessage":"success"}(新接口也可能用 code/msg)
  const code = json?.code ?? json?.StatusCode;
  const msg = json?.msg ?? json?.StatusMessage ?? text;
  if (code !== undefined && code !== 0) {
    throw new Error(`飞书返回错误 code=${code}, msg=${msg}`);
  }
  return json;
}

/**
 * 发送纯文本消息。
 * @param {string} text 文本内容;可用 <at user_id="ou_xxx">名字</at> 或 <at user_id="all">所有人</at>
 */
export function sendText(text, opts = {}) {
  return sendToWebhook({
    ...opts,
    payload: { msg_type: 'text', content: { text } },
  });
}

/**
 * 发送富文本(post)消息。
 * @param {object} param0
 * @param {string} param0.title 标题
 * @param {Array<Array<object>>} param0.content 行数组,每行是 tag 数组:
 *   [{ tag: 'text', text: '粗体', style: ['bold'] },
 *    { tag: 'a', text: '链接', href: 'https://...' },
 *    { tag: 'at', user_id: 'ou_xxx' }]
 */
export function sendPost({ title = '', content = [] }, opts = {}) {
  return sendToWebhook({
    ...opts,
    payload: {
      msg_type: 'post',
      content: { post: { zh_cn: { title, content } } },
    },
  });
}

/**
 * 发送卡片(interactive)消息。
 * @param {object} card 卡片 JSON,如 { config: {...}, header: {...}, elements: [...] }
 */
export function sendCard(card, opts = {}) {
  return sendToWebhook({
    ...opts,
    payload: { msg_type: 'interactive', card },
  });
}

/**
 * 便捷构造一个客户端,把 webhookUrl / secret 固定下来。
 * @param {object} config { webhookUrl, secret, timeoutMs }
 */
export function makeClient({ webhookUrl, secret, timeoutMs } = {}) {
  const opts = { webhookUrl, secret, timeoutMs };
  return {
    send: (payload) => sendToWebhook({ ...opts, payload }),
    sendText: (text) => sendText(text, opts),
    sendPost: (post) => sendPost(post, opts),
    sendCard: (card) => sendCard(card, opts),
  };
}

/** 由 .env 读取配置并构造客户端(CLI 用)。 */
export function clientFromEnv(env = process.env) {
  return makeClient({
    webhookUrl: env.FEISHU_WEBHOOK_URL,
    secret: env.FEISHU_WEBHOOK_SECRET || undefined,
  });
}

export { HOOK_HOST };
