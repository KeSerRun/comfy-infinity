import { App, Button, Form, Input, Modal, Radio, Select, Switch, Tabs } from "antd";
import { ArrowLeft, ArrowRight, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ModelPicker, WorkflowModelPicker } from "@/components/model-picker";
import { imageAspectOptions } from "@/components/image-settings-panel";
import { LOCAL_ONLY } from "@/constant/app-mode";
import { videoResolutionOptions } from "@/components/video-settings-panel";
import { ConfigLocalStorage } from "@/components/layout/config-local-storage";
import { audioFormatOptions, audioVoiceOptions, normalizeAudioSpeedValue } from "@/lib/audio-generation";
import { computeMediaSize, inferMediaRatio, inferMediaScale, mediaScaleOptions, parseVideoResolution } from "@/lib/media-size";
import { progressRingSkins } from "@/lib/canvas/progress-ring-skins";
import { cardSkinIds, getCanvasTheme, type CardSkinId } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { useConfigStore, type ConfigTabKey, type ModelCapability } from "@/stores/use-config-store";

type ModelGroup = {
    capability: ModelCapability;
    modelKey: "imageModel" | "videoModel" | "textModel" | "audioModel";
    labelKey: string;
};

const modelGroups: ModelGroup[] = [
    { capability: "image", modelKey: "imageModel", labelKey: "config.preferences.defaultImageModel" },
    { capability: "video", modelKey: "videoModel", labelKey: "config.preferences.defaultVideoModel" },
    { capability: "text", modelKey: "textModel", labelKey: "config.preferences.defaultTextModel" },
    { capability: "audio", modelKey: "audioModel", labelKey: "config.preferences.defaultAudioModel" },
];

export function AppConfigPanel({ showDoneButton = false, initialTab = "preferences" }: { showDoneButton?: boolean; initialTab?: ConfigTabKey }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [activeTab, setActiveTab] = useState<ConfigTabKey>(initialTab);
    const [fishOptionsOpen, setFishOptionsOpen] = useState(false);
    const config = useConfigStore((state) => state.config);
    const appTheme = useThemeStore((state) => state.theme);
    const cardSkin = useThemeStore((state) => state.cardSkin) || "warm";
    const setCardSkin = useThemeStore((state) => state.setCardSkin);
    const fishWhipEnabled = useThemeStore((state) => state.fishWhipEnabled);
    const setFishWhipEnabled = useThemeStore((state) => state.setFishWhipEnabled);
    const fishWhipSide = useThemeStore((state) => state.fishWhipSide);
    const setFishWhipSide = useThemeStore((state) => state.setFishWhipSide);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const shouldPromptContinue = useConfigStore((state) => state.shouldPromptContinue);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const clearPromptContinue = useConfigStore((state) => state.clearPromptContinue);
    const imageResolutionOptions = mediaScaleOptions.map((value) => ({ value, label: value === "auto" ? t("settingsPanels.common.auto") : value.toUpperCase() }));
    useEffect(() => setActiveTab(initialTab), [initialTab]);

    const selectCardSkin = (skinId: CardSkinId) => {
        if (skinId === "fish" || skinId === "angel") {
            setFishOptionsOpen(cardSkin === skinId ? !fishOptionsOpen : true);
        } else {
            setFishOptionsOpen(false);
        }
        setCardSkin(skinId);
    };

    useEffect(() => {
        if (cardSkin === "fish" || cardSkin === "angel") setFishOptionsOpen(true);
    }, [cardSkin]);

    const finishConfig = () => {
        const ready = config.channels.some((channel) => channel.baseUrl.trim() && channel.apiKey.trim() && channel.models.length);
        setConfigDialogOpen(false);
        if (!ready) return;
        message.success(t(shouldPromptContinue ? "config.savedContinue" : "config.saved"));
        clearPromptContinue();
    };

    return (
        <>
            <div className="border-b border-stone-200 pb-3 text-xs text-stone-500 dark:border-stone-800">配置只保存在本机浏览器。</div>
            <Tabs
                activeKey={activeTab}
                onChange={(key) => setActiveTab(key as ConfigTabKey)}
                items={[
                    {
                        key: "preferences",
                        label: t("config.tabs.preferences"),
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <div className="mb-2 text-sm font-semibold">{t("config.preferences.defaultModels")}</div>
                                <div className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                                    {modelGroups
                                        .filter((group) => !LOCAL_ONLY || group.capability === "image" || group.capability === "video")
                                        .map((group) => (
                                            <Form.Item key={group.modelKey} label={t(group.labelKey)} className="mb-0">
                                                {group.capability === "image" || group.capability === "video" ? (
                                                    <WorkflowModelPicker config={config} value={config[group.modelKey]} onChange={(model) => updateConfig(group.modelKey, model)} capability={group.capability} fullWidth />
                                                ) : (
                                                    <ModelPicker config={config} value={config[group.modelKey]} onChange={(model) => updateConfig(group.modelKey, model)} capability={group.capability} fullWidth />
                                                )}
                                            </Form.Item>
                                        ))}
                                </div>
                                <div className="mb-2 text-sm font-semibold">{t("config.preferences.generation")}</div>
                                <div className="grid gap-4 md:grid-cols-4">
                                    <Form.Item label={t("config.preferences.canvasImageCount")} extra={t("config.preferences.canvasImageCountDescription")} className="mb-4">
                                        <Input
                                            type="number"
                                            min={1}
                                            max={15}
                                            value={config.canvasImageCount}
                                            onChange={(event) => updateConfig("canvasImageCount", event.target.value)}
                                            onBlur={(event) => updateConfig("canvasImageCount", normalizeImageCount(event.target.value))}
                                        />
                                    </Form.Item>
                                    <Form.Item label={t("config.preferences.imageResolution")} className="mb-4">
                                        <Select value={inferMediaScale(config.size)} options={imageResolutionOptions} onChange={(scale) => updateConfig("size", computeMediaSize(scale, inferMediaRatio(config.size)))} />
                                    </Form.Item>
                                    <Form.Item label={t("config.preferences.imageAspectRatio")} className="mb-4">
                                        <Select value={inferMediaRatio(config.size)} options={imageAspectOptions} onChange={(ratio) => updateConfig("size", computeMediaSize(inferMediaScale(config.size), ratio))} />
                                    </Form.Item>
                                    <Form.Item label={t("config.preferences.videoResolution")} className="mb-4">
                                        <Select value={parseVideoResolution(config.vquality)} options={videoResolutionOptions} onChange={(value) => updateConfig("vquality", value)} />
                                    </Form.Item>
                                    {!LOCAL_ONLY ? (
                                        <>
                                            <Form.Item label={t("config.preferences.audioVoice")} className="mb-4">
                                                <Select value={config.audioVoice} options={audioVoiceOptions} onChange={(value) => updateConfig("audioVoice", value)} />
                                            </Form.Item>
                                            <Form.Item label={t("config.preferences.audioFormat")} className="mb-4">
                                                <Select value={config.audioFormat} options={audioFormatOptions} onChange={(value) => updateConfig("audioFormat", value)} />
                                            </Form.Item>
                                            <Form.Item label={t("config.preferences.audioSpeed")} className="mb-4">
                                                <Input
                                                    type="number"
                                                    min={0.25}
                                                    max={4}
                                                    step={0.05}
                                                    value={config.audioSpeed}
                                                    onChange={(event) => updateConfig("audioSpeed", event.target.value)}
                                                    onBlur={(event) => updateConfig("audioSpeed", normalizeAudioSpeedValue(event.target.value))}
                                                />
                                            </Form.Item>
                                        </>
                                    ) : null}
                                </div>
                                <Form.Item label={t("config.preferences.cardSkin")} extra={t("config.preferences.cardSkinDescription")} className="mb-4">
                                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                                        {cardSkinIds.map((id) => {
                                            const selected = cardSkin === id;
                                            const palette = getCanvasTheme(appTheme, id).node;
                                            return (
                                                <button
                                                    key={id}
                                                    type="button"
                                                    onClick={() => selectCardSkin(id)}
                                                    className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition ${selected ? "border-stone-900 bg-stone-100 dark:border-stone-100 dark:bg-white/10" : "border-stone-200 hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-white/5"}`}
                                                >
                                                    <span className="relative grid h-10 w-16 shrink-0 place-items-center overflow-hidden rounded-md border" style={{ background: palette.fill, borderColor: palette.stroke }}>
                                                        {id === "fish" ? (
                                                            <img src="/skins/lantern-guard-idle.png" alt="" draggable={false} className="size-10 object-contain" />
                                                        ) : id === "angel" ? (
                                                            <img src="/skins/angel-girl-idle.webp" alt="" draggable={false} className="size-10 object-contain" />
                                                        ) : (
                                                            <span className="space-y-1">
                                                                <span className="block h-1 w-8 rounded-full" style={{ background: palette.text, opacity: 0.85 }} />
                                                                <span className="block h-1 w-5 rounded-full" style={{ background: palette.muted, opacity: 0.65 }} />
                                                            </span>
                                                        )}
                                                    </span>
                                                    <span className="min-w-0">
                                                        <span className="flex items-center gap-1.5 text-sm font-medium">
                                                            <span className="truncate">{t(`config.preferences.cardSkins.${id}.label`)}</span>
                                                            {id === "fish" || id === "angel" ? (
                                                                <ChevronDown className={`ml-auto size-3.5 shrink-0 opacity-45 transition-transform ${selected && fishOptionsOpen ? "rotate-180" : ""}`} />
                                                            ) : null}
                                                        </span>
                                                        <span className="mt-0.5 block truncate text-[11px] opacity-60">{t(`config.preferences.cardSkins.${id}.description`)}</span>
                                                    </span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                    {(cardSkin === "fish" || cardSkin === "angel") && fishOptionsOpen ? (
                                        <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50/80 px-3 py-3 dark:border-stone-800 dark:bg-white/5">
                                            <div className="flex items-start justify-between gap-4">
                                                <div className="min-w-0">
                                                    <div className="text-sm font-medium">{t("config.preferences.fishWhip")}</div>
                                                    <div className="mt-1 text-[11px] leading-5 opacity-60">{t("config.preferences.fishWhipDescription")}</div>
                                                </div>
                                                <Switch checked={fishWhipEnabled} onChange={setFishWhipEnabled} />
                                            </div>
                                            <div className="mt-3 flex items-center justify-between gap-3 border-t border-stone-200/70 pt-3 dark:border-stone-800/70">
                                                <div className="text-xs opacity-60">{t("config.preferences.fishWhipSide")}</div>
                                                <Button
                                                    size="small"
                                                    icon={fishWhipSide === "right" ? <ArrowLeft className="size-3.5" /> : <ArrowRight className="size-3.5" />}
                                                    onClick={() => setFishWhipSide(fishWhipSide === "right" ? "left" : "right")}
                                                >
                                                    {fishWhipSide === "right" ? t("config.preferences.fishWhipMoveLeft") : t("config.preferences.fishWhipMoveRight")}
                                                </Button>
                                            </div>
                                        </div>
                                    ) : null}
                                </Form.Item>
                                <Form.Item label={t("config.preferences.progressRingSkin")} extra={t("config.preferences.progressRingSkinDescription")} className="mb-4">
                                    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                                        {progressRingSkins.map((skin) => {
                                            const selected = (config.progressRingSkin || "cyan") === skin.id;
                                            const palette = appTheme === "dark" ? skin.dark : skin.light;
                                            return (
                                                <button
                                                    key={skin.id}
                                                    type="button"
                                                    onClick={() => updateConfig("progressRingSkin", skin.id)}
                                                    className={`flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition ${selected ? "border-stone-900 bg-stone-100 dark:border-stone-100 dark:bg-white/10" : "border-stone-200 hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-white/5"}`}
                                                >
                                                    <span className="relative grid h-7 w-14 shrink-0 place-items-center overflow-hidden rounded-md" style={{ background: appTheme === "dark" ? "#1c1917" : "#f5f5f4" }}>
                                                        {skin.mode === "tide" ? (
                                                            <span
                                                                className="absolute inset-x-0 bottom-0 h-[62%]"
                                                                style={{ background: `linear-gradient(to top, ${palette.glow}66, ${palette.core}2e)`, borderTop: `1px solid ${palette.glow}`, boxShadow: `0 -3px 8px ${palette.glow}66` }}
                                                            />
                                                        ) : (
                                                            <span
                                                                className="absolute inset-x-1.5 top-1/2 h-[2px] -translate-y-1/2 rounded-full"
                                                                style={{ background: `linear-gradient(90deg, ${palette.gradient[0]}, ${palette.gradient[2]})`, boxShadow: `0 0 8px ${palette.glow}` }}
                                                            />
                                                        )}
                                                    </span>
                                                    <span className="min-w-0">
                                                        <span className="block text-sm font-medium">{t(`config.preferences.progressRingSkins.${skin.id}.label`)}</span>
                                                        <span className="mt-0.5 block truncate text-[11px] opacity-60">{t(`config.preferences.progressRingSkins.${skin.id}.description`)}</span>
                                                    </span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </Form.Item>
                                <Form.Item label={t("config.preferences.regenerateBehavior")} className="mb-4">
                                    <Radio.Group value={config.nodeRegenerateBehavior} onChange={(event) => updateConfig("nodeRegenerateBehavior", event.target.value)} className="flex flex-col gap-2">
                                        <Radio value="overwrite">
                                            <span className="block text-sm font-medium">{t("config.preferences.regenerateBehaviorOverwrite")}</span>
                                            <span className="mt-0.5 block text-xs opacity-60">{t("config.preferences.regenerateBehaviorOverwriteDescription")}</span>
                                        </Radio>
                                        <Radio value="new-node">
                                            <span className="block text-sm font-medium">{t("config.preferences.regenerateBehaviorNewNode")}</span>
                                            <span className="mt-0.5 block text-xs opacity-60">{t("config.preferences.regenerateBehaviorNewNodeDescription")}</span>
                                        </Radio>
                                    </Radio.Group>
                                </Form.Item>
                                <Form.Item className="mb-4">
                                    <div className="flex items-center justify-between gap-3">
                                        <span className="text-sm">{t("config.preferences.autoFocusOnSelect")}</span>
                                        <Switch checked={config.autoFocusOnSelect} onChange={(checked) => updateConfig("autoFocusOnSelect", checked)} />
                                    </div>
                                </Form.Item>
                                {!LOCAL_ONLY ? (
                                    <Form.Item label={t("config.preferences.audioInstructions")} className="mb-4">
                                        <Input.TextArea rows={2} value={config.audioInstructions} placeholder={t("config.preferences.audioInstructionsPlaceholder")} onChange={(event) => updateConfig("audioInstructions", event.target.value)} />
                                    </Form.Item>
                                ) : null}
                                <Form.Item label={t("config.preferences.systemPrompt")} className="mb-0">
                                    <Input.TextArea rows={4} value={config.systemPrompt} placeholder={t("config.preferences.systemPromptPlaceholder")} onChange={(event) => updateConfig("systemPrompt", event.target.value)} />
                                </Form.Item>
                            </Form>
                        ),
                    },
                    {
                        key: "local-storage",
                        label: t("config.tabs.localStorage"),
                        children: <ConfigLocalStorage active={activeTab === "local-storage"} />,
                    },
                ]}
            />
            {showDoneButton ? (
                <div className="mt-4 flex justify-end">
                    <Button type="primary" onClick={finishConfig}>
                        {t("common.done")}
                    </Button>
                </div>
            ) : null}
        </>
    );
}

export function AppConfigModal() {
    const { t } = useTranslation();
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const configTab = useConfigStore((state) => state.configTab);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    return (
        <Modal
            title={
                <div>
                    <div className="text-lg font-semibold">{t("config.title")}</div>
                    <div className="mt-1 text-xs font-normal text-stone-500">{t("config.modalDescription")}</div>
                </div>
            }
            open={isConfigOpen}
            width={980}
            centered
            onCancel={() => setConfigDialogOpen(false)}
            styles={{ body: { maxHeight: "72vh", overflowY: "auto", paddingRight: 12 } }}
            footer={null}
        >
            <AppConfigPanel showDoneButton initialTab={configTab} />
        </Modal>
    );
}

function normalizeImageCount(value: string) {
    return String(Math.max(1, Math.min(15, Math.floor(Math.abs(Number(value)) || 3))));
}

