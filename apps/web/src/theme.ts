import { create } from "zustand";

export type ThemePreference = "system" | "light" | "dark";

const storageKey = "voxstudio.theme";

/* Guarded so importing this module stays safe under Bun, SSR, and a bare test DOM. */
const media = typeof window !== "undefined" && typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-color-scheme: dark)")
  : undefined;

const effective = (preference: ThemePreference): "light" | "dark" =>
  preference === "system" ? (media?.matches ? "dark" : "light") : preference;

/** index.html applies the stored preference pre-paint; this keeps it live afterwards. */
const apply = (preference: ThemePreference): void => {
  if (typeof document !== "undefined") document.documentElement.dataset.theme = effective(preference);
};

const browserStorage = (): Storage | undefined => {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    // Storage may exist but be inaccessible in sandboxed/private browser contexts.
    return undefined;
  }
};

const stored = (): ThemePreference => {
  const value = browserStorage()?.getItem(storageKey);
  return value === "light" || value === "dark" ? value : "system";
};

export const useTheme = create<{
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
}>(set => ({
  preference: stored(),
  setPreference: next => {
    // "system" is the absence of an override, so it clears the key instead of storing it.
    const storage = browserStorage();
    if (next === "system") storage?.removeItem(storageKey);
    else storage?.setItem(storageKey, next);
    apply(next);
    set({ preference: next });
  },
}));

apply(stored());
media?.addEventListener("change", () => {
  if (useTheme.getState().preference === "system") apply("system");
});
