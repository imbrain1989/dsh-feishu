// app/main.js
// 应用入口:npm run listen(或由 dsh web 的 feishu-launcher 自动拉起)
// 加载全部插件并启动(飞书长连接接收 + 股价定时播报),Ctrl+C 优雅停止。
//
// pid 文件:启动时写入(默认 C:\dsh\.feishu-listener.pid,可用 FEISHU_PID_FILE 覆盖),
// 退出时删除 —— 供 dsh web 的 launcher 检测重复实例(已在运行则不重复拉起)。

import { writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../core/index.js';
import feishuPlugin from '../plugins/feishu/index.js';
import stockPlugin from '../plugins/stock-broadcast/index.js';

// pid 文件默认落在仓库根(克隆到任意目录都能正确工作),可用 FEISHU_PID_FILE 覆盖
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // app/ -> 仓库根
const PID_FILE = process.env.FEISHU_PID_FILE || join(REPO_ROOT, '.feishu-listener.pid');

function writePid() {
  try {
    writeFileSync(PID_FILE, String(process.pid), 'utf8');
  } catch {
    /* 忽略 */
  }
}

function removePid() {
  try {
    unlinkSync(PID_FILE);
  } catch {
    /* 忽略 */
  }
}

writePid();

const runtime = createRuntime();
runtime.use(feishuPlugin).use(stockPlugin);

try {
  await runtime.start();
  console.log('\n[dsh-feishu] 全部插件已启动:');
  for (const p of runtime.list()) {
    console.log(`  · ${p.name} v${p.version} — ${p.description ?? ''}`);
  }
  console.log(`\nCtrl+C 退出(pid=${process.pid})`);
} catch (err) {
  console.error('❌ 启动失败:', err.message);
  removePid();
  process.exit(1);
}

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[dsh-feishu] 收到 ${signal},正在停止...`);
  await runtime.stop();
  removePid();
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
