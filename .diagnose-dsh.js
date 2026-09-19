// 临时诊断:直接跑一次 askDsh(dsh 模式),看是否能正常产出回复
import { askDsh } from './plugins/feishu/dsh.js';

const chatId = process.env.FEISHU_CHAT_ID || 'oc_0123456789abcdef0123456789abcdef';
console.log('=== 调用 dsh headless(测试) ===');
try {
  const reply = await askDsh({
    dshCmd: process.env.FEISHU_DSH_CMD || 'dsh',
    task: '请用一句话中文回复用户:"你好"',
    sessionId: `feishu-${chatId}`,
    timeoutMs: 120_000,
  });
  console.log('✅ DSH 返回:', JSON.stringify(reply).slice(0, 500));
} catch (e) {
  console.log('❌ DSH 失败:', e.message);
}
