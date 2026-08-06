import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ChevronRight,
  Clock3,
  FileClock,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { resolveLocale, useI18n, useT, type MessageKey, type UiLocale } from "../i18n";
import {
  agentConversationMediaUrl,
  deleteAgentConversation,
  getAgentConversation,
  listAgentConversations,
  type ConversationOutcome,
  type ConversationMediaDescriptor,
  type ConversationTraceDetail,
  type ConversationTraceEvent,
  type ConversationTracePolicy,
  type ConversationTraceSummary,
} from "../lib/api";
import { secondaryButton } from "../components/StudioPage";
import { useStudio } from "../store";

export interface ConversationTurnView {
  id: string;
  revision: number;
  transcript?: string;
  reply?: string;
  interrupted: boolean;
  inputMedia?: ConversationMediaDescriptor;
  outputMedia?: ConversationMediaDescriptor;
}

/** Final text only: streaming deltas are protocol evidence, not duplicate transcript rows. */
export function conversationTurns(
  events: ConversationTraceEvent[],
  media: ConversationMediaDescriptor[] = [],
): ConversationTurnView[] {
  const turns = new Map<string, ConversationTurnView>();
  const interrupted = new Set<string>();
  const turn = (id: string, revision: number): ConversationTurnView => {
    const key = `${id}:${revision}`;
    const existing = turns.get(key);
    if (existing) return existing;
    const created = { id, revision, interrupted: interrupted.has(id) };
    turns.set(key, created);
    return created;
  };
  for (const event of events) {
    if (!event.turnId) continue;
    if (event.type === "playback.interrupted") {
      interrupted.add(event.turnId);
      for (const current of turns.values()) {
        if (current.id === event.turnId) current.interrupted = true;
      }
      continue;
    }
    const current = turn(event.turnId, event.revision ?? 0);
    if (event.type === "transcript.final" && typeof event.text === "string") current.transcript = event.text;
    if (event.type === "response.text.final" && typeof event.text === "string") current.reply = event.text;
  }
  for (const descriptor of [...media].sort((left, right) => left.createdAt - right.createdAt)) {
    const current = turn(descriptor.turnId, descriptor.revision);
    if (descriptor.direction === "input") current.inputMedia = descriptor;
    else current.outputMedia = descriptor;
  }
  return [...turns.values()].filter(item =>
    item.transcript !== undefined || item.reply !== undefined || item.inputMedia !== undefined || item.outputMedia !== undefined);
}

export function durationLabel(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder.toString().padStart(2, "0")}s`;
}

const outcomeKeys: Record<ConversationOutcome, MessageKey> = {
  active: "进行中",
  completed: "已完成",
  error: "失败",
  abandoned: "异常中断",
};

const outcomeTone: Record<ConversationOutcome, string> = {
  active: "bg-blue-50 text-blue-700 dark:bg-blue-500/10 dark:text-blue-300",
  completed: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
  error: "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300",
  abandoned: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
};

function timeLabel(value: number, locale: UiLocale): string {
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

function PolicyBanner({ policy }: { policy: ConversationTracePolicy }) {
  const t = useT();
  if (!policy.enabled) {
    return (
      <section className="rounded-2xl border border-dashed border-edge-strong bg-canvas px-5 py-8 text-center sm:px-8">
        <span className="mx-auto flex size-11 items-center justify-center rounded-xl bg-fill-active text-fg-muted"><FileClock className="size-5" /></span>
        <h2 className="mt-4 text-[13px] font-semibold">{t("会话记录尚未启用")}</h2>
        <p className="mx-auto mt-2 max-w-xl text-[11px] leading-5 text-fg-muted">{t("VoxStudio 默认不保存会话。启动 Gateway 时配置 --traces DIR 后，才会记录助手会话元数据。")}</p>
        <code className="mt-4 inline-block max-w-full overflow-x-auto rounded-lg bg-fill-active px-3 py-2 font-mono text-[10px] text-fg-secondary">vox studio --traces ~/.config/voxstudio/traces</code>
      </section>
    );
  }
  return (
    <div className="flex items-start gap-3 rounded-xl border border-edge bg-canvas px-4 py-3">
      <ShieldCheck className="mt-0.5 size-4 shrink-0 text-fg-muted" />
      <div className="min-w-0 flex-1">
        <p className="text-[11px] font-medium">{policy.content ? t("会话内容留存已启用") : t("仅保留会话元数据")}</p>
        <p className="mt-1 text-[10px] leading-5 text-fg-faint">{policy.audio
          ? policy.inputAudio && policy.outputAudio
            ? t("输入与输出音频也会保留，可在逐轮对话中播放。")
            : t("部分音频留存已启用，可在逐轮对话中播放。")
          : policy.content
            ? t("转写、回答和工具载荷会被保存；音频仍然不会进入 Trace Store。")
            : t("转写、回答和工具载荷不会保存；音频也不会进入 Trace Store。")}</p>
      </div>
      <span className="shrink-0 rounded-full bg-fill-active px-2 py-1 text-[9px] text-fg-muted">{t(policy.audio ? "音频开启" : "音频关闭")}</span>
    </div>
  );
}

function mediaStateLabel(media: ConversationMediaDescriptor, t: ReturnType<typeof useT>): string {
  if (media.state === "pending") return t("音频处理中");
  if (media.state === "missing") return t("音频缺失");
  if (media.state === "truncated") return t("录制不完整");
  if (media.delivery === "playback_acknowledged") return t("已播放");
  if (media.delivery === "interrupted") return t("被打断");
  if (media.delivery === "superseded") return t("已替代");
  if (media.delivery === "sent") return t("已发送");
  return t("已完成");
}

function RetainedAudio({ media, playing, failed, inverse, onToggle }: {
  media: ConversationMediaDescriptor;
  playing: boolean;
  failed: boolean;
  inverse?: boolean;
  onToggle(): void;
}) {
  const t = useT();
  const playable = media.state === "ready" || media.state === "truncated";
  const label = media.direction === "input" ? t("用户录音") : t("助手录音");
  const state = failed ? t("音频播放失败") : mediaStateLabel(media, t);
  return (
    <button
      type="button"
      disabled={!playable}
      onClick={onToggle}
      aria-label={`${playing ? t("暂停录音") : t("播放录音")} · ${label}`}
      className={`mt-2 flex max-w-full items-center gap-2 rounded-full border px-2.5 py-1.5 text-[9px] transition disabled:cursor-not-allowed disabled:opacity-55 ${inverse
        ? "border-white/20 bg-white/10 text-white hover:bg-white/15"
        : "border-edge bg-fill-faint text-fg-secondary hover:bg-fill-hover"}`}
    >
      <span className={`flex size-5 shrink-0 items-center justify-center rounded-full ${inverse ? "bg-white text-ink" : "bg-ink text-on-ink"}`}>
        {playing ? <Pause className="size-2.5 fill-current" /> : <Play className="ml-px size-2.5 fill-current" />}
      </span>
      <span className="truncate font-medium">{label}</span>
      <span className={inverse ? "text-white/65" : "text-fg-faint"}>{durationLabel(media.durationMs)}</span>
      <span className={`truncate ${failed ? "text-danger" : inverse ? "text-white/65" : "text-fg-faint"}`}>{state}</span>
    </button>
  );
}

function ConversationRow({ conversation, selected, locale, onOpen }: {
  conversation: ConversationTraceSummary;
  selected: boolean;
  locale: UiLocale;
  onOpen(): void;
}) {
  const t = useT();
  const version = conversation.agentSource === "published"
    ? `v${conversation.agentVersion ?? "—"}`
    : `revision ${conversation.agentRevision ?? "—"}`;
  return (
    <button onClick={onOpen} className={`flex w-full items-center gap-3 border-b border-edge-faint px-4 py-3.5 text-left transition last:border-b-0 hover:bg-fill-hover ${selected ? "bg-fill-active" : "bg-canvas"}`}>
      <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-fill-faint text-fg-muted"><Clock3 className="size-4" /></span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2"><span className="truncate text-[11px] font-medium">{timeLabel(conversation.startedAt, locale)}</span><span className={`rounded-full px-2 py-0.5 text-[8px] font-medium ${outcomeTone[conversation.outcome]}`}>{t(outcomeKeys[conversation.outcome])}</span></span>
        <span className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[9px] text-fg-faint"><span>{version}</span><span>{durationLabel(conversation.durationMs)}</span><span>{t("{count} 轮", { count: conversation.turnCount })}</span></span>
        <span className="mt-1 block truncate font-mono text-[8px] text-fg-faint">{conversation.id}</span>
      </span>
      <ChevronRight className="size-3.5 shrink-0 text-fg-faint" />
    </button>
  );
}

function EventSummary({ event, startedAt }: { event: ConversationTraceEvent; startedAt: number }) {
  const t = useT();
  const detail = event.type.startsWith("tool.") && event.name ? event.name
    : event.type === "error" ? event.code
      : event.type === "session.state" ? `${event.previous ?? "—"} → ${event.state ?? "—"}`
        : event.type === "command.rejected" ? event.reason
          : undefined;
  return (
    <details className="group border-b border-edge-faint py-2.5 last:border-b-0">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[10px]">
        <span className="w-14 shrink-0 font-mono text-[8px] text-fg-faint">+{durationLabel(event.timestampMs - startedAt)}</span>
        <span className="min-w-0 flex-1 truncate font-medium text-fg-secondary">{event.type}</span>
        {detail ? <span className="max-w-[42%] truncate text-[9px] text-fg-faint">{detail}</span> : null}
        <ChevronRight className="size-3 shrink-0 text-fg-faint transition group-open:rotate-90" />
      </summary>
      <pre className="mt-2 max-h-56 overflow-auto rounded-lg bg-fill-faint p-3 font-mono text-[8px] leading-4 text-fg-muted">{JSON.stringify(event, null, 2)}</pre>
    </details>
  );
}

function ConversationDetail({ agentId, conversation, locale, deleting, onClose, onDelete }: {
  agentId: string;
  conversation: ConversationTraceDetail;
  locale: UiLocale;
  deleting: boolean;
  onClose(): void;
  onDelete(): void;
}) {
  const t = useT();
  const turns = conversationTurns(conversation.events, conversation.media);
  const tools = conversation.events.filter(event => event.type === "tool.call" || event.type === "tool.result" || event.type === "tool.pending");
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const loadedMediaIdRef = useRef<string | undefined>(undefined);
  const [playingMediaId, setPlayingMediaId] = useState<string>();
  const [failedMediaId, setFailedMediaId] = useState<string>();

  useEffect(() => () => {
    audioRef.current?.pause();
    audioRef.current = null;
    loadedMediaIdRef.current = undefined;
  }, [conversation.id]);

  const toggleAudio = async (media: ConversationMediaDescriptor) => {
    if (loadedMediaIdRef.current === media.id && audioRef.current) {
      if (playingMediaId === media.id) {
        audioRef.current.pause();
        return;
      }
      if (audioRef.current.ended) audioRef.current.currentTime = 0;
      setFailedMediaId(undefined);
      setPlayingMediaId(media.id);
      try {
        await audioRef.current.play();
      } catch {
        setPlayingMediaId(undefined);
        setFailedMediaId(media.id);
      }
      return;
    }
    audioRef.current?.pause();
    const audio = new Audio(agentConversationMediaUrl(agentId, conversation.id, media.id));
    audio.preload = "none";
    audio.onended = () => setPlayingMediaId(current => current === media.id ? undefined : current);
    audio.onpause = () => setPlayingMediaId(current => current === media.id ? undefined : current);
    audio.onerror = () => {
      if (audioRef.current === audio) {
        audioRef.current = null;
        loadedMediaIdRef.current = undefined;
      }
      setPlayingMediaId(current => current === media.id ? undefined : current);
      setFailedMediaId(media.id);
    };
    audioRef.current = audio;
    loadedMediaIdRef.current = media.id;
    setFailedMediaId(undefined);
    setPlayingMediaId(media.id);
    try {
      await audio.play();
    } catch {
      if (audioRef.current === audio) {
        audioRef.current = null;
        loadedMediaIdRef.current = undefined;
      }
      setPlayingMediaId(current => current === media.id ? undefined : current);
      setFailedMediaId(media.id);
    }
  };

  return (
    <aside className="fixed inset-0 z-40 flex min-h-0 flex-col overflow-hidden bg-canvas lg:static lg:z-auto lg:min-h-[600px] lg:rounded-2xl lg:border lg:border-edge">
      <header className="flex items-start gap-3 border-b border-edge-faint px-4 py-4 sm:px-5">
        <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><h2 className="text-[12px] font-semibold">{t("会话详情")}</h2><span className={`rounded-full px-2 py-0.5 text-[8px] font-medium ${outcomeTone[conversation.outcome]}`}>{t(outcomeKeys[conversation.outcome])}</span></div><p className="mt-1 truncate font-mono text-[8px] text-fg-faint">{conversation.id}</p></div>
        <button onClick={onDelete} disabled={deleting} aria-label={t("删除会话")} className="flex size-8 items-center justify-center rounded-lg text-fg-muted hover:bg-danger-surface hover:text-danger disabled:opacity-40">{deleting ? <LoaderCircle className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}</button>
        <button onClick={onClose} aria-label={t("关闭")} className="flex size-8 items-center justify-center rounded-lg text-fg-muted hover:bg-fill-hover lg:hidden"><X className="size-4" /></button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5">
        <dl className="grid grid-cols-2 gap-3 rounded-xl bg-fill-faint p-3 text-[9px] sm:grid-cols-4">
          <div><dt className="text-fg-faint">{t("开始时间")}</dt><dd className="mt-1 font-medium text-fg-secondary">{timeLabel(conversation.startedAt, locale)}</dd></div>
          <div><dt className="text-fg-faint">{t("持续时间")}</dt><dd className="mt-1 font-medium text-fg-secondary">{durationLabel(conversation.durationMs)}</dd></div>
          <div><dt className="text-fg-faint">{t("运行版本")}</dt><dd className="mt-1 font-medium text-fg-secondary">{conversation.agentSource === "published" ? `v${conversation.agentVersion}` : `revision ${conversation.agentRevision}`}</dd></div>
          <div><dt className="text-fg-faint">{t("对话轮次")}</dt><dd className="mt-1 font-medium text-fg-secondary">{conversation.turnCount}</dd></div>
        </dl>

        <section className="mt-5"><h3 className="text-[11px] font-semibold">{t("逐轮对话")}</h3>{conversation.contentRetained || conversation.media.length > 0 ? (
          turns.length > 0 ? <div className="mt-3 space-y-4">{turns.map(turn => <div key={`${turn.id}:${turn.revision}`} className="space-y-2">
            {(turn.transcript !== undefined || turn.inputMedia) ? <div className="ml-auto w-fit max-w-[88%] rounded-2xl rounded-br-md bg-ink px-3 py-2 text-[10px] leading-5 text-on-ink">
              <p>{turn.transcript ?? t("无用户转写")}</p>
              {turn.inputMedia ? <RetainedAudio media={turn.inputMedia} inverse playing={playingMediaId === turn.inputMedia.id} failed={failedMediaId === turn.inputMedia.id} onToggle={() => void toggleAudio(turn.inputMedia!)} /> : null}
            </div> : null}
            {(turn.reply !== undefined || turn.outputMedia) ? <div className={`w-fit max-w-[92%] rounded-2xl rounded-bl-md border border-edge bg-surface px-3 py-2 text-[10px] leading-5 ${turn.interrupted ? "opacity-60" : ""}`}>
              {turn.reply ? <p>{turn.reply}</p> : null}
              {turn.outputMedia ? <RetainedAudio media={turn.outputMedia} playing={playingMediaId === turn.outputMedia.id} failed={failedMediaId === turn.outputMedia.id} onToggle={() => void toggleAudio(turn.outputMedia!)} /> : null}
            </div> : null}
          </div>)}</div>
            : <p className="mt-3 text-[10px] text-fg-faint">{t("这个会话没有可显示的对话内容。")}</p>
        ) : <div className="mt-3 flex items-start gap-2 rounded-xl border border-dashed border-edge px-3 py-3 text-[10px] leading-5 text-fg-muted"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{t("此部署只保留元数据，因此无法显示转写和回答。")}</div>}</section>

        {tools.length > 0 ? <section className="mt-5"><h3 className="flex items-center gap-2 text-[11px] font-semibold"><Wrench className="size-3.5" />{t("工具活动")}</h3><div className="mt-2 rounded-xl border border-edge px-3">{tools.map(event => <EventSummary key={event.sequence} event={event} startedAt={conversation.startedAt} />)}</div></section> : null}

        <section className="mt-5"><h3 className="text-[11px] font-semibold">{t("协议事件")}</h3><div className="mt-2 rounded-xl border border-edge px-3">{conversation.events.map(event => <EventSummary key={event.sequence} event={event} startedAt={conversation.startedAt} />)}</div></section>
      </div>
    </aside>
  );
}

export function AgentConversations({ agentId }: { agentId: string }) {
  const t = useT();
  const locale = resolveLocale(useI18n(state => state.locale));
  const toast = useStudio(state => state.toast);
  const [conversations, setConversations] = useState<ConversationTraceSummary[]>([]);
  const [policy, setPolicy] = useState<ConversationTracePolicy>({
    enabled: true, content: false, audio: false,
    inputAudio: false, outputAudio: false, maxBytes: null,
  });
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");
  const [query, setQuery] = useState("");
  const [serverQuery, setServerQuery] = useState("");
  const [outcome, setOutcome] = useState<ConversationOutcome | "">("");
  const [selected, setSelected] = useState<ConversationTraceDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const loadGeneration = useRef(0);

  const load = useCallback(async (signal?: AbortSignal) => {
    const generation = ++loadGeneration.current;
    setLoading(true); setFailure("");
    try {
      const result = await listAgentConversations(agentId, {
        ...(outcome ? { outcome } : {}),
        ...(serverQuery ? { query: serverQuery } : {}),
        limit: 200,
        ...(signal === undefined ? {} : { signal }),
      });
      if (generation !== loadGeneration.current) return;
      setConversations(result.conversations); setPolicy(result.policy);
      setSelected(current => current && !result.conversations.some(item => item.id === current.id) ? undefined : current);
    } catch (error) {
      if (signal?.aborted || generation !== loadGeneration.current) return;
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      if (generation === loadGeneration.current) setLoading(false);
    }
  }, [agentId, outcome, serverQuery]);

  useEffect(() => {
    const timer = setTimeout(() => setServerQuery(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  useEffect(() => {
    setConversations([]);
    setSelected(undefined);
    setQuery("");
    setServerQuery("");
  }, [agentId]);

  const open = async (summary: ConversationTraceSummary) => {
    setDetailLoading(true);
    try {
      const result = await getAgentConversation(agentId, summary.id);
      setSelected(result.conversation);
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    } finally { setDetailLoading(false); }
  };

  const remove = async () => {
    if (!selected || !window.confirm(t("确定删除这条会话记录？此操作不可撤销。"))) return;
    setDeleting(true);
    try {
      await deleteAgentConversation(agentId, selected.id);
      setSelected(undefined);
      await load();
      toast("info", t("会话已删除"));
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    } finally { setDeleting(false); }
  };

  if (loading && conversations.length === 0) return <div className="flex min-h-[420px] items-center justify-center"><LoaderCircle className="size-5 animate-spin text-fg-faint" /></div>;
  if (failure) return <div className="flex min-h-[360px] flex-col items-center justify-center gap-3 text-center"><AlertTriangle className="size-5 text-danger" /><p className="text-[11px] text-danger">{failure}</p><button onClick={() => void load()} className={secondaryButton}><RefreshCw className="size-3.5" />{t("重试")}</button></div>;
  if (!policy.enabled) return <PolicyBanner policy={policy} />;

  return (
    <div className="space-y-4">
      <PolicyBanner policy={policy} />
      <section className="overflow-hidden rounded-2xl border border-edge bg-canvas">
        <header className="flex flex-col gap-3 border-b border-edge-faint px-4 py-4 sm:flex-row sm:items-center sm:px-5">
          <div className="min-w-0 flex-1"><h2 className="text-[13px] font-semibold">{t("会话记录")}</h2><p className="mt-1 text-[10px] text-fg-muted">{t("查看这个助手实际运行过的版本、结果和协议事件。")}</p></div>
          <div className="flex gap-2">
            <label className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-edge bg-surface px-3 sm:w-56"><Search className="size-3.5 shrink-0 text-fg-faint" /><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t("搜索会话 ID")} className="min-w-0 flex-1 bg-transparent text-[10px] outline-none placeholder:text-fg-faint" /></label>
            <select value={outcome} onChange={event => setOutcome(event.target.value as ConversationOutcome | "")} className="h-9 rounded-lg border border-edge bg-surface px-2 text-[10px] text-fg-secondary outline-none"><option value="">{t("全部状态")}</option>{(Object.keys(outcomeKeys) as ConversationOutcome[]).map(value => <option key={value} value={value}>{t(outcomeKeys[value])}</option>)}</select>
            <button onClick={() => void load()} aria-label={t("刷新")} className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-edge text-fg-muted hover:bg-fill-hover"><RefreshCw className={`size-3.5 ${loading ? "animate-spin" : ""}`} /></button>
          </div>
        </header>
        <div className="grid min-h-[520px] lg:grid-cols-[minmax(0,0.9fr)_minmax(390px,1.1fr)]">
          <div className="min-w-0 border-edge lg:border-r">
            {conversations.length === 0 ? <div className="flex min-h-[360px] flex-col items-center justify-center px-6 text-center"><FileClock className="size-6 text-fg-faint" /><p className="mt-3 text-[11px] font-medium">{query || outcome ? t("没有符合筛选条件的会话") : t("还没有会话记录")}</p><p className="mt-1 text-[10px] leading-5 text-fg-faint">{t("通过实时试用或部署接口运行这个助手后，记录会出现在这里。")}</p></div> : conversations.map(item => <ConversationRow key={item.id} conversation={item} selected={selected?.id === item.id} locale={locale} onOpen={() => void open(item)} />)}
          </div>
          <div className="hidden min-w-0 bg-surface/35 lg:block">{detailLoading ? <div className="flex h-full items-center justify-center"><LoaderCircle className="size-5 animate-spin text-fg-faint" /></div> : selected ? <ConversationDetail agentId={agentId} conversation={selected} locale={locale} deleting={deleting} onClose={() => setSelected(undefined)} onDelete={() => void remove()} /> : <div className="flex h-full min-h-[520px] flex-col items-center justify-center text-center"><Clock3 className="size-6 text-fg-faint" /><p className="mt-3 text-[10px] text-fg-muted">{t("选择一条会话查看详情")}</p></div>}</div>
        </div>
      </section>
      <div className="lg:hidden">{detailLoading ? <div className="fixed inset-0 z-40 flex items-center justify-center bg-canvas"><LoaderCircle className="size-5 animate-spin text-fg-faint" /></div> : selected ? <ConversationDetail agentId={agentId} conversation={selected} locale={locale} deleting={deleting} onClose={() => setSelected(undefined)} onDelete={() => void remove()} /> : null}</div>
    </div>
  );
}
