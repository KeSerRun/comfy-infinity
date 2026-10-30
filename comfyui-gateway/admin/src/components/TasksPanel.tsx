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
    <section className="section">
      <div className="section-head">
        <h2>最近任务</h2>
      </div>
      {list.length === 0 ? (
        <div className="empty">暂无任务</div>
      ) : (
        <div>
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
  );
}
