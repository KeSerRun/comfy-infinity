"use strict";

/**
 * 桌面外壳的纯函数部分（不依赖 electron），便于单独测试。
 */

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_CONTROL_PORT = 8290;
const DEFAULT_CANVAS_PORT = 3000;
const DEFAULT_GATEWAY_PORT = 8190;

function isFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

/**
 * 从若干起点向上找包含 launcher/start.mjs 的项目根目录。
 * 依次尝试：显式传入的目录、环境变量、可执行文件所在目录。
 */
function findRepoRoot(candidates = []) {
  const starts = [
    ...candidates,
    process.env.COMFY_INFINITY_ROOT,
    typeof __dirname === "string" ? __dirname : "",
    process.resourcesPath,
    path.dirname(process.execPath),
  ].filter(Boolean);

  const seen = new Set();
  for (const candidate of starts) {
    let dir = path.resolve(candidate);
    if (isFile(dir)) dir = path.dirname(dir);
    for (let depth = 0; depth < 8; depth += 1) {
      const key = dir.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        if (isFile(path.join(dir, "launcher", "start.mjs"))) return dir;
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return "";
}

function readLauncherConfig(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
  } catch {
    return {};
  }
}

function positivePort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : fallback;
}

function resolvePorts(fileConfig = {}, env = process.env) {
  return {
    controlPort: positivePort(env.LAUNCHER_CONTROL_PORT ?? fileConfig.controlPort, DEFAULT_CONTROL_PORT),
    canvasPort: positivePort(env.CANVAS_PORT ?? fileConfig.canvasPort, DEFAULT_CANVAS_PORT),
    gatewayPort: positivePort(env.GATEWAY_PORT ?? fileConfig.gatewayPort, DEFAULT_GATEWAY_PORT),
  };
}

/**
 * 有随包 node 就用它；否则让 electron 以 node 模式运行（ELECTRON_RUN_AS_NODE）。
 */
function nodeLaunchCommand(root, { execPath = process.execPath, platform = process.platform } = {}) {
  const bundled = path.join(root, "node", platform === "win32" ? "node.exe" : "node");
  if (isFile(bundled)) return { command: bundled, electronRunAsNode: false };
  return { command: execPath, electronRunAsNode: true };
}

module.exports = {
  DEFAULT_CONTROL_PORT,
  DEFAULT_CANVAS_PORT,
  DEFAULT_GATEWAY_PORT,
  findRepoRoot,
  isFile,
  nodeLaunchCommand,
  positivePort,
  readLauncherConfig,
  resolvePorts,
};
