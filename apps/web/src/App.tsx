import { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Bot,
  FolderOpen,
  Menu,
  MessageCircleMore,
  Mic2,
  Settings,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { VerifyBanner } from "./AuthGate";
import { AgentsPanel } from "./panels/AgentsPanel";
import { ConversationPanel } from "./panels/ConversationPanel";
import { GeneratePanel } from "./panels/GeneratePanel";
import { LibraryPanel } from "./panels/LibraryPanel";
import { SettingsPanel } from "./panels/SettingsPanel";
import { VoicesPanel } from "./panels/VoicesPanel";
import { useStudio, type ToastView } from "./store";
import { useT, type MessageKey } from "./i18n";

export type Tab = "agents" | "conversation" | "generate" | "voices" | "library" | "settings";

const tabs: {
  id: Tab;
  label: MessageKey;
  icon: typeof Mic2;
}[] = [
  { id: "agents", label: "助手", icon: Bot },
  { id: "conversation", label: "实时对话", icon: MessageCircleMore },
  { id: "generate", label: "文本转语音", icon: AudioLines },
  { id: "voices", label: "音色库", icon: Mic2 },
  { id: "library", label: "素材库", icon: FolderOpen },
  { id: "settings", label: "设置", icon: Settings },
];

const sessionLabels: Record<string, { text: MessageKey; tone: string }> = {
  connecting: { text: "连接中", tone: "bg-yellow-400" },
  reconnecting: { text: "重连中", tone: "bg-yellow-400" },
  connected: { text: "会话中", tone: "bg-emerald-400" },
};

/**
 * Two layers, one dot: a live session's socket state wins; otherwise report gateway
 * reachability — an idle studio is "就绪", not a scary "未连接".
 */
function ConnectionDot({ withText = true }: { withText?: boolean }) {
  const t = useT();
  const connection = useStudio(state => state.connection);
  const [gateway, setGateway] = useState<"probing" | "ok" | "down">("probing");

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

  const status: { text: MessageKey; tone: string } = sessionLabels[connection]
    ?? (gateway === "ok"
      ? { text: "就绪", tone: "bg-emerald-400/60" }
      : gateway === "down"
        ? { text: "网关离线", tone: "bg-red-400" }
        : { text: "探测中", tone: "bg-ink-500" });
  return (
    <span className="flex items-center gap-2 text-xs text-ink-300">
      <span className={`inline-block size-2 rounded-full ${status.tone}`} />
      {withText && <span>{t(status.text)}</span>}
    </span>
  );
}

function Toast({ toast, onDismiss }: { toast: ToastView; onDismiss: () => void }) {
  const t = useT();
  useEffect(() => {
    // Errors wait for the user; info leaves on its own.
    if (toast.kind === "error") return;
    const timer = setTimeout(onDismiss, 3_500);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <button
      onClick={onDismiss}
      className={`pointer-events-auto rounded-xl border px-3.5 py-3 text-left text-xs leading-relaxed shadow-xl shadow-black/10 ${
        toast.kind === "error"
          ? "border-red-400/40 bg-ink-900 text-red-300"
          : "border-ink-700 bg-ink-900 text-ink-100"
      }`}
      title={t("点击关闭")}
    >
      {toast.text}
    </button>
  );
}

/** The one feedback surface: panels report outcomes here instead of scattering inline text. */
function Toasts() {
  const toasts = useStudio(state => state.toasts);
  const dismissToast = useStudio(state => state.dismissToast);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed bottom-20 right-4 z-50 flex w-72 max-w-[calc(100vw-2rem)] flex-col gap-2 md:bottom-6"
    >
      {toasts.map(toast => (
        <Toast key={toast.id} toast={toast} onDismiss={() => dismissToast(toast.id)} />
      ))}
    </div>
  );
}

/**
 * Each tab is a URL (the gateway's static fallback anticipated exactly this): "/" is the
 * agent list, and the functional workspaces deep-link and survive refresh. History API only —
 * this small route set does not need a router dependency.
 */
const tabPath = (tab: Tab): string => (tab === "agents" ? "/" : `/${tab}`);

function tabFromPath(pathname: string): Tab {
  const name = pathname.replace(/^\/+|\/+$/g, "");
  return (tabs.find(item => item.id === name)?.id ?? "agents") as Tab;
}

export function App() {
  const t = useT();
  const [tab, setTabState] = useState<Tab>(() => tabFromPath(window.location.pathname));
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const hasTakes = useStudio(state => state.takes.length > 0);

  const setTab = (next: Tab): void => {
    if (next !== tab) window.history.pushState(null, "", tabPath(next));
    setTabState(next);
    setMobileNavOpen(false);
  };

  // Back/forward move between tabs like between pages — that is the point of the URLs.
  useEffect(() => {
    const onPop = (): void => setTabState(tabFromPath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (!mobileNavOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [mobileNavOpen]);

  useEffect(() => {
    if (mainRef.current) mainRef.current.scrollTop = 0;
  }, [tab]);

  // Generation takes are in-memory object URLs; a reload silently discards them.
  useEffect(() => {
    if (!hasTakes) return;
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [hasTakes]);

  const panel = (
    <>
      {tab === "agents" && <AgentsPanel onOpenAgent={() => setTab("conversation")} />}
      {tab === "conversation" && <ConversationPanel />}
      {tab === "generate" && <GeneratePanel />}
      {tab === "voices" && <VoicesPanel />}
      {tab === "library" && <LibraryPanel />}
      {tab === "settings" && <SettingsPanel />}
    </>
  );

  const sidebarItem = (
    target: Tab,
    label: MessageKey,
    Icon: typeof Bot,
    badge?: string,
  ) => {
    const selected = tab === target;
    return (
    <button
      key={target}
      onClick={() => setTab(target)}
      aria-current={selected ? "page" : undefined}
      className={`flex h-[37px] w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition ${
        selected
          ? "bg-[#f2f2f0] font-medium text-[#20201e]"
          : "text-[#73736d] hover:bg-[#f6f6f4] hover:text-[#20201e]"
      }`}
    >
      <Icon className={`size-[15px] shrink-0 ${selected ? "text-[#343430]" : "text-[#8c8c85]"}`} strokeWidth={1.75} />
      <span className="flex-1">{t(label)}</span>
      {badge && <span className="text-[10px] font-medium text-[#f36f21]">{badge}</span>}
    </button>
    );
  };

  const navigation = (
    <>
      <div className="flex h-[58px] items-center gap-2.5 px-5">
        <span className="flex size-7 items-center justify-center rounded-lg bg-[#171715] text-white">
          <AudioLines className="size-4" strokeWidth={2.3} />
        </span>
        <span className="text-[14px] font-semibold tracking-[-0.025em] text-[#181816]">VoxStudio</span>
      </div>

      <nav className="sidebar-scroll flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-5 pt-4">
        <div>
          <div className="mb-1 px-2.5 text-[11px] font-medium text-[#989891]">{t("工作台")}</div>
          <div className="space-y-0.5">
            {sidebarItem("agents", "助手", Bot, "Beta")}
            {sidebarItem("conversation", "实时对话", MessageCircleMore)}
          </div>
        </div>

        <div className="mt-7">
          <div className="mb-1 px-2.5 text-[11px] font-medium text-[#989891]">{t("语音创作")}</div>
          <div className="space-y-0.5">
            {sidebarItem("generate", "文本转语音", AudioLines)}
            {sidebarItem("voices", "音色", Mic2)}
          </div>
        </div>

        <div className="mt-7">
          <div className="mb-1 px-2.5 text-[11px] font-medium text-[#989891]">{t("资产")}</div>
          <div className="space-y-0.5">
            {sidebarItem("library", "素材库", FolderOpen)}
          </div>
        </div>

        <div className="mt-7">
          <div className="mb-1 px-2.5 text-[11px] font-medium text-[#989891]">{t("系统")}</div>
          <div className="space-y-0.5">
            {sidebarItem("settings", "运行时与设置", SlidersHorizontal)}
          </div>
        </div>
      </nav>

      <div className="flex h-[58px] items-center gap-2 border-t border-[#eceeed] px-4">
        <div className="flex min-w-0 flex-1 items-center gap-2.5 px-1.5">
          <span className="flex size-6 items-center justify-center rounded-full bg-[#f1f1ee] text-[9px] font-semibold text-[#74746e]">VS</span>
          <div className="min-w-0">
            <div className="truncate text-[11px] font-medium text-[#4c4c47]">{t("自托管语音工作台")}</div>
            <ConnectionDot />
          </div>
        </div>
        <button onClick={() => setTab("settings")} aria-label={t("设置")} className="flex size-8 items-center justify-center rounded-lg text-[#777c83] hover:bg-[#f4f4f2]">
          <Settings className="size-[16px]" strokeWidth={1.7} />
        </button>
      </div>
    </>
  );

  return (
    <div className="flex h-full min-h-0 bg-white text-[#181816]">
      <aside className="hidden w-[276px] shrink-0 flex-col border-r border-[#e9e9e5] bg-white md:flex">
        {navigation}
      </aside>

      <header className="fixed inset-x-0 top-0 z-30 flex h-[74px] items-center justify-between border-b border-[#eeeeea] bg-white/95 px-4 backdrop-blur md:hidden">
        <span className="flex items-center gap-2.5 text-[15px] font-semibold tracking-[-0.025em]">
          <span className="flex size-8 items-center justify-center rounded-[10px] bg-[#171715] text-white">
            <AudioLines className="size-4" strokeWidth={2.2} />
          </span>
          VoxStudio
        </span>
        <button
          aria-label={mobileNavOpen ? t("关闭导航") : t("打开导航")}
          aria-expanded={mobileNavOpen}
          onClick={() => setMobileNavOpen(open => !open)}
          className="flex size-9 items-center justify-center rounded-lg border border-[#e0e0db] bg-white text-[#474742] shadow-sm"
        >
          {mobileNavOpen ? <X className="size-[17px]" /> : <Menu className="size-[17px]" />}
        </button>
      </header>

      {mobileNavOpen && (
        <div className="fixed inset-0 z-20 md:hidden">
          <button
            aria-label={t("关闭导航")}
            className="absolute inset-0 bg-black/15 backdrop-blur-[1px]"
            onClick={() => setMobileNavOpen(false)}
          />
          <aside className="absolute bottom-0 left-0 top-[74px] flex w-[min(82vw,310px)] flex-col border-r border-[#e9e9e5] bg-white shadow-[16px_0_48px_rgba(0,0,0,0.1)]">
            {navigation}
          </aside>
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col pt-[74px] md:pt-0">
        <VerifyBanner />
        <main ref={mainRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-white">{panel}</main>
      </div>
      <Toasts />
    </div>
  );
}
