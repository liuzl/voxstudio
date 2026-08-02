import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Bot,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  ChevronDown,
  CircleStop,
  Copy,
  Headphones,
  LoaderCircle,
  Mic,
  MicOff,
  MoreHorizontal,
  Plus,
  RotateCw,
  Search,
  Send,
  Sparkles,
  Trash2,
  TrendingUp,
  UserRoundSearch,
  Volume2,
} from "lucide-react";
import { PageHeader, pageShellClass, primaryButton, secondaryButton } from "../components/StudioPage";
import { conversationControls, startConversation, stopConversation } from "../conversation";
import { resolveLocale, useI18n, useT, type MessageKey, type UiLocale } from "../i18n";
import {
  auditAgent,
  createAgent,
  deleteAgent,
  getAgent,
  listAgents,
  listVoices,
  publishAgent,
  updateAgent,
  type AgentAudit,
  type AgentRecord,
  type AgentSpec,
  type VoiceEntry,
} from "../lib/api";
import type { ConnectionState } from "../lib/client";
import { useStudio } from "../store";

const templates = [
  {
    name: "客服助手",
    description: "解决客户问题",
    icon: Headphones,
    color: "bg-[#fff1e8] text-[#ee6d32] dark:bg-[#33221a] dark:text-[#f0925c]",
    spec: {
      instructions: "你是一名耐心、准确的客户支持助手。先理解问题，再给出清晰可执行的解决方案。",
      welcome: "你好，我是客服助手。今天有什么可以帮你？",
    },
    specEn: {
      instructions: "You are a patient, accurate customer support agent. Understand the issue first, then provide a clear, actionable solution. Reply in the user's language.",
      welcome: "Hello, I'm your customer support agent. How can I help today?",
    },
  },
  {
    name: "销售顾问",
    description: "推动客户完成购买",
    icon: TrendingUp,
    color: "bg-[#eaf7ee] text-[#39915a] dark:bg-[#1a2b20] dark:text-[#5cba7d]",
    spec: {
      instructions: "你是一名专业但不强迫推销的销售顾问。通过提问理解需求，并提供诚实、具体的建议。",
      welcome: "你好，很高兴认识你。想先了解一下你正在寻找什么？",
    },
    specEn: {
      instructions: "You are a professional sales advisor who never pressures the customer. Ask questions to understand their needs, then offer honest, specific recommendations. Reply in the user's language.",
      welcome: "Hello, it's great to meet you. What are you looking for today?",
    },
  },
  {
    name: "预约助理",
    description: "安排和管理预约",
    icon: CalendarDays,
    color: "bg-[#fff4d8] text-[#bd8514] dark:bg-[#2e2718] dark:text-[#d8a437]",
    spec: {
      instructions: "你负责帮助用户安排预约。确认日期、时间、时区和必要的联系信息，并在提交前复述确认。",
      welcome: "你好，我可以帮你安排预约。你希望预约什么时间？",
    },
    specEn: {
      instructions: "Help the user schedule appointments. Confirm the date, time, time zone, and required contact details, then repeat the details before submitting. Reply in the user's language.",
      welcome: "Hello, I can help schedule your appointment. What time works for you?",
    },
  },
  {
    name: "个人助理",
    description: "协助处理日常事务",
    icon: BriefcaseBusiness,
    color: "bg-[#f1ebff] text-[#7d55c7] dark:bg-[#251d33] dark:text-[#a685e0]",
    spec: {
      instructions: "你是一名高效、简洁的个人助理。把复杂任务拆解为清晰的下一步，并主动确认关键约束。",
      welcome: "你好，我已经准备好了。我们先处理哪件事？",
    },
    specEn: {
      instructions: "You are an efficient, concise personal assistant. Break complex tasks into clear next steps and proactively confirm important constraints. Reply in the user's language.",
      welcome: "Hello, I'm ready. What should we work on first?",
    },
  },
  {
    name: "线索筛选",
    description: "筛选和跟进入站线索",
    icon: UserRoundSearch,
    color: "bg-[#e9f1ff] text-[#4c77c6] dark:bg-[#1a2333] dark:text-[#7ba1e0]",
    spec: {
      instructions: "你负责初步了解潜在客户的场景、需求、预算和时间表。保持自然对话，不要像问卷一样连续追问。",
      welcome: "你好，我想快速了解一下你的需求，方便我们安排最合适的下一步。",
    },
    specEn: {
      instructions: "Qualify potential customers by learning about their situation, needs, budget, and timeline. Keep the conversation natural instead of asking a rigid sequence of questions. Reply in the user's language.",
      welcome: "Hello, I'd like to understand your needs so we can recommend the best next step.",
    },
  },
] as const;

type Template = (typeof templates)[number];

function avatarStyle(id: string): React.CSSProperties {
  const hue = Array.from(id).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 80 + 235;
  return {
    background: `radial-gradient(circle at 68% 26%, hsl(${hue} 78% 82%) 0 5%, transparent 21%), radial-gradient(circle at 28% 70%, hsl(${hue} 46% 41%) 0 8%, transparent 34%), radial-gradient(circle at 72% 76%, hsl(${hue + 38} 32% 32%) 0 5%, transparent 28%), #101019`,
  };
}

const dateLocales: Record<UiLocale, string> = {
  zh: "zh-CN",
  en: "en",
  ja: "ja",
  ko: "ko",
  es: "es",
  fr: "fr",
  de: "de",
  pt: "pt-BR",
  ru: "ru",
  it: "it",
};

export function displayTime(value: string, locale: UiLocale): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return new Intl.DateTimeFormat(dateLocales[locale], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function agentSlug(value: string): string {
  const latin = value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return latin || `agent-${crypto.randomUUID().slice(0, 8)}`;
}

function AgentAvatar({ id, size = "size-7" }: { id: string; size?: string }) {
  return <span aria-hidden className={`${size} shrink-0 rounded-full border border-black/10 shadow-[inset_0_0_8px_rgba(255,255,255,0.22)] dark:border-white/15`} style={avatarStyle(id)} />;
}

interface AgentsPanelProps {
  agentId?: string | undefined;
  onOpenAgent(id: string): void;
  onCloseAgent(): void;
  onDirtyChange(dirty: boolean): void;
}

export function AgentsPanel({ agentId, onOpenAgent, onCloseAgent, onDirtyChange }: AgentsPanelProps) {
  if (agentId) return <AgentBuilder agentId={agentId} onClose={onCloseAgent} onDirtyChange={onDirtyChange} />;
  return <AgentList onOpenAgent={onOpenAgent} />;
}

function AgentList({ onOpenAgent }: { onOpenAgent(id: string): void }) {
  const t = useT();
  const locale = resolveLocale(useI18n(state => state.locale));
  const toast = useStudio(state => state.toast);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");
  const [query, setQuery] = useState("");
  const [createMenuOpen, setCreateMenuOpen] = useState(false);
  const [createTemplate, setCreateTemplate] = useState<Template | null | undefined>(undefined);
  const [actionsId, setActionsId] = useState<string>();
  const menuRef = useRef<HTMLDivElement>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setFailure("");
    try {
      setAgents(await listAgents());
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setCreateMenuOpen(false);
      if (!(event.target as Element).closest?.("[data-agent-actions]")) setActionsId(undefined);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return needle ? agents.filter(agent => `${agent.name} ${agent.description ?? ""} ${agent.id}`.toLocaleLowerCase().includes(needle)) : agents;
  }, [agents, query]);

  const openCreate = (template: Template | null) => {
    setCreateMenuOpen(false);
    setCreateTemplate(template);
  };

  const remove = async (agent: AgentRecord) => {
    if (!window.confirm(`${t("删除助手")} “${agent.name}”？`)) return;
    try {
      await deleteAgent(agent.id, agent.revision);
      setAgents(current => current.filter(item => item.id !== agent.id));
      toast("info", t("已从列表移除助手"));
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <div className={pageShellClass}>
      <PageHeader
        title={t("语音助手")}
        description={t("创建、配置和测试实时语音助手。")}
        badge={<span className="rounded-full border border-accent-edge bg-accent-surface px-2 py-0.5 text-[10px] font-medium text-accent-deep">Beta</span>}
      />

      <div className="mt-8 flex items-center gap-3 sm:justify-between">
        <label className="relative min-w-0 flex-1 sm:max-w-[300px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-faint" strokeWidth={1.8} />
          <input value={query} onChange={event => setQuery(event.target.value)} placeholder={t("搜索助手")} className="h-10 w-full rounded-lg border border-edge bg-surface pl-9 pr-3 text-[13px] text-fg placeholder:text-fg-faint" />
        </label>
        <div ref={menuRef} className="relative flex shrink-0">
          <button onClick={() => openCreate(null)} className="inline-flex h-10 items-center gap-2 rounded-l-full bg-ink px-5 text-[13px] font-medium text-on-ink hover:bg-ink-hover">
            <Plus className="size-4" /><span className="hidden sm:inline">{t("创建助手")}</span><span className="sm:hidden">{t("创建")}</span>
          </button>
          <button aria-label={t("显示模板")} aria-expanded={createMenuOpen} onClick={() => setCreateMenuOpen(open => !open)} className="flex h-10 w-10 items-center justify-center rounded-r-full border-l border-white/20 bg-ink text-on-ink hover:bg-ink-hover">
            <ChevronDown className={`size-3.5 transition-transform ${createMenuOpen ? "rotate-180" : ""}`} />
          </button>
          {createMenuOpen && (
            <div className="absolute right-0 top-12 z-30 w-[310px] rounded-xl border border-edge bg-canvas p-1.5 shadow-[0_16px_50px_rgba(0,0,0,0.14)]">
              <button onClick={() => openCreate(null)} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-fill-hover">
                <span className="flex size-8 items-center justify-center rounded-full bg-fill-active"><Sparkles className="size-4" /></span>
                <span><span className="block text-[13px] font-medium">{t("空白助手")}</span><span className="text-[11px] text-fg-faint">{t("从零开始")}</span></span>
              </button>
              <div className="mx-2 my-1.5 border-t border-edge-faint" />
              {templates.map(template => <TemplateMenuItem key={template.name} template={template} onClick={() => openCreate(template)} />)}
            </div>
          )}
        </div>
      </div>

      <div className="mt-8 overflow-visible">
        <div className="grid grid-cols-[minmax(0,1fr)_150px_48px] items-center border-b border-edge px-2 pb-2 text-[11px] text-fg-faint sm:grid-cols-[54%_minmax(0,1fr)_48px]">
          <span>{t("助手")}</span><span>{t("更新时间")}</span><span />
        </div>
        {loading ? (
          <div className="flex min-h-32 items-center justify-center text-fg-faint"><LoaderCircle className="size-5 animate-spin" /></div>
        ) : failure ? (
          <div className="flex min-h-32 flex-col items-center justify-center gap-3 text-center text-[12px] text-danger"><span>{failure}</span><button onClick={() => void reload()} className={secondaryButton}><RotateCw className="size-3.5" />{t("刷新")}</button></div>
        ) : filtered.length === 0 ? (
          <div className="flex min-h-32 flex-col items-center justify-center gap-3 border-b border-edge-faint text-[12px] text-fg-faint">
            <Bot className="size-6" strokeWidth={1.5} />
            <span>{query ? t("没有匹配的助手。") : t("还没有助手。")}</span>
          </div>
        ) : filtered.map(agent => (
          <div key={agent.id} onClick={() => onOpenAgent(agent.id)} className="group grid min-h-[62px] cursor-pointer grid-cols-[minmax(0,1fr)_150px_48px] items-center border-b border-edge-faint px-2 transition hover:bg-fill-faint sm:grid-cols-[54%_minmax(0,1fr)_48px]">
            <span className="flex min-w-0 items-center gap-3">
              <AgentAvatar id={agent.id} />
              <span className="min-w-0"><span className="block truncate text-[13px] font-medium text-fg">{agent.name}</span><span className="mt-0.5 block truncate text-[10px] text-fg-faint">{agent.id}</span></span>
              {agent.published ? <span className="hidden rounded-full bg-emerald-50 px-2 py-0.5 text-[9px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300 sm:inline">v{agent.published.version}</span> : <span className="hidden rounded-full bg-fill-active px-2 py-0.5 text-[9px] text-fg-muted sm:inline">{t("草稿")}</span>}
            </span>
            <span className="text-[11px] text-fg-muted">{displayTime(agent.updatedAt, locale)}</span>
            <span data-agent-actions className="relative justify-self-end">
              <button aria-label={t("助手操作")} onClick={event => { event.stopPropagation(); setActionsId(current => current === agent.id ? undefined : agent.id); }} className="flex size-8 items-center justify-center rounded-lg text-fg-muted opacity-70 hover:bg-fill-active hover:text-fg group-hover:opacity-100"><MoreHorizontal className="size-4.5" /></button>
              {actionsId === agent.id && (
                <div className="absolute right-0 top-9 z-20 w-44 rounded-xl border border-edge bg-canvas p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.12)]">
                  <button onClick={event => { event.stopPropagation(); void navigator.clipboard?.writeText(agent.id); setActionsId(undefined); toast("info", t("已复制助手 ID")); }} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12px] hover:bg-fill-hover"><Copy className="size-3.5 text-fg-muted" />{t("复制助手 ID")}</button>
                  <button onClick={event => { event.stopPropagation(); setActionsId(undefined); void remove(agent); }} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12px] text-danger hover:bg-danger-surface"><Trash2 className="size-3.5" />{t("删除助手")}</button>
                </div>
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-5 flex gap-2.5 overflow-x-auto pb-2">
        {templates.map(template => {
          const Icon = template.icon;
          return <button key={template.name} onClick={() => openCreate(template)} className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-edge-strong bg-canvas py-1 pl-1 pr-4 text-[12px] font-medium hover:bg-fill-faint"><span className={`flex size-8 items-center justify-center rounded-full ${template.color}`}><Icon className="size-4" /></span>{t(template.name)}</button>;
        })}
        <button onClick={() => openCreate(null)} className="inline-flex h-10 shrink-0 items-center gap-2 rounded-full border border-edge-strong px-4 text-[12px] font-medium hover:bg-fill-faint"><Plus className="size-4" />{t("从零开始")}</button>
      </div>

      {createTemplate !== undefined && <CreateAgentDialog template={createTemplate} onClose={() => setCreateTemplate(undefined)} onCreated={agent => { setAgents(current => [agent, ...current]); setCreateTemplate(undefined); onOpenAgent(agent.id); }} />}
    </div>
  );
}

function TemplateMenuItem({ template, onClick }: { template: Template; onClick(): void }) {
  const t = useT();
  const Icon = template.icon;
  return <button onClick={onClick} className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-fill-hover"><span className={`flex size-8 items-center justify-center rounded-full ${template.color}`}><Icon className="size-4" /></span><span><span className="block text-[13px] font-medium">{t(template.name)}</span><span className="text-[11px] text-fg-faint">{t(template.description)}</span></span></button>;
}

function CreateAgentDialog({ template, onClose, onCreated }: { template: Template | null; onClose(): void; onCreated(agent: AgentRecord): void }) {
  const t = useT();
  const locale = resolveLocale(useI18n(state => state.locale));
  const [name, setName] = useState(template ? t(template.name) : "");
  const [id, setId] = useState(() => template ? agentSlug(t(template.name)) : "");
  const [idTouched, setIdTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState("");

  const submit = async () => {
    const cleanName = name.trim();
    const cleanId = id.trim();
    if (!cleanName || !cleanId) return;
    setSaving(true); setFailure("");
    try {
      const localizedSpec = template ? (locale === "zh" ? template.spec : template.specEn) : undefined;
      const templateLanguage = (["zh", "en", "ja", "ko"] as const).find(language => language === locale) ?? "auto";
      onCreated(await createAgent({ id: cleanId, name: cleanName, ...(template && localizedSpec ? { description: t(template.description), spec: { ...localizedSpec, language: templateLanguage } } : {}) }));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 px-4 backdrop-blur-[2px]" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <div role="dialog" aria-modal="true" className="w-full max-w-[430px] rounded-2xl border border-edge bg-canvas p-6 shadow-[0_24px_80px_rgba(0,0,0,0.18)]">
        <div className="flex items-start gap-3"><span className="flex size-10 items-center justify-center rounded-xl bg-ink text-on-ink"><Bot className="size-5" /></span><div><h2 className="text-[17px] font-semibold tracking-[-0.02em]">{t("创建助手")}</h2><p className="mt-1 text-[12px] text-fg-muted">{template ? t("已载入「{name}」模板", { name: t(template.name) }) : t("从零开始")}</p></div></div>
        <label className="mt-6 block text-[11px] font-medium text-fg-secondary">{t("名称")}</label>
        <input autoFocus value={name} onChange={event => { setName(event.target.value); if (!idTouched) setId(agentSlug(event.target.value)); }} className="mt-2 h-10 w-full rounded-lg border border-edge-strong bg-surface px-3 text-[13px]" />
        <label className="mt-4 block text-[11px] font-medium text-fg-secondary">Agent ID</label>
        <input value={id} onChange={event => { setIdTouched(true); setId(event.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, "-")); }} placeholder="customer-support" className="mt-2 h-10 w-full rounded-lg border border-edge-strong bg-surface px-3 font-mono text-[12px]" />
        {failure && <p className="mt-3 text-[11px] leading-5 text-danger">{failure}</p>}
        <div className="mt-6 flex justify-end gap-2"><button onClick={onClose} disabled={saving} className={secondaryButton}>{t("取消")}</button><button onClick={() => void submit()} disabled={saving || !name.trim() || !id.trim()} className={primaryButton}>{saving ? <LoaderCircle className="size-4 animate-spin" /> : <Plus className="size-4" />}{t("创建助手")}</button></div>
      </div>
    </div>
  );
}

interface AgentDraft {
  name: string;
  description: string;
  instructions: string;
  welcome: string;
  language: string;
  voice: string;
  ttsEngine: string;
  nudgeAfterSeconds: string;
  maxSessionSeconds: string;
  studioTools: boolean;
}

function draftFrom(record: AgentRecord): AgentDraft {
  return {
    name: record.name,
    description: record.description ?? "",
    instructions: record.spec.instructions ?? "",
    welcome: record.spec.welcome ?? "",
    language: record.spec.language ?? "auto",
    voice: record.spec.voice ?? "",
    ttsEngine: record.spec.ttsEngine ?? "",
    nudgeAfterSeconds: record.spec.nudgeAfterSeconds === undefined ? "" : String(record.spec.nudgeAfterSeconds),
    maxSessionSeconds: record.spec.maxSessionSeconds === undefined ? "" : String(record.spec.maxSessionSeconds),
    studioTools: record.spec.studioTools ?? false,
  };
}

function specFrom(draft: AgentDraft, prior: AgentSpec): AgentSpec {
  const nudge = Number(draft.nudgeAfterSeconds);
  const maxSession = Number(draft.maxSessionSeconds);
  const spec: AgentSpec = {
    ...prior,
    instructions: draft.instructions,
    welcome: draft.welcome,
    language: draft.language || "auto",
    studioTools: draft.studioTools,
  };
  if (draft.voice) spec.voice = draft.voice;
  else delete spec.voice;
  if (draft.ttsEngine) spec.ttsEngine = draft.ttsEngine;
  else delete spec.ttsEngine;
  if (draft.nudgeAfterSeconds && Number.isFinite(nudge) && nudge >= 0) spec.nudgeAfterSeconds = nudge;
  else delete spec.nudgeAfterSeconds;
  if (draft.maxSessionSeconds && Number.isFinite(maxSession) && maxSession > 0) spec.maxSessionSeconds = maxSession;
  else delete spec.maxSessionSeconds;
  return spec;
}

function AgentBuilder({ agentId, onClose, onDirtyChange }: { agentId: string; onClose(): void; onDirtyChange(dirty: boolean): void }) {
  const t = useT();
  const toast = useStudio(state => state.toast);
  const [record, setRecord] = useState<AgentRecord>();
  const [draft, setDraft] = useState<AgentDraft>();
  const [voices, setVoices] = useState<VoiceEntry[]>([]);
  const [audit, setAudit] = useState<AgentAudit>();
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true); setFailure("");
    setRecord(undefined); setDraft(undefined); setAudit(undefined);
    try {
      const [next, voiceBank, nextAudit] = await Promise.all([getAgent(agentId), listVoices().catch(() => []), auditAgent(agentId).catch(() => undefined)]);
      if (generation !== loadGeneration.current) return;
      setRecord(next); setDraft(draftFrom(next)); setVoices(voiceBank);
      setAudit(nextAudit);
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      setFailure(error instanceof Error ? error.message : String(error));
    } finally { if (generation === loadGeneration.current) setLoading(false); }
  }, [agentId]);

  useEffect(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]);
  const dirty = useMemo(() => Boolean(record && draft && JSON.stringify(draft) !== JSON.stringify(draftFrom(record))), [record, draft]);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  const save = async (): Promise<AgentRecord | undefined> => {
    if (!record || !draft) return undefined;
    if (!dirty) return record;
    setSaving(true);
    try {
      const next = await updateAgent(record.id, record.revision, {
        name: draft.name.trim(),
        description: draft.description.trim() || null,
        spec: specFrom(draft, record.spec),
      });
      setRecord(next); setDraft(draftFrom(next));
      setAudit(await auditAgent(agentId).catch(() => undefined));
      toast("info", t("助手已保存"));
      return next;
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
      return undefined;
    } finally { setSaving(false); }
  };

  const publish = async () => {
    setPublishing(true);
    try {
      const saved = await save();
      if (!saved) return;
      const result = await publishAgent(saved.id, saved.revision);
      setRecord(result.record); setDraft(draftFrom(result.record));
      setAudit({ status: "current", draftHash: result.version.hash, publishedHash: result.version.hash, version: result.version.version });
      toast("info", `${t("发布")} v${result.version.version}`);
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    } finally { setPublishing(false); }
  };

  if (loading) return <div className="flex h-full items-center justify-center"><LoaderCircle className="size-6 animate-spin text-fg-faint" /></div>;
  if (!record || !draft) return <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center text-[13px] text-danger"><span>{failure || t("获取助手")}</span><div className="flex gap-2"><button onClick={onClose} className={secondaryButton}><ArrowLeft className="size-4" />{t("助手")}</button><button onClick={() => void load()} className={secondaryButton}><RotateCw className="size-4" />{t("刷新")}</button></div></div>;

  return (
    <div className="min-h-full bg-surface/55">
      <div className="sticky top-0 z-20 border-b border-edge-faint bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex min-h-[66px] max-w-[1440px] items-center gap-3 px-4 sm:px-7 lg:px-10">
          <button onClick={onClose} aria-label={t("返回")} className="flex size-9 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-fill-hover hover:text-fg"><ArrowLeft className="size-[18px]" /></button>
          <AgentAvatar id={record.id} size="size-8" />
          <div className="min-w-0 flex-1"><div className="flex items-center gap-2"><span className="truncate text-[14px] font-semibold">{draft.name || record.id}</span>{record.published ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[9px] font-medium text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">v{record.published.version}</span> : <span className="rounded-full bg-fill-active px-2 py-0.5 text-[9px] text-fg-muted">{t("草稿")}</span>}</div><span className="block truncate font-mono text-[9px] text-fg-faint">{record.id}</span></div>
          <span className="hidden items-center gap-1.5 text-[10px] text-fg-faint sm:flex">{dirty ? <><span className="size-1.5 rounded-full bg-amber-400" />{t("有未保存的更改")}</> : <><Check className="size-3" />{t("已保存")}</>}</span>
          <button onClick={() => void save()} disabled={!dirty || saving || publishing} className={secondaryButton}>{saving ? <LoaderCircle className="size-4 animate-spin" /> : null}{t("保存")}</button>
          <button onClick={() => void publish()} disabled={saving || publishing || !draft.name.trim()} className={primaryButton}>{publishing ? <LoaderCircle className="size-4 animate-spin" /> : <Send className="size-3.5" />}{t("发布")}</button>
        </div>
      </div>

      <div className="mx-auto grid w-full max-w-[1440px] gap-5 px-4 py-6 sm:px-7 lg:px-10 xl:grid-cols-[minmax(0,1fr)_400px] xl:items-start">
        <div className="space-y-5">
          <BuilderSection icon={Bot} title={t("基本信息")} description={t("定义助手在工作台中的名称与用途。")}>
            <div className="grid gap-4 sm:grid-cols-2"><Field label={t("名称")}><input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} className="builder-input" /></Field><Field label="Agent ID" hint={t("创建后不可修改")}><input value={record.id} disabled className="builder-input font-mono opacity-60" /></Field></div>
            <Field label={t("描述")}><input value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} placeholder={t("简要说明这个助手负责什么") } className="builder-input" /></Field>
          </BuilderSection>

          <BuilderSection icon={Sparkles} title={t("行为")} description={t("用自然语言定义角色、目标和回答边界。")}>
            <Field label={t("系统提示词")} hint={`${draft.instructions.length} / 32768`}><textarea value={draft.instructions} onChange={event => setDraft({ ...draft, instructions: event.target.value })} placeholder={t("告诉助手它是谁、要完成什么，以及需要遵守哪些规则。") } rows={8} className="builder-input min-h-44 resize-y py-3 leading-6" /></Field>
            <Field label={t("开场白")} hint={t("会话开始时自动说出")}><textarea value={draft.welcome} onChange={event => setDraft({ ...draft, welcome: event.target.value })} placeholder={t("你好，有什么可以帮你？") } rows={3} className="builder-input resize-y py-3 leading-5" /></Field>
          </BuilderSection>

          <BuilderSection icon={Volume2} title={t("语音与会话")} description={t("选择输出音色并调整实时对话节奏。")}>
            <div className="grid gap-4 sm:grid-cols-2"><Field label={t("音色")}><VoiceSelect draft={draft} voices={voices} onChange={next => setDraft({ ...draft, ...next })} /></Field><Field label={t("语言")}><select value={draft.language} onChange={event => setDraft({ ...draft, language: event.target.value })} className="builder-input"><option value="auto">{t("自动")}</option><option value="zh">中文</option><option value="en">English</option><option value="ja">日本語</option><option value="ko">한국어</option></select></Field></div>
            <div className="grid gap-4 sm:grid-cols-2"><Field label={t("静默追问（秒）")} hint={t("留空表示关闭")}><input type="number" min="0" value={draft.nudgeAfterSeconds} onChange={event => setDraft({ ...draft, nudgeAfterSeconds: event.target.value })} placeholder="—" className="builder-input" /></Field><Field label={t("最长会话（秒）")} hint={t("部署上限仍然生效")}><input type="number" min="1" value={draft.maxSessionSeconds} onChange={event => setDraft({ ...draft, maxSessionSeconds: event.target.value })} placeholder="—" className="builder-input" /></Field></div>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-edge bg-surface p-4"><input type="checkbox" checked={draft.studioTools} onChange={event => setDraft({ ...draft, studioTools: event.target.checked })} className="mt-0.5 size-4 accent-black" /><span><span className="block text-[12px] font-medium">{t("工作台语音工具")}</span><span className="mt-1 block text-[11px] leading-5 text-fg-muted">{t("允许助手通过语音保存音色、重念和管理发音。")}</span></span></label>
          </BuilderSection>
        </div>

        <TryItLive record={record} dirty={dirty} onSave={save} audit={audit} />
      </div>
    </div>
  );
}

function BuilderSection({ icon: Icon, title, description, children }: { icon: typeof Bot; title: string; description: string; children: React.ReactNode }) {
  return <section className="rounded-2xl border border-edge bg-canvas shadow-[0_1px_2px_rgba(0,0,0,0.025)]"><header className="flex items-start gap-3 border-b border-edge-faint px-5 py-4 sm:px-6"><span className="flex size-8 items-center justify-center rounded-lg bg-fill-active text-fg-secondary"><Icon className="size-4" strokeWidth={1.8} /></span><span><h2 className="text-[13px] font-semibold">{title}</h2><p className="mt-1 text-[11px] text-fg-muted">{description}</p></span></header><div className="space-y-5 p-5 sm:p-6">{children}</div></section>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-2 flex items-center justify-between gap-3 text-[11px] font-medium text-fg-secondary"><span>{label}</span>{hint && <span className="font-normal text-fg-faint">{hint}</span>}</span>{children}</label>;
}

const voiceSeparator = "\u0000";

export function voiceOptionValue(voice: Pick<VoiceEntry, "id" | "engine">): string {
  return `${voice.engine ?? ""}${voiceSeparator}${voice.id}`;
}

export function voiceFromOption(value: string): { voice: string; ttsEngine: string } {
  if (!value) return { voice: "", ttsEngine: "" };
  const separator = value.indexOf(voiceSeparator);
  if (separator < 0) return { voice: value, ttsEngine: "" };
  return { ttsEngine: value.slice(0, separator), voice: value.slice(separator + 1) };
}

function VoiceSelect({ draft, voices, onChange }: { draft: AgentDraft; voices: VoiceEntry[]; onChange(value: { voice: string; ttsEngine: string }): void }) {
  const t = useT();
  const selected = draft.voice ? voiceOptionValue({ id: draft.voice, engine: draft.ttsEngine }) : "";
  const known = voices.some(voice => voiceOptionValue(voice) === selected);
  return (
    <select value={selected} onChange={event => onChange(voiceFromOption(event.target.value))} className="builder-input">
      <option value="">{t("自动")}</option>
      {draft.voice && !known ? <option value={selected}>{draft.voice}{draft.ttsEngine ? ` · ${draft.ttsEngine}` : ""}</option> : null}
      {voices.map(voice => <option key={`${voice.engine}:${voice.id}`} value={voiceOptionValue(voice)}>{voice.id}{voice.engine ? ` · ${voice.engine}` : ""}</option>)}
    </select>
  );
}

const previewSessionLabels: Record<string, MessageKey> = {
  listening: "聆听中",
  speech_started: "你在说话",
  finalizing: "断句中",
  thinking: "思考中",
  speaking: "回答中",
  closed: "已结束",
};

export function previewStatusLabel(connection: ConnectionState, sessionState: string): MessageKey {
  if (connection === "connecting") return "连接中";
  if (connection === "reconnecting" || connection === "disconnected") return "重连中";
  return previewSessionLabels[sessionState] ?? "聆听中";
}

function TryItLive({ record, dirty, onSave, audit }: { record: AgentRecord; dirty: boolean; onSave(): Promise<AgentRecord | undefined>; audit: AgentAudit | undefined }) {
  const t = useT();
  const active = useStudio(state => state.active);
  const connection = useStudio(state => state.connection);
  const sessionState = useStudio(state => state.sessionState);
  const turns = useStudio(state => state.turns);
  const muted = useStudio(state => state.muted);
  const micLevel = useStudio(state => state.micLevel);
  const clearHistory = useStudio(state => state.clearHistory);
  const toast = useStudio(state => state.toast);
  const [starting, setStarting] = useState(false);
  const [hasUnseen, setHasUnseen] = useState(false);
  const previewOwned = useRef(false);
  const previewStarting = useRef(false);
  const mounted = useRef(false);
  const operationGeneration = useRef(0);
  const messagesRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      operationGeneration.current += 1;
      const shouldStop = previewOwned.current || previewStarting.current;
      previewOwned.current = false;
      previewStarting.current = false;
      if (shouldStop) void stopConversation();
    };
  }, []);

  useEffect(() => {
    if (!followLatest.current) {
      setHasUnseen(true);
      return;
    }
    const frame = requestAnimationFrame(() => {
      const messages = messagesRef.current;
      if (messages) messages.scrollTo({ top: messages.scrollHeight, behavior: "auto" });
    });
    return () => cancelAnimationFrame(frame);
  }, [turns]);

  const scrollToLatest = () => {
    followLatest.current = true;
    setHasUnseen(false);
    const messages = messagesRef.current;
    if (messages) messages.scrollTo({ top: messages.scrollHeight, behavior: "smooth" });
  };

  const onMessagesScroll = () => {
    const messages = messagesRef.current;
    if (!messages) return;
    const atLatest = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 48;
    followLatest.current = atLatest;
    if (atLatest) setHasUnseen(false);
  };

  const start = async () => {
    if (previewStarting.current) return;
    if (active) { toast("error", t("请先结束当前实时对话")); return; }
    const generation = ++operationGeneration.current;
    const current = () => mounted.current && operationGeneration.current === generation;
    previewStarting.current = true;
    setStarting(true);
    try {
      const saved = dirty ? await onSave() : record;
      if (!saved) return;
      if (!current()) return;
      clearHistory();
      followLatest.current = true;
      setHasUnseen(false);
      await startConversation({ agent: saved.id, agentSource: "draft", agentRevision: saved.revision });
      if (!current()) return;
      previewOwned.current = true;
    } catch (error) {
      if (current()) toast("error", error instanceof Error ? error.message : String(error));
    } finally {
      if (current()) {
        previewStarting.current = false;
        setStarting(false);
      }
    }
  };

  const end = async () => {
    operationGeneration.current += 1;
    previewStarting.current = false;
    previewOwned.current = false;
    await stopConversation();
  };

  const restart = async () => {
    if (!previewOwned.current || previewStarting.current) return;
    const generation = ++operationGeneration.current;
    const current = () => mounted.current && operationGeneration.current === generation;
    // Keep the old session alive while a dirty draft saves; only replace it once the
    // revision needed by the new preview is durable.
    setStarting(true);
    previewStarting.current = true;
    try {
      const saved = dirty ? await onSave() : record;
      if (!saved || !current()) return;
      previewOwned.current = false;
      await stopConversation();
      if (!current()) return;
      clearHistory();
      followLatest.current = true;
      setHasUnseen(false);
      await startConversation({ agent: saved.id, agentSource: "draft", agentRevision: saved.revision });
      if (!current()) return;
      previewOwned.current = true;
    } catch (error) {
      if (current()) toast("error", error instanceof Error ? error.message : String(error));
    } finally {
      if (current()) {
        previewStarting.current = false;
        setStarting(false);
      }
    }
  };

  const isPreview = active && previewOwned.current;
  const previewConnected = isPreview && connection === "connected";
  const stateLabel = isPreview ? t(previewStatusLabel(connection, sessionState)) : t("未开始");
  const latestTurn = turns.at(-1);
  const liveAnnouncement = latestTurn?.status === "completed" && latestTurn.reply ? latestTurn.reply : stateLabel;
  return (
    <aside className="flex h-[70dvh] max-h-[680px] flex-col overflow-hidden rounded-2xl border border-edge bg-canvas shadow-[0_8px_30px_rgba(0,0,0,0.05)] xl:sticky xl:top-[90px] xl:h-[calc(100dvh-114px)] xl:max-h-none">
      <header className="flex shrink-0 items-start justify-between gap-4 border-b border-edge-faint bg-canvas px-5 py-4">
        <div>
          <div className="flex items-center gap-2"><h2 className="text-[13px] font-semibold">{t("实时试用")}</h2>{audit?.status === "current" ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[9px] text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">v{audit.version}</span> : null}</div>
          <p className="mt-1 text-[11px] text-fg-muted">{t("使用当前草稿进行实时测试。")}</p>
        </div>
        <div className="flex items-center gap-2">
          {isPreview ? <button onClick={() => void restart()} disabled={starting} title={t("重新开始")} aria-label={t("重新开始")} className="flex size-8 items-center justify-center rounded-lg text-fg-muted hover:bg-fill-hover hover:text-fg disabled:opacity-40"><RotateCw className={`size-3.5 ${starting ? "animate-spin" : ""}`} /></button> : null}
          <span className={`size-2 rounded-full ${previewConnected ? "bg-emerald-400 shadow-[0_0_0_4px_rgba(52,211,153,0.12)]" : isPreview ? "bg-amber-400 shadow-[0_0_0_4px_rgba(251,191,36,0.12)]" : "bg-edge-hover"}`} />
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col bg-surface/45">
        <div ref={messagesRef} onScroll={onMessagesScroll} role="log" aria-label={t("对话记录")} aria-live="off" className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-5">
          {turns.length === 0 ? (
            <div className="flex h-full min-h-[240px] flex-col items-center justify-center text-center"><span className="flex size-12 items-center justify-center rounded-full border border-edge bg-canvas"><Mic className="size-5 text-fg-muted" /></span><p className="mt-4 text-[12px] font-medium">{t("在浏览器中与助手对话")}</p><p className="mt-1 max-w-[250px] text-[10px] leading-5 text-fg-faint">{t("开始后会使用当前草稿 revision，不影响已发布版本。")}</p></div>
          ) : turns.map(turn => (
            <div key={turn.id} className="space-y-2.5">
              {turn.transcript && <div className="ml-auto w-fit max-w-[86%] rounded-2xl rounded-br-md bg-ink px-3.5 py-2 text-[11px] leading-5 text-on-ink">{turn.transcript}</div>}
              {turn.reply && <div className={`w-fit max-w-[92%] rounded-2xl rounded-bl-md bg-canvas px-3.5 py-2.5 text-[11px] leading-[1.65] text-fg ring-1 ring-edge-faint ${turn.status === "interrupted" ? "opacity-60" : ""}`}>{turn.reply}</div>}
            </div>
          ))}
        </div>

        {hasUnseen ? <button onClick={scrollToLatest} className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-edge bg-canvas px-3 py-1.5 text-[10px] font-medium text-fg-secondary shadow-lg hover:bg-fill-hover">{t("有新消息")} ↓</button> : null}
      </div>

      <span className="sr-only" aria-live="polite" aria-atomic="true">{liveAnnouncement}</span>

      <footer className="shrink-0 border-t border-edge-faint bg-canvas p-4">
        <div className="mb-3 flex items-center justify-between text-[10px] text-fg-faint">
          <span className="flex items-center gap-2"><span className={`size-1.5 rounded-full ${previewConnected ? "bg-emerald-400" : isPreview ? "bg-amber-400" : "bg-edge-hover"}`} />{isPreview ? stateLabel : t("麦克风将在开始后启用")}</span>
          <span className={`flex h-3 items-end gap-[2px] ${muted ? "opacity-35" : ""}`}>{[0.15, 0.3, 0.5, 0.7, 0.9].map((threshold, index) => <span key={threshold} className={`w-[2px] rounded-full transition ${!muted && micLevel >= threshold ? "bg-emerald-400" : "bg-edge-hover"}`} style={{ height: `${4 + index * 2}px` }} />)}</span>
        </div>
        {isPreview ? (
          <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] gap-2">
            <button onClick={() => conversationControls()?.setMuted(!muted)} disabled={starting} title={muted ? t("已静音") : t("静音")} className={`flex h-10 items-center justify-center gap-2 rounded-full border px-3 text-[11px] font-medium transition disabled:opacity-40 ${muted ? "border-amber-300 bg-amber-50 text-amber-700" : "border-edge bg-canvas text-fg-secondary hover:bg-fill-hover"}`}>{muted ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}<span className="hidden sm:inline">{muted ? t("已静音") : t("静音")}</span></button>
            <button onClick={() => conversationControls()?.interruptPlayback()} disabled={starting || !previewConnected || sessionState !== "speaking"} title={t("停止当前回答（也可以直接开口打断）")} className="flex h-10 items-center justify-center gap-2 rounded-full border border-edge bg-canvas px-3 text-[11px] font-medium text-fg-secondary hover:bg-fill-hover disabled:cursor-not-allowed disabled:opacity-35"><CircleStop className="size-3.5" /><span className="hidden sm:inline">{t("停止回答")}</span></button>
            <button onClick={() => void end()} disabled={starting} className="flex h-10 min-w-0 items-center justify-center gap-2 rounded-full border border-red-200 bg-red-50 px-3 text-[11px] font-medium text-red-600 hover:bg-red-100 disabled:opacity-40 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300"><CircleStop className="size-3.5" />{t("结束测试")}</button>
          </div>
        ) : (
          <button onClick={() => void start()} disabled={starting} className="flex h-11 w-full items-center justify-center gap-2 rounded-full bg-ink text-[12px] font-medium text-on-ink transition hover:bg-ink-hover disabled:opacity-60">{starting ? <LoaderCircle className="size-4 animate-spin" /> : <Mic className="size-4" />}{dirty ? t("保存并开始测试") : t("开始测试")}</button>
        )}
      </footer>
    </aside>
  );
}
