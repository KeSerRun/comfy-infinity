import { useEffect, useState } from "react";

import { api } from "../api";
import type { DirectoryPayload } from "../api";
import type { DirectoryInfo, DirectorySettings } from "../types";

type Props = { onStatusChange: () => void };
type PickField = "workflows" | "model" | "lora" | "nodes";
type Busy = "" | "scan" | "save" | PickField;

export function DirectoriesPanel({ onStatusChange }: Props) {
  const [info, setInfo] = useState<DirectoryInfo | null>(null);
  const [comfyDir, setComfyDir] = useState("");
  const [workflowsDirs, setWorkflowsDirs] = useState("");
  const [modelDirs, setModelDirs] = useState("");
  const [loraDirs, setLoraDirs] = useState("");
  const [customNodesDirs, setCustomNodesDirs] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<Busy>("");
  const [loadError, setLoadError] = useState("");

  const applySettings = (settings: DirectorySettings) => {
    setComfyDir(settings.comfyDir || "");
    const dirs = settings.workflowsDirs?.length ? settings.workflowsDirs : settings.workflowsDir ? [settings.workflowsDir] : [];
    setWorkflowsDirs(dirs.join("\n"));
    setModelDirs((settings.modelDirs || []).join("\n"));
    setLoraDirs((settings.loraDirs || []).join("\n"));
    setCustomNodesDirs((settings.customNodesDirs || []).join("\n"));
  };

  useEffect(() => {
    let alive = true;
    api
      .directories()
      .then((data) => {
        if (!alive) return;
        setInfo(data);
        applySettings(data.settings);
        setLoadError("");
      })
      .catch((error: unknown) => {
        if (alive) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      alive = false;
    };
  }, []);

  const payload = (): DirectoryPayload => ({
    mode: "manual",
    comfyDir: comfyDir.trim(),
    workflowsDirs,
    modelDirs,
    loraDirs,
    customNodesDirs,
  });

  const scan = async () => {
    setBusy("scan");
    setNote("正在检测…");
    try {
      const data = await api.scanDirectories({ ...payload(), mode: "manual" });
      const totals = data.scan?.totals || {};
      setNote(`扫描结果：模型 ${totals.models || 0} · LoRA ${totals.loras || 0} · 插件 ${totals.plugins || 0} · 工作流 ${totals.workflows || 0}`);
    } catch (error) {
      setNote(`检测失败：${error instanceof Error ? error.message : error}`);
    } finally {
      setBusy("");
    }
  };

  const save = async () => {
    setBusy("save");
    setNote("正在保存…");
    try {
      const data = await api.saveDirectories(payload());
      applySettings(data.settings);
      setNote(data.note || (data.restartRequired ? "已保存；重启 ComfyUI 后生效。" : "已保存并扫描。"));
      onStatusChange();
    } catch (error) {
      setNote(`保存失败：${error instanceof Error ? error.message : error}`);
    } finally {
      setBusy("");
    }
  };

  const appendPath = (field: PickField, selected: string) => {
    const setter = field === "workflows" ? setWorkflowsDirs : field === "model" ? setModelDirs : field === "lora" ? setLoraDirs : setCustomNodesDirs;
    setter((current) => {
      const lines = current.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (!lines.includes(selected)) lines.push(selected);
      return lines.join("\n");
    });
  };

  const pick = async (field: PickField) => {
    setBusy(field);
    try {
      const workflowsInitial = workflowsDirs.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || "";
      const initial = field === "workflows" ? workflowsInitial : "";
      const data = await api.pickDirectory("选择目录", initial);
      if (!data.canceled && data.path) appendPath(field, data.path);
    } catch (error) {
      setNote(`选择目录失败：${error instanceof Error ? error.message : error}`);
    } finally {
      setBusy("");
    }
  };

  const browse = (field: PickField) => (
    <button className="copy browse-btn" type="button" disabled={Boolean(busy) && busy !== field} onClick={() => void pick(field)}>
      {busy === field ? "选择中…" : "浏览…"}
    </button>
  );

  const summary = loadError ? "读取目录设置失败" : info?.auto?.root ? `检测到：${info.auto.root}` : "未检测到 ComfyUI";

  return (
    <>
      <div className="intro">
        <h1>ComfyUI 目录</h1>
        <p>配置工作流、模型、LoRA 和插件目录，保存后会重新扫描工作流。</p>
      </div>

      <div className="status-strip">
        <span className={`dot${loadError ? "" : info?.auto?.root ? " ok" : " idle"}`} />
        <span>{summary}</span>
      </div>

      <section className="panel-card">
        <div className="panel-toolbar">
          <div className="panel-title">目录设置</div>
          <span className="count">手动配置</span>
        </div>

        <div className="settings-body">
          <div className="settings-group">
            <div className="settings-group-title">资源目录</div>
            <div className="settings-row">
              <div className="settings-label">
                <label htmlFor="dirs-workflows">工作流目录</label>
                <span>每行一个，可多个</span>
              </div>
              <div className="settings-control">
                <textarea
                  id="dirs-workflows"
                  rows={2}
                  placeholder={info?.auto?.workflowsDir ? `每行一个目录；自动识别：${info.auto.workflowsDir}` : "每行一个目录"}
                  value={workflowsDirs}
                  onChange={(event) => setWorkflowsDirs(event.target.value)}
                />
              </div>
              {browse("workflows")}
            </div>
            <div className="settings-row">
              <div className="settings-label">
                <label htmlFor="dirs-models">模型目录</label>
                <span>每行一个，可多个</span>
              </div>
              <div className="settings-control">
                <textarea id="dirs-models" rows={2} placeholder="每行一个目录" value={modelDirs} onChange={(event) => setModelDirs(event.target.value)} />
              </div>
              {browse("model")}
            </div>
            <div className="settings-row">
              <div className="settings-label">
                <label htmlFor="dirs-lora">LoRA 目录</label>
                <span>每行一个，可多个</span>
              </div>
              <div className="settings-control">
                <textarea id="dirs-lora" rows={2} placeholder="每行一个目录" value={loraDirs} onChange={(event) => setLoraDirs(event.target.value)} />
              </div>
              {browse("lora")}
            </div>
            <div className="settings-row">
              <div className="settings-label">
                <label htmlFor="dirs-nodes">插件目录</label>
                <span>自定义节点根目录</span>
              </div>
              <div className="settings-control">
                <textarea id="dirs-nodes" rows={2} placeholder="每行一个目录" value={customNodesDirs} onChange={(event) => setCustomNodesDirs(event.target.value)} />
              </div>
              {browse("nodes")}
            </div>
          </div>
        </div>

        <div className="panel-actions">
          <span className={`settings-note${/失败/.test(note) ? " bad" : ""}`}>{note}</span>
          <div className="settings-actions">
            <button className="text-btn" type="button" disabled={Boolean(busy)} onClick={() => void scan()}>
              {busy === "scan" ? "检测中…" : "检测目录"}
            </button>
            <button className="primary" type="button" disabled={Boolean(busy)} onClick={() => void save()}>
              {busy === "save" ? "保存中…" : "保存并扫描"}
            </button>
          </div>
        </div>
      </section>
    </>
  );
}
