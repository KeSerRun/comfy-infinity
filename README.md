# Comfy Infinity

个人自用的本地 AI 创作工作台：**无限画布 × ComfyUI**。不依赖云端 API，模型和工作流都在本机运行。

## 功能

- 无限画布：文本、图片、视频、配置、分组、自由卡片节点；连线、框选、导出、自动保存。
- 本地网关把 ComfyUI 工作流暴露成 OpenAI 兼容模型，画布只连本地网关。
- 图像：Z-Image Turbo、Krea2、MOSS SFT、Qwen Image 2.1（编辑 / 重绘 / 扩图 / 多角度）。
- 视频：MiniMax-H3 文生、首尾帧、多参、角色替换；支持预览和取消。
- 放大：ESRGAN、SeedVR2 图片/视频超分。
- 自由卡片：把 ComfyUI 里已有的工作流导入画布，首次导入时自动转换为 API 工作流。
- 资源中心：按工作流检查并安装缺失的模型、LoRA、节点和运行库。
- 本地提示词：Qwen3.5-9B 与 Florence-2 按需安装；不装也可用云端反推。
- 系统状态：显存、内存、GPU、ComfyUI 状态，清理显存，一键重启 ComfyUI，关闭工作台。

## 架构

```text
start-local.bat
  └─ launcher/start.mjs
       ├─ ComfyUI         :8188   检测 / 接管 / 拉起
       ├─ comfyui-gateway :8190   OpenAI 兼容网关 + 任务/预览/系统接口
       ├─ canvas          :3000   托管 infinite-canvas/web/dist
       └─ console         :8290   启动器控制台（状态 / 启停 / 日志）

画布 :3000  →  网关 :8190  →  ComfyUI :8188
控制台 :8290  →  启动器控制接口
```

画布 3000 被占用时回退到 3001–3010；网关端口默认 8190。

## 启动器控制台

启动后默认打开 `http://127.0.0.1:8290/`（由 `controlPort` 决定）：

- 查看 ComfyUI、网关、画布的在线状态、地址和 PID。
- 启动 / 停止 / 重启网关，启动 / 停止 / 重启 ComfyUI，打开画布与网关管理页。
- 查看显卡、内存占用和启动器实时日志。
- 关闭整个工作台。

不想自动打开可设置 `launcher/config.json` 的 `"openConsole": false`，恢复直接打开画布。

## 快速开始

1. 安装网关依赖：`cd comfyui-gateway && npm install`
2. 安装画布依赖并构建：`cd infinite-canvas\web && npm install --legacy-peer-deps && npm run build`
3. 按本机路径复制并修改 `launcher/config.example.json` 为 `launcher/config.json`；也可以让启动器自动发现 ComfyUI。
4. 双击 `start-local.bat`。

首次启动后，在画布右上角「配置 → 添加工作流」里确认 ComfyUI 目录、模型目录和工作流目录。自由卡片会读取 ComfyUI 用户工作流目录（默认 `...\ComfyUI\user\default\workflows`）。

## 目录

```text
infinite-canvas/       React + Vite 画布（web/src 源码，web/dist 构建产物）
web/public/plugins/    本地 LoRA / ComfyUI 参数插件
comfyui-gateway/       Node.js + Express 本地网关
launcher/              启动器（检测/接管 ComfyUI、拉起网关、托管画布）
start-local.bat        Windows 一键启动
```

## 环境要求

- Windows 10/11，NVIDIA GPU。
- Node.js 24+（发布包自带 `node/node.exe`）。
- 一份可运行的 ComfyUI。

模型权重、LoRA、自定义节点和 ComfyUI 本体不在仓库内；由资源中心按工作流下载，或手动放进 ComfyUI 对应目录。

## 网关

- 健康检查：`GET http://127.0.0.1:8190/health`
- 模型列表：`GET http://127.0.0.1:8190/v1/models`
- 管理页：`http://127.0.0.1:8190/admin`
- 工作流注册表：`comfyui-gateway/workflows/registry.json`

详细接口和环境变量见 `comfyui-gateway/README.md`。

## 安全提示

- 网关、ComfyUI、启动器控制接口默认只绑 `127.0.0.1`，没有鉴权。
- 不要把 `:8188`、`:8190`、`:8290` 暴露到公网或不可信局域网。
- 不要提交 `launcher/config.json`、`comfyui-gateway/data/`、任务输出、模型权重和任何密钥。

## 署名与许可证

本项目基于 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas) v0.20.0（MIT，Copyright (c) 2026 basketikun）修改，保留其许可证与版权声明，详见 `infinite-canvas/LICENSE` 和 `NOTICE.md`。

`comfyui-gateway`、`launcher` 及本地集成修改的原始版权归 1314521gjy 所有（MIT）。本个人分支在其基础上做单机化改造，许可证见根目录 `LICENSE`。

ComfyUI 本体、模型权重、LoRA 和第三方节点适用各自许可证，详见 `THIRD_PARTY_NOTICES.md`。
