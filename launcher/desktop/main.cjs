"use strict";

/**
 * Comfy Infinity 桌面外壳：托盘 + 控制台窗口 + 画布窗口。
 *
 * 只做三件事：
 *   1. 以子进程方式运行 launcher/start.mjs --no-open（启动逻辑完全复用，不改动原路径）；
 *   2. 窗口加载启动器自带的 8290 控制台页面；
 *   3. 退出时通知启动器（POST /shutdown）按原有规则关停网关/ComfyUI。
 */

const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, screen, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");

const { findRepoRoot, isConsoleUrl, isFile, nodeLaunchCommand, readLauncherConfig, resolvePorts } = require("./lib.cjs");

const APP_TITLE = "Comfy Infinity";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.disableHardwareAcceleration();
if (process.platform === "win32") app.setAppUserModelId("com.comfyinfinity.desktop");

const ROOT = findRepoRoot();
const START_SCRIPT = ROOT ? path.join(ROOT, "launcher", "start.mjs") : "";
const ICON_PATH = ROOT ? path.join(ROOT, "launcher", "app-icon.ico") : "";
const CONFIG_PATH = ROOT ? path.join(ROOT, "launcher", "config.json") : "";

const { controlPort, canvasPort, gatewayPort } = resolvePorts(ROOT ? readLauncherConfig(CONFIG_PATH) : {});
const CONTROL_URL = `http://127.0.0.1:${controlPort}`;

let tray = null;
let mainWindow = null;
let canvasWindow = null;
let adminWindow = null;
let launcherChild = null;
let controlReady = false;
let consoleLoaded = false;
let consoleLoading = false;
let restartBusy = false;
let quitting = false;

/* --------------------------------------------------------------- 控制接口 */

async function pingControl() {
  try {
    const response = await fetch(`${CONTROL_URL}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForControl(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pingControl()) return true;
    await sleep(400);
  }
  return false;
}

async function readStatus() {
  try {
    const response = await fetch(`${CONTROL_URL}/api/status`, { signal: AbortSignal.timeout(3000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

/* ----------------------------------------------------------------- 启动器 */

function startLauncher() {
  const { command, electronRunAsNode } = nodeLaunchCommand(ROOT);
  const env = { ...process.env };
  if (electronRunAsNode) env.ELECTRON_RUN_AS_NODE = "1";

  launcherChild = spawn(command, [START_SCRIPT, "--no-open"], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  launcherChild.stdout.on("data", (chunk) => process.stdout.write(String(chunk)));
  launcherChild.stderr.on("data", (chunk) => process.stderr.write(String(chunk)));
  launcherChild.on("error", (error) => {
    console.error(`[desktop] 启动器进程启动失败：${error.message}`);
  });
  launcherChild.on("exit", (code, signal) => {
    launcherChild = null;
    controlReady = false;
    refreshTray();
    if (quitting) return;
    console.log(`[desktop] 启动器已退出（code=${code}, signal=${signal}）`);
    quitting = true;
    if (code) dialog.showErrorBox("启动器异常退出", `启动器以 code=${code} 退出，详见 launcher/launcher.log。`);
    app.quit();
  });
}

/* ------------------------------------------------------------------- 窗口 */

function isCanvasUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) return false;
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    // 画布端口被占用时启动器会顺延到 +10，这里按区间判断。
    return port >= canvasPort && port <= canvasPort + 10;
  } catch {
    return false;
  }
}

function isGatewayAdminUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname)) return false;
    const port = Number(url.port) || (url.protocol === "https:" ? 443 : 80);
    return port === gatewayPort && (url.pathname === "/admin" || url.pathname.startsWith("/admin/"));
  } catch {
    return false;
  }
}

function routeExternalUrl(rawUrl) {
  if (!/^https?:\/\//i.test(rawUrl)) return;
  if (isGatewayAdminUrl(rawUrl)) {
    void openGatewayAdmin();
    return;
  }
  if (isCanvasUrl(rawUrl)) {
    void openCanvas();
    return;
  }
  void shell.openExternal(rawUrl);
}

const MAIN_WINDOW_SIZE = { width: 1440, height: 960 };

// 默认给足空间，同时按屏幕工作区收口，避免小屏或缩放比例下超出可用区域。
function initialMainWindowSize() {
  try {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    return {
      width: Math.min(MAIN_WINDOW_SIZE.width, Math.max(880, Math.round(width * 0.92))),
      height: Math.min(MAIN_WINDOW_SIZE.height, Math.max(620, Math.round(height * 0.92))),
    };
  } catch {
    return MAIN_WINDOW_SIZE;
  }
}

function createMainWindow() {
  consoleLoaded = false;
  mainWindow = new BrowserWindow({
    ...initialMainWindowSize(),
    minWidth: 880,
    minHeight: 620,
    title: APP_TITLE,
    backgroundColor: "#0b0d12",
    icon: ICON_PATH || undefined,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    routeExternalUrl(url);
    return { action: "deny" };
  });
  // 控制台窗口只允许停留在控制台页面：画布、网关管理页交给 Electron 窗口，其余外链交给浏览器。
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (isConsoleUrl(url, controlPort)) return;
    event.preventDefault();
    routeExternalUrl(url);
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
    // 忽略导航被打断（例如启动页正在换成控制台），只处理真正的加载失败。
    if (isMainFrame && code !== -3) consoleLoaded = false;
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    // 关闭窗口 = 最小化到托盘；退出走托盘菜单或系统退出。
    if (quitting) return;
    event.preventDefault();
    mainWindow.hide();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  void mainWindow.loadFile(path.join(__dirname, "loading.html"));
}

async function loadConsole() {
  if (consoleLoading) return;
  consoleLoading = true;
  try {
    controlReady = await waitForControl();
    refreshTray();
    if (!mainWindow) return;
    if (!controlReady) {
      dialog.showErrorBox(
        "无法连接启动器控制接口",
        `端口 ${controlPort} 无响应。可能是端口被占用或启动器启动失败，详见 launcher/launcher.log。`,
      );
      return;
    }
    await mainWindow.loadURL(`${CONTROL_URL}/`);
    consoleLoaded = true;
  } catch (error) {
    consoleLoaded = false;
    console.error(`[desktop] 控制台加载失败：${error.message}`);
  } finally {
    consoleLoading = false;
  }
}

function showConsole() {
  if (!mainWindow) {
    createMainWindow();
    void loadConsole();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  // Windows 会拦截后台程序抢焦点：短暂置顶，确保从托盘唤起的窗口浮到画布窗口上面。
  mainWindow.setAlwaysOnTop(true);
  mainWindow.show();
  mainWindow.focus();
  mainWindow.moveTop?.();
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
  }, 200);
  // 窗口可能停在启动页，或之前被控制台里的链接导航到了画布/管理页；补一次控制台加载。
  if (!consoleLoaded || !isConsoleUrl(mainWindow.webContents.getURL(), controlPort)) void loadConsole();
}

async function resolveCanvasUrl() {
  const status = await readStatus();
  const canvas = status?.services?.canvas;
  if (canvas && canvas.reachable === false) return "";
  return typeof canvas?.url === "string" && canvas.url ? canvas.url : `http://127.0.0.1:${canvasPort}`;
}

async function openGatewayAdmin() {
  const status = await readStatus();
  if (status?.services?.gateway?.reachable === false) {
    dialog.showErrorBox("网关未启动", "本地网关还没有就绪，请稍后重试或在控制台启动网关。");
    return;
  }
  if (adminWindow && !adminWindow.isDestroyed()) {
    if (adminWindow.isMinimized()) adminWindow.restore();
    adminWindow.show();
    adminWindow.focus();
    return;
  }
  const gatewayUrl = status?.services?.gateway?.url || `http://127.0.0.1:${gatewayPort}`;
  let adminUrl;
  try {
    adminUrl = new URL("/admin", gatewayUrl).toString();
  } catch {
    dialog.showErrorBox("网关地址无效", String(gatewayUrl));
    return;
  }
  adminWindow = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    title: `${APP_TITLE} · 网关管理`,
    backgroundColor: "#0b0d12",
    icon: ICON_PATH || undefined,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  adminWindow.setMenuBarVisibility(false);
  adminWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isConsoleUrl(url, controlPort)) {
      showConsole();
      return { action: "deny" };
    }
    if (isGatewayAdminUrl(url)) return { action: "deny" };
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  adminWindow.webContents.on("will-navigate", (event, url) => {
    if (isGatewayAdminUrl(url)) return;
    event.preventDefault();
    if (isConsoleUrl(url, controlPort)) showConsole();
    else routeExternalUrl(url);
  });
  adminWindow.on("closed", () => {
    adminWindow = null;
  });
  try {
    await adminWindow.loadURL(adminUrl);
  } catch (error) {
    console.error(`[desktop] 网关管理页加载失败：${error.message}`);
    dialog.showErrorBox("网关管理页加载失败", `${adminUrl}\n${error.message}`);
  }
}

async function openCanvas() {
  const url = await resolveCanvasUrl();
  if (!url) {
    dialog.showErrorBox("画布未启动", "画布服务还没有就绪，请稍后重试或在控制台查看状态。");
    return;
  }
  if (canvasWindow && !canvasWindow.isDestroyed()) {
    if (canvasWindow.isMinimized()) canvasWindow.restore();
    canvasWindow.show();
    canvasWindow.focus();
    return;
  }
  canvasWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 720,
    title: `${APP_TITLE} · 画布`,
    backgroundColor: "#0b0d12",
    icon: ICON_PATH || undefined,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  canvasWindow.setMenuBarVisibility(false);
  // 画布里的「控制台」按钮指向启动器控制台：桌面版直接切回控制台窗口，不把画布窗口导航走。
  canvasWindow.webContents.on("will-navigate", (event, url) => {
    if (isGatewayAdminUrl(url)) {
      event.preventDefault();
      void openGatewayAdmin();
      return;
    }
    if (!isConsoleUrl(url, controlPort)) return;
    event.preventDefault();
    showConsole();
  });
  canvasWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isConsoleUrl(url, controlPort)) {
      showConsole();
      return { action: "deny" };
    }
    if (isGatewayAdminUrl(url)) {
      void openGatewayAdmin();
      return { action: "deny" };
    }
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  canvasWindow.on("closed", () => {
    canvasWindow = null;
  });
  try {
    // 直接进入「我的画布」列表，跳过已删除的落地首页。
    await canvasWindow.loadURL(`${url.replace(/\/+$/, "")}/canvas`);
  } catch (error) {
    console.error(`[desktop] 画布加载失败：${error.message}`);
    dialog.showErrorBox("画布加载失败", `${url}\n${error.message}`);
  }
}

/* --------------------------------------------------------------- 托盘菜单 */

function trayMenuTemplate() {
  return [
    { label: controlReady ? "打开控制台" : "打开控制台（启动中…）", click: () => showConsole() },
    { label: "打开画布", click: () => void openCanvas() },
    { label: "打开网关管理页", click: () => void openGatewayAdmin() },
    { type: "separator" },
    {
      label: restartBusy ? "正在重启 ComfyUI…" : "重启 ComfyUI",
      enabled: controlReady && !restartBusy,
      click: () => void restartComfy(),
    },
    { type: "separator" },
    { label: "退出（关闭工作台）", click: () => app.quit() },
  ];
}

function refreshTray() {
  if (tray) tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()));
}

function createTray() {
  const image = ICON_PATH ? nativeImage.createFromPath(ICON_PATH) : nativeImage.createEmpty();
  if (image.isEmpty()) console.warn(`[desktop] 托盘图标不可用：${ICON_PATH || "（空路径）"}`);
  tray = new Tray(image);
  tray.setToolTip(APP_TITLE);
  tray.on("double-click", () => showConsole());
  refreshTray();
}

/* ------------------------------------------------------------------- 动作 */

async function restartComfy() {
  if (restartBusy) return;
  restartBusy = true;
  refreshTray();
  try {
    const response = await fetch(`${CONTROL_URL}/restart-comfy`, {
      method: "POST",
      signal: AbortSignal.timeout(360000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    console.log(`[desktop] ComfyUI 已重启：${data.comfyUrl || ""}，释放显存 ${data.freedMb || 0} MB`);
  } catch (error) {
    dialog.showErrorBox("重启 ComfyUI 失败", error.message);
  } finally {
    restartBusy = false;
    refreshTray();
  }
}

function waitForChildExit(child, timeoutMs) {
  if (!child || child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function killTree(pid) {
  if (!pid) return;
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    /* 已退出 */
  }
}

async function shutdownWorkbench() {
  try {
    await fetch(`${CONTROL_URL}/shutdown`, { method: "POST", signal: AbortSignal.timeout(5000) });
  } catch {
    /* 控制接口不可达时直接结束子进程 */
  }
  const child = launcherChild;
  if (!child) return;
  if (!(await waitForChildExit(child, 10000))) {
    console.warn("[desktop] 启动器未在 10s 内退出，强制结束进程树");
    killTree(child.pid);
  }
}

/* ------------------------------------------------------------------- 入口 */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showConsole());

  // 托盘常驻：关掉所有窗口也不退出。
  app.on("window-all-closed", () => {});

  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    if (tray) {
      tray.destroy();
      tray = null;
    }
    void shutdownWorkbench().finally(() => app.exit(0));
  });

  app.whenReady().then(async () => {
    if (!ROOT || !isFile(START_SCRIPT)) {
      dialog.showErrorBox(
        "找不到 Comfy Infinity 主目录",
        "桌面外壳需要与 launcher/start.mjs 位于同一套目录中；也可用环境变量 COMFY_INFINITY_ROOT 指向项目根目录。",
      );
      quitting = true;
      app.exit(1);
      return;
    }
    createTray();
    createMainWindow();
    startLauncher();
    await loadConsole();
  });
}
