// test/dsh.test.js
// DSH 连接模块测试:会话 id 派生、任务组装、CLI 调用器(注入假 spawn)。

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

import { buildTask, sessionIdForChat, createDshRunner, resolveInvocation } from '../plugins/feishu/dsh.js';

// ---- 会话 id 派生 ----

test('sessionIdForChat:同一 chat_id 派生稳定 id,且安全化', () => {
  assert.equal(sessionIdForChat('oc_0123456789abcdef0123456789abcdef'), 'feishu-oc_0123456789abcdef0123456789abcdef');
  // 相同输入 → 相同输出(会话连续性的关键)
  assert.equal(sessionIdForChat('oc_abc'), sessionIdForChat('oc_abc'));
  // 非法字符被替换
  assert.equal(sessionIdForChat('a/b c'), 'feishu-a_b_c');
  // 不同 chat_id → 不同会话
  assert.notEqual(sessionIdForChat('oc_a'), sessionIdForChat('oc_b'));
});

// ---- 任务组装 ----

test('buildTask 只含角色设定与用户消息(历史由 DSH 持久化会话提供)', () => {
  const task = buildTask({ userText: '你好' });
  assert.ok(task.includes('用户最新消息:'));
  assert.ok(task.includes('你好'));
  assert.ok(!task.includes('对话历史'));
});

test('buildTask 纯文本输出与旧格式完全一致(不回归)', () => {
  // 旧实现:`${persona}\n\n用户最新消息:\n${userText}` —— 必须逐字节保持
  assert.equal(
    buildTask({ userText: '你好' }),
    '你是部署在飞书群里的助手,请用中文简洁友好地回答。\n\n用户最新消息:\n你好',
  );
});

test('buildTask 带图片时把本地路径交给智能体用 read_image 读', () => {
  const task = buildTask({
    userText: '这张图里是什么',
    imagePaths: ['C:\\dsh\\.feishu-images\\om_1-1.png', 'C:\\dsh\\.feishu-images\\om_1-2.jpg'],
  });
  assert.ok(task.includes('2 张图片'));
  assert.ok(task.includes('C:\\dsh\\.feishu-images\\om_1-1.png'));
  assert.ok(task.includes('C:\\dsh\\.feishu-images\\om_1-2.jpg'));
  assert.ok(task.includes('read_image'), '应指示智能体用 read_image 看图');
  assert.ok(task.includes('这张图里是什么'));
});

test('buildTask 纯图片消息(无文字)标注未附文字', () => {
  const task = buildTask({ userText: '', imagePaths: ['C:\\dsh\\.feishu-images\\om_2-1.png'] });
  assert.ok(task.includes('未附文字'));
  assert.ok(task.includes('om_2-1.png'));
  // 空白文字也应视为无文字
  assert.ok(buildTask({ userText: '   ', imagePaths: ['a.png'] }).includes('未附文字'));
});

test('buildTask 忽略空路径(不产生空条目)', () => {
  const task = buildTask({ userText: 'hi', imagePaths: ['', null, undefined, 'a.png'] });
  assert.ok(task.includes('1 张图片'));
  assert.ok(!task.includes('- 第 2 张'));
});

// ---- 调用方式解析 ----

test('resolveInvocation:JS 入口走 node,无 shell', () => {
  const inv = resolveInvocation('C:/dsh/dsh/lib/bin.js', '你好 "带引号"');
  assert.equal(inv.cmd, 'node');
  assert.deepEqual(inv.args, ['C:/dsh/dsh/lib/bin.js', '--profile', 'headless', '你好 "带引号"']);
  assert.equal(inv.shell, false);
});

test('resolveInvocation:.cmd 走 shell;普通命令直接 spawn', () => {
  const cmdInv = resolveInvocation('dsh.cmd', '任务');
  assert.equal(cmdInv.cmd, 'dsh.cmd');
  assert.equal(cmdInv.shell, true);
  const plain = resolveInvocation('/usr/bin/dsh', '任务');
  assert.equal(plain.shell, false);
  assert.deepEqual(plain.args, ['--profile', 'headless', '任务']);
});

// ---- CLI 调用器(注入假 spawn) ----

function fakeChild({ exitCode = 0, stdout = '', stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = Readable.from([stdout]);
  child.stderr = Readable.from([stderr]);
  child.kill = () => {};
  child.emitClose = (code = exitCode) => child.emit('close', code);
  return child;
}

test('askDsh 正常返回 stdout 中的最终回答', async () => {
  const calls = [];
  let child;
  const runner = createDshRunner({
    spawnFn: (cmd, args, opts) => {
      calls.push({ cmd, args, opts });
      child = fakeChild({ exitCode: 0, stdout: '这是DSH的回答\n' });
      return child;
    },
  });
  const p = runner({ dshCmd: 'dsh', task: '任务' });
  await new Promise((r) => setTimeout(r, 10)); // 等 stdout 数据流完
  child.emitClose(0);
  const answer = await p;
  assert.equal(answer, '这是DSH的回答');
  assert.equal(calls[0].cmd, 'dsh');
  assert.deepEqual(calls[0].args, ['--profile', 'headless', '任务']);
  assert.equal(calls[0].opts.shell, false);
  // 无 sessionId / extraEnv 时不注入 DSH_AGENT_SESSION_ID,但继承其余环境
  assert.ok(calls[0].opts.env && typeof calls[0].opts.env === 'object');
  assert.equal(calls[0].opts.env.DSH_AGENT_SESSION_ID, undefined, '无 sessionId 时不注入 DSH_AGENT_SESSION_ID');
});

test('askDsh 传入 sessionId 时注入 DSH_AGENT_SESSION_ID', async () => {
  let child;
  let captured;
  const runner = createDshRunner({
    spawnFn: (cmd, args, opts) => {
      captured = opts;
      child = fakeChild({ exitCode: 0, stdout: 'ok\n' });
      return child;
    },
  });
  const p = runner({ dshCmd: 'dsh', task: '任务', sessionId: 'feishu-oc_abc' });
  await new Promise((r) => setTimeout(r, 10));
  child.emitClose(0);
  await p;
  assert.equal(captured.env.DSH_AGENT_SESSION_ID, 'feishu-oc_abc');
  // 继承其余环境变量(spread 保留原环境)
  assert.ok(captured.env && typeof captured.env === 'object');
  assert.ok(Object.keys(captured.env).length > 1);
  const inheritedKey = Object.keys(process.env).find((k) => k !== 'DSH_AGENT_SESSION_ID');
  if (inheritedKey) assert.equal(captured.env[inheritedKey], process.env[inheritedKey]);
});

test('askDsh 传入 extraEnv 时注入额外环境变量', async () => {
  let child;
  let captured;
  const runner = createDshRunner({
    spawnFn: (cmd, args, opts) => {
      captured = opts;
      child = fakeChild({ exitCode: 0, stdout: 'ok\n' });
      return child;
    },
  });
  const p = runner({
    dshCmd: 'dsh',
    task: '任务',
    sessionId: 'feishu-oc_abc',
    extraEnv: { DSH_APPROVAL_BRIDGE_URL: 'http://127.0.0.1:4321' },
  });
  await new Promise((r) => setTimeout(r, 10));
  child.emitClose(0);
  await p;
  assert.equal(captured.env.DSH_APPROVAL_BRIDGE_URL, 'http://127.0.0.1:4321');
  assert.equal(captured.env.DSH_AGENT_SESSION_ID, 'feishu-oc_abc');
});

test('askDsh 非零退出且无输出时报错', async () => {
  let child;
  const runner = createDshRunner({
    spawnFn: () => {
      child = fakeChild({ exitCode: 1, stderr: 'boom' });
      return child;
    },
  });
  const p = runner({ dshCmd: 'dsh', task: 'x' });
  await new Promise((r) => setTimeout(r, 10));
  child.emitClose(1);
  await assert.rejects(() => p, /DSH 失败/);
});

test('askDsh 非零退出但有输出时仍返回文本', async () => {
  let child;
  const runner = createDshRunner({
    spawnFn: () => {
      child = fakeChild({ exitCode: 1, stdout: '部分回答', stderr: 'agent error' });
      return child;
    },
  });
  const p = runner({ dshCmd: 'dsh', task: 'x' });
  await new Promise((r) => setTimeout(r, 10));
  child.emitClose(1);
  assert.equal(await p, '部分回答');
});

test('askDsh 超时拒绝', async () => {
  const runner = createDshRunner({ spawnFn: () => fakeChild({}) });
  await assert.rejects(
    () => runner({ dshCmd: 'dsh', task: 'x', timeoutMs: 30 }),
    /超时/
  );
});

test('askDsh spawn 同步抛错时拒绝', async () => {
  const runner = createDshRunner({
    spawnFn: () => {
      throw new Error('ENOENT');
    },
  });
  await assert.rejects(() => runner({ dshCmd: 'no-such-dsh', task: 'x' }), /无法启动 DSH/);
});
