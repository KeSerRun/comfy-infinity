import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input, Table, Tag, Tooltip, type TableColumnsType } from "antd";

import { api } from "../api";
import type { ResourceJob, ResourceJobItem, SetupStatus, WorkflowSummary } from "../types";

const TYPE_LABEL: Record<string, string> = { image: "生图", video: "视频", audio: "音频", text: "文本", ui: "UI" };
const TYPE_COLOR: Record<string, string> = { image: "blue", video: "purple", audio: "gold", text: "green", ui: "orange" };
const PAGE_SIZE = 5;

type Props = {
  setup: SetupStatus | null;
  refreshToken: number;
  onChanged: () => void;
};

function workflowKey(item: WorkflowSummary) {
  return item.id || `${item.source || ""}:${item.file || item.name}`;
}

function normalizeSearch(value: unknown) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\-_./\\]+/g, "");
}

function formatBytes(value: unknown) {
  const bytes = Math.max(0, Number(value) || 0);
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = bytes / 1024;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`;
}

function itemPercent(item: ResourceJobItem) {
  if (item.status === "done") return 100;
  const size = Number(item.size) || 0;
  const bytes = Number(item.bytes) || 0;
  return size > 0 ? Math.max(0, Math.min(100, Math.round((bytes / size) * 100))) : 0;
}

const ACTIVE_ITEM_STATUSES = new Set(["downloading", "verifying", "extracting", "installing", "copying", "baking"]);

function fuzzyMatch(value: unknown, keyword: string) {
  const text = normalizeSearch(value);
  if (text.includes(keyword)) return true;
  let index = 0;
  for (const char of text) {
    if (char !== keyword[index]) continue;
    index += 1;
    if (index === keyword.length) return true;
  }
  return false;
}

export function WorkflowsPanel({ setup, refreshToken, onChanged }: Props) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [repairing, setRepairing] = useState("");
  const [repairJob, setRepairJob] = useState<ResourceJob | null>(null);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadError, setLoadError] = useState("");

  const loadWorkflows = useCallback(async () => {
    setLoading(true);
    try {
      setWorkflows(await api.workflows());
      setLoadError("");
    } catch (error) {
      setWorkflows([]);
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkflows();
  }, [loadWorkflows, refreshToken]);

  // 在 ComfyUI 标签页保存工作流后，切回管理页时重新读取状态。
  useEffect(() => {
    let timer = 0;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void (async () => {
          try {
            setWorkflows(await api.workflows());
            setLoadError("");
            onChanged();
          } catch {
            /* 后台刷新失败时保留当前列表 */
          }
        })();
      }, 250);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [onChanged]);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const job = await api.activeResourceJob();
        if (!alive || !job || job.status !== "running") return;
        setRepairJob(job);
      } catch {
        /* 恢复进度失败时仍可手动刷新工作流 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const filteredWorkflows = useMemo(() => {
    const keyword = normalizeSearch(query);
    if (!keyword) return workflows;
    return workflows.filter((item) => {
      const fields = [item.name, item.id, item.file, item.source, item.type, TYPE_LABEL[item.type]];
      return fields.some((field) => fuzzyMatch(field, keyword));
    });
  }, [workflows, query]);

  const totalPages = Math.max(1, Math.ceil(filteredWorkflows.length / PAGE_SIZE));

  useEffect(() => {
    setPage(1);
  }, [query]);

  useEffect(() => {
    setPage((current) => Math.min(Math.max(1, current), totalPages));
  }, [totalPages]);

  const repairJobRunning = repairJob?.status === "running";
  const repairItems = repairJob?.items || [];
  const activeRepairItems = repairItems.filter((item) => ACTIVE_ITEM_STATUSES.has(item.status));
  const failedRepairItems = repairItems.filter((item) => item.status === "error");

  const setupText = useMemo(() => {
    if (!setup) return "正在检查 ComfyUI…";
    const parts = [setup.comfyReachable ? "ComfyUI 已连接" : "ComfyUI 未连接"];
    if (setup.phase === "scanning") parts.push("后台扫描中…");
    else if (setup.phase === "ready") parts.push(`工作流 ${setup.counts?.available || 0}/${setup.counts?.total || 0} 可用`);
    else if (setup.phase === "degraded") parts.push("扫描降级");
    if (setup.missing?.uiWorkflows) parts.push(`${setup.missing.uiWorkflows} 个 UI 工作流`);
    if (setup.missing?.models?.length) parts.push(`缺模型 ${setup.missing.models.length}`);
    if (setup.missing?.nodes?.length) parts.push(`缺节点 ${setup.missing.nodes.length}`);
    return parts.join(" · ");
  }, [setup]);

  const refresh = async () => {
    setRefreshing(true);
    setNotice("");
    try {
      await loadWorkflows();
      onChanged();
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    if (!repairJob || repairJob.status !== "running") return;
    let alive = true;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const job = await api.resourceJob(repairJob.id);
          if (!alive) return;
          setRepairJob(job);
          if (job.status !== "running") {
            setRepairing("");
            await loadWorkflows();
            onChanged();
          }
        } catch (error) {
          if (!alive) return;
          setRepairing("");
          setRepairJob(null);
          setNotice(`读取安装进度失败：${error instanceof Error ? error.message : error}`);
        }
      })();
    }, 1200);
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [repairJob, loadWorkflows, onChanged]);

  const openInComfy = async (item: WorkflowSummary) => {
    if (!item.file) {
      setNotice("缺少工作流文件路径，无法打开");
      return;
    }
    const key = workflowKey(item);
    setRepairing(key);
    setNotice("");
    try {
      const target = await api.openWorkflow(item.file, item.origin === "path" ? item.source : undefined);
      const link = document.createElement("a");
      link.href = target.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      document.body.appendChild(link);
      link.click();
      link.remove();
      if (!target.bridge) setNotice(`已在 ComfyUI 打开，但工作流桥接未安装：${target.bridgeReason || "未知原因"}`);
    } catch (error) {
      setNotice(`打开失败：${error instanceof Error ? error.message : error}`);
    } finally {
      setRepairing("");
    }
  };

  const repairWithResources = async (item: WorkflowSummary) => {
    if (!item.id) {
      setNotice("该工作流没有依赖清单，无法自动修复");
      return;
    }
    const key = workflowKey(item);
    setRepairing(key);
    setNotice("");
    setRepairJob(null);
    try {
      const job = await api.repairWorkflow(item.id);
      setRepairJob(job);
      if (job.status !== "running") {
        setRepairing("");
        await loadWorkflows();
        onChanged();
      }
    } catch (error) {
      setRepairing("");
      setNotice(`启动资源修复失败：${error instanceof Error ? error.message : error}`);
    }
  };

  const cancelRepair = async () => {
    if (!repairJob) return;
    try {
      setRepairJob(await api.cancelResourceJob(repairJob.id));
      setRepairing("");
    } catch (error) {
      setNotice(`取消修复失败：${error instanceof Error ? error.message : error}`);
    }
  };

  const columns: TableColumnsType<WorkflowSummary> = [
    {
      title: "工作流",
      key: "name",
      width: "34%",
      render: (_, item) => (
        <div className="workflow-name">
          <strong>{item.name}</strong>
          <Tooltip title={item.origin === "path" ? item.source || "自动发现目录" : "comfyui-gateway/workflows"}>
            {item.origin === "path" ? <Tag color="blue">自动发现</Tag> : <Tag>内置</Tag>}
          </Tooltip>
        </div>
      ),
    },
    {
      title: "类型",
      dataIndex: "type",
      width: "10%",
      render: (value: string) => <Tag color={TYPE_COLOR[value] || "default"}>{TYPE_LABEL[value] || value}</Tag>,
    },
    {
      title: "文件",
      key: "file",
      width: "26%",
      render: (_, item) => (
        <Tooltip title={item.origin === "path" && item.source ? `${item.source}\\${item.file}` : item.file}>
          <span className="workflow-file">{item.file || "—"}</span>
        </Tooltip>
      ),
    },
    {
      title: "参数",
      key: "bindings",
      width: "8%",
      render: (_, item) => (item.format === "ui" ? "—" : Object.keys(item.bindings || {}).length),
    },
    {
      title: "状态",
      key: "status",
      width: "10%",
      render: (_, item) => {
        const key = workflowKey(item);
        const unsupported = item.availability?.problems?.filter((problem) => problem.type === "unsupported") || [];
        const unavailable = item.availability?.available === false;
        const canResourceRepair = unavailable && item.repair === "resources" && Boolean(item.id) && !unsupported.length;
        const problemText = (item.availability?.problems || []).map((problem) => problem.message).filter(Boolean).join("；");
        if (unsupported.length) {
          return (
            <Tooltip title={unsupported.map((problem) => problem.message).filter(Boolean).join("；")}>
              <Tag color="orange">硬件不支持</Tag>
            </Tooltip>
          );
        }
        if (canResourceRepair) {
          return (
            <Tooltip title={problemText || "下载该工作流缺失的模型、LoRA、节点和运行库"}>
              <Button
                danger
                className="repair-btn"
                size="small"
                loading={repairing === key}
                disabled={repairJobRunning || (Boolean(repairing) && repairing !== key)}
                onClick={() => void repairWithResources(item)}
              >
                修复
              </Button>
            </Tooltip>
          );
        }
        if (unavailable) {
          return (
            <Tooltip title={problemText || "工作流不可用"}>
              <Tag color="red">不可用</Tag>
            </Tooltip>
          );
        }
        if (item.availability?.baseModelFallback) {
          return (
            <Tooltip title="默认底模未安装，但可用其他匹配的底模变体运行；请在画布中切换底模">
              <Tag color="gold">可用·切底模</Tag>
            </Tooltip>
          );
        }
        return item.format === "ui" ? <Tag>可编辑</Tag> : <Tag color="green">可用</Tag>;
      },
    },
    {
      title: "操作",
      key: "actions",
      width: "12%",
      render: (_, item) => {
        const key = workflowKey(item);
        const loading = repairing === key;
        const disabled = Boolean(repairing) && !loading || !item.file;
        return (
          <div className="workflow-actions">
            <Tooltip title={item.file ? "在 ComfyUI 中打开该工作流" : "缺少工作流文件路径，无法打开"}>
              <Button
                className="repair-btn"
                size="small"
                loading={loading}
                disabled={disabled}
                onClick={() => void openInComfy(item)}
              >
                打开
              </Button>
            </Tooltip>
          </div>
        );
      },
    },
  ];

  const emptyText = loadError
    ? `加载失败：${loadError}`
    : workflows.length === 0
      ? "系统内置目录和选择的工作流目录中都没有找到工作流。"
      : "没有找到匹配的工作流。";

  return (
    <>
      <div className="intro">
        <h1>工作流</h1>
        <p>系统内置目录和已选择的工作流目录中的文件会自动显示在这里。</p>
      </div>

      <div className="status-strip">
        <span className={`dot${setup ? (setup.comfyReachable ? " ok" : "") : " idle"}`} />
        <span>{setupText}</span>
      </div>

      <section className="panel-card">
        <div className="panel-toolbar">
          <div className="panel-title">
            全部工作流
            <span className="count">{query.trim() ? `${filteredWorkflows.length} / ${workflows.length}` : `共 ${workflows.length} 个`}</span>
          </div>
          <div className="section-tools">
            <Input
              className="workflow-search"
              allowClear
              placeholder="搜索工作流，支持模糊匹配"
              aria-label="搜索工作流"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <Button type="text" size="small" loading={refreshing} onClick={() => void refresh()}>
              刷新
            </Button>
          </div>
        </div>
        {repairJob ? (
          <div className={`repair-status${repairJob.status === "error" ? " bad" : ""}`}>
            <div className="repair-main">
              <div className="repair-line">
                <span>
                  {repairJob.error || repairJob.message || repairJob.status}
                  {repairJob.total ? ` · ${repairJob.completed || 0}/${repairJob.total}` : ""}
                  {repairJob.status === "done" && !String(repairJob.message || "").includes("跳过") ? " · 如仍不可用，请重启 ComfyUI" : ""}
                </span>
                <span className="repair-percent">
                  {repairJob.status === "done" ? "100%" : `总进度 ${Math.max(0, Math.min(100, Number(repairJob.progress) || 0))}%`}
                </span>
              </div>
              <div className="repair-bar">
                <i style={{ width: `${repairJob.status === "done" ? 100 : Math.max(0, Math.min(100, Number(repairJob.progress) || 0))}%` }} />
              </div>
              {repairJobRunning && activeRepairItems.length ? (
                <div className="repair-current">
                  {activeRepairItems.slice(0, 2).map((item) => (
                    <span key={item.id}>
                      {item.label || item.id}：{itemPercent(item)}%
                      {Number(item.size) > 0 ? ` · ${formatBytes(item.bytes)} / ${formatBytes(item.size)}` : ""}
                    </span>
                  ))}
                  {activeRepairItems.length > 2 ? <span>等 {activeRepairItems.length} 个文件</span> : null}
                </div>
              ) : null}
              {!repairJobRunning && failedRepairItems.length ? (
                <div className="repair-current bad">
                  {failedRepairItems.slice(0, 2).map((item) => (
                    <span key={item.id}>
                      {item.label || item.id}：{item.error || "安装失败"}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            {repairJob.status === "running" ? (
              <button className="text-btn" type="button" onClick={() => void cancelRepair()}>
                取消
              </button>
            ) : (
              <button className="text-btn" type="button" onClick={() => setRepairJob(null)}>
                关闭
              </button>
            )}
          </div>
        ) : null}
        {notice ? <div className="message bad">{notice}</div> : null}
        <Table<WorkflowSummary>
          className="workflow-table"
          rowKey={workflowKey}
          columns={columns}
          dataSource={filteredWorkflows}
          loading={loading}
          size="small"
          tableLayout="fixed"
          locale={{ emptyText }}
          pagination={
            filteredWorkflows.length > PAGE_SIZE
              ? {
                  current: page,
                  pageSize: PAGE_SIZE,
                  total: filteredWorkflows.length,
                  showSizeChanger: false,
                  showLessItems: true,
                  onChange: setPage,
                  showTotal: (total, range) => `第 ${range[0]}–${range[1]} 条 / 共 ${total} 条`,
                }
              : false
          }
        />
      </section>
    </>
  );
}
