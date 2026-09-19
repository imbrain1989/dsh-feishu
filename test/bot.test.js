// test/bot.test.js
// 离线测试:消息解析、回复决策与回复组装(llm 直连模式已删除,仅保留 echo / dsh)。

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseReceiveEvent, shouldReply, replyText, createChatSerializer, extractPostContent, createSlowTaskNotifier } from '../plugins/feishu/receive.js';

// 官方 im.message.receive_v1 (v2.0) 事件样例
const SAMPLE_EVENT = {
  schema: '2.0',
  header: {
    event_id: 'evt_test',
    event_type: 'im.message.receive_v1',
    tenant_key: 'tk_test',
  },
  event: {
    sender: {
      sender_id: { open_id: 'ou_user_123', union_id: 'on_123', user_id: '123' },
      sender_type: 'user',
      tenant_key: 'tk_test',
    },
    message: {
      chat_id: 'oc_0123456789abcdef0123456789abcdef',
      chat_type: 'group',
      message_id: 'om_123',
      message_type: 'text',
      content: '{"text":"你好,机器人"}',
      create_time: '1787707151945',
      mentions: [{ key: 'x', id: { open_id: 'ou_bot' }, name: '机器人', tenant_key: 'tk' }],
    },
  },
};

test('parseReceiveEvent 解析文本消息', () => {
  const parsed = parseReceiveEvent(SAMPLE_EVENT.event);
  assert.equal(parsed.text, '你好,机器人');
  assert.equal(parsed.chatId, 'oc_0123456789abcdef0123456789abcdef');
  assert.equal(parsed.chatType, 'group');
  assert.equal(parsed.senderType, 'user');
  assert.equal(parsed.senderId, 'ou_user_123');
  assert.equal(parsed.messageType, 'text');
});

test('parseReceiveEvent 处理非文本/空内容不抛错', () => {
  assert.equal(parseReceiveEvent({ sender: {}, message: { message_type: 'image' } }).text, '');
  assert.equal(parseReceiveEvent({ sender: {}, message: { message_type: 'text', content: 'not-json' } }).text, '');
});

test('parseReceiveEvent 解析图片消息(取 image_key)', () => {
  const parsed = parseReceiveEvent({
    sender: { sender_type: 'user' },
    message: {
      chat_id: 'oc_x',
      chat_type: 'p2p',
      message_id: 'om_img',
      message_type: 'image',
      content: '{"image_key":"img_v3_abc"}',
    },
  });
  assert.equal(parsed.text, '');
  assert.deepEqual(parsed.imageKeys, ['img_v3_abc']);
  assert.equal(parsed.messageType, 'image');
});

test('parseReceiveEvent 解析 post 富文本(图文混排:文字与内嵌图片都取出)', () => {
  // 飞书里"图+文"一起发通常是 post,而不是 image —— 这是最容易漏的路径
  const parsed = parseReceiveEvent({
    sender: { sender_type: 'user' },
    message: {
      chat_id: 'oc_x',
      message_id: 'om_post',
      message_type: 'post',
      content: JSON.stringify({
        title: '看看这个',
        content: [
          [{ tag: 'text', text: '帮我看看' }, { tag: 'img', image_key: 'img_v3_p1' }],
          [{ tag: 'text', text: '第二行' }],
        ],
      }),
    },
  });
  assert.equal(parsed.text, '看看这个\n帮我看看\n第二行');
  assert.deepEqual(parsed.imageKeys, ['img_v3_p1']);
});

test('extractPostContent 兼容发送侧多语言结构与 at 元素', () => {
  const r = extractPostContent({
    zh_cn: { title: '标题', content: [[{ tag: 'at', user_name: '小明' }, { tag: 'text', text: '你好' }]] },
  });
  assert.equal(r.text, '标题\n@小明你好');
  assert.deepEqual(r.imageKeys, []);
});

test('shouldReply:回复用户文本与图片,不回复机器人自己的消息', () => {
  assert.equal(shouldReply(parseReceiveEvent(SAMPLE_EVENT.event)), true);
  const botMsg = {
    sender: { sender_type: 'app', sender_id: { open_id: 'ou_bot' } },
    message: { chat_id: 'oc_x', chat_type: 'p2p', message_type: 'text', content: '{"text":"hi"}' },
  };
  assert.equal(shouldReply(parseReceiveEvent(botMsg)), false);

  // 关键回归:用户发的图片必须放行(历史上这里返回 false,导致图片被静默丢弃)
  const userImage = parseReceiveEvent({
    sender: { sender_type: 'user' },
    message: { chat_id: 'oc_x', message_id: 'om_i', message_type: 'image', content: '{"image_key":"img_v3_abc"}' },
  });
  assert.equal(shouldReply(userImage), true);

  // 机器人自己发的图片仍不回复(防自问自答死循环)
  const botImage = parseReceiveEvent({
    sender: { sender_type: 'app' },
    message: { chat_id: 'oc_x', message_id: 'om_i2', message_type: 'image', content: '{"image_key":"img_v3_x"}' },
  });
  assert.equal(shouldReply(botImage), false);

  // 既无文字也无图片(如 file/audio)仍不回复
  assert.equal(
    shouldReply(parseReceiveEvent({ sender: { sender_type: 'user' }, message: { message_type: 'file', content: '{}' } })),
    false,
  );
});

test('replyText 组装正确(chat_id 发送,content 为 JSON 字符串)', async () => {
  const calls = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url.includes('/auth/v3/tenant_access_token')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-abc', expire: 7200 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/im/v1/messages')) {
      calls.push({ url, init });
      return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_reply' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ code: -1, msg: 'no route' }), { status: 404 });
  };
  try {
    const data = await replyText({ appId: 'cli_x', appSecret: 's', chatId: 'oc_abc', text: '回复你' });
    assert.equal(data.message_id, 'om_reply');
    assert.ok(calls[0].url.includes('receive_id_type=chat_id'));
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.receive_id, 'oc_abc');
    assert.deepEqual(JSON.parse(body.content), { text: '回复你' });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('createChatSerializer:同 chat 串行且按序执行', async () => {
  const enqueue = createChatSerializer();
  const order = [];
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));
  const p1 = enqueue('chatA', async () => {
    order.push('a-start');
    await delay(30);
    order.push('a-end');
  });
  const p2 = enqueue('chatA', async () => {
    order.push('b');
  });
  const p3 = enqueue('chatB', async () => {
    order.push('c');
  });
  await Promise.all([p1, p2, p3]);
  // chatA 的两条严格串行(b 在 a-end 之后);chatB 独立、不被 chatA 阻塞
  assert.ok(order.indexOf('a-start') < order.indexOf('a-end'));
  assert.ok(order.indexOf('a-end') < order.indexOf('b'));
  assert.ok(order.includes('c'));
});

test('createChatSerializer:单条失败不阻塞队列,错误透传给调用方', async () => {
  const enqueue = createChatSerializer();
  const order = [];
  const p1 = enqueue('chatX', async () => {
    throw new Error('boom');
  });
  const p2 = enqueue('chatX', async () => {
    order.push('after-error');
  });
  await assert.rejects(p1, /boom/);
  await p2;
  assert.deepEqual(order, ['after-error']);
});

/** 安装一个只记录 im/v1/messages 发送请求的 fetch 桩,返回已发送文本的数组。 */
function installSendSpy() {
  const sent = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (url.includes('/auth/v3/tenant_access_token')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-abc', expire: 7200 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (url.includes('/im/v1/messages')) {
      sent.push(JSON.parse(JSON.parse(init.body).content).text);
      return new Response(JSON.stringify({ code: 0, data: { message_id: 'om_x' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ code: -1, msg: 'no route' }), { status: 404 });
  };
  return { sent, restore: () => { globalThis.fetch = origFetch; } };
}

const quietLogger = { log() {}, error() {} };

test('超时回执:任务在阈值内结束 → 全程静默(不再每条都回"收到")', async () => {
  const spy = installSendSpy();
  try {
    const notice = createSlowTaskNotifier({
      appId: 'cli_x', appSecret: 's', chatId: 'oc_a', thresholdMs: 40, logger: quietLogger,
    });
    // 模拟任务很快跑完
    notice.cancel();
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(spy.sent.length, 0);
    assert.equal(notice.fired(), false);
  } finally {
    spy.restore();
  }
});

test('超时回执:超过阈值仍未完成 → 回一条带耗时秒数的提示,且默认只提醒一次', async () => {
  const spy = installSendSpy();
  try {
    const notice = createSlowTaskNotifier({
      appId: 'cli_x',
      appSecret: 's',
      chatId: 'oc_a',
      thresholdMs: 30,
      logger: quietLogger,
      message: '⏳ 还在处理中(已 {seconds} 秒)',
    });
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(spy.sent.length, 1, '超过阈值应恰好收到一条提示');
    assert.match(spy.sent[0], /^⏳ 还在处理中\(已 \d+ 秒\)$/);
    assert.equal(notice.fired(), true);
    // intervalMs=0:再等一段时间也不会有第二条
    await new Promise((r) => setTimeout(r, 90));
    assert.equal(spy.sent.length, 1);
    notice.cancel();
  } finally {
    spy.restore();
  }
});

test('超时回执:intervalMs>0 时按间隔重复提醒,cancel 后停止', async () => {
  const spy = installSendSpy();
  try {
    const notice = createSlowTaskNotifier({
      appId: 'cli_x', appSecret: 's', chatId: 'oc_a',
      thresholdMs: 20, intervalMs: 30, logger: quietLogger,
    });
    await new Promise((r) => setTimeout(r, 100));
    assert.ok(spy.sent.length >= 2, `期望至少两次提醒,实际 ${spy.sent.length}`);
    notice.cancel();
    const countAfterCancel = spy.sent.length;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(spy.sent.length, countAfterCancel, 'cancel 之后不应再发送');
  } finally {
    spy.restore();
  }
});
