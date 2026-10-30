import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
const GPU_FIELDS = "index,name,memory.used,memory.total,utilization.gpu,temperature.gpu";
const GPU_TIMEOUT_MS = 8000;
const MIB = 1024 * 1024;
let cached = null;
let cachedAt = 0;
let pending = null;
let lastGoodGpu = null;
function readRam() {
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    return { totalBytes, freeBytes, usedBytes: Math.max(0, totalBytes - freeBytes) };
}
function nvidiaSmiCandidates() {
    const candidates = ["nvidia-smi"];
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    candidates.push(path.join(systemRoot, "System32", "nvidia-smi.exe"));
    return candidates;
}
function powershellCandidates() {
    const systemRoot = process.env.SystemRoot || "C:\\Windows";
    return [
        path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        "powershell",
    ];
}
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
function parseLuid(name) {
    const match = /luid_(0x[0-9a-f]+)_(0x[0-9a-f]+)_phys_(\d+)/i.exec(String(name || ""));
    return match ? `${match[1].toLowerCase()}:${match[2].toLowerCase()}:${match[3]}` : "";
}
function toNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}
/**
 * 把 Windows 快照转换成语义化的显卡列表。
 * 计数器的实例名只有 LUID，拿不到和适配器名的一一对应关系；这里按「显存总量降序 ↔ 占用降序」配对，
 * 单显卡机器是精确的，多显卡时优先把占用最高的 LUID 归给显存最大的那块（通常是正在跑的独显）。
 */
export function gpuFromWindowsSnapshot(raw) {
    const data = JSON.parse(String(raw || "{}"));
    const adapters = [];
    for (const item of Array.isArray(data.adapters) ? data.adapters : []) {
        const name = String(item?.Name || "").trim();
        if (!name || /microsoft basic|remote display/i.test(name))
            continue;
        adapters.push({ name, adapterRam: toNumber(item.AdapterRAM) });
    }
    const totals = new Map();
    for (const item of Array.isArray(data.totals) ? data.totals : []) {
        const name = String(item?.name || "").trim().toLowerCase();
        const bytes = toNumber(item?.bytes);
        if (name && bytes > 0)
            totals.set(name, bytes);
    }
    const memories = [];
    for (const item of Array.isArray(data.memory) ? data.memory : []) {
        const luid = parseLuid(item?.Name);
        if (!luid)
            continue;
        memories.push({ luid, dedicated: toNumber(item?.DedicatedUsage), shared: toNumber(item?.SharedUsage) });
    }
    memories.sort((a, b) => b.dedicated + b.shared - (a.dedicated + a.shared));
    // 计数器按「进程 + 引擎」拆分，先把同一引擎类型的占用求和，再取各类引擎的最大值。
    // 直接取单个样本会低估多进程共用同一引擎时的真实负载。
    const engineSums = new Map();
    for (const item of Array.isArray(data.engines) ? data.engines : []) {
        const luid = parseLuid(item?.Name);
        if (!luid)
            continue;
        const type = /engtype_([a-z0-9]+)/i.exec(String(item?.Name || ""))?.[1]?.toLowerCase() || "all";
        const key = `${luid}|${type}`;
        engineSums.set(key, (engineSums.get(key) || 0) + Math.max(0, toNumber(item?.UtilizationPercentage)));
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
            memoryUsedMb: Math.round(memory.dedicated / MIB),
            memoryTotalMb: 0,
            utilization: utilization.get(memory.luid) || 0,
        }));
    }
    return enriched.map((adapter, position) => {
        const memory = memories[position];
        return {
            index: adapter.index,
            name: adapter.name,
            memoryUsedMb: memory ? Math.round(memory.dedicated / MIB) : 0,
            memoryTotalMb: Math.round(adapter.totalBytes / MIB),
            utilization: memory ? utilization.get(memory.luid) || 0 : 0,
        };
    });
}
async function readNvidiaSmi() {
    let lastError = "";
    for (const bin of nvidiaSmiCandidates()) {
        try {
            const { stdout } = await execFileAsync(bin, [`--query-gpu=${GPU_FIELDS}`, "--format=csv,noheader,nounits"], {
                timeout: GPU_TIMEOUT_MS,
                windowsHide: true,
            });
            const gpu = String(stdout || "")
                .split(/\r?\n/)
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line, fallbackIndex) => {
                const [index, name, used, total, utilization, temperature] = line.split(",").map((part) => part.trim());
                return {
                    index: Number(index) || fallbackIndex,
                    name: name || "GPU",
                    memoryUsedMb: Number(used) || 0,
                    memoryTotalMb: Number(total) || 0,
                    utilization: Number(utilization) || 0,
                    temperature: Number(temperature) || 0,
                };
            });
            if (!gpu.length) {
                lastError = "nvidia-smi 没有返回显卡信息";
                continue;
            }
            return { gpu, gpuError: null };
        }
        catch (error) {
            lastError = error?.message || String(error);
        }
    }
    return { gpu: [], gpuError: lastError };
}
async function readWindowsGpu() {
    if (process.platform !== "win32")
        return { gpu: [], gpuError: "当前系统暂不支持自动读取显存" };
    let lastError = "";
    for (const bin of powershellCandidates()) {
        try {
            const { stdout } = await execFileAsync(bin, ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_GPU_SCRIPT], {
                timeout: GPU_TIMEOUT_MS,
                windowsHide: true,
                maxBuffer: 2 * MIB,
            });
            const gpu = gpuFromWindowsSnapshot(stdout);
            if (gpu.length)
                return { gpu, gpuError: null };
            lastError = "未能从 Windows GPU 计数器读取到显卡信息";
        }
        catch (error) {
            lastError = error?.message || String(error);
            if (error?.code !== "ENOENT")
                break;
        }
    }
    return { gpu: [], gpuError: lastError || "无法读取显存信息" };
}
async function readGpu() {
    const nvidia = await readNvidiaSmi();
    if (nvidia.gpu.length)
        return nvidia;
    const windows = await readWindowsGpu();
    if (windows.gpu.length)
        return windows;
    return { gpu: [], gpuError: windows.gpuError || nvidia.gpuError || "无法读取显存信息" };
}
// 显卡满载时 nvidia-smi 很容易超时；返回空列表会让界面变成「显存 --」。
// 有上次读数就沿用，并标记 gpuStale，让界面能区分“读取失败”和“真的没显卡”。
export function mergeGpuSnapshot(previous, next) {
    if (Array.isArray(next?.gpu) && next.gpu.length) {
        return { gpu: next.gpu, gpuError: null, gpuStale: false };
    }
    if (Array.isArray(previous) && previous.length) {
        return { gpu: previous, gpuError: next?.gpuError || "读取显存超时", gpuStale: true };
    }
    return { gpu: [], gpuError: next?.gpuError || "无法读取显存信息", gpuStale: false };
}
export async function readSystemStats({ cacheMs = 1500 } = {}) {
    const now = Date.now();
    if (cached && now - cachedAt < cacheMs)
        return cached;
    if (pending)
        return pending;
    pending = (async () => {
        try {
            const [gpuInfo, ram] = await Promise.all([readGpu(), Promise.resolve(readRam())]);
            const merged = mergeGpuSnapshot(lastGoodGpu, gpuInfo);
            if (!merged.gpuStale && merged.gpu.length)
                lastGoodGpu = merged.gpu;
            cached = { at: new Date().toISOString(), ...merged, ram };
            cachedAt = Date.now();
            return cached;
        }
        finally {
            pending = null;
        }
    })();
    return pending;
}
