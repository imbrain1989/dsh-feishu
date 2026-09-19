// test/image.test.js
// 离线测试:模拟飞书 API 响应,验证图片传输(上传拿 image_key + 发送图片消息)。
// sendCard/upload 用 stub,不触碰真实飞书。

import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  uploadImage,
  sendImageMessage,
  sendAppImage,
  makeAppClient,
  downloadMessageResource,
  saveMessageImage,
  extForContentType,
} from '../plugins/feishu/app-api.js';
import { materializeIncomingImages } from '../plugins/feishu/receive.js';

const APP_ID = 'cli_test_app';
const APP_SECRET = 'secret_test';
// 测试样例图片:用仓库内相对路径定位,克隆到任意目录都能跑
const SAMPLE_PNG = fileURLToPath(new URL('./sample.png', import.meta.url));

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

test('uploadImage:multipart 上传 file 字段并返回 image_key', async () => {
  const { calls, restore } = mockFetch([
    // 预置缓存 token(仅首次请求 auth,后续命中缓存)
    { match: '/auth/v3/tenant_access_token/internal', body: { code: 0, tenant_access_token: 't-abc', expire: 7200 } },
    { match: '/im/v1/images', body: { code: 0, msg: 'success', data: { image: 'img_v_abc', image_key: 'img_v_xxx' } } },
  ]);
  try {
    const data = await uploadImage({ appId: APP_ID, appSecret: APP_SECRET, filePath: SAMPLE_PNG });
    assert.equal(data.image_key, 'img_v_xxx');
    // token 先获取(此处用缓存,不触发 auth 请求)——注入一个已缓存 token
    const imgCall = calls.find((c) => c.url.includes('/im/v1/images'));
    assert.ok(imgCall, '应请求 im/v1/images');
    assert.equal(imgCall.init.headers.Authorization, 'Bearer t-abc'); // 见下:预置缓存
    // multipart body 含 file 字段(FormData.get)
    const body = imgCall.init.body;
    assert.ok(typeof body.get === 'function', 'body 应为 FormData');
    const filePart = await body.get('file');
    assert.ok(filePart, '应含 file 字段');
    assert.equal(filePart.name, 'sample.png'); // path.basename 取文件名
    // 验证字节与读取一致(防 multipart 被篡改)
    const fs = await import('node:fs');
    const bytes = Buffer.from(await filePart.arrayBuffer());
    const original = await fs.promises.readFile(SAMPLE_PNG);
    assert.deepEqual(bytes, original);
  } finally {
    restore();
  }
});

test('uploadImage:支持 buffer(不读文件)', async () => {
  const { calls, restore } = mockFetch([
    // 预置缓存 token(仅首次请求 auth,后续命中缓存)
    { match: '/auth/v3/tenant_access_token/internal', body: { code: 0, tenant_access_token: 't-abc', expire: 7200 } },
    { match: '/im/v1/images', body: { code: 0, data: { image_key: 'img_v_buf' } } },
  ]);
  try {
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]); // PNG 魔数
    const data = await uploadImage({ appId: APP_ID, appSecret: APP_SECRET }, { buffer: buf });
    assert.equal(data.image_key, 'img_v_buf');
    const body = calls[0].init.body;
    const filePart = await body.get('file');
    const bytes = Buffer.from(await filePart.arrayBuffer());
    assert.deepEqual(bytes, buf); // 字节一致
  } finally {
    restore();
  }
});

test('sendImageMessage:以 image_key 发送图片且 content 为 JSON 字符串', async () => {
  const { calls, restore } = mockFetch([
    { match: '/auth/v3/tenant_access_token/internal', body: { code: 0, tenant_access_token: 't-abc', expire: 7200 } },
    { match: '/im/v1/messages', body: { code: 0, data: { message_id: 'om_img_1' } } },
  ]);
  try {
    const data = await sendImageMessage({
      appId: APP_ID,
      appSecret: APP_SECRET,
      receiveId: 'oc_0123456789abcdef0123456789abcdef',
      imageKey: 'img_v_xxx',
    });
    assert.equal(data.message_id, 'om_img_1');
    const msgCall = calls.find((c) => c.url.includes('/im/v1/messages'));
    assert.ok(msgCall.url.includes('receive_id_type=chat_id'));
    assert.equal(msgCall.init.headers.Authorization, 'Bearer t-abc');
    const body = JSON.parse(msgCall.init.body);
    assert.equal(body.msg_type, 'image');
    assert.equal(body.receive_id, 'oc_0123456789abcdef0123456789abcdef');
    assert.equal(typeof body.content, 'string'); // content 是 JSON 字符串
    assert.deepEqual(JSON.parse(body.content), { image_key: 'img_v_xxx' });
  } finally {
    restore();
  }
});

test('sendAppImage(一步到位):传 filePath 时先上传再发送(两次请求)', async () => {
  const { calls, restore } = mockFetch([
    { match: '/auth/v3/tenant_access_token/internal', body: { code: 0, tenant_access_token: 't-abc', expire: 7200 } },
    { match: '/im/v1/images', body: { code: 0, data: { image_key: 'img_v_step' } } },
    { match: '/im/v1/messages', body: { code: 0, data: { message_id: 'om_img_step' } } },
  ]);
  try {
    const data = await sendAppImage({ appId: APP_ID, appSecret: APP_SECRET, receiveId: 'oc_xxx' }, { filePath: SAMPLE_PNG });
    assert.equal(data.message_id, 'om_img_step');
    // images 请求在前、messages 在后(先上传后发送)
    const imgIdx = calls.findIndex((c) => c.url.includes('/im/v1/images'));
    const msgIdx = calls.findIndex((c) => c.url.includes('/im/v1/messages'));
    assert.ok(imgIdx < msgIdx, '应先上传图片再发送');
  } finally {
    restore();
  }
});

test('sendAppImage:直接传 imageKey 时跳过上传(仅一次请求)', async () => {
  const { calls, restore } = mockFetch([
    { match: '/auth/v3/tenant_access_token/internal', body: { code: 0, tenant_access_token: 't-abc', expire: 7200 } },
    { match: '/im/v1/messages', body: { code: 0, data: { message_id: 'om_img_direct' } } },
  ]);
  try {
    const data = await sendAppImage({ appId: APP_ID, appSecret: APP_SECRET, receiveId: 'oc_xxx' }, { imageKey: 'img_v_direct' });
    assert.equal(data.message_id, 'om_img_direct');
    // 直接传 imageKey 时跳过上传:应无 /im/v1/images 请求(仅 auth + messages)
    const imgCall = calls.find((c) => c.url.includes('/im/v1/images'));
    assert.ok(!imgCall, '直接传 imageKey 不应触发 images API 上传');
  } finally {
    restore();
  }
});

test('makeAppClient.sendImage:便捷客户端直接可用', async () => {
  const { calls, restore } = mockFetch([
    { match: '/auth/v3/tenant_access_token/internal', body: { code: 0, tenant_access_token: 't-abc', expire: 7200 } },
    { match: '/im/v1/images', body: { code: 0, data: { image_key: 'img_v_client' } } },
    { match: '/im/v1/messages', body: { code: 0, data: { message_id: 'om_img_client' } } },
  ]);
  try {
    const client = makeAppClient({ appId: APP_ID, appSecret: APP_SECRET, receiveId: 'oc_xxx' });
    const data = await client.sendImage(SAMPLE_PNG); // 传 filePath(自动上传)
    assert.equal(data.message_id, 'om_img_client');
    const imgCall = calls.find((c) => c.url.includes('/im/v1/images'));
    assert.ok(imgCall.init.headers.Authorization, '应携带 Bearer token');
  } finally {
    restore();
  }
});

test('缺省指引:缺少 receiveId / imageKey', async () => {
  // 预置缓存 token 以让缺失项在发送阶段而非 token 阶段短路
  await assert.rejects(
    () => sendImageMessage({ appId: APP_ID, appSecret: APP_SECRET, imageKey: 'img_v_xxx' }),
    /FEISHU_CHAT_ID/,
  );
  await assert.rejects(
    () => sendAppImage({ appId: APP_ID, appSecret: APP_SECRET, receiveId: 'oc_xxx' }, { imageKey: undefined }),
    /image_key/,
  );
});

// ==================== 接收方向:下载消息中的图片 ====================

/** 用自定义 handler 接管 fetch(可返回二进制,现有 mockFetch 只能回 JSON)。 */
function mockFetchRaw(handler) {
  const orig = globalThis.fetch;
  globalThis.fetch = handler;
  return { restore: () => { globalThis.fetch = orig; } };
}

function tempDir(tag) {
  return path.join(os.tmpdir(), `dsh-feishu-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

test('downloadMessageResource:成功时按二进制读取(不能当 JSON 解析)', async () => {
  const calls = [];
  const { restore } = mockFetchRaw(async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/auth/v3/tenant_access_token')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-abc', expire: 7200 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    // 关键:成功响应体是图片二进制,Content-Type 不是 json
    return new Response(PNG_BYTES, { status: 200, headers: { 'Content-Type': 'image/png' } });
  });
  try {
    const { buffer, contentType } = await downloadMessageResource({
      appId: APP_ID,
      appSecret: APP_SECRET,
      messageId: 'om_abc',
      fileKey: 'img_v3_abc',
    });
    assert.deepEqual(buffer, PNG_BYTES);
    assert.equal(contentType, 'image/png');
    const resCall = calls.find((c) => c.url.includes('/resources/'));
    assert.ok(resCall, '应请求消息资源接口');
    assert.ok(
      resCall.url.includes('/im/v1/messages/om_abc/resources/img_v3_abc?type=image'),
      `URL 应带 message_id/file_key/type,实际:${resCall.url}`,
    );
    assert.equal(resCall.init.headers.Authorization, 'Bearer t-abc');
  } finally {
    restore();
  }
});

test('downloadMessageResource:失败时解析 JSON 错误体并给出可读原因(如缺 im:resource 权限)', async () => {
  const { restore } = mockFetchRaw(async (url) => {
    if (url.includes('/auth/v3/tenant_access_token')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-abc', expire: 7200 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ code: 99991672, msg: 'no permission' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  try {
    await assert.rejects(
      () => downloadMessageResource({ appId: APP_ID, appSecret: APP_SECRET, messageId: 'om_x', fileKey: 'img_v3_x' }),
      /99991672/,
    );
  } finally {
    restore();
  }
});

test('downloadMessageResource:缺少 messageId / fileKey 时立即报错(不空跑网络)', async () => {
  await assert.rejects(
    () => downloadMessageResource({ appId: APP_ID, appSecret: APP_SECRET, fileKey: 'img_v3_x' }),
    /messageId/,
  );
  await assert.rejects(
    () => downloadMessageResource({ appId: APP_ID, appSecret: APP_SECRET, messageId: 'om_x' }),
    /fileKey/,
  );
});

test('extForContentType:常见图片类型映射,未知回退 .png', () => {
  assert.equal(extForContentType('image/png'), '.png');
  assert.equal(extForContentType('image/jpeg'), '.jpg');
  assert.equal(extForContentType('image/jpeg; charset=binary'), '.jpg'); // 带参数
  assert.equal(extForContentType('image/webp'), '.webp');
  assert.equal(extForContentType('application/octet-stream'), '.png'); // 未知回退
  assert.equal(extForContentType(''), '.png');
});

test('saveMessageImage:按 content-type 落盘,且 basename 被净化(防路径穿越)', async () => {
  const dir = tempDir('save');
  const { restore } = mockFetchRaw(async (url) => {
    if (url.includes('/auth/v3/tenant_access_token')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-abc', expire: 7200 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(PNG_BYTES, { status: 200, headers: { 'Content-Type': 'image/jpeg' } });
  });
  try {
    const saved = await saveMessageImage({
      appId: APP_ID,
      appSecret: APP_SECRET,
      messageId: 'om_1',
      imageKey: 'img_v3_abc',
      dir,
      basename: '../../evil name',
    });
    assert.equal(path.dirname(saved.filePath), dir, '文件必须落在指定目录内,不得被 ../ 逃逸');
    assert.ok(saved.filePath.endsWith('.jpg'), `应按 image/jpeg 推断 .jpg,实际:${saved.filePath}`);
    assert.equal(saved.bytes, PNG_BYTES.length);
    assert.deepEqual(fs.readFileSync(saved.filePath), PNG_BYTES);
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('saveMessageImage:超过体积上限时拒绝写入', async () => {
  const dir = tempDir('max');
  const { restore } = mockFetchRaw(async (url) => {
    if (url.includes('/auth/v3/tenant_access_token')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-abc', expire: 7200 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(Buffer.alloc(64), { status: 200, headers: { 'Content-Type': 'image/png' } });
  });
  try {
    await assert.rejects(
      () =>
        saveMessageImage({
          appId: APP_ID,
          appSecret: APP_SECRET,
          messageId: 'om_big',
          imageKey: 'img_v3_big',
          dir,
          maxBytes: 10,
        }),
      /过大/,
    );
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('materializeIncomingImages:多图逐张落盘,单张失败不中断整条消息', async () => {
  const dir = tempDir('multi');
  let resourceHits = 0;
  const { restore } = mockFetchRaw(async (url) => {
    if (url.includes('/auth/v3/tenant_access_token')) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: 't-abc', expire: 7200 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    resourceHits += 1;
    if (resourceHits === 2) {
      // 第 2 张失败(如超时/权限),应只影响它自己
      return new Response(JSON.stringify({ code: 99991672, msg: 'no permission' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(PNG_BYTES, { status: 200, headers: { 'Content-Type': 'image/png' } });
  });
  const logs = [];
  try {
    const { paths, failed } = await materializeIncomingImages({
      appId: APP_ID,
      appSecret: APP_SECRET,
      messageId: 'om_multi',
      imageKeys: ['img_v3_1', 'img_v3_2', 'img_v3_3'],
      dir,
      logger: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
    });
    assert.equal(paths.length, 2, '3 张中应有 2 张成功');
    assert.equal(failed, 1, '应恰好 1 张失败');
    // 文件名含消息 id 与序号,可回溯且不互相覆盖
    assert.ok(paths.every((p) => path.basename(p).startsWith('om_multi-')));
    assert.ok(paths.every((p) => fs.existsSync(p)));
    assert.ok(logs.some((m) => String(m).includes('图片下载失败')), '失败应有日志,不能静默');
  } finally {
    restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('materializeIncomingImages:无图片时不触碰网络与磁盘', async () => {
  let hits = 0;
  const { restore } = mockFetchRaw(async () => {
    hits += 1;
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  try {
    const { paths, failed } = await materializeIncomingImages({
      appId: APP_ID,
      appSecret: APP_SECRET,
      messageId: 'om_none',
      imageKeys: [],
      dir: tempDir('none'),
      logger: { log() {}, error() {} },
    });
    assert.deepEqual(paths, []);
    assert.equal(failed, 0);
    assert.equal(hits, 0);
  } finally {
    restore();
  }
});
