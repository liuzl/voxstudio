import { useEffect, useState } from "react";
import { ConversationPanel } from "./panels/ConversationPanel";
import { GeneratePanel } from "./panels/GeneratePanel";
import { PlaceholderPanel } from "./panels/PlaceholderPanel";
import { SettingsPanel } from "./panels/SettingsPanel";
import { VoicesPanel } from "./panels/VoicesPanel";
import { useStudio, type ToastView } from "./store";
import { useT, type MessageKey } from "./i18n";

type Tab = "conversation" | "generate" | "voices" | "library" | "settings";

const tabs: { id: Tab; label: MessageKey; icon: string; hint?: MessageKey }[] = [
  { id: "conversation", label: "对话", icon: "🎙" },
  { id: "generate", label: "生成", icon: "✍️" },
  { id: "voices", label: "音色", icon: "🎭" },
  // A planned phase keeps its door labeled, not silently dead.
  { id: "library", label: "素材库", icon: "🗂", hint: "规划中" },
  { id: "settings", label: "设置", icon: "⚙️" },
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
      className={`pointer-events-auto rounded-lg border px-3 py-2 text-left text-xs leading-relaxed shadow-lg shadow-black/30 ${
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

export function App() {
  const t = useT();
  const [tab, setTab] = useState<Tab>("conversation");
  const hasTakes = useStudio(state => state.takes.length > 0);

  // Generation takes are in-memory object URLs; a reload silently discards them.
  useEffect(() => {
    if (!hasTakes) return;
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [hasTakes]);

  const panel = (
    <>
      {tab === "conversation" && <ConversationPanel />}
      {tab === "generate" && <GeneratePanel />}
      {tab === "voices" && <VoicesPanel />}
      {tab === "library" && (
        <PlaceholderPanel
          title={t("素材库")}
          phase="Web Studio Phase 4"
          description={t("每条录音/话语与其转写配对：重转写、行内修正（回馈 ASR 参考集工作流）、一键升级为音色样本。落库为网关侧 SQLite。")}
        />
      )}
      {tab === "settings" && <SettingsPanel />}
    </>
  );

  return (
    <div className="flex h-full flex-col md:flex-row">
      {/* Desktop: left rail */}
      <aside className="hidden w-52 shrink-0 flex-col border-r border-ink-700 bg-ink-900 md:flex">
        <div className="px-5 py-5">
          <div className="text-lg font-semibold tracking-wide">VoxStudio</div>
          <div className="text-xs text-ink-300">self-hosted voice studio</div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3">
          {tabs.map(item => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              aria-current={tab === item.id ? "page" : undefined}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                tab === item.id ? "bg-ink-700 text-ink-100" : "text-ink-300 hover:bg-ink-800 hover:text-ink-100"
              }`}
            >
              <span aria-hidden>{item.icon}</span>
              <span>{t(item.label)}</span>
              {item.hint && <span className="ml-auto text-[10px] text-ink-500">{t(item.hint)}</span>}
            </button>
          ))}
        </nav>
        <div className="border-t border-ink-700 px-5 py-4">
          <ConnectionDot />
        </div>
      </aside>

      {/* Mobile: slim top bar */}
      <header className="flex items-center justify-between border-b border-ink-700 bg-ink-900 px-4 py-2.5 md:hidden">
        <span className="text-base font-semibold tracking-wide">VoxStudio</span>
        <ConnectionDot />
      </header>

      <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">{panel}</main>
      <Toasts />

      {/* Mobile: bottom tab bar */}
      <nav
        className="flex border-t border-ink-700 bg-ink-900 pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label={t("主导航")}
      >
        {tabs.map(item => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            aria-current={tab === item.id ? "page" : undefined}
            className={`flex min-h-14 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] ${
              tab === item.id ? "text-accent-500" : "text-ink-300"
            } ${item.hint ? "opacity-60" : ""}`}
          >
            <span aria-hidden className="text-lg leading-none">{item.icon}</span>
            <span>{t(item.label)}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
