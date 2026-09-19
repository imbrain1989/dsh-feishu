// app/main.js
// 应用入口:npm run listen(或由 dsh web 的 feishu-launcher 自动拉起)
// 启动 feishu 插件(飞书长连接接收 + 发送能力),Ctrl+C 优雅停止。
//
// 本机自用插件(可选):若存在 app/local-plugins.js,则把它默认导出的插件数组一并加载。
// 该文件不在仓库里(已 gitignore),用于放置不上传 GitHub 的私有插件;文件缺失时静默跳过。
//
// pid 文件:启动时写入(默认 <仓库根>/.feishu-listener.pid,可用 FEISHU_PID_FILE 覆盖),
// 退出时删除 —— 供 dsh web 的 launcher 检测重复实例(已在运行则不重复拉起)。

import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../core/index.js';
import feishuPlugin from '../plugins/feishu/index.js';

// pid 文件默认落在仓库根(克隆到任意目录都能正确工作),可用 FEISHU_PID_FILE 覆盖
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url))); // app/ -> 仓库根
const PID_FILE = process.env.FEISHU_PID_FILE || join(REPO_ROOT, '.feishu-listener.pid');
// 本机自用插件入口(可选)
const LOCAL_PLUGINS_FILE = fileURLToPath(new URL('./local-plugins.js', import.meta.url));

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

/** 读取本机自用插件(文件不存在返回空数组;文件存在但加载失败则原样抛错,便于排查) */
async function loadLocalPlugins() {
  if (!existsSync(LOCAL_PLUGINS_FILE)) return [];
  const mod = await import('./local-plugins.js');
  if (!Array.isArray(mod.default)) {
    throw new Error('app/local-plugins.js 必须默认导出插件数组,例如: export default [myPlugin]');
  }
  return mod.default;
}

const runtime = createRuntime();
runtime.use(feishuPlugin);

const localPlugins = await loadLocalPlugins();
for (const plugin of localPlugins) {
  runtime.use(plugin);
}
if (localPlugins.length) {
  console.log(`[dsh-feishu] 已加载本机自用插件:${localPlugins.map((p) => p.name).join(', ')}(见 app/local-plugins.js)`);
}

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
