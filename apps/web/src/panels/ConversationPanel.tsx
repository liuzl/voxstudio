import { useEffect, useRef, useState } from "react";
import {
  AudioLines,
  CircleStop,
  Gauge,
  Headphones,
  Mic,
  MicOff,
  Radio,
  ShieldCheck,
  Sparkles,
  VolumeX,
} from "lucide-react";
import { VoicePicker } from "../components/VoicePicker";
import { ConversationRoutePicker } from "../components/EngineRoutePicker";
import { PageHeader, SectionCard, StatusBadge, primaryButton, secondaryButton } from "../components/StudioPage";
import { conversationControls, startConversation, stopConversation } from "../conversation";
import { useGatewayHealth } from "../lib/useGatewayHealth";
import { useStudio, type TurnView } from "../store";
import { useT, type MessageKey } from "../i18n";

const stateLabels: Record<string, { text: MessageKey; tone: string }> = {
  off: { text: "未开始", tone: "bg-ink-700 text-ink-300" },
  idle: { text: "空闲", tone: "bg-ink-700 text-ink-300" },
  listening: { text: "聆听中", tone: "bg-emerald-500/20 text-emerald-300" },
  speech_started: { text: "你在说话", tone: "bg-sky-500/20 text-sky-300" },
  finalizing: { text: "断句中", tone: "bg-sky-500/20 text-sky-300" },
  thinking: { text: "思考中", tone: "bg-amber-500/20 text-amber-300" },
  speaking: { text: "回答中", tone: "bg-accent-500/20 text-accent-500" },
  closed: { text: "已结束", tone: "bg-ink-700 text-ink-300" },
};

const timingLabels: [string, MessageKey][] = [
  ["vad_end", "断句"],
  ["asr_done", "识别"],
  ["llm_first", "首字"],
  ["tts_first_audio", "首音"],
  ["playback_first", "开播"],
];

function TimingChips({ turn }: { turn: TurnView }) {
  const t = useT();
  if (!turn.timing) return null;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1.5 text-[11px] text-ink-300">
      {timingLabels.map(([key, label]) => {
        const value = turn.timing?.[key];
        if (value === undefined) return null;
        return (
          <span key={key} className="rounded bg-ink-800 px-1.5 py-0.5">
            {t(label)} +{Math.round(value)}ms
          </span>
        );
      })}
    </div>
  );
}

/** Quiet per-turn meta: a timestamp, the developer timings behind a toggle, copy. */
function TurnFooter({ turn }: { turn: TurnView }) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const toast = useStudio(state => state.toast);
  const copy = () => {
    void navigator.clipboard?.writeText(turn.reply || turn.transcript || "");
    toast("info", t("已复制回复内容"));
  };
  return (
    <div>
      <div className="flex items-center gap-2.5 text-[11px] text-ink-500">
        <span>{new Date(turn.at).toLocaleTimeString()}</span>
        {turn.timing && (
          <button onClick={() => setExpanded(value => !value)} className="hover:text-ink-300">
            {expanded ? t("收起耗时") : t("耗时")}
          </button>
        )}
        {turn.reply && (
          <button onClick={copy} className="hover:text-ink-300">
            {t("复制")}
          </button>
        )}
        {turn.reopens > 0 && <span className="text-amber-300/80">{t("续说 ×{n}", { n: turn.reopens })}</span>}
        {turn.falseBargeIns > 0 && <span>{t("忽略杂音 ×{n}", { n: turn.falseBargeIns })}</span>}
      </div>
      {expanded && <TimingChips turn={turn} />}
    </div>
  );
}

/**
 * The stuck-turn escape hatch: a quiet "思考中…" grows a waited-seconds counter and a
 * cancel button once the wait stops feeling like latency and starts feeling like a hang.
 */
function ThinkingBubble({ turn }: { turn: TurnView }) {
  const t = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const waited = Math.max(0, Math.round((now - turn.statusAt) / 1_000));
  return (
    <span className="text-ink-500">
      {t("思考中…")}
      {waited >= 8 && (
        <>
          <span className="ml-2 text-[11px]">{t("已等待 {n}s", { n: waited })}</span>
          <button
            onClick={() => conversationControls()?.cancelTurn(turn.id)}
            className="ml-2 text-[11px] text-amber-300 hover:underline"
          >
            {t("取消本轮")}
          </button>
        </>
      )}
    </span>
  );
}

/** What the assistant did, not just said: one chip per tool invocation. */
function ToolChips({ turn }: { turn: TurnView }) {
  const t = useT();
  if (turn.tools.length === 0) return null;
  const labels: Record<string, string> = {
    set_voice: t("切换音色"),
    set_speed: t("调整语速"),
    get_engine_status: t("查询引擎状态"),
    end_call: t("挂断"),
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {turn.tools.map((tool, index) => (
        <span
          key={index}
          className={`rounded-full px-2 py-0.5 text-[11px] ${
            tool.pending ? "bg-amber-500/15 text-amber-300"
              : tool.ok === false ? "bg-red-500/15 text-red-300" : "bg-ink-800 text-ink-300"
          }`}
        >
          {tool.pending ? "⏳" : "🔧"} {labels[tool.name] ?? tool.name}
          {tool.detail !== undefined && ` → ${tool.detail}`}
          {tool.pending ? ` ${t("待确认")}` : tool.ok === true ? " ✓" : tool.ok === false ? " ✗" : " …"}
        </span>
      ))}
    </div>
  );
}

function TurnCard({ turn }: { turn: TurnView }) {
  const t = useT();
  return (
    <div className="space-y-2">
      {turn.transcript !== undefined ? (
        <div className="flex justify-end">
          <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent-600/20 px-4 py-2.5 text-sm leading-relaxed md:max-w-[75%]">
            {turn.transcript}
          </div>
        </div>
      ) : turn.status === "capturing" ? (
        <div className="flex justify-end">
          <div className="rounded-2xl rounded-br-sm bg-ink-800 px-4 py-2.5 text-sm text-ink-300">…</div>
        </div>
      ) : null}
      {(turn.reply || turn.status === "thinking") && (
        <div className="flex justify-start">
          <div
            className={`max-w-[85%] rounded-2xl rounded-bl-sm bg-ink-800 px-4 py-2.5 text-sm leading-relaxed md:max-w-[75%] ${
              turn.status === "interrupted" ? "opacity-60" : ""
            }`}
          >
            {turn.reply || <ThinkingBubble turn={turn} />}
            {turn.status === "interrupted" && <span className="ml-2 text-xs text-amber-300">{t("（被打断）")}</span>}
          </div>
        </div>
      )}
      <ToolChips turn={turn} />
      <TurnFooter turn={turn} />
    </div>
  );
}

/** Five bars of local mic RMS — the "it hears you" signal while a session runs. */
function MicLevel() {
  const t = useT();
  const level = useStudio(state => state.micLevel);
  const muted = useStudio(state => state.muted);
  const lit = muted ? 0 : Math.min(5, Math.ceil(level * 5));
  return (
    <div
      className={`flex items-end gap-0.5 ${muted ? "opacity-40" : ""}`}
      title={muted ? t("已静音") : t("麦克风电平")}
      role="img"
      aria-label={muted ? t("麦克风已静音") : t("麦克风电平")}
    >
      {[0, 1, 2, 3, 4].map(bar => (
        <span
          key={bar}
          className={`w-1 rounded-sm transition-colors ${bar < lit ? "bg-emerald-400" : "bg-ink-700"}`}
          style={{ height: 5 + bar * 2.5 }}
        />
      ))}
    </div>
  );
}

function StartCard({ starting, onStart }: { starting: boolean; onStart: () => void }) {
  const t = useT();
  const gateway = useGatewayHealth();
  const voice = useStudio(state => state.voice);
  const voiceEngine = useStudio(state => state.voiceEngine);
  const setVoice = useStudio(state => state.setVoice);
  const capabilities = [
    { icon: Headphones, label: t("低延迟流式播放") },
    { icon: VolumeX, label: t("开口即可打断回答") },
    { icon: Gauge, label: t("逐轮耗时可观测") },
    { icon: ShieldCheck, label: t("音频默认不留存") },
  ];

  return (
    <div className="grid min-h-full gap-5 py-1 lg:grid-cols-[minmax(0,1.4fr)_minmax(280px,0.6fr)]">
      <SectionCard className="flex min-h-[430px] flex-col overflow-hidden">
        <div className="flex items-center gap-2 border-b border-ink-700 px-5 py-3.5 text-[12px] text-ink-500">
          <Radio className="size-3.5" />
          {t("实时试用")}
          <span className="ml-auto flex items-center gap-1.5">
            <span
              className={`size-1.5 rounded-full ${
                gateway === "ok" ? "bg-emerald-500" : gateway === "down" ? "bg-red-500" : "bg-ink-500"
              }`}
            />
            {t(gateway === "ok" ? "网关就绪" : gateway === "down" ? "网关离线" : "探测中")}
          </span>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
          <span className="relative flex size-20 items-center justify-center rounded-full border border-ink-700 bg-ink-950 shadow-sm">
            <span className="absolute inset-2 rounded-full border border-ink-700/60" />
            <AudioLines className="relative size-7 text-ink-100" strokeWidth={1.55} />
          </span>
          <h2 className="mt-6 text-xl font-semibold tracking-[-0.03em]">
            {starting ? t("启动中…") : t("和你的语音助手实时对话")}
          </h2>
          <p className="mt-2 max-w-md text-[13px] leading-5 text-ink-500">
            {t("全双工会话支持实时转写、自然打断和逐轮延迟观测。")}
          </p>
          <button onClick={onStart} disabled={starting} className={`${primaryButton} mt-7 min-w-40`} aria-label={t("开始对话")}>
            {starting ? <Sparkles className="size-4 animate-pulse" /> : <Mic className="size-4" />}
            {starting ? t("启动中…") : t("开始对话")}
          </button>
          <p className="mt-3 text-[10px] text-ink-500">{t("首次使用需要授权麦克风")}</p>
        </div>
      </SectionCard>

      <div className="space-y-5">
        <SectionCard className="overflow-hidden">
          <div className="border-b border-ink-700 px-4 py-3.5">
            <h3 className="text-[13px] font-medium">{t("会话设置")}</h3>
            <p className="mt-0.5 text-[11px] text-ink-500">{t("开始前确认音色和运行路线")}</p>
          </div>
          <div className="space-y-4 p-4">
            <label className="block">
              <span className="mb-1.5 block text-[11px] font-medium text-ink-500">{t("音色")}</span>
              <VoicePicker value={voice} engine={voiceEngine} onChange={setVoice} className="w-full" />
            </label>
            <div>
              <span className="mb-1.5 block text-[11px] font-medium text-ink-500">{t("运行路线")}</span>
              <ConversationRoutePicker />
            </div>
          </div>
        </SectionCard>

        <SectionCard className="p-4">
          <h3 className="text-[12px] font-medium">{t("体验能力")}</h3>
          <div className="mt-3 space-y-3">
            {capabilities.map(item => (
              <div key={item.label} className="flex items-center gap-2.5 text-[11px] text-ink-300">
                <item.icon className="size-3.5 text-ink-500" strokeWidth={1.8} />
                <span>{item.label}</span>
              </div>
            ))}
          </div>
        </SectionCard>
      </div>
    </div>
  );
}

export function ConversationPanel() {
  const t = useT();
  const [starting, setStarting] = useState(false);
  const active = useStudio(state => state.active);
  const voice = useStudio(state => state.voice);
  const voiceEngine = useStudio(state => state.voiceEngine);
  const muted = useStudio(state => state.muted);
  const sessionState = useStudio(state => state.sessionState);
  const turns = useStudio(state => state.turns);
  const notices = useStudio(state => state.notices);
  const capability = useStudio(state => state.capability);
  const toast = useStudio(state => state.toast);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  // No unmount cleanup on purpose: the conversation is app-scoped and survives tab
  // switches. It ends on 结束, on session.stop, or with the page.

  // Space toggles mute during a session — the hands-on-keyboard mute switch.
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, button, [contenteditable]")) return;
      event.preventDefault();
      conversationControls()?.setMuted(!useStudio.getState().muted);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  const start = async () => {
    setStarting(true);
    try {
      await startConversation();
    } catch (error) {
      toast("error", t("启动失败：{error}", { error: error instanceof Error ? error.message : String(error) }));
    } finally {
      setStarting(false);
    }
  };

  // A finished session with history reads "已结束", not "未开始" — the restart bar below
  // the turns is the way back in.
  const stateKey = active ? sessionState : turns.length > 0 ? "closed" : "off";
  const state = stateLabels[stateKey] ?? stateLabels.off as { text: MessageKey; tone: string };
  const lastNotice = notices[notices.length - 1];
  const clearHistory = useStudio(state => state.clearHistory);

  return (
    <div className="flex h-full flex-col">
      <header>
        <div className="mx-auto w-full max-w-[1276px] px-4 pt-8 sm:px-8 sm:pt-12 lg:px-12 lg:pt-14">
          <PageHeader
            title={t("实时对话")}
            description={t("全双工会话支持实时转写、自然打断和逐轮延迟观测。")}
            badge={<StatusBadge tone={active ? "success" : "neutral"}>{t(state.text)}</StatusBadge>}
            actions={(
              <>
                {active && <MicLevel />}
                {(active || turns.length > 0) && (
                  <span
                    className="max-w-48 truncate rounded-full border border-ink-700 px-3 py-1.5 text-xs text-ink-300"
                    title={t("本次对话的 TTS 音色")}
                  >
                    🎭 {voice ? `${voice}${voiceEngine ? ` · ${voiceEngine}` : ""}` : t("默认音色")}
                  </span>
                )}
                {active && (
                  <>
                    <button
                      onClick={() => conversationControls()?.setMuted(!muted)}
                      className={`${secondaryButton} ${muted ? "border-amber-300 bg-amber-50 text-amber-700" : ""}`}
                      title={t("空格键切换")}
                    >
                      {muted ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
                      <span className="hidden sm:inline">{muted ? t("已静音") : t("静音")}</span>
                    </button>
                    <button
                      onClick={() => conversationControls()?.interruptPlayback()}
                      className={secondaryButton}
                      title={t("停止当前回答（也可以直接开口打断）")}
                    >
                      <CircleStop className="size-3.5" />
                      <span className="hidden sm:inline">{t("停止回答")}</span>
                    </button>
                    <button
                      onClick={() => void stopConversation()}
                      className="inline-flex min-h-10 items-center gap-2 rounded-full border border-red-200 bg-red-50 px-4 text-[13px] font-medium text-red-700 hover:bg-red-100"
                    >
                      {t("结束")}
                    </button>
                  </>
                )}
              </>
            )}
          />
        </div>
      </header>

      <div ref={scroller} className="flex-1 overflow-y-auto">
        {/* Same content width as every other tab, so switching tabs doesn't reflow the eye. */}
        <div className="mx-auto h-full w-full max-w-[1276px] space-y-5 px-4 pb-16 pt-8 sm:px-8 lg:px-12">
          {!active && turns.length === 0 ? (
            <StartCard starting={starting} onStart={() => void start()} />
          ) : (
            <>
              {turns.length === 0 && (
                <div className="mx-auto mt-16 max-w-md text-center text-sm leading-relaxed text-ink-500">
                  {t("开口即说 —— 断句、识别、回答全自动；回答播放时直接说话就能打断。")}
                </div>
              )}
              {turns.map(turn => (
                <TurnCard key={turn.id} turn={turn} />
              ))}
              {/* The way back in: a finished session leaves its history, not a dead end. */}
              {!active && turns.length > 0 && (
                <div className="flex flex-col items-center gap-2.5 pb-2 pt-5">
                  <button
                    onClick={() => void start()}
                    disabled={starting}
                    className={primaryButton}
                  >
                    <Mic className="size-4" />
                    {starting ? t("启动中…") : t("重新开始")}
                  </button>
                  <button onClick={clearHistory} className="text-xs text-ink-500 hover:text-ink-300">
                    {t("清空记录")}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <footer className="border-t border-ink-700 bg-ink-900 py-2">
        <div className="mx-auto flex w-full max-w-[1276px] items-center gap-4 overflow-hidden px-4 text-[10px] text-ink-500 sm:px-8 lg:px-12">
          {capability && (
            <span className="shrink-0">
              AEC {capability.echoCancellation === false ? "✗" : "✓"} · NS {capability.noiseSuppression === false ? "✗" : "✓"} · AGC{" "}
              {capability.autoGainControl === false ? "✗" : "✓"} · {capability.contextSampleRate}Hz
            </span>
          )}
          {lastNotice && (
            <span className={`truncate ${lastNotice.kind === "error" ? "text-red-300" : ""}`}>{lastNotice.text}</span>
          )}
        </div>
      </footer>
    </div>
  );
}
