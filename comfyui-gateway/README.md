# comfyui-gateway

把本地 ComfyUI 工作流暴露成 OpenAI 兼容模型，供 Infinite Canvas 直接调用。画布不需要改请求层，只要把渠道 Base URL 指到网关。

## 架构

```text
Infinite Canvas :3000
  └─ OpenAI 兼容请求（/v1/images/*、/v1/videos、/v1/prompts/*）
       └─ comfyui-gateway :8190
            ├─ workflows/registry.json   工作流 = 模型
            ├─ bindings                 画布参数 → ComfyUI 节点输入
            ├─ tasks                    异步任务 + 输出缓存
            └─ ComfyUI :8188            /prompt → /history → /view
```

## 主要接口

- `GET /health`
- `GET /v1/models`
- `POST /v1/images/generations`
- `POST /v1/images/edits`
- `POST /v1/images/upscale`
- `POST /v1/videos`
- `POST /v1/videos/upscale`
- `GET /v1/videos/:id`、`GET /v1/videos/:id/content`、`POST /v1/videos/:id/cancel`
- `POST /v1/prompts/optimize`、`POST /v1/prompts/optimize-image`
- `GET /api/setup/status`、`GET /api/workflows`、`GET /api/workflows/:id/schema`
- `GET /api/workflow-files/raw`、`GET /api/workflow-files/open`（在 ComfyUI 中打开任意内置或已发现工作流）
- `GET /api/system/stats`、`POST /api/system/free-memory`、`POST /api/system/restart-comfy`
- `GET /api/loras`
- 管理页：`/admin`（工作流浏览、ComfyUI 目录配置）

## 工作流

管理页会直接列出 `workflows/` 顶层以及已选 ComfyUI 工作流目录中的 JSON 文件，不再有导入或注册接口。`workflows/registry.json` 仅作为内置工作流的绑定/参数元数据，不会被管理页写入。工作流表格支持搜索、每页 5 条分页，以及每行的「修复」按钮：点击后会安装工作流缺失的模型、运行库和节点。

`workflows/registry.json` 当前包含 23 个条目，分为：

- 图像生成：Z-Image Turbo、Krea2 Aesthetics、MOSS SFT 8 步 / 50 步、Qwen Image 2.1（edit / inpaint / outpaint）。
- 视频：MiniMax-H3 文生、首尾帧、多参、角色替换。
- 文本：参考图反推提示词（Qwen3.5-9B / Florence-2）。
- 音频：ACE-Step 1.5 文生音乐。
- 放大/超分：ESRGAN、SeedVR2 图片、SeedVR2 视频。
- 自动发现的诊断工作流标记为 hidden，不进入 `/v1/models`。

**模型权重、LoRA、自定义节点和 ComfyUI 本体不随仓库分发。** 缺少模型/节点的工作流会在扫描时标记不可用，不会出现在 `/v1/models`。

## 安装与运行

正常情况下由根目录的 `start-desktop.bat` 自动拉起网关，无需单独启动。仅在调试网关本身时直接运行：

```bash
cd comfyui-gateway/server
npm install
npm run build
npm start
```

默认连接 `http://127.0.0.1:8188`，监听 `127.0.0.1:8190`。

### 工程结构

```text
server/                 后端工程
  package.json          npm 脚本与依赖
  tsconfig.json
  src/
    server.ts           网关入口（Express 路由与启动）
    config.ts           配置、环境变量与日志
    comfy/              ComfyUI 客户端、桥接、运行器、预览、会话、步数规划
    models/             底模、LoRA、模型匹配与路径
    workflows/          工作流注册表、自由卡片、UI→API 转换、参数绑定
    resources/          资源安装、目录扫描、初始化
    prompts/            提示词优化、布局提示词
    system/             任务、上传、系统状态、视频插帧
    shared/             通用工具
  dist/                 tsc 构建产物，启动器直接运行 server/dist/server.js
  test/                 后端测试与 mock ComfyUI
  scripts/              构建清理、工作流转换、TRT 编译辅助
admin/                  管理页源码（Vite + React + TypeScript）
admin/dist/             管理页构建产物，由网关在 /admin 静态托管
resources/ workflows/ prompts/ data/ comfyui-bridge/   共享数据与资源
```

`npm run build` 会先清空 `server/dist/` 再编译，避免目录调整后残留旧文件。

在网关根目录下修改后端源码后运行：

```bash
cd server && npm run build
```

修改管理页后运行：

```bash
cd admin
npm install
npm run build
```

管理页开发模式（Vite 代理到 `127.0.0.1:8190`）：`cd admin && npm run dev`。

常用环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8190` / `127.0.0.1` | 网关监听地址 |
| `COMFY_URL` | `http://127.0.0.1:8188` | ComfyUI 地址 |
| `COMFY_WORKFLOWS_DIR` | 空 | ComfyUI 用户工作流目录，用于自动发现 API 工作流；也可在管理页「ComfyUI 目录」第一页修改，保存后会同步到 `launcher/config.json` |
| `COMFY_WORKFLOWS_DIRS` | 空 | 多个工作流目录，用换行、分号或逗号分隔；管理页第一页的工作流目录支持多行多个，会覆盖这里的单目录设置 |
| `LAUNCHER_CONTROL_URL` | 空 | 启动器控制地址，由桌面启动器注入 |
| `REQUEST_TIMEOUT_MS` | `600000` | 图片请求超时 |
| `VIDEO_TIMEOUT_MS` | `0` | 视频超时；0 表示不设上限 |
| `POLL_INTERVAL_MS` | `750` | `/history` 轮询间隔 |
| `SCAN_ON_START` | `1` | 启动后后台扫描工作流 |
| `WATCH_WORKFLOWS` | `1` | 监听工作流目录热刷新 |
| `CORS_ORIGINS` | `http://localhost:3000,http://127.0.0.1:3000` | 允许的画布来源 |
| `TASK_RETENTION_DAYS` | `0` | 任务/输出保留天数；0 不清理 |
| `MAX_STORED_TASKS` | `0` | 最多保留任务数；0 不限制 |
| `RESOURCES_INDEX_URL` | 空 | 可选：资源索引远端地址；默认只用本地 `resources/index.json` |

## 无 GPU 联调

```bash
# 终端 A
cd comfyui-gateway/server
node test/mock/comfyui-mock.mjs --port 18188 --delay 300

# 终端 B
cd comfyui-gateway/server
npm run build
COMFY_URL=http://127.0.0.1:18188 node dist/server.js
```

Mock 只验证协议与占位图，不验证真实出图质量。

## 更新

本个人版不包含应用内更新；升级时直接替换程序文件，保留 `data/`、模型和 `launcher/config.json`。

## 测试

```bash
cd comfyui-gateway/server
npm test
```

测试会先执行 `npm run build`，再针对 `dist/` 运行 `node --test`。

## 安全

网关、ComfyUI、启动器控制接口默认只绑 `127.0.0.1`，没有鉴权。不要暴露到公网；不要把 `data/`、任务输出、模型权重或密钥提交到仓库。

## 许可证与署名

网关代码由 1314521gjy 编写，按 MIT 许可发布；项目整体署名和第三方声明见仓库根目录 `LICENSE`、`NOTICE.md`、`THIRD_PARTY_NOTICES.md`。
