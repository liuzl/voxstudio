import { create } from "zustand";
import { de } from "./de";
import { en, type MessageKey } from "./en";
import { es } from "./es";
import { fr } from "./fr";
import { it } from "./it";
import { ja } from "./ja";
import { ko } from "./ko";
import { pt } from "./pt";
import { ru } from "./ru";

export type { MessageKey };

/**
 * The i18n scheme: the Chinese source string IS the message key — Chinese lives in the
 * components, every other language is a catalog in this directory, and `t()` only
 * accepts keys that exist in en.ts. A missing translation is a compile error, not a
 * runtime fallback. `{name}` placeholders are substituted in every language.
 *
 * Constraint on catalog text: no plural rules are applied, so translations must phrase
 * counts neutrally ("{n} total", never "{n} items"). This matters most for Slavic
 * languages when their catalogs land.
 */
const catalogs = {
  en, ja, ko, es, fr, de, pt, ru, it,
} satisfies Record<string, Record<MessageKey, string>>;

/** "zh" is the source language — it has no catalog, the keys themselves are the text. */
export type UiLocale = "zh" | keyof typeof catalogs;
export type Locale = "auto" | UiLocale;

export const uiLocales = ["zh", ...Object.keys(catalogs)] as readonly UiLocale[];

/** What <html lang> should say for each UI locale (BCP-47 decisions live here only). */
const htmlLang: Record<UiLocale, string> = {
  zh: "zh-CN", en: "en", ja: "ja", ko: "ko", es: "es",
  fr: "fr", de: "de", pt: "pt-BR", ru: "ru", it: "it",
};

/** Endonyms for the language picker — a language names itself, so these are not translated. */
export const localeNames: Record<UiLocale, string> = {
  zh: "中文", en: "English", ja: "日本語", ko: "한국어", es: "Español",
  fr: "Français", de: "Deutsch", pt: "Português", ru: "Русский", it: "Italiano",
};

const storageKey = "voxstudio.locale";
const hasDom = typeof document !== "undefined";

const isUiLocale = (value: unknown): value is UiLocale =>
  typeof value === "string" && (uiLocales as readonly string[]).includes(value);

function detect(): UiLocale {
  if (typeof navigator === "undefined") return "zh";
  // Walk the whole preference list, not just the first entry, matching primary
  // subtags (zh-TW/zh-HK fold into zh until a zh-Hant catalog exists).
  for (const tag of navigator.languages ?? [navigator.language]) {
    const primary = (tag ?? "").toLowerCase().split("-")[0];
    if (isUiLocale(primary)) return primary;
  }
  return "en";
}

export function resolveLocale(locale: Locale): UiLocale {
  if (locale === "auto") return detect();
  // Keep the runtime boundary defensive too: JavaScript callers, stale persisted
  // state, and test seams are not constrained by the Locale TypeScript union.
  return isUiLocale(locale) ? locale : "en";
}

const storedLocale = (): Locale => {
  if (typeof localStorage === "undefined") return "auto";
  const value = localStorage.getItem(storageKey);
  return value === "auto" || isUiLocale(value) ? value : "auto";
};

const applyLang = (locale: Locale): void => {
  if (hasDom) document.documentElement.lang = htmlLang[resolveLocale(locale)];
};

interface I18nState {
  locale: Locale;
  setLocale(locale: Locale): void;
}

export const useI18n = create<I18nState>(set => ({
  locale: storedLocale(),
  setLocale: locale => {
    if (typeof localStorage !== "undefined") localStorage.setItem(storageKey, locale);
    applyLang(locale);
    set({ locale });
  },
}));

applyLang(useI18n.getState().locale);

function format(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match);
}

/** Translate a message; usable outside React (reads the store imperatively). */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const locale = resolveLocale(useI18n.getState().locale);
  // Optional chaining is runtime defense in depth; the Record types cover typed callers.
  const text = locale === "zh" ? key : (catalogs[locale]?.[key] ?? en[key] ?? key);
  return format(text, params);
}

/** React hook version: subscribes to locale changes so components re-render on switch. */
export function useT(): typeof t {
  useI18n(state => state.locale);
  return t;
}

/** For the i18n test only: the full catalog map, keyed by locale. */
export const allCatalogs: Readonly<Record<string, Record<MessageKey, string>>> = catalogs;
