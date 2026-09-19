// core/runtime.js
// 轻量插件运行时(零依赖):
//   - 插件注册(use)
//   - 服务注入(registerService / getService):插件之间通过服务协作
//   - 依赖拓扑排序(被依赖者先启动、后停止),检测缺失依赖与循环依赖
//   - 生命周期:install(注册服务) → start(按依赖序) → stop(逆序)
//
// 一个插件 = 一个目录 + index.js(默认导出插件定义):
//   {
//     name, version, description,          // 元信息(可来自 manifest.json)
//     deps: ['otherPluginName'],           // 依赖声明
//     install(ctx) {},                     // 注册服务
//     start(ctx) {},                       // 启动(长连接、定时器等)
//     stop(ctx) {},                        // 停止
//     commands: { 'cmd': async (runtime, args) => {} },  // CLI 子命令
//   }
// ctx = runtime 本身(含 env / logger / plugins / services)

export class Runtime {
  constructor({ env = process.env, logger = console } = {}) {
    this.env = env;
    this.logger = logger;
    this.plugins = new Map();
    this.services = new Map();
    this.started = false;
  }

  /** 注册一个插件 */
  use(plugin) {
    if (!plugin || typeof plugin !== 'object' || !plugin.name) {
      throw new Error('插件定义无效:必须包含 name(可用 manifest.json 提供)');
    }
    if (this.plugins.has(plugin.name)) {
      throw new Error(`插件重复注册:${plugin.name}`);
    }
    this.plugins.set(plugin.name, plugin);
    return this;
  }

  /** 注册一个服务(供其他插件通过 getService 使用) */
  registerService(name, service) {
    this.services.set(name, service);
    return this;
  }

  /** 获取服务;未注册则抛错 */
  getService(name) {
    if (!this.services.has(name)) {
      throw new Error(`服务未注册:${name}(请确认依赖插件已 use 且已完成 install)`);
    }
    return this.services.get(name);
  }

  /** 依赖拓扑排序:被依赖者在前 */
  order() {
    const names = [...this.plugins.keys()];
    const visited = new Set();
    const stack = new Set();
    const order = [];
    const visit = (name) => {
      if (stack.has(name)) {
        throw new Error(`插件依赖存在环:${name}`);
      }
      if (visited.has(name)) return;
      stack.add(name);
      for (const dep of this.plugins.get(name).deps ?? []) {
        if (!this.plugins.has(dep)) {
          throw new Error(`插件 ${name} 依赖的插件未注册:${dep}`);
        }
        visit(dep);
      }
      stack.delete(name);
      visited.add(name);
      order.push(name);
    };
    for (const n of names) visit(n);
    return order;
  }

  /** 启动全部插件:先 install(注册服务),再按依赖序 start */
  async start() {
    if (this.started) return this;
    for (const plugin of this.plugins.values()) {
      await plugin.install?.(this);
    }
    for (const name of this.order()) {
      const plugin = this.plugins.get(name);
      this.logger.log(`[runtime] ▶ 启动插件 ${name} v${plugin.version ?? '?'}`);
      try {
        await plugin.start?.(this);
      } catch (err) {
        this.logger.error(`[runtime] 插件 ${name} 启动失败:`, err.message);
        throw err;
      }
    }
    this.started = true;
    return this;
  }

  /** 停止全部插件(依赖逆序) */
  async stop() {
    if (!this.started) return this;
    for (const name of this.order().reverse()) {
      const plugin = this.plugins.get(name);
      try {
        await plugin.stop?.(this);
        this.logger.log(`[runtime] ■ 停止插件 ${name}`);
      } catch (err) {
        this.logger.error(`[runtime] 插件 ${name} 停止失败:`, err.message);
      }
    }
    this.started = false;
    return this;
  }

  /** 插件清单(调试/帮助用) */
  list() {
    return [...this.plugins.values()].map((p) => ({
      name: p.name,
      version: p.version,
      description: p.description,
      deps: p.deps ?? [],
      commands: Object.keys(p.commands ?? {}),
    }));
  }
}

export function createRuntime(opts) {
  return new Runtime(opts);
}
