import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
const BRIDGE_SOURCE = fileURLToPath(new URL("../../../comfyui-bridge/open-workflow.js", import.meta.url));
const BRIDGE_DIR = path.join("extensions", "local-canvas");
const BRIDGE_FILE = "open-workflow.js";
const SITE_PACKAGES_FRONTEND = path.join("Lib", "site-packages", "comfyui_frontend_package", "static");
const FRONTEND_CANDIDATES = [
    path.join("python_embeded", "Lib", "site-packages", "comfyui_frontend_package", "static"),
    path.join("ComfyUI", "python_embeded", "Lib", "site-packages", "comfyui_frontend_package", "static"),
    path.join(".venv", SITE_PACKAGES_FRONTEND),
    path.join("ComfyUI", ".venv", SITE_PACKAGES_FRONTEND),
    path.join("standalone-env", SITE_PACKAGES_FRONTEND),
    path.join("ComfyUI", "standalone-env", SITE_PACKAGES_FRONTEND),
    path.join("env", SITE_PACKAGES_FRONTEND),
    path.join("ComfyUI", "env", SITE_PACKAGES_FRONTEND),
    path.join("venv", SITE_PACKAGES_FRONTEND),
    path.join("ComfyUI", "venv", SITE_PACKAGES_FRONTEND),
    "web",
    path.join("ComfyUI", "web"),
];
function normalize(value) {
    return String(value || "").replace(/\\/g, "/").replace(/\/+$/, "");
}
function installRoots(config) {
    const roots = new Set();
    const add = (dir) => {
        if (!dir)
            return;
        roots.add(path.resolve(dir));
    };
    if (config.comfyDir)
        add(config.comfyDir);
    const workflowDirs = config.comfyWorkflowsDirs?.length ? config.comfyWorkflowsDirs : [config.comfyWorkflowsDir].filter(Boolean);
    for (const dir of workflowDirs) {
        const workflows = normalize(dir);
        for (const suffix of ["/ComfyUI/user/default/workflows", "/user/default/workflows"]) {
            if (!workflows.endsWith(suffix))
                continue;
            const base = workflows.slice(0, -suffix.length);
            add(base);
            add(path.dirname(base));
            add(path.join(base, "ComfyUI"));
        }
    }
    return [...roots];
}
async function desktopInstallRoots() {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const installsRoot = path.join(localAppData, "Comfy-Desktop", "ComfyUI-Installs");
    const roots = [];
    try {
        for (const entry of await fsp.readdir(installsRoot, { withFileTypes: true })) {
            if (entry.isDirectory())
                roots.push(path.join(installsRoot, entry.name));
        }
    }
    catch {
        // ComfyUI Desktop is not installed for this user.
    }
    roots.push(installsRoot, path.join(localAppData, "Programs", "@comfyorgcomfyui-electron", "resources", "ComfyUI"), path.join(localAppData, "Programs", "ComfyUI"));
    return roots;
}
async function frontendCandidates(config) {
    const candidates = [];
    if (config.comfyFrontendDir)
        candidates.push(path.resolve(config.comfyFrontendDir));
    for (const root of [...installRoots(config), ...(await desktopInstallRoots())]) {
        for (const relative of FRONTEND_CANDIDATES)
            candidates.push(path.join(root, relative));
    }
    return [...new Set(candidates)];
}
async function isFrontendDir(dir) {
    if (!dir)
        return false;
    try {
        await fsp.access(path.join(dir, "scripts", "app.js"));
        await fsp.access(path.join(dir, "index.html"));
        return true;
    }
    catch {
        return false;
    }
}
async function findFrontendDir(config) {
    for (const candidate of await frontendCandidates(config)) {
        if (await isFrontendDir(candidate))
            return candidate;
    }
    return "";
}
export function createComfyBridge({ config, logger } = {}) {
    let cached = null;
    let checkedAt = 0;
    let checking = null;
    async function install() {
        const frontendDir = await findFrontendDir(config);
        if (!frontendDir) {
            return {
                installed: false,
                reason: "未找到 ComfyUI 前端目录（可设置 COMFY_FRONTEND_DIR 或 comfyFrontendDir）",
            };
        }
        const targetDir = path.join(frontendDir, BRIDGE_DIR);
        const targetFile = path.join(targetDir, BRIDGE_FILE);
        const source = await fsp.readFile(BRIDGE_SOURCE, "utf8");
        let current = "";
        try {
            current = await fsp.readFile(targetFile, "utf8");
        }
        catch {
            // First install.
        }
        if (current !== source) {
            await fsp.mkdir(targetDir, { recursive: true });
            await fsp.writeFile(targetFile, source, "utf8");
            logger?.info?.(`已安装 ComfyUI 工作流桥接扩展：${targetFile}`);
        }
        return { installed: true, frontendDir, file: targetFile, updated: current !== source };
    }
    async function ensure({ force = false } = {}) {
        if (!force && cached && Date.now() - checkedAt < 60 * 1000)
            return cached;
        if (!checking) {
            checking = install()
                .then((result) => {
                cached = result;
                checkedAt = Date.now();
                return result;
            })
                .catch((error) => {
                logger?.warn?.(`安装 ComfyUI 工作流桥接失败：${error.message}`);
                return { installed: false, reason: error.message };
            })
                .finally(() => {
                checking = null;
            });
        }
        return checking;
    }
    return { ensure, findFrontendDir };
}
