import { useEffect, useRef, useState } from "react";
import { VoicePicker } from "../components/VoicePicker";
import { conversationControls, startConversation, stopConversation } from "../conversation";
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
  reconfiguring: { text: "重配置", tone: "bg-ink-700 text-ink-300" },
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
  const voice = useStudio(state => state.voice);
  const voiceEngine = useStudio(state => state.voiceEngine);
  const setVoice = useStudio(state => state.setVoice);

  return (
    <div className="mx-auto flex h-full max-w-sm flex-col items-center justify-center gap-6 px-6 text-center">
      <button
        onClick={onStart}
        disabled={starting}
        className="flex size-24 items-center justify-center rounded-full bg-accent-600 text-4xl shadow-lg shadow-accent-600/25 transition hover:bg-accent-500 active:scale-95 disabled:opacity-50"
        aria-label={t("开始对话")}
      >
        {starting ? "…" : "🎙"}
      </button>
      <div className="text-base font-medium">{starting ? t("启动中…") : t("开始对话")}</div>
      <div className="flex w-full flex-wrap items-center justify-center gap-3">
        {/* One decision on the start card: the voice. Choosing one routes the session's
            TTS to its owning engine — a clone voice moves onto the quality line. The ASR
            language hint is fixed to auto (measured identical to zh on SenseVoice); the
            protocol still carries it for engines that care. */}
        <VoicePicker value={voice} engine={voiceEngine} onChange={setVoice} className="max-w-44" />
      </div>
      <p className="text-xs leading-relaxed text-ink-500">
        {t("授权麦克风后进入全双工对话：断句、识别、回答全自动，回答播放时直接开口即可打断，停顿后续说会自动合并。")}
      </p>
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
      <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-ink-700 px-4 py-3 md:px-6">
        <h1 className="text-base font-semibold">{t("对话")}</h1>
        <span className={`rounded-full px-2.5 py-0.5 text-xs ${state.tone}`}>{t(state.text)}</span>
        {active && <MicLevel />}
        {/* The voice picker lives on the start card, so what it chose stays visible here. */}
        {(active || turns.length > 0) && (
          <span
            className="max-w-48 truncate rounded-full border border-ink-700 px-2.5 py-0.5 text-xs text-ink-300"
            title={t("本次对话的 TTS 音色")}
          >
            🎭 {voice ? `${voice}${voiceEngine ? ` · ${voiceEngine}` : ""}` : t("默认音色")}
          </span>
        )}
        <div className="flex-1" />
        {active && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => conversationControls()?.setMuted(!muted)}
              className={`rounded-lg border px-3 py-1.5 text-sm ${
                muted ? "border-amber-400 text-amber-300" : "border-ink-700 text-ink-300 hover:text-ink-100"
              }`}
              title={t("空格键切换")}
            >
              {muted ? t("已静音") : t("静音")}
            </button>
            <button
              onClick={() => conversationControls()?.interruptPlayback()}
              className="rounded-lg border border-ink-700 px-3 py-1.5 text-sm text-ink-300 hover:text-ink-100"
              title={t("停止当前回答（也可以直接开口打断）")}
            >
              {t("停止回答")}
            </button>
            <button
              onClick={() => void stopConversation()}
              className="rounded-lg border border-red-400/50 px-3 py-1.5 text-sm text-red-300 hover:bg-red-500/10"
            >
              {t("结束")}
            </button>
          </div>
        )}
      </header>

      <div ref={scroller} className="flex-1 overflow-y-auto px-4 py-5 md:px-6">
        {/* Same content width as every other tab, so switching tabs doesn't reflow the eye. */}
        <div className="mx-auto h-full max-w-6xl space-y-5">
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
                    className="rounded-full bg-accent-600 px-6 py-2.5 text-sm font-medium text-white shadow-lg shadow-accent-600/25 transition hover:bg-accent-500 active:scale-95 disabled:opacity-50"
                  >
                    {starting ? t("启动中…") : `🎙 ${t("重新开始")}`}
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

      <footer className="border-t border-ink-700 px-4 py-2 md:px-6">
        <div className="flex items-center gap-4 overflow-hidden text-[11px] text-ink-500">
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
