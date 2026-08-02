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
import { AgentsPanel, type AgentSection } from "./panels/AgentsPanel";
import { ConversationPanel } from "./panels/ConversationPanel";
import { GeneratePanel } from "./panels/GeneratePanel";
import { LibraryPanel } from "./panels/LibraryPanel";
import { SettingsPanel } from "./panels/SettingsPanel";
import { VoicesPanel } from "./panels/VoicesPanel";
import { useGatewayHealth } from "./lib/useGatewayHealth";
import { useAccount } from "./account";
import { useStudio, type ToastView } from "./store";
import { useT, type MessageKey } from "./i18n";

/* The sidebar (grouped, hand-laid-out) is the source of labels and icons; routes only need ids. */
const tabIds = ["agents", "conversation", "generate", "voices", "library", "settings"] as const;
export type Tab = (typeof tabIds)[number];

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
  const gateway = useGatewayHealth();

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
  if (name.startsWith("agents/")) return "agents";
  return tabIds.find(id => id === name) ?? "agents";
}

export interface AgentRoute {
  id: string;
  section: AgentSection;
}

export function agentRouteFromPath(pathname: string): AgentRoute | undefined {
  const match = /^\/agents\/([^/]+)(?:\/(configuration|speech))?\/?$/.exec(pathname);
  if (!match?.[1]) return undefined;
  try {
    return {
      id: decodeURIComponent(match[1]),
      section: (match[2] as AgentSection | undefined) ?? "configuration",
    };
  } catch {
    return undefined;
  }
}

export const agentPath = (id: string, section: AgentSection): string =>
  `/agents/${encodeURIComponent(id)}/${section}`;

export function App() {
  const t = useT();
  const [tab, setTabState] = useState<Tab>(() => tabFromPath(window.location.pathname));
  const initialAgentRoute = agentRouteFromPath(window.location.pathname);
  const [agentId, setAgentId] = useState<string | undefined>(() => initialAgentRoute?.id);
  const [agentSection, setAgentSection] = useState<AgentSection>(() => initialAgentRoute?.section ?? "configuration");
  const [agentDirty, setAgentDirty] = useState(false);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const mainRef = useRef<HTMLElement>(null);
  const hasTakes = useStudio(state => state.takes.length > 0);
  const accountStatus = useAccount(state => state.status);
  const accountUser = useAccount(state => state.user);
  const accountName = accountUser?.name.trim() || accountUser?.email.split("@")[0] || "VoxStudio";
  const accountInitials = accountName
    .split(/\s+/)
    .slice(0, 2)
    .map(part => Array.from(part)[0] ?? "")
    .join("")
    .toUpperCase();

  const confirmAgentLeave = (): boolean => !agentDirty || window.confirm(t("放弃未保存的更改？"));

  const setTab = (next: Tab): void => {
    if (agentId && !confirmAgentLeave()) return;
    const path = tabPath(next);
    if (window.location.pathname !== path) window.history.pushState(null, "", path);
    setTabState(next);
    setAgentId(undefined);
    setAgentSection("configuration");
    setAgentDirty(false);
    setMobileNavOpen(false);
  };

  const openAgent = (id: string): void => {
    if (agentId === id) return;
    if (agentId && !confirmAgentLeave()) return;
    window.history.pushState(null, "", agentPath(id, "configuration"));
    setTabState("agents");
    setAgentId(id);
    setAgentSection("configuration");
    setAgentDirty(false);
    setMobileNavOpen(false);
  };

  const closeAgent = (): void => {
    if (!confirmAgentLeave()) return;
    window.history.pushState(null, "", "/");
    setTabState("agents");
    setAgentId(undefined);
    setAgentSection("configuration");
    setAgentDirty(false);
  };

  const openAgentSection = (section: AgentSection): void => {
    if (!agentId || section === agentSection) return;
    window.history.pushState(null, "", agentPath(agentId, section));
    setAgentSection(section);
  };

  // Back/forward move between tabs like between pages — that is the point of the URLs.
  useEffect(() => {
    const onPop = (): void => {
      const nextTab = tabFromPath(window.location.pathname);
      const nextAgent = agentRouteFromPath(window.location.pathname);
      const nextAgentId = nextAgent?.id;
      if (agentDirty && agentId && nextAgentId !== agentId && !window.confirm(t("放弃未保存的更改？"))) {
        window.history.pushState(null, "", agentPath(agentId, agentSection));
        return;
      }
      setTabState(nextTab);
      setAgentId(nextAgentId);
      setAgentSection(nextAgent?.section ?? "configuration");
      if (nextAgentId !== agentId) setAgentDirty(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [agentDirty, agentId, agentSection, t]);

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
  }, [tab, agentId, agentSection]);

  // Generation takes are in-memory object URLs; a reload silently discards them.
  useEffect(() => {
    if (!hasTakes && !agentDirty) return;
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [agentDirty, hasTakes]);

  const panel = (
    <>
      {tab === "agents" && <AgentsPanel agentId={agentId} agentSection={agentSection} onOpenAgent={openAgent} onOpenAgentSection={openAgentSection} onCloseAgent={closeAgent} onDirtyChange={setAgentDirty} />}
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
          ? "bg-fill-active font-medium text-fg"
          : "text-fg-tertiary hover:bg-fill-hover hover:text-fg"
      }`}
    >
      <Icon className={`size-[15px] shrink-0 ${selected ? "text-fg" : "text-fg-muted"}`} strokeWidth={1.75} />
      <span className="flex-1">{t(label)}</span>
      {badge && <span className="text-[10px] font-medium text-accent">{badge}</span>}
    </button>
    );
  };

  const navigation = (
    <>
      <div className="flex h-[58px] items-center gap-2.5 px-5">
        <span className="flex size-7 items-center justify-center rounded-lg bg-ink text-on-ink">
          <AudioLines className="size-4" strokeWidth={2.3} />
        </span>
        <span className="text-[14px] font-semibold tracking-[-0.025em] text-ink">VoxStudio</span>
      </div>

      <nav className="sidebar-scroll flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-5 pt-4">
        <div>
          <div className="mb-1 px-2.5 text-[11px] font-medium text-fg-faint">{t("工作台")}</div>
          <div className="space-y-0.5">
            {sidebarItem("agents", "助手", Bot, "Beta")}
            {sidebarItem("conversation", "实时对话", MessageCircleMore)}
          </div>
        </div>

        <div className="mt-7">
          <div className="mb-1 px-2.5 text-[11px] font-medium text-fg-faint">{t("语音创作")}</div>
          <div className="space-y-0.5">
            {sidebarItem("generate", "文本转语音", AudioLines)}
            {sidebarItem("voices", "音色", Mic2)}
          </div>
        </div>

        <div className="mt-7">
          <div className="mb-1 px-2.5 text-[11px] font-medium text-fg-faint">{t("资产")}</div>
          <div className="space-y-0.5">
            {sidebarItem("library", "素材库", FolderOpen)}
          </div>
        </div>

        <div className="mt-7">
          <div className="mb-1 px-2.5 text-[11px] font-medium text-fg-faint">{t("系统")}</div>
          <div className="space-y-0.5">
            {sidebarItem("settings", "运行时与设置", SlidersHorizontal)}
          </div>
        </div>
      </nav>

      <div className="flex h-[58px] items-center gap-2 border-t border-edge-faint px-4">
        {accountStatus === "signed-in" && accountUser ? (
          <button onClick={() => setTab("settings")} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 py-1 text-left hover:bg-fill-hover" aria-label={t("账户")}>
            <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ink text-[9px] font-semibold text-on-ink">{accountInitials || "VS"}</span>
            <span className="min-w-0">
              <span className="block truncate text-[11px] font-medium text-fg-secondary">{accountName}</span>
              <span className="block truncate text-[10px] text-fg-faint">{accountUser.email}</span>
            </span>
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2.5 px-1.5">
            <span className="flex size-6 items-center justify-center rounded-full bg-fill-active text-[9px] font-semibold text-fg-tertiary">VS</span>
            <div className="min-w-0">
              <div className="truncate text-[11px] font-medium text-fg-secondary">{t("自托管语音工作台")}</div>
              <ConnectionDot />
            </div>
          </div>
        )}
        <button onClick={() => setTab("settings")} aria-label={t("设置")} className="flex size-8 items-center justify-center rounded-lg text-fg-tertiary hover:bg-fill-hover">
          <Settings className="size-[16px]" strokeWidth={1.7} />
        </button>
      </div>
    </>
  );

  return (
    <div className="flex h-full min-h-0 bg-canvas text-ink">
      <aside className="hidden w-[276px] shrink-0 flex-col border-r border-edge-faint bg-canvas md:flex">
        {navigation}
      </aside>

      <header className="fixed inset-x-0 top-0 z-30 flex h-[74px] items-center justify-between border-b border-edge-faint bg-canvas/95 px-4 backdrop-blur md:hidden">
        <span className="flex items-center gap-2.5 text-[15px] font-semibold tracking-[-0.025em]">
          <span className="flex size-8 items-center justify-center rounded-[10px] bg-ink text-on-ink">
            <AudioLines className="size-4" strokeWidth={2.2} />
          </span>
          VoxStudio
        </span>
        <button
          aria-label={mobileNavOpen ? t("关闭导航") : t("打开导航")}
          aria-expanded={mobileNavOpen}
          onClick={() => setMobileNavOpen(open => !open)}
          className="flex size-9 items-center justify-center rounded-lg border border-edge bg-canvas text-fg-secondary shadow-sm"
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
          <aside className="absolute bottom-0 left-0 top-[74px] flex w-[min(82vw,310px)] flex-col border-r border-edge-faint bg-canvas shadow-[16px_0_48px_rgba(0,0,0,0.1)]">
            {navigation}
          </aside>
        </div>
      )}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col pt-[74px] md:pt-0">
        <VerifyBanner />
        <main ref={mainRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-canvas">{panel}</main>
      </div>
      <Toasts />
    </div>
  );
}
