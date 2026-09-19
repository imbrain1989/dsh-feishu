// plugins/feishu/app-api.js
// 飞书"企业自建应用"API 客户端。
//
// 适用场景(Webhook 单向推送无法覆盖的):
//   - 通过 im/v1/messages 以应用身份发消息(可指定任意用户/群,无需群里加机器人)
//   - 读写云文档 / 表格 / 日历 / 审批等数据
//   - 事件订阅 / 长连接接收消息(对接 AI 对话机器人)
//
// 前置:
//   1. 在 https://open.feishu.cn 创建"企业自建应用",拿到 App ID / App Secret
//   2. 应用后台开通权限:im:message(发送消息)、im:chat 等,并"创建版本 -> 发布"
//   3. 将机器人添加到目标群(在群里 @机器人 或应用后台添加)
//
// 官方文档:https://open.feishu.cn/document/server-docs/im-v1/message/create
import * as path from 'node:path';

const OPEN_API = 'https://open.feishu.cn/open-apis';

// tenant_access_token 约 2 小时有效,做进程内缓存,避免每次请求都换取
let cachedToken = { token: null, expiresAt: 0 };

/**
 * 获取 tenant_access_token(租户级访问凭证)。
 * @param {object} opts { appId, appSecret }
 * @param {boolean} [opts.forceRefresh] 强制重新获取
 */
export async function getTenantAccessToken({ appId, appSecret }, { forceRefresh = false } = {}) {
  if (!appId || !appSecret) {
    throw new Error('缺少 appId / appSecret:请在飞书开放平台创建企业自建应用,并填入 .env 的 FEISHU_APP_ID / FEISHU_APP_SECRET');
  }
  if (!forceRefresh && cachedToken.token && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const res = await fetch(`${OPEN_API}/auth/v3/tenant_access_token/internal`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const json = await res.json();
  if (json.code !== 0) {
    throw new Error(`获取 tenant_access_token 失败 code=${json.code} msg=${json.msg}`);
  }
  cachedToken = { token: json.tenant_access_token, expiresAt: Date.now() + (json.expire || 7200) * 1000 };
  return json.tenant_access_token;
}

/**
 * 以应用身份发送消息(im/v1/messages)。content 为 JSON 字符串。
 * @param {object} opts
 * @param {string} opts.appId
 * @param {string} opts.appSecret
 * @param {'open_id'|'user_id'|'union_id'|'email'|'chat_id'} [opts.receiveIdType] 接收者类型,默认 chat_id
 * @param {string} opts.receiveId 接收者 ID(群 chat_id / 用户 open_id 等)
 * @param {string} [opts.msgType] text | post | interactive | image | ...
 * @param {string} opts.content 内容 JSON 字符串,如 '{"text":"你好"}'
 */
export async function sendAppMessage({ appId, appSecret, receiveIdType = 'chat_id', receiveId, msgType = 'text', content }) {
  if (!receiveId) {
    throw new Error('缺少 receiveId:请在 .env 中配置 FEISHU_CHAT_ID(目标群 chat_id)');
  }
  const token = await getTenantAccessToken({ appId, appSecret });
  const res = await fetch(`${OPEN_API}/im/v1/messages?receive_id_type=${receiveIdType}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ receive_id: receiveId, msg_type: msgType, content }),
  });
  const json = await res.json();
  if (json.code !== 0) {
    throw new Error(`发送消息失败 code=${json.code} msg=${json.msg}`);
  }
  return json.data;
}

/**
 * 上传图片到飞书,获取 image_key(用于发送图片消息)。
 * 官方文档:https://open.feishu.cn/document/server-docs/im-v1/message-media/upload
 * 权限:im:image / im:message。文件 ≤20MB,支持 png/jpg/gif/webp 等。
 * @param {object} opts
 * @param {string} opts.appId
 * @param {string} opts.appSecret
 * @param {string} [opts.filePath] 图片本地路径;缺省用 opts.buffer
 * @param {Buffer} [opts.buffer] 图片文件字节(与 filePath 二选一)
 * @returns {Promise<{image?:string, image_key:string}>} 飞书返回的媒体对象
 */
export async function uploadImage({ appId, appSecret, filePath }, { buffer } = {}) {
  const token = await getTenantAccessToken({ appId, appSecret });
  let buf;
  if (filePath) {
    const fs = await import('node:fs');
    buf = await fs.promises.readFile(filePath);
  } else if (buffer) {
    buf = buffer;
  } else {
    throw new Error('缺少图片:提供 filePath 或 opts.buffer(字节 Buffer)');
  }
  const filename = filePath ? path.basename(filePath) : 'image.png';
  // multipart/form-data:字段 file。注意不得手动设置 Content-Type,否则破坏 boundary。
  const form = new FormData();
  form.append('file', new File([buf], filename, { type: 'image/png' }));

  const res = await fetch(`${OPEN_API}/im/v1/images`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` }, // 由 FormData 自动设置 boundary
    body: form,
  });
  const json = await res.json();
  if (json.code !== 0) {
    throw new Error(`上传图片失败 code=${json.code} msg=${json.msg}`);
  }
  return json.data; // { image?, image_key }
}

/**
 * 以 image_key 发送图片消息(im/v1/messages, msg_type='image')。
 * @param {object} opts
 * @param {string} opts.appId
 * @param {string} opts.appSecret
 * @param {string} opts.receiveId 目标群 chat_id(缺省用 FEISHU_CHAT_ID)
 * @param {string} opts.imageKey 上传获得的 image_key(形如 img_v_xxxx)
 */
export async function sendImageMessage({ appId, appSecret, receiveId, imageKey }) {
  if (!receiveId) {
    throw new Error('缺少 receiveId:请在 .env 中配置 FEISHU_CHAT_ID(目标群 chat_id)');
  }
  if (!imageKey) {
    throw new Error('缺少 image_key:先调用 uploadImage({filePath}) 获取,或直接传入 imageKey');
  }
  const token = await getTenantAccessToken({ appId, appSecret });
  const res = await fetch(`${OPEN_API}/im/v1/messages?receive_id_type=chat_id`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'image',
      content: JSON.stringify({ image_key: imageKey }),
    }),
  });
  const json = await res.json();
  if (json.code !== 0) {
    throw new Error(`发送图片失败 code=${json.code} msg=${json.msg}`);
  }
  return json.data;
}

/**
 * 一步到位:发一张图片到目标群。内部先上传(缺省 imageKey 时),再发送。
 * @param {object} opts
 * @param {string} opts.appId
 * @param {string} opts.appSecret
 * @param {string} [opts.receiveId] 目标群 chat_id(缺省用 FEISHU_CHAT_ID)
 * @param {string} [opts.filePath] 图片本地路径;与 imageKey 二选一
 * @param {string} [opts.imageKey] 已获取的 image_key;与 filePath 二选一
 */
export async function sendAppImage({ appId, appSecret, receiveId }, { filePath, imageKey } = {}, env) {
  const target = receiveId ?? env?.FEISHU_CHAT_ID; // index.js 调用时注入 env;缺省用目标群
  if (!target) throw new Error('缺少 receiveId:请在 .env 中配置 FEISHU_CHAT_ID');
  let key = imageKey;
  if (!key && filePath) {
    const uploaded = await uploadImage({ appId, appSecret, filePath });
    key = uploaded.image_key;
  }
  if (!key) throw new Error('缺少 image_key(提供 filePath 或 imageKey);先调用 uploadImage');
  return sendImageMessage({ appId, appSecret, receiveId: target, imageKey: key });
}

// ==================== 接收方向:下载消息中的资源(图片) ====================

/**
 * 下载「消息中的资源文件」(用户在飞书发来的图片/文件)。
 * 官方文档:https://open.feishu.cn/document/server-docs/im-v1/message/get-2
 * 权限:im:resource(获取与上传图片或文件资源)。缺权限会返回 code=99991672/403。
 * 注意:成功时响应体是**二进制**,失败时才是 JSON —— 故不能直接 res.json()。
 * @param {object} opts
 * @param {string} opts.appId
 * @param {string} opts.appSecret
 * @param {string} opts.messageId 消息 id(om_xxx),资源必须绑定具体消息
 * @param {string} opts.fileKey 资源的 key(image_key / file_key)
 * @param {'image'|'file'} [opts.type] 资源类型,默认 image
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
export async function downloadMessageResource({ appId, appSecret, messageId, fileKey, type = 'image' }) {
  if (!messageId) throw new Error('缺少 messageId:下载消息资源必须提供消息 id(om_xxx)');
  if (!fileKey) throw new Error('缺少 fileKey:请传入消息内容里的 image_key / file_key');
  const token = await getTenantAccessToken({ appId, appSecret });
  const url =
    `${OPEN_API}/im/v1/messages/${encodeURIComponent(messageId)}` +
    `/resources/${encodeURIComponent(fileKey)}?type=${encodeURIComponent(type)}`;

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const contentType = res.headers.get('content-type') ?? '';

  // 失败:飞书回 JSON 错误体(HTTP 非 2xx 或 content-type 为 json)
  if (!res.ok || contentType.includes('application/json')) {
    let detail = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      detail = `code=${j.code} msg=${j.msg}`;
    } catch {
      /* 非 JSON 错误体,保留 HTTP 状态 */
    }
    throw new Error(`下载消息资源失败(${type}=${fileKey}):${detail}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (!buffer.length) throw new Error(`下载消息资源失败(${type}=${fileKey}):内容为空`);
  return { buffer, contentType };
}

/** content-type → 文件扩展名(飞书图片资源通常回 png/jpeg/gif/webp) */
const EXT_BY_CONTENT_TYPE = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/bmp': '.bmp',
  'image/tiff': '.tiff',
  'image/heic': '.heic',
};

/** 由 content-type 推断扩展名;未知类型回退 .png(飞书图片资源绝大多数为 png) */
export function extForContentType(contentType = '') {
  const base = String(contentType).split(';')[0].trim().toLowerCase();
  return EXT_BY_CONTENT_TYPE[base] ?? '.png';
}

/**
 * 下载一张消息图片并存到本地目录,返回本地路径(供 DSH 智能体用 read_image 读取)。
 * @param {object} opts
 * @param {string} opts.appId
 * @param {string} opts.appSecret
 * @param {string} opts.messageId 消息 id
 * @param {string} opts.imageKey 图片 key
 * @param {string} opts.dir 本地保存目录(不存在则递归创建)
 * @param {string} [opts.basename] 文件名(不含扩展名);缺省用「时间戳-序号」
 * @param {number} [opts.maxBytes] 体积上限,超过则抛错(默认 20MB,与飞书上传上限一致)
 * @returns {Promise<{filePath: string, bytes: number, contentType: string}>}
 */
export async function saveMessageImage({
  appId,
  appSecret,
  messageId,
  imageKey,
  dir,
  basename,
  maxBytes = 20 * 1024 * 1024,
}) {
  if (!dir) throw new Error('缺少 dir:请指定图片本地保存目录');
  const { buffer, contentType } = await downloadMessageResource({
    appId,
    appSecret,
    messageId,
    fileKey: imageKey,
    type: 'image',
  });
  if (buffer.length > maxBytes) {
    throw new Error(`图片过大(${buffer.length} 字节 > 上限 ${maxBytes} 字节),已跳过`);
  }
  const fs = await import('node:fs');
  await fs.promises.mkdir(dir, { recursive: true });
  // basename 净化:防路径穿越(basename 可能来自消息 id,虽可信也不裸用)
  const rawName = basename || `${Date.now()}-${imageKey.slice(-6)}`;
  const name = String(rawName).replace(/[^A-Za-z0-9._-]/g, '_') || String(Date.now());
  const filePath = path.join(dir, `${name}${extForContentType(contentType)}`);
  await fs.promises.writeFile(filePath, buffer);
  return { filePath, bytes: buffer.length, contentType };
}

/**
 * 便捷构造应用模式客户端,固定 appId/appSecret/目标群。
 * @param {object} config { appId, appSecret, receiveId, receiveIdType }
 */
export function makeAppClient({ appId, appSecret, receiveId, receiveIdType = 'chat_id' } = {}) {
  const opts = { appId, appSecret, receiveId, receiveIdType };
  return {
    sendText: (text) =>
      sendAppMessage({ ...opts, msgType: 'text', content: JSON.stringify({ text }) }),
    sendCard: (card) =>
      sendAppMessage({ ...opts, msgType: 'interactive', content: JSON.stringify(card) }),
    /** 发一张图片:传 filePath(自动上传拿 image_key)或 imageKey */
    sendImage: (filePath, { imageKey } = {}) =>
      sendAppImage({ ...opts }, { filePath, imageKey }),
  };
}

/** 由 .env 读取配置并构造应用模式客户端(CLI 用)。 */
export function appClientFromEnv(env = process.env) {
  return makeAppClient({
    appId: env.FEISHU_APP_ID,
    appSecret: env.FEISHU_APP_SECRET,
    receiveId: env.FEISHU_CHAT_ID,
  });
}
