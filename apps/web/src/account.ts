import { create } from "zustand";
import { fetchDoor, fetchSession, signOut as signOutRequest, type AccountUser, type AuthMode, type LoginDoors } from "./lib/auth";
import { clearGatewayToken, configureGatewayAuth, gatewayFetch, hasGatewayToken, setGatewayToken } from "./lib/gateway-auth";
import { onUnauthorized } from "./lib/unauthorized";

/**
 * Shell-level account state (docs/auth.md phase 3), kept apart from the studio session
 * store: this is about who is at the door, not what a conversation is doing.
 *
 * An unprotected self-hosted deployment passes through unchanged. A protected one must
 * prove its tab-scoped shared token before the product shell mounts.
 */
export type AccountStatus = "loading" | "self" | "token-required" | "signed-in" | "signed-out" | "unavailable";

interface AccountState {
  status: AccountStatus;
  mode: AuthMode | undefined;
  /** Which ways in the deployment offers; the card renders exactly these. */
  doors: LoginDoors;
  user: AccountUser | null;
  tokenRequired: boolean;
  tokenRejected: boolean;
  /** Probe the door, then the session. Safe to call again after signing in or out. */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  unlockSelfHosted: (token: string) => Promise<void>;
  /** A credential that stopped working: back to the card, keeping the mode. */
  markSignedOut: () => void;
}

export const useAccount = create<AccountState>((set, get) => ({
  status: "loading",
  mode: undefined,
  doors: { password: false, providers: [] },
  user: null,
  tokenRequired: false,
  tokenRejected: false,

  refresh: async () => {
    if (get().status === "unavailable") set({ status: "loading" });
    const { mode, doors, tokenRequired } = await fetchDoor();
    configureGatewayAuth(mode, tokenRequired);
    if (mode === "self") {
      if (tokenRequired && !hasGatewayToken()) {
        set({ status: "token-required", mode, doors, user: null, tokenRequired, tokenRejected: false });
        return;
      }
      if (tokenRequired) {
        try {
          const probe = await gatewayFetch("/v1/engines");
          if (probe.status === 401) {
            clearGatewayToken();
            set({ status: "token-required", mode, doors, user: null, tokenRequired, tokenRejected: true });
            return;
          }
        } catch {
          set({ status: "unavailable", mode: "unavailable", doors, user: null, tokenRequired, tokenRejected: false });
          return;
        }
      }
      set({ status: "self", mode, doors, user: null, tokenRequired, tokenRejected: false });
      return;
    }
    if (mode === "unavailable") {
      set({ status: "unavailable", mode, doors, user: null, tokenRequired: false, tokenRejected: false });
      return;
    }
    const user = await fetchSession().catch(() => null);
    set({ status: user === null ? "signed-out" : "signed-in", mode, doors, user, tokenRequired: false, tokenRejected: false });
  },

  signOut: async () => {
    await signOutRequest().catch(() => {
      // Even a failed sign-out must not leave the shell pretending to be signed in;
      // the cookie is gone or unusable either way.
    });
    set({ status: "signed-out", user: null });
  },

  unlockSelfHosted: async sharedToken => {
    setGatewayToken(sharedToken);
    set({ status: "loading", tokenRejected: false });
    await get().refresh();
  },

  markSignedOut: () => {
    if (get().mode === "self" && get().tokenRequired) {
      clearGatewayToken();
      set({ status: "token-required", user: null, tokenRejected: true });
      return;
    }
    if (get().mode !== "accounts") return;
    set({ status: "signed-out", user: null });
  },
}));

// Any /v1 helper hitting 401 sends the shell back to the card.
onUnauthorized(() => { useAccount.getState().markSignedOut(); });
