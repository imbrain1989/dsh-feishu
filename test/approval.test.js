// test/approval.test.js
// 离线测试:审批决定解析 + 审批桥(本地 HTTP)的完整请求/决定/超时流程。
// 发送函数用 stub,不触碰真实飞书。

import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeDecision, startApprovalBridge } from '../plugins/feishu/approval-bridge.js';

test('normalizeDecision:同意类返回 allowed-once', () => {
  for (const t of ['同意', '同意。', '同意！', ' 同意 ', '允许', '批准', '通过', '放行', '可以', 'ok', 'OK', 'yes', 'Y', 'approve', '同意吧', '好的']) {
    assert.equal(normalizeDecision(t), 'allowed-once', `input=${t}`);
  }
});

test('normalizeDecision:拒绝类返回 rejected', () => {
  for (const t of ['拒绝', '拒绝。', ' 拒绝 ', '驳回', '不同意', '不允许', '不行', '不可以', 'no', 'No', 'N', 'deny', '否']) {
    assert.equal(normalizeDecision(t), 'rejected', `input=${t}`);
  }
});

test('normalizeDecision:普通消息与空内容返回 null', () => {
  for (const t of ['今天天气不错', '你好', '', '  ', '同意你前面的观点(带宾语)', '拒绝同意']) {
    assert.equal(normalizeDecision(t), null, `input=${t}`);
  }
});

test('normalizeDecision:去掉 @ 提及后仍可识别', () => {
  assert.equal(normalizeDecision('<at user_id="ou_x"></at> 同意'), 'allowed-once');
});

/** 启动一个带 stub 发送函数的审批桥,返回 hub 与发送记录。 */
async function makeHub({ askTimeoutMs = 60_000, autoDecide = null, onAsk } = {}) {
  const sent = [];
  let hub;
  const sendText = async ({ chatId, text }) => {
    sent.push({ chatId, text });
    onAsk?.({ chatId, text });
    if (autoDecide) hub.handleDecision(chatId, autoDecide);
  };
  hub = await startApprovalBridge({ sendText, askTimeoutMs, logger: { log() {}, error() {} } });
  return { hub, sent };
}

test('审批桥:同意后 HTTP 返回 allowed-once 且群里收到询问', async () => {
  const { hub, sent } = await makeHub({ autoDecide: null });
  try {
    const post = fetch(`${hub.url}/approval/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'feishu-oc_test_chat', toolName: 'pwsh', reason: '需要更高权限' }),
    });
    // 等询问消息发出
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes('pwsh'));
    assert.ok(sent[0].text.includes('需要更高权限'));
    // 群里有人回复「同意」
    const verdict = hub.handleDecision('oc_test_chat', '同意');
    assert.equal(verdict, 'allowed-once');
    const res = await post;
    const json = await res.json();
    assert.equal(json.outcome, 'allowed-once');
  } finally {
    hub.close();
  }
});

test('审批桥:拒绝后 HTTP 返回 rejected', async () => {
  const { hub } = await makeHub();
  try {
    const post = fetch(`${hub.url}/approval/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'feishu-oc_test_chat', toolName: 'bash' }),
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hub.handleDecision('oc_test_chat', '拒绝'), 'rejected');
    const json = await (await post).json();
    assert.equal(json.outcome, 'rejected');
  } finally {
    hub.close();
  }
});

test('审批桥:无人回复时超时返回 cancelled 并通知群里', async () => {
  const { hub, sent } = await makeHub({ askTimeoutMs: 150 });
  try {
    const post = fetch(`${hub.url}/approval/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'feishu-oc_test_chat', toolName: 'write' }),
    });
    const json = await (await post).json();
    assert.equal(json.outcome, 'cancelled');
    // 取消通知已发
    assert.ok(sent.some((s) => s.text.includes('超时')));
  } finally {
    hub.close();
  }
});

test('审批桥:非 feishu 会话 400;同 chat 已有 pending 时 409', async () => {
  const { hub } = await makeHub();
  try {
    const bad = await fetch(`${hub.url}/approval/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'session-other', toolName: 'x' }),
    });
    assert.equal(bad.status, 400);
    const busy1 = fetch(`${hub.url}/approval/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'feishu-oc_dup', toolName: 'x' }),
    });
    await new Promise((r) => setTimeout(r, 50));
    const busy2 = await fetch(`${hub.url}/approval/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'feishu-oc_dup', toolName: 'y' }),
    });
    assert.equal(busy2.status, 409);
    hub.handleDecision('oc_dup', '同意');
    assert.equal((await busy1).status, 200);
  } finally {
    hub.close();
  }
});

test('审批桥:普通聊天内容不会误触发审批(pending 保留)', async () => {
  const { hub } = await makeHub();
  try {
    const post = fetch(`${hub.url}/approval/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: 'feishu-oc_normal', toolName: 'fs' }),
    });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hub.handleDecision('oc_normal', '今天天气不错'), null); // 不命中
    assert.equal(hub.handleDecision('oc_normal', '同意'), 'allowed-once'); // 仍可正常审批
    const json = await (await post).json();
    assert.equal(json.outcome, 'allowed-once');
  } finally {
    hub.close();
  }
});
