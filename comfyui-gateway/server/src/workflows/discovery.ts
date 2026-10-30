import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";

import { inferBindings, inferType, isApiWorkflow, isUiWorkflow } from "./registry.js";

export type DiscoveredWorkflow = {
  id: string;
  name: string;
  type: string;
  file: string;
  source: string;
  origin: "path";
  format: "api" | "ui";
  bindings: Record<string, any>;
  variantModes: string[];
  label: string;
};

type RootSpec = {
  dir: string;
  recursive?: boolean;
  label?: string;
};

function workflowId(file: string) {
  return `discovered-${crypto.createHash("sha1").update(file.toLowerCase()).digest("hex").slice(0, 12)}`;
}

export async function discoverWorkflowFiles(
  roots: RootSpec[],
  { maxBytes = 5 * 1024 * 1024, maxDepth = 6, limit = 1000, exclude = new Set<string>() }: any = {},
): Promise<DiscoveredWorkflow[]> {
  const results: DiscoveredWorkflow[] = [];
  const seen = new Set<string>(exclude);

  async function walk(dir: string, root: string, depth: number, recursive: boolean) {
    if (results.length >= limit) return;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= limit) return;
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (recursive && depth < maxDepth) await walk(full, root, depth + 1, recursive);
        continue;
      }
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) continue;
      if (entry.name.toLowerCase() === "registry.json") continue;
      const key = path.resolve(full).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      let stat;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }
      if (stat.size > maxBytes) continue;
      let workflow;
      try {
        workflow = JSON.parse((await fsp.readFile(full, "utf8")).replace(/^\uFEFF/, ""));
      } catch {
        continue;
      }
      const format = isApiWorkflow(workflow) ? "api" : isUiWorkflow(workflow) ? "ui" : "";
      if (!format) continue;
      const baseName = path.basename(entry.name, ".json");
      const type = format === "api" ? inferType(workflow, "") : "ui";
      results.push({
        id: workflowId(full),
        name: baseName,
        label: baseName,
        type,
        file: path.relative(root, full).split(path.sep).join("/"),
        source: root,
        origin: "path",
        format,
        bindings: format === "api" ? inferBindings(workflow) : {},
        variantModes: [],
      });
    }
  }

  for (const spec of roots) {
    if (!spec?.dir) continue;
    const root = path.resolve(spec.dir);
    try {
      if (!(await fsp.stat(root)).isDirectory()) continue;
    } catch {
      continue;
    }
    await walk(root, root, 0, spec.recursive !== false);
  }
  return results;
}
