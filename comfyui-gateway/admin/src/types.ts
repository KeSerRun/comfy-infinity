export type TabKey = "directories" | "workflows" | "tasks";

export type Health = {
  status?: string;
  consoleUrl?: string;
  comfy?: { reachable?: boolean };
};

export type SetupStatus = {
  phase?: string;
  comfyReachable?: boolean;
  counts?: { total?: number; available?: number; unavailable?: number };
  missing?: { models?: string[]; nodes?: string[]; runtime?: string[]; uiWorkflows?: number };
};

export type WorkflowSummary = {
  id?: string;
  name: string;
  type: string;
  file?: string;
  source?: string;
  origin?: "builtin" | "path";
  format?: "api" | "ui";
  repair?: "resources" | "comfyui";
  bindings?: Record<string, unknown>;
  variantModes?: string[];
  availability?: { available?: boolean; baseModelFallback?: boolean; problems?: Array<{ type?: string; message?: string }> };
};

export type ResourceJobItem = {
  id: string;
  label?: string;
  status: string;
  bytes?: number;
  size?: number;
  source?: string | null;
  error?: string;
};

export type ResourceJob = {
  id: string;
  status: string;
  message?: string;
  createdAt?: string;
  updatedAt?: string;
  items?: ResourceJobItem[];
  completed?: number;
  total?: number;
  progress?: number;
  error?: string;
};

export type TaskSummary = {
  id: string;
  model: string;
  status: string;
};

export type DirectorySettings = {
  mode: "auto" | "manual";
  comfyDir: string;
  workflowsDirs: string[];
  workflowsDir?: string;
  modelDirs: string[];
  loraDirs: string[];
  customNodesDirs: string[];
};

export type DirectoryScan = {
  totals?: { models?: number; loras?: number; plugins?: number; workflows?: number };
};

export type DirectoryInfo = {
  settings: DirectorySettings;
  auto?: { root?: string; comfyDir?: string; workflowsDir?: string };
  setup?: { phase?: string; counts?: { available?: number; total?: number } };
  loadReport?: { restartRequired?: boolean };
};

export type DirectorySaveResult = {
  settings: DirectorySettings;
  scan?: DirectoryScan;
  restartRequired?: boolean;
  note?: string;
};
