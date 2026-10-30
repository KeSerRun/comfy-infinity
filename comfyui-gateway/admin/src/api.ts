import type {
  DirectoryInfo,
  DirectorySaveResult,
  DirectoryScan,
  Health,
  ResourceJob,
  SetupStatus,
  TaskSummary,
  WorkflowSummary,
} from "./types";

const JSON_HEADERS = { "content-type": "application/json" };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const data = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok || data.ok === false) {
    const detail = data.error;
    throw new Error((detail && detail.message) || (typeof detail === "string" ? detail : "") || `HTTP ${response.status}`);
  }
  return data as T;
}

export type DirectoryPayload = {
  mode: "auto" | "manual";
  comfyDir: string;
  workflowsDirs: string;
  modelDirs: string;
  loraDirs: string;
  customNodesDirs: string;
};

export const api = {
  health: () => request<Health>("/health"),

  setup: async () => (await request<{ status: SetupStatus }>("/api/setup/status")).status,

  workflows: async () => (await request<{ workflows: WorkflowSummary[] }>("/api/workflows")).workflows,

  openWorkflow: (file: string, source?: string) => {
    const params = new URLSearchParams({ file });
    if (source) params.set("source", source);
    return request<{ url: string; name?: string; bridge?: boolean; bridgeReason?: string }>(`/api/workflow-files/open?${params.toString()}`);
  },

  repairWorkflow: async (id: string) =>
    (await request<{ job: ResourceJob }>(`/api/workflows/${encodeURIComponent(id)}/repair`, { method: "POST" })).job,

  resourceJob: async (id: string) => (await request<{ job: ResourceJob }>(`/api/resources/jobs/${encodeURIComponent(id)}`)).job,

  cancelResourceJob: async (id: string) => (await request<{ job: ResourceJob }>(`/api/resources/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" })).job,

  tasks: async () => (await request<{ tasks: TaskSummary[] }>("/api/tasks")).tasks,

  directories: () => request<DirectoryInfo>("/api/setup/directories"),

  scanDirectories: (payload: DirectoryPayload & { mode: "manual" }) =>
    request<{ scan: DirectoryScan }>("/api/setup/directories/scan", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    }),

  saveDirectories: (payload: DirectoryPayload) =>
    request<DirectorySaveResult>("/api/setup/directories", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(payload),
    }),

  pickDirectory: (title: string, initial: string) =>
    request<{ canceled?: boolean; path?: string }>("/api/setup/pick-directory", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ title, initial }),
    }),
};
