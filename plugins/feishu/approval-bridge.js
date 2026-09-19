// plugins/feishu/approval-bridge.js
// 飞书审批桥:让 DSH headless 智能体的「审批请求」(approval/request)能通过飞书群聊天
// 由群成员实时决定(同意/拒绝),并把决定回传给等待中的 dsh 进程。
//
// 拓扑:
//   1. dsh-headless(headless profile 内的 feishu-approval 应答插件)
//      POST http://127.0.0.1:<port>/approval/request { sessionId, toolName, reason }
//      —— 该 HTTP 请求会一直挂着,直到有人决定或超时。
//   2. 本桥把请求转成一条飞书文本发到对应群/单聊:
//      ⚠️ 需要审批 ... 回复「同意」或「拒绝」
//   3. receive.js 收到群里回复后调用 handleDecision(chatId, text),
//      命中 pending 审批则回传 outcome,HTTP 请求随即返回给 dsh 进程。
//
// 权限:按用户选择——同对话框内任何成员回复均可生效(审批人白名单留待以后)。
// 安全:只监听 127.0.0.1,不对外网暴露。

import { createServer } from 'node:http';
import { sendAppMessage } from './app-api.js';

/** 把回复文本归一化为审批决定。返回 'allowed-once' | 'rejected' | null。 */
export function normalizeDecision(text) {
  if (typeof text !== 'string') return null;
  let t = text
    .replace(/<at[^>]*>.*?<\/at>/g, '') // 去掉 @提及
    .replace(/[，。！？、,.!?~～\s]/g, '')
    .toLowerCase();
  // 去掉常见语气后缀
  t = t.replace(/(了|吧|啊|哈|呀|哦|的|嘛|呢)$/g, '');
  if (t === '') return null;
  if (/^(同意|允许|批准|通过|放行|可以|好|ok|yes|y|approve|allow)$/.test(t)) return 'allowed-once';
  if (/^(拒绝|驳回|不同意|不允许|不行|不可以|否|no|n|deny|reject)$/.test(t)) return 'rejected';
  return null;
}

/**
 * 启动审批桥(本地 HTTP 服务)。
 * @param {object} opts
 * @param {Function} [opts.sendText] 发送文本到指定 chat,默认走应用 API。
 * @param {number} [opts.askTimeoutMs] 单次审批等待上限(默认 100s)。
 * @param {object} [opts.logger]
 * @returns {Promise<{ url: string, handleDecision: (chatId: string, text: string) => string|null, close: () => void }>}
 */
export async function startApprovalBridge({
  appId,
  appSecret,
  sendText,
  askTimeoutMs = 100_000,
  logger = console,
} = {}) {
  const doSend =
    sendText ??
    (async ({ chatId, text }) => {
      await sendAppMessage({
        appId,
        appSecret,
        receiveId: chatId,
        receiveIdType: 'chat_id',
        msgType: 'text',
        content: JSON.stringify({ text }),
      });
    });

  /** chatId -> { resolve, timer, askedAt } 同一 chat 同时只有一个 pending */
  const pending = new Map();

  async function askInChat(chatId, info) {
    const lines = [
      '⚠️ DSH 需要审批',
      `操作:${info.toolName ?? '(未知)'}`,
    ];
    if (info.reason) lines.push(`原因:${info.reason}`);
    lines.push('回复「同意」放行,或「拒绝」拒绝。');
    await doSend({ chatId, text: lines.join('\n') });
  }

  function settle(chatId, outcome) {
    const entry = pending.get(chatId);
    if (!entry) return false;
    pending.delete(chatId);
    clearTimeout(entry.timer);
    entry.resolve(outcome);
    return true;
  }

  const server = createServer((req, res) => {
    res.on('error', () => {}); // 客户端断开等导致的写错误不崩服务
    if (req.method === 'POST' && req.url === '/approval/request') {
      let body = '';
      req.on('data', (d) => {
        body += String(d);
        if (body.length > 64 * 1024) req.destroy();
      });
      req.on('end', async () => {
        let payload = {};
        try {
          payload = JSON.parse(body);
        } catch {
          // 保持空对象
        }
        const sessionId = String(payload.sessionId ?? '');
        if (!sessionId.startsWith('feishu-')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ outcome: 'unavailable', error: 'non-feishu session' }));
          return;
        }
        const chatId = sessionId.slice('feishu-'.length);
        if (!chatId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ outcome: 'unavailable', error: 'empty chatId' }));
          return;
        }
        if (pending.has(chatId)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ outcome: 'unavailable', error: 'another approval is pending for this chat' }));
          return;
        }
        let responded = false;
        const respond = (outcome) => {
          if (responded) return;
          responded = true;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ outcome }));
        };
        const timeout = setTimeout(() => {
          if (!settle(chatId, 'cancelled')) return;
          logger.log(`⏰ 审批超时取消(chat=${chatId}, tool=${payload.toolName ?? ''})`);
          doSend({ chatId, text: '⏰ 审批等待超时,该操作已取消(可重新发起)。' }).catch(() => {});
          respond('cancelled');
        }, Math.min(Math.max(Number(payload.askTimeoutMs) || askTimeoutMs, 50), 600_000));
        const entry = {
          resolve: (outcome) => {
            clearTimeout(timeout);
            respond(outcome);
          },
          timer: timeout,
        };
        pending.set(chatId, entry);
        logger.log(`📋 审批请求(chat=${chatId}, tool=${payload.toolName ?? ''}${payload.reason ? ', reason=' + payload.reason : ''})`);
        try {
          await askInChat(chatId, { toolName: payload.toolName, reason: payload.reason });
        } catch (err) {
          logger.error(`❌ 审批消息发送失败(chat=${chatId}):`, err.message);
          settle(chatId, 'unavailable');
          respond('unavailable');
          return;
        }
        // 客户端(DSH 进程)中途断开 → 视为取消
        req.on('close', () => {
          if (!responded && settle(chatId, 'cancelled')) {
            logger.log(`↩️ 审批请求被中断(chat=${chatId})`);
          }
        });
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;

  function handleDecision(chatId, text) {
    const verdict = normalizeDecision(text);
    if (!verdict) return null;
    const settled = settle(String(chatId), verdict);
    if (!settled) return null;
    logger.log(`✅ 审批已决定(chat=${chatId}, outcome=${verdict})`);
    return verdict;
  }

  return {
    url,
    handleDecision,
    close() {
      for (const chatId of [...pending.keys()]) settle(chatId, 'cancelled');
      server.close();
    },
  };
}
