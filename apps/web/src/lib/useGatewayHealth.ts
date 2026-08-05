import { useSyncExternalStore } from "react";

export type GatewayHealth = "probing" | "ok" | "down";

let gateway: GatewayHealth = "probing";
let livekit = false;
let liveKitClient: typeof import("./livekit-client").BrowserLiveKitClient | undefined;
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
    .then(async response => {
      if (!response.ok) {
        livekit = false;
        publish("down");
        return;
      }
      const body = await response.json().catch(() => null) as { deployment?: { livekit?: unknown } } | null;
      livekit = body?.deployment?.livekit === true;
      if (livekit && liveKitClient === undefined) {
        // Keep the substantial WebRTC SDK out of the default Studio bundle. Loading it
        // as soon as capability discovery completes makes the constructor available
        // before the user's later click, preserving iOS transient activation.
        void import("./livekit-client")
          .then(module => { if (livekit) liveKitClient = module.BrowserLiveKitClient; })
          .catch(() => { liveKitClient = undefined; });
      } else if (!livekit) {
        liveKitClient = undefined;
      }
      publish("ok");
    })
    .catch(() => {
      livekit = false;
      publish("down");
    })
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

/** Synchronous by design: transport choice happens inside the user's start gesture. */
export function gatewaySupportsLiveKit(): boolean {
  return gateway === "ok" && livekit && liveKitClient !== undefined;
}

/** Constructor already preloaded by capability discovery; never awaits inside a click. */
export function preparedLiveKitClient(): typeof import("./livekit-client").BrowserLiveKitClient | undefined {
  return gatewaySupportsLiveKit() ? liveKitClient : undefined;
}
