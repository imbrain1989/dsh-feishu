// test/app-api.test.js
// 离线测试:模拟飞书 API 响应,验证 token 获取、请求头、content 序列化。

import test from 'node:test';
import assert from 'node:assert/strict';

import { getTenantAccessToken, sendAppMessage, makeAppClient, appClientFromEnv } from '../plugins/feishu/app-api.js';

const APP_ID = 'cli_test_app';
const APP_SECRET = 'secret_test';

function mockFetch(routes) {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    for (const r of routes) {
      if (url.includes(r.match)) {
        return new Response(JSON.stringify(r.body), {
          status: r.status ?? 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ code: -1, msg: 'no route' }), { status: 404 });
  };
  return { calls, restore: () => { globalThis.fetch = orig; } };
}

test('获取 tenant_access_token 并缓存', async () => {
  const { calls, restore } = mockFetch([
    { match: '/auth/v3/tenant_access_token/internal', body: { code: 0, tenant_access_token: 't-abc', expire: 7200 } },
  ]);
  try {
    const t1 = await getTenantAccessToken({ appId: APP_ID, appSecret: APP_SECRET });
    const t2 = await getTenantAccessToken({ appId: APP_ID, appSecret: APP_SECRET });
    assert.equal(t1, 't-abc');
    assert.equal(t2, 't-abc');
    assert.equal(calls.length, 1, '第二次应命中缓存,不再请求');
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body, { app_id: APP_ID, app_secret: APP_SECRET });
  } finally {
    restore();
  }
});

test('sendAppMessage 携带 Bearer token 且 content 为 JSON 字符串', async () => {
  const { calls, restore } = mockFetch([
    { match: '/auth/v3/tenant_access_token/internal', body: { code: 0, tenant_access_token: 't-abc', expire: 7200 } },
    { match: '/im/v1/messages', body: { code: 0, data: { message_id: 'om_123' } } },
  ]);
  try {
    const data = await sendAppMessage({
      appId: APP_ID,
      appSecret: APP_SECRET,
      receiveId: 'oc_0123456789abcdef0123456789abcdef',
      msgType: 'text',
      content: JSON.stringify({ text: '你好' }),
    });
    assert.equal(data.message_id, 'om_123');
    const msgCall = calls.find((c) => c.url.includes('/im/v1/messages'));
    assert.ok(msgCall, '应请求 im/v1/messages');
    assert.ok(msgCall.url.includes('receive_id_type=chat_id'));
    assert.equal(msgCall.init.headers.Authorization, 'Bearer t-abc');
    const body = JSON.parse(msgCall.init.body);
    assert.equal(body.receive_id, 'oc_0123456789abcdef0123456789abcdef');
    assert.equal(body.msg_type, 'text');
    assert.equal(typeof body.content, 'string');
    assert.deepEqual(JSON.parse(body.content), { text: '你好' });
  } finally {
    restore();
  }
});

test('makeAppClient.sendText 直接可用', async () => {
  const { calls, restore } = mockFetch([
    { match: '/auth/v3/tenant_access_token/internal', body: { code: 0, tenant_access_token: 't-abc', expire: 7200 } },
    { match: '/im/v1/messages', body: { code: 0, data: { message_id: 'om_456' } } },
  ]);
  try {
    const client = makeAppClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      receiveId: 'oc_0123456789abcdef0123456789abcdef',
    });
    const data = await client.sendText('hello');
    assert.equal(data.message_id, 'om_456');
    const body = JSON.parse(calls.find((c) => c.url.includes('/im/v1/messages')).init.body);
    assert.deepEqual(JSON.parse(body.content), { text: 'hello' });
  } finally {
    restore();
  }
});

test('缺少 App ID / chat_id 时给出明确指引', async () => {
  await assert.rejects(() => getTenantAccessToken({}), /FEISHU_APP_ID/);
  await assert.rejects(
    () => sendAppMessage({ appId: APP_ID, appSecret: APP_SECRET, receiveId: '' }),
    /FEISHU_CHAT_ID/
  );
});

test('appClientFromEnv 读取环境变量', () => {
  const client = appClientFromEnv({
    FEISHU_APP_ID: 'cli_x',
    FEISHU_APP_SECRET: 's',
    FEISHU_CHAT_ID: 'oc_y',
  });
  assert.ok(typeof client.sendText === 'function');
  assert.ok(typeof client.sendCard === 'function');
});
