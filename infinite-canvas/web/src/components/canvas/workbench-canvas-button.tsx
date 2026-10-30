import { Images } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";

import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export function WorkbenchCanvasButton() {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <Link
            to="/canvas"
            className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-[11px] transition-colors hover:bg-black/5 dark:hover:bg-white/10"
            style={{ color: theme.node.muted, background: "transparent" }}
            title={t("canvas.backToCanvasHint")}
        >
            <Images className="size-3.5" />
            <span className="hidden text-[11px] font-normal leading-none xl:inline">{t("canvas.backToCanvas")}</span>
        </Link>
    );
}
