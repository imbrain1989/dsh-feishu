// test/feishu.test.js
// 离线测试:不依赖网络,验证签名算法与请求组装逻辑。
// 运行:npm test

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { buildSign, sendToWebhook, sendText, makeClient } from '../plugins/feishu/webhook.js';

const FAKE_HOOK = 'https://open.feishu.cn/open-apis/bot/v2/hook/fake-token';

/** 用独立实现(直接在测试里重写算法)交叉验证 buildSign */
function referenceSign(timestamp, secret) {
  const stringToSign = `${timestamp}\n${secret}`;
  return createHmac('sha256', stringToSign).update(stringToSign).digest('base64');
}

test('buildSign 与官方加签算法一致', () => {
  const ts = 1700000000;
  const secret = 'some-secret-密钥';
  assert.equal(buildSign(ts, secret), referenceSign(ts, secret));
  // 时间戳变化则签名变化
  assert.notEqual(buildSign(ts + 1, secret), buildSign(ts, secret));
});

test('sendText 组装正确请求体(未加签)', async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ StatusCode: 0, StatusMessage: 'success' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const result = await sendText('你好,飞书', { webhookUrl: FAKE_HOOK });
    assert.equal(result.StatusCode, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, FAKE_HOOK);
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body, { msg_type: 'text', content: { text: '你好,飞书' } });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('开启加签后请求体带 timestamp 与 sign', async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    calls.push(init);
    return new Response(JSON.stringify({ code: 0, msg: 'success' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    const secret = 'secret-key';
    const client = makeClient({ webhookUrl: FAKE_HOOK, secret });
    await client.sendText('hello');
    const body = JSON.parse(calls[0].body);
    assert.equal(body.msg_type, 'text');
    assert.ok(Number.isInteger(body.timestamp));
    // 时间戳为秒级(10 位)
    assert.ok(String(body.timestamp).length === 10);
    assert.equal(body.sign, referenceSign(body.timestamp, secret));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('飞书业务错误码(code!=0)会抛出可读错误', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ StatusCode: 19001, StatusMessage: 'sign match fail or timestamp is not within one hour' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  try {
    await assert.rejects(
      () => sendText('x', { webhookUrl: FAKE_HOOK, secret: 's' }),
      /code=19001/
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('HTTP 层错误会抛出', async () => {
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('Bad Gateway', { status: 502 });
  try {
    await assert.rejects(() => sendText('x', { webhookUrl: FAKE_HOOK }), /HTTP 502/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('缺少 webhookUrl 时给出明确指引', async () => {
  await assert.rejects(() => sendText('x', {}), /FEISHU_WEBHOOK_URL/);
});
