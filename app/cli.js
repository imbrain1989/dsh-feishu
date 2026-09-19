// app/cli.js
// 命令行入口:按插件注册的 commands 分发。
// 用法:
//   npm run send -- --text "你好"        → node app/cli.js send --text 你好
//   npm run send -- --app --text "x"      → node app/cli.js send --app --text x
//   node app/cli.js help                  → 列出所有插件命令
//
// 本机自用插件(可选):存在 app/local-plugins.js 时一并注册,其命令也会出现在 help 里。

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../core/index.js';
import feishuPlugin from '../plugins/feishu/index.js';

const LOCAL_PLUGINS_FILE = fileURLToPath(new URL('./local-plugins.js', import.meta.url));

const runtime = createRuntime();
runtime.use(feishuPlugin);

// 本机自用插件(不上传仓库;文件不存在则跳过)
if (existsSync(LOCAL_PLUGINS_FILE)) {
  const mod = await import('./local-plugins.js');
  if (!Array.isArray(mod.default)) {
    console.error('❌ app/local-plugins.js 必须默认导出插件数组,例如: export default [myPlugin]');
    process.exit(1);
  }
  for (const plugin of mod.default) runtime.use(plugin);
}

const [cmd, ...args] = process.argv.slice(2);

function printHelp() {
  console.log('dsh-feishu 插件命令:\n');
  for (const p of runtime.list()) {
    if (p.commands.length) console.log(`  [${p.name}] ${p.commands.join(', ')}`);
  }
  console.log('\n用法:npm run <命令> -- <参数>(详见 README)');
}

if (!cmd || ['help', '--help', '-h'].includes(cmd)) {
  printHelp();
  process.exit(cmd ? 0 : 1);
}

for (const plugin of runtime.plugins.values()) {
  const fn = plugin.commands?.[cmd];
  if (fn) {
    try {
      await fn(runtime, args);
    } catch (err) {
      console.error('❌ 执行失败:', err.message);
      process.exit(1);
    }
    process.exit(0);
  }
}

console.error(`未知命令:${cmd}`);
printHelp();
process.exit(1);
