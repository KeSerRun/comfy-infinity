import { create } from "zustand";
import { persist } from "zustand/middleware";

import type { CardSkinId } from "@/lib/canvas-theme";

export type ThemeName = "light" | "dark";
export type FishWhipSide = "left" | "right";

type ThemeStore = {
    theme: ThemeName;
    cardSkin: CardSkinId;
    fishWhipEnabled: boolean;
    fishWhipSide: FishWhipSide;
    setTheme: (theme: ThemeName) => void;
    setCardSkin: (cardSkin: CardSkinId) => void;
    setFishWhipEnabled: (enabled: boolean) => void;
    setFishWhipSide: (side: FishWhipSide) => void;
};

export const useThemeStore = create<ThemeStore>()(
    persist(
        (set) => ({
            theme: "dark",
            cardSkin: "warm",
            fishWhipEnabled: true,
            fishWhipSide: "right",
            setTheme: (theme) => set({ theme }),
            setCardSkin: (cardSkin) => set({ cardSkin }),
            setFishWhipEnabled: (enabled) => set({ fishWhipEnabled: enabled }),
            setFishWhipSide: (side) => set({ fishWhipSide: side }),
        }),
        { name: "infinite-canvas:theme_store" },
    ),
);
