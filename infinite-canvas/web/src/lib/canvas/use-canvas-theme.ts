import { getCanvasTheme, type CardSkinId } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export function useEffectiveCardSkin(): CardSkinId {
    return useThemeStore((state) => state.cardSkin);
}

export function useCanvasTheme() {
    const theme = useThemeStore((state) => state.theme);
    const cardSkin = useEffectiveCardSkin();
    return getCanvasTheme(theme, cardSkin);
}
