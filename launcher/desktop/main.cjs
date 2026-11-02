"use strict";

/**
 * Comfy Infinity 桌面外壳：托盘 + 单窗口标签页。
 *
 * 只做三件事：
 *   1. 以子进程方式运行 launcher/start.mjs --no-open（启动逻辑完全复用，不改动原路径）；
 *   2. 统一窗口承载控制台、画布、模型配置三个标签；
 *   3. 退出时通知启动器（POST /shutdown）按原有规则关停服务。
 */

const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, screen, shell } = require("electron");
const { spawn, spawnSync } = require("node:child_process");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const { findRepoRoot, isFile, nodeLaunchCommand, readLauncherConfig, resolvePorts } = require("./lib.cjs");

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
let launcherChild = null;
let controlReady = false;
let shellReady = false;
let pendingShellRequest = null;
let consoleLoading = false;
let restartBusy = false;
let quitting = false;
let closeConfirmOpen = false;

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

async function showNativeQuitConfirm() {
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  try {
    const result = await dialog.showMessageBox(win, {
      type: "question",
      title: "退出 Comfy Infinity",
      message: "确定要退出 Comfy Infinity 吗？",
      detail: "退出后控制台、画布和模型服务都会停止。",
      buttons: ["退出", "取消"],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (result.response === 0) app.quit();
  } catch (error) {
    console.error(`[desktop] 关闭确认失败：${error.message}`);
  }
}

function confirmQuitFromWindow() {
  if (closeConfirmOpen || quitting) return;
  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  closeConfirmOpen = true;
  // 外壳已加载时使用站内弹窗，避免 Windows 原生消息框与软件视觉割裂。
  if (shellReady) {
    try {
      win.webContents.send("quit-confirm-request");
      return;
    } catch (error) {
      console.error(`[desktop] 打开退出确认弹窗失败：${error.message}`);
    }
  }
  closeConfirmOpen = false;
  void showNativeQuitConfirm();
}

function createMainWindow() {
  shellReady = false;
  const shellUrl = new URL(pathToFileURL(path.join(__dirname, "shell.html")).toString());
  shellUrl.searchParams.set("console", `${CONTROL_URL}/`);
  shellUrl.searchParams.set("canvas", `http://127.0.0.1:${canvasPort}/canvas`);
  shellUrl.searchParams.set("admin", `http://127.0.0.1:${gatewayPort}/admin`);
  mainWindow = new BrowserWindow({
    ...initialMainWindowSize(),
    minWidth: 980,
    minHeight: 680,
    title: APP_TITLE,
    backgroundColor: "#0b0d12",
    icon: ICON_PATH || undefined,
    show: false,
    titleBarStyle: "hidden",
    titleBarOverlay: {
      color: "#11151d",
      symbolColor: "#e8ecf3",
      height: 45,
    },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webviewTag: true,
      preload: path.join(__dirname, "shell-preload.cjs"),
    },
  });
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    routeExternalUrl(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url.startsWith("file:")) return;
    event.preventDefault();
    routeExternalUrl(url);
  });
  mainWindow.webContents.on("will-attach-webview", (_event, webPreferences) => {
    webPreferences.preload = path.join(__dirname, "webview-preload.cjs");
  });
  // webview 里的 target="_blank" / window.open 不会走主窗口的 windowOpenHandler，
  // 需要单独接到统一路由，否则控制台里的打开画布、模型配置等链接会被静默拦截。
  mainWindow.webContents.on("did-attach-webview", (_event, guest) => {
    guest.setWindowOpenHandler(({ url }) => {
      routeExternalUrl(url);
      return { action: "deny" };
    });
    guest.on("will-navigate", (event, url) => {
      if (isGatewayAdminUrl(url) || isCanvasUrl(url)) {
        event.preventDefault();
        routeExternalUrl(url);
      }
    });
  });
  mainWindow.webContents.on("did-finish-load", () => {
    shellReady = true;
    if (pendingShellRequest) {
      const request = pendingShellRequest;
      pendingShellRequest = null;
      applyShellRequest(request);
    }
  });
  mainWindow.webContents.on("did-fail-load", (_event, code, _description, _url, isMainFrame) => {
    if (isMainFrame && code !== -3) shellReady = false;
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.on("close", (event) => {
    // 关闭按钮先确认；确认后交给 before-quit 统一关停服务。
    if (quitting) return;
    event.preventDefault();
    confirmQuitFromWindow();
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
    shellReady = false;
    pendingShellRequest = null;
    closeConfirmOpen = false;
  });
  void mainWindow.loadURL(shellUrl.toString());
}

ipcMain.on("open-external", (_event, url) => {
  if (typeof url === "string") routeExternalUrl(url);
});

ipcMain.on("quit-confirmed", () => {
  if (!closeConfirmOpen) return;
  closeConfirmOpen = false;
  app.quit();
});

ipcMain.on("quit-cancelled", () => {
  closeConfirmOpen = false;
});

ipcMain.on("window-theme", (event, theme) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const light = theme === "light";
  try {
    win.setTitleBarOverlay({
      color: light ? "#fffdfa" : "#11151d",
      symbolColor: light ? "#211d19" : "#e8ecf3",
      height: 45,
    });
  } catch {
    /* 非 Windows 平台或旧版 Electron 没有标题栏覆盖层 */
  }
});

function applyShellRequest({ tab, url = "", reload = false }) {
  if (!mainWindow || !shellReady) return;
  const script = `window.comfyShell && window.comfyShell.show(${JSON.stringify(tab)}, ${JSON.stringify(url)}, ${reload ? "true" : "false"})`;
  void mainWindow.webContents.executeJavaScript(script).catch((error) => {
    console.error(`[desktop] 切换标签失败：${error.message}`);
  });
}

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.setAlwaysOnTop(true);
  mainWindow.show();
  mainWindow.focus();
  mainWindow.moveTop?.();
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.setAlwaysOnTop(false);
  }, 200);
}

function activateShell(tab, url = "", reload = false) {
  const request = { tab, url, reload };
  if (!mainWindow) {
    createMainWindow();
    pendingShellRequest = request;
    return;
  }
  focusMainWindow();
  if (!shellReady) {
    pendingShellRequest = request;
    return;
  }
  applyShellRequest(request);
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
    activateShell("console", `${CONTROL_URL}/`, true);
  } catch (error) {
    console.error(`[desktop] 控制台加载失败：${error.message}`);
  } finally {
    consoleLoading = false;
  }
}

function showConsole() {
  if (!mainWindow) {
    createMainWindow();
  }
  focusMainWindow();
  activateShell("console", `${CONTROL_URL}/`);
  if (!controlReady) void loadConsole();
}

async function resolveCanvasUrl() {
  const status = await readStatus();
  const canvas = status?.services?.canvas;
  if (canvas && canvas.reachable === false) return "";
  return typeof canvas?.url === "string" && canvas.url ? canvas.url : `http://127.0.0.1:${canvasPort}`;
}

async function openGatewayAdmin() {
  const status = await readStatus();
  const gatewayUrl = status?.services?.gateway?.url || `http://127.0.0.1:${gatewayPort}`;
  let adminUrl;
  try {
    adminUrl = new URL("/admin", gatewayUrl).toString();
  } catch {
    dialog.showErrorBox("网关地址无效", String(gatewayUrl));
    return;
  }
  activateShell("admin", adminUrl);
}

async function openCanvas() {
  const url = (await resolveCanvasUrl()) || `http://127.0.0.1:${canvasPort}`;
  // 直接进入「我的画布」列表；服务未启动时由画布标签页显示提示。
  activateShell("canvas", `${url.replace(/\/+$/, "")}/canvas`);
}

/* --------------------------------------------------------------- 托盘菜单 */

function trayMenuTemplate() {
  return [
    { label: controlReady ? "打开控制台" : "打开控制台（启动中…）", click: () => showConsole() },
    { label: "打开画布", click: () => void openCanvas() },
    { label: "打开模型配置", click: () => void openGatewayAdmin() },
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
