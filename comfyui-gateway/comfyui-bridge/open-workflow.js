import { app } from "../../scripts/app.js";

const LOADED_KEY = "__localCanvasOpenWorkflowLoaded";
const SAVE_TARGET_KEY = "__localCanvasSaveTarget";
const PARAM_ID = "local_canvas_open";
const PARAM_FILE = "local_canvas_file";
const PARAM_GATEWAY = "local_canvas_gw";
const DEBOUNCE_MS = 900;
const FALLBACK_MS = 12000;

function showBanner(message, bad = false) {
  (bad ? console.error : console.log)("[LocalCanvas]", message);
  const banner = document.createElement("div");
  banner.textContent = `本地无限画布：${message}`;
  Object.assign(banner.style, {
    position: "fixed",
    left: "50%",
    bottom: "28px",
    transform: "translateX(-50%)",
    zIndex: "100000",
    padding: "10px 16px",
    borderRadius: "10px",
    background: bad ? "#3b1f1f" : "#173a2a",
    color: bad ? "#ffd7d7" : "#d7ffe7",
    border: `1px solid ${bad ? "#a55" : "#3a8"}`,
    font: "13px/1.4 system-ui, sans-serif",
    boxShadow: "0 10px 40px rgba(0,0,0,.45)",
    maxWidth: "70vw",
  });
  document.body.appendChild(banner);
  setTimeout(() => banner.remove(), bad ? 10000 : 5000);
}

function showNotice(message) {
  showBanner(message, false);
}

function showError(message) {
  showBanner(message, true);
}

function readTarget() {
  const params = new URLSearchParams(window.location.search);
  const id = params.get(PARAM_ID);
  const file = params.get(PARAM_FILE);
  if (!id && !file) return null;
  let gateway;
  try {
    gateway = new URL(params.get(PARAM_GATEWAY) || "", window.location.href);
  } catch {
    return null;
  }
  if (gateway.protocol !== "http:" && gateway.protocol !== "https:") return null;
  const sameHost = gateway.hostname === window.location.hostname;
  const loopback = gateway.hostname === "127.0.0.1" || gateway.hostname === "localhost" || gateway.hostname === "::1" || gateway.hostname === "[::1]";
  if (!sameHost && !loopback) return null;
  return id ? { id, gateway: gateway.origin } : { file, gateway: gateway.origin };
}

function cleanUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete(PARAM_ID);
  url.searchParams.delete(PARAM_FILE);
  url.searchParams.delete(PARAM_GATEWAY);
  window.history.replaceState(window.history.state, "", url.toString());
}

function looksLikeApiWorkflow(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.values(value);
  return entries.length > 0 && entries.every((node) => node && typeof node === "object" && typeof node.class_type === "string");
}

let loadingTarget = false;

async function loadRequestedWorkflow() {
  if (window[LOADED_KEY]) return;
  const target = readTarget();
  if (!target) return;
  window[LOADED_KEY] = true;
  loadingTarget = true;
  try {
    const endpoint = target.file
      ? `${target.gateway}/api/workflow-files/raw?file=${encodeURIComponent(target.file)}`
      : `${target.gateway}/api/free-workflows/${encodeURIComponent(target.id)}/ui`;
    const response = await fetch(endpoint, { cache: "no-store" });
    if (!response.ok) throw new Error(`网关返回 HTTP ${response.status}`);
    const data = await response.json();
    if (!data?.workflow) throw new Error("工作流内容为空");
    if (data.format === "api" || looksLikeApiWorkflow(data.workflow)) {
      await app.loadApiJson(data.workflow, data.name || "工作流");
    } else {
      await app.loadGraphData(data.workflow, true, true, data.sourceRel || null);
    }
    window[SAVE_TARGET_KEY] = target.file
      ? { file: target.file, gateway: target.gateway, format: data.format === "ui" ? "ui" : "api" }
      : null;
    cleanUrl();
    if (target.file) showNotice(`已打开 ${target.file}；Ctrl+S 将保存回原目录`);
  } catch (error) {
    window[LOADED_KEY] = false;
    showError(`无法自动打开工作流「${target.id || target.file}」：${error?.message || error}`);
  } finally {
    loadingTarget = false;
  }
}

async function saveRequestedWorkflow() {
  const target = window[SAVE_TARGET_KEY];
  if (!target?.file) return;
  try {
    const serialized = target.format === "api"
      ? (await app.graphToPrompt()).output
      : app.graph.serialize();
    const response = await fetch(`${target.gateway}/api/workflow-files/save`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: target.file, workflow: serialized }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(data?.error?.message || `网关返回 HTTP ${response.status}`);
    }
    showNotice(`已保存到 ${data.file || target.file}`);
  } catch (error) {
    showError(`保存工作流失败：${error?.message || error}`);
  }
}

function installSaveShortcut() {
  if (window.__localCanvasSaveShortcut) return;
  window.__localCanvasSaveShortcut = true;
  window.addEventListener("keydown", (event) => {
    if (!window[SAVE_TARGET_KEY]?.file) return;
    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void saveRequestedWorkflow();
  }, true);
}

let timer = null;
function scheduleLoad(delay = DEBOUNCE_MS) {
  if (window[LOADED_KEY]) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    timer = null;
    void loadRequestedWorkflow();
  }, delay);
}

app.registerExtension({
  name: "LocalCanvas.OpenWorkflow",
  setup() {
    installSaveShortcut();
    if (readTarget()) scheduleLoad(FALLBACK_MS);
  },
  afterLoadGraph() {
    // 用户在同一标签页打开别的工作流后，不能再把 Ctrl+S 写回旧文件。
    if (!loadingTarget && !readTarget()) window[SAVE_TARGET_KEY] = null;
    // ComfyUI restores the last session / workflow tabs after app.setup().
    // Debouncing the loader until those loads settle keeps our target workflow
    // as the active one instead of being replaced by the restored session.
    if (readTarget()) scheduleLoad();
  },
});
