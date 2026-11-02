# 桌面外壳

Comfy Infinity 的唯一启动入口：托盘常驻 + 单窗口标签页。启动逻辑复用 `launcher/start.mjs`（以子进程运行、加 `--no-open`）。

## 运行

标准方式：双击仓库根目录的 `start-desktop.bat`（首次会自动安装依赖）。

开发调试时也可以直接执行：

```bash
# 首次
cd launcher/desktop
npm install

# 之后
npm start
```

## 行为

- 主进程以子进程方式执行 `node launcher/start.mjs --no-open`：不额外开浏览器窗口，其余流程不变。
- 统一窗口顶部有「控制台 / 画布 / 模型配置」三个标签，页面都在同一 Electron 窗口内切换。
- 关闭窗口只是收进托盘；托盘双击回到控制台。
- 托盘菜单：打开控制台 / 打开画布 / 打开模型配置 / 重启 ComfyUI / 退出（关闭工作台）。
- 退出时先 `POST /shutdown` 通知启动器按原有规则关停，10 秒内未退出才强制结束进程树。
- 关闭窗口不会退出；只有托盘「退出」或显式关闭工作台时，桌面外壳和启动器才退出。
- 单实例锁：重复启动只会聚焦已有窗口。
- 关闭硬件加速，避免 Electron 自身占用显存、污染 `nvidia-smi` 读数。

## 打包

```bash
cd launcher/desktop
npm run dist
```

产物在 `launcher/desktop/dist/win-unpacked`（`asar: false`，仅打包外壳文件）。桌面外壳需要能找到 `launcher/start.mjs`，任选其一：

1. 把 `win-unpacked` 里的内容放到项目根目录（与 `launcher/` 同级）后运行；
2. 设置环境变量 `COMFY_INFINITY_ROOT` 指向项目根目录。

首次运行仍然需要目标机器上有可用的 ComfyUI 与已构建的 `infinite-canvas/web/dist`。
