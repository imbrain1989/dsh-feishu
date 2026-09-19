// plugins/stock-broadcast/index.js
// 股价播报插件
//   依赖:feishu 插件(通过其服务发消息)
//   能力:工作日定时拉取行情推送(随运行时 start 启动)
//   命令:stock:now(立即拉取并可选推送,等价于 npm run stock:now)

import manifest from './manifest.json' with { type: 'json' };
import { getStockQuote, formatQuote } from './quote.js';
import { createStockScheduler, parseTimes } from './scheduler.js';

export default {
  ...manifest,
  deps: ['feishu'],

  async start(ctx) {
    const env = ctx.env;
    if ((env.FEISHU_STOCK_ENABLED ?? 'true') === 'false') {
      ctx.logger.log('[stock-broadcast] 已禁用(FEISHU_STOCK_ENABLED=false)');
      return;
    }
    const feishu = ctx.getService('feishu');
    const code = env.FEISHU_STOCK_CODE || '002432';
    const times = parseTimes(env.FEISHU_STOCK_TIMES || '09:35,10:30,11:30,13:00,14:00,15:00');
    const chatId = env.FEISHU_STOCK_CHAT_ID || env.FEISHU_CHAT_ID;

    this.scheduler = createStockScheduler({
      enabled: true,
      times,
      code,
      intervalMs: 20000,
      send: async (text) => {
        // 优先应用模式;未配置应用时退回 Webhook
        if (env.FEISHU_APP_ID && env.FEISHU_APP_SECRET) {
          return feishu.sendText(text, { receiveId: chatId });
        }
        return feishu.webhook.sendText(text);
      },
    });
    this.scheduler.start();
    ctx.logger.log(`📈 [stock-broadcast] 股价播报已开启:${code} @ ${times.join(', ')} (工作日,推送至 ${chatId})`);
  },

  async stop() {
    this.scheduler?.stop();
  },

  /** CLI 命令:stock:now [股票代码] [--send] */
  commands: {
    'stock:now': async (runtime, args) => {
      const env = runtime.env;
      const code = args.find((a) => /^\d{6}$/.test(a)) || env.FEISHU_STOCK_CODE || '002432';
      const doSend = args.includes('--send');

      const quote = await getStockQuote(code);
      const text = formatQuote(quote);
      console.log(text);

      if (doSend) {
        const chatId = env.FEISHU_STOCK_CHAT_ID || env.FEISHU_CHAT_ID;
        if (!chatId) throw new Error('缺少目标群 FEISHU_CHAT_ID');
        const { sendAppMessage } = await import('../feishu/app-api.js');
        await sendAppMessage({
          appId: env.FEISHU_APP_ID,
          appSecret: env.FEISHU_APP_SECRET,
          receiveId: chatId,
          receiveIdType: 'chat_id',
          msgType: 'text',
          content: JSON.stringify({ text }),
        });
        console.log('✅ 已推送到飞书群');
      } else {
        console.log('(加 --send 参数可推送到飞书群)');
      }
    },
  },
};
