// test/runtime.test.js
// 插件运行时测试:注册、服务注入、依赖拓扑排序、生命周期、错误处理。

import test from 'node:test';
import assert from 'node:assert/strict';

import { createRuntime } from '../core/index.js';

const quietLogger = { log() {}, error() {}, warn() {} };

function makePlugin(name, { deps = [], install, start, stop, commands } = {}) {
  return { name, version: '1.0.0', description: name, deps, install, start, stop, commands };
}

test('use 注册与 list 清单', () => {
  const rt = createRuntime({ logger: quietLogger });
  rt.use(makePlugin('a', { commands: { hi: async () => {} } }));
  rt.use(makePlugin('b'));
  assert.equal(rt.plugins.size, 2);
  const list = rt.list();
  assert.deepEqual(list.map((p) => p.name), ['a', 'b']);
  assert.deepEqual(list[0].commands, ['hi']);
});

test('重复注册 / 非法插件抛错', () => {
  const rt = createRuntime({ logger: quietLogger });
  rt.use(makePlugin('a'));
  assert.throws(() => rt.use(makePlugin('a')), /重复注册/);
  assert.throws(() => rt.use({}), /必须包含 name/);
});

test('依赖拓扑排序:被依赖者先启动、后停止', async () => {
  const order = [];
  const rt = createRuntime({ logger: quietLogger });
  rt.use(
    makePlugin('stock', {
      deps: ['feishu'],
      start: async () => order.push('start:stock'),
      stop: async () => order.push('stop:stock'),
    })
  );
  rt.use(
    makePlugin('feishu', {
      start: async () => order.push('start:feishu'),
      stop: async () => order.push('stop:feishu'),
    })
  );
  await rt.start();
  await rt.stop();
  assert.deepEqual(order, ['start:feishu', 'start:stock', 'stop:stock', 'stop:feishu']);
});

test('服务注入:依赖插件通过 getService 使用服务', async () => {
  let received;
  const rt = createRuntime({ logger: quietLogger });
  rt.use(
    makePlugin('feishu', {
      install(ctx) {
        ctx.registerService('feishu', { sendText: async (t) => `sent:${t}` });
      },
    })
  );
  rt.use(
    makePlugin('stock', {
      deps: ['feishu'],
      start(ctx) {
        received = ctx.getService('feishu');
      },
    })
  );
  await rt.start();
  assert.equal(await received.sendText('hello'), 'sent:hello');
  await rt.stop();
});

test('install 全部先于 start 执行', async () => {
  const order = [];
  const rt = createRuntime({ logger: quietLogger });
  rt.use(
    makePlugin('b', {
      install: async () => order.push('install:b'),
      start: async () => order.push('start:b'),
    })
  );
  rt.use(
    makePlugin('a', {
      install: async () => order.push('install:a'),
      start: async () => order.push('start:a'),
    })
  );
  await rt.start();
  assert.deepEqual(order, ['install:b', 'install:a', 'start:b', 'start:a']);
  await rt.stop();
});

test('缺失依赖 / 循环依赖抛错', async () => {
  const rt = createRuntime({ logger: quietLogger });
  rt.use(makePlugin('x', { deps: ['nope'] }));
  await assert.rejects(() => rt.start(), /依赖的插件未注册:nope/);

  const rt2 = createRuntime({ logger: quietLogger });
  rt2.use(makePlugin('m', { deps: ['n'] }));
  rt2.use(makePlugin('n', { deps: ['m'] }));
  await assert.rejects(() => rt2.start(), /存在环/);
});

test('start 时插件抛错会中断并向上抛出', async () => {
  const rt = createRuntime({ logger: quietLogger });
  rt.use(
    makePlugin('bad', {
      start: async () => {
        throw new Error('boom');
      },
    })
  );
  await assert.rejects(() => rt.start(), /boom/);
  assert.equal(rt.started, false);
});

test('stop 对未启动的运行时是安全空操作', async () => {
  const rt = createRuntime({ logger: quietLogger });
  rt.use(makePlugin('a'));
  await rt.stop();
  assert.equal(rt.started, false);
});
