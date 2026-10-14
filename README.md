# dsh-maid-comfyui

[English](README.en.md) | **中文**

<p align="center">
  <img src="logo.png" width="480" alt="dsh-maid-comfyui logo" />
</p>

<h1 align="center">dsh-maid-comfyui</h1>

<p align="center">让 DeepSeek Harness 的 Agent 智能驱动本地或远程 ComfyUI 生成任何内容。附带工作流、资产管理面板与技能包管理挂载。配套 skill 与同源媒体代理。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-maid-comfyui"><img src="https://img.shields.io/npm/v/dsh-maid-comfyui" alt="npm version" /></a>
  <a href="https://www.npmjs.com/package/dsh-maid-comfyui"><img src="https://img.shields.io/npm/dm/dsh-maid-comfyui" alt="npm downloads" /></a>
  <img src="https://img.shields.io/npm/l/dsh-maid-comfyui" alt="license" />
</p>

> **版本配对（选对 dsh 版本再装，否则 dshmarket 会报风险提示）**：
>
> | dsh-maid-comfyui | 配对的 DeepSeek Harness | 说明 |
> | --- | --- | --- |
> | **0.5.x（最新，`latest` tag）** | **≥ 0.1.2**（含 0.1.5 / 0.1.6 / 0.1.7 预发布版） | 0.5.3 起兼容 dsh 0.1.7 的设置机制（设置页保存直接生效，无需重启） |
> | **0.3.x（beta 线，`beta` tag）** | **0.1.1** | 老版本 dsh 请留在 0.3.x 线 |
>
> 安装：`dsh plugin --profile web add dsh-maid-comfyui`（装最新 0.5.x）/ `dsh plugin --profile web add dsh-maid-comfyui@beta`（老宿主装 0.3.x）。

## 功能

### Agent 工具

Agent 直接驱动 ComfyUI，无需手动操作画布：

- `comfyui_run` —— 提交 API 格式工作流或内置模板（txt2img / img2img / video），返回生成媒体；`mode: "sync"` 等待结果，`mode: "async"` 后台任务（视频生成强烈建议）。
- `comfyui_object_info` —— 列出服务器支持的节点定义，让 Agent 现场构造合法工作流。
- `comfyui_workflow` —— 管理插件工作流库：`list`（含服务器地址、本机 ComfyUI 目录、加载区素材、每个工作流的参数清单）、`run`（按 id 运行 + 参数覆盖）、`skill`（按需读取某工作流的技能包）、`refresh`（重算参数快照）。
- `comfyui_skill` —— 读写工作流技能包（`list` / `read` / `write` / `append` / `mkdir` / `rename` / `delete` / `enable` / `require`），Agent 可把踩坑经验写回技能包，跨会话复用。

### UI 面板

右侧停靠面板，三个页签：

- **工作流** —— 可运行工作流库（新建 / 编辑 / 运行 / 删除 / 导入 `.json`，标签分类 + 下拉筛选）；支持**预设导出 / 导入**：把选中的工作流（默认全选，带技能包的行有标注）连同参数与技能包打包成 `.zip` 预设包带走，导出完成后的回执显示实际打包的工作流名单、文件名、体积与警告；把预设包**拖进对话框**（或点选文件）即可整包分析、按需导入，技能包原样完整还原（上千文件的模板大包也没问题），始终创建为新工作流、不覆盖现有库；自动检测 ComfyUI 端保存的图工作流，支持**提取**为可运行工作流（画布含多个独立流程时可选整体 / 按分量 / 主流程）。
- **资产** —— 所有生成结果，预览、下载、悬停可删除（同步清理 ComfyUI 输出目录里的文件）。
- **队列** —— 实时队列 + 历史任务五态展示，支持删除 / 中断 / 重跑 / 清空 / 释放内存，插件提交的任务带进度条与预览。

点击会话头部的「ComfyUI 面板」按钮时会自动探测后端与 ComfyUI 的连接：连接正常时静默（仅在不通→恢复时短暂显示「连接正常」）；连不上时页面顶部弹出提醒说明具体原因，并且**面板照常打开**——提醒条上有「启动本地 ComfyUI」与「去设置页」两个出口，随时可以关掉，不会把窗口卡住。

「启动本地 ComfyUI」只在两件事都成立时出现：设置页 `启动命令` 非空，且服务器地址指向本机（回环地址）。点它会在本机跑你填的命令（如 `D:\ComfyUI_windows_portable\python_embeded\pythonw.exe -s ComfyUI\main.py --windows-standalone-build`，工作目录填便携版根目录），然后每 1 秒探一次、最多等 90 秒；起来了就直接进面板，超时/失败会把原因写在提醒条里（同一失败的 10 秒内不重复启动）。远程服务器不显示这个按钮。

> 想让启动过程完全无窗口，命令里用便携版的 `python_embeded\pythonw.exe`，别用自带的 `run_nvidia_gpu.bat`：那个 bat 结尾有 `pause`，且由 `cmd` 拉起的控制台窗口会一直挂着。

反过来也管：**本插件启动的**那个 ComfyUI，空闲 `idleShutdownMinutes`（默认 10 分钟）没人用就会自动关掉，把几 GB 显存还回去——你手动开的那个永远不会被关，有任务在排队 / 在跑也不会关。设置页那项填 `0` 即彻底关掉这个行为；想立刻停，按旁边的「立即停止」。

<p align="center"><img src="images/panel.png" width="70%" alt="插件主面板：工作流 / 资产 / 队列" title="插件主面板：工作流 / 资产 / 队列" /></p>

### 加载区（媒体加载器）

工作流页顶部的媒体加载器，仿 ComfyUI LoadImage 节点：图片 / 视频 / 音频可视化选择（可就地试听）、粘贴上传、多加载位。已放入的素材按顺序自动填进工作流里未显式指定的加载参数——**Agent 不需要猜文件名**；未传 `width`/`height` 时自动匹配源图分辨率。上传按内容哈希去重命名。

`comfyui_workflow list` 的 `loadArea` 字段会把加载位数与内容暴露给 Agent。

### 工作流技能包（给 Agent 的说明书）

参数清单只能告诉 Agent"有哪些旋钮"，说不出"这个工作流适合什么、哪一步会翻车"。复杂工作流可以挂一个**技能包**（面板工作流卡片上点「技能包」按钮启用）：

```
<数据目录>/skills/<工作流>/
  SKILL.md          # 主文档：适用场景 / 关键参数 / 注意事项
  references/       # 参考文档：风格合集、排错记录
  assets/           # 参考图等素材（可在面板预览）
```

- **按需三级披露，不占常驻上下文**：`comfyui_workflow list` 只有一行摘要 → 选中工作流后 `action: skill` 取正文 → 正文点名某份参考文档时才读那一篇。几十个工作流各带整套文档，平时对话成本也只是一行摘要。
- **面板编辑**：左栏文件列表 + 右栏编辑器，支持导入（按扩展名自动分目录）、自定义子目录、图片预览、把整个技能包目录挪到别的盘或同步盘（设置页 `技能包目录`）。
- **Agent 也能写**：`comfyui_skill` 工具让 Agent 查看/编写技能包——踩到坑就 `append` 进 SKILL.md，下次（换个会话也一样）直接复用经验。
- **运行前必读**：可勾选「运行前必读」，勾上后 Agent 本会话没读过该技能包就调 `run` 会被拒绝并提示先读。

### 媒体代理与设置

生成文件经同源路由（`/comfyui/media`）按文件名转发，不依赖 ComfyUI 内存态历史——重启或清空历史后旧结果照样能打开。浏览器不直接接触 ComfyUI：无 CORS、无混合内容、API Key 不下发。

DH 设置页新增 "ComfyUI" 分区：服务器地址、API Key 环境变量名、启动命令与工作目录、空闲自动关闭、本机 ComfyUI 目录、媒体访问地址、测试连接、界面语言切换，改完即生效，无需改 `cordis.yml`。

## 安装

```sh
# web profile
dsh plugin --profile web add dsh-maid-comfyui
# desktop profile
dsh plugin --profile desktop add dsh-maid-comfyui
```

装完**重启应用即可**：侧边栏出现面板入口，设置页出现 "ComfyUI" 分区，Agent 立即获得全部工具与配套 skill。

> **不用手改 profile**：安装器（`dsh plugin add` / 插件市场）会自己把依赖写进 `package.json`、把本包加进 `dsh.profile.bundles`，并应用包内的 bundle patch——宿主 `dsh-plugin-manager` 的 reconcile 步骤会收编每一个带 `dsh.bundle` 字段的新依赖。本机 ComfyUI 路径这类**机器特定值**走设置页（改完即生效，无需重启），不必写进 profile 的 `cordis.patch.yml`。

## 使用

直接告诉 Agent，例如：

- "用 ComfyUI 画一张红猫的图"
- "把这幅图转成赛博朋克风格"
- "把加载区这张动漫图转成真人照片，分辨率跟原图一致"
- "生成一段 5 秒的短视频：日落下的城市"
- "用我之前在 ComfyUI 里保存的 Krea-Afterlight 跑一下"（若该图还没提取，Agent 会转告你先去面板点**提取**）

远程 ComfyUI 若位于需鉴权的代理之后，通过凭据存储或 `apiKeyEnv` 指定的环境变量（默认 `COMFYUI_API_KEY`）提供密钥，绝不发给浏览器。

### 子图工作流（画布把主体封进了 subgraph）

新版 ComfyUI 画布可以把一整段流程收进**子图**，存盘后顶层只剩一个 type 等于子图 UUID 的实例节点。这类图工作流**面板里提取不了**——分析器把子图当黑盒，会报「包含未注册的 UI-only 节点 "<uuid>"」。两条路：

1. **在 ComfyUI 里转回普通节点**：右键子图 → `Unpack`（展开），保存后再到面板点**提取**。
2. **用仓库自带的转换器**（离线、可脚本化，不用动画布）：

```bash
node scripts/subgraph-to-api.mjs <画布工作流.json> [输出.json]
# 选项：--base-url <url>    ComfyUI 地址（默认 http://127.0.0.1:8188），用它实时拉 object_info
#       --object-info <file> 改用本地 object_info 转储（离线 / 不连 ComfyUI）
#       --quiet              不打印转换后的工作流 JSON
```

它做两件事：先把子图实例**内联摊平**（`-10` / `-20` 两个虚拟端口接成真连线），再按 `object_info` 契约把画布图转成可 `POST /prompt` 的 API 格式。产物可直接经 `/comfyui/workflows` 路由存进本插件的工作流库。

转换规则（都已实测校验，改脚本前先看这几条）：

- 子图实例的 `widgets_values` 按**子图定义的槽位顺序**对齐，只有 widget 型槽（STRING/INT/FLOAT/BOOLEAN/COMBO）占一格——**该槽就算有外部连线也照样占一格**，数错就整条错位。
- 节点的 `widgets_values` 顺序 == `object_info` 的 required 全部 → optional 全部（只算 widget 型）；`control_after_generate` 多占一格、消费后丢弃；`forceInput` 的 widget 不占格；`COMFY_DYNAMICCOMBO_V3` 的 master 占一格、子项名是 `master.sub`。
- Autogrow 组（`COMFY_AUTOGROW_V3`）的输入名**必须保留组前缀**（`images.image0`），剥掉会让 `/prompt` 返回 400 `required_input_missing`。
- 只存在于画布上的前端节点（`MarkdownNote`、`ImageCompare` 等）按 `object_info` 里是否含前端专属输入类型来识别并跳过。

自测：`node scripts/test-subgraph-to-api.mjs`（纯离线 fixture，不连 ComfyUI）。

## 配置

`cordis.yml` 的 `comfyui` 段（多数可在设置页改）：

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8188` | ComfyUI 服务器地址 |
| `apiKeyEnv` | `COMFYUI_API_KEY` | 可选 API Key 的环境变量 / 凭据名 |
| `dataDir` | *（DSH 数据目录）* | 工作流库与资产索引存放位置 |
| `comfyuiDirs` | `[]` | 本机 ComfyUI 安装目录列表（可多条），Agent 据此定位 models、自定义节点、TTS 音色库 |
| `launchCommand` | `''` | 本机 ComfyUI 的启动命令（面板「启动本地 ComfyUI」按钮执行它）。留空 = 不显示按钮 |
| `launchDir` | `''` | 启动命令的工作目录（便携版填其根目录）。留空 = 本插件运行目录 |
| `idleShutdownMinutes` | `10` | 空闲这么久没人用，就停掉**本插件启动的**那个 ComfyUI，把显存还回去。`0` = 不自动关闭 |
| `outputDir` | `''`（自动推断） | ComfyUI 输出目录（删除资产时定位文件用） |
| `mediaHost` | `''`（自动检测） | 生成媒体的外网访问基址 |
| `skillsDir` | `''`（默认 `dataDir/skills`） | 技能包根目录（绝对路径，可放同步盘 / 版本库） |

## 环境要求

- DeepSeek Harness（`web` / `desktop` profile）
- 一个运行中的 [ComfyUI](https://github.com/comfystack/ComfyUI) 服务器（默认 `http://127.0.0.1:8188`）
- `video` 模板需要 [ComfyUI-WanVideoWrapper](https://github.com/kijai/ComfyUI-WanVideoWrapper) 与 Wan 2.1 模型

## License

MIT