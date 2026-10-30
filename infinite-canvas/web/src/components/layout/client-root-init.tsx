import type { ReactNode } from "react";

import { useLocalGatewaySync } from "@/hooks/use-local-gateway-sync";

export function ClientRootInit({ children }: { children: ReactNode }) {
    useLocalGatewaySync();
    return <>{children}</>;
}
