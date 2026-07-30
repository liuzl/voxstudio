import { create } from "zustand";

export type ThemePreference = "system" | "light" | "dark";

const storageKey = "voxstudio.theme";

/* Guarded so importing this module stays safe under the test runner's bare DOM. */
const media = typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-color-scheme: dark)")
  : undefined;

const effective = (preference: ThemePreference): "light" | "dark" =>
  preference === "system" ? (media?.matches ? "dark" : "light") : preference;

/** index.html applies the stored preference pre-paint; this keeps it live afterwards. */
const apply = (preference: ThemePreference): void => {
  document.documentElement.dataset.theme = effective(preference);
};

const stored = (): ThemePreference => {
  const value = localStorage.getItem(storageKey);
  return value === "light" || value === "dark" ? value : "system";
};

export const useTheme = create<{
  preference: ThemePreference;
  setPreference: (next: ThemePreference) => void;
}>(set => ({
  preference: stored(),
  setPreference: next => {
    // "system" is the absence of an override, so it clears the key instead of storing it.
    if (next === "system") localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, next);
    apply(next);
    set({ preference: next });
  },
}));

apply(stored());
media?.addEventListener("change", () => {
  if (useTheme.getState().preference === "system") apply("system");
});
