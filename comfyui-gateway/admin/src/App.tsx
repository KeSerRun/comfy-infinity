import { useCallback, useEffect, useState } from "react";
import { ConfigProvider, theme as antdTheme } from "antd";

import { api } from "./api";
import { DirectoriesPanel } from "./components/DirectoriesPanel";
import { TasksPanel } from "./components/TasksPanel";
import { WorkflowsPanel } from "./components/WorkflowsPanel";
import type { Health, SetupStatus, TabKey, TaskSummary } from "./types";

const TAB_NAMES: TabKey[] = ["directories", "workflows", "tasks"];
const TAB_LABELS: Record<TabKey, string> = {
  directories: "ComfyUI 目录",
  workflows: "工作流",
  tasks: "最近任务",
};
const TAB_KEY = "comfy-infinity-gateway-tab-v2";
const THEME_KEY = "comfy-infinity-gateway-theme";
const FONT_SANS = '"Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", system-ui, sans-serif';

function isTab(value: string | null | undefined): value is TabKey {
  return Boolean(value) && (TAB_NAMES as string[]).includes(value as string);
}

function initialTab(): TabKey {
  const hash = window.location.hash.replace(/^#/, "");
  if (isTab(hash)) return hash;
  try {
    const saved = localStorage.getItem(TAB_KEY);
    if (isTab(saved)) return saved;
  } catch {
    /* 忽略存储失败 */
  }
  return "directories";
}

function initialTheme(): "light" | "dark" {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") return saved;
  } catch {
    /* 忽略存储失败 */
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export default function App() {
  const [theme, setTheme] = useState<"light" | "dark">(initialTheme);
  const [tab, setTab] = useState<TabKey>(initialTab);
  const [health, setHealth] = useState<Health | null>(null);
  const [setup, setSetup] = useState<SetupStatus | null>(null);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [workflowRefresh, setWorkflowRefresh] = useState(0);

  const loadHealth = useCallback(async () => {
    try {
      setHealth(await api.health());
    } catch {
      setHealth(null);
    }
  }, []);

  const loadSetup = useCallback(async () => {
    try {
      setSetup(await api.setup());
    } catch {
      setSetup(null);
    }
  }, []);

  const loadTasks = useCallback(async () => {
    try {
      setTasks(await api.tasks());
    } catch {
      setTasks([]);
    }
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    try {
      localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* 存储不可用时只在本页生效 */
    }
  }, [theme]);

  useEffect(() => {
    const onTheme = (event: Event) => {
      const next = (event as CustomEvent<string>).detail;
      if (next === "light" || next === "dark") setTheme(next);
    };
    window.addEventListener("comfy-theme", onTheme);
    return () => window.removeEventListener("comfy-theme", onTheme);
  }, []);

  useEffect(() => {
    void loadHealth();
    const timer = window.setInterval(() => void loadHealth(), 15000);
    return () => window.clearInterval(timer);
  }, [loadHealth]);

  useEffect(() => {
    void loadSetup();
    void loadTasks();
  }, [loadSetup, loadTasks]);

  useEffect(() => {
    if (setup?.phase !== "scanning") return;
    const timer = window.setTimeout(() => void loadSetup(), 1500);
    return () => window.clearTimeout(timer);
  }, [setup?.phase, loadSetup]);

  useEffect(() => {
    if (setup?.phase === "ready") setWorkflowRefresh((value) => value + 1);
  }, [setup?.phase]);

  const selectTab = useCallback((next: TabKey) => {
    setTab(next);
    try {
      localStorage.setItem(TAB_KEY, next);
    } catch {
      /* 忽略存储失败 */
    }
    try {
      window.history.replaceState(null, "", `#${next}`);
    } catch {
      /* 忽略历史记录失败 */
    }
  }, []);

  useEffect(() => {
    const onHashChange = () => {
      const next = window.location.hash.replace(/^#/, "");
      if (isTab(next)) setTab(next);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const tasksVisible = tasks.length > 0;
  useEffect(() => {
    if (!tasksVisible && tab === "tasks") selectTab("directories");
  }, [tasksVisible, tab, selectTab]);

  const connected = Boolean(health?.comfy?.reachable);

  return (
    <ConfigProvider
      theme={{
        algorithm: theme === "dark" ? antdTheme.darkAlgorithm : antdTheme.defaultAlgorithm,
        token: { fontFamily: FONT_SANS },
      }}
      button={{ autoInsertSpace: false }}
    >
      <>
        <header className="top">
          <div aria-hidden="true" />
          <nav className="tabs" role="tablist" aria-label="管理页面">
            {TAB_NAMES.map((name) => (
              <button
                key={name}
                type="button"
                role="tab"
                className={`tab${tab === name ? " active" : ""}`}
                aria-selected={tab === name}
                hidden={name === "tasks" && !tasksVisible}
                onClick={() => selectTab(name)}
              >
                {TAB_LABELS[name]}
              </button>
            ))}
          </nav>
          <div className="top-right">
            <span className="status">
              <span id="health-dot" className={`dot${connected ? " ok" : ""}`} />
              <span>{health ? (connected ? "已连接" : "未连接") : "离线"}</span>
            </span>
          </div>
        </header>

        <main>
        {tab === "directories" ? (
          <div className="tab-panel">
            <DirectoriesPanel onStatusChange={loadSetup} />
          </div>
        ) : null}
        {tab === "workflows" ? (
          <div className="tab-panel">
            <WorkflowsPanel setup={setup} refreshToken={workflowRefresh} onChanged={loadSetup} />
          </div>
        ) : null}
        {tab === "tasks" ? (
          <div className="tab-panel">
            <TasksPanel tasks={tasks} />
          </div>
        ) : null}
        </main>
      </>
    </ConfigProvider>
  );
}
