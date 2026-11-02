# Comfy Infinity

个人自用的本地 AI 创作工作台：**无限画布 × ComfyUI**。不依赖云端 API，模型和工作流都在本机运行。

## 功能

- 无限画布：文本、图片、视频、配置、分组、自由卡片节点；连线、框选、导出、自动保存。
- 本地模型配置：把 ComfyUI 工作流暴露成 OpenAI 兼容模型，画布只连本地模型配置服务。
- 图像：Z-Image Turbo、Krea2、MOSS SFT、Qwen Image 2.1（编辑 / 重绘 / 扩图 / 多角度）。
- 视频：MiniMax-H3 文生、首尾帧、多参、角色替换；支持预览和取消。
- 放大：ESRGAN、SeedVR2 图片/视频超分。
- 自由卡片：把 ComfyUI 里已有的工作流导入画布，首次导入时自动转换为 API 工作流。
- 本地提示词：Qwen3.5-9B 与 Florence-2；不装也可用云端反推。
- 系统状态：显存、内存、GPU、ComfyUI 状态，清理显存，一键重启 ComfyUI，关闭工作台。

## 架构

```text
ComfyInfinity.exe（推荐） / start-desktop.bat（开发）
  └─ launcher/desktop         Electron 单窗口工作台（托盘 + 三个标签页）
       └─ launcher/start.mjs
            ├─ ComfyUI          :8188   检测 / 接管 / 拉起
            ├─ comfyui-gateway  :8190   OpenAI 兼容模型配置 + 任务 / 预览 / 系统接口
            ├─ canvas           :3000   托管 infinite-canvas/web/dist
            └─ control          :8290   控制台页面 + 状态 / 启停 / 日志接口

画布 :3000  →  模型配置 :8190  →  ComfyUI :8188
```

画布 3000 被占用时回退到 3001–3010；模型配置端口默认 8190。

## 启动

### 推荐：双击 `ComfyInfinity.exe`

- 无控制台黑窗，启动过程在后台完成。
- 首次启动如果缺少 Electron，会先显示「正在下载资源」页面，展示百分比和已写入大小；资源准备完成后自动进入工作台。
- 关闭窗口只是收进托盘；从托盘「退出」才会结束工作台。

### 开发者：`start-desktop.bat`

用于从源码调试桌面外壳，行为与 exe 基本一致。首次运行会在 `launcher/desktop` 下安装依赖，因此可能看到控制台窗口。

桌面外壳会以子进程方式运行 `launcher/start.mjs` 拉起全部服务，自身只负责窗口、托盘和退出清理。

## 桌面工作台

统一窗口顶部有三个标签：

- **控制台**：服务状态、启停、日志、配置查看。
- **画布**：无限画布创作界面。
- **模型配置**：ComfyUI 目录、工作流、模型和资源管理。

顶部导航栏同时承载全局主题切换；深浅色会同步到三个标签页，并更新窗口按钮配色。窗口关闭后仍驻留托盘，双击托盘可重新打开控制台。

## 控制台能力

- 查看 ComfyUI、模型配置、画布的在线状态、地址和 PID。
- 启动 / 停止 / 重启模型配置，启动 / 停止 / 重启 ComfyUI，选择 ComfyUI 启动路径。
- ComfyUI 启动失败会立即停止等待、自动尝试其他已发现的安装目录，并在服务行显示失败原因，方便切换路径后重试。
- 查看显卡、内存占用和启动器实时日志（默认折叠；超过 5MB 启动时轮转为 `launcher.log.1`，日志面板可清空）。
- 打开画布、模型配置，或直接关闭整个工作台。

## 首次启动

1. 桌面依赖缺失时，启动器会显示下载页并自动执行安装，完成后进入工作台。
2. 网关依赖缺失时，会优先从随包的 `launcher/gateway-deps.zip` 自动修复，无需手动 `npm install`。
3. 启动器不会自动推断 ComfyUI 路径；路径为空或无效时会弹窗提示选择。
4. 默认工作流会在启动时补齐；已有用户工作流不会被覆盖。
5. 模型权重不会自动打包，需要按工作流在模型配置页下载，或手动放进 ComfyUI 对应目录。

## 快速开始

1. 确保本机有可运行的 ComfyUI。
2. 按需复制并修改 `launcher/config.example.json` 为 `launcher/config.json`；首次启动路径为空或无效时，控制台会弹窗提示选择 ComfyUI 安装目录。
3. 双击 `ComfyInfinity.exe`（或运行 `start-desktop.bat`）。
4. 在模型配置页确认 ComfyUI 目录、模型目录和工作流目录。

模型配置页地址：`http://127.0.0.1:8190/admin`。

## 构建

画布、模型配置页和网关的构建产物都已随仓库提供。修改源码后重新构建：

```powershell
# 画布
cd infinite-canvas\web
npm install --legacy-peer-deps
npm run build

# 模型配置页
cd comfyui-gateway\admin
npm install
npm run build

# 网关后端
cd comfyui-gateway\server
npm run build
```

修改 `launcher/launcher.cs` 后重新编译便携启动器：

```powershell
powershell -ExecutionPolicy Bypass -File launcher\build-launcher.ps1
```

## 目录

```text
ComfyInfinity.exe       便携启动入口（静默启动 + 首次下载页）
start-desktop.bat       开发用启动入口
infinite-canvas/        React + Vite 画布（web/src 源码，web/dist 构建产物）
web/public/plugins/     本地 LoRA / ComfyUI 参数插件
comfyui-gateway/        模型配置与网关容器（共享 workflows/resources/prompts/data）
comfyui-gateway/server/ 后端工程（TypeScript + Express，src 源码，dist 构建产物）
comfyui-gateway/admin/  模型配置页（Vite + React + TypeScript，dist 构建产物）
launcher/               启动器（检测/接管 ComfyUI、拉起服务、托管画布）
launcher/desktop/       Electron 单窗口外壳（shell.html + 标签页 + 托盘）
```

## 环境要求

- Windows 10/11，NVIDIA 或 AMD GPU。
- Node.js 24+（发布包自带 `node/node.exe`）。
- 一份可运行的 ComfyUI。

模型权重、LoRA、自定义节点和 ComfyUI 本体不在仓库内；由模型配置页按工作流下载，或手动放进 ComfyUI 对应目录。

## 接口

- 健康检查：`GET http://127.0.0.1:8190/health`
- 模型列表：`GET http://127.0.0.1:8190/v1/models`
- 模型配置页：`http://127.0.0.1:8190/admin`
- 工作流注册表：`comfyui-gateway/workflows/registry.json`

详细接口和环境变量见 `comfyui-gateway/README.md`。

## 安全提示

- 模型配置、ComfyUI、启动器控制接口默认只绑 `127.0.0.1`，没有鉴权。
- 不要把 `:8188`、`:8190`、`:8290` 暴露到公网或不可信局域网。
- 不要提交 `launcher/config.json`、`comfyui-gateway/data/`、任务输出、模型权重和任何密钥。

## 署名与许可证

本项目基于 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas) v0.20.0（MIT，Copyright (c) 2026 basketikun）修改，保留其许可证与版权声明，详见 `infinite-canvas/LICENSE` 和 `NOTICE.md`。

`comfyui-gateway`、`launcher` 及本地集成修改的原始版权归 1314521gjy 所有（MIT）。本个人分支在其基础上做单机化改造，许可证见根目录 `LICENSE`。

ComfyUI 本体、模型权重、LoRA 和第三方节点适用各自许可证，详见 `THIRD_PARTY_NOTICES.md`。
