// plugins/feishu/index.js
// 飞书连接插件
//   服务(供其他插件调用):feishu.sendText / feishu.sendCard / feishu.webhook
//   能力:长连接接收机器人(echo/LLM 回复,随运行时 start 启动)
//   命令:send(发消息,等价于 npm run send)

import manifest from './manifest.json' with { type: 'json' };
import { makeClient } from './webhook.js';
import { sendAppMessage, makeAppClient, uploadImage as uploadImageFn, sendAppImage } from './app-api.js';
import { startReceiveBot } from './receive.js';
// 卡片式审批通道:经飞书交互卡片呈现操作授权(沙箱/提权等),自决/机器人自决。
import { askApproval as rawAskApproval } from './card-approval.js';

export default {
  ...manifest,
  deps: [],

  /** 注册 feishu 服务(发送能力)供其他插件使用 */
  install(ctx) {
    const env = ctx.env;
    ctx.registerService('feishu', {
      /** 应用模式发文本(receiveId 缺省用 FEISHU_CHAT_ID) */
      sendText: (text, { receiveId, receiveIdType = 'chat_id' } = {}) =>
        sendAppMessage({
          appId: env.FEISHU_APP_ID,
          appSecret: env.FEISHU_APP_SECRET,
          receiveId: receiveId ?? env.FEISHU_CHAT_ID,
          receiveIdType,
          msgType: 'text',
          content: JSON.stringify({ text }),
        }),
      /** 应用模式发卡片 */
      sendCard: (card, { receiveId, receiveIdType = 'chat_id' } = {}) =>
        sendAppMessage({
          appId: env.FEISHU_APP_ID,
          appSecret: env.FEISHU_APP_SECRET,
          receiveId: receiveId ?? env.FEISHU_CHAT_ID,
          receiveIdType,
          msgType: 'interactive',
          content: JSON.stringify(card),
        }),
      /** Webhook 模式客户端(备用) */
      webhook: makeClient({ webhookUrl: env.FEISHU_WEBHOOK_URL, secret: env.FEISHU_WEBHOOK_SECRET || undefined }),
      /** 图片传输:发一张图片到目标群。内部先上传拿 image_key(缺省 imageKey 时),再发送(app 模式) */
      sendImage: (filePath, { receiveId, imageKey } = {}) =>
        sendAppImage({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, receiveId }, { filePath, imageKey }, env),
      /** 上传图片获取 image_key(供其它渠道发送);返回 {image, image_key} */
      uploadImage: (filePath) =>
        uploadImageFn({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, filePath }),
      /** 发起一次操作授权审批(沙箱/提权等):经飞书交互卡片呈现,receive.js 路由决策;超时 fail-closed */
      askApproval: (request, { targetChatId = env.FEISHU_CHAT_ID, receiveIdType = 'chat_id' } = {}) =>
        rawAskApproval({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, targetChatId, request, receiveIdType }),
    });
  },

  /** 启动长连接接收机器人 */
  async start(ctx) {
    const env = ctx.env;
    if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) {
      ctx.logger.log('[feishu] 未配置 FEISHU_APP_ID / FEISHU_APP_SECRET,跳过接收机器人(仅保留发送能力)');
      return;
    }
    this.receiveHandle = await startReceiveBot({
      appId: env.FEISHU_APP_ID,
      appSecret: env.FEISHU_APP_SECRET,
      mode: env.FEISHU_BOT_MODE || 'echo',
      dsh: {
        cmd: env.FEISHU_DSH_CMD || 'dsh',
        timeoutMs: Number(env.FEISHU_DSH_TIMEOUT_MS) || 120_000,
      },
      approval: {
        enabled: true,
        // 审批等待上限(秒),缺省 100s
        askTimeoutMs: env.FEISHU_APPROVAL_TIMEOUT_MS ? Number(env.FEISHU_APPROVAL_TIMEOUT_MS) * 1000 : undefined,
      },
      // 接收图片:落盘目录与单张体积上限(缺省 工作区/.feishu-images 与 20MB)
      images: {
        dir: env.FEISHU_IMAGE_DIR || undefined,
        maxBytes: env.FEISHU_IMAGE_MAX_BYTES ? Number(env.FEISHU_IMAGE_MAX_BYTES) : undefined,
      },
      // 「超时才回执」:收到消息先不回任何东西;超过阈值(缺省 150s)仍在跑才回一条提示。
      // FEISHU_STATUS_ENABLED=false 可彻底关闭提示;FEISHU_STATUS_INTERVAL_MS>0 可按间隔重复提醒。
      status: {
        enabled: env.FEISHU_STATUS_ENABLED ? env.FEISHU_STATUS_ENABLED !== 'false' : true,
        ...(env.FEISHU_STATUS_THRESHOLD_MS ? { thresholdMs: Number(env.FEISHU_STATUS_THRESHOLD_MS) } : {}),
        ...(env.FEISHU_STATUS_INTERVAL_MS ? { intervalMs: Number(env.FEISHU_STATUS_INTERVAL_MS) } : {}),
        ...(env.FEISHU_STATUS_MESSAGE ? { message: env.FEISHU_STATUS_MESSAGE } : {}),
      },
      // env:把 .env 配置传给接收机器人(用于异步路径超时上限等)
      env: { FEISHU_DSH_ASYNC_TIMEOUT_MS: env.FEISHU_DSH_ASYNC_TIMEOUT_MS },
      logger: ctx.logger,
    });
  },

  /** 停止接收机器人 */
  async stop() {
    this.receiveHandle?.close?.();
  },

  /** CLI 命令:send(发文本/富文本/卡片,@,应用或 Webhook 模式) */
  commands: {
    send: async (runtime, args) => {
      const env = runtime.env;
      const parsed = {};
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--text') parsed.text = args[++i];
        else if (a === '--post') parsed.post = args[++i];
        else if (a === '--card') parsed.card = true;
        else if (a === '--at') parsed.at = args[++i];
        else if (a === '--app') parsed.app = true;
        else if (a === '--chat') parsed.chat = args[++i];
        else if (a === '--image') parsed.image = args[++i]; // 图片文件路径(app/webhook 模式)
      }

      const text = parsed.text
        ? parsed.at === 'all'
          ? `<at user_id="all">所有人</at> ${parsed.text}`
          : parsed.at
            ? `<at user_id="${parsed.at}"></at> ${parsed.text}`
            : parsed.text
        : null;

      if (parsed.app) {
        const app = makeAppClient({
          appId: env.FEISHU_APP_ID,
          appSecret: env.FEISHU_APP_SECRET,
          receiveId: parsed.chat ?? env.FEISHU_CHAT_ID,
        });
        let result;
        if (text) result = await app.sendText(text);
        else if (parsed.post) {
          const [title, ...lines] = parsed.post.split('\n').map((l) => l.trim());
          result = await app.sendCard({
            header: { title: { tag: 'plain_text', content: title } },
            elements: lines.map((line) => ({ tag: 'div', text: { tag: 'lark_md', content: line } })),
          });
        } else if (parsed.card) {
          result = await app.sendCard({
            config: { wide_screen_mode: true },
            header: { template: 'blue', title: { tag: 'plain_text', content: '示例卡片' } },
            elements: [
              { tag: 'div', text: { tag: 'lark_md', content: '**这是一张演示卡片**\n来自 dsh-feishu(应用模式)' } },
              { tag: 'hr' },
              { tag: 'note', elements: [{ tag: 'plain_text', content: '发送时间 ' + new Date().toLocaleString('zh-CN') }] },
            ],
          });
        } else if (parsed.image) {
          // 图片传输:传 filePath(自动上传拿 image_key)或 imageKey;app 模式一步到位
          const data = await app.sendImage(parsed.image);
          console.log('✅ 图片发送成功:', JSON.stringify(data));
        }
        console.log('✅ 发送成功:', JSON.stringify(result));
        return;
      }

      const client = makeClient({ webhookUrl: env.FEISHU_WEBHOOK_URL, secret: env.FEISHU_WEBHOOK_SECRET || undefined });
      let result;
      if (text) result = await client.sendText(text);
      else if (parsed.post) {
        const [title, ...lines] = parsed.post.split('\n').map((l) => l.trim());
        result = await client.sendPost({
          title,
          content: lines.map((line) => [{ tag: 'text', text: line }]),
        });
      } else if (parsed.card) {
        result = await client.sendCard({
          config: { wide_screen_mode: true },
          header: { template: 'blue', title: { tag: 'plain_text', content: '示例卡片' } },
          elements: [
            { tag: 'div', text: { tag: 'lark_md', content: '**这是一张演示卡片**\n来自 dsh-feishu' } },
            { tag: 'hr' },
            { tag: 'note', elements: [{ tag: 'plain_text', content: '发送时间 ' + new Date().toLocaleString('zh-CN') }] },
          ],
        });
      } else if (parsed.image) {
        // webhook 图片:先经自建应用 token 上传拿 image_key,再走 webhook payload(自定义机器人发图片需先获取 image_key)
        const uploaded = await uploadImageFn({ appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, filePath: parsed.image });
        result = await client.send({ payload: { msg_type: 'image', content: { image_key: uploaded.image_key } } });
      }
      console.log('✅ 发送成功:', JSON.stringify(result));
    },
  },
};
