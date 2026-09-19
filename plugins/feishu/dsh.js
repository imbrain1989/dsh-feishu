// plugins/feishu/dsh.js
// DSH(DeepSeek Harness)连接:把飞书消息交给本机 DSH headless profile 的完整智能体处理,
// 而不是直接调用 LLM API。
//
// 原理:spawn `dsh --profile headless "<task>"`,DSH 会启动一个完整智能体
// (与 Web GUI 相同的模型/工具/指令栈)处理任务,并把最终回答打印到 stdout。
//
// 前置:本机已初始化 headless profile(见 README),且 dsh 可执行文件可被调用。

import { spawn } from 'node:child_process';

// ==================== 会话连续性 ====================

/**
 * 由飞书 chat_id 派生稳定的 DSH 会话 id:同一对话框始终对应同一 DSH 会话,
 * 配合 headless 的 resume 机制实现真正的对话连续性(而不是每句一个全新会话)。
 */
export function sessionIdForChat(chatId) {
  const safe = String(chatId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
  return `feishu-${safe}`;
}

/**
 * 组装发给 headless 智能体的任务文本。
 * 说明:headless 本身已带 DSH 系统提示与工具;会话历史由 DSH 持久化会话提供,这里只带最新消息。
 * 图片:飞书图片会先下载到本机,这里只传**本地路径**,让智能体用 read_image 工具读——
 *      headless 的任务入口是纯文本,走路径无需改动任何协议。
 * @param {object} opts
 * @param {string} [opts.userText] 用户文字(纯图片消息时为空)
 * @param {string[]} [opts.imagePaths] 已下载到本机的图片路径
 * @param {string} [opts.persona] 角色设定
 */
export function buildTask({ userText, imagePaths = [], persona = '你是部署在飞书群里的助手,请用中文简洁友好地回答。' } = {}) {
  const paths = Array.isArray(imagePaths) ? imagePaths.filter(Boolean) : [];
  const blocks = [persona];

  if (paths.length) {
    blocks.push(
      [
        `用户发来 ${paths.length} 张图片,已保存到本机:`,
        ...paths.map((p, i) => `- 第 ${i + 1} 张:${p}`),
        '请先用 read_image 工具查看这些图片,再结合用户文字作答。',
      ].join('\n')
    );
  }

  const hasText = typeof userText === 'string' && userText.trim() !== '';
  blocks.push(`用户最新消息:\n${hasText ? userText : '(未附文字,只有图片)'}`);

  return blocks.join('\n\n');
}

// ==================== 命令行调用 ====================

/**
 * 解析 dsh 调用方式(Windows 下 .cmd/.bat 无法被 Node 直接 spawn,需特殊处理):
 *  - .js 入口  → node <入口> --profile headless <task>(推荐,argv 传参无引号问题)
 *  - .cmd/.bat → 交给 shell 执行(尽力而为)
 *  - 其他      → 直接 spawn(要求是真正的可执行文件,或已入 PATH 的 .exe)
 */
export function resolveInvocation(dshCmd, task) {
  const rest = ['--profile', 'headless', task];
  if (/\.js$/i.test(dshCmd)) {
    return { cmd: 'node', args: [dshCmd, ...rest], shell: false };
  }
  if (/\.(cmd|bat)$/i.test(dshCmd)) {
    return { cmd: dshCmd, args: rest, shell: true };
  }
  return { cmd: dshCmd, args: rest, shell: false };
}

/**
 * 创建 DSH 调用器(可注入 spawnFn 便于测试)。
 * @param {object} opts { spawnFn }
 */
export function createDshRunner({ spawnFn = spawn } = {}) {
  /**
   * 调用 dsh headless 处理一条任务,返回智能体的最终回答文本。
   * @param {object} opts { dshCmd, task, sessionId, timeoutMs, cwd, extraEnv }
   */
  return function askDsh({ dshCmd = 'dsh', task, sessionId, timeoutMs = 3_600_000, cwd = process.cwd(), extraEnv } = {}) {
    // timeoutMs 为 null / Infinity 表示不限时:复杂任务可继续执行而不被 kill。
    const unlimited = timeoutMs == null || timeoutMs === Infinity;
    return new Promise((resolve, reject) => {
      const { cmd, args, shell } = resolveInvocation(dshCmd, task);
      let child;
      try {
        child = spawnFn(cmd, args, {
          cwd,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell,
          env: {
            ...process.env,
            ...(sessionId ? { DSH_AGENT_SESSION_ID: sessionId } : {}),
            ...extraEnv,
          },
        });
      } catch (err) {
        reject(new Error(`无法启动 DSH(${dshCmd}):${err.message}`));
        return;
      }

      let stdout = '';
      let stderr = '';
      const timer = unlimited ? null : setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* 已退出 */
        }
        reject(new Error(`DSH 处理超时(${timeoutMs}ms),请稍后重试`));
      }, timeoutMs);

      child.stdout?.on('data', (d) => {
        stdout += String(d);
      });
      child.stderr?.on('data', (d) => {
        stderr += String(d);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`DSH 进程错误:${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const out = stdout.trim();
        if (code !== 0 && !out) {
          reject(new Error(`DSH 失败(exit=${code}):${stderr.trim().slice(0, 500)}`));
        } else {
          resolve(out);
        }
      });
    });
  };
}

/** 便捷实例(生产用真实 spawn) */
export const askDsh = createDshRunner();
