import test from "node:test";
import assert from "node:assert/strict";

import { gpuFromWindowsSnapshot } from "../dist/system/system-stats.js";

const luid = (low) => `luid_0x00000000_0x${low}_phys_0`;

test("windows snapshot: 读取 AMD 显存总量并过滤软件适配器", () => {
  const gpu = gpuFromWindowsSnapshot(
    JSON.stringify({
      adapters: [
        { Name: "Microsoft Basic Render Driver", AdapterRAM: 0 },
        { Name: "AMD Radeon RX 6700 XT", AdapterRAM: 4293918720 },
      ],
      totals: [{ name: "AMD Radeon RX 6700 XT", bytes: 12868124672 }],
      memory: [
        { Name: luid("000014FDC"), DedicatedUsage: 0, SharedUsage: 8192 },
        { Name: luid("000120FF"), DedicatedUsage: 901419008, SharedUsage: 128581632 },
      ],
      engines: [
        { Name: `pid_1_${luid("000120FF")}_eng_0_engtype_3D`, UtilizationPercentage: 14 },
        { Name: `pid_2_${luid("000120FF")}_eng_0_engtype_3D`, UtilizationPercentage: 5 },
        { Name: `pid_1_${luid("000120FF")}_eng_3_engtype_Compute`, UtilizationPercentage: 42 },
        { Name: `pid_9_${luid("000014FDC")}_eng_0_engtype_3D`, UtilizationPercentage: 3 },
      ],
    }),
  );

  assert.equal(gpu.length, 1);
  assert.equal(gpu[0].name, "AMD Radeon RX 6700 XT");
  assert.equal(gpu[0].memoryTotalMb, 12272);
  assert.equal(gpu[0].memoryUsedMb, 860);
  // 同一引擎类型按进程求和后取各类引擎的最大值：3D = 19，Compute = 42。
  assert.equal(gpu[0].utilization, 42);
});

test("windows snapshot: 注册表缺失时退回 AdapterRAM", () => {
  const gpu = gpuFromWindowsSnapshot(
    JSON.stringify({
      adapters: [{ Name: "AMD Radeon RX 580", AdapterRAM: 4293918720 }],
      totals: [],
      memory: [],
      engines: [],
    }),
  );

  assert.equal(gpu.length, 1);
  assert.equal(gpu[0].memoryTotalMb, 4095);
  assert.equal(gpu[0].memoryUsedMb, 0);
});

test("windows snapshot: 多显卡按显存总量与占用配对", () => {
  const gpu = gpuFromWindowsSnapshot(
    JSON.stringify({
      adapters: [
        { Name: "AMD Radeon(TM) Graphics", AdapterRAM: 536870912 },
        { Name: "AMD Radeon RX 6700 XT", AdapterRAM: 4293918720 },
      ],
      totals: [
        { name: "AMD Radeon(TM) Graphics", bytes: 536870912 },
        { name: "AMD Radeon RX 6700 XT", bytes: 12868124672 },
      ],
      memory: [
        { Name: luid("000011111"), DedicatedUsage: 104857600, SharedUsage: 0 },
        { Name: luid("000122222"), DedicatedUsage: 5368709120, SharedUsage: 0 },
      ],
      engines: [],
    }),
  );

  assert.deepEqual(
    gpu.map((item) => [item.name, item.memoryTotalMb, item.memoryUsedMb]),
    [
      ["AMD Radeon RX 6700 XT", 12272, 5120],
      ["AMD Radeon(TM) Graphics", 512, 100],
    ],
  );
});

test("windows snapshot: 没有适配器名时用 LUID 占位", () => {
  const gpu = gpuFromWindowsSnapshot(
    JSON.stringify({
      adapters: [],
      totals: [],
      memory: [{ Name: luid("000120FF"), DedicatedUsage: 104857600, SharedUsage: 0 }],
      engines: [],
    }),
  );

  assert.equal(gpu.length, 1);
  assert.equal(gpu[0].name, "GPU 1");
  assert.equal(gpu[0].memoryUsedMb, 100);
  assert.equal(gpu[0].memoryTotalMb, 0);
});
