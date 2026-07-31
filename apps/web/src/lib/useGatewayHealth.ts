import { useSyncExternalStore } from "react";

export type GatewayHealth = "probing" | "ok" | "down";

let gateway: GatewayHealth = "probing";
let timer: ReturnType<typeof setInterval> | undefined;
let inFlight: Promise<void> | undefined;
const listeners = new Set<() => void>();

const publish = (next: GatewayHealth): void => {
  if (next === gateway) return;
  gateway = next;
  listeners.forEach(listener => listener());
};

/** One request at a time, even if a slow probe overlaps the next scheduled tick. */
const probe = (): Promise<void> => {
  if (inFlight) return inFlight;
  if (typeof fetch === "undefined") {
    publish("down");
    return Promise.resolve();
  }
  inFlight = fetch("/healthz")
    .then(response => publish(response.ok ? "ok" : "down"))
    .catch(() => publish("down"))
    .finally(() => { inFlight = undefined; });
  return inFlight;
};

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  if (listeners.size === 1) {
    void probe();
    timer = setInterval(() => void probe(), 30_000);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
};

const getSnapshot = (): GatewayHealth => gateway;

/**
 * Poll /healthz once for every mounted consumer. Sidebar and start-card readers
 * subscribe to the same module-level snapshot and share a single request/timer.
 */
export function useGatewayHealth(): GatewayHealth {
  return useSyncExternalStore(subscribe, getSnapshot, () => "probing");
}
