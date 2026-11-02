import type { TaskSummary } from "../types";

const STATUS_LABEL: Record<string, string> = {
  queued: "排队中",
  running: "生成中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

export function TasksPanel({ tasks }: { tasks: TaskSummary[] }) {
  const list = tasks.slice(0, 6);
  return (
    <>
      <div className="intro">
        <h1>最近任务</h1>
        <p>这里只保留最近的生成记录，用于快速确认模型和任务状态。</p>
      </div>
      <section className="panel-card">
        <div className="panel-toolbar">
          <div className="panel-title">
            任务记录
            <span className="count">最近 {list.length} 条</span>
          </div>
        </div>
        {list.length === 0 ? (
          <div className="empty">暂无任务</div>
        ) : (
          <div className="tasks-list">
            {list.map((task) => {
              const ok = task.status === "completed";
              const bad = task.status === "failed" || task.status === "cancelled";
              return (
                <div className="task" key={task.id}>
                  <span className={`dot${ok ? " ok" : ""}`} style={bad ? { background: "var(--bad)" } : undefined} />
                  <span className="task-model">{task.model}</span>
                  <span className="task-status">{STATUS_LABEL[task.status] || task.status}</span>
                  <span className="task-id">{task.id}</span>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
