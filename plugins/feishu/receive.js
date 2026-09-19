// plugins/feishu/receive.js
// 飞书消息接收:通过长连接(WebSocket)接收 im.message.receive_v1 事件并回复。
//
// 前置(飞书开放平台后台):
//   1. 事件与回调 -> 事件配置 -> 添加事件:im.message.receive_v1(接收消息 v2.0)
//   2. 编辑订阅方式 -> 选择"使用长连接接收事件" -> 保存
//      (必须先启动本程序且长连接在线,才能保存成功)
//   3. 创建版本并发布
//
// 回复模式:echo=原样回显(验证链路) | dsh=交给本机 DSH 智能体处理(推荐)

import * as Lark from '@larksuiteoapi/node-sdk';
import * as path from 'node:path';
import { askDsh, buildTask, sessionIdForChat } from './dsh.js';
// 卡片式审批通道(自决/机器人自决,非群投票):决策经飞书交互卡片呈现,receive.js 内 reply 文本路由走 cardHandleDecision(chatId,text)。(不注入 HTTP bridge。)
import { handleDecision as cardHandleDecision } from './card-approval.js';
// im/v1 messages:应用身份发消息(发回复/审批回执共用);saveMessageImage:下载用户发来的图片,从 app-api.js 导入。
import { sendAppMessage, saveMessageImage } from './app-api.js';

/** 收到的图片默认落盘目录(位于监听器 cwd,即工作区内,便于智能体 read_image 读取) */
export const DEFAULT_IMAGE_DIR = path.join(process.cwd(), '.feishu-images');

// ==================== 纯函数(便于离线测试) ====================

/**
 * 创建「每 chat 串行队列」:同一个对话框同时只执行一个任务。
 * 背景:DSH 会话日志按 chat 持久化(见 dsh.js),若两条消息并发触发两个
 * dsh-headless 进程 resume + append 同一会话,会产生 seq 重叠/缺口而损坏日志
 * (曾出现 "seq gap in committed region")。串行化后同一会话始终只有一个写者。
 * @returns {(chatId: string, task: () => Promise<any>) => Promise<any>}
 */
export function createChatSerializer() {
  const tails = new Map();
  function enqueue(chatId, task) {
    const key = String(chatId ?? '');
    const prev = tails.get(key) ?? Promise.resolve();
    // prev 永不复现错误(尾部 catch 过),这里只是等待上一位完成
    const run = prev.then(task, task);
    tails.set(key, run.catch(() => undefined));
    return run;
  }
  return enqueue;
}




/**
 * 任务状态队列(内存):记录每个 chat 的异步任务状态,支持轮询/状态查询。
 * 背景:async 路径下任务完成后才推送结果;用户可在完成前查询"是否还在跑"。
 * 可选后端:此处为内存实现;跨进程/持久化可替换为 Redis(见 README)。
 * @returns {{ set: (chatId, patch) => object, get: (chatId) => object|undefined, clear: (chatId) => void }}
 */
export function createTaskStatusStore() {
  const tasks = new Map(); // chatId -> { status, startedAt, updatedAt, result? }
  function set(chatId, patch) {
    const key = String(chatId ?? '');
    const now = Date.now();
    const prev = tasks.get(key);
    const next = {
      ...(prev || {}),
      ...patch,
      status: patch.status ?? prev?.status ?? 'running',
      startedAt: prev?.startedAt ?? now,
      updatedAt: now,
    };
    tasks.set(key, next);
    return next;
  }
  function get(chatId) {
    return tasks.get(String(chatId ?? ''));
  }
  function clear(chatId) {
    tasks.delete(String(chatId ?? ''));
  }
  return { set, get, clear };
}


/**
 * 从 post(富文本)内容里抽出纯文本与内嵌图片 key。
 * 兼容两种结构:
 *   1. 事件侧(单语言):{ title?, content: [[{tag,text|image_key}, ...], ...] }
 *   2. 发送侧(多语言):{ zh_cn: { title, content }, en_us: {...} }
 * @param {object} parsed 已 JSON.parse 的 content
 * @returns {{text: string, imageKeys: string[]}}
 */
export function extractPostContent(parsed) {
  const imageKeys = [];
  const parts = [];
  let doc = parsed ?? {};
  if (!Array.isArray(doc.content)) {
    // 多语言结构:取第一个含 content 的语言块
    doc =
      doc.zh_cn ??
      doc.en_us ??
      doc.ja_jp ??
      Object.values(doc).find((v) => v && Array.isArray(v.content)) ??
      {};
  }
  if (doc.title) parts.push(String(doc.title));
  const paragraphs = Array.isArray(doc.content) ? doc.content : [];
  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue;
    const line = [];
    for (const el of paragraph) {
      if (!el || typeof el !== 'object') continue;
      // 内嵌图片:富文本里图片元素的 tag 是 img(不是 image)
      if (el.tag === 'img' || el.tag === 'image') {
        if (el.image_key) imageKeys.push(el.image_key);
        continue;
      }
      if (el.tag === 'at') {
        line.push(`@${el.user_name || el.user_id || ''}`);
        continue;
      }
      if (typeof el.text === 'string' && el.text) line.push(el.text);
    }
    if (line.length) parts.push(line.join(''));
  }
  return { text: parts.join('\n'), imageKeys };
}

/**
 * 解析 im.message.receive_v1 事件负载。
 * 支持 text / image / post("图+文"一起发在飞书里通常是 post,而非 image)。
 * @param {object} data SDK 派发的事件数据(含 sender / message)
 */
export function parseReceiveEvent(data) {
  const sender = data.sender ?? {};
  const message = data.message ?? {};
  let text = '';
  const imageKeys = [];

  let content = null;
  if (typeof message.content === 'string' && message.content) {
    try {
      content = JSON.parse(message.content);
    } catch {
      content = null; // 非 JSON 内容(如加密/异常负载)按空处理,不抛错
    }
  }

  const messageType = message.message_type ?? '';
  if (content && messageType === 'text') {
    text = content.text ?? '';
  } else if (content && messageType === 'image') {
    // 纯图片消息:content = {"image_key":"img_v3_..."}
    if (content.image_key) imageKeys.push(content.image_key);
  } else if (content && messageType === 'post') {
    const extracted = extractPostContent(content);
    text = extracted.text;
    imageKeys.push(...extracted.imageKeys);
  }

  return {
    senderType: sender.sender_type, // user | app | bot
    senderId: sender.sender_id?.open_id ?? '',
    chatId: message.chat_id ?? '',
    chatType: message.chat_type ?? '', // p2p | group
    messageId: message.message_id ?? '',
    messageType,
    text,
    imageKeys,
    mentions: message.mentions ?? [],
  };
}

/** 是否应回复:回复用户的文本或图片消息;不回复机器人自己的消息。 */
export function shouldReply(parsed) {
  if (parsed.senderType === 'app') return false;
  if (parsed.text) return true;
  // 图片消息(text 为空)也必须放行,否则会静默丢弃(历史 bug)
  return Array.isArray(parsed.imageKeys) && parsed.imageKeys.length > 0;
}

/** 以应用身份向群/单聊回复文本。 */
export async function replyText({ appId, appSecret, chatId, text }) {
  return sendAppMessage({
    appId,
    appSecret,
    receiveId: chatId,
    receiveIdType: 'chat_id',
    msgType: 'text',
    content: JSON.stringify({ text }),
  });
}

/**
 * 把一条消息里携带的图片逐张下载到本地。
 * 设计:单张失败**不中断**(只记日志并计数),避免一张图读失败导致整条消息无响应。
 * @param {object} opts
 * @param {string} opts.appId
 * @param {string} opts.appSecret
 * @param {string} opts.messageId 消息 id(下载资源必须绑定具体消息)
 * @param {string[]} opts.imageKeys 消息内容里的 image_key 列表
 * @param {string} opts.dir 本地保存目录
 * @param {object} [opts.logger]
 * @param {number} [opts.maxBytes] 单张体积上限
 * @returns {Promise<{paths: string[], failed: number}>}
 */
export async function materializeIncomingImages({
  appId,
  appSecret,
  messageId,
  imageKeys = [],
  dir,
  logger = console,
  maxBytes,
}) {
  const paths = [];
  let failed = 0;
  for (let i = 0; i < imageKeys.length; i++) {
    try {
      const saved = await saveMessageImage({
        appId,
        appSecret,
        messageId,
        imageKey: imageKeys[i],
        dir,
        // 用消息 id + 序号做文件名:同一条消息多张图不互相覆盖,且可回溯
        basename: messageId ? `${messageId}-${i + 1}` : undefined,
        maxBytes,
      });
      paths.push(saved.filePath);
      logger.log(`🖼️ 已下载图片 ${i + 1}/${imageKeys.length} → ${saved.filePath}(${saved.bytes} 字节)`);
    } catch (err) {
      failed += 1;
      logger.error(`⚠️ 图片下载失败(第 ${i + 1}/${imageKeys.length} 张,${imageKeys[i]}):${err.message}`);
    }
  }
  return { paths, failed };
}

/** 超时回执默认阈值:任务在这段时间内跑完 → 全程静默(不再每条消息都回"收到") */
export const DEFAULT_SLOW_NOTICE_THRESHOLD_MS = 150_000;
/** 超时回执默认文案;`{seconds}` 会替换成已耗时秒数 */
export const DEFAULT_SLOW_NOTICE_TEXT = '⏳ 任务还在处理中(已 {seconds} 秒),完成后我会把结果发给你。';

/**
 * 「超时才回执」计时器(替代原来的"立即回执"):
 *   收到消息后**什么都不发**;只有任务超过 thresholdMs 仍未结束,才回一条提示(默认 150s)。
 *   任务在阈值内跑完 → 调用 cancel() 取消定时器,用户只会看到最终结果,不会看到"收到"。
 * 注意:定时器 unref(),不阻止进程退出;同 chat 任务由 createChatSerializer 串行,互不重叠。
 * @param {object} opts
 * @param {string} opts.appId
 * @param {string} opts.appSecret
 * @param {string} opts.chatId 目标对话框
 * @param {number} [opts.thresholdMs=150000] 超过多久未完成才回执
 * @param {number} [opts.intervalMs=0] >0 时按该间隔重复提醒;0=只提醒一次
 * @param {string} [opts.message] 提示文案(支持 {seconds} 占位)
 * @param {object} [opts.logger]
 * @returns {{ cancel: () => void, fired: () => boolean }}
 */
export function createSlowTaskNotifier({
  appId,
  appSecret,
  chatId,
  logger = console,
  thresholdMs = DEFAULT_SLOW_NOTICE_THRESHOLD_MS,
  intervalMs = 0,
  message = DEFAULT_SLOW_NOTICE_TEXT,
}) {
  const startedAt = Date.now();
  let timer = null;
  let cancelled = false;
  let notified = false;

  async function notify() {
    if (cancelled) return;
    notified = true;
    const seconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    const text = String(message).replace('{seconds}', String(seconds));
    await replyText({ appId, appSecret, chatId, text }).catch((err) =>
      logger.error('❌ 超时提示发送失败:', err.message)
    );
    if (!cancelled && intervalMs > 0) {
      timer = setTimeout(notify, intervalMs);
      timer.unref?.();
    }
  }

  if (Number.isFinite(thresholdMs) && thresholdMs >= 0) {
    timer = setTimeout(notify, thresholdMs);
    timer.unref?.();
  }

  return {
    cancel() {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
    fired: () => notified,
  };
}

// ==================== 长连接启动 ====================

/**
 * 启动飞书长连接接收机器人。
 * @param {object} opts
 * @param {string} opts.appId
 * @param {string} opts.appSecret
 * @param {'echo'|'dsh'} [opts.mode] 回复模式:echo=回显 | dsh=交给本机 DSH 智能体
 * @param {object} [opts.dsh] dsh 模式配置 { cmd, timeoutMs }
 * @param {object} [opts.approval] 审批通道配置 { enabled=true }
 * @param {object} [opts.images] 接收图片配置 { dir=工作区/.feishu-images, maxBytes=20MB }

 * @param {object} [opts.logger]
 * @returns {{ close: () => void }} 停止句柄
 */
export async function startReceiveBot({
  appId,
  appSecret,
  mode = 'echo',
  dsh = {},
  approval = {},
  // 接收图片:落盘目录(默认工作区内 .feishu-images)与单张体积上限
  images = {},
  // 复杂任务「超时才回执」开关:收到消息先不回执;超过 thresholdMs(缺省 150s)仍在跑才回一条提示。
  // 缺省 enabled=true / thresholdMs=150000 / intervalMs=0(只提醒一次)。
  status = {},
  // env:读取 .env 配置(如 FEISHU_DSH_ASYNC_TIMEOUT_MS,控制异步路径超时上限)
  env = {},
  logger = console,
}) {
  if (!appId || !appSecret) {
    throw new Error('缺少 appId / appSecret');
  }

  // 卡片式审批通道(自决/机器人自决,非群投票)。决策经飞书交互卡片呈现,receive.js 内 reply 文本路由走 cardHandleDecision(chatId,text)。(不注入 HTTP bridge。)

  /** 生成回复文本(parsed:已解析消息;imagePaths:已下载到本机的图片路径) */
  async function makeReply(parsed, imagePaths = []) {
    if (mode === 'echo') {
      const imagesNote = imagePaths.length ? ` [${imagePaths.length} 张图片]` : '';
      return `收到:${parsed.text}${imagesNote}(echo 模式)`;
    }
    if (mode === 'dsh') {
      const task = buildTask({ userText: parsed.text, imagePaths });
      // 同一飞书对话框 → 同一 DSH 会话(持久化,对话连续)
      // 关键修复:异步路径不限时(或给足时间),避免"超过180s即被 kill/取消"。
      // timeoutMs=null/Infinity=不限时;FEISHU_DSH_ASYNC_TIMEOUT_MS 可设上限(秒)。
      const asyncTimeoutMs = env?.FEISHU_DSH_ASYNC_TIMEOUT_MS
        ? Number(env.FEISHU_DSH_ASYNC_TIMEOUT_MS) * 1000
        : Infinity; // 默认不限时,超长任务跑完不被 kill
      return askDsh({ dshCmd: dsh.cmd, task, sessionId: sessionIdForChat(parsed.chatId), timeoutMs: asyncTimeoutMs });
    }
    throw new Error(`未知回复模式:${mode}(可选 echo / dsh)`);
  }

  // 每 chat 串行:同一对话框同时只处理一条消息(防止并发写坏同一 DSH 会话日志)
  const enqueue = createChatSerializer();
  // 任务状态队列(内存):记录每个 chat 异步任务状态,支持轮询/查询;可替换为 Redis
  const taskStatus = createTaskStatusStore();
  // 接收图片的落盘目录(缺省工作区内 .feishu-images)
  const imageDir = images.dir || DEFAULT_IMAGE_DIR;

  const wsClient = new Lark.WSClient({ appId, appSecret, loggerLevel: Lark.LoggerLevel.info });
  const dispatcher = new Lark.EventDispatcher({}).register({
    'im.message.receive_v1': async (data) => {
      const parsed = parseReceiveEvent(data);
      const imageNote = parsed.imageKeys.length ? ` [+${parsed.imageKeys.length} 张图]` : '';
      logger.log(
        `📩 [${parsed.chatType === 'p2p' ? '单聊' : '群聊'}] 来自 ${parsed.senderId} (${parsed.messageType})${imageNote}:${parsed.text}`
      );
      if (!shouldReply(parsed)) return;

      // 卡片审批决策优先(自决/机器人自决,非群投票):命中则回传 outcome 并直接返回;null=未命中/继续正常回复
      if (parsed.text && cardHandleDecision) {
        const verdict = cardHandleDecision(parsed.chatId, parsed.text);
        if (verdict) {
          const confirm =
            verdict === 'allowed-once'
              ? '✅ 已同意,该操作已放行。'
              : '🚫 已拒绝,该操作未执行。';
          await replyText({ appId, appSecret, chatId: parsed.chatId, text: confirm }).catch((err) =>
            logger.error('❌ 审批结果回执发送失败:', err.message)
          );
          return;
        }
      }

      // 异步回复:事件处理需在 3 秒内返回,DSH 调用可能更久,故不 await;
      // 同 chat 消息按到达顺序排队执行,后到消息不会与前一条并发。
      enqueue(parsed.chatId, async () => {
        // 超时才回执:默认不再每条消息都回"收到";只有超过阈值(缺省 150s)仍未跑完才回一条提示。
        // 任务提前结束 → cancel(),用户只会看到最终结果。
        const slowNotice =
          mode === 'dsh' && status.enabled !== false
            ? createSlowTaskNotifier({
                appId,
                appSecret,
                chatId: parsed.chatId,
                logger,
                thresholdMs: Number.isFinite(status.thresholdMs)
                  ? status.thresholdMs
                  : DEFAULT_SLOW_NOTICE_THRESHOLD_MS,
                intervalMs: Number.isFinite(status.intervalMs) ? status.intervalMs : 0,
                message: status.message || DEFAULT_SLOW_NOTICE_TEXT,
              })
            : null;
        try {
          if (mode === 'dsh') taskStatus.set(parsed.chatId, { status: 'running' });
          // 图片落到本地:智能体用 read_image 读文件,而不是把字节塞进任务文本
          const { paths: imagePaths, failed } = await materializeIncomingImages({
            appId,
            appSecret,
            messageId: parsed.messageId,
            imageKeys: parsed.imageKeys,
            dir: imageDir,
            logger,
            maxBytes: images.maxBytes,
          });

          // 关键:带了图却一张都没下下来(通常是缺 im:resource 权限)。
          // 此时把消息交给智能体只会得到"我看不到图"的困惑回答,不如直接给出可操作的原因。
          if (parsed.imageKeys.length && imagePaths.length === 0) {
            taskStatus.set(parsed.chatId, { status: 'failed' });
            await replyText({
              appId,
              appSecret,
              chatId: parsed.chatId,
              text:
                `⚠️ 收到你的图片,但下载失败了(${parsed.imageKeys.length} 张全部失败)。\n` +
                '最常见原因:应用未开通「获取与上传图片或文件资源」(im:resource)权限。\n' +
                '请在飞书开发者后台开通该权限后「创建版本 -> 发布」,再重发一次。',
            }).catch((err) => logger.error('❌ 图片失败提示发送失败:', err.message));
            return;
          }
          if (failed) logger.log(`（本次 ${failed} 张图片下载失败,已用成功的 ${imagePaths.length} 张继续）`);

          const reply = await makeReply(parsed, imagePaths);
          taskStatus.set(parsed.chatId, { status: 'completed', result: reply });
          await replyText({ appId, appSecret, chatId: parsed.chatId, text: reply });
          logger.log(`↩️ 已回复(${mode}):`, reply);
        } catch (err) {
          taskStatus.set(parsed.chatId, { status: 'failed' });
          // 长任务失败时主动告知,避免用户"断联"体感
          await replyText({ appId, appSecret, chatId: parsed.chatId, text: `⚠️ 任务处理遇到问题:${err.message}。稍后可重试。` }).catch(() => {});

          logger.error(`❌ 回复失败(${mode}):`, err.message);
        } finally {
          // 任务结束(成功/失败都算)→ 撤掉超时提示定时器,保证"跑完就不再啰嗦"
          slowNotice?.cancel();
        }
      });
    },
  });

  const p = wsClient.start({ eventDispatcher: dispatcher });
  if (p && typeof p.catch === 'function') p.catch((err) => logger.error('❌ 长连接启动失败:', err));

  logger.log(`🤖 飞书接收机器人已启动(模式=${mode})`);

  return {
    close() {
      try {
        wsClient.close?.();
      } catch {
        /* 忽略关闭异常 */
      }
    },
  };
}
