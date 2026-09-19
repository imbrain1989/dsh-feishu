// test/card-approval.test.js
// 离线测试:卡片式审批通道的交互卡片构造 + askApproval/handleDecision 完整流程。
// sendCard 用 stub,不触碰真实飞书。

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildApprovalCard, askApproval, handleDecision } from '../plugins/feishu/card-approval.js';

test('buildApprovalCard:返回交互式卡片且含同意/拒绝两个按钮', () => {
  const card = buildApprovalCard({ toolName: 'pwsh', reason: '需要更高权限' });
  assert.equal(card.msgType, undefined); // schema 本身无 msgType;交互性由调用方决定
  assert.ok(Array.isArray(card.elements));
  const buttons = card.elements.filter((e) => e.tag === 'button');
  assert.equal(buttons.length, 2);
  assert.deepEqual(buttons.map((b) => b.text.content), ['同意', '拒绝']);
});

test('buildApprovalCard:无 reason 时不追加原因行', () => {
  const card = buildApprovalCard({ toolName: 'bash' });
  const body = card.elements[0].text.content;
  assert.ok(body.includes('操作:bash'));
  assert.ok(!body.includes('原因:'));
});

test('askApproval+handleDecision:群里回复「同意」resolve allowed-once', async () => {
  const sent = [];
  const p = askApproval({
    targetChatId: 'oc_allow',
    request: { toolName: 'pwsh', reason: '需要更高权限' },
    opts: { sendCard: async ({ content }) => { sent.push(JSON.parse(content)); } },
  });
  // handleDecision(chatId,text) 命中 chatToRequest,回传 outcome(与审批桥契约一致)
  assert.equal(handleDecision('oc_allow', '同意'), 'allowed-once');
  const resolved = await p;
  assert.equal(resolved, 'allowed-once');
});

test('askApproval:普通聊天内容不命中,pending 保留且仍可正常决定', async () => {
  const sent = [];
  const p = askApproval({ targetChatId: 'oc_normal', request: { toolName: 'fs' }, opts: { sendCard: async ({ content }) => { sent.push(content); } } });
  assert.equal(handleDecision('oc_normal', '今天天气不错'), null); // 不命中,无副作用
  assert.equal(handleDecision('oc_normal', '拒绝吧'), 'rejected');
  const resolved = await p;
  assert.equal(resolved, 'rejected');
});

test('askApproval:无人决定时超时返回 cancelled', async () => {
  const sent = [];
  const p = askApproval({ targetChatId: 'oc_to', request: { toolName: 'write' }, opts: { sendCard: async () => { sent.push(1); }, askTimeoutMs: 120 } });
  await p; // 等待超时自动 cancelled(fail-closed)
});

test('handleDecision:未知 chat 返回 null,不抛错', () => {
  assert.equal(handleDecision('oc_unknown', '同意'), null);
});

test('askApproval:首次决定后可在同一 chat 再发起一次', async () => {
  const sent = [];
  let first;
  // 首次:发出卡片后立即 settle(拒绝)→清理映射,不再等待默认 100s
  first = askApproval({ targetChatId: 'oc_seq', request: { toolName: 'x' }, opts: { sendCard: async ({ content }) => { sent.push(content); } } });
  assert.equal(handleDecision('oc_seq', '拒绝'), 'rejected');
  const r1 = await first;
  assert.equal(r1, 'rejected');
  // 清理后同一 chat 可再发起一次(本次给短超时,等待其自动 cancelled,避免挂起)
  const second = askApproval({ targetChatId: 'oc_seq', request: { toolName: 'y' }, opts: { sendCard: async ({ content }) => { sent.push(content); }, askTimeoutMs: 40 } });
  await new Promise((r) => setTimeout(r, 60)); // 超过短超时,让其自动 cancelled(非 racy)
  assert.equal(await second, 'cancelled');
});
