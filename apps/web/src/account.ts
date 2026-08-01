import { create } from "zustand";
import { fetchDoor, fetchSession, signOut as signOutRequest, type AccountUser, type AuthMode, type LoginDoors } from "./lib/auth";
import { onUnauthorized } from "./lib/unauthorized";

/**
 * Shell-level account state (docs/auth.md phase 3), kept apart from the studio session
 * store: this is about who is at the door, not what a conversation is doing.
 *
 * A self-hosted deployment resolves to mode "self" and stays there — no session probe,
 * no login card, nothing changed from before accounts existed.
 */
export type AccountStatus = "loading" | "self" | "signed-in" | "signed-out" | "unavailable";

interface AccountState {
  status: AccountStatus;
  mode: AuthMode | undefined;
  /** Which ways in the deployment offers; the card renders exactly these. */
  doors: LoginDoors;
  user: AccountUser | null;
  /** Probe the door, then the session. Safe to call again after signing in or out. */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  /** A credential that stopped working: back to the card, keeping the mode. */
  markSignedOut: () => void;
}

export const useAccount = create<AccountState>((set, get) => ({
  status: "loading",
  mode: undefined,
  doors: { password: false, providers: [] },
  user: null,

  refresh: async () => {
    if (get().status === "unavailable") set({ status: "loading" });
    const { mode, doors } = await fetchDoor();
    if (mode === "self") {
      set({ status: "self", mode, doors, user: null });
      return;
    }
    if (mode === "unavailable") {
      set({ status: "unavailable", mode, doors, user: null });
      return;
    }
    const user = await fetchSession().catch(() => null);
    set({ status: user === null ? "signed-out" : "signed-in", mode, doors, user });
  },

  signOut: async () => {
    await signOutRequest().catch(() => {
      // Even a failed sign-out must not leave the shell pretending to be signed in;
      // the cookie is gone or unusable either way.
    });
    set({ status: "signed-out", user: null });
  },

  markSignedOut: () => {
    // Only meaningful under accounts: a self-hosted studio has no card to fall back to.
    if (get().mode !== "accounts") return;
    set({ status: "signed-out", user: null });
  },
}));

// Any /v1 helper hitting 401 sends the shell back to the card.
onUnauthorized(() => { useAccount.getState().markSignedOut(); });
