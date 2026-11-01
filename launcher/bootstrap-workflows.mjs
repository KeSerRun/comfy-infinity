import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

function isFile(file) {
    try {
        return fs.statSync(file).isFile();
    } catch {
        return false;
    }
}

function isDir(dir) {
    try {
        return fs.statSync(dir).isDirectory();
    } catch {
        return false;
    }
}

function mergeRegistry(bundleFile, targetFile, log) {
    let bundled;
    let local;
    try {
        bundled = JSON.parse(fs.readFileSync(bundleFile, "utf8").replace(/^\uFEFF/, ""));
        local = JSON.parse(fs.readFileSync(targetFile, "utf8").replace(/^\uFEFF/, ""));
    } catch (error) {
        log(`[workflow-bootstrap] registry.json 合并跳过：${error.message}`, "WARN");
        return [];
    }
    const workflows = Array.isArray(local.workflows) ? local.workflows : [];
    if (!Array.isArray(bundled.workflows)) return [];
    const existing = new Set(workflows.map((item) => String(item?.id || "")));
    const added = bundled.workflows.filter((item) => item?.id && !existing.has(String(item.id)));
    if (!added.length) return [];
    local.workflows = [...workflows, ...added];
    const temp = `${targetFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(local, null, 2)}\n`, "utf8");
    fs.renameSync(temp, targetFile);
    return added.map((item) => String(item.id));
}

export async function installBundledWorkflows({ root, workflowDir, log = console.log } = {}) {
    if (!workflowDir) return [];
    const bundleDir = path.join(root, "comfyui-gateway", "resources", "workflows");
    if (!isDir(bundleDir)) return [];
    await fsp.mkdir(workflowDir, { recursive: true });
    const installed = [];

    async function copyMissing(directory) {
        const entries = await fsp.readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
            if (entry.name === "registry.json") continue;
            const source = path.join(directory, entry.name);
            const relative = path.relative(bundleDir, source);
            const target = path.join(workflowDir, relative);
            if (entry.isDirectory()) {
                await copyMissing(source);
                continue;
            }
            if (!entry.isFile() || isFile(target)) continue;
            await fsp.mkdir(path.dirname(target), { recursive: true });
            await fsp.copyFile(source, target);
            installed.push(relative.split(path.sep).join("/"));
            log(`[workflow-bootstrap] 复制默认工作流：${relative}`);
        }
    }

    await copyMissing(bundleDir);

    const bundledRegistry = path.join(bundleDir, "registry.json");
    const targetRegistry = path.join(workflowDir, "registry.json");
    if (isFile(bundledRegistry)) {
        if (!isFile(targetRegistry)) {
            await fsp.copyFile(bundledRegistry, targetRegistry);
            installed.push("registry.json");
            log("[workflow-bootstrap] 复制默认 registry.json");
        } else {
            const added = mergeRegistry(bundledRegistry, targetRegistry, log);
            if (added.length) {
                installed.push(...added.map((id) => `registry:${id}`));
                log(`[workflow-bootstrap] registry.json 补充 ${added.length} 个默认工作流条目`);
            }
        }
    }

    return installed;
}
