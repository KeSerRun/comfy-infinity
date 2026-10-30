import { LOCAL_GATEWAY_BASE_URL } from "@/constant/app-mode";
import { gatewayFetch } from "@/services/api/gateway-status";

const gatewayRoot = LOCAL_GATEWAY_BASE_URL.replace(/\/v1\/?$/, "");

export type PromptEngineCapability = {
    id: string;
    label: string;
    available: boolean;
    missingResources: Array<{ id: string; label: string }>;
    missingNodes: string[];
    reasons: string[];
};

export type PromptCapabilities = {
    packId: string;
    comfyReachable: boolean;
    engines: Record<string, PromptEngineCapability>;
};

export type ResourceStatus = {
    promptCapabilities?: PromptCapabilities;
};

async function readJson(response: Response) {
    return (await response.json().catch(() => ({}))) as Record<string, any>;
}

function errorMessage(data: Record<string, any>, fallback: string) {
    return String(data?.error?.message || data?.message || fallback);
}

export async function fetchResourceStatus(): Promise<ResourceStatus> {
    const response = await gatewayFetch(`${gatewayRoot}/api/resources/status`, { headers: { Accept: "application/json" } });
    const data = await readJson(response);
    if (!response.ok || data.ok === false) throw new Error(errorMessage(data, `读取资源状态失败（HTTP ${response.status}）`));
    return data as ResourceStatus;
}
