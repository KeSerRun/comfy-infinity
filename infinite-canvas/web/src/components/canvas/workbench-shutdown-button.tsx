import { useState } from "react";
import { App, Button, Modal, Spin } from "antd";
import { Power } from "lucide-react";

import { LOCAL_GATEWAY_BASE_URL } from "@/constant/app-mode";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

const gatewayRoot = LOCAL_GATEWAY_BASE_URL.replace(/\/v1\/?$/, "");

type ShutdownResponse = {
    ok?: boolean;
    message?: string;
    error?: string | { message?: string };
};

function readError(data: ShutdownResponse, fallback: string) {
    if (typeof data.error === "string") return data.error;
    if (data.error?.message) return data.error.message;
    return data.message || fallback;
}

export function WorkbenchShutdownButton() {
    const { message } = App.useApp();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [open, setOpen] = useState(false);
    const [closing, setClosing] = useState(false);
    const [error, setError] = useState("");

    const closeWorkbench = async () => {
        setClosing(true);
        setError("");
        try {
            const response = await fetch(`${gatewayRoot}/api/system/shutdown`, { method: "POST" });
            const data = (await response.json().catch(() => ({}))) as ShutdownResponse;
            if (!response.ok || data.ok === false) throw new Error(readError(data, "关闭工作台失败"));
            setOpen(false);
            message.success("工作台正在关闭，可以直接关闭此页面");
        } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setClosing(false);
        }
    };

    return (
        <>
            <button
                type="button"
                className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
                style={{ color: theme.node.muted, background: "transparent" }}
                title="关闭工作台（网关、ComfyUI 与启动器）"
                onClick={() => setOpen(true)}
            >
                <Power className="size-3.5" />
                <span className="hidden xl:inline">关闭</span>
            </button>
            <Modal title="关闭工作台？" open={open} onCancel={() => !closing && setOpen(false)} footer={null} centered width={400} destroyOnHidden>
                <div className="space-y-3 pt-1 text-sm" style={{ color: theme.node.text }}>
                    <div className="text-xs leading-5" style={{ color: theme.node.muted }}>
                        会停止网关、本启动器启动的 ComfyUI，以及启动器本身；接管的 ComfyUI 按 stopAdoptedComfyOnCanvasClose 配置处理。正在运行或排队的生成任务会中断。
                    </div>
                    {error ? (
                        <div className="text-xs" style={{ color: "#b91c1c" }}>
                            {error}
                        </div>
                    ) : null}
                    <div className="flex justify-end gap-2">
                        <Button size="small" disabled={closing} onClick={() => setOpen(false)}>
                            取消
                        </Button>
                        <Button size="small" danger type="primary" loading={closing} onClick={() => void closeWorkbench()}>
                            确认关闭
                        </Button>
                    </div>
                    {closing ? (
                        <div className="flex items-center gap-2 text-[11px]" style={{ color: theme.node.muted }}>
                            <Spin size="small" />
                            <span>正在通知启动器退出…</span>
                        </div>
                    ) : null}
                </div>
            </Modal>
        </>
    );
}
