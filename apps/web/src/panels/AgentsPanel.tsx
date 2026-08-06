import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  BriefcaseBusiness,
  CalendarDays,
  Check,
  ChevronDown,
  CircleStop,
  Copy,
  Download,
  Headphones,
  History,
  LoaderCircle,
  Mic,
  MicOff,
  MoreHorizontal,
  Plus,
  RotateCw,
  Rocket,
  Search,
  Send,
  ServerCog,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  TrendingUp,
  UserRoundSearch,
  Volume2,
  Wrench,
  X,
} from "lucide-react";
import { PageHeader, pageShellClass, primaryButton, secondaryButton } from "../components/StudioPage";
import { conversationControls, downloadMediaTrace, startConversation, stopConversation } from "../conversation";
import { resolveLocale, useI18n, useT, type MessageKey, type UiLocale } from "../i18n";
import {
  auditAgent,
  createAgent,
  deleteAgent,
  getAgent,
  getDeploymentInfo,
  listAgents,
  listAgentVersions,
  listRuntimeCatalog,
  listVoices,
  publishAgent,
  updateAgent,
  type AgentAudit,
  type AgentPublishedVersion,
  type AgentRecord,
  type AgentSpec,
  type EngineEntry,
  type DeploymentInfo,
  type VoiceEntry,
} from "../lib/api";
import type { ConnectionState } from "../lib/client";
import { formatMediaTransportDetails, mediaTransportFallbackMessage } from "../lib/media-telemetry";
import { useMicrophoneDevices } from "../lib/use-microphone";
import { useStudio } from "../store";
import { AgentConversations } from "./AgentConversations";

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

const auditStatusKeys = {
  unpublished: "未发布",
  current: "已发布",
  drifted: "已漂移",
  missing_snapshot: "发布快照缺失",
} as const satisfies Record<AgentAudit["status"], MessageKey>;

function agentSlug(value: string): string {
  const latin = value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return latin || `agent-${crypto.randomUUID().slice(0, 8)}`;
}

function yamlKey(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) ? value : JSON.stringify(value);
}

function yamlScalar(value: string | number | boolean | null): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (value === null) return "null";
  return String(value);
}

function yamlLines(value: Record<string, unknown>, depth = 0): string[] {
  const indent = "  ".repeat(depth);
  const lines: string[] = [];
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (Array.isArray(item)) {
      lines.push(`${indent}${yamlKey(key)}: ${item.length === 0 ? "[]" : `[${item.map(entry => yamlScalar(entry as string | number | boolean | null)).join(", ")}]`}`);
    } else if (typeof item === "object" && item !== null) {
      const nested = yamlLines(item as Record<string, unknown>, depth + 1);
      lines.push(nested.length > 0 ? `${indent}${yamlKey(key)}:` : `${indent}${yamlKey(key)}: {}`);
      lines.push(...nested);
    } else {
      lines.push(`${indent}${yamlKey(key)}: ${yamlScalar(item as string | number | boolean | null)}`);
    }
  }
  return lines;
}

/** A portable Agent draft export. Quoted JSON scalars keep arbitrary Unicode valid YAML. */
export function agentExportYaml(record: AgentRecord): string {
  const portable: AgentRecord = { ...record };
  // A published pointer is only valid together with its immutable snapshot file. A
  // single-file draft export must never carry a pointer it cannot satisfy elsewhere.
  delete portable.published;
  return `# VoxStudio Agent draft\n${yamlLines(portable as unknown as Record<string, unknown>).join("\n")}\n`;
}

function downloadAgentYaml(record: AgentRecord): void {
  const url = URL.createObjectURL(new Blob([agentExportYaml(record)], { type: "application/yaml;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${record.id}.yaml`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function AgentAvatar({ id, size = "size-7" }: { id: string; size?: string }) {
  return <span aria-hidden className={`${size} shrink-0 rounded-full border border-black/10 shadow-[inset_0_0_8px_rgba(255,255,255,0.22)] dark:border-white/15`} style={avatarStyle(id)} />;
}

export type AgentSection = "configuration" | "speech" | "deployment" | "conversations";

interface AgentsPanelProps {
  agentId?: string | undefined;
  agentSection: AgentSection;
  onOpenAgent(id: string): void;
  onOpenAgentSection(section: AgentSection): void;
  onCloseAgent(force?: boolean): void;
  onDirtyChange(dirty: boolean): void;
}

export function AgentsPanel({ agentId, agentSection, onOpenAgent, onOpenAgentSection, onCloseAgent, onDirtyChange }: AgentsPanelProps) {
  if (agentId) return <AgentBuilder agentId={agentId} section={agentSection} onOpenAgent={onOpenAgent} onSectionChange={onOpenAgentSection} onClose={onCloseAgent} onDirtyChange={onDirtyChange} />;
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
  const [duplicateSource, setDuplicateSource] = useState<AgentRecord>();
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
                  <button onClick={event => { event.stopPropagation(); setActionsId(undefined); setDuplicateSource(agent); }} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12px] hover:bg-fill-hover"><Plus className="size-3.5 text-fg-muted" />{t("复制助手")}</button>
                  <button onClick={event => { event.stopPropagation(); setActionsId(undefined); downloadAgentYaml(agent); toast("info", t("已导出助手 YAML")); }} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12px] hover:bg-fill-hover"><Download className="size-3.5 text-fg-muted" />{t("导出 YAML")}</button>
                  <button onClick={event => { event.stopPropagation(); setActionsId(undefined); void auditAgent(agent.id).then(result => toast("info", t("审计结果：{status}", { status: t(auditStatusKeys[result.status]) }))).catch(error => toast("error", error instanceof Error ? error.message : String(error))); }} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12px] hover:bg-fill-hover"><ShieldCheck className="size-3.5 text-fg-muted" />{t("审计助手")}</button>
                  <div className="my-1 border-t border-edge-faint" />
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
      {duplicateSource && <DuplicateAgentDialog source={duplicateSource} onClose={() => setDuplicateSource(undefined)} onCreated={agent => { setAgents(current => [agent, ...current]); setDuplicateSource(undefined); onOpenAgent(agent.id); }} />}
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

function DuplicateAgentDialog({ source, onClose, onCreated }: { source: AgentRecord; onClose(): void; onCreated(agent: AgentRecord): void }) {
  const t = useT();
  const [name, setName] = useState(t("{name} 副本", { name: source.name }));
  const [id, setId] = useState(`${source.id}-copy`.slice(0, 64));
  const [idTouched, setIdTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState("");

  const submit = async () => {
    const cleanName = name.trim();
    const cleanId = id.trim();
    if (!cleanName || !cleanId) return;
    setSaving(true); setFailure("");
    try {
      onCreated(await createAgent({
        id: cleanId,
        name: cleanName,
        ...(source.description ? { description: source.description } : {}),
        ...(source.avatar ? { avatar: source.avatar } : {}),
        spec: source.spec,
      }));
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 px-4 backdrop-blur-[2px]" onMouseDown={event => { if (event.target === event.currentTarget && !saving) onClose(); }}>
      <div role="dialog" aria-modal="true" aria-labelledby="duplicate-agent-title" className="w-full max-w-[430px] rounded-2xl border border-edge bg-canvas p-6 shadow-[0_24px_80px_rgba(0,0,0,0.18)]">
        <div className="flex items-start gap-3"><span className="flex size-10 items-center justify-center rounded-xl bg-fill-active text-fg-secondary"><Copy className="size-5" /></span><div><h2 id="duplicate-agent-title" className="text-[17px] font-semibold tracking-[-0.02em]">{t("复制助手")}</h2><p className="mt-1 text-[12px] text-fg-muted">{t("复制配置并创建一个独立的新助手。")}</p></div></div>
        <label className="mt-6 block text-[11px] font-medium text-fg-secondary">{t("名称")}</label>
        <input autoFocus value={name} onChange={event => { setName(event.target.value); if (!idTouched) setId(agentSlug(event.target.value).slice(0, 64)); }} className="mt-2 h-10 w-full rounded-lg border border-edge-strong bg-surface px-3 text-[13px]" />
        <label className="mt-4 block text-[11px] font-medium text-fg-secondary">Agent ID</label>
        <input value={id} onChange={event => { setIdTouched(true); setId(event.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, "-").slice(0, 64)); }} className="mt-2 h-10 w-full rounded-lg border border-edge-strong bg-surface px-3 font-mono text-[12px]" />
        {failure && <p className="mt-3 text-[11px] leading-5 text-danger">{failure}</p>}
        <div className="mt-6 flex justify-end gap-2"><button onClick={onClose} disabled={saving} className={secondaryButton}>{t("取消")}</button><button onClick={() => void submit()} disabled={saving || !name.trim() || !id.trim()} className={primaryButton}>{saving ? <LoaderCircle className="size-4 animate-spin" /> : <Copy className="size-4" />}{t("创建副本")}</button></div>
      </div>
    </div>
  );
}

export interface AgentDraft {
  name: string;
  description: string;
  instructions: string;
  welcome: string;
  language: string;
  voice: string;
  asrEngine: string;
  llmEngine: string;
  ttsEngine: string;
  nudgeAfterSeconds: string;
  maxSessionSeconds: string;
  studioTools: boolean;
  mcpServers: string[];
  pronunciationsText: string;
  keytermsText: string;
  turnTaking: "" | "conservative" | "speculative";
  vad: "" | "energy" | "silero";
  reopenMs: string;
  threshold: string;
  silenceMs: string;
  minSpeechMs: string;
}

function textList(values: readonly string[] | undefined): string {
  return (values ?? []).join("\n");
}

export function listFromText(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map(item => item.trim()).filter(Boolean))];
}

export function pronunciationsFromText(value: string): {
  pronunciations?: Record<string, string>;
  errorLine?: number;
} {
  const pronunciations: Record<string, string> = {};
  const lines = value.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (!line) continue;
    const separator = line.search(/[=＝]/);
    const term = separator < 0 ? "" : line.slice(0, separator).trim();
    const reading = separator < 0 ? "" : line.slice(separator + 1).trim();
    if (!term || !reading) return { errorLine: index + 1 };
    pronunciations[term] = reading;
  }
  return { pronunciations };
}

function pronunciationsText(value: Record<string, string> | undefined): string {
  return Object.entries(value ?? {}).map(([term, reading]) => `${term} = ${reading}`).join("\n");
}

export interface ValidationIssue {
  key: MessageKey;
  params?: Record<string, string | number>;
}

const nonNegativeFields = [
  ["nudgeAfterSeconds", "静默追问（秒）"],
  ["reopenMs", "续说窗口（毫秒）"],
  ["threshold", "能量阈值"],
  ["silenceMs", "静音断句（毫秒）"],
  ["minSpeechMs", "最短语音（毫秒）"],
] as const satisfies readonly [keyof AgentDraft, MessageKey][];

export function validateAgentDraftShape(draft: AgentDraft): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!draft.name.trim()) issues.push({ key: "名称不能为空" });
  for (const [field, label] of nonNegativeFields) {
    const raw = draft[field] as string;
    if (raw && (!Number.isFinite(Number(raw)) || Number(raw) < 0)) {
      issues.push({ key: "{field}必须是非负数字", params: { field: label } });
    }
  }
  if (draft.maxSessionSeconds && (!Number.isFinite(Number(draft.maxSessionSeconds)) || Number(draft.maxSessionSeconds) <= 0)) {
    issues.push({ key: "最长会话必须是大于 0 的数字" });
  }
  const parsedPronunciations = pronunciationsFromText(draft.pronunciationsText);
  if (parsedPronunciations.errorLine !== undefined) {
    issues.push({ key: "发音词典第 {line} 行应使用“词语 = 读音”格式", params: { line: parsedPronunciations.errorLine } });
  }
  return issues;
}

export function draftFrom(record: AgentRecord): AgentDraft {
  return {
    name: record.name,
    description: record.description ?? "",
    instructions: record.spec.instructions ?? "",
    welcome: record.spec.welcome ?? "",
    language: record.spec.language ?? "auto",
    voice: record.spec.voice ?? "",
    asrEngine: record.spec.asrEngine ?? "",
    llmEngine: record.spec.llmEngine ?? "",
    ttsEngine: record.spec.ttsEngine ?? "",
    nudgeAfterSeconds: record.spec.nudgeAfterSeconds === undefined ? "" : String(record.spec.nudgeAfterSeconds),
    maxSessionSeconds: record.spec.maxSessionSeconds === undefined ? "" : String(record.spec.maxSessionSeconds),
    studioTools: record.spec.studioTools ?? false,
    mcpServers: record.spec.mcpServers ?? [],
    pronunciationsText: pronunciationsText(record.spec.pronunciations),
    keytermsText: textList(record.spec.keyterms),
    turnTaking: record.spec.turnTaking ?? "",
    vad: record.spec.vad ?? "",
    reopenMs: record.spec.reopenMs === undefined ? "" : String(record.spec.reopenMs),
    threshold: record.spec.threshold === undefined ? "" : String(record.spec.threshold),
    silenceMs: record.spec.silenceMs === undefined ? "" : String(record.spec.silenceMs),
    minSpeechMs: record.spec.minSpeechMs === undefined ? "" : String(record.spec.minSpeechMs),
  };
}

export function specFrom(draft: AgentDraft, prior: AgentSpec): AgentSpec {
  const spec: AgentSpec = { ...prior };
  if (draft.instructions || prior.instructions !== undefined) spec.instructions = draft.instructions;
  else delete spec.instructions;
  if (draft.welcome || prior.welcome !== undefined) spec.welcome = draft.welcome;
  else delete spec.welcome;
  const language = draft.language || "auto";
  if (language !== "auto" || prior.language !== undefined) spec.language = language;
  else delete spec.language;
  if (draft.studioTools || prior.studioTools !== undefined) spec.studioTools = draft.studioTools;
  else delete spec.studioTools;
  if (draft.voice) spec.voice = draft.voice;
  else delete spec.voice;
  if (draft.asrEngine) spec.asrEngine = draft.asrEngine;
  else delete spec.asrEngine;
  if (draft.llmEngine) spec.llmEngine = draft.llmEngine;
  else delete spec.llmEngine;
  if (draft.ttsEngine) spec.ttsEngine = draft.ttsEngine;
  else delete spec.ttsEngine;
  for (const [field] of nonNegativeFields) {
    const raw = draft[field] as string;
    if (raw) (spec as Record<string, unknown>)[field] = Number(raw);
    else delete (spec as Record<string, unknown>)[field];
  }
  if (draft.maxSessionSeconds) spec.maxSessionSeconds = Number(draft.maxSessionSeconds);
  else delete spec.maxSessionSeconds;
  const pronunciations = pronunciationsFromText(draft.pronunciationsText).pronunciations ?? {};
  if (Object.keys(pronunciations).length > 0) spec.pronunciations = pronunciations;
  else delete spec.pronunciations;
  const keyterms = listFromText(draft.keytermsText);
  if (keyterms.length > 0) spec.keyterms = keyterms;
  else delete spec.keyterms;
  if (draft.mcpServers.length > 0) spec.mcpServers = [...new Set(draft.mcpServers)];
  else delete spec.mcpServers;
  if (draft.turnTaking) spec.turnTaking = draft.turnTaking;
  else delete spec.turnTaking;
  if (draft.vad) spec.vad = draft.vad;
  else delete spec.vad;
  return spec;
}

/** Materialize the editor's current in-memory draft without mutating the registry. */
export function agentRecordFromDraft(record: AgentRecord, draft: AgentDraft): AgentRecord {
  const next: AgentRecord = {
    ...record,
    name: draft.name.trim(),
    spec: specFrom(draft, record.spec),
  };
  const description = draft.description.trim();
  if (description) next.description = description;
  else delete next.description;
  return next;
}

function canonicalJson(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize);
    if (typeof item !== "object" || item === null) return item;
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalize(entry)]));
  };
  return JSON.stringify(normalize(value));
}

export function agentBehaviorChanged(draft: AgentDraft, prior: AgentSpec): boolean {
  return canonicalJson(specFrom(draft, prior)) !== canonicalJson(prior);
}

export function validateAgentDraftDependencies(
  draft: AgentDraft,
  engines: EngineEntry[],
  voices: VoiceEntry[],
  mcpServers: string[],
  runtimeCatalogReady: boolean,
  voiceCatalogReady: boolean,
): ValidationIssue[] {
  if (!runtimeCatalogReady || (Boolean(draft.voice) && !voiceCatalogReady)) {
    return [{ key: "无法验证运行依赖；请检查网关后重试。" }];
  }
  const issues: ValidationIssue[] = [];
  const routes = [
    { kind: "asr", label: "ASR", selected: draft.asrEngine },
    { kind: "llm", label: "LLM", selected: draft.llmEngine },
    { kind: "tts", label: "TTS", selected: draft.ttsEngine },
  ] as const;
  const effective = new Map<(typeof routes)[number]["kind"], EngineEntry>();
  for (const route of routes) {
    const entry = route.selected
      ? engines.find(engine => engine.name === route.selected && engine.kind === route.kind)
      : engines.find(engine => engine.kind === route.kind && engine.roles.includes(route.kind));
    if (!entry) {
      issues.push(route.selected
        ? { key: "{kind} 引擎“{name}”不存在", params: { kind: route.label, name: route.selected } }
        : { key: "未配置 {kind} 默认引擎", params: { kind: route.label } });
      continue;
    }
    effective.set(route.kind, entry);
    if (!entry.healthy) issues.push({ key: "{kind} 引擎“{name}”当前离线", params: { kind: route.label, name: entry.name } });
  }
  const effectiveTts = effective.get("tts");
  if (draft.voice && effectiveTts && !voices.some(voice => voice.id === draft.voice && voice.engine === effectiveTts.name)) {
    issues.push({ key: "音色“{voice}”在所选引擎中不可用", params: { voice: draft.voice } });
  }
  for (const server of draft.mcpServers) {
    if (!mcpServers.includes(server)) issues.push({ key: "MCP 服务器“{name}”当前不可用", params: { name: server } });
  }
  return issues;
}

export type AgentPreviewSource = { type: "draft" } | { type: "published"; version: number };

export function agentPreviewTraceKey(source: AgentPreviewSource, draftRevision: number): string {
  return source.type === "draft" ? `draft:${draftRevision}` : `published:${source.version}`;
}

export function agentPreviewOptions(record: AgentRecord, source: AgentPreviewSource) {
  return source.type === "draft"
    ? { agent: record.id, agentSource: "draft" as const, agentRevision: record.revision }
    : { agent: record.id, agentSource: "published" as const, agentVersion: source.version };
}

export interface AgentDeploymentSnippets {
  cli: string | null;
  native: string;
  openai: string;
  python: string;
}

export type AgentDemoPinState = "loading" | "off" | "current" | "other" | "unpinned";

export function agentDemoPinState(
  info: DeploymentInfo | undefined,
  agentId: string,
  publishedVersion: number,
): AgentDemoPinState {
  if (info === undefined) return "loading";
  if (!info.demo) return "off";
  if (info.demoAgent === undefined) return "unpinned";
  return info.demoAgent.id === agentId && info.demoAgent.version === publishedVersion ? "current" : "other";
}

export function agentDeploymentSnippets(
  agentId: string,
  origin: string,
  options: { tokenRequired?: boolean; accountMode?: boolean } = {},
): AgentDeploymentSnippets {
  const base = origin.replace(/\/$/, "");
  const websocket = base.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  const encoded = encodeURIComponent(agentId);
  const nativeSocket = options.accountMode
    ? `import WebSocket from "ws";\n\nconst ws = new WebSocket(${JSON.stringify(`${websocket}/v1/realtime`)}, {\n  headers: { Authorization: \`Bearer \${process.env.VOX_API_KEY ?? "YOUR_API_KEY"}\` },\n});`
    : options.tokenRequired
      ? `const url = new URL(${JSON.stringify(`${websocket}/v1/realtime`)});\nurl.searchParams.set("token", "YOUR_GATEWAY_TOKEN");\nconst ws = new WebSocket(url);`
      : `const ws = new WebSocket(${JSON.stringify(`${websocket}/v1/realtime`)});`;
  return {
    // Hosted records live in the signed-in account namespace. The local CLI resolves
    // only the self-hosted owner namespace, so offering it here could run the wrong id.
    cli: options.accountMode ? null : `# Run on the gateway host; this uses its local Agent registry and engines.\nvox listen --agent ${agentId}`,
    native: `${nativeSocket}\n\nws.addEventListener("open", () => {\n  ws.send(JSON.stringify({\n    v: 1,\n    type: "session.start",\n    idempotencyKey: crypto.randomUUID(),\n    options: { agent: ${JSON.stringify(agentId)} },\n  }));\n});`,
    openai: `import OpenAI from "openai";\nimport { OpenAIRealtimeWebSocket } from "openai/realtime/websocket";\n\nconst api = new OpenAI({\n  apiKey: process.env.VOX_API_KEY ?? ${JSON.stringify(options.tokenRequired || options.accountMode ? "YOUR_API_KEY" : "local")},\n  baseURL: ${JSON.stringify(`${base}/v1`)},\n});\n\nconst realtime = new OpenAIRealtimeWebSocket({\n  model: "voxstudio-realtime",\n  onURL(url) {\n    url.searchParams.set("agent", ${JSON.stringify(agentId)});\n    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") url.protocol = "ws:";\n  },\n}, api);`,
    python: `import asyncio, json, websockets\n\nasync def main():\n    uri = ${JSON.stringify(`${websocket}/v1/realtime?model=voxstudio-realtime&agent=${encoded}`)}\n    headers = {"Authorization": "Bearer YOUR_API_KEY"}\n    async with websockets.connect(uri, additional_headers=headers) as ws:\n        print(json.loads(await ws.recv()))  # session.created\n\nasyncio.run(main())`,
  };
}

function DeploymentCode({ title, code, onCopy }: { title: string; code: string; onCopy(): void }) {
  const t = useT();
  return (
    <div className="overflow-hidden rounded-xl border border-edge bg-surface">
      <div className="flex items-center justify-between border-b border-edge-faint px-4 py-2.5">
        <span className="text-[10px] font-semibold text-fg-secondary">{title}</span>
        <button onClick={onCopy} className="inline-flex h-7 items-center gap-1.5 rounded-lg px-2 text-[9px] text-fg-muted hover:bg-fill-hover hover:text-fg"><Copy className="size-3" />{t("复制代码")}</button>
      </div>
      <pre className="overflow-x-auto p-4 text-[10px] leading-5 text-fg-secondary"><code>{code}</code></pre>
    </div>
  );
}

function AgentDeployment({ record }: { record: AgentRecord }) {
  const t = useT();
  const toast = useStudio(state => state.toast);
  const [info, setInfo] = useState<DeploymentInfo>();
  const [failure, setFailure] = useState("");
  const infoGeneration = useRef(0);
  const loadInfo = useCallback(async (): Promise<void> => {
    const generation = ++infoGeneration.current;
    setFailure("");
    setInfo(undefined);
    try {
      const next = await getDeploymentInfo();
      if (generation === infoGeneration.current) setInfo(next);
    } catch (error) {
      if (generation === infoGeneration.current) setFailure(error instanceof Error ? error.message : String(error));
    }
  }, []);
  useEffect(() => {
    void loadInfo();
    return () => { infoGeneration.current += 1; };
  }, [loadInfo]);
  const copy = (code: string) => {
    void navigator.clipboard?.writeText(code);
    toast("info", t("已复制代码"));
  };
  if (!record.published) {
    return <div className="rounded-2xl border border-dashed border-edge bg-canvas px-6 py-12 text-center"><Rocket className="mx-auto size-6 text-fg-faint" /><h2 className="mt-4 text-[13px] font-semibold">{t("请先发布助手")}</h2><p className="mt-2 text-[11px] text-fg-muted">{t("部署接口只解析不可变的已发布版本。")}</p></div>;
  }
  if (info === undefined) {
    return (
      <BuilderSection icon={Rocket} title={t("连接已发布的助手")} description={t("复制可直接运行的连接示例；草稿不会通过部署接口提供。")}>
        {failure ? (
          <div className="flex flex-col items-start gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-4 text-[11px] text-red-700 dark:border-red-500/30 dark:bg-red-500/10 dark:text-red-300">
            <span>{failure}</span>
            <button type="button" onClick={() => { void loadInfo(); }} className="inline-flex h-8 items-center gap-2 rounded-full border border-current px-3 font-medium"><RotateCw className="size-3" />{t("刷新")}</button>
          </div>
        ) : <div className="flex items-center gap-2 rounded-xl border border-edge-faint bg-surface px-4 py-4 text-[11px] text-fg-muted"><LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />{t("探测中…")}</div>}
      </BuilderSection>
    );
  }
  const snippets = agentDeploymentSnippets(record.id, window.location.origin, {
    tokenRequired: info.tokenRequired,
    accountMode: info.auth === "accounts",
  });
  const cliSnippet = snippets.cli;
  const demoState = agentDemoPinState(info, record.id, record.published.version);
  const demoLabel = demoState === "loading" ? "—"
    : demoState === "off" ? t("未启用演示模式")
      : demoState === "current" ? t("已固定到此版本")
        : demoState === "other" && info?.demoAgent
          ? t("演示模式固定到 {id} v{version}", { id: info.demoAgent.id, version: info.demoAgent.version })
          : t("演示模式已启用，未固定助手");

  return (
    <div className="space-y-5">
      <BuilderSection icon={Rocket} title={t("连接已发布的助手")} description={t("复制可直接运行的连接示例；草稿不会通过部署接口提供。") }>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            [t("发布版本"), `v${record.published.version} · ${record.published.hash.slice(0, 10)}`],
            [t("公开地址"), window.location.origin],
            [t("认证模式"), info.auth === "accounts" ? t("账户与 API 密钥") : info.tokenRequired ? t("自托管（共享令牌）") : t("自托管")],
            [t("演示固定"), demoLabel],
          ].map(([label, value]) => <div key={label} className="rounded-xl border border-edge-faint bg-surface px-4 py-3"><div className="text-[9px] font-medium text-fg-faint">{label}</div><div className="mt-1.5 break-all font-mono text-[10px] text-fg-secondary">{value}</div></div>)}
        </div>
        {(info.tokenRequired || info.auth === "accounts") && <p className="text-[10px] leading-5 text-fg-muted">{info.tokenRequired
          ? t("共享令牌部署需替换示例中的令牌；账户模式机器客户端需要 API 密钥；浏览器还必须满足同源策略。")
          : t("机器客户端在账户模式下需要 Bearer API 密钥；浏览器还必须满足同源策略。")}</p>}
      </BuilderSection>
      <BuilderSection icon={ServerCog} title={cliSnippet === null ? t("原生 WebSocket") : t("原生 CLI")} description={info.auth === "accounts" ? t("机器客户端在账户模式下需要 Bearer API 密钥；浏览器还必须满足同源策略。") : t("本地命令，仅在 Gateway 主机使用。远程客户端请使用 WebSocket 示例。") }>
        {cliSnippet !== null && <DeploymentCode title={t("原生 CLI")} code={cliSnippet} onCopy={() => copy(cliSnippet)} />}
        <DeploymentCode title={t("原生 WebSocket")} code={snippets.native} onCopy={() => copy(snippets.native)} />
      </BuilderSection>
      <BuilderSection icon={Bot} title={t("OpenAI Realtime SDK")} description="OpenAI-compatible WebSocket">
        <DeploymentCode title="TypeScript" code={snippets.openai} onCopy={() => copy(snippets.openai)} />
        <DeploymentCode title={t("Python WebSocket")} code={snippets.python} onCopy={() => copy(snippets.python)} />
      </BuilderSection>
    </div>
  );
}

function AgentBuilder({ agentId, section, onOpenAgent, onSectionChange, onClose, onDirtyChange }: {
  agentId: string;
  section: AgentSection;
  onOpenAgent(id: string): void;
  onSectionChange(section: AgentSection): void;
  onClose(force?: boolean): void;
  onDirtyChange(dirty: boolean): void;
}) {
  const t = useT();
  const locale = resolveLocale(useI18n(state => state.locale));
  const toast = useStudio(state => state.toast);
  const [record, setRecord] = useState<AgentRecord>();
  const [draft, setDraft] = useState<AgentDraft>();
  const [voices, setVoices] = useState<VoiceEntry[]>([]);
  const [engines, setEngines] = useState<EngineEntry[]>([]);
  const [mcpServers, setMcpServers] = useState<string[]>([]);
  const [runtimeCatalogReady, setRuntimeCatalogReady] = useState(false);
  const [voiceCatalogReady, setVoiceCatalogReady] = useState(false);
  const [audit, setAudit] = useState<AgentAudit>();
  const [versions, setVersions] = useState<AgentPublishedVersion[]>([]);
  const [latestPublishedVersion, setLatestPublishedVersion] = useState<number>();
  const [versionsLoading, setVersionsLoading] = useState(false);
  const [versionsFailure, setVersionsFailure] = useState("");
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewSource, setPreviewSource] = useState<AgentPreviewSource>({ type: "draft" });
  const [duplicateSource, setDuplicateSource] = useState<AgentRecord>();
  const [actionsOpen, setActionsOpen] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState("");
  const [saving, setSaving] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    const generation = ++loadGeneration.current;
    setLoading(true); setFailure("");
    setRecord(undefined); setDraft(undefined); setAudit(undefined); setVersions([]); setLatestPublishedVersion(undefined); setVersionsFailure("");
    setVersionsOpen(false); setPreviewOpen(false); setPreviewSource({ type: "draft" });
    setDuplicateSource(undefined); setActionsOpen(false);
    setRuntimeCatalogReady(false); setVoiceCatalogReady(false);
    try {
      const [next, voiceBank, runtimeCatalog, nextAudit, nextVersions] = await Promise.all([
        getAgent(agentId),
        listVoices().catch(() => undefined),
        listRuntimeCatalog().catch(() => undefined),
        auditAgent(agentId).catch(() => undefined),
        listAgentVersions(agentId).catch(() => undefined),
      ]);
      if (generation !== loadGeneration.current) return;
      setRecord(next); setDraft(draftFrom(next));
      setVoices(voiceBank ?? []); setVoiceCatalogReady(voiceBank !== undefined);
      setEngines(runtimeCatalog?.engines ?? []); setMcpServers(runtimeCatalog?.mcpServers ?? []);
      setRuntimeCatalogReady(runtimeCatalog !== undefined);
      setAudit(nextAudit);
      setVersions(nextVersions ?? []);
      setLatestPublishedVersion(next.published?.version);
      if (nextVersions === undefined) setVersionsFailure(t("无法加载版本历史"));
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      setFailure(error instanceof Error ? error.message : String(error));
    } finally { if (generation === loadGeneration.current) setLoading(false); }
  }, [agentId, t]);

  useEffect(() => {
    void load();
    return () => { loadGeneration.current += 1; };
  }, [load]);
  useEffect(() => {
    if (!actionsOpen) return;
    const close = (event: PointerEvent) => {
      if (!(event.target as Element).closest?.("[data-builder-actions]")) setActionsOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [actionsOpen]);
  const dirty = useMemo(() => Boolean(record && draft && JSON.stringify(draft) !== JSON.stringify(draftFrom(record))), [record, draft]);
  const behaviorDirty = useMemo(() => Boolean(record && draft && dirty && agentBehaviorChanged(draft, record.spec)), [dirty, draft, record]);
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  const shapeIssues = useMemo(() => draft ? validateAgentDraftShape(draft) : [], [draft]);
  const dependencyIssues = useMemo<ValidationIssue[]>(() => draft
    ? validateAgentDraftDependencies(draft, engines, voices, mcpServers, runtimeCatalogReady, voiceCatalogReady)
    : [], [draft, engines, mcpServers, runtimeCatalogReady, voiceCatalogReady, voices]);
  const validationIssues = [...shapeIssues, ...dependencyIssues];
  const issueText = (issue: ValidationIssue): string => t(issue.key, issue.params);

  const save = async (): Promise<AgentRecord | undefined> => {
    if (!record || !draft) return undefined;
    if (shapeIssues.length > 0) {
      toast("error", issueText(shapeIssues[0] as ValidationIssue));
      return undefined;
    }
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
    if (validationIssues.length > 0) {
      toast("error", issueText(validationIssues[0] as ValidationIssue));
      return;
    }
    setPublishing(true);
    try {
      const saved = await save();
      if (!saved) return;
      const latestAudit = await auditAgent(saved.id);
      setAudit(latestAudit);
      if (latestAudit.status === "current") return;
      const result = await publishAgent(saved.id, saved.revision);
      setRecord(result.record); setDraft(draftFrom(result.record));
      setVersions(current => [result.version, ...current.filter(version => version.version !== result.version.version)]);
      setLatestPublishedVersion(result.version.version);
      setAudit({ status: "current", draftHash: result.version.hash, publishedHash: result.version.hash, version: result.version.version });
      toast("info", `${t("发布")} v${result.version.version}`);
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    } finally { setPublishing(false); }
  };

  const refreshVersions = async () => {
    setVersionsLoading(true); setVersionsFailure("");
    try {
      const [nextVersions, nextRecord, nextAudit] = await Promise.all([
        listAgentVersions(agentId),
        getAgent(agentId),
        auditAgent(agentId),
      ]);
      setVersions(nextVersions);
      setLatestPublishedVersion(nextRecord.published?.version);
      // When the editor is clean, safely advance its revision and published pointer too.
      // A dirty editor keeps its original base so a later save still detects conflicts.
      if (!dirty) {
        setRecord(nextRecord);
        setDraft(draftFrom(nextRecord));
        setAudit(nextAudit);
      }
    } catch (error) {
      setVersionsFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setVersionsLoading(false);
    }
  };

  const openVersions = () => {
    setVersionsOpen(true);
    void refreshVersions();
  };

  const restoreVersion = (version: AgentPublishedVersion) => {
    if (!record) return;
    if (dirty && !window.confirm(t("恢复版本会替换当前未保存的更改，继续吗？"))) return;
    setDraft(draftFrom({ ...record, spec: version.spec }));
    setPreviewSource({ type: "draft" });
    setVersionsOpen(false);
    toast("info", t("已将 v{version} 恢复为草稿；保存后生效。", { version: version.version }));
  };

  const runAudit = async () => {
    setActionBusy(true); setActionsOpen(false);
    try {
      const result = await auditAgent(agentId);
      setAudit(result);
      toast("info", t("审计结果：{status}", { status: t(auditStatusKeys[result.status]) }));
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    } finally {
      setActionBusy(false);
    }
  };

  const currentDraftRecord = (): AgentRecord | undefined => {
    if (!record || !draft) return undefined;
    if (shapeIssues.length > 0) {
      toast("error", issueText(shapeIssues[0] as ValidationIssue));
      return undefined;
    }
    return agentRecordFromDraft(record, draft);
  };

  const prepareDuplicate = () => {
    setActionsOpen(false);
    const source = currentDraftRecord();
    if (source) setDuplicateSource(source);
  };

  const exportYaml = () => {
    setActionsOpen(false);
    const source = currentDraftRecord();
    if (!source) return;
    downloadAgentYaml(source);
    toast("info", t("已导出助手 YAML"));
  };

  const removeBuilderAgent = async () => {
    if (!record || !window.confirm(`${t("删除助手")} “${record.name}”？`)) return;
    setActionBusy(true); setActionsOpen(false);
    try {
      await deleteAgent(record.id, record.revision);
      toast("info", t("已从列表移除助手"));
      onClose(true);
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
      setActionBusy(false);
    }
  };

  if (loading) return <div className="flex h-full items-center justify-center"><LoaderCircle className="size-6 animate-spin text-fg-faint" /></div>;
  if (!record || !draft) return <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center text-[13px] text-danger"><span>{failure || t("获取助手")}</span><div className="flex gap-2"><button onClick={() => onClose()} className={secondaryButton}><ArrowLeft className="size-4" />{t("助手")}</button><button onClick={() => void load()} className={secondaryButton}><RotateCw className="size-4" />{t("刷新")}</button></div></div>;

  const status = validationIssues.length > 0
    ? { label: t("配置无效"), tone: "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300" }
    : record.published && (behaviorDirty || audit?.status === "drifted")
      ? { label: t("已漂移"), tone: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300" }
      : record.published
        ? { label: t("已发布"), tone: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" }
        : { label: t("未发布"), tone: "bg-fill-active text-fg-muted" };
  const publishDisabled = saving || publishing || validationIssues.length > 0 || (!behaviorDirty && audit?.status === "current");
  const availableMcpServers = [...new Set([...mcpServers, ...draft.mcpServers])];

  return (
    <div className="min-h-full bg-surface/55">
      <div className="sticky top-0 z-20 border-b border-edge-faint bg-canvas/95 backdrop-blur">
        <div className="mx-auto flex min-h-[66px] max-w-[1440px] items-center gap-2 px-3 sm:gap-3 sm:px-7 lg:px-10">
          <button onClick={() => onClose()} aria-label={t("返回")} className="flex size-9 shrink-0 items-center justify-center rounded-lg text-fg-muted hover:bg-fill-hover hover:text-fg"><ArrowLeft className="size-[18px]" /></button>
          <span className="hidden sm:inline-flex"><AgentAvatar id={record.id} size="size-8" /></span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2"><span className="truncate text-[14px] font-semibold">{draft.name || record.id}</span><span className={`hidden rounded-full px-2 py-0.5 text-[9px] font-medium sm:inline ${status.tone}`}>{status.label}</span></div>
            <span className="block truncate text-[9px] text-fg-faint">{record.id}{record.published ? ` · v${record.published.version} · ${t("发布于 {time}", { time: displayTime(record.published.publishedAt, locale) })}` : ""}</span>
          </div>
          <span className="hidden items-center gap-1.5 text-[10px] text-fg-faint lg:flex">{dirty ? <><span className="size-1.5 rounded-full bg-amber-400" />{t("有未保存的更改")}</> : <><Check className="size-3" />{t("已保存")}</>}</span>
          <button onClick={openVersions} title={t("版本历史")} aria-label={t("版本历史")} className="hidden size-9 shrink-0 items-center justify-center rounded-full border border-edge bg-canvas text-fg-secondary hover:bg-fill-hover md:flex"><History className="size-3.5" /></button>
          <button onClick={() => setPreviewOpen(true)} title={t("实时试用")} className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-full border border-edge bg-canvas px-2.5 text-[11px] font-medium text-fg-secondary hover:bg-fill-hover sm:px-3"><Mic className="size-3.5" /><span className="hidden xl:inline">{t("实时试用")}</span></button>
          <button onClick={() => void save()} disabled={!dirty || saving || publishing || shapeIssues.length > 0} title={t("保存")} className="inline-flex h-9 shrink-0 items-center justify-center rounded-full border border-edge bg-canvas px-2.5 text-[11px] font-medium text-fg-secondary hover:bg-fill-hover disabled:cursor-not-allowed disabled:opacity-40 sm:px-3">{saving ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5 sm:hidden" />}<span className="hidden sm:inline">{t("保存")}</span></button>
          <button onClick={() => void publish()} disabled={publishDisabled} title={t("发布")} className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-full bg-ink px-2.5 text-[11px] font-medium text-on-ink hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-40 sm:px-4">{publishing ? <LoaderCircle className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}<span className="hidden sm:inline">{t("发布")}</span></button>
          <div data-builder-actions className="relative shrink-0">
            <button onClick={() => setActionsOpen(open => !open)} disabled={actionBusy} aria-label={t("助手操作")} aria-expanded={actionsOpen} className="flex size-9 items-center justify-center rounded-full text-fg-muted hover:bg-fill-hover hover:text-fg disabled:opacity-40">{actionBusy ? <LoaderCircle className="size-4 animate-spin" /> : <MoreHorizontal className="size-4.5" />}</button>
            {actionsOpen ? <div className="absolute right-0 top-11 z-40 w-48 rounded-xl border border-edge bg-canvas p-1.5 shadow-[0_16px_44px_rgba(0,0,0,0.15)]">
              <button onClick={() => { setActionsOpen(false); void navigator.clipboard?.writeText(record.id); toast("info", t("已复制助手 ID")); }} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] hover:bg-fill-hover"><Copy className="size-3.5 text-fg-muted" />{t("复制助手 ID")}</button>
              <button onClick={prepareDuplicate} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] hover:bg-fill-hover"><Plus className="size-3.5 text-fg-muted" />{t("复制助手")}</button>
              <button onClick={exportYaml} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] hover:bg-fill-hover"><Download className="size-3.5 text-fg-muted" />{t("导出 YAML")}</button>
              <button onClick={() => void runAudit()} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] hover:bg-fill-hover"><ShieldCheck className="size-3.5 text-fg-muted" />{t("审计助手")}</button>
              <button onClick={() => { setActionsOpen(false); openVersions(); }} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] hover:bg-fill-hover md:hidden"><History className="size-3.5 text-fg-muted" />{t("版本历史")}</button>
              <div className="my-1 border-t border-edge-faint" />
              <button onClick={() => void removeBuilderAgent()} className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[12px] text-danger hover:bg-danger-surface"><Trash2 className="size-3.5" />{t("删除助手")}</button>
            </div> : null}
          </div>
        </div>
        <nav className="mx-auto flex max-w-[1440px] gap-6 overflow-x-auto px-4 sm:px-7 lg:px-10" aria-label={t("助手")}>
          {(["configuration", "speech", "deployment", "conversations"] as const).map(item => (
            <button key={item} onClick={() => onSectionChange(item)} aria-current={section === item ? "page" : undefined} className={`relative h-10 shrink-0 px-1 text-[11px] font-medium transition ${section === item ? "text-fg" : "text-fg-muted hover:text-fg"}`}>
              {item === "configuration" ? t("配置") : item === "speech" ? t("语音设置") : item === "deployment" ? t("部署") : t("会话记录")}
              {section === item ? <span className="absolute inset-x-0 bottom-0 h-0.5 rounded-full bg-ink" /> : null}
            </button>
          ))}
        </nav>
      </div>

      {validationIssues.length > 0 ? (
        <div className="mx-auto max-w-[1440px] px-4 pt-5 sm:px-7 lg:px-10">
          <div role="alert" className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-amber-900 dark:border-amber-500/20 dark:bg-amber-500/10 dark:text-amber-200">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <div><p className="text-[11px] font-semibold">{t("修复以下配置问题后才能发布或试用：")}</p><ul className="mt-1.5 space-y-1 text-[10px] leading-5">{validationIssues.map((issue, index) => <li key={`${issue.key}-${index}`}>• {issueText(issue)}</li>)}</ul></div>
          </div>
        </div>
      ) : null}

      <div className="mx-auto w-full max-w-[1040px] px-4 py-6 sm:px-7 lg:px-10">
        <div className="space-y-5">
          {section === "configuration" ? (
            <>
              <BuilderSection icon={Bot} title={t("基本信息")} description={t("定义助手在工作台中的名称与用途。")}>
                <div className="grid gap-4 sm:grid-cols-2"><Field label={t("名称")}><input value={draft.name} onChange={event => setDraft({ ...draft, name: event.target.value })} className="builder-input" /></Field><Field label="Agent ID" hint={t("创建后不可修改")}><input value={record.id} disabled className="builder-input font-mono opacity-60" /></Field></div>
                <Field label={t("描述")}><input value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} placeholder={t("简要说明这个助手负责什么") } className="builder-input" /></Field>
              </BuilderSection>

              <BuilderSection icon={Sparkles} title={t("行为")} description={t("用自然语言定义角色、目标和回答边界。")}>
                <Field label={t("系统提示词")} hint={`${draft.instructions.length} / 32768`}><textarea value={draft.instructions} onChange={event => setDraft({ ...draft, instructions: event.target.value })} placeholder={t("告诉助手它是谁、要完成什么，以及需要遵守哪些规则。") } rows={8} className="builder-input min-h-44 resize-y py-3 leading-6" /></Field>
                <Field label={t("开场白")} hint={t("会话开始时自动说出")}><textarea value={draft.welcome} onChange={event => setDraft({ ...draft, welcome: event.target.value })} placeholder={t("你好，有什么可以帮你？") } rows={3} className="builder-input resize-y py-3 leading-5" /></Field>
              </BuilderSection>

              <BuilderSection icon={ServerCog} title={t("运行路线与能力")} description={t("为助手固定引擎和可用工具；留空时使用部署默认。")}>
                <div className="grid gap-4 md:grid-cols-3">
                  <AgentEngineSelect kind="asr" value={draft.asrEngine} engines={engines} onChange={asrEngine => setDraft({ ...draft, asrEngine })} />
                  <AgentEngineSelect kind="llm" value={draft.llmEngine} engines={engines} onChange={llmEngine => setDraft({ ...draft, llmEngine })} />
                  <AgentEngineSelect kind="tts" value={draft.ttsEngine} engines={engines} onChange={ttsEngine => setDraft({ ...draft, ttsEngine, voice: ttsEngine === draft.ttsEngine ? draft.voice : "" })} />
                </div>
              </BuilderSection>

              <BuilderSection icon={Wrench} title={t("能力与工具")} description={t("只允许助手使用这里明确启用的能力。")}>
                <ToggleCard checked={draft.studioTools} onChange={studioTools => setDraft({ ...draft, studioTools })} title={t("工作台语音工具")} description={t("允许助手通过语音保存音色、重念和管理发音。")} />
                <Field label={t("MCP 服务器")}>
                  {availableMcpServers.length === 0 ? <div className="rounded-xl border border-dashed border-edge bg-surface px-4 py-4 text-[11px] text-fg-faint">{t("当前没有可用的 MCP 服务器。")}</div> : <div className="grid gap-2 sm:grid-cols-2">{availableMcpServers.map(server => <ToggleCard key={server} checked={draft.mcpServers.includes(server)} onChange={checked => setDraft({ ...draft, mcpServers: checked ? [...draft.mcpServers, server] : draft.mcpServers.filter(item => item !== server) })} title={server} compact />)}</div>}
                </Field>
              </BuilderSection>

              <BuilderSection icon={ShieldCheck} title={t("会话边界")} description={t("助手只能收紧部署限制，不能放宽。")}>
                <Field label={t("最长会话（秒）")} hint={t("部署上限仍然生效")}><input type="number" min="1" value={draft.maxSessionSeconds} onChange={event => setDraft({ ...draft, maxSessionSeconds: event.target.value })} placeholder="—" className="builder-input" /></Field>
              </BuilderSection>
            </>
          ) : section === "speech" ? (
            <>
              <BuilderSection icon={Volume2} title={t("语音与会话")} description={t("选择输出音色并调整实时对话节奏。")}>
                <div className="grid gap-4 sm:grid-cols-2"><Field label={t("音色")}><VoiceSelect draft={draft} voices={voices} onChange={next => setDraft({ ...draft, ...next })} /></Field><Field label={t("语言")}><select value={draft.language} onChange={event => setDraft({ ...draft, language: event.target.value })} className="builder-input"><option value="auto">{t("自动")}</option><option value="zh">中文</option><option value="en">English</option><option value="ja">日本語</option><option value="ko">한국어</option></select></Field></div>
                <Field label={t("静默追问（秒）")} hint={t("留空表示关闭")}><input type="number" min="0" value={draft.nudgeAfterSeconds} onChange={event => setDraft({ ...draft, nudgeAfterSeconds: event.target.value })} placeholder="—" className="builder-input" /></Field>
              </BuilderSection>

              <BuilderSection icon={SlidersHorizontal} title={t("发音与识别")} description={t("调整合成读音和识别提示，不改变对话文字。")}>
                <div className="grid gap-4 md:grid-cols-2">
                  <Field label={t("发音词典")} hint={t("每行格式：词语 = 读音")}><textarea value={draft.pronunciationsText} onChange={event => setDraft({ ...draft, pronunciationsText: event.target.value })} rows={6} placeholder="VoxStudio = 沃克斯" className="builder-input resize-y py-3 font-mono text-[11px] leading-5" /></Field>
                  <Field label={t("ASR 关键词")} hint={t("每行一个需要优先识别的词语")}><textarea value={draft.keytermsText} onChange={event => setDraft({ ...draft, keytermsText: event.target.value })} rows={6} placeholder={'VoxStudio\nAgent Builder'} className="builder-input resize-y py-3 text-[11px] leading-5" /></Field>
                </div>
              </BuilderSection>

              <details className="group rounded-2xl border border-edge bg-canvas shadow-[0_1px_2px_rgba(0,0,0,0.025)]" open={Boolean(draft.turnTaking || draft.vad || draft.reopenMs || draft.threshold || draft.silenceMs || draft.minSpeechMs)}>
                <summary className="flex cursor-pointer list-none items-center gap-3 px-5 py-4 sm:px-6"><span className="flex size-8 items-center justify-center rounded-lg bg-fill-active text-fg-secondary"><SlidersHorizontal className="size-4" strokeWidth={1.8} /></span><span className="min-w-0 flex-1"><span className="block text-[13px] font-semibold">{t("高级语音控制")}</span><span className="mt-1 block text-[11px] text-fg-muted">{t("只有需要覆盖部署默认值时才调整。")}</span></span><ChevronDown className="size-4 text-fg-muted transition group-open:rotate-180" /></summary>
                <div className="grid gap-4 border-t border-edge-faint p-5 sm:grid-cols-2 sm:p-6">
                  <Field label={t("轮次策略")}><select value={draft.turnTaking} onChange={event => setDraft({ ...draft, turnTaking: event.target.value as AgentDraft["turnTaking"] })} className="builder-input"><option value="">{t("自动")}</option><option value="conservative">{t("保守")}</option><option value="speculative">{t("推测")}</option></select></Field>
                  <Field label={t("语音活动检测")}><select value={draft.vad} onChange={event => setDraft({ ...draft, vad: event.target.value as AgentDraft["vad"] })} className="builder-input"><option value="">{t("自动")}</option><option value="silero">Silero</option><option value="energy">{t("能量检测")}</option></select></Field>
                  <NumericField label={t("续说窗口（毫秒）")} value={draft.reopenMs} onChange={reopenMs => setDraft({ ...draft, reopenMs })} />
                  <NumericField label={t("静音断句（毫秒）")} value={draft.silenceMs} onChange={silenceMs => setDraft({ ...draft, silenceMs })} />
                  <NumericField label={t("最短语音（毫秒）")} value={draft.minSpeechMs} onChange={minSpeechMs => setDraft({ ...draft, minSpeechMs })} />
                  <NumericField label={t("能量阈值")} value={draft.threshold} step="0.001" onChange={threshold => setDraft({ ...draft, threshold })} />
                </div>
              </details>
            </>
          ) : section === "deployment" ? <AgentDeployment record={record} /> : <AgentConversations agentId={record.id} />}
        </div>

      </div>

      {versionsOpen ? <VersionHistoryDrawer
        record={record}
        versions={versions}
        loading={versionsLoading}
        failure={versionsFailure}
        dirty={dirty}
        currentPublishedVersion={latestPublishedVersion}
        previewSource={previewSource}
        onClose={() => setVersionsOpen(false)}
        onReload={() => void refreshVersions()}
        onRestore={restoreVersion}
        onPreviewDraft={() => { setPreviewSource({ type: "draft" }); setVersionsOpen(false); setPreviewOpen(true); }}
        onPreview={version => { setPreviewSource({ type: "published", version: version.version }); setVersionsOpen(false); setPreviewOpen(true); }}
      /> : null}
      {previewOpen ? <TryItLive record={record} versions={versions} currentPublishedVersion={latestPublishedVersion} source={previewSource} onSourceChange={setPreviewSource} dirty={dirty} onSave={save} blocked={validationIssues.length > 0} onClose={() => setPreviewOpen(false)} /> : null}
      {duplicateSource ? <DuplicateAgentDialog source={duplicateSource} onClose={() => setDuplicateSource(undefined)} onCreated={agent => { setDuplicateSource(undefined); onOpenAgent(agent.id); }} /> : null}
    </div>
  );
}

function VersionHistoryDrawer({ record, versions, loading, failure, dirty, currentPublishedVersion, previewSource, onClose, onReload, onRestore, onPreviewDraft, onPreview }: {
  record: AgentRecord;
  versions: AgentPublishedVersion[];
  loading: boolean;
  failure: string;
  dirty: boolean;
  currentPublishedVersion: number | undefined;
  previewSource: AgentPreviewSource;
  onClose(): void;
  onReload(): void;
  onRestore(version: AgentPublishedVersion): void;
  onPreviewDraft(): void;
  onPreview(version: AgentPublishedVersion): void;
}) {
  const t = useT();
  const locale = resolveLocale(useI18n(state => state.locale));
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[1px]" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <aside role="dialog" aria-modal="true" aria-labelledby="version-history-title" className="absolute inset-y-0 right-0 flex w-full flex-col border-l border-edge bg-canvas shadow-[-18px_0_60px_rgba(0,0,0,0.12)] sm:max-w-[460px]">
        <header className="flex shrink-0 items-start gap-3 border-b border-edge px-5 py-5 sm:px-6">
          <span className="flex size-9 items-center justify-center rounded-xl bg-fill-active text-fg-secondary"><History className="size-4" /></span>
          <div className="min-w-0 flex-1"><h2 id="version-history-title" className="text-[15px] font-semibold">{t("版本历史")}</h2><p className="mt-1 truncate text-[11px] text-fg-muted">{record.name} · {record.id}</p></div>
          <button onClick={onClose} aria-label={t("关闭")} className="flex size-9 items-center justify-center rounded-lg text-fg-muted hover:bg-fill-hover hover:text-fg"><X className="size-4" /></button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
          <section className={`rounded-2xl border p-4 ${previewSource.type === "draft" ? "border-fg bg-fill-faint" : "border-edge bg-surface"}`}>
            <div className="flex items-start justify-between gap-3"><div><div className="flex items-center gap-2"><span className="text-[12px] font-semibold">{t("当前草稿")}</span>{dirty ? <span className="rounded-full bg-amber-50 px-2 py-0.5 text-[9px] text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">{t("未保存")}</span> : null}</div><p className="mt-1 text-[10px] text-fg-faint">revision {record.revision} · {displayTime(record.updatedAt, locale)}</p></div><button onClick={onPreviewDraft} className="inline-flex h-8 items-center gap-1.5 rounded-full border border-edge bg-canvas px-3 text-[10px] font-medium hover:bg-fill-hover"><Mic className="size-3" />{t("试用")}</button></div>
          </section>

          <div className="my-5 flex items-center justify-between"><h3 className="text-[11px] font-semibold text-fg-secondary">{t("已发布版本")}</h3><span className="text-[10px] text-fg-faint">{t("共 {n} 个版本", { n: versions.length })}</span></div>
          {loading ? <div className="flex min-h-40 items-center justify-center"><LoaderCircle className="size-5 animate-spin text-fg-faint" /></div> : failure ? <div className="flex min-h-40 flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-edge px-5 text-center text-[11px] text-danger"><span>{failure}</span><button onClick={onReload} className={secondaryButton}><RotateCw className="size-3.5" />{t("重试")}</button></div> : versions.length === 0 ? <div className="flex min-h-40 flex-col items-center justify-center rounded-xl border border-dashed border-edge px-5 text-center"><History className="size-5 text-fg-faint" /><p className="mt-3 text-[11px] font-medium">{t("尚未发布任何版本")}</p><p className="mt-1 text-[10px] leading-5 text-fg-faint">{t("发布后，版本快照会不可变地保存在这里。")}</p></div> : <div className="space-y-3">{versions.map(version => {
            const current = currentPublishedVersion === version.version;
            const selected = previewSource.type === "published" && previewSource.version === version.version;
            return <article key={version.version} className={`rounded-2xl border p-4 transition ${selected ? "border-fg bg-fill-faint" : "border-edge bg-canvas hover:border-edge-strong"}`}>
              <div className="flex items-start justify-between gap-3"><div><div className="flex items-center gap-2"><span className="text-[13px] font-semibold">v{version.version}</span>{current ? <span className="rounded-full bg-emerald-50 px-2 py-0.5 text-[9px] text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300">{t("当前发布")}</span> : null}</div><p className="mt-1 text-[10px] text-fg-faint">{displayTime(version.publishedAt, locale)}</p></div><button onClick={() => { void navigator.clipboard?.writeText(version.hash); }} title={t("复制 Hash")} className="flex h-8 items-center gap-1.5 rounded-lg px-2 font-mono text-[9px] text-fg-muted hover:bg-fill-hover"><span>{version.hash.slice(0, 10)}</span><Copy className="size-3" /></button></div>
              <div className="mt-4 flex gap-2"><button onClick={() => onPreview(version)} className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full border border-edge bg-canvas px-3 text-[10px] font-medium hover:bg-fill-hover"><Mic className="size-3" />{t("试用此版本")}</button><button onClick={() => onRestore(version)} className="inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-full border border-edge bg-canvas px-3 text-[10px] font-medium hover:bg-fill-hover"><RotateCw className="size-3" />{t("恢复为草稿")}</button></div>
            </article>;
          })}</div>}
        </div>
        <footer className="shrink-0 border-t border-edge-faint px-5 py-4 text-[10px] leading-5 text-fg-faint sm:px-6">{t("已发布版本不可修改；恢复操作只会更新当前草稿。")}</footer>
      </aside>
    </div>
  );
}

function BuilderSection({ icon: Icon, title, description, children }: { icon: typeof Bot; title: string; description: string; children: React.ReactNode }) {
  return <section className="rounded-2xl border border-edge bg-canvas shadow-[0_1px_2px_rgba(0,0,0,0.025)]"><header className="flex items-start gap-3 border-b border-edge-faint px-5 py-4 sm:px-6"><span className="flex size-8 items-center justify-center rounded-lg bg-fill-active text-fg-secondary"><Icon className="size-4" strokeWidth={1.8} /></span><span><h2 className="text-[13px] font-semibold">{title}</h2><p className="mt-1 text-[11px] text-fg-muted">{description}</p></span></header><div className="space-y-5 p-5 sm:p-6">{children}</div></section>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-2 flex items-center justify-between gap-3 text-[11px] font-medium text-fg-secondary"><span>{label}</span>{hint && <span className="font-normal text-fg-faint">{hint}</span>}</span>{children}</label>;
}

const agentEngineLabels = {
  asr: "语音识别 ASR",
  llm: "语言模型 LLM",
  tts: "语音合成 TTS",
} as const satisfies Record<"asr" | "llm" | "tts", MessageKey>;

function AgentEngineSelect({ kind, value, engines, onChange }: {
  kind: "asr" | "llm" | "tts";
  value: string;
  engines: EngineEntry[];
  onChange(value: string): void;
}) {
  const t = useT();
  const candidates = engines.filter(engine => engine.kind === kind);
  const roleDefault = engines.find(engine => engine.roles.includes(kind));
  const known = candidates.some(engine => engine.name === value);
  return (
    <Field label={t(agentEngineLabels[kind])}>
      <select value={value} onChange={event => onChange(event.target.value)} className="builder-input">
        <option value="">{t("自动（{engine}）", { engine: roleDefault?.name ?? t("未配置") })}</option>
        {value && !known ? <option value={value}>{value}</option> : null}
        {candidates.map(engine => <option key={engine.name} value={engine.name}>{engine.healthy ? "●" : "○"} {engine.name}{engine.model ? ` · ${engine.model}` : ""}</option>)}
      </select>
    </Field>
  );
}

function ToggleCard({ checked, onChange, title, description, compact = false }: {
  checked: boolean;
  onChange(checked: boolean): void;
  title: string;
  description?: string;
  compact?: boolean;
}) {
  return (
    <label className={`flex cursor-pointer items-start gap-3 rounded-xl border bg-surface transition hover:border-edge-strong ${checked ? "border-edge-strong ring-1 ring-edge-faint" : "border-edge"} ${compact ? "p-3" : "p-4"}`}>
      <input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} className="mt-0.5 size-4 accent-black" />
      <span><span className="block text-[12px] font-medium">{title}</span>{description ? <span className="mt-1 block text-[11px] leading-5 text-fg-muted">{description}</span> : null}</span>
    </label>
  );
}

function NumericField({ label, value, onChange, step = "1" }: {
  label: string;
  value: string;
  onChange(value: string): void;
  step?: string;
}) {
  return <Field label={label}><input type="number" min="0" step={step} value={value} onChange={event => onChange(event.target.value)} placeholder="—" className="builder-input" /></Field>;
}

const voiceSeparator = "\u0000";

export function voiceOptionValue(voice: Pick<VoiceEntry, "id" | "engine">): string {
  return `${voice.engine ?? ""}${voiceSeparator}${voice.id}`;
}

export function voiceFromOption(value: string, currentTtsEngine = ""): { voice: string; ttsEngine: string } {
  if (!value) return { voice: "", ttsEngine: currentTtsEngine };
  const separator = value.indexOf(voiceSeparator);
  if (separator < 0) return { voice: value, ttsEngine: "" };
  return { ttsEngine: value.slice(0, separator), voice: value.slice(separator + 1) };
}

function VoiceSelect({ draft, voices, onChange }: { draft: AgentDraft; voices: VoiceEntry[]; onChange(value: { voice: string; ttsEngine: string }): void }) {
  const t = useT();
  const selected = draft.voice ? voiceOptionValue({ id: draft.voice, engine: draft.ttsEngine }) : "";
  const known = voices.some(voice => voiceOptionValue(voice) === selected);
  return (
    <select value={selected} onChange={event => onChange(voiceFromOption(event.target.value, draft.ttsEngine))} className="builder-input">
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

function TryItLive({ record, versions, currentPublishedVersion, source, onSourceChange, dirty, onSave, blocked, onClose }: {
  record: AgentRecord;
  versions: AgentPublishedVersion[];
  currentPublishedVersion: number | undefined;
  source: AgentPreviewSource;
  onSourceChange(source: AgentPreviewSource): void;
  dirty: boolean;
  onSave(): Promise<AgentRecord | undefined>;
  blocked: boolean;
  onClose(): void;
}) {
  const t = useT();
  const active = useStudio(state => state.active);
  const connection = useStudio(state => state.connection);
  const sessionState = useStudio(state => state.sessionState);
  const turns = useStudio(state => state.turns);
  const muted = useStudio(state => state.muted);
  const micInputDeviceId = useStudio(state => state.micInputDeviceId);
  const setMicInputDevice = useStudio(state => state.setMicInputDevice);
  const micLevel = useStudio(state => state.micLevel);
  const media = useStudio(state => state.mediaDiagnostics);
  const mediaDetails = formatMediaTransportDetails(media);
  const fallbackMessage = mediaTransportFallbackMessage(media.transportFallbackReason);
  const clearHistory = useStudio(state => state.clearHistory);
  const toast = useStudio(state => state.toast);
  const [starting, setStarting] = useState(false);
  const [sendingText, setSendingText] = useState(false);
  const [textInput, setTextInput] = useState("");
  const { devices: audioInputs, needsPermission: micNeedsPermission, authorizing: micAuthorizing, authorize: authorizeMicrophone } = useMicrophoneDevices();
  const [previewTraceKey, setPreviewTraceKey] = useState<string>();
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
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

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
    if (blocked && source.type === "draft") { toast("error", t("修复以下配置问题后才能发布或试用：")); return; }
    if (active) { toast("error", t("请先结束当前实时对话")); return; }
    const generation = ++operationGeneration.current;
    const current = () => mounted.current && operationGeneration.current === generation;
    previewStarting.current = true;
    setStarting(true);
    setPreviewTraceKey(undefined);
    try {
      const saved = source.type === "draft" && dirty ? await onSave() : record;
      if (!saved) return;
      if (!current()) return;
      clearHistory();
      followLatest.current = true;
      setHasUnseen(false);
      await startConversation(agentPreviewOptions(saved, source));
      if (!current()) return;
      previewOwned.current = true;
      setPreviewTraceKey(agentPreviewTraceKey(source, saved.revision));
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
    if (!previewOwned.current || previewStarting.current || (blocked && source.type === "draft")) return;
    const generation = ++operationGeneration.current;
    const current = () => mounted.current && operationGeneration.current === generation;
    // Keep the old session alive while a dirty draft saves; only replace it once the
    // revision needed by the new preview is durable.
    setStarting(true);
    previewStarting.current = true;
    try {
      const saved = source.type === "draft" && dirty ? await onSave() : record;
      if (!saved || !current()) return;
      setPreviewTraceKey(undefined);
      previewOwned.current = false;
      await stopConversation();
      if (!current()) return;
      clearHistory();
      followLatest.current = true;
      setHasUnseen(false);
      await startConversation(agentPreviewOptions(saved, source));
      if (!current()) return;
      previewOwned.current = true;
      setPreviewTraceKey(agentPreviewTraceKey(source, saved.revision));
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
  const sessionCanAcceptText = sessionState !== "off" && sessionState !== "idle" && sessionState !== "closed";
  const canSubmitText = previewConnected && sessionCanAcceptText && !starting && !sendingText;
  const textWillInterrupt = sessionState !== "listening";
  const submitText = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const submitted = textInput.trim();
    if (!submitted || !canSubmitText) return;
    setSendingText(true);
    try {
      if (await conversationControls()?.submitText(submitted)) {
        setTextInput(current => current.trim() === submitted ? "" : current);
      }
    } catch (error) {
      toast("error", error instanceof Error ? error.message : String(error));
    } finally {
      if (mounted.current) setSendingText(false);
    }
  };
  const stateLabel = isPreview ? t(previewStatusLabel(connection, sessionState)) : t("未开始");
  const latestTurn = turns.at(-1);
  const liveAnnouncement = latestTurn?.status === "completed" && latestTurn.reply ? latestTurn.reply : stateLabel;
  const sourceValue = source.type === "draft" ? "draft" : `published:${source.version}`;
  const sourceDescription = source.type === "draft"
    ? t("使用当前草稿进行实时测试。")
    : t("使用不可变的已发布版本 v{version} 进行测试。", { version: source.version });
  const hasMediaDiagnostics = previewTraceKey === agentPreviewTraceKey(source, record.revision)
    && media.transport !== undefined;
  const transportLabel = media.transport === "webrtc" ? "WebRTC" : "WebSocket";
  // On a phone the transcript is the primary surface: active-session configuration is
  // immutable anyway, and full transport diagnostics remain available through download.
  // Keep those controls detailed in the desktop drawer but collapse them around the log
  // below md so browser chrome plus footer controls cannot squeeze the conversation out.
  return (
    <div className="fixed inset-0 z-50 bg-black/20 backdrop-blur-[1px]" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <aside role="dialog" aria-modal="true" aria-labelledby="try-live-title" className="absolute inset-0 flex flex-col overflow-hidden bg-canvas shadow-[-18px_0_60px_rgba(0,0,0,0.12)] md:left-auto md:w-[430px] md:border-l md:border-edge">
      <header className="shrink-0 border-b border-edge-faint bg-canvas px-4 py-3 sm:px-5 sm:py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="try-live-title" className="text-[14px] font-semibold">{t("实时试用")}</h2>
              <span className={`rounded-full px-2 py-0.5 text-[9px] ${source.type === "draft" ? "bg-fill-active text-fg-muted" : "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300"}`}>{source.type === "draft" ? t("草稿") : `v${source.version}`}</span>
              {hasMediaDiagnostics ? <span className={`rounded-full border px-2 py-0.5 text-[9px] font-medium md:hidden ${media.transport === "webrtc" ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300" : "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/25 dark:bg-sky-500/10 dark:text-sky-300"}`}>{transportLabel}</span> : null}
            </div>
            <p className="mt-1 truncate text-[10px] text-fg-muted">{record.name}</p>
          </div>
          <div className="flex items-center gap-1.5">
            {isPreview ? <button onClick={() => void restart()} disabled={starting || (blocked && source.type === "draft")} title={t("重新开始")} aria-label={t("重新开始")} className="flex size-8 items-center justify-center rounded-lg text-fg-muted hover:bg-fill-hover hover:text-fg disabled:opacity-40"><RotateCw className={`size-3.5 ${starting ? "animate-spin" : ""}`} /></button> : null}
            {hasMediaDiagnostics ? <button type="button" onClick={downloadMediaTrace} className="flex size-8 items-center justify-center rounded-lg text-fg-muted hover:bg-fill-hover hover:text-fg md:hidden" title="Metadata only; no audio or transcript content" aria-label={`media trace · ${t("下载")}`}><Download className="size-3.5" /></button> : null}
            <span className={`mx-1 size-2 rounded-full ${previewConnected ? "bg-emerald-400 shadow-[0_0_0_4px_rgba(52,211,153,0.12)]" : isPreview ? "bg-amber-400 shadow-[0_0_0_4px_rgba(251,191,36,0.12)]" : "bg-edge-hover"}`} />
            <button onClick={onClose} aria-label={t("关闭")} className="flex size-8 items-center justify-center rounded-lg text-fg-muted hover:bg-fill-hover hover:text-fg"><X className="size-4" /></button>
          </div>
        </div>
        <div className={isPreview ? "hidden md:block" : "block"}>
          <div className="mt-3 rounded-xl border border-edge bg-surface p-1 sm:mt-4">
            <select aria-label={t("试用版本")} value={sourceValue} disabled={isPreview || starting} onChange={event => {
              const value = event.target.value;
              onSourceChange(value === "draft" ? { type: "draft" } : { type: "published", version: Number(value.slice("published:".length)) });
            }} className="h-9 w-full rounded-lg bg-canvas px-3 text-[11px] font-medium text-fg outline-none disabled:opacity-60">
              <option value="draft">{t("当前草稿")} · revision {record.revision}</option>
              {versions.map(version => <option key={version.version} value={`published:${version.version}`}>{t("已发布版本")} v{version.version}{currentPublishedVersion === version.version ? ` · ${t("当前发布")}` : ""}</option>)}
            </select>
          </div>
          <p className="mt-2 hidden text-[10px] leading-5 text-fg-faint md:block">{sourceDescription}</p>
        </div>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col bg-surface/45">
        <div ref={messagesRef} onScroll={onMessagesScroll} role="log" aria-label={t("对话记录")} aria-live="off" className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-4 sm:space-y-4 sm:px-5 sm:py-5">
          {turns.length === 0 ? (
            <div className="flex h-full min-h-[240px] flex-col items-center justify-center text-center"><span className="flex size-12 items-center justify-center rounded-full border border-edge bg-canvas"><Mic className="size-5 text-fg-muted" /></span><p className="mt-4 text-[12px] font-medium">{t("在浏览器中与助手对话")}</p><p className="mt-1 max-w-[270px] text-[10px] leading-5 text-fg-faint">{sourceDescription}</p></div>
          ) : turns.map(turn => (
            <div key={turn.id} className="space-y-2.5">
              {turn.transcript && <div className="ml-auto w-fit max-w-[86%] rounded-2xl rounded-br-md bg-ink px-3.5 py-2 text-[11px] leading-5 text-on-ink">{turn.transcript}</div>}
              {turn.reply && <div className={`w-fit max-w-[92%] rounded-2xl rounded-bl-md bg-canvas px-3.5 py-2.5 text-[11px] leading-[1.65] text-fg ring-1 ${turn.status === "interrupted" ? "opacity-60 ring-edge-faint" : turn.status === "failed" ? "ring-red-300/60" : "ring-edge-faint"}`}>{turn.reply}</div>}
              {turn.status === "failed" && <div role="alert" className="flex max-w-[92%] items-start gap-2 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-[10px] leading-5 text-red-700 dark:border-red-500/25 dark:bg-red-500/10 dark:text-red-300"><AlertTriangle className="mt-0.5 size-3 shrink-0" /><span>{turn.failure ?? t("失败")}</span></div>}
            </div>
          ))}
        </div>

        {hasUnseen ? <button onClick={scrollToLatest} className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full border border-edge bg-canvas px-3 py-1.5 text-[10px] font-medium text-fg-secondary shadow-lg hover:bg-fill-hover">{t("有新消息")} ↓</button> : null}
      </div>

      <span className="sr-only" aria-live="polite" aria-atomic="true">{liveAnnouncement}</span>

      <footer className="shrink-0 border-t border-edge-faint bg-canvas p-3 sm:p-4">
        {hasMediaDiagnostics ? (
          <div className="mb-3 hidden space-y-1.5 rounded-lg border border-edge-faint bg-surface px-2.5 py-2 text-[9px] text-fg-faint md:block">
            <div className="flex items-center gap-2">
              <span className={`shrink-0 rounded-full border px-2 py-0.5 font-medium ${media.transport === "webrtc" ? "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/25 dark:bg-emerald-500/10 dark:text-emerald-300" : "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-500/25 dark:bg-sky-500/10 dark:text-sky-300"}`}>{transportLabel}</span>
              <span className="min-w-0 flex-1 truncate" title={mediaDetails}>{mediaDetails}</span>
              <button
                type="button"
                onClick={downloadMediaTrace}
                className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 hover:bg-fill-hover hover:text-fg-secondary"
                title="Metadata only; no audio or transcript content"
                aria-label={`media trace · ${t("下载")}`}
              >
                <Download className="size-3" /> trace
              </button>
            </div>
            {fallbackMessage ? <p className="truncate text-amber-600 dark:text-amber-300" title={t(fallbackMessage)}>{t(fallbackMessage)}</p> : null}
          </div>
        ) : null}
        {hasMediaDiagnostics && fallbackMessage ? <p className="mb-2 truncate text-[9px] text-amber-600 dark:text-amber-300 md:hidden" title={t(fallbackMessage)}>{t(fallbackMessage)}</p> : null}
        {isPreview ? (
          <form onSubmit={event => { void submitText(event); }} className="mb-3 flex items-center gap-2" aria-label={t("输入消息")}>
            <input
              value={textInput}
              onChange={event => setTextInput(event.target.value)}
              maxLength={8_000}
              placeholder={t("输入消息")}
              aria-label={t("输入消息")}
              className="h-10 min-w-0 flex-1 rounded-full border border-edge bg-surface px-4 text-[11px] text-fg outline-none placeholder:text-fg-faint focus:border-edge-hover focus:bg-canvas"
            />
            <button
              type="submit"
              disabled={!canSubmitText || !textInput.trim()}
              title={t(textWillInterrupt ? "打断并发送" : "发送消息")}
              aria-label={t(textWillInterrupt ? "打断并发送" : "发送消息")}
              className={`flex size-10 shrink-0 items-center justify-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-30 ${textWillInterrupt ? "bg-amber-300 text-amber-950 hover:bg-amber-200" : "bg-ink text-on-ink hover:bg-ink-hover"}`}
            >
              <Send className="size-3.5" />
            </button>
          </form>
        ) : null}
        <div className={`${isPreview ? "flex" : "hidden sm:flex"} mb-2 items-center justify-between text-[10px] text-fg-faint sm:mb-3`}>
          <span className="flex items-center gap-2"><span className={`size-1.5 rounded-full ${previewConnected ? "bg-emerald-400" : isPreview ? "bg-amber-400" : "bg-edge-hover"}`} />{isPreview ? stateLabel : t("麦克风将在开始后启用")}</span>
          <span className={`flex h-3 items-end gap-[2px] ${muted ? "opacity-35" : ""}`}>{[0.15, 0.3, 0.5, 0.7, 0.9].map((threshold, index) => <span key={threshold} className={`w-[2px] rounded-full transition ${!muted && micLevel >= threshold ? "bg-emerald-400" : "bg-edge-hover"}`} style={{ height: `${4 + index * 2}px` }} />)}</span>
        </div>
        {isPreview ? (
          <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] gap-2">
            <button onClick={() => { void conversationControls()?.setMuted(!muted); }} disabled={starting} title={muted ? t("已静音") : t("静音")} className={`flex h-10 items-center justify-center gap-2 rounded-full border px-3 text-[11px] font-medium transition disabled:opacity-40 ${muted ? "border-amber-300 bg-amber-50 text-amber-700" : "border-edge bg-canvas text-fg-secondary hover:bg-fill-hover"}`}>{muted ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}<span className="hidden sm:inline">{muted ? t("已静音") : t("静音")}</span></button>
            <button onClick={() => conversationControls()?.interruptPlayback()} disabled={starting || !previewConnected || sessionState !== "speaking"} title={t("停止当前回答（也可以直接开口打断）")} className="flex h-10 items-center justify-center gap-2 rounded-full border border-edge bg-canvas px-3 text-[11px] font-medium text-fg-secondary hover:bg-fill-hover disabled:cursor-not-allowed disabled:opacity-35"><CircleStop className="size-3.5" /><span className="hidden sm:inline">{t("停止回答")}</span></button>
            <button onClick={() => void end()} disabled={starting} className="flex h-10 min-w-0 items-center justify-center gap-2 rounded-full border border-red-200 bg-red-50 px-3 text-[11px] font-medium text-red-600 hover:bg-red-100 disabled:opacity-40 dark:border-red-500/20 dark:bg-red-500/10 dark:text-red-300"><CircleStop className="size-3.5" />{t("结束测试")}</button>
          </div>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-2 sm:grid-cols-1 sm:gap-3">
            <label className="flex h-10 items-center gap-2 rounded-full border border-edge bg-surface px-3 text-[10px] text-fg-muted">
              <Mic className="size-3.5 shrink-0" />
              <span className="shrink-0">{t("麦克风")}</span>
              <select
                aria-label={t("麦克风")}
                value={micInputDeviceId}
                onChange={event => setMicInputDevice(event.target.value)}
                className="min-w-0 flex-1 bg-transparent text-right text-[10px] font-medium text-fg outline-none"
              >
                <option value="">{t("浏览器默认输入")}</option>
                {micInputDeviceId && !audioInputs.some(device => device.id === micInputDeviceId) ? <option value={micInputDeviceId}>{t("已选择的麦克风不可用")}</option> : null}
                {audioInputs.filter(device => device.label !== "").map(device => <option key={device.id} value={device.id}>{device.label}</option>)}
              </select>
            </label>
            {micNeedsPermission ? (
              <button
                type="button"
                onClick={() => void authorizeMicrophone()}
                disabled={micAuthorizing}
                className="self-end rounded-full border border-edge bg-canvas px-2.5 py-1 text-[10px] text-fg-secondary transition hover:bg-fill-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                {t("首次使用需要授权麦克风")}
              </button>
            ) : null}
            <button onClick={() => void start()} disabled={starting || (blocked && source.type === "draft")} className="flex h-10 items-center justify-center gap-2 rounded-full bg-ink px-5 text-[12px] font-medium text-on-ink transition hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-40 sm:h-11 sm:w-full">{starting ? <LoaderCircle className="size-4 animate-spin" /> : <Mic className="size-4" />}{source.type === "draft" && dirty ? t("保存并开始测试") : t("开始测试")}</button>
          </div>
        )}
      </footer>
    </aside>
    </div>
  );
}
