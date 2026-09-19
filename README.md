# dsh-feishu — 飞书插件化项目

把「飞书连接」和「九安医疗股价播报」整理成**两个独立插件**,跑在一个轻量插件运行时上。新增功能只需新增一个插件目录。

```
dsh-feishu/
├── core/                       # 插件运行时(零依赖)
│   └── runtime.js              #   注册/服务注入/依赖拓扑排序/生命周期
├── app/
│   ├── main.js                 # 应用入口:npm run listen(启动全部插件)
│   └── cli.js                  # 命令入口:按插件 commands 分发
├── plugins/
│   ├── feishu/                 # ★ 插件① 飞书连接
│   │   ├── manifest.json       #   元信息(name/version/deps)
│   │   ├── index.js            #   插件定义:注册 feishu 服务 + 命令 send
│   │   ├── webhook.js          #   Webhook 发送(加签/文本/富文本/卡片)
│   │   ├── app-api.js          #   企业自建应用 API(tenant_access_token + im/v1)
│   │   ├── receive.js          #   长连接接收机器人(echo | dsh;超时才回执)
│   │   └── dsh.js              #   DSH 连接:调用本机 dsh headless 智能体处理消息
│   └── stock-broadcast/        # ★ 插件② 股价播报(依赖 feishu)
│       ├── manifest.json       #   deps: ["feishu"]
│       ├── index.js            #   插件定义:启动调度器 + 命令 stock:now
│       ├── quote.js            #   行情获取(腾讯/东财免费源)与格式化
│       └── scheduler.js        #   工作日时间槽调度(纯函数可测)
├── test/                       # 离线单元测试(npm test 共 85 个用例)
├── .env                        # 配置(已 gitignore;参考 .env.example)
├── LICENSE                     # MIT
└── package.json
```

## 插件架构

一个插件 = **一个目录 + index.js**(默认导出插件定义):

```js
import manifest from './manifest.json' with { type: 'json' };
export default {
  ...manifest,                        // { name, version, description, deps }
  async install(ctx) {},              // 注册服务:ctx.registerService('名字', 服务)
  async start(ctx) {},                // 启动:长连接、定时器等
  async stop(ctx) {},                 // 停止
  commands: { 'my-cmd': async (runtime, args) => {} },  // CLI 子命令
};
```

- **ctx(runtime)** 提供 `env` / `logger` / `plugins` / `services`
- **插件间协作**:通过服务注入。如 stock-broadcast 声明 `deps: ['feishu']`,在 start 里 `ctx.getService('feishu').sendText(...)` 发消息
- **启动顺序**:install(全部)→ start(按依赖拓扑,被依赖者先);停止时逆序
- 依赖缺失/循环/重复注册都会在启动时报出明确错误

### 新增一个插件(三步)

1. 建目录 `plugins/my-plugin/` + `manifest.json` + `index.js`(按上面模板)
2. 在 `app/main.js` 与 `app/cli.js` 里 `runtime.use(myPlugin)`(两处都注册,命令才会出现在 CLI)
3. `npm run listen` 验证

## 模式说明

| 插件 | 能力 | 关键命令 |
|---|---|---|
| **feishu** | 发送(Webhook/自建应用,含图片传输)+ 长连接接收(echo / DSH 回复模式,含图片消息) | `npm run send` |
| **stock-broadcast** | 工作日 09:35/10:30/11:30/13:00/14:00/15:00 推送 A 股实时行情到群 | `npm run stock:now` |

### 图片传输(新增)

feishu 插件现已支持**发送图片**:先上传图片获取 `image_key`,再用它发送图片消息。

```bash
npm run send -- --app --image path/to/pic.png          # 发一张图片到 FEISHU_CHAT_ID
npm run send -- --app --chat oc_xxx --image pic.png    # 指定目标群
node app/cli.js send --image pic.png                   # 默认 Webhook 模式(需先经自建应用 token 上传)
```

- **流程**:`--image <path>` → 经企业自建应用 token 上传到 `im/v1/images` 拿 `image_key` → 再发图片消息。Webhook 模式同理(复用自建应用 token 上传,自定义机器人发图片需先获取 image_key)。
- **服务接口**:`feishu.sendImage(filePath, {receiveId, imageKey})`、`feishu.uploadImage(filePath)`(返回 `{image, image_key}`);也可单独 `sendAppImage({appId, appSecret, receiveId}, {filePath, imageKey})`。
- **权限**:需在飞书开放平台开通 `im:image`(或 `im:message`) 并"创建版本 -> 发布"。缺权限会返回错误码。
- **格式/大小**:png/jpg/gif/webp 等,文件 ≤20MB。
- **复用配置**:沿用 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_CHAT_ID`,无需新增 env。

### 接收图片(新增)

用户在飞书里发的图片,机器人现在也能处理(dsh 模式:交给智能体用 `read_image` 看图后回答)。

- **识别范围**:
  - `image` —— 纯图片消息(`content = {"image_key":"img_v3_..."}`)
  - `post` —— 富文本。**注意:飞书里「图+文」一起发通常是 `post` 而不是 `image`**,只处理 `image` 会漏掉大半场景。
- **流程**:收到消息 → 从 `content` 取 `image_key` → 调 `im/v1/messages/{message_id}/resources/{file_key}?type=image` 下载 → 存到本地 → 把**本地路径**写进任务文本,智能体用 `read_image` 读。
  headless 的任务入口是纯文本,所以图片走「落盘 + 传路径」而非改协议,零侵入。
- **落盘位置**:默认 `<工作区>/.feishu-images/`,文件名 `{message_id}-{序号}.{ext}`(多图不互相覆盖、可回溯)。
- **容错**:多张图逐张下载,**单张失败只记日志、不中断**整条消息,避免一张图坏掉就「整条没反应」。
- **权限(必须)**:需开通 **「获取与上传图片或文件资源」`im:resource`** 并「创建版本 -> 发布」。缺权限下载会返回 `403 / code=99991672`,日志里会明确打印,不会静默失败。
- **env(可选)**:`FEISHU_IMAGE_DIR`(落盘目录)、`FEISHU_IMAGE_MAX_BYTES`(单张体积上限,默认 20MB)。
- **尚未支持**:`file` / `audio` / `media` 类消息(仍会被忽略,不回复)。


## 快速开始

### 1. 配置 `.env`(模板见 `.env.example`)

```ini
# 飞书自建应用(必填)
FEISHU_APP_ID=cli_xxxxxxxx
FEISHU_APP_SECRET=xxxxxxxx
FEISHU_CHAT_ID=oc_xxxxxxxx

# 接收机器人回复模式:echo(回显) | dsh(交给本机 DSH 智能体,推荐)
FEISHU_BOT_MODE=dsh
# dsh 模式:本机 dsh 可执行文件。Windows 推荐填 JS 入口(node <路径> 调用,无引号问题)
FEISHU_DSH_CMD=C:\path\to\dsh\lib\bin.js
FEISHU_DSH_TIMEOUT_MS=180000           # 单条消息最长等待
FEISHU_STATUS_THRESHOLD_MS=150000      # 150s 内跑完就不回"收到"(见下文「回执策略」)

# 股价播报
FEISHU_STOCK_ENABLED=true
FEISHU_STOCK_CODE=002432            # 九安医疗;可改任意 A 股
FEISHU_STOCK_TIMES=09:35,10:30,11:30,13:00,14:00,15:00
FEISHU_STOCK_CHAT_ID=               # 缺省用 FEISHU_CHAT_ID
```

### 2. 安装依赖并启动

```bash
npm install
npm run listen      # 启动全部插件:飞书长连接接收 + 股价定时播报
```

### 3. 测试

```bash
npm run send -- --app --text "你好,飞书 🎉"     # 发消息(命令 send)
npm run stock:now -- --send                    # 立即推送一次行情
```

飞书端:单聊直接发消息给机器人;群聊 @机器人。收到 `ws client ready` 即连接成功。

## 回复模式:echo / dsh

| 模式 | 消息由谁处理 | 说明 |
|---|---|---|
| `echo` | 本程序 | 原样回显,验证链路最快 |
| `dsh`(推荐) | **本机 DSH 智能体**(`dsh --profile headless`) | 完整 DSH 环境:DSH 系统提示、工具(搜索/命令等)、推理循环;内部模型默认 DeepSeek API,可切换本地 MTP 模型。**同一飞书对话框对应一个持久化的 DSH 会话**(按 chat_id 派生固定 session id,自动恢复历史),对话框不关、会话就不中断 |

> 曾有的 `llm` 模式(直连大模型 API)已删除,避免绕过 DSH。

### 回执策略:超时才回执(默认 150s)

收到消息后机器人**不再每条都回「收到,任务已交给后台处理」**:

- 任务在 **150s** 内跑完 → 全程静默,只发最终结果(一次消息只看到一条回答)
- 超过 150s 仍未跑完 → 回一条「⏳ 任务还在处理中(已 N 秒),完成后我会把结果发给你。」
- 任务一结束(成功或失败)就撤掉定时器,不会再补发提示

`.env` 可调:

| 变量 | 缺省 | 说明 |
|---|---|---|
| `FEISHU_STATUS_THRESHOLD_MS` | `150000` | 超时阈值(毫秒);设 `0` 恢复"收到即回执"的旧行为 |
| `FEISHU_STATUS_INTERVAL_MS` | `0` | >0 时按该间隔重复提醒(长任务防"断联") |
| `FEISHU_STATUS_ENABLED` | `true` | `false` = 完全静默(任何情况都不发提示) |
| `FEISHU_STATUS_MESSAGE` | 内置文案 | 自定义提示,`{seconds}` 替换为已耗时秒数 |

实现:`createSlowTaskNotifier()`(`plugins/feishu/receive.js`;`setTimeout(...).unref()` 不阻塞进程退出),
任务结束走 `finally` 取消。审批类回复(卡片「同意/拒绝」的回执)不受影响,仍即时回复。
对应测试:`test/bot.test.js` 中 3 个「超时回执」用例。

### 会话连续性(每个飞书对话框 = 一个持久 DSH 会话)

- 机器人按飞书 `chat_id` 派生固定 session id(`feishu-<chat_id>`),每次调用 headless 时通过环境变量 `DSH_AGENT_SESSION_ID` 传入
- 这依赖对 `@deepseek-ai/dsh-headless` 的一个小补丁:其 `lib/index.js` 的 `run()` 支持 `DSH_AGENT_SESSION_ID`(已设置时优先 `agents.resume({ resumeSessionId })`,会话不存在则用该 id 创建)
- 补丁位置(重装依赖后需重打,两处都要):
  - 全局安装目录:`<dsh 安装目录>/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-headless/lib/index.js`
  - profile:`$DSH_HOME/profiles/node_modules/@deepseek-ai/dsh-headless/lib/index.js`
- 效果:飞书对话框不关,DSH 侧就在同一会话中持续对话(历史由 DSH 持久化 + 自动压缩管理)

### 并发安全(同对话框消息串行)

同一个对话框的消息在监听器内**按到达顺序排队**,同一时刻只有一个 DSH 进程在跑
(`createChatSerializer`,见 `plugins/feishu/receive.js`)。原因:两个 dsh-headless
并发 resume + append 同一个持久化会话,会产生 seq 重叠而**写坏会话日志**
(报错 `corrupt session log: seq gap in committed region`)。串行化后同一会话永远
只有一个写者;若仍发生日志损坏,按会话日志「已提交区」(committed region)的帧边界截断即可修复
(先备份原文件)。

### 飞书端审批(DSH 高权限操作)

dsh 模式下,DSH 智能体需要审批(如沙箱提权、跨目录写)时,机器人会把请求发到群里:

```
⚠️ DSH 需要审批
操作:pwsh
原因:需要更高权限
回复「同意」放行,或「拒绝」拒绝。
```

同对话框内**任何成员**回复「同意/拒绝」即可实时放行/拒绝该次操作;等待超时自动取消。
- 实现:监听器内置审批桥(`plugins/feishu/approval-bridge.js`,仅监听 127.0.0.1);
  headless profile 注入应答插件 `@local/dsh-feishu-approval`
  (`$DSH_HOME\profiles\node_modules\@local\dsh-feishu-approval`,已注册进 headless profile bundles),
  通过环境变量 `DSH_APPROVAL_BRIDGE_URL` 与桥对接(桥不可达时保持 fail-closed)。
- 配置:`FEISHU_APPROVAL_TIMEOUT_MS`(审批等待上限,秒,缺省 100)
- 自检:`node .diagnose-approval.mjs`(不碰真实飞书,模拟同意/拒绝/中断/无桥)

### 卡片式审批通道(自决 / 机器人自决,非群投票)

`plugins/feishu/card-approval.js`:让 DSH headless 智能体发起的「操作授权」请求
(沙箱 / 提权等 `允许一次`)以一张**交互式飞书卡片**发到目标群,用户本人或机器人
回复一次「同意 / 拒绝」决定,决策经 `receive.js` 内的 reply 文本路由(`handleDecision`)。

- **与 `approval-bridge.js` 的区别**:后者是多成员群投票 + 本地 HTTP bridge;本模块走飞书渠道(交互卡片)且自决,不依赖群内多成员投票。
- **契约**:`feishu.askApproval(request,{targetChatId,requestIdType})` → `Promise<'allowed-once'|'rejected'|'cancelled'|'unavailable'>`;超时 / 发送失败 fail-closed;同 chat 并发二次发起 reject。
- **路由**:`handleDecision(chatId,text)` 按 `chat→requestId` 边表归一到具体卡片,receive.js 用其替代旧 bridge(不再注入 HTTP bridge)。
- **测试**(离线,stub `sendCard`):`npm test`(已加入 `test/card-approval.test.js`,共 7 用例)——交互卡片 schema、allowed/rejected/超时 cancelled、未知 chat 不命中、同 chat 二次发起 reject。

### DSH 安装与工作区

- **CLI**:全局安装 `@deepseek-ai/dsh`(`npm i -g @deepseek-ai/dsh`),之后 `dsh` 命令即可在任意终端使用
- **DSH_HOME**:默认 `~/.dsh`(profiles / sessions / 凭证 `.credentials.yaml` / `settings.yaml`)
- **工作区**:本仓库目录即工作区;飞书监听器默认在仓库根启动,图片落盘到 `<仓库>/.feishu-images`
- **API Key**:模型凭证保存在 `$DSH_HOME/.credentials.yaml`,**不要提交进仓库**
- **启动 Web 界面**:在仓库目录执行 `dsh web`(浏览器访问 http://127.0.0.1:3080)
- **机器人调用**:建议 `FEISHU_DSH_CMD` 指向 dsh 的 JS 入口 `<dsh 安装目录>/lib/bin.js`(比 npx 缓存路径稳定)

### dsh web 自动拉起飞书监听器

已安装插件 **`@local/dsh-feishu-launcher`**(位于 `$DSH_HOME\profiles\node_modules\@local\dsh-feishu-launcher`),并注册进 web profile 的 bundles:

- **每次 `dsh web` 启动时自动运行飞书监听器**(`node app/main.js`),dsh 退出时自动终止
- **防重复**:监听器启动时写 pid 文件(`<仓库>/.feishu-listener.pid`),launcher 检测到存活实例则跳过;pid 陈旧(进程已死)则自动清理后拉起
- **崩溃自动重启**:监听器意外退出 5 秒后自动重启(连续快速退出 5 次后停止,避免死循环)
- 配置在 `$DSH_HOME\profiles\node_modules\@local\dsh-feishu-launcher\cordis.patch.yml`(改命令/参数改这里)
- 手动方式仍然可用:`npm run listen`(与 `dsh web` 二选一,避免重复实例;手动实例也会写 pid 文件,launcher 会自动跳过)

### 使用本地模型(可选,默认走云端 API)

> **默认情况**:飞书机器人的 DSH 智能体与 Web 端一致,走 DSH 里配置的云端模型 API,秒级响应。

如需把飞书机器人临时切到本地 LM Studio 模型:

1. LM Studio 启动并加载目标模型,开启本地 API 服务(默认 `http://127.0.0.1:1234/v1`)
2. 把 `docs/headless-local-model.patch.yml` 的内容复制到 headless profile 的 `cordis.patch.yml`(它会 `disabled` 全局 settings 层、注册本地 provider,并把默认模型指向本地模型;按注释改成你自己的 provider / 模型名)
3. 验证:`dsh --profile headless "你是什么模型?"` 应回答本地模型名
4. 想切回云端 API:把 headless 的 `cordis.patch.yml` 还原为 `[]` 即可

### dsh 模式前置(一次性)

1. 确认本机装有 `dsh`(DeepSeek Harness CLI,`npx @deepseek-ai/dsh` 安装)
2. 初始化 headless profile(在 `$DSH_HOME/profiles/headless` 下创建,内容参考 `profiles/web`):

   ```json
   // package.json
   { "name": "dsh-profile-headless", "private": true, "dependencies": {},
     "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] } } }
   ```

   另需 `cordis.yml`、`cordis.patch.yml`(内容 `[]`)与 `pnpm-workspace.yaml`(同 web profile),并确保 bundles 已在共享 node_modules 中
3. 验证:`dsh --profile headless "只回复OK"` 应输出 `OK`
4. `.env` 填 `FEISHU_DSH_CMD`(Windows 填 `...\node_modules\@deepseek-ai\dsh\lib\bin.js`,程序会用 `node <路径> --profile headless <任务>` 调用)

> ⚠️ 已知取舍:dsh 模式每条消息冷启动一个完整智能体,首条消息约 1~2 分钟,后续因系统缓存会快一些。
> 因此默认启用「超时才回执」(150s),避免用户以为消息没被收到。

## CLI 命令总览

```bash
npm run send -- --text "部署完成 ✅" --at all      # Webhook 模式发文本
npm run send -- --app --text "消息"                # 应用模式(推荐)
npm run send -- --app --chat oc_xxx --text "指定群"
npm run send -- --card                            # 演示卡片
npm run send -- --app --image path/to/pic.png     # 发一张图片(自建应用/Webhook 模式)
npm run stock:now                                 # 打印当前行情
npm run stock:now -- 600519 --send                # 指定股票并推送到群
node app/cli.js help                              # 列出全部插件命令
```

## 常见返回码

| code | 含义 | 处理 |
|---|---|---|
| 0 | 成功 | — |
| 19024 | 签名过期 | 校准本机系统时间 |
| 9499 | 频率限制 | 放慢发送频率 |
| 99991672 | 应用无发消息权限 | 开通 `im:message` 并重新发布版本 |
| 99991661 | 机器人不在该群 | 把机器人添加到目标群 |

## 扩展路线

| 需求 | 方案 |
|---|---|
| 飞书里 AI 对话(已实现,dsh 模式) | feishu 插件 + 本机 DSH 智能体(带工具),每条消息一个智能体会话 |
| 读写云文档/表格/日历 | 新增插件,在 feishu 插件基础上调 `docx` / `sheets` API |
| 更多股票/更多时间点 | 改 `.env` 的 `FEISHU_STOCK_CODE` / `FEISHU_STOCK_TIMES` 即可 |
| 法定节假日精确判断 | 在 scheduler 里接入节假日 API(当前仅周一~周五) |

## 开发

```bash
npm test        # 离线跑全部单元测试(85 个用例,不联网)
```

> ⚠️ 首次使用请先 `npm install`(需联网下载官方 SDK @larksuiteoapi/node-sdk)。
> 行情数据来自腾讯/东方财富免费接口,仅供个人参考。

## 许可证

[MIT](./LICENSE) © 2026 imbrain1989

> 第三方依赖 `@larksuiteoapi/node-sdk` 遵循其自身许可(MIT);行情数据接口为公开免费接口,请自行确认使用条款。
