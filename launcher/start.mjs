#!/usr/bin/env node
/**
 * 本地一键启动器（Windows / Node 24 / 零第三方依赖）
 *
 * 行为：
 *   - 先探测 ComfyUI(8188)、网关(8190)、画布(3000)，已在运行的一律“接管”，绝不重复启动；
 *   - 缺失的服务按 comfy → gateway → canvas 顺序拉起；
 *   - ComfyUI 找不到时如实提示，仍启动网关并打开 /admin；
 *   - 画布由内置静态服务器托管 infinite-canvas/web/dist（SPA fallback，仅绑 127.0.0.1）；
 *   - 关闭画布不会停止后台；Ctrl+C 或从托盘显式退出时，才停止“本启动器启动的”子进程。
 *
 * 用法：
 *   node launcher/start.mjs [--dry-run] [--no-open]
 *
 * 环境变量：COMFYUI_DIR / COMFY_URL / GATEWAY_PORT / CANVAS_PORT
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { installBundledNodes } from "./bootstrap-nodes.mjs";
import { installBundledWorkflows } from "./bootstrap-workflows.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(__dirname, "config.json");
const LOG_PATH = path.join(__dirname, "launcher.log");
const LOG_BACKUP_PATH = path.join(__dirname, "launcher.log.1");
const LOG_ROTATE_BYTES = 5 * 1024 * 1024;

const ARGV = process.argv.slice(2);
const DRY_RUN = ARGV.includes("--dry-run");
const NO_OPEN = ARGV.includes("--no-open");

const DEFAULT_CONFIG = {
  comfyUrl: "http://127.0.0.1:8188",
  comfyDir: "",
  comfyWorkflowsDir: "",
  gatewayPort: 8190,
  controlPort: 8290,
  canvasPort: 3000,
  gatewayDir: "",
  canvasDist: "",
  comfyStartTimeoutSec: 300,
  gatewayStartTimeoutSec: 30,
  openBrowser: true,
  openConsole: true,
  stopAdoptedComfyOnExit: true,
  allowLan: false,
  canvasHost: "127.0.0.1",
  gatewayHost: "127.0.0.1",
  gatewayPublicHost: "",
  corsOrigins: "",
};

function normalizeHost(value, fallback = "127.0.0.1") {
  const raw = String(value || "").trim();
  if (!raw) return fallback;
  return raw.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

function isLoopbackHost(host) {
  const value = String(host || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "::1" || value === "0:0:0:0:0:0:0:1" || /^127\./.test(value);
}

function browseHostFor(bindHost) {
  const host = normalizeHost(bindHost);
  return host === "0.0.0.0" || host === "::" || isLoopbackHost(host) ? "127.0.0.1" : host;
}

/* ------------------------------------------------------------------ 日志 */

function log(message, level = "INFO") {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_PATH, line + os.EOL);
  } catch {
    /* 日志写失败不应中断启动 */
  }
}

function forwardLines(chunk, tag) {
  const text = String(chunk);
  for (const piece of text.split(/\r?\n/)) {
    if (piece.trim()) log(`[${tag}] ${piece}`, "CHILD");
  }
}

// 启动时轮转：超过 5MB 就改名为 launcher.log.1（只保留一份），避免日志无限增长。
function rotateLauncherLog() {
  try {
    const stat = fs.statSync(LOG_PATH);
    if (stat.size < LOG_ROTATE_BYTES) return "";
    fs.rmSync(LOG_BACKUP_PATH, { force: true });
    fs.renameSync(LOG_PATH, LOG_BACKUP_PATH);
    return LOG_BACKUP_PATH;
  } catch {
    return "";
  }
}

/* ------------------------------------------------------------------ 配置 */

function toPort(value, fallback, envName) {
  const n = Number(value);
  if (Number.isInteger(n) && n > 0 && n < 65536) return n;
  if (envName && process.env[envName]) log(`环境变量 ${envName}=${process.env[envName]} 非法，忽略`, "WARN");
  return fallback;
}

function loadConfig() {
  let created = false;
  let fileConfig = {};
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2) + os.EOL, "utf8");
    created = true;
  } else {
    try {
      fileConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch (err) {
      throw new Error(`launcher/config.json 不是合法 JSON：${err.message}`);
    }
  }

  const merged = { ...DEFAULT_CONFIG, ...fileConfig };
  const cfg = {
    comfyUrl: String(process.env.COMFY_URL || merged.comfyUrl || DEFAULT_CONFIG.comfyUrl).replace(/\/+$/, ""),
    comfyDir: String(process.env.COMFYUI_DIR || merged.comfyDir || ""),
    comfyWorkflowsDir: String(merged.comfyWorkflowsDir || ""),
    gatewayPort: toPort(process.env.GATEWAY_PORT ?? merged.gatewayPort, DEFAULT_CONFIG.gatewayPort, "GATEWAY_PORT"),
    controlPort: toPort(process.env.LAUNCHER_CONTROL_PORT ?? merged.controlPort, DEFAULT_CONFIG.controlPort, "LAUNCHER_CONTROL_PORT"),
    canvasPort: toPort(process.env.CANVAS_PORT ?? merged.canvasPort, DEFAULT_CONFIG.canvasPort, "CANVAS_PORT"),
    gatewayDir: path.resolve(ROOT, merged.gatewayDir || "comfyui-gateway"),
    canvasDist: path.resolve(ROOT, merged.canvasDist || path.join("infinite-canvas", "web", "dist")),
    comfyStartTimeoutSec: Number(merged.comfyStartTimeoutSec) > 0 ? Number(merged.comfyStartTimeoutSec) : 300,
    gatewayStartTimeoutSec: Number(merged.gatewayStartTimeoutSec) > 0 ? Number(merged.gatewayStartTimeoutSec) : 30,
    openBrowser: merged.openBrowser !== false,
    openConsole: merged.openConsole !== false,
    stopAdoptedComfyOnExit:
      process.env.STOP_ADOPTED_COMFY !== "0" &&
      (merged.stopAdoptedComfyOnExit ?? merged.stopAdoptedComfyOnCanvasClose) !== false,
    allowLan: merged.allowLan === true,
    canvasHost: normalizeHost(merged.canvasHost, DEFAULT_CONFIG.canvasHost),
    gatewayHost: normalizeHost(merged.gatewayHost, DEFAULT_CONFIG.gatewayHost),
    gatewayPublicHost: normalizeHost(merged.gatewayPublicHost, ""),
    corsOrigins: String(merged.corsOrigins || "").trim(),
    configCreated: created,
  };
  if (cfg.allowLan !== true && (!isLoopbackHost(cfg.canvasHost) || !isLoopbackHost(cfg.gatewayHost))) {
    throw new Error("canvasHost/gatewayHost 非回环地址时必须显式设置 allowLan=true；否则可能把无鉴权服务暴露到局域网。");
  }
  // 本机健康检查/代理始终走回环，避免 gatewayPublicHost 在本机不可解析时启动失败。
  cfg.gatewayUrl = `http://127.0.0.1:${cfg.gatewayPort}`;
  const specificLanHost = !isLoopbackHost(cfg.gatewayHost) && cfg.gatewayHost !== "0.0.0.0" && cfg.gatewayHost !== "::";
  const publicHost = cfg.allowLan ? (cfg.gatewayPublicHost || (specificLanHost ? cfg.gatewayHost : "127.0.0.1")) : "127.0.0.1";
  cfg.gatewayPublicUrl = `http://${publicHost}:${cfg.gatewayPort}`;
  cfg.canvasUrl = `http://${browseHostFor(cfg.canvasHost)}:${cfg.canvasPort}`;
  cfg.controlUrl = `http://127.0.0.1:${cfg.controlPort}`;
  return cfg;
}

function persistDiscovery(cfg) {
  try {
    let file = {};
    try {
      file = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    } catch {
      file = {};
    }
    file.comfyUrl = cfg.comfyUrl;
    file.comfyDir = cfg.comfyDir;
    file.comfyWorkflowsDir = cfg.comfyWorkflowsDir;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(file, null, 2) + os.EOL, "utf8");
  } catch (err) {
    log(`保存 launcher/config.json 失败：${err.message}`, "WARN");
  }
}

function applyComfyDir(cfg, dir) {
  cfg.comfyDir = dir;
  const info = comfyInstallInfo(dir);
  if (info?.workflowsDir) cfg.comfyWorkflowsDir = info.workflowsDir;
  persistDiscovery(cfg);
  state.comfyStartError = "";
  const plan = resolveLaunchPlan(info);
  state.comfyNeedsPath = !info || !plan;
  return { comfyDir: cfg.comfyDir, workflowsDir: cfg.comfyWorkflowsDir, detected: Boolean(info), plan };
}

// 原生目录选择会阻塞到用户确认或取消，使用异步子进程避免卡住控制接口和状态轮询。
function pickComfyDirectory(initial) {
  return new Promise((resolve, reject) => {
    if (process.platform !== "win32") {
      reject(new Error("当前系统不支持原生目录选择"));
      return;
    }
    const initialPath = String(initial || "");
    const escaped = initialPath.replace(/'/g, "''");
    const script = [
      "$ProgressPreference = 'SilentlyContinue'",
      "Add-Type -AssemblyName System.Windows.Forms | Out-Null",
      "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
      "$dialog.Description = '选择 ComfyUI 安装目录'",
      "$dialog.ShowNewFolderButton = $false",
      escaped ? `$dialog.SelectedPath = '${escaped}'` : "",
      "if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {",
      "  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
      "  [Console]::Write($dialog.SelectedPath)",
      "}",
    ]
      .filter(Boolean)
      .join("\n");
    const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = spawn(powershell, ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("选择目录超时"));
    }, 300000);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr.trim() || `目录选择窗口异常退出（code=${code}）`));
      else resolve(stdout.trim());
    });
  });
}

/* -------------------------------------------------------------- HTTP 探测 */

async function httpGet(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json, text/html;q=0.9, */*;q=0.8" },
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { ok: res.ok, status: res.status, text, json, contentType: res.headers.get("content-type") || "" };
  } catch {
    return { ok: false, status: 0, text: "", json: null, contentType: "" };
  } finally {
    clearTimeout(timer);
  }
}

const COMFY_PORT_FIRST = 8188;
const COMFY_PORT_LAST = 8199;
// 8000 是 ComfyUI 桌面版默认端口；其余是常见整合包/自定义端口。
const EXTRA_COMFY_PORTS = [8000, 7860, 8080, 8888, 18000];

function parsePortSpec(spec) {
  const ports = [];
  for (const part of String(spec || "").split(",")) {
    const piece = part.trim();
    if (!piece) continue;
    const range = piece.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (!Number.isInteger(from) || !Number.isInteger(to)) continue;
      const maxSpan = 200;
      for (let p = Math.min(from, to); p <= Math.max(from, to) && p - Math.min(from, to) < maxSpan; p += 1) ports.push(p);
    } else if (/^\d+$/.test(piece)) {
      ports.push(Number(piece));
    }
  }
  return ports;
}

function comfyPortCandidates(cfg) {
  const reserved = new Set([cfg.gatewayPort, cfg.controlPort, cfg.canvasPort].filter((port) => Number.isInteger(port) && port > 0));
  const ports = [];
  const add = (port) => {
    if (!Number.isInteger(port) || port <= 0 || port >= 65536) return;
    // 别把启动器自己的端口当成 ComfyUI 去探测，否则网关会收到一堆 /system_stats 404。
    if (reserved.has(port)) return;
    if (!ports.includes(port)) ports.push(port);
  };
  add(portFromUrl(cfg.comfyUrl));
  add(COMFY_PORT_FIRST);
  for (const port of EXTRA_COMFY_PORTS) add(port);
  for (const port of parsePortSpec(process.env.COMFY_PORT_SCAN)) add(port);
  for (let port = COMFY_PORT_FIRST + 1; port <= COMFY_PORT_LAST; port += 1) add(port);
  return ports;
}

async function probeComfy(url, timeoutMs = 900) {
  const res = await httpGet(`${url.replace(/\/+$/, "")}/system_stats`, timeoutMs);
  return res.ok;
}

// 并行探测一组端口，避免逐个 2s 超时把启动拖成十几秒。
async function probeAnyComfy(ports, timeoutMs = 900) {
  const queue = [...ports];
  const worker = async () => {
    while (queue.length) {
      const port = queue.shift();
      const url = `http://127.0.0.1:${port}`;
      if (await probeComfy(url, timeoutMs)) return url;
    }
    return "";
  };
  const results = await Promise.all(Array.from({ length: Math.min(16, queue.length) }, worker));
  const hit = results.find(Boolean);
  return hit ? { url: hit, via: `端口 ${portFromUrl(hit)}` } : null;
}

async function detectComfy(cfg) {
  return await probeAnyComfy(comfyPortCandidates(cfg), 900);
}

async function detectGateway(cfg) {
  const res = await httpGet(`${cfg.gatewayUrl}/health`, 2500);
  if (res.ok && res.json && typeof res.json === "object") return { url: cfg.gatewayUrl, health: res.json };
  return null;
}

async function detectCanvas(cfg) {
  const res = await httpGet(`${cfg.canvasUrl}/`, 2500);
  if (res.ok) return { url: cfg.canvasUrl };
  return null;
}

async function waitFor(label, probe, timeoutSec, { intervalMs = 3000, progressEveryMs = 15000, shouldAbort } = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  const started = Date.now();
  let nextNote = started + progressEveryMs;
  while (Date.now() < deadline) {
    const hit = await probe();
    if (hit) {
      log(`${label} 就绪（${Math.round((Date.now() - started) / 1000)}s）`);
      return hit;
    }
    const abortReason = typeof shouldAbort === "function" ? shouldAbort() : "";
    if (abortReason) {
      log(`${label} 中止等待：${abortReason}`, "WARN");
      return null;
    }
    if (Date.now() >= nextNote) {
      log(`${label} 仍在等待…（已 ${Math.round((Date.now() - started) / 1000)}s / 上限 ${timeoutSec}s）`);
      nextNote += progressEveryMs;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  log(`${label} 在 ${timeoutSec}s 内未就绪`, "ERROR");
  return null;
}

/* ---------------------------------------------------------- ComfyUI 启动 */

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

const pythonProbeCache = new Map();
// 整合包里可能存在坏掉的 python.exe（例如 env\Scripts 下的占位文件），
// 选解释器前实际跑一次，别把 ComfyUI 拉起失败留到用户面前。
function pythonWorks(file) {
  if (!file) return false;
  const cached = pythonProbeCache.get(file);
  if (cached && Date.now() - cached.at < 300000) return cached.ok;
  let ok = false;
  try {
    const result = spawnSync(file, ["-c", "import sys;print(sys.version_info[0])"], { timeout: 8000, windowsHide: true, encoding: "utf8" });
    ok = result.status === 0 && /^\s*3\s*$/m.test(String(result.stdout || ""));
  } catch {
    ok = false;
  }
  pythonProbeCache.set(file, { at: Date.now(), ok });
  return ok;
}

function comfyInstallInfo(dir) {
  if (!dir || !isDir(dir)) return null;
  const mainCandidates = [
    path.join(dir, "ComfyUI", "main.py"),
    path.join(dir, "main.py"),
    path.join(dir, "resources", "ComfyUI", "main.py"),
  ];
  const mainPy = mainCandidates.find((candidate) => isFile(candidate)) || "";
  const pythonCandidates = [
    path.join(dir, "python_embeded", "python.exe"),
    path.join(dir, "python_embedded", "python.exe"),
    path.join(dir, "python", "python.exe"),
    path.join(dir, "env", "python.exe"),
    path.join(dir, "env", "python", "python.exe"),
    path.join(dir, "env", "Scripts", "python.exe"),
    path.join(dir, "venv", "Scripts", "python.exe"),
    path.join(dir, ".venv", "Scripts", "python.exe"),
    path.join(dir, "Scripts", "python.exe"),
    path.join(dir, "..", "python", "python.exe"),
    path.join(dir, "..", "env", "python.exe"),
    path.join(dir, "..", "env", "python", "python.exe"),
    path.join(dir, "..", "env", "Scripts", "python.exe"),
    path.join(dir, "..", "python_embeded", "python.exe"),
    mainPy ? path.join(path.dirname(mainPy), "..", "python_embeded", "python.exe") : "",
  ].filter(Boolean);
  const pythonExe = pythonCandidates.find((candidate) => isFile(candidate) && pythonWorks(candidate)) || pythonCandidates.find((candidate) => isFile(candidate)) || "";
  const scripts = [];
  // 只把内容里真的调用 main.py 的脚本算作 ComfyUI 启动脚本；
  // 否则我们自己的启动脚本、卸载脚本之类都会被误判成 ComfyUI 安装。
  const pushScript = (file) => {
    if (!isFile(file) || scripts.includes(file)) return;
    try {
      if (/main\.py/i.test(fs.readFileSync(file, "utf8"))) scripts.push(file);
    } catch {
      /* 读不到就跳过 */
    }
  };
  let electronExe = [path.join(dir, "ComfyUI.exe"), path.join(dir, "ComfyUI Desktop.exe")].find((candidate) => isFile(candidate)) || "";
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const rank = (name) => (/^run_nvidia_gpu\.bat$/i.test(name) ? 0 : /^run.*\.(bat|cmd)$/i.test(name) ? 1 : /(启动|一键|开始|start|launch)/i.test(name) ? 2 : 3);
    const parent = path.dirname(dir);
    const scanDirs = [dir, parent && parent !== path.parse(dir).root ? parent : ""].filter(Boolean);
    for (const base of scanDirs) {
      let list = [];
      try {
        list = fs.readdirSync(base, { withFileTypes: true });
      } catch {
        continue;
      }
      const bats = list
        .filter((entry) => entry.isFile() && /\.(bat|cmd)$/i.test(entry.name))
        .sort((a, b) => rank(a.name) - rank(b.name));
      for (const entry of bats) pushScript(path.join(base, entry.name));
    }
    if (!electronExe) {
      const exe = entries.find((entry) => entry.isFile() && /\.exe$/i.test(entry.name) && /comfy/i.test(entry.name));
      if (exe) electronExe = path.join(dir, exe.name);
    }
  } catch {
    /* 目录不可读时按已有信息处理 */
  }
  if (!scripts.length && !mainPy && !electronExe) return null;

  const workflowCandidates = [
    path.join(dir, "ComfyUI", "user", "default", "workflows"),
    path.join(dir, "resources", "ComfyUI", "user", "default", "workflows"),
    path.join(dir, "user", "default", "workflows"),
  ];
  const workflowsDir = workflowCandidates.find((candidate) => isDir(candidate)) || "";
  return {
    dir,
    bat: scripts[0] || "",
    scripts,
    mainPy,
    pythonExe,
    electronExe,
    workflowsDir,
  };
}

function resolveLaunchPlan(install) {
  if (!install) return null;
  if (install.electronExe) return { kind: "desktop", file: install.electronExe, cwd: install.dir };
  // 整合包的 bat 往往带了必要的启动参数/环境变量，能跑就优先用；python 直启只作兜底。
  if (install.scripts?.length) return { kind: "script", file: install.scripts[0], cwd: path.dirname(install.scripts[0]) };
  if (install.pythonExe && install.mainPy) return { kind: "python", file: install.pythonExe, mainPy: install.mainPy, cwd: install.dir };
  return null;
}

function collectComfyInstalls(cfg) {
  const home = os.homedir();
  const sameFolder = [
    ROOT,
    path.join(ROOT, "ComfyUI"),
    path.join(ROOT, "ComfyUI_windows_portable"),
    path.join(ROOT, "ComfyUI_windows_portable", "ComfyUI"),
    path.resolve(ROOT, ".."),
    path.resolve(ROOT, "..", "ComfyUI"),
    path.resolve(ROOT, "..", "ComfyUI_windows_portable"),
    path.resolve(ROOT, "..", "ComfyUI_windows_portable", "ComfyUI"),
  ];
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const preferred = cfg.comfyDir ? [cfg.comfyDir] : [];
  const common = [
    path.join(home, "ComfyUI"),
    path.join(home, "Documents", "ComfyUI"),
    path.join(localAppData, "Programs", "@comfyorgcomfyui-electron"),
    path.join(localAppData, "Programs", "@comfyorgcomfyui-electron", "resources", "ComfyUI"),
    path.join(localAppData, "Programs", "ComfyUI"),
    "C:\\ComfyUI",
    "D:\\ComfyUI",
    "E:\\ComfyUI",
    "E:\\ComfyUI_windows_portable",
    "E:\\ComfyUI\\ComfyUI",
  ].filter(Boolean);

  const found = [];
  const seen = new Set();
  const inspect = (raw, via) => {
    if (!raw) return;
    const dir = path.resolve(raw);
    const key = dir.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    const info = comfyInstallInfo(dir);
    if (info) {
      log(`ComfyUI 探测命中（${via}）：${dir}`);
      found.push(info);
    }
  };

  for (const dir of preferred) inspect(dir, "配置路径");
  for (const dir of sameFolder) inspect(dir, "同文件夹");

  const driveRoot = path.parse(ROOT).root;
  const skip = new Set(["windows", "program files", "program files (x86)", "programdata", "$recycle.bin", "system volume information", "recovery", "perflogs"]);
  const started = Date.now();
  let entries = [];
  try {
    entries = fs.readdirSync(driveRoot, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || skip.has(entry.name.toLowerCase())) continue;
    if (Date.now() - started > 2000) break;
    const dir = path.join(driveRoot, entry.name);
    inspect(dir, "同盘");
    if (/comfy/i.test(entry.name)) {
      inspect(path.join(dir, "ComfyUI"), "同盘子目录");
      inspect(path.join(dir, "resources", "ComfyUI"), "同盘 resources/ComfyUI");
    }
  }

  for (const dir of common) inspect(dir, "常见目录/配置");
  return found;
}

function findComfyInstall(cfg) {
  return collectComfyInstalls(cfg)[0] || null;
}

async function pickFreePort(ports) {
  for (const port of ports) {
    if (!(await probeComfy(`http://127.0.0.1:${port}`, 300))) return port;
  }
  return COMFY_PORT_FIRST;
}

// 3000 经常被 NEW API / 其他开发服务占着；画布不能因为一个端口就整体退出。
async function listenCanvasServer(cfg, preferredPort) {
  const ports = [preferredPort, ...Array.from({ length: 10 }, (_, index) => preferredPort + index + 1)];
  let lastError = null;
  for (const port of ports) {
    const server = createCanvasServer(cfg);
    const error = await new Promise((resolve) => {
      server.once("error", (err) => resolve(err));
      server.listen(port, cfg.canvasHost || "127.0.0.1", () => resolve(null));
    });
    if (!error) return { server, port };
    lastError = error;
    try {
      server.close();
    } catch {
      /* 监听失败时 server 可能还没打开 */
    }
    if (error.code !== "EADDRINUSE") break;
  }
  throw lastError || new Error("画布端口不可用");
}

function spawnComfyTracked(plan, port = COMFY_PORT_FIRST) {
  const child = spawnComfy(plan, port);
  const failure = { error: null, exited: false, code: null, signal: null };
  child.on("error", (error) => {
    failure.error = error;
  });
  child.on("exit", (code, signal) => {
    failure.exited = true;
    failure.code = code;
    failure.signal = signal;
  });
  return { child, failure };
}

async function startComfyCandidate(cfg, install, { preferredPort, label, timeoutSec } = {}) {
  const plan = resolveLaunchPlan(install);
  if (!plan) return { ok: false, error: "没有可用的启动方式" };
  const launchPort = plan.kind === "python" ? preferredPort || (await pickFreePort(comfyPortCandidates(cfg))) : COMFY_PORT_FIRST;
  log(`${label}：尝试 ${plan.kind === "desktop" ? "桌面版" : plan.kind === "script" ? "启动脚本" : "Python"} ${plan.file}`);
  const { child, failure } = spawnComfyTracked(plan, launchPort);
  state.comfyChild = child;
  const ready = await waitFor(
    label,
    async () => probeAnyComfy(comfyPortCandidates(cfg), 900),
    timeoutSec,
    {
      intervalMs: 2000,
      progressEveryMs: 15000,
      shouldAbort: () => {
        if (failure.error) return `进程启动失败：${failure.error.message}`;
        if (failure.exited && failure.code !== 0) {
          return `进程退出（code=${failure.code}${failure.signal ? `，signal=${failure.signal}` : ""}）`;
        }
        return "";
      },
    }
  );
  if (ready) return { ok: true, url: ready.url, install, plan, child };
  if (!failure.exited && child.pid) {
    try {
      killOurChild(child, "ComfyUI");
    } catch {
      /* 失败清理不覆盖原因 */
    }
  }
  if (state.comfyChild === child) state.comfyChild = null;
  const reason = failure.error
    ? failure.error.message
    : failure.exited
      ? `进程退出（code=${failure.code}${failure.signal ? `，signal=${failure.signal}` : ""}）`
      : `未在 ${timeoutSec}s 内就绪`;
  return { ok: false, error: reason, install, plan };
}

async function startComfyWithFallback(cfg, { preferredPort, label = "ComfyUI", timeoutSec = cfg.comfyStartTimeoutSec } = {}) {
  const installs = collectComfyInstalls(cfg);
  if (!installs.length) return { ok: false, error: "未找到 ComfyUI 安装目录" };
  const failures = [];
  let firstAttempt = true;
  for (const install of installs) {
    log(`ComfyUI 候选路径：${install.dir}`);
    const result = await startComfyCandidate(cfg, install, { preferredPort: firstAttempt ? preferredPort : undefined, label, timeoutSec });
    firstAttempt = false;
    if (result.ok) return result;
    failures.push(`${install.dir}：${result.error}`);
    log(`候选路径启动失败（${install.dir}）：${result.error}`, "WARN");
  }
  return {
    ok: false,
    error: failures.length === 1 ? failures[0] : `所有候选路径均启动失败：${failures.join("；")}`,
  };
}

function spawnComfy(plan, port = COMFY_PORT_FIRST) {
  const options = { cwd: plan.cwd, detached: true, stdio: "ignore", windowsHide: plan.kind !== "script" };
  let child;
  if (plan.kind === "python") {
    child = spawn(plan.file, [plan.mainPy, "--port", String(port), "--listen", "127.0.0.1"], options);
  } else if (plan.kind === "desktop") {
    child = spawn(plan.file, [], { ...options, windowsHide: false });
  } else {
    const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
    child = spawn(comspec, ["/d", "/s", "/c", plan.file], { ...options, windowsHide: false });
  }
  child.on("error", (err) => log(`启动 ComfyUI 失败：${err.message}`, "ERROR"));
  child.unref();
  return child;
}

/* ------------------------------------------------------------- 网关依赖自愈 */

const GATEWAY_DEPS_ZIP = path.join(__dirname, "gateway-deps.zip");

function gatewayDepsReady(gatewayDir) {
  if (!isDir(gatewayDir)) return false;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "Promise.all([import('express'),import('multer')]).then(()=>process.exit(0),()=>process.exit(1))"],
    { cwd: gatewayDir, timeout: 30000, windowsHide: true, stdio: "ignore" },
  );
  return result.status === 0;
}

function extractGatewayDeps(archive, destination) {
  const tar = process.env.SystemRoot ? path.join(process.env.SystemRoot, "System32", "tar.exe") : "tar";
  let result = spawnSync(tar, ["-xf", archive, "-C", destination], { timeout: 120000, windowsHide: true });
  if (result.status === 0) return;
  const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  result = spawnSync(powershell, ["-NoProfile", "-Command", `Expand-Archive -LiteralPath ${quote(archive)} -DestinationPath ${quote(destination)} -Force`], {
    timeout: 120000,
    windowsHide: true,
  });
  if (result.status !== 0) throw new Error("解压网关依赖失败");
}

let gatewayDepsRepair = null;

function ensureGatewayDeps(cfg) {
  const serverDir = path.join(cfg.gatewayDir, "server");
  if (gatewayDepsReady(serverDir)) return Promise.resolve();
  if (!gatewayDepsRepair) {
    gatewayDepsRepair = (async () => {
      if (!isFile(GATEWAY_DEPS_ZIP)) {
        throw new Error(`网关依赖缺失，且找不到随包 ${GATEWAY_DEPS_ZIP}；请重新解压完整发布包，或在 comfyui-gateway/server 运行 npm install`);
      }
      log("检测到网关依赖缺失或不完整，正在用随包依赖修复…", "WARN");
      extractGatewayDeps(GATEWAY_DEPS_ZIP, serverDir);
      if (!gatewayDepsReady(serverDir)) {
        throw new Error("解压随包网关依赖后仍无法加载 express/multer；请在 comfyui-gateway/server 运行 npm install");
      }
      log("网关依赖已自动修复（随包）。");
    })().finally(() => {
      gatewayDepsRepair = null;
    });
  }
  return gatewayDepsRepair;
}

/* ------------------------------------------------------------- 网关启动 */

async function quarantineTeManData(comfyRoot) {
  if (!comfyRoot) return;
  const dataDir = path.join(ROOT, "comfyui-gateway", "data");
  const marker = path.join(dataDir, "te-man-cleanup-v2.json");
  if (isFile(marker)) return;
  const quarantineRoot = path.join(dataDir, "te-man-quarantine", `20261030-${Date.now()}`);
  const customNodes = path.join(comfyRoot, "custom_nodes", "TE_MAN");
  const bundledNodes = path.join(ROOT, "comfyui-gateway", "resources", "nodes", "unpacked", "TE_MAN");
  const moved = [];
  try {
    const move = async (source, label) => {
      if (!fs.existsSync(source)) return;
      const destination = path.join(quarantineRoot, label, path.basename(source));
      await fsp.mkdir(path.dirname(destination), { recursive: true });
      try {
        await fsp.rename(source, destination);
      } catch {
        await fsp.cp(source, destination, { recursive: true, force: true });
        await fsp.rm(source, { recursive: true, force: true });
      }
      moved.push(label);
    };
    for (const [root, prefix] of [[customNodes, "custom"], [bundledNodes, "bundled"]]) {
      await move(path.join(root, "data"), `${prefix}-data`);
      const config = path.join(root, "config_IdeaDesk.ini");
      // 只清理随包分发的旧配置（1042B），用户自己改过的配置保持不动。
      if (isFile(config) && fs.statSync(config).size === 1042) await move(config, `${prefix}-config`);
    }
    await fsp.mkdir(path.join(customNodes, "data"), { recursive: true });
    await fsp.mkdir(dataDir, { recursive: true });
    await fsp.writeFile(marker, JSON.stringify({ cleanedAt: new Date().toISOString(), moved }, null, 2));
    if (moved.length) log(`已隔离 TE_MAN 旧数据/配置 ${moved.length} 项`, "WARN");
  } catch (error) {
    log(`TE_MAN 旧数据/配置隔离失败：${error.message}`, "WARN");
  }
}

function spawnGateway(cfg, comfyUrl, workflowsDir) {
  const serverDir = path.join(cfg.gatewayDir, "server");
  const serverEntry = path.join(serverDir, "dist", "server.js");
  if (!isFile(serverEntry)) {
    throw new Error(`找不到网关入口：${serverEntry}（请先在 comfyui-gateway/server 运行 npm run build）`);
  }
  const env = {
    ...process.env,
    PORT: String(cfg.gatewayPort),
    HOST: cfg.gatewayHost || "127.0.0.1",
    ...(isLoopbackHost(cfg.gatewayHost || "127.0.0.1") ? {} : { ALLOW_REMOTE: "1" }),
    ...(cfg.corsOrigins ? { CORS_ORIGINS: cfg.corsOrigins } : {}),
    COMFY_URL: comfyUrl,
    ...(cfg.comfyDir ? { COMFYUI_DIR: cfg.comfyDir } : {}),
    ...(cfg.launcherControlUrl ? { LAUNCHER_CONTROL_URL: cfg.launcherControlUrl } : {}),
  };
  if (workflowsDir) env.COMFY_WORKFLOWS_DIR = workflowsDir;
  const child = spawn(process.execPath, [serverEntry], {
    cwd: serverDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.on("data", (d) => forwardLines(d, "gateway"));
  child.stderr.on("data", (d) => forwardLines(d, "gateway"));
  child.on("error", (err) => log(`启动网关失败：${err.message}`, "ERROR"));
  child.on("exit", (code, signal) => {
    if (state.gatewayChild === child) state.gatewayChild = null;
    if (!shuttingDown) log(`网关子进程退出（code=${code}, signal=${signal}）`, "WARN");
  });
  return child;
}

/* --------------------------------------------------------- 画布静态服务 */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};

function contentTypeFor(filePath) {
  return MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function sendFile(req, res, filePath, statusCode = 200, cacheControl = "no-cache") {
  let stat;
  try {
    stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error("not a file");
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("404 Not Found");
    return;
  }
  res.writeHead(statusCode, {
    "content-type": contentTypeFor(filePath),
    "content-length": stat.size,
    "cache-control": cacheControl,
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = fs.createReadStream(filePath);
  stream.on("error", () => res.destroy());
  stream.pipe(res);
}

function writeRuntimeConfig(cfg, gatewayUrl) {
  const file = path.join(cfg.canvasDist, "config.js");
  let runtime = {};
  try {
    const text = fs.readFileSync(file, "utf8");
    const match = text.match(/window\.__RUNTIME_CONFIG__\s*=\s*(\{[\s\S]*?\})\s*;?/);
    if (match) runtime = JSON.parse(match[1]);
  } catch {
    runtime = {};
  }
  let origin = "";
  try {
    origin = new URL(gatewayUrl).origin;
  } catch {
    origin = cfg.gatewayUrl;
  }
  runtime.LOCAL_GATEWAY_HOST = cfg.gatewayPublicHost || "127.0.0.1";
  runtime.LOCAL_GATEWAY_PORT = String(cfg.gatewayPort);
  runtime.LOCAL_GATEWAY_URL = `${origin}/v1`;
  fs.writeFileSync(file, `window.__RUNTIME_CONFIG__ = ${JSON.stringify(runtime)};\n`, "utf8");
  log(`运行时网关配置已写入：${runtime.LOCAL_GATEWAY_URL}`);
}

function createCanvasServer(cfg) {
  const distDir = path.resolve(cfg.canvasDist);
  const indexPath = path.join(distDir, "index.html");

  return http.createServer(async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { "content-type": "text/plain; charset=utf-8", allow: "GET, HEAD" });
        res.end("405 Method Not Allowed");
        return;
      }

      let pathname;
      try {
        pathname = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
      } catch {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
        res.end("400 Bad Request");
        return;
      }

      // 运行时配置由服务端直接生成：npm run build 清空 dist 后也不会丢网关地址。
      if (pathname === "/config.js") {
        let origin = cfg.gatewayUrl;
        try {
          origin = new URL(cfg.gatewayUrl).origin;
        } catch {
          /* 保持原样 */
        }
        const runtime = {
          LOCAL_GATEWAY_HOST: "127.0.0.1",
          LOCAL_GATEWAY_PORT: String(cfg.gatewayPort),
          LOCAL_GATEWAY_URL: `${origin}/v1`,
        };
        res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
        res.end(`window.__RUNTIME_CONFIG__ = ${JSON.stringify(runtime)};\n`);
        return;
      }

      const relative = pathname.replace(/^[/\\]+/, "");
      const target = path.resolve(distDir, relative);
      const insideDist = target === distDir || target.startsWith(distDir + path.sep);
      if (!insideDist) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
        res.end("403 Forbidden");
        return;
      }

      let stat = null;
      try {
        stat = await fsp.stat(target);
      } catch {
        stat = null;
      }

      if (stat && stat.isFile()) {
        const cache = pathname.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache";
        await sendFile(req, res, target, 200, cache);
        return;
      }

      // 目录（含 /）或未命中：SPA fallback 到 index.html；带扩展名的资源缺失则 404
      if (!stat || stat.isDirectory()) {
        if (path.extname(pathname)) {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("404 Not Found");
          return;
        }
        await sendFile(req, res, indexPath, 200, "no-cache");
        return;
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("404 Not Found");
    } catch (err) {
      log(`画布静态服务异常：${err.message}`, "ERROR");
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end("500 Internal Server Error");
    }
  });
}

/* --------------------------------------------------------------- 浏览器 */

function openBrowser(url) {
  if (DRY_RUN) {
    log(`[dry-run] 将打开浏览器：${url}`);
    return;
  }
  if (NO_OPEN) {
    log(`--no-open：跳过打开浏览器（${url}）`);
    return;
  }
  const comspec = process.env.ComSpec || "C:\\Windows\\System32\\cmd.exe";
  try {
    const child = spawn(comspec, ["/c", "start", "", url], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.on("error", (err) => log(`打开浏览器失败：${err.message}`, "WARN"));
    child.unref();
    log(`已请求系统浏览器打开：${url}`);
  } catch (err) {
    log(`打开浏览器失败：${err.message}`, "WARN");
  }
}

/* ------------------------------------------------------------ 生命周期 */

const state = {
  startedAt: Date.now(),
  comfyChild: null,
  adoptedComfyUrl: null,
  comfyUrl: null,
  gatewayChild: null,
  canvasServer: null,
  controlServer: null,
  restarting: false,
  comfyStartError: "",
  comfyNeedsPath: false,
  starting: { comfy: false, gateway: false, canvas: false },
};

let shuttingDown = false;

function portFromUrl(url) {
  try {
    return Number(new URL(url).port) || 0;
  } catch {
    return 0;
  }
}

function listenerPids(port) {
  if (!port || process.platform !== "win32") return [];
  const netstat = spawnSync("netstat", ["-ano"], { encoding: "utf8", windowsHide: true });
  if (netstat.status !== 0) return [];
  const pids = new Set();
  for (const line of String(netstat.stdout || "").split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5 || parts[3] !== "LISTENING" || !parts[1].endsWith(`:${port}`)) continue;
    if (/^\d+$/.test(parts[4])) pids.add(parts[4]);
  }
  return [...pids];
}

// 读取一次 AMD/Intel 显存要起一次 PowerShell（约 1s），控制台每 3s 轮询一次状态，
// 缓存 5s 可以避免把启动器的事件循环持续占住。
const GPU_SNAPSHOT_TTL_MS = 5000;

// Windows 自带的 GPU 性能计数器与厂商无关，AMD / Intel 也能读显存占用和利用率。
// 总量走注册表：Win32_VideoController.AdapterRAM 在显存超过 4GB 时会截断。
const WINDOWS_GPU_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$adapters = @(Get-CimInstance Win32_VideoController | Where-Object { $_.Name } | Select-Object Name, AdapterRAM)
$totals = @(Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Video' -ErrorAction SilentlyContinue | ForEach-Object {
  $item = Get-ItemProperty ($_.PSPath + '\\0000') -ErrorAction SilentlyContinue
  if ($item.DriverDesc -and $item.'HardwareInformation.qwMemorySize') {
    [pscustomobject]@{ name = $item.DriverDesc; bytes = [double]$item.'HardwareInformation.qwMemorySize' }
  }
})
$memory = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUAdapterMemory -ErrorAction SilentlyContinue | Where-Object { $_.Name } | Select-Object Name, DedicatedUsage, SharedUsage)
$engines = @(Get-CimInstance Win32_PerfFormattedData_GPUPerformanceCounters_GPUEngine -ErrorAction SilentlyContinue | Where-Object { $_.Name } | Select-Object Name, UtilizationPercentage)
[pscustomobject]@{ adapters = $adapters; totals = $totals; memory = $memory; engines = $engines } | ConvertTo-Json -Depth 4 -Compress
`.trim();

function parseGpuLuid(name) {
  const match = /luid_(0x[0-9a-f]+)_(0x[0-9a-f]+)_phys_(\d+)/i.exec(String(name || ""));
  return match ? `${match[1].toLowerCase()}:${match[2].toLowerCase()}:${match[3]}` : "";
}

function gpuNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 计数器实例名只有 LUID，拿不到和适配器名的一一对应关系；按「显存总量降序 ↔ 占用降序」配对。
 * 单显卡机器是精确的；多显卡时优先把占用最高的 LUID 归给显存最大的那块（通常是正在跑的独显）。
 */
function gpuFromWindowsSnapshot(raw) {
  const data = JSON.parse(String(raw || "{}"));
  const adapters = [];
  for (const item of Array.isArray(data.adapters) ? data.adapters : []) {
    const name = String(item?.Name || "").trim();
    if (!name || /microsoft basic|remote display/i.test(name)) continue;
    adapters.push({ name, adapterRam: gpuNumber(item.AdapterRAM) });
  }

  const totals = new Map();
  for (const item of Array.isArray(data.totals) ? data.totals : []) {
    const name = String(item?.name || "").trim().toLowerCase();
    const bytes = gpuNumber(item?.bytes);
    if (name && bytes > 0) totals.set(name, bytes);
  }

  const memories = [];
  for (const item of Array.isArray(data.memory) ? data.memory : []) {
    const luid = parseGpuLuid(item?.Name);
    if (!luid) continue;
    memories.push({ luid, dedicated: gpuNumber(item?.DedicatedUsage), shared: gpuNumber(item?.SharedUsage) });
  }
  memories.sort((a, b) => b.dedicated + b.shared - (a.dedicated + a.shared));

  // 计数器按「进程 + 引擎」拆分，先按引擎类型求和，再取最大值，避免多进程共用引擎时低估负载。
  const engineSums = new Map();
  for (const item of Array.isArray(data.engines) ? data.engines : []) {
    const luid = parseGpuLuid(item?.Name);
    if (!luid) continue;
    const type = /engtype_([a-z0-9]+)/i.exec(String(item?.Name || ""))?.[1]?.toLowerCase() || "all";
    const key = `${luid}|${type}`;
    engineSums.set(key, (engineSums.get(key) || 0) + Math.max(0, gpuNumber(item?.UtilizationPercentage)));
  }
  const utilization = new Map();
  for (const [key, total] of engineSums) {
    const [luid] = key.split("|");
    utilization.set(luid, Math.max(utilization.get(luid) || 0, Math.min(100, total)));
  }

  const enriched = adapters
    .map((adapter, index) => ({
      index,
      name: adapter.name,
      totalBytes: totals.get(adapter.name.toLowerCase()) || adapter.adapterRam,
    }))
    .sort((a, b) => b.totalBytes - a.totalBytes);

  if (!enriched.length) {
    return memories.map((memory, index) => ({
      index,
      name: `GPU ${index + 1}`,
      memoryUsedMb: Math.round(memory.dedicated / 1024 / 1024),
      memoryTotalMb: 0,
      utilization: utilization.get(memory.luid) || 0,
    }));
  }

  return enriched.map((adapter, position) => {
    const memory = memories[position];
    return {
      index: adapter.index,
      name: adapter.name,
      memoryUsedMb: memory ? Math.round(memory.dedicated / 1024 / 1024) : 0,
      memoryTotalMb: Math.round(adapter.totalBytes / 1024 / 1024),
      utilization: memory ? utilization.get(memory.luid) || 0 : 0,
    };
  });
}

function readNvidiaGpuSync() {
  const args = ["--query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu", "--format=csv,noheader,nounits"];
  const candidates = [
    "nvidia-smi",
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "nvidia-smi.exe"),
  ];
  let result = null;
  for (const command of candidates) {
    result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 3000 });
    if (result.status === 0) break;
  }
  if (!result || result.status !== 0) {
    const detail = String(result?.stderr || result?.stdout || "").trim();
    return { gpu: [], error: detail || "nvidia-smi 执行失败" };
  }
  const gpu = String(result.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [gpuIndex, name, used, total, utilization, temperature] = line.split(",").map((part) => part.trim());
      return {
        index: Number(gpuIndex) || index,
        name: name || "GPU",
        memoryUsedMb: Number(used) || 0,
        memoryTotalMb: Number(total) || 0,
        utilization: Number(utilization) || 0,
        temperature: Number(temperature) || 0,
      };
    });
  if (!gpu.length) return { gpu: [], error: "nvidia-smi 没有返回显卡信息" };
  return { gpu, error: null };
}

function readWindowsGpuSync() {
  const candidates = [
    path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    "powershell",
  ];
  let lastError = "";
  for (const command of candidates) {
    const result = spawnSync(command, ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_GPU_SCRIPT], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 8000,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (result.error) {
      lastError = result.error.message || String(result.error);
      // 只有「找不到这个路径」才换下一个候选；超时或权限错误重试也只会再卡一次。
      if (result.error.code === "ENOENT") continue;
      break;
    }
    if (result.status !== 0) {
      lastError = String(result.stderr || result.stdout || "").trim() || `powershell 退出码 ${result.status}`;
      continue;
    }
    try {
      const gpu = gpuFromWindowsSnapshot(result.stdout);
      if (gpu.length) return { gpu, error: null };
      lastError = "未能从 Windows GPU 计数器读取到显卡信息";
    } catch (error) {
      lastError = error?.message || String(error);
    }
  }
  return { gpu: [], error: lastError || "无法读取显存信息" };
}

let statsCache = null;
let statsCachedAt = 0;

function readSystemStats({ cacheMs = 0 } = {}) {
  if (statsCache && cacheMs > 0 && Date.now() - statsCachedAt < cacheMs) return statsCache;
  let gpu = [];
  let gpuError = null;
  try {
    if (process.platform === "win32") {
      const nvidia = readNvidiaGpuSync();
      if (nvidia.gpu.length) {
        gpu = nvidia.gpu;
      } else {
        const windows = readWindowsGpuSync();
        gpu = windows.gpu;
        if (!gpu.length) gpuError = windows.error || nvidia.error || "无法读取显存信息";
      }
    }
  } catch (error) {
    gpuError = error?.message || String(error);
  }
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const stats = {
    at: new Date().toISOString(),
    gpu,
    gpuError,
    ram: { totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes) },
  };
  statsCache = stats;
  statsCachedAt = Date.now();
  return stats;
}

// 显式退出工作台时按配置停止“接管”的 ComfyUI；Ctrl+C 不会触发。
function stopAdoptedComfyProcess(label) {
  const port = portFromUrl(state.adoptedComfyUrl);
  if (!port) return false;
  if (process.platform !== "win32") {
    log(`接管的 ${label}（端口 ${port}）未自动停止，请手动处理`, "WARN");
    return false;
  }
  const pids = listenerPids(port);
  let stopped = false;
  for (const pid of pids) {
    const result = spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore", windowsHide: true });
    if (result.status === 0) {
      log(`已停止接管的 ${label}（PID ${pid}，端口 ${port}）`);
      stopped = true;
    } else {
      log(`停止接管的 ${label}（PID ${pid}）失败，可手动处理`, "WARN");
    }
  }
  return stopped;
}

function killOurChild(child, label) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      const r = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      if (r.status === 0) log(`已停止本启动器启动的 ${label}（PID ${pid}）`);
      else log(`停止 ${label}（PID ${pid}）失败，可手动处理`, "WARN");
    } else {
      child.kill("SIGTERM");
      log(`已停止本启动器启动的 ${label}（PID ${pid}）`);
    }
  } catch (err) {
    log(`停止 ${label} 失败：${err.message}`, "WARN");
  }
}

async function shutdown(exitCode = 0, reason = "", { stopAdoptedComfy = false } = {}) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (reason) log(reason);
  log("收到退出信号，停止本启动器启动的进程…");
  if (state.controlServer) {
    state.controlServer.closeAllConnections?.();
    state.controlServer.close();
    state.controlServer = null;
  }
  if (state.canvasServer) {
    const server = state.canvasServer;
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections?.();
    });
    log("画布静态服务已关闭");
    state.canvasServer = null;
  }
  killOurChild(state.gatewayChild, "网关");
  killOurChild(state.comfyChild, "ComfyUI");
  const adoptedComfyStopped = !state.comfyChild && stopAdoptedComfy && state.adoptedComfyUrl ? stopAdoptedComfyProcess("ComfyUI") : false;
  if (adoptedComfyStopped) log("已退出。接管的网关未被触碰；接管的 ComfyUI 已按要求停止。");
  else log("已退出。接管（非本启动器启动）的服务未被触碰。");
  process.exit(exitCode);
}

/* ------------------------------------------------------ ComfyUI 清理重启 */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function restartComfy(cfg) {
  if (state.restarting) {
    const error = new Error("ComfyUI 正在重启，请稍候");
    error.status = 409;
    throw error;
  }
  state.restarting = true;
  state.starting.comfy = true;
  const startedAt = Date.now();
  const report = { ok: false, steps: [], before: null, afterKill: null, afterStart: null };
  try {
    report.before = readSystemStats();
    const targetUrl = state.comfyUrl || cfg.comfyUrl;
    const port = portFromUrl(targetUrl);
    const pids = listenerPids(port);
    const killStarted = Date.now();
    for (const pid of pids) {
      const result = spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore", windowsHide: true });
      log(result.status === 0 ? `已强制停止 ComfyUI（PID ${pid}）` : `停止 ComfyUI（PID ${pid}）失败`, result.status === 0 ? "INFO" : "WARN");
    }
    killOurChild(state.comfyChild, "ComfyUI");
    state.comfyChild = null;
    report.steps.push({ name: "停止 ComfyUI", pids, durationMs: Date.now() - killStarted });

    const closeStarted = Date.now();
    while (Date.now() - closeStarted < 30000) {
      if (!(await probeComfy(targetUrl))) break;
      await delay(500);
    }
    const portClosed = !(await probeComfy(targetUrl));
    report.steps.push({ name: "确认端口关闭", ok: portClosed, durationMs: Date.now() - closeStarted });
    if (!portClosed) throw new Error(`ComfyUI 端口 ${port} 未能在 30 秒内释放`);

    const beforeMb = report.before.gpu?.[0]?.memoryUsedMb || 0;
    let afterKill = readSystemStats();
    const vramStarted = Date.now();
    while (beforeMb > 0 && Date.now() - vramStarted < 20000) {
      const used = afterKill.gpu?.[0]?.memoryUsedMb;
      if (typeof used !== "number" || used <= Math.max(0, beforeMb - 256)) break;
      await delay(500);
      afterKill = readSystemStats();
    }
    report.afterKill = afterKill;
    report.freedMb = Math.max(0, beforeMb - (afterKill.gpu?.[0]?.memoryUsedMb || 0));
    report.steps.push({
      name: "检测显存释放",
      beforeMb,
      afterMb: afterKill.gpu?.[0]?.memoryUsedMb || 0,
      freedMb: report.freedMb,
      durationMs: Date.now() - vramStarted,
    });

    const startStarted = Date.now();
    const result = await startComfyWithFallback(cfg, {
      preferredPort: port,
      label: "ComfyUI（重启）",
      timeoutSec: cfg.comfyStartTimeoutSec,
    });
    if (!result.ok) throw new Error(result.error);
    state.comfyUrl = result.url;
    state.adoptedComfyUrl = null;
    state.comfyStartError = "";
    cfg.comfyDir = result.install.dir;
    if (result.install.workflowsDir) cfg.comfyWorkflowsDir = result.install.workflowsDir;
    persistDiscovery(cfg);
    report.afterStart = readSystemStats();
    report.steps.push({ name: "重新拉起 ComfyUI", url: result.url, durationMs: Date.now() - startStarted });
    report.ok = true;
    report.comfyUrl = result.url;
    report.durationMs = Date.now() - startedAt;
    log(`ComfyUI 清理重启完成：${result.url}，释放显存 ${report.freedMb} MB，用时 ${Math.round(report.durationMs / 1000)}s`);
    return report;
  } catch (error) {
    try {
      killOurChild(state.comfyChild, "ComfyUI");
    } catch {
      /* 失败清理不覆盖原始错误 */
    }
    state.comfyChild = null;
    state.comfyStartError = error?.message || String(error);
    report.error = error?.message || String(error);
    report.durationMs = Date.now() - startedAt;
    error.report = report;
    log(`ComfyUI 清理重启失败：${report.error}`, "ERROR");
    throw error;
  } finally {
    state.restarting = false;
    state.starting.comfy = false;
  }
}

async function collectStatus(cfg) {
  const comfyUrl = state.comfyUrl || cfg.comfyUrl;
  const [comfyReachable, gateway, canvas] = await Promise.all([
    probeComfy(comfyUrl, 900),
    httpGet(`${cfg.gatewayUrl}/health`, 1500),
    httpGet(`${cfg.canvasUrl}/`, 1500),
  ]);
  if (comfyReachable) state.comfyStartError = "";
  const system = readSystemStats({ cacheMs: GPU_SNAPSHOT_TTL_MS });
  return {
    ok: true,
    version: readLauncherVersion(),
    startedAt: new Date(state.startedAt).toISOString(),
    uptimeSec: Math.round((Date.now() - state.startedAt) / 1000),
    workspace: ROOT,
    restarting: state.restarting,
    config: {
      comfyUrl,
      comfyDir: cfg.comfyDir,
      comfyWorkflowsDir: cfg.comfyWorkflowsDir,
      gatewayPort: cfg.gatewayPort,
      controlPort: cfg.controlPort,
      canvasPort: cfg.canvasPort,
      allowLan: cfg.allowLan,
      gatewayDir: cfg.gatewayDir,
      canvasDist: cfg.canvasDist,
      stopAdoptedComfyOnExit: cfg.stopAdoptedComfyOnExit,
    },
    services: {
      comfy: {
        reachable: Boolean(comfyReachable),
        starting: state.starting.comfy,
        needsPath: state.comfyNeedsPath,
        startError: state.comfyStartError,
        url: comfyUrl,
        managed: Boolean(state.comfyChild),
        adopted: Boolean(state.adoptedComfyUrl),
        pid: state.comfyChild?.pid || null,
      },
      gateway: {
        reachable: Boolean(gateway.ok && gateway.json),
        starting: state.starting.gateway,
        url: cfg.gatewayUrl,
        managed: Boolean(state.gatewayChild),
        pid: state.gatewayChild?.pid || null,
        health: gateway.json,
      },
      canvas: {
        reachable: Boolean(canvas.ok),
        starting: state.starting.canvas,
        url: cfg.canvasUrl,
        managed: Boolean(state.canvasServer),
      },
    },
    system: {
      at: system.at,
      gpu: system.gpu,
      gpuError: system.gpuError,
      ram: system.ram,
    },
    logs: { path: LOG_PATH },
  };
}

async function startGatewayProcess(cfg) {
  if (state.gatewayChild) {
    const error = new Error("网关已在运行");
    error.status = 409;
    throw error;
  }
  await ensureGatewayDeps(cfg);
  const comfyUrl = state.comfyUrl || cfg.comfyUrl;
  const workflowsDir = cfg.comfyWorkflowsDir || "";
  state.gatewayComfyUrl = comfyUrl;
  state.gatewayWorkflowsDir = workflowsDir;
  state.starting.gateway = true;
  try {
    state.gatewayChild = spawnGateway(cfg, comfyUrl, workflowsDir);
    log(`控制台启动网关：PID=${state.gatewayChild.pid}`);
    const hit = await waitFor(
      "网关（控制台启动）",
      async () => {
        const res = await httpGet(`${cfg.gatewayUrl}/health`, 2000);
        return res.ok && res.json ? { url: cfg.gatewayUrl } : null;
      },
      cfg.gatewayStartTimeoutSec,
      { intervalMs: 1000, progressEveryMs: 5000 },
    );
    if (!hit) throw new Error("网关未在超时内就绪");
    return { ok: true, pid: state.gatewayChild.pid, url: cfg.gatewayUrl };
  } finally {
    state.starting.gateway = false;
  }
}

function stopGatewayProcess() {
  if (!state.gatewayChild) {
    const error = new Error("网关不是本启动器启动的，无法由控制台停止");
    error.status = 409;
    throw error;
  }
  const child = state.gatewayChild;
  state.gatewayChild = null;
  killOurChild(child, "网关");
  log("控制台停止网关");
  return { ok: true };
}

async function startComfyProcess(cfg) {
  if (state.starting.comfy) {
    const error = new Error("ComfyUI 正在启动");
    error.status = 409;
    throw error;
  }
  const targetUrl = state.comfyUrl || cfg.comfyUrl;
  if (await probeComfy(targetUrl, 900)) {
    const error = new Error("ComfyUI 已在运行");
    error.status = 409;
    throw error;
  }
  state.starting.comfy = true;
  state.comfyStartError = "";
  try {
    const result = await startComfyWithFallback(cfg, { label: "ComfyUI（控制台启动）", timeoutSec: cfg.comfyStartTimeoutSec });
    if (!result.ok) throw new Error(result.error);
    state.comfyUrl = result.url;
    state.adoptedComfyUrl = null;
    state.comfyStartError = "";
    state.comfyNeedsPath = false;
    cfg.comfyDir = result.install.dir;
    if (result.install.workflowsDir) cfg.comfyWorkflowsDir = result.install.workflowsDir;
    persistDiscovery(cfg);
    return { ok: true, pid: state.comfyChild?.pid || null, url: result.url };
  } catch (error) {
    state.comfyStartError = error?.message || String(error);
    throw error;
  } finally {
    state.starting.comfy = false;
  }
}

async function stopComfyProcess(cfg) {
  const targetUrl = state.comfyUrl || cfg.comfyUrl;
  const port = portFromUrl(targetUrl);
  let stopped = false;
  for (const pid of listenerPids(port)) {
    const result = spawnSync("taskkill", ["/PID", pid, "/T", "/F"], { stdio: "ignore", windowsHide: true });
    log(result.status === 0 ? `控制台停止 ComfyUI（PID ${pid}）` : `停止 ComfyUI（PID ${pid}）失败`, result.status === 0 ? "INFO" : "WARN");
    stopped = result.status === 0 || stopped;
  }
  if (state.comfyChild) {
    killOurChild(state.comfyChild, "ComfyUI");
    state.comfyChild = null;
    stopped = true;
  }
  state.adoptedComfyUrl = null;
  state.comfyStartError = "";
  if (!stopped && !(await probeComfy(targetUrl, 700))) return { ok: true, alreadyStopped: true };

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (!(await probeComfy(targetUrl, 700))) return { ok: true };
    await delay(500);
  }
  throw new Error(`ComfyUI 端口 ${port} 未能在 20 秒内释放`);
}

function readLauncherVersion() {
  try {
    return fs.readFileSync(path.join(ROOT, "VERSION"), "utf8").trim() || "dev";
  } catch {
    return "dev";
  }
}

function tailLauncherLog(lines = 200) {
  const limit = Math.max(20, Math.min(2000, Number(lines) || 200));
  try {
    const stat = fs.statSync(LOG_PATH);
    if (!stat.size) return "";
    const size = Math.min(stat.size, 512 * 1024);
    const buffer = Buffer.alloc(size);
    const fd = fs.openSync(LOG_PATH, "r");
    try {
      fs.readSync(fd, buffer, 0, size, stat.size - size);
    } finally {
      fs.closeSync(fd);
    }
    const text = buffer.toString("utf8").replace(/^\uFEFF/, "");
    return text.split(/\r?\n/).slice(-limit).join("\n");
  } catch {
    return "";
  }
}

let consoleHtmlCache = null;
let consoleHtmlMtime = 0;
function readConsoleHtml() {
  // 按修改时间刷新缓存：改完 console.html 刷新页面即可生效，不用重启启动器。
  const file = path.join(__dirname, "console.html");
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (consoleHtmlCache === null || mtime !== consoleHtmlMtime) {
      consoleHtmlCache = fs.readFileSync(file, "utf8");
      consoleHtmlMtime = mtime;
    }
  } catch {
    if (consoleHtmlCache === null) throw new Error("console.html 读取失败");
  }
  return consoleHtmlCache;
}

async function startControlServer(cfg) {
  const server = http.createServer(async (req, res) => {
    res.setHeader("content-type", "application/json; charset=utf-8");
    try {
      const pathname = new URL(req.url, "http://127.0.0.1").pathname;
      if (req.method === "GET" && pathname === "/app-icon.png") {
        try {
          const data = fs.readFileSync(path.join(__dirname, "app-icon.png"));
          res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=3600" });
          res.end(data);
        } catch {
          res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
          res.end("404 Not Found");
        }
        return;
      }
      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        try {
          res.setHeader("content-type", "text/html; charset=utf-8");
          res.setHeader("cache-control", "no-store");
          res.setHeader("content-security-policy", "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
          res.end(readConsoleHtml());
        } catch (error) {
          res.statusCode = 500;
          res.setHeader("content-type", "text/plain; charset=utf-8");
          res.end(`控制台页面读取失败：${error.message}`);
        }
        return;
      }
      if (req.method === "GET" && pathname === "/health") {
        res.end(JSON.stringify({ ok: true, restarting: state.restarting }));
        return;
      }
      if (req.method === "GET" && pathname === "/api/status") {
        res.end(JSON.stringify(await collectStatus(cfg)));
        return;
      }
      if (req.method === "GET" && pathname === "/api/logs") {
        const lines = Number(new URL(req.url, "http://127.0.0.1").searchParams.get("lines")) || 200;
        res.end(JSON.stringify({ ok: true, path: LOG_PATH, text: tailLauncherLog(lines) }));
        return;
      }
      if (req.method === "POST" && pathname === "/clear-logs") {
        fs.writeFileSync(LOG_PATH, "", "utf8");
        log("启动器日志已清空");
        res.end(JSON.stringify({ ok: true, path: LOG_PATH }));
        return;
      }
      if (req.method === "POST" && pathname === "/start-gateway") {
        res.setTimeout(120000);
        res.end(JSON.stringify(await startGatewayProcess(cfg)));
        return;
      }
      if (req.method === "POST" && pathname === "/stop-gateway") {
        res.end(JSON.stringify(stopGatewayProcess()));
        return;
      }
      if (req.method === "POST" && pathname === "/start-comfy") {
        res.setTimeout(360000);
        res.end(JSON.stringify(await startComfyProcess(cfg)));
        return;
      }
      if (req.method === "POST" && pathname === "/stop-comfy") {
        res.setTimeout(60000);
        res.end(JSON.stringify(await stopComfyProcess(cfg)));
        return;
      }
      if (req.method === "POST" && pathname === "/restart-gateway") {
        if (!state.gatewayChild) {
          res.statusCode = 409;
          res.end(JSON.stringify({ ok: false, error: "网关不是本启动器启动的，无法原地重启" }));
          return;
        }
        const previous = state.gatewayChild;
        state.gatewayChild = null;
        killOurChild(previous, "网关");
        await delay(600);
        res.setTimeout(120000);
        res.end(JSON.stringify(await startGatewayProcess(cfg)));
        return;
      }
      if (req.method === "POST" && pathname === "/shutdown") {
        res.end(JSON.stringify({ ok: true }));
        setTimeout(() => {
          void shutdown(0, "收到前端关闭请求，停止工作台…", { stopAdoptedComfy: cfg.stopAdoptedComfyOnExit });
        }, 300);
        return;
      }
      if (req.method === "POST" && pathname === "/set-comfy-dir") {
        const body = await new Promise((resolve) => {
          let raw = "";
          req.setEncoding("utf8");
          req.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > 8192) req.destroy();
          });
          req.on("end", () => {
            try {
              resolve(JSON.parse(raw || "{}"));
            } catch {
              resolve({});
            }
          });
          req.on("error", () => resolve({}));
        });
        const dir = String(body.dir || "").trim();
        if (!dir || !isDir(dir)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: `目录不存在：${dir || "（空）"}` }));
          return;
        }
        const applied = applyComfyDir(cfg, dir);
        log(`已更新 ComfyUI 目录：${applied.comfyDir}${applied.workflowsDir ? `（工作流 ${applied.workflowsDir}）` : ""}`);
        res.end(JSON.stringify({ ok: true, comfyDir: applied.comfyDir, workflowsDir: applied.workflowsDir, restartRequired: true }));
        return;
      }
      if (req.method === "POST" && pathname === "/pick-comfy-dir") {
        res.setTimeout(300000);
        try {
          const selected = await pickComfyDirectory(cfg.comfyDir || "");
          if (!selected) {
            res.end(JSON.stringify({ ok: true, canceled: true }));
            return;
          }
          if (!isDir(selected)) {
            res.statusCode = 400;
            res.end(JSON.stringify({ ok: false, error: `目录不存在：${selected}` }));
            return;
          }
          const selectedInfo = comfyInstallInfo(selected);
          const selectedPlan = resolveLaunchPlan(selectedInfo);
          if (!selectedInfo || !selectedPlan) {
            res.statusCode = 400;
            res.end(
              JSON.stringify({
                ok: false,
                error: "选择的目录不是有效的 ComfyUI 安装；请选择包含 ComfyUI/main.py、启动脚本或 ComfyUI.exe 的目录。",
              })
            );
            return;
          }
          const applied = applyComfyDir(cfg, selected);
          const running = await probeComfy(state.comfyUrl || cfg.comfyUrl, 700);
          log(`已选择 ComfyUI 启动路径：${selected}${applied.workflowsDir ? `（工作流 ${applied.workflowsDir}）` : ""}`);
          res.end(
            JSON.stringify({
              ok: true,
              path: selected,
              comfyDir: applied.comfyDir,
              workflowsDir: applied.workflowsDir,
              detected: applied.detected,
              plan: applied.plan ? { kind: applied.plan.kind, file: applied.plan.file } : null,
              autoStart: !running,
            })
          );
          if (!running) {
            void startComfyProcess(cfg).catch((error) => {
              if (error?.status === 409) return;
              state.comfyStartError = error?.message || String(error);
              log(`选择路径后启动 ComfyUI 失败：${state.comfyStartError}`, "ERROR");
            });
          }
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({ ok: false, error: error.message }));
        }
        return;
      }
      if (req.method === "POST" && pathname === "/set-comfy-workflows-dir") {
        const body = await new Promise((resolve) => {
          let raw = "";
          req.setEncoding("utf8");
          req.on("data", (chunk) => {
            raw += chunk;
            if (raw.length > 8192) req.destroy();
          });
          req.on("end", () => {
            try {
              resolve(JSON.parse(raw || "{}"));
            } catch {
              resolve({});
            }
          });
          req.on("error", () => resolve({}));
        });
        const raw = String(body.dir || "").trim();
        if (raw && !isDir(raw)) {
          res.statusCode = 400;
          res.end(JSON.stringify({ ok: false, error: `目录不存在：${raw}` }));
          return;
        }
        cfg.comfyWorkflowsDir = raw ? path.resolve(raw) : "";
        persistDiscovery(cfg);
        log(`已更新工作流目录：${cfg.comfyWorkflowsDir || "（未设置）"}`);
        res.end(JSON.stringify({ ok: true, workflowsDir: cfg.comfyWorkflowsDir }));
        return;
      }
      if (req.method === "POST" && pathname === "/restart-comfy") {
        res.setTimeout(360000);
        const report = await restartComfy(cfg);
        res.end(JSON.stringify(report));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: "not found" }));
    } catch (error) {
      res.statusCode = error?.status || 500;
      res.end(JSON.stringify({ ok: false, error: error?.message || String(error), ...(error?.report || {}) }));
    }
  });
  server.requestTimeout = 0;
  return new Promise((resolve) => {
    server.once("error", (error) => {
      log(`控制接口启动失败（${cfg.controlUrl}）：${error.message}`, "WARN");
      resolve(false);
    });
    server.listen(cfg.controlPort, "127.0.0.1", () => {
      state.controlServer = server;
      log(`控制接口已启动：${cfg.controlUrl}/（启动器控制台 + ComfyUI 清理重启）`);
      resolve(true);
    });
  });
}

/* ------------------------------------------------------------------ 主流程 */

function fmtStatus(mode) {
  if (mode === "adopt") return "接管";
  if (mode === "started") return "已启动";
  if (mode === "missing") return "未找到";
  if (mode === "planned") return "将启动";
  return mode;
}

async function main() {
  const rotatedTo = rotateLauncherLog();
  log(`===== 本地一键启动器 ${DRY_RUN ? "[dry-run] " : ""}=====`);
  if (rotatedTo) log(`启动器日志超过 5MB，已轮转到 ${rotatedTo}`);
  log(`工作区：${ROOT}`);
  log(`Node：${process.execPath} (${process.version})`);

  const cfg = loadConfig();
  log(`配置：${CONFIG_PATH}${cfg.configCreated ? "（已创建默认配置）" : "（已加载）"}`);
  log(
    `参数：comfyUrl=${cfg.comfyUrl} gatewayPort=${cfg.gatewayPort} controlPort=${cfg.controlPort} canvasPort=${cfg.canvasPort} ` +
      `gatewayDir=${cfg.gatewayDir} canvasDist=${cfg.canvasDist}`
  );
  if (DRY_RUN) log("dry-run：只做检测与打印，不启动任何进程，不监听端口");
  if (!DRY_RUN) {
    const installedWorkflows = await installBundledWorkflows({
      root: ROOT,
      workflowDir: path.join(cfg.gatewayDir, "workflows"),
      log,
    });
    if (installedWorkflows.length) {
      log(`已从随包工作流补齐 ${installedWorkflows.length} 个文件；已有的用户工作流保持不变`);
    }
  }
  cfg.launcherControlUrl = "";
  if (!DRY_RUN) {
    const controlReady = await startControlServer(cfg);
    if (controlReady) cfg.launcherControlUrl = cfg.controlUrl;
  }

  /* 1. 检测 */
  const comfyHit = await detectComfy(cfg);
  let comfy = null;
  if (comfyHit) {
    comfy = { url: comfyHit.url, mode: "adopt" };
    state.comfyStartError = "";
    log(`ComfyUI 已在运行（${comfyHit.url}，${comfyHit.via}）→ 接管，不重复启动`);
  } else {
    log("ComfyUI 未运行（8188–8199 与 config.comfyUrl 均无响应）");
  }

  const gatewayHit = await detectGateway(cfg);
  let gateway = null;
  if (gatewayHit) {
    gateway = { url: gatewayHit.url, mode: "adopt" };
    const comfyInfo = gatewayHit.health?.comfy?.reachable;
    log(
      `网关已在运行（${gatewayHit.url}/health 可达${
        comfyInfo === undefined ? "" : `，其内部 ComfyUI 视角 reachable=${comfyInfo}`
      }）→ 接管，不重复启动`
    );
  } else {
    log(`网关未运行（${cfg.gatewayUrl}/health 无响应）`);
  }

  const canvasHit = await detectCanvas(cfg);
  let canvas = null;
  if (canvasHit) {
    canvas = { url: canvasHit.url, mode: "adopt" };
    log(`画布已在运行（${canvasHit.url}/）→ 接管，不重复启动`);
  } else {
    log(`画布未运行（${cfg.canvasUrl}/ 无响应）`);
  }

  /* 2. ComfyUI */
  let comfyInstall = findComfyInstall(cfg);
  if (comfyInstall && (!cfg.comfyDir || (!cfg.comfyWorkflowsDir && comfyInstall.workflowsDir))) {
    cfg.comfyDir = cfg.comfyDir || comfyInstall.dir;
    cfg.comfyWorkflowsDir = cfg.comfyWorkflowsDir || comfyInstall.workflowsDir;
    persistDiscovery(cfg);
    log(`记录 ComfyUI 安装目录：${cfg.comfyDir}${cfg.comfyWorkflowsDir ? `，工作流目录：${cfg.comfyWorkflowsDir}` : ""}`);
  }
  if (comfyInstall && !DRY_RUN) {
    const comfyRoot = comfyInstall.mainPy
      ? path.dirname(comfyInstall.mainPy)
      : (isDir(path.join(comfyInstall.dir, "ComfyUI")) ? path.join(comfyInstall.dir, "ComfyUI") : comfyInstall.dir);
    const installed = await installBundledNodes({ root: ROOT, comfyRoot, comfyUrl: comfy || "", log });
    await quarantineTeManData(comfyRoot);
    if (installed.length) log(`已自动放置 ${installed.length} 个内置节点包${comfy ? "；ComfyUI 已在运行，重启后生效" : ""}`);
  }
  if (!comfy) {
    const comfyPlan = comfyInstall ? resolveLaunchPlan(comfyInstall) : null;
    state.comfyNeedsPath = !comfyInstall || !comfyPlan;
    if (state.comfyNeedsPath) {
      log("未检测到可用的 ComfyUI 安装目录，请在控制台选择 ComfyUI 路径。", "WARN");
    }
    if (DRY_RUN) {
      const plan = resolveLaunchPlan(comfyInstall);
      if (!comfyInstall) {
        log("未找到 ComfyUI 安装目录（已查环境变量 COMFYUI_DIR、config.comfyDir、C/D/E:\\ComfyUI、" +
          "%USERPROFILE%\\ComfyUI、%USERPROFILE%\\Documents\\ComfyUI、E:\\ComfyUI_windows_portable、" +
          "E:\\ComfyUI\\ComfyUI）。", "ERROR");
        comfy = { url: cfg.comfyUrl, mode: "missing" };
      } else if (!plan) {
        log(`找到 ComfyUI 目录 ${comfyInstall.dir}，但没找到可用的启动方式（启动脚本 / python_embeded+main.py / 桌面版 exe）`, "ERROR");
        comfy = { url: cfg.comfyUrl, mode: "missing" };
      } else {
        const launchPort = plan.kind === "python" ? await pickFreePort(comfyPortCandidates(cfg)) : COMFY_PORT_FIRST;
        const planLabel = plan.kind === "desktop"
          ? `桌面版 ${plan.file}`
          : plan.kind === "python"
            ? `${plan.file} ${plan.mainPy} --port ${launchPort}`
            : `启动脚本 ${plan.file}`;
        log(`ComfyUI 安装目录：${comfyInstall.dir}`);
        log(`ComfyUI 启动方式：${planLabel}`);
        if (comfyInstall.workflowsDir) log(`ComfyUI 用户工作流目录：${comfyInstall.workflowsDir}`);
        log(`[dry-run] 将启动 ComfyUI：${planLabel}（cwd=${plan.cwd}，等待 /system_stats 最多 ${cfg.comfyStartTimeoutSec}s）`);
        comfy = { url: `http://127.0.0.1:${launchPort}`, mode: "planned" };
      }
    } else {
      state.starting.comfy = true;
      state.comfyStartError = "";
      try {
        const result = await startComfyWithFallback(cfg, { label: "ComfyUI", timeoutSec: cfg.comfyStartTimeoutSec });
        if (result.ok) {
          comfy = { url: result.url, mode: "started" };
          state.comfyStartError = "";
          cfg.comfyDir = result.install.dir;
          if (result.install.workflowsDir) cfg.comfyWorkflowsDir = result.install.workflowsDir;
          persistDiscovery(cfg);
          log(`ComfyUI 已启动：${result.url}`);
        } else {
          comfy = { url: cfg.comfyUrl, mode: "missing" };
          state.comfyStartError = result.error;
          log(`ComfyUI 启动失败：${result.error}`, "ERROR");
          log("继续启动网关；可在控制台「选择 ComfyUI 路径」后重试。", "WARN");
        }
      } finally {
        state.starting.comfy = false;
      }
    }
  }
  const comfyReady = comfy.mode === "adopt" || comfy.mode === "started";
  state.adoptedComfyUrl = comfy.mode === "adopt" ? comfy.url : null;
  state.comfyUrl = comfyReady ? comfy.url : cfg.comfyUrl;

  /* 3. 网关 */
  let gatewayResult = gateway;
  if (!gateway) {
    const workflowsDir = cfg.comfyWorkflowsDir || comfyInstall?.workflowsDir || "";
    if (workflowsDir) log(`网关将使用 COMFY_WORKFLOWS_DIR=${workflowsDir}`);
    const comfyUrl = comfy?.url || cfg.comfyUrl;

    if (DRY_RUN) {
      log(
        `[dry-run] 将启动网关：${process.execPath} ${path.join(cfg.gatewayDir, "server", "dist", "server.js")} ` +
          `（cwd=${path.join(cfg.gatewayDir, "server")}，PORT=${cfg.gatewayPort}，COMFY_URL=${comfyUrl}，等待 /health 最多 ${cfg.gatewayStartTimeoutSec}s）`
      );
      gatewayResult = { url: cfg.gatewayUrl, mode: "planned" };
    } else {
      state.starting.gateway = true;
      try {
        log(`启动网关：${path.join(cfg.gatewayDir, "server", "dist", "server.js")}（PORT=${cfg.gatewayPort}，COMFY_URL=${comfyUrl}）`);
        try {
          await ensureGatewayDeps(cfg);
          state.gatewayComfyUrl = comfyUrl;
          state.gatewayWorkflowsDir = workflowsDir;
          state.gatewayChild = spawnGateway(cfg, comfyUrl, workflowsDir);
        } catch (err) {
          log(err.message, "ERROR");
          log("网关无法启动，画布即便打开也无法生成内容；请修复后重试。", "ERROR");
          await shutdown(1);
          return;
        }
        log(`网关子进程 PID=${state.gatewayChild.pid}，等待 /health（上限 ${cfg.gatewayStartTimeoutSec}s）`);
        const hit = await waitFor(
          "网关",
          async () => {
            const res = await httpGet(`${cfg.gatewayUrl}/health`, 2000);
            return res.ok && res.json ? { url: cfg.gatewayUrl } : null;
          },
          cfg.gatewayStartTimeoutSec,
          { intervalMs: 1500, progressEveryMs: 10000 }
        );
        if (!hit) {
          log(`网关启动失败，请查看 launcher/launcher.log 与上方 [gateway] 日志。`, "ERROR");
          await shutdown(1);
          return;
        }
        gatewayResult = { url: cfg.gatewayUrl, mode: "started" };
        log(`网关已启动：${cfg.gatewayUrl}/health`);
        if (comfyReady) log(`已向网关注入 COMFY_URL=${comfyUrl}`);
      } finally {
        state.starting.gateway = false;
      }
    }
  }

  /* 4. 画布静态服务 */
  let canvasResult = canvas;
  if (!canvas) {
    if (!isDir(cfg.canvasDist) || !isFile(path.join(cfg.canvasDist, "index.html"))) {
      log(`画布静态产物缺失：${cfg.canvasDist}`, "ERROR");
      log("请先构建：cd infinite-canvas\\web && npm install && npm run build", "ERROR");
      await shutdown(1);
      return;
    }
    if (DRY_RUN) {
      log(`[dry-run] 将在 http://${browseHostFor(cfg.canvasHost)}:${cfg.canvasPort} 托管 ${cfg.canvasDist}（SPA fallback → index.html，绑 ${cfg.canvasHost}）`);
      canvasResult = { url: cfg.canvasUrl, mode: "planned" };
    } else {
      try {
        writeRuntimeConfig(cfg, cfg.gatewayPublicUrl || gatewayResult.url);
      } catch (error) {
        log(`写入运行时网关配置失败：${error.message}`, "WARN");
      }
      let listen;
      state.starting.canvas = true;
      try {
        listen = await listenCanvasServer(cfg, cfg.canvasPort);
      } catch (error) {
        log(`画布静态服务启动失败：${error.message}`, "ERROR");
        await shutdown(1);
        return;
      } finally {
        state.starting.canvas = false;
      }
      if (listen.port !== cfg.canvasPort) {
        log(`画布端口 ${cfg.canvasPort} 已被其他程序占用，改用空闲端口 ${listen.port}`);
        cfg.canvasPort = listen.port;
        cfg.canvasUrl = `http://${browseHostFor(cfg.canvasHost)}:${listen.port}`;
      }
      state.canvasServer = listen.server;
      canvasResult = { url: cfg.canvasUrl, mode: "started" };
      log(`画布已托管：${cfg.canvasUrl}/ ← ${cfg.canvasDist}（SPA fallback 已启用，绑 ${cfg.canvasHost}）`);
    }
  }

  /* 5. 汇总 + 浏览器 */
  log("---------------- 服务状态 ----------------");
  log(`ComfyUI : ${fmtStatus(comfy.mode)}  ${comfyReady ? comfy.url : "（不可用）"}`);
  log(`网关    : ${fmtStatus(gatewayResult.mode)}  ${gatewayResult.url}`);
  if (cfg.gatewayPublicUrl && cfg.gatewayPublicUrl !== gatewayResult.url) log(`对外网关: ${cfg.gatewayPublicUrl}`);
  log(`画布    : ${fmtStatus(canvasResult.mode)}  ${canvasResult.url}`);
  if (state.controlServer) log(`控制台  : 已启动  ${cfg.controlUrl}/`);
  log("------------------------------------------");

  const consoleReady = Boolean(state.controlServer);
  const target = consoleReady && cfg.openConsole ? `${cfg.controlUrl}/` : comfyReady ? `${canvasResult.url}/canvas` : `${cfg.gatewayUrl}/admin`;
  if (!comfyReady) {
    log("ComfyUI 未就绪：控制台会显示真实状态；也可打开 /admin 查看网关。", "WARN");
  }
  if (DRY_RUN) {
    log(`[dry-run] 将打开：${target}`);
    log("dry-run 结束（未启动任何进程）。");
    return;
  }

  if (cfg.openBrowser) openBrowser(target);
  else if (consoleReady) log(`config.openBrowser=false，启动器控制台：${cfg.controlUrl}/`);
  else log(`config.openBrowser=false，未自动打开：${target}`);

  log("启动器前台运行中。关闭画布不会停止后台；按 Ctrl+C 或从托盘退出时才会停止本启动器启动的进程。");

  await new Promise((resolve) => {
    process.on("SIGINT", () => {
      log("捕获 Ctrl+C");
      resolve();
    });
    process.on("SIGBREAK", () => {
      log("捕获 Ctrl+Break");
      resolve();
    });
    process.on("SIGTERM", () => {
      log("捕获 SIGTERM");
      resolve();
    });
  });
  await shutdown(0);
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch(async (err) => {
    log(`启动器异常：${err?.stack || err}`, "ERROR");
    try {
      await shutdown(1);
    } catch {
      process.exit(1);
    }
  });
}

export { comfyInstallInfo, resolveLaunchPlan, comfyPortCandidates, detectComfy, probeAnyComfy, listenCanvasServer, isLoopbackHost, normalizeHost, browseHostFor, gpuFromWindowsSnapshot, readSystemStats };
