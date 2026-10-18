# dsh-maid-comfyui · 问题与解决记录

> 用途：**换新设备 / 重新装一遍时的对照表**。按「装 → 连 → 工作流 → 跑任务」的实际顺序分类，每条写清症状原文、已确认的原因、可执行解法和验证方式。
>
> 最后更新：2026-10-16（对应插件版本 0.5.5）
>
> 与 `docs/INCIDENTS.md` 的关系：那份是**原始事故单**（单次事故的时间、证据、修复与教训）；本文件是**分类整理版**，把事故单条目拆开归入对应类别，并补上仓内文档、源码注释与实机踩坑。互为索引：事故现场看 INCIDENTS，装机器看这里。
>
> 症状里带引号的是实际报错/界面文案；标「（待核）」的是尚无实机证据、仅按代码推断的条目。

---

## 一、安装与部署

### 1.1 装完 dsh 起不来 / dshmarket 弹风险横幅（版本没配对）

- **症状**：把新版插件装到老宿主机上，dsh 整体启动失败（宿主对插件 fail-loud，不隔离）；或插件市场出现 `soft-incompatible` 风险提示 + 一键回滚。
- **原因**：`@deepseek-ai/dsh-settings` 是**必选 peer**（0.4.0 起摘掉 `peerDependenciesMeta` 的 `optional: true`），且 peer 范围只覆盖宿主 0.1.2 起的各条预发布线；老宿主（0.1.1）装 0.5.x 不满足 peer。
- **解法**：配对安装——插件 **0.5.x（`latest`）↔ dsh ≥ 0.1.2**（含 0.1.5/0.1.6/0.1.7 预发布）；插件 **0.3.x（`beta`）↔ dsh 0.1.1**。命令 `dsh plugin --profile web add dsh-maid-comfyui`（老宿主加 `@beta`）。0.3.x 老线留在 npm 不撤，不做双版本 shim。
- **验证**：重启后 `GET /comfyui/ping` 返回 200，侧栏出现「ComfyUI 面板」，设置页出现「ComfyUI」分区。

### 1.2 装完没变化：面板入口/设置页都不出现

- **症状**：`dsh plugin add` 成功，界面上什么都找不到。
- **原因**：宿主侧（`lib/index.js`、工具、路由）只在启动时装配，不重启不生效。
- **解法**：装完**重启应用**即可。**不要手改 profile**——安装器会把依赖写进 `package.json`、把本包加进 `dsh.profile.bundles`，宿主 `dsh-plugin-manager` 的 reconcile 会收编带 `dsh.bundle` 字段的新依赖。本机 ComfyUI 路径这类机器特定值走设置页，不写进 `cordis.patch.yml`。
- **验证**：重启后 `/comfyui/ping` 200。

### 1.3 源码方式装：clone 下来是空壳，构建不出来

- **症状**：clone 后没有 `lib/`、`client/`（`.gitignore` 已排除），加载报找不到 `lib/index.js`；或无 npm 的机器上 `pnpm run build` 直接失败。
- **原因**：构建产物不入库，必须自行构建；本机实测 **PATH 里没有 npm**，脚本入口跑不通。
- **解法**：
  ```sh
  npm install                 # 或 pnpm install，见 1.4
  ./node_modules/.bin/tsc -p tsconfig.json
  ./node_modules/.bin/tsdown -c tsdown.config.mjs
  ```
  两条直接产出 `lib/`（宿主）与 `client/client.js`（浏览器侧）。
- **验证**：两个产物存在且时间戳是新的；重启 DSH 后 `/comfyui/ping` 200。

### 1.4 `pnpm install` 撞供应链门禁

- **症状**：`pnpm install` 直接 exit 1，报 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`。
- **原因**：lockfile 里有发布不满 24 小时的包，撞了 pnpm 的 `minimumReleaseAge` 门槛。
- **解法**：`pnpm install --config.minimumReleaseAge=0`（命令行 `--config.` 前缀有效；`npm_config_minimum_release_age` 这类**环境变量实测无效**）。这是本机重试手段，不作为默认关掉门禁的姿势。
- **验证**：install 成功退出，`node_modules/.bin/tsc` 存在。

### 1.5 装配三处名字必须一致（改名/定制后最容易踩）

- **症状**：profile 起不来，或插件加载了但面板空白、客户端 bundle 不注册。
- **原因**：宿主按三处名字对齐装配：**npm 包名 = `cordis.patch.yml` 的 `name` = client bundle 注册 id**；宿主半边还要求 `inject = ['tools']`。任何一处改了另两处没跟着改就断链。
- **解法**：三处一起改；`package.json` 的 `dsh.bundle.patch` 指向 `./cordis.patch.yml`；客户端 bundle 由 `tsdown.config.mjs` 产出，`PLATFORM_EXTERNALS`（react、cordis、`dsh-client-ui-*`）必须保持 external。
- **验证**：重启后 `/comfyui/ping` 200 且面板能打开。

### 1.6 boot 期报 `cannot get property "<name>" without inject`（INCIDENTS 问题一）

- **症状**：profile 起不来，报错点在 boot 期、离肇事代码很远。
- **原因**：插件通过 `ctx.<服务名>` 访问了某个 cordis 服务，却没在 `export const inject` 里声明。
- **解法 / 核查结论**：规则成立并必须遵守。INCIDENTS.md 记的这起事故**本仓库不存在**：`src/index.ts:37` 与 `lib/` 产物均已声明 `export const inject = ['tools']`（当时检修侧基于旧版本判断）。反向纪律同样重要：**可选服务**（`webServer` / `settings` / `credentials` / `skills`）**不要**进 `inject`，改用 `ctx.get(...)` 或 `ctx.inject([...], cb)` 子 fiber，让插件在无该服务的 headless 宿主上优雅降级。
- **验证**：重启后 profile 正常加载；逐个确认 `ctx.webServer` / `ctx.settings` / `ctx.credentials` / `ctx.skills` 都有对应子 fiber 或 `ctx.get`。

### 1.7 dsh 0.1.7 上设置页保存报 `Plugin entry has no volatile fields`（Issue #11）

- **症状**：宿主升到 0.1.7 后设置页保存报这句，或改了没反应。
- **原因**：0.1.7 起设置服务**只编辑 Config 里 `.volatile()` 的字段**（写回 profile 的 `cordis.patch.yml`，Loader 就地更新引用并发 `loader/volatile-update`）。本插件的 `dataDir` / `maxAssets` / `outputDir` **刻意不是 volatile**——store 启动时由它们构造。
- **解法**：这三个走 `cordis.yml` 的 `comfyui` 段并重启；其余（`baseUrl` / `apiKeyEnv` / 超时 / 轮询 / 媒体上限 / `skillsDir` / `mediaHost` / `comfyuiDirs` / `launchCommand` / `launchDir`）设置页改完**即生效，无需重启**，`baseUrl` 变化会重连进度 WS。需 `@deepseek-ai/schemastery` ≥ 3.18.4。
- **验证**：不重启改 `comfyuiDirs`，`comfyui_workflow list` 的 `env` 立刻是新值。

### 1.8 历史会话整个打不开（INCIDENTS 问题二，最贵的一次事故）

- **症状**：重启 web server 后某个历史会话**完全无法加载，整个会话报废**；日志里看不出跟 ComfyUI 有关。
- **原因**：`echoCompletion()`（`src/tools.ts`）后台生成完成时向会话注入通知，早期传的是**裸对象字面量**（`owner.inject({ role: 'user', content, source })`，缺 `id`）。host 的 `agent.inject()` 要求**已具名消息**（内部一律走 `createUserMessage()`，该 helper 补 `id: crypto.randomUUID()` 与 `role: 'user'`）。绕过 helper 后一条没有 `id` 的 message 事件写进了 append-only 的会话日志，加载时 `assertMessageEventShape`（`packages/core/session/src/index.ts:301`）全量校验撞上它，**整个会话拒绝加载**。证据：坏事件署名 `"source":{"kind":"plugin","plugin":"comfyui","form":"notice",...}`，正文是 `echoCompletion` 里硬编码的中文通知；全日志 2238 条 message 事件仅此 1 条缺 id。
- **解法**（代码已修，装新机不用处理，纪律要带过去）：注入消息补全 `id`（UUID）+ `role: 'user'` + `content` + `source` 完整形状，修复处带 CONTRACT 注释；**能用 host 的 `createUserMessage()` 就用**。数据侧损坏日志需重写修复（停进程、备份、重压），代价极高——所以 `echoCompletion` 已用 try/catch 包成 best-effort：**宁可注入失败也不写坏数据**。
- **验证**：跑 `node scripts/analyze-sessions.mjs`（只读扫描，逐帧解压找缺 `id` 的 message 事件）。2026-08-20 全量复检：3 个日志（575 帧 / 30998 帧 / 9431 帧）missingId 全为 0。**新增任何「向会话/模型注入内容」的路径后必须重跑它。**
- **教训**：这类错误编译期零提示、运行期才暴露，报错点离肇事点极远（一个炸在 boot，一个炸在几天后的历史加载），看起来都像 harness 坏了——插件侧必须主动守契约。

---

## 二、连接与路径问题

### 2.1 面板报「无法连接 ComfyUI」，`/comfyui/test` 失败

- **症状**：会话头部点「ComfyUI 面板」后顶部弹提醒条「无法连接 ComfyUI」；测试连接报 `连接失败：{message}`（底层常见连接被拒/超时）；队列页显示「无法读取队列（ComfyUI 未运行？）」。
- **原因**（按概率）：① ComfyUI 根本没在跑——它作为 DSH 桌面壳的子进程时，**DSH 一重启它就跟着死**，8188 直接拒连；② 设置页 `baseUrl` 填错（默认 `http://127.0.0.1:8188`）；③ 远程机没开 / 防火墙 / 需要 API Key 而 `apiKeyEnv`（默认 `COMFYUI_API_KEY`）没配。
- **解法**：① 面板右上角 `⏻` 手动拉起（设置页填了「启动命令」才能成功）；没填就在设置页填 `launchCommand` + `launchDir`，或自己手动跑便携版；② 设置页改 `baseUrl`，改完即生效；③ 远端走凭据存储或 `apiKeyEnv` 指定环境变量（密钥只在宿主解析，**绝不下发浏览器**）。
- **验证**：`GET /system_stats` 出 JSON（本机 8188 约 12 秒起来）；`GET /comfyui/ping` 200；提醒条消失。
- **附（不是故障）**：**本插件启动的** ComfyUI 在会话里的任务结束（这一轮对话结束）时会自动关掉把显存还回去，所以下次跑工作流它可能又不在——设计行为，照上面走即可。**没有空闲自动关闭**：服务器闲置多久都不会被关。

### 2.2 启动命令拉起了黑窗还关不掉 / 拉起报 `launch-timeout`

- **症状**：用 `run_nvidia_gpu.bat` 当启动命令后，一个 cmd 控制台窗口一直挂着（关掉它 ComfyUI 也跟着死）；或 ⏻ 拉起后 90 秒超时，面板顶部写原因。
- **原因**：便携版那个 bat 结尾有 `pause`，且由 `cmd` 拉起的控制台不会自己消失；`launch.ts` 虽是 `spawn(command, { shell: true, detached: true, stdio: 'ignore', windowsHide: true })`，也管不了 bat 自己拉的控制台。另外 `POLL_TIMEOUT_MS = 90_000`（1 秒探一次，最多 90 秒），同一失败有 `FAIL_COOLDOWN_MS = 10_000` 冷却，冷却内重复点击回放同一条错误。
- **解法**：启动命令改用便携版 pythonw，去掉窗口：
  `D:\ComfyUI_windows_portable\python_embeded\pythonw.exe -s ComfyUI\main.py --windows-standalone-build`，`launchDir` 填便携版根目录。`launchCommand` 留空时 `⏻` 只能关不能开，接口返回 `launch-not-configured`。`launch` 路由**只在本机 baseUrl 下开放**（`canLaunch` 为假时面板不显示按钮），会写 `ctx.logger.info` 审计日志。
- **关停的四条硬约束**（`src/idle.ts:16-33` 头注释原文，动手改关停逻辑前先读；2026-10-18 复核代码确认仍成立）：
  1. **只有 loopback 上的 `baseUrl` 才算「本机自己拉起的」**——"Only a loopback `baseUrl` qualifies. A server on another machine is not ours to kill, and its port would resolve to nothing local anyway." 远端 ComfyUI 一律不关。
  2. **有活在飞就绝不关**——"Never while work is in flight: the caller supplies `busy()`, which reports the ComfyUI queue (running + pending) and the plugin's tracked runs. A shutdown that lands mid-generation would destroy the user's image." 队列未排空时，关停请求只是被记住，按 `PENDING_TICK_MS = 5_000`（`src/idle.ts:42`）重试到队列清空，不是排队下发。
  3. **PID 必须在关停那刻从监听端口反查，绝不缓存**——"The PID is resolved from the listening port at shutdown time, never cached: a `.bat` launcher exits immediately, so the pid we spawned is not the server's pid." 拿 `spawn()` 的 pid 去杀，杀的是 bat 外壳（它早就退了），真正的 `python.exe` 还活着。
  4. **ComfyUI 0.39 没有「退出」路由**——"ComfyUI 0.39 exposes no \"quit\" route (only `/interrupt` and `/free`)"，所以只能杀进程树：win32 用 `taskkill /PID <pid> /T /F`，否则 `bat → python` 的后代进程留着不下来。
  代码锚点：`findListeningPids()`（`src/idle.ts:106`，win32 解析 `netstat -ano -p TCP` 的 `LISTENING` 行尾 PID，其他平台走 `lsof`）、`killProcessTree()`（`src/idle.ts:128`）。`armed` 由一次成功拉起置位，并从 `<dataDir>/launched.json` 跨宿主重启恢复——**没 `armed` 就绝不动手**。
- **验证**：拉起后 `GET /system_stats` 有响应且**没有**残留控制台窗口；关停时先探端口 → 按端口反查 PID → `taskkill /PID <pid> /T /F`。

### 2.3 挂在反代后面时裸路由 404（只转发 `/api/*` 的代理）

- **症状**：ComfyUI 本身能开，但插件探活/队列全失败，直连 `/system_stats` 404。
- **原因**：有些反代（如 comfy-api-proxy）只转发 `/api/*`，裸路由不存在（Issue #6）。
- **解法**：无需配置——`routePrefix` 自学习：裸路由 404 时自动重试 `/api` 前缀，成功就记住（`src/comfyui.ts:149`）。
- **验证**：探活成功后 `/comfyui/ping` 200，队列页能读出任务。

### 2.4 加载区「已导入」列表是空的（0.35 桌面版）

- **症状**：ComfyUI 的 input 目录里明明有图，加载区「已导入」看不到。
- **原因**：`/v2/userdata` 在 0.35 桌面版不存在（Issue #5），列表请求直接失败。
- **解法**：无需配置——`listUserData` 在 `/v2/userdata` 404 时回退 v1 `/userdata?dir=…&recurse=true&full_info=true`（`src/comfyui.ts:420-427`）。
- **验证**：加载区出现 input 目录里的文件。

### 2.5 资产删不掉 / 删了卡片还在，输出目录文件还在

- **症状**：面板资产页删除后磁盘上的图仍在；或只删了记录没删文件。
- **原因**：**ComfyUI 全服务端唯一的 DELETE 路由是 `/userdata/{file}`**（用户目录）；0.32 的 `DELETE /api/assets/{uuid}` 需 `--enable-assets`，且源码里 `delete_content_if_orphan=False`——只软删数据库引用，**文件保留**。所以插件只能自己动文件系统；找不到输出目录时降级为只删索引记录。
- **解法**：设置页 `outputDir` 填 ComfyUI 输出目录（如 `D:\ComfyUI_windows_portable\ComfyUI\output`）；留空时由 `resolveOutputDir` 从资产记录的 `fullpath` 反推（`src/routes.ts:63-77`）。删除保留了 `relative()` 路径穿越检查——`subfolder` 是 ComfyUI 给的、**不可信**。
- **验证**：删一条资产后 `assets.json` 记录消失且输出目录文件消失；`temp`/`input` 等兄弟目录不被误删。

### 2.6 媒体打不开、面板显示「源文件已被 ComfyUI 清理」

- **症状**：早先生成的图/视频点开 404；面板资产卡片显示「源文件已被 ComfyUI 清理」，但文件其实还在 output 目录。桌面端（`dsh-app://` 壳）里卡片配图变破图。
- **原因**：① 早期实现按 prompt/node/index 拼链接、依赖 `/history`——**history 是内存态**，ComfyUI 重启或用户点「清空历史」就没了（契约 7）；② 桌面端 GUI 跑在 `dsh-app://` 自定义协议下**完全禁网**，写死 `http://127.0.0.1:8188/...` 的外链静默失败。
- **解法**：媒体一律**按文件寻址**：`/comfyui/media?file=<文件名>&subfolder=<子目录>&type=output`（同源代理 `src/proxy.ts`），按 `file+subfolder+type` 直取、不依赖 history，重启/清空历史后旧结果照样能打开；历史里的旧链接由 `/comfyui/assets`、`/comfyui/loadarea` 的 `healAssetUrls` 与代理的资产索引回落救回。远端浏览器访问时填 `mediaHost`（留空则按浏览器实际访问的 Host 推，回环 origin 不覆盖已知外部 origin）。VCP 卡片配图只能走这个同源路由，`src` 写相对路径。
- **验证**：`curl "http://127.0.0.1:19387/comfyui/media?file=<文件名>&type=output"` 返回 200 与图片字节；音频/视频拖动进度条正常（代理转发 Range，206 直通）。
- **根因（补记）**：媒体链接是按 **prompt / node / index** 拼出来的，落点在 ComfyUI 的 `/history` 上；而 `history` 是**内存态**——ComfyUI 一重启、或用户点一次「清空历史」，映射表就没了，之前生成的所有链接集体 404，可**文件其实还在 output 目录里**。面板那句「源文件已被 ComfyUI 清理」是这句话在骗人：清理的不是文件，是索引。
- **修法（补记）**：媒体 URL 必须**按文件寻址**，只用 `file` + `subfolder` + `type` 三个参数，不掺 prompt/node/index。`collectMedia` 统一走 `mediaProxyUrl`；历史记录里已经存下来的旧链接，由 `/comfyui/assets`、`/comfyui/loadarea` 的 `healAssetUrls` 与代理侧的资产索引回落救回——不需要用户重跑一遍工作流。

### 2.7 重启后工作流库/技能包全空

- **症状**：升级/改名后重启，面板工作流列表空、技能包不见；`GET /comfyui/workflows` 返回 `{"workflows":[]}`。
- **原因**：**运行时数据目录跟着 npm 包名走**——`defaultDataDir()` = `join(DSH_HOME ?? ~/.dsh, 'data', 'dsh-maid-comfyui')`（`src/index.ts:99`）。`dsh-comfyui` 改名成 `dsh-maid-comfyui` 后，老数据留在 `data/dsh-comfyui`，**不会自动跟过去**。
- **解法**：把旧目录内容复制到新目录（本机两条都在：`C:\Users\Kayle\.dsh\data\dsh-comfyui` → `…\data\dsh-maid-comfyui`），至少带 `workflows.json`、`tracked.json`、`skills/`；旧目录留着无妨。换机同理（拷整个 `data/dsh-maid-comfyui`，或用面板的**预设导出/导入**打包带走）。
- **验证**：重启后面板工作流列表与技能包都回来。

### 2.8 要让 Agent 找得到本机的 models / 自定义节点 / 音色库

- **症状**：Agent 反复问 ComfyUI 装在哪，或找 model 找不到。
- **原因**：`comfyuiDirs` 默认空数组，插件不知道安装位置（可能还有目录映射/多实例/便携版）。
- **解法**：设置页「ComfyUI 目录」填绝对路径，**可填多条**。Agent 每次 `comfyui_workflow list` 都能读到 `env.baseUrl` 与 `env.comfyuiDirs`（现读，改完即生效），据此定位 models、自定义节点、TTS 音色库、输出目录；映射了额外模型目录的还要算上 `extra_model_paths.yaml`。
- **验证**：改完配置不重启，`list` 的 `env.comfyuiDirs` 立刻是新值。

### 2.9 连接提醒条写死 `top: 14px`，整条 toast 的点击（含关闭 ✕）被当成拖窗口吞掉

- **症状**：会话头部点「ComfyUI 面板」后弹出顶部提醒条，但它**整条点不动**——包括右上角那个关闭 ✕，点了没反应，弹窗关不掉，只能刷新页面。2026-10-15 老大实测报障。
- **原因**：提醒条写死 `top: 14px`，正好落在宿主 Windows Electron 外框的标题栏条带里。宿主那一层有一条 caption 高度的伪元素（`.BynINW_frame:before`）铺着 `-webkit-app-region: drag`，而宿主**只在 macOS 分支**给 `button` / `a` / `input` 等隐式加 `no-drag`，Windows 下没有这段兜底——于是拖拽区把整条 toast 上的点击全接管了。
- **解法**：
  1. 所有插件浮层显式写 `-webkit-app-region: no-drag`：`.dsc-conn-toast`、`.dsc-panel`、`.dsc-picker-overlay`、`.dsc-lightbox`；toast 再补一条 `.dsc-conn-toast *` 覆盖到子元素（只写父级漏子级，点按钮仍被吞）。
  2. 顶部定位改用变量 `top: var(--dsh-frame-overlay-top, 14px)`，别把 14px 写死——宿主换外框高度时插件不跟着改就又落回条带里。
- **验证**：未验：本轮只取到「2026-10-15 老大报障」这一侧的现象记录，没有修后复测存档（未记录「点击关闭 ✕ 是否恢复」）。落地前须在 Windows 桌面端实测一次：打开提醒条 → 点关闭 ✕ 能关 → 点条内任意文字不触发窗口拖动。
- 来源：`D:\Works By DSH\dsh-maid-comfyui\CLAUDE.md:141`。

---

## 三、工作流问题

### 3.1 提示「非 API 流程，无法直接执行」

- **症状**：面板/`list` 里看得见 ComfyUI 端保存的工作流但不能运行；该图 `extracted: false`。
- **原因**：本插件有两个「工作流主题」——**图工作流（衍生主题）**是 ComfyUI 端保存的画布 UI 图（nodes/links/widgets），是「源」，**不能直接运行**；**API 工作流（运行主题）**是 API 格式 prompt（node id → `{ class_type, inputs }`），是「运行单元」。
- **解法**：图 → API 两条路：① 面板点**提取**（`analyzeGraph` → `convertGraphToApi` → `analyzeWorkflowParameters` → `store.saveWorkflow`）；② 直接把 API JSON 粘进「新建工作流」或 POST 入库（`POST /comfyui/workflows`，**origin 头必带**）。图未提取时 Agent 应转告用户去面板点提取，而不是试图运行图本身。
- **验证**：提取出的工作流能被 `run` 起来；插件对提取产物先做一次 `POST /prompt` 校验，`nodeErrors` 必须为空。

### 3.2 提取报「包含未注册的 UI-only 节点 "<一串 UUID>"」

- **症状**：面板点提取失败，报错里的节点类型是一串 UUID；用户常误以为「模型路径没适配好」。
- **原因**：新版 ComfyUI 画布可把整段流程收进**子图（subgraph）**，存盘后顶层只剩一个 type 等于子图 UUID 的实例节点；分析器把子图当黑盒（`src/convert.ts:336/340`）按未注册拒掉。**这不是模型路径问题**——先看报错发生在**提取阶段**还是**执行阶段**，别顺着猜测走。
- **解法**：① 在 ComfyUI 里右键子图 → `Unpack` 展开，保存后再提取；② 用仓库自带离线转换器（脚本随**源码仓库**分发，不在 npm 包 `files` 白名单里，要 clone 后用）：
  ```bash
  node scripts/subgraph-to-api.mjs <画布工作流.json> [输出.json]
  # --base-url <url>（默认 http://127.0.0.1:8188）实时拉 object_info
  # --object-info <file> 用本地 object_info 转储（离线）
  # --quiet 不打印转换后的 JSON
  ```
  它先把子图实例**内联摊平**（`-10`/`-20` 两个虚拟端口接成真连线），再按 `object_info` 契约转成可 `POST /prompt` 的 API 格式，产物可直接经 `/comfyui/workflows` 存进工作流库。
- **验证**：`node scripts/test-subgraph-to-api.mjs`（纯离线 fixture）。
- **坑（改脚本前必看）**：Autogrow 组（`COMFY_AUTOGROW_V3`）的输入名**必须保留组前缀**（`images.image0`），剥掉会让 `/prompt` 返回 400 `required_input_missing`。

### 3.3 画布上躺着多个独立流程，不知道怎么提取

- **症状**：提取出的工作流跑起来带一堆无关节点，或提示某分量没有输出节点。
- **原因**：`groups`（视觉分组）**只是矩形，没有执行语义**；真正的可执行单元是**激活节点的连通分量**。悬空单节点（Markdown、Fast Groups Bypasser、未连接的 Primitive 等）自动忽略；bypass（`mode: 4`）按与 `convert.ts` 相同的直通规则（输出跟随**第一个**有连线的输入）连接上下游。
- **解法**：多分量时面板给三个选项——**整体**（合成一个，运行时全部执行）/ **按分量提取**（推荐，每个独立流程一个运行工作流）/ **只拆主流程**（最大分量）。面板先展示分析报告（各分量节点数、所在组），选择权交给用户。分量没有任何输出节点时插件跳过并警告「分量没有任何输出节点（ComfyUI 无法排队），已跳过」。
- **验证**：`node scripts/test-convert.mjs`（覆盖 DynamicCombo 扁平、bypass 直通与越界引用拒绝、Set/Get 按名配对、rgthree Relay/Repeater 连线丢弃）。

### 3.4 提取成功但一提交就 KeyError / 输入错位

- **症状**：转换成功，`POST /prompt` 阶段报错。
- **原因**（三个高频）：① **节点引用写成了数字**——API prompt 里必须 `[String(nodeId), slot]`，服务端按字符串键做字典查找（`execution.py` `validate_inputs`），数字引用 KeyError；② **`widgets_values` 顺序错位**——图节点自身 `inputs` 数组才是 widget 顺序（含动态子 widget，**被链接的 widget 仍占一格**），名为 `seed`/`noise_seed` 的 INT 前端渲染「生成后控制」下拉，**占一格但无 API 输入**，提取时消费该值但不写入，否则后续 widget 全部错位（典型：TTS-Audio-Suite 的 seed 后跟的 `"fixed"` 被当参数），`forceInput` 的 widget 不占格，只存在于画布上的前端节点（`MarkdownNote`、`ImageCompare`）按 `object_info` 有无前端专属输入类型识别并跳过；③ **输出槽位越界**（保存图声称 2 个输出、服务端只有 1 个）→ 断开该引用并警告，**必需输入缺失**（required 里没有且非 lazy/template）→ 明确报错，不产出「能转但跑不起来」的工作流。
- **解法**：按上述三条对齐；`COMFY_AUTOGROW_V3`/带 `template`/带 `lazy` 的输入豁免必需性检查。参数写回要区分「没传」与「传了空值」：空默认值（`default: ''`）在未显式传值时必须跳过**连线输入上的高级参数**与**加载参数**（否则冲掉连线/清空文件名，运行直接失败），唯一例外是 `upload: 'media'` 参考位，空值语义就是「移除该位」。
- **验证**：提取后先用 `POST /prompt` 校验 `nodeErrors` 为空；产物另做引用完整性检查（所有 `[id, slot]` 必须指向同一产物内的节点）。

### 3.5 DynamicCombo V3 被包成嵌套结构 → 节点 execute 才报缺参数

- **症状**：能提交、能跑，但跑到视频节点才报 `missing ... 'codec'` 之类缺参数（整轮白跑）。
- **原因**：`COMFY_DYNAMICCOMBO_V3` 在 API prompt 里**是扁平的**——主输入的值 = 选中项 key 字符串，子控件以 `master.sub` 为同级键（如 `codec: "auto"`、`aspect_ratio.size`）。包成 `{ key, inputs }` 匹配不上、输入被丢弃，服务端到 `execute()` 才发现（契约 15）。同类：`SaveImageAdvanced` 的 `format` 是动态 combo，API 提交必须同时给 `bit_depth:'8-bit'` 与 `input_color_space:'sRGB'`，否则报 `Required input is missing: bit_depth / input_color_space`——图省事直接用 `SaveImage`。
- **解法**：扁平提交；`params.ts` 的 combo 子参数也按扁平键工作；0.2.0–0.5.1 存下的旧形状（`{ key, inputs }`）在排队时由 `flattenDynamicCombos` 摊平。
- **验证**：`node scripts/test-convert.mjs`（含 DynamicCombo 扁平回归，源码里的 #10）。

### 3.6 参数取值被拒 / 传了不生效

- **症状**：`action: run` 被拒，报 `parameter ... is not one of the allowed options`；或传了小数被四舍五入；或传了参数像没传。
- **原因**（三种，别混）：① **快照过期**——工作流参数保存时会**拷贝**一份 `options` / `numberKind` / min/max/step，之后不再自动更新，新音色/新节点定义不在旧 options 里会被运行前校验拒绝（TTS-Audio-Suite 最典型：音色数据有**两份**都会过期——TTS 进程缓存，与工作流参数快照）；② **类型**——`numberKind` 为 `int` 的参数传小数会四舍五入，`float` 才能传 `cfg 7.5`；③ **名字**——必须用清单里的英文 `name`（`prompt`/`seed`/`width`…），不要自造。
- **解法**：`comfyui_workflow action: refresh { id }`（或 `POST /comfyui/workflows/refresh-params`，body `{ id }`）——先强制 TTS 音色库重扫（`?refresh=1`）再读最新 `object_info`，只更新 options / numberKind / min/max/step 等派生字段，**参数集合与用户手加的高级参数原样保留**，返回 `changed`。注意：单独打 `?refresh=1`（或让用户在画布按 R）**只重扫 TTS 进程缓存，不动工作流快照**。
- **验证**：refresh 后 `action: list` 能看到新选项，run 不再报 allowed options。

### 3.7 加载节点的输入键写死 → 整类媒体在加载区凭空消失

- **症状**：加载区里视频/音频选不了或不生效。
- **原因**：加载节点输入键**必须从 `object_info` 读**（找带 `*_upload` 标记的输入，`loaderInputKey`）：`LoadImage` 是 `image`，**`LoadVideo` 是 `file`**，`LoadAudio` 是 `audio`；写死 `video` 会让整类媒体消失。文件类型按扩展名判定（同一个 `.mp4` 会同时出现在 LoadVideo 与 LoadAudio 的候选列表里）。
- **解法**：不写死键名；加载区是一组**加载位**（`Array<CurrentImage | null>`，`null` = 空位），已放入的按顺序自动填进未显式传值的加载参数（同类型匹配），Agent 不需要猜文件名；加载位数与内容通过 `comfyui_workflow list` 的 `loadArea` 暴露。
- **验证**：加载区放入一张图后 `loadArea.items` 出现它，跑图生图不传文件名也生效；未传 `width`/`height` 时自动匹配源图分辨率。

### 3.8 技能包相关：报「没有技能包」或被「运行前必读」拦住

- **症状**：`comfyui_skill read` 报「工作流 "X" 没有技能包」；或 `comfyui_workflow action: run` 失败提示先读技能包。
- **原因**：① 没挂技能包时，除 `enable` 外的动作都报「没有技能包」（创建只有 `enable` 一条路）；② 用户勾了「运行前必读」——它**只拦 `action: run` 这一条路径**，`list`/`skill`/`get`/`refresh` 不受影响；拦截粒度是**会话 × 工作流**，读过一次（`action: skill` 或 `comfyui_skill read` 读到 `SKILL.md`）即解除，**换会话会重新拦**。
- **解法**：报错里会指明先跑 `comfyui_workflow action: skill { id }`；建技能包用 `comfyui_skill action: enable`（建目录 + 骨架 `SKILL.md`，自动列出全部可调参数名占位），往里 `append`，别整体覆盖骨架。
- **验证**：读完再 run 通过；`list` 里该行显示「技能包（运行前必读）」。
- **别做的事**：**不要把技能包改成 `ctx.skills.register`**（契约 12）——宿主 skill 目录会把每个 model-invocable skill 无条件写进常驻消息，几十个工作流就变成每轮请求都在收费。按需披露阶梯挂在 `comfyui_workflow` 上。

### 3.9 工作流接线本身的问题（出纯噪声 / 参考图不生效）

- **症状**：跑完不报错但出纯噪声；或图像编辑的参考图完全不生效（照着提示词另画一张）。
- **原因**（实机踩过，2026-10-14）：① **选错文本编码器**——`pe_*_w4a8` 那两份不是主线文本编码器（属「提示词重写」分支），主线要 `qwen3vl_8b_nvfp4` + `type='qwen_image'`，接错照样跑完、出纯噪声；② **多加节点**——别加 `ModelSamplingAuraFlow`（官方 t2i 子图里没有），加了同样出纯噪声；③ **参考图写成数组**——图像编辑参考图在 API 格式里必须是**对象** `images: { image_0: ["6", 0] }`（自动增长复合输入 `COMFY_AUTOGROW_V3`），写成 `[["6",0]]` 不报错但参考图完全不生效；④ 官方模板的真实节点常藏在 **subgraph** 里（顶层只有 ResolutionSelector + 子图 + SaveImageAdvanced + MarkdownNote），要读 `definitions.subgraphs` 才看得到接线——照官方模板接，别凭想象接。
- **解法**：① 文本编码器认准 `qwen3vl_8b_nvfp4` + `type='qwen_image'`，`pe_*_w4a8` 一律不选；② 节点表里见到 `ModelSamplingAuraFlow` 就删掉；③ 参考图改成对象写法 `images: { image_0: ["6", 0] }`；④ 接线一律照官方模板 `definitions.subgraphs` 抄，别凭界面想象接。
- **验证**：出图不是噪声、参考图构图被保持。

---

## 四、生成任务问题

### 4.1 视频/音频跑一半报 `generation aborted`

- **症状**：视频工作流提交后等待中途失败，报 `ComfyUI generation aborted`。
- **原因**：视频/音频生成要几分钟，`mode: "sync"` 会等超时并中断（契约 5）。
- **解法**：**视频/音频工作流一律 `mode: "async"`**——立即返回 job id，**启动后不要阻塞等待**（别对返回的 job 用 `wait: true`），后台完成时会通知，再用 `job_output`（不 wait）收结果与媒体。图片生成可 sync（通常 <1 分钟），类型不确定也用 async。
- **验证**：`job_output` 拿到媒体；会话卡片出现结果。

### 4.2 大工作流报超时

- **症状**：`ComfyUI generation timed out after <ms> ms (prompt <promptId>)`。
- **原因**：`timeoutMs` 默认 **900000（15 分钟）**，`pollIntervalMs` 默认 1000；`connectTimeoutMs` 默认 **10000**（单次请求，视频上传/下载单独放宽到 ≥120 秒）。
- **解法**：设置页调大 `timeoutMs`（上限 3600000）；远端慢链路再考虑 `connectTimeoutMs`。
- **验证**：重跑正常出结果；`/comfyui/config` 能看到生效值。

### 4.3 后台任务卡片报「后台任务状态收集失败（已重试 n 次）」

- **症状**：异步任务卡片长时间卡在收集状态并最终报失败。
- **原因**：`GET /comfyui/jobs/media` 查 `/history`，没有记录时靠 `/queue` 区分 `queued`（仍在排队）与 `unknown`（已被清掉）（`src/routes.ts:1547`）；早期不区分，长队列被误判成「任务没了」。
- **解法**：卡片只对 `unknown` 计超时，并尝试从资产索引恢复结果（历史被清也能救回）。长队列**耐心等**，反复重跑会真的重复占用显卡。
- **验证**：排队中的卡片保持轮询、不报超时；完成后出图。

### 4.4 队列页读不出来 / 任务状态不刷新

- **症状**：队列页报「无法读取队列（ComfyUI 未运行？）」；重启 DSH 后面板里旧任务没了。
- **原因**：数据来自 ComfyUI 的 `/queue`、`/history`；`QueueTracker.sweep()` 是**「读时清扫」**——没有后台定时器，只在读 assets/queue 路由时把已完成的运行归档进资产索引（契约 4：不留裸定时器）。插件只记**本插件提交过**的 prompt（`tracked.json`）。
- **解法**：先确认 ComfyUI 在跑（2.1）；任务历史以 ComfyUI 自己为准。
- **验证**：队列页显示运行中 + 历史，插件提交的任务带进度条。

### 4.5 显存不够 / 想立刻把显存还回去

- **症状**：跑完一轮后显存仍被占着（几 GB）。
- **原因**：内存态由 ComfyUI 持有；插件**只有两个关闭口**——① 会话轮结束（`session/event` 的 `turn/end` → `shutdownNow`）；② 面板头部 `⏻`。
- **解法**：队列页「释放内存」或面板 `⏻`。`stop()` 有三重闸门：**本插件启动的**（`launched.json` 打标，跨宿主重启认回）+ **回环 baseUrl** + **没有任务在飞**；任务在飞时记成 `pending`，队列排空后补完。**用户自己手动开的 ComfyUI 永远不会被碰**，会提示原因。ComfyUI 0.39 没有退出路由（只有 `/interrupt`、`/free`），关停只能杀进程：按端口反查 PID（win32 `netstat -ano -p TCP`，其他 `lsof -iTCP:<port> -sTCP:LISTEN -t`）后 `taskkill /PID <pid> /T /F`——**不缓存 spawn 的 pid**，因为 `.bat` 启动器自己立刻退出，spawn 到的 pid 不是服务器的 pid。
- **验证**：`node scripts/test-idle.mjs`（离线自测触发口与边界，不真拉/杀进程）。
- **OOM（CUDA out of memory）**：本机暂无实机记录（待核）；临时对策是释放内存 / 关掉别的占卡进程 / 降分辨率与 batch。

### 4.6 视频模板跑不了 / 时长参数怎么传

- **症状**：内置 `video` 模板（Wan 2.1）提交失败或节点不存在；或不知道时长填哪个参数。
- **原因**：该模板需要 **ComfyUI-WanVideoWrapper** 自定义节点与 Wan 2.1 模型；视频参数是**自动识别**出的通用名：提示词、分辨率、步数、种子、**时长（`duration` / `length` / `frames`）**、宽高比（`aspect_ratio`）、加载节点。
- **解法**：装上自定义节点与模型，用 `comfyui_object_info { filter: "Wan" }` 确认节点存在（缺节点时的具体报错文案待核）；参数先 `comfyui_workflow list` 读该工作流的 `parameters` 清单，按英文 `name` 传，别自造。`aspect_ratio` 这类联动参数只传它时 `size` 会自动跟随新比例的默认尺寸（如 9:16 → 768×1376）。
- **验证**：`object_info` 列出 Wan 节点；视频 async 跑通且时长/尺寸与预期一致。

### 4.7 进度条不动

- **症状**：任务在跑但面板进度条不更新。
- **原因**：进度走 ComfyUI 的 `/ws`，是 **best-effort**——远端鉴权代理后可能根本收不到进度事件；`ProgressTracker` 会断线重连直到 dispose。
- **解法**：不是故障，看队列页与最终结果；需要进度就直连本地 ComfyUI。
- **验证**：任务最终正常完成并回显媒体。

---

## 五、关键路径与配置落点

### 5.1 运行时数据文件（换机要带走的就这些）

默认 `$DSH_HOME/data/dsh-maid-comfyui/`（未设 `DSH_HOME` 时 `~/.dsh/data/dsh-maid-comfyui`；本机实测 `C:\Users\Kayle\.dsh\data\dsh-maid-comfyui`），可用 `dataDir` 覆盖（改它要重启插件）：

| 文件/目录 | 内容 | 丢了会怎样 |
| --- | --- | --- |
| `workflows.json` | 工作流库（含参数清单与快照） | 面板工作流全空 |
| `assets.json` | 资产索引 | 资产页空（output 文件还在） |
| `current-image.json` | 加载区加载位（`null` = 空位） | 加载区清空 |
| `media-sizes.json` | 上传图像素尺寸 | 尺寸自动匹配失效 |
| `media-hashes.json` | 内容哈希 → 文件名（去重） | 重复上传会重存 |
| `tracked.json` | 本插件提交过的任务 | 队列页看不到插件任务 |
| `launched.json` | 「这个 ComfyUI 是本插件拉的」打标 | 关停闸门失灵（宁可留着也不误杀） |
| `skills/<slug>/` | 各工作流技能包（`SKILL.md` + 一层子目录） | 说明书丢失，**没有别的副本** |

`skillsDir` 可把技能包整棵树挪到别的盘/同步盘/版本库，**必须绝对路径**（相对值忽略）；它是运行时 getter 现读，设置页改完即生效，但**不会自动搬走已有目录**。

### 5.2 源码与构建产物落点

- 宿主：`src/*.ts` → `lib/`（`tsc`）；**改完要重启 DSH**。
- 浏览器：`src/client/*` → `client/client.js`（tsdown）；**改完刷新页面即可**。
- skill 文本编译进 `lib/skill.js`，属宿主侧。
- 装配：`cordis.patch.yml` 把插件以 `id: comfyui` 插入 profile 层栈；`package.json` 的 `dsh.bundle.patch` 指向它。
- 两个会拉起本地进程的点：`launch.ts`（⏻ 启动）与 `workflows/skill/reveal` 路由（在 DSH 所在机器上用 explorer/open/xdg-open 打开技能包目录，目录取自 pack store 而非请求、`spawn` 传数组不走 shell、要求同源）。**Agent 工具没有 reveal 这个能力。**

### 5.3 端口、路由与配置键

- ComfyUI 默认 `http://127.0.0.1:8188`（本机实测约 12 秒起来：torch 2.14.0+cu130 / RTX 5060 8123 MB / ComfyUI 0.39.0）。
- 本机 DSH GUI `http://127.0.0.1:19387`；插件全部路由挂在 `/comfyui/` 前缀下，写操作要求同源。探活三连：`GET /comfyui/ping`、`POST /comfyui/test`、`GET /comfyui/config`（脱敏，含 `skillsDir`/`launchCommand`/`canLaunch` 与生效的 `skillsRoot`）。
- 媒体路由（唯一能吐图片字节的同源口）：`/comfyui/media?file=X&subfolder=&type=output`。`dsh-app://` 壳内同样可探，根路径 401 是鉴权正常现象。
- 冒烟脚本 `scripts/run-cg-portrait.mjs` / `run-16x9.mjs` 默认打 `http://127.0.0.1:3080`（旧 webServer 端口；本机现为 19387，跑前按需改或传参）（待核）。
- `cordis.yml` 的 `comfyui` 段主要键：`baseUrl`、`apiKeyEnv`、`dataDir`、`comfyuiDirs`、`launchCommand`、`launchDir`、`outputDir`、`mediaHost`、`skillsDir`（默认空即自动推断）。

### 5.4 客户端界面落点（换主题/换机后常见的观感问题）

- **面板透明**：底色固定为 `var(--dsc-panel-surface, #121f41)`（`src/client/styles.ts`）。早期取主题变量 `--dsw-alias-bg-layer-2`，某些皮肤把它压到很低透明度，视频背景直接透上来。**写死色值必须逐字核对**——曾把 `#121f41` 写成 `#121f43`，用户照旧反馈「还是透明」。改的是客户端文件，`build:client` 后**刷新页面即生效**。
- **顶部浮层点不动（2026-10-15 报障）**：宿主 Windows Electron 外框有一条 caption 高度的伪元素（`.BynINW_frame:before`）铺着 `-webkit-app-region: drag`，而宿主只在 macOS 分支给 `button/a/input` 隐式 `no-drag`。后果：连接提醒条写死 `top: 14px` 正好落在标题栏条带里，**整条 toast 上的点击（包括关闭 ✕）全被当成拖窗口吞掉，弹窗关不掉**。规矩：所有插件浮层（`.dsc-conn-toast` / `.dsc-panel` / `.dsc-picker-overlay` / `.dsc-lightbox`）显式写 `-webkit-app-region: no-drag`（toast 再补 `.dsc-conn-toast *` 覆盖子元素）；顶部定位用 `top: var(--dsh-frame-overlay-top, 14px)`，**不要写死像素**。
- 面板几何信息存 localStorage；标题栏 `↺` 复位位置与大小并清 localStorage（换显示器后位置跑到屏幕外时用它）。

### 5.5 技能包与预设包的尺寸上限（导入「假死」时先看这里）

- 技能包尺寸按**文件类型**限制：文本 256KB、二进制（`ASSET_EXTENSIONS`）4MB、每包 **20MB / 2000 文件**；单次 `comfyui_skill read` 超过 **40k 字符**截断。
- 预设导入大包（上千文件）时逐文件写会退化成 O(n²) 文件系统调用，表现为**导入假死数分钟**——已知代价，`applyImportPackage` 已做批量写与一次限额检查。
- 安全姿态：文件系统路径**从不取自 zip 条目名**，落盘目录由 `skillSlug(新名, 新id)` 现生成；`version` 主版本更新拒绝导入；重名追加「（导入）」后缀，始终创建为新工作流、不覆盖现有库。

---

## 六、排查手法

### 6.1 先分阶段，再定位（最重要的一条经验）

报错发生在**提取阶段**还是**执行阶段**，决定完全不同的排查方向。实例：看到「包含未注册的 UI-only 节点 "<uuid>"」时顺着「模型路径没适配」猜，方向完全错了——真因是子图（3.2）。同理「工作流跑不起来」要先分清是画布图（没提取）、参数（快照过期），还是 ComfyUI 端（模型/节点缺失）。

### 6.2 探活与连线三连

```bash
curl -s http://127.0.0.1:8188/system_stats          # ComfyUI 本身活没活
curl -s http://127.0.0.1:19387/comfyui/ping         # 插件半边活没活（预期 200）
curl -s http://127.0.0.1:19387/comfyui/config       # 生效配置（脱敏）
```
`POST /comfyui/test` 是设置页「测试连接」走的那条，报错文案最直白。

### 6.3 Agent 侧的自助查证

- `comfyui_workflow list`：一次拿到工作流库、ComfyUI 端图工作流（含 `extracted`/`derived`）、`loadArea`（用户放了什么素材）、`env`（`baseUrl` + `comfyuiDirs`）。**需要地址或目录先跑这一条，不要反复问用户。**
- `comfyui_object_info { filter: "类名子串" }`：确认节点真实存在（缺自定义节点的第一手证据）。
- `comfyui_workflow action: get { id }`：只在**诊断**时用（输出完整 JSON，很费 token，**不是运行路径**）。
- `comfyui_workflow action: skill` / `comfyui_skill action: list|read`：看工作流技能包（用户写的说明书优先于通用经验）。
- 队列页 / `GET /comfyui/jobs/media?promptId=…`（`queued` / `running` / `completed` / `failed` / `unknown` 五态）/ 资产页。

### 6.4 离线自测（不连 ComfyUI，构建后可直接跑）

```sh
node scripts/test-store-params.mjs    # 参数保存/重载
node scripts/test-skillpack.mjs       # 技能包 CRUD / 尺寸上限 / 路径穿越防护
node scripts/test-transfer.mjs        # 预设导出→分析→导入回环（zip-slip / 版本拒绝）
node scripts/test-convert.mjs         # 画布分析与图→API 转换回归
node scripts/test-subgraph-to-api.mjs # 子图转换器（纯离线 fixture）
node scripts/test-launch.mjs          # 一键启动判据（不真拉服务）
node scripts/test-idle.mjs            # 关闭请求的触发口与边界（不真拉/杀进程）
node scripts/test-host-compat.mjs     # 宿主兼容缝（需先 build:host）
```
真机冒烟：`node scripts/run-cg-portrait.mjs` / `run-16x9.mjs`（需 DSH + ComfyUI 都在运行）。

### 6.5 会话日志检测（动过「注入消息」就必须跑）

```sh
node scripts/analyze-sessions.mjs    # 只读扫描，逐帧解压找缺 id 的 message 事件
node scripts/inspect-tool-meta.mjs   # 按 promptId 查会话日志里的 tool-result meta（排查媒体回显）
```
日志是 Zstandard 压缩的 JSONL，逐帧解压才能读全：
```sh
node -e "console.log(require('node:zlib').zstdDecompressSync(require('fs').readFileSync(process.argv[1])).toString())" <session.jsonl.zstd>
```
目录：`$DSH_HOME/sessions/<工作区>/<会话id>/session.v4.jsonl.zstd`（本机 `C:\Users\Kayle\.dsh\sessions\--D-DeepSeek~0020Harness-Works--/…`）。

### 6.6 改动的生效边界（别白折腾）

| 改了什么 | 怎么生效 |
| --- | --- |
| `src/*.ts`（tools/routes/store/params/skill/launch/idle…） | **重启 DSH** |
| `src/client/*`（panel/settings/styles/i18n…） | `build:client` 后**刷新页面** |
| `cordis.yml` 的 `dataDir` / `maxAssets` / `outputDir` | 重启（这几个不是 volatile） |
| 其余设置页字段 | 保存即生效，无需重启 |
| 工作流参数快照 | `action: refresh`（否则报 allowed options） |

### 6.7 症状 → 章节速查

| 症状关键词 | 去看 |
| --- | --- |
| 装不上 / dsh 起不来 / 风险横幅 / 装配断链 / 构建失败 | 1.1–1.6、6.6 |
| `without inject` / `no volatile fields` / 会话打不开 | 1.6–1.8、6.5 |
| 「无法连接 ComfyUI」/ 队列读不到 / 黑窗关不掉 / `launch-timeout` | 2.1、2.2、4.4 |
| 反代 404 / 加载区空 / 删不掉资产 / 媒体 404 / 库空 | 2.3–2.7 |
| 「非 API 流程」/ 未提取 / 多分量 / UUID 节点 / 出纯噪声 | 3.1–3.3、3.9 |
| KeyError / 输入错位 / `missing 'codec'` / `required_input_missing` | 3.4、3.5 |
| `not one of the allowed options` / 参数不生效 / 必读拦截 | 3.6–3.8 |
| `generation aborted` / 超时 / 后台任务收集失败 / 显存 / 进度条 | 4.1–4.7 |
| 面板透明 / 顶部浮层点不动 / 导入假死 | 5.4、5.5 |

### 6.8 两台机器对同一段活各打了一个同名 tag，fetch 被拒

- **症状**：公司机与家里机在各自分支上把同一版工作流封了同一个版本号（`v0.5.4`），先后推送后 `git fetch --tags` 报 `! [rejected]        v0.5.4 -> v0.5.4  (would clobber existing tag)`，本地 tag 推不上去，`git describe` 在两台机器上给出不同的提交。
- **原因**：打 tag 之前没有比对远端同名 tag。两台机器各自把「当前 HEAD」当成了同一个版本号，而两边的 HEAD 并不是同一个提交；git 默认拒绝用本地 tag 覆盖同名远端 tag，于是 fetch 阶段就中止，而不是推到远端才失败。tag 指向的提交不同（家里机那一轮 `72c498a`，公司机那一轮 `a4019e2`）之后，`git describe` 与版本号引用就失去了唯一性。
- **解法**：先取证再决定，别直接重打：
  1. 逐条比对——`git rev-parse 'vX.Y.Z^{commit}'` 与 `git ls-remote --tags <remote> 'refs/tags/vX.Y.Z'`，把同名 tag 在两台机器上指向的 SHA 列成表；
  2. 确认哪一边是「该版本真正的内容」以后，**由老大拍板**保留哪一边（本次决策是保留家里机那一轮、以远端为准），再 `git push origin --tags --force`（2026-10-16 处置，远端 `v0.5.4` 由 `72c498a` 改为 `a4019e2`）；
  3. 另一台机器下次同步时先 `git fetch --tags` 再 `git tag -f vX.Y.Z <正确提交>`，不要靠删 tag 重建。
- **验证**：`git ls-remote --tags origin` 与两台机器的 `git rev-parse 'v0.5.4^{commit}'` 三处 SHA 一致；`git fetch --tags` 不再出现 `would clobber existing tag`。
- 证据：记忆 `0mvaxbrdr-aa6b2a2000f14bf0819b207597`（2026-10-16 结案）；复验日期 2026-10-18。
- **教训**：版本号是全局命名空间，不是本地动作。打 tag 前先 `git ls-remote --tags` 看一眼远端有没有同名，比事后 `--force` 便宜得多。
