// 临时诊断脚本:验证 token + 发送消息,打印完整响应体(成功/失败都打印)
import { getTenantAccessToken } from './plugins/feishu/app-api.js';

const appId = process.env.FEISHU_APP_ID;
const appSecret = process.env.FEISHU_APP_SECRET;
const chatId = process.env.FEISHU_CHAT_ID || 'oc_0123456789abcdef0123456789abcdef';

console.log('=== 1) 验证 tenant_access_token ===');
try {
  const token = await getTenantAccessToken({ appId, appSecret });
  console.log('✅ token 有效:', token.slice(0, 24), '...');
} catch (e) {
  console.log('❌ token 获取失败:', e.message);
  process.exit(0); // 到此为止,不发送
}

console.log('\n=== 2) 尝试以应用身份向 chat_id 发送测试消息 ===');
const res = await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${await getTenantAccessToken({ appId, appSecret })}`,
  },
  body: JSON.stringify({
    receive_id: chatId,
    msg_type: 'text',
    content: JSON.stringify({ text: '[DIAGNOSTIC TEST] dsh-feishu 发送链路自检' }),
  }),
});
const json = await res.json();
console.log('HTTP status:', res.status);
console.log('完整响应体:', JSON.stringify(json, null, 2));
