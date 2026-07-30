import { useEffect, useState } from "react";

export type GatewayHealth = "probing" | "ok" | "down";

/** Poll /healthz so idle surfaces (sidebar dot, start card) report real reachability. */
export function useGatewayHealth(): GatewayHealth {
  const [gateway, setGateway] = useState<GatewayHealth>("probing");

  useEffect(() => {
    let cancelled = false;
    const probe = () =>
      fetch("/healthz")
        .then(response => { if (!cancelled) setGateway(response.ok ? "ok" : "down"); })
        .catch(() => { if (!cancelled) setGateway("down"); });
    void probe();
    const timer = setInterval(() => void probe(), 30_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  return gateway;
}
