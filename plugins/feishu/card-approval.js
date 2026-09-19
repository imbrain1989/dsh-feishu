// plugins/feishu/card-approval.js
// 飞书审批通道(卡片版):让 DSH headless 智能体发起的「操作授权」请求(沙箱/提权等)
// 以一张交互式卡片发到目标群,由用户本人或机器人回复一次「同意/拒绝」决定。
//   - 区别于 approval-bridge.js:后者是多成员群投票+本地 HTTP bridge;本模块是
//     「经飞书渠道(交互卡片)」且自决/机器人自决,不依赖多成员投票。
//
//   拓扑:
//     1. askApproval({targetChatId,request}) → 发交互式卡片 + 登记 pending(requestId)
//        返回 Promise<outcome>;超时(fail-closed)自动 cancelled。
//     2. receive.js 收到回复文本后调用 handleDecision(chatId,text),按 chat→request
//        边表定位到对应 pending,回传 outcome(与审批桥同样契约)。
//
//   会话安全:同一对话框消息串行(receive.js createChatSerializer 保证);本模块内
//   request 并发允许跨不同 chat 共存,但每 chat 同时只有一条有效 pending。

import { normalizeDecision } from './approval-bridge.js';
import { sendAppMessage } from './app-api.js';

// requestId → { settle, timer, request, chatId }
const pending = new Map();
// chatId → requestId(用于把群回复文本定位到具体一张卡片)
const chatToRequest = new Map();

/** 交互式卡片 schema。纯函数、可离线测试。 */
export function buildApprovalCard({ toolName, reason, requestUrl }) {
  const body = [
    `⚠️ DSH 需要审批`,
    `操作:${toolName}`,
    ifPresent(reason),
    '',
    '回复「同意」放行,或「拒绝」拒绝。',
  ];
  return {
    config: { wide_screen_mode: false },
    header: { template: 'red', title: { tag: 'plain_text', content: 'DSH 操作授权' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: body.join('\n') } },
      {
        tag: 'button',
        lang: 'zh-CN',
        multiSelectCVs: false,
        style: { color: 'rgba(0,0,0,1)', bg_color: 'rgba(255,82,82,1)' },
        text: { tag: 'plain_text', content: '同意' },
      },
      {
        tag: 'button',
        lang: 'zh-CN',
        multiSelectCVs: false,
        style: { color: 'rgba(0,0,0,1)', bg_color: 'rgba(255,82,82,1)' },
        text: { tag: 'plain_text', content: '拒绝' },
      },
    ],
  };
}

function ifPresent(reason) {
  return reason ? `\n原因:${reason}` : '';
}

/**
 * DSH headless 发起一次操作授权审批。
 * @param {object} opts
 * @param {'open_id'|'user_id'|'union_id'|'email'|'chat_id'} opts.targetChatIdType
 * @param {string} opts.targetChatId      目标群/用户(卡片发送处)
 * @param {{toolName,reason?}} opts.request DSH 发起的操作信息
 * @param {{sendCard?, askTimeoutMs?}} [opts] sendCard 可注入(stub),默认走应用 API。
 * @returns {Promise<'allowed-once'|'rejected'|'cancelled'|'unavailable'>}
 */
export async function askApproval({ targetChatId, request, receiveIdType = 'chat_id', opts = {} } = {}) {
  if (!targetChatId || !request?.toolName) {
    throw new Error('askApproval:缺少 targetChatId / request.toolName');
  }
  const requestId = 'req_' + Math.random().toString(36).slice(2, 10);

  // 同 chat 已有 pending → fail-closed
  if (pending.has(requestId) || chatToRequest.get(targetChatId)) {
    throw new Error('card-approval:该对话已有未决审批,请重新发起');
  }
  let entry = { promise: null, timer: null, request, chatId: targetChatId };
  pending.set(requestId, entry);
  // chat→request 边表(把群回复文本定位到具体一张卡片),handleDecision/receive.js 依赖它。
  chatToRequest.set(targetChatId, requestId);
  // eager-bind a resolver(决定前同步 handleDecision 也能被唤醒),其余路径经 settle。
  const promise = new Promise((resolvePromise) => entry.promise = resolvePromise);

  const sendCard = opts.sendCard ?? (({ appId, appSecret, receiveId, msgType, content }) =>
    sendAppMessage({ appId, appSecret, receiveIdType, receiveId, msgType: 'interactive', content }));

  const card = buildApprovalCard({ toolName: request.toolName, reason: request.reason });
  try {
    await sendCard({ targetChatId, receiveIdType, content: JSON.stringify(card) });
    // 发送成功:登记超时(cancelled),fail-closed 由 catch/决定统一处理。
    entry.timer = setTimeout(() => { if (pending.has(requestId)) settle(requestId, 'cancelled'); },
      Math.min(opts.askTimeoutMs || 100_000, 600_000));
  } catch (err) {
    // 发送失败仍 fail-closed(不静默放行该操作)
    settle(requestId, 'unavailable');
    throw err;
  }

  return promise;
}

/** 任一通道(决定/超时/发送失败)统一结算:清定时器+删映射+唤醒 awaiter。 */
function settle(requestId, outcome) {
  const entry = pending.get(requestId);
  if (!entry) return null;
  clearTimeout(entry.timer);
  pending.delete(requestId);
  if (chatToRequest.has(entry.chatId)) chatToRequest.delete(entry.chatId);
  entry.promise?.(outcome);
  return outcome;
}

/** receive.js 调用:把群回复文本归一到某张卡片,回传 outcome。 */
export function handleDecision(chatId, text) {
  const verdict = normalizeDecision(text);
  if (!verdict) return null; // 普通聊天内容不命中,pending 保留
  const requestId = chatToRequest.get(String(chatId));
  console.log(`✅ 卡片审批已决定(chat=${chatId}, requestId=${requestId ?? 'none'}, outcome=${verdict})`);
  return settle(requestId, verdict);
}

/** 关闭全部 pending(停止时调用)。 */
export function close() {
  for (const [requestId] of [...pending.entries()]) settle(requestId, 'cancelled');
}
