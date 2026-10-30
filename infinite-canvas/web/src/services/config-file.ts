import { saveAs } from "file-saver";

import i18n from "@/i18n";
import { normalizePromptCloudConfig, useConfigStore, type AiConfig } from "@/stores/use-config-store";

type AppConfigFile = {
    app: "comfy-infinity" | "infinite-canvas";
    version: 1;
    exportedAt: string;
    secretsStripped?: boolean;
    config: AiConfig;
};

const SECRET_KEY = /^(apiKey|password|token|secret|accessKey|secretKey|authorization)$|(apiKey|accessKey|secretKey|api_key|access_key|secret_key)$/i;

function redactSecrets<T>(value: T): T {
    if (Array.isArray(value)) return value.map((item) => redactSecrets(item)) as T;
    if (!value || typeof value !== "object") return value;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        result[key] = SECRET_KEY.test(key) ? "" : redactSecrets(item);
    }
    return result as T;
}

export function exportAppConfig() {
    const { config } = useConfigStore.getState();
    const data: AppConfigFile = redactSecrets({ app: "comfy-infinity", version: 1, exportedAt: new Date().toISOString(), secretsStripped: true, config });
    saveAs(new Blob([JSON.stringify(data, null, 2)], { type: "application/json;charset=utf-8" }), "comfy-infinity-config.json");
}

export async function importAppConfig(file: File) {
    let data: AppConfigFile;
    try {
        data = JSON.parse(await file.text()) as AppConfigFile;
    } catch {
        throw new Error(i18n.t("config.invalidFile"));
    }
    if (!["comfy-infinity", "infinite-canvas"].includes(data.app) || data.version !== 1 || !data.config) throw new Error(i18n.t("config.invalidFile"));
    const current = useConfigStore.getState();
    let nextConfig = normalizePromptCloudConfig(data.config);
    if (data.secretsStripped) {
        nextConfig.channels = nextConfig.channels.map((channel) => {
            if (channel.apiKey) return channel;
            const existing = current.config.channels.find((item) => item.id === channel.id) || current.config.channels.find((item) => item.baseUrl === channel.baseUrl);
            return existing?.apiKey ? { ...channel, apiKey: existing.apiKey } : channel;
        });
        if (!nextConfig.apiKey && current.config.apiKey) nextConfig.apiKey = current.config.apiKey;
    }
    useConfigStore.setState({ config: nextConfig });
}
