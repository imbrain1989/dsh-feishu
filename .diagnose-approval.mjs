// .diagnose-approval.mjs
// 端到端自检:headless 审批应答插件(@local/dsh-feishu-approval) ↔ 飞书审批桥 ↔ 群成员决定。
// 不碰真实飞书:桥的发送函数用 stub 并模拟群成员回复(同意/拒绝)。
// 运行:node --env-file-if-exists=.env .diagnose-approval.mjs
import { startApprovalBridge, normalizeDecision } from './plugins/feishu/approval-bridge.js';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 审批应答插件装在 DSH_HOME 的 profiles 下(不在本仓库内),可用环境变量覆盖路径
const approvalPluginPath =
  process.env.FEISHU_APPROVAL_PLUGIN_PATH ||
  join(homedir(), '.dsh', 'profiles', 'node_modules', '@local', 'dsh-feishu-approval', 'lib', 'index.js');
const { apply: applyApprovalPlugin, Config: ApprovalConfig } = await import(pathToFileURL(approvalPluginPath).href);

process.env.DSH_APPROVAL_BRIDGE_URL ??= '';

const results = [];
function check(name, cond, extra = '') {
  results.push({ name, ok: !!cond, extra });
  console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
}

// 启动桥;sendText 可模拟群成员自动回复
const sent = [];
let hub;
const sendText = async ({ chatId, text }) => {
  sent.push({ chatId, text });
  if (sendText.autoDecide) hub.handleDecision(chatId, sendText.autoDecide);
};
hub = await startApprovalBridge({ sendText, askTimeoutMs: 3000, logger: { log() {}, error() {} } });
process.env.DSH_APPROVAL_BRIDGE_URL = hub.url;

// 挂载插件(模拟 cordis ctx)
let handler = null;
const ctx = {
  get: () => ({}), // 'approval' 服务存在
  on: (_event, fn) => {
    handler = fn;
  },
};
applyApprovalPlugin(ctx, ApprovalConfig({ bridgeUrlEnv: 'DSH_APPROVAL_BRIDGE_URL', askTimeoutMs: 3000 }));
check('插件已注册 approval/request 应答', typeof handler === 'function');

function fakeReq(sessionId, { toolName = 'pwsh', reason = '需要更高权限', signal } = {}) {
  return {
    agent: { session: { id: sessionId } },
    toolName,
    reason,
    signal,
  };
}
const noNext = () => Promise.resolve('unavailable');

// 场景A:群成员回复「同意」→ allowed-once
sendText.autoDecide = '同意';
const a = await handler(fakeReq('feishu-oc_e2e_a'), noNext);
check('同意 → allowed-once', a === 'allowed-once', `outcome=${a}`);
check('群里收到审批询问(含操作名)', sent.some((s) => s.chatId === 'oc_e2e_a' && s.text.includes('pwsh') && s.text.includes('需要更高权限')));

// 场景B:回复「拒绝」→ rejected
sendText.autoDecide = '拒绝';
const b = await handler(fakeReq('feishu-oc_e2e_b'), noNext);
check('拒绝 → rejected', b === 'rejected', `outcome=${b}`);

// 场景C:非 feishu 会话 → 交给 next()(不处理)
sendText.autoDecide = null;
let nextCalled = false;
const c = await handler(fakeReq('session-00e2e', { toolName: 'fs' }), () => {
  nextCalled = true;
  return Promise.resolve('unavailable');
});
check('非 feishu 会话走 next()', nextCalled && c === 'unavailable');

// 场景D:无人回复且请求中断(abort)→ cancelled
sendText.autoDecide = null;
const abort = new AbortController();
const d = handler(fakeReq('feishu-oc_e2e_d', { signal: abort.signal }), noNext);
setTimeout(() => abort.abort(), 200);
const dOutcome = await d;
check('中断 → cancelled', dOutcome === 'cancelled', `outcome=${dOutcome}`);

// 场景E:桥不存在 → unavailable(fail closed)
delete process.env.DSH_APPROVAL_BRIDGE_URL;
sendText.autoDecide = null;
const e = await handler(fakeReq('feishu-oc_e2e_e'), noNext);
check('无桥 → next() 维持 fail-closed', e === 'unavailable', `outcome=${e}`);
process.env.DSH_APPROVAL_BRIDGE_URL = hub.url;

hub.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? '✔ 审批链路端到端自检全部通过' : `✘ ${failed.length} 项失败`}`);
process.exit(failed.length === 0 ? 0 : 1);
