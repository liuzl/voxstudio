import { useEffect, useRef, useState } from "react";
import {
  BriefcaseBusiness,
  CalendarDays,
  ChevronDown,
  Copy,
  Headphones,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Sparkles,
  Trash2,
  TrendingUp,
  UserRoundSearch,
} from "lucide-react";
import { useT } from "../i18n";
import { useStudio } from "../store";

const agentNameKey = "voxstudio.agent.name";
const agentId = "voxstudio-default-agent";

const templates = [
  {
    name: "客服助手",
    description: "解决客户问题",
    icon: Headphones,
    color: "bg-[#fff1e8] text-[#ee6d32]",
    width: 180,
  },
  {
    name: "销售顾问",
    description: "推动客户完成购买",
    icon: TrendingUp,
    color: "bg-[#eaf7ee] text-[#39915a]",
    width: 164,
  },
  {
    name: "预约助理",
    description: "安排和管理预约",
    icon: CalendarDays,
    color: "bg-[#fff4d8] text-[#bd8514]",
    width: 216,
  },
  {
    name: "个人助理",
    description: "协助处理日常事务",
    icon: BriefcaseBusiness,
    color: "bg-[#f1ebff] text-[#7d55c7]",
    width: 182,
  },
  {
    name: "线索筛选",
    description: "筛选和跟进入站线索",
    icon: UserRoundSearch,
    color: "bg-[#e9f1ff] text-[#4c77c6]",
    width: 176,
  },
] as const;

type Template = (typeof templates)[number];

export function AgentsPanel({ onOpenAgent }: { onOpenAgent: () => void }) {
  const t = useT();
  const toast = useStudio(state => state.toast);
  const [query, setQuery] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [agentVisible, setAgentVisible] = useState(true);
  const [agentName, setAgentName] = useState(
    () => localStorage.getItem(agentNameKey) || t("默认语音助手"),
  );
  const [draftName, setDraftName] = useState(agentName);
  const createRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const closeMenus = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!createRef.current?.contains(target)) setCreateOpen(false);
      if (!actionsRef.current?.contains(target)) setActionsOpen(false);
    };
    document.addEventListener("pointerdown", closeMenus);
    return () => document.removeEventListener("pointerdown", closeMenus);
  }, []);

  const saveName = () => {
    const next = draftName.trim();
    if (!next) return;
    setAgentName(next);
    localStorage.setItem(agentNameKey, next);
    setRenameOpen(false);
    toast("info", t("助手名称已更新"));
  };

  const useTemplate = (template?: Template) => {
    setCreateOpen(false);
    setAgentVisible(true);
    if (template) {
      setAgentName(t(template.name));
      localStorage.setItem(agentNameKey, t(template.name));
      toast("info", t("已载入「{name}」模板", { name: t(template.name) }));
    }
    onOpenAgent();
  };

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const hasMatch = agentVisible && agentName.toLocaleLowerCase().includes(normalizedQuery);

  return (
    <div className="mx-auto w-full max-w-[1276px] px-4 pb-16 pt-8 sm:px-8 sm:pt-12 lg:px-12 lg:pt-14">
      <header>
        <div className="flex items-center gap-2.5">
          <h1 className="text-[23px] font-semibold tracking-[-0.035em] text-[#11110f] sm:text-[26px]">
            {t("语音助手")}
          </h1>
          <span className="rounded-full border border-[#f2a56f] bg-[#fffaf6] px-2 py-0.5 text-[10px] font-medium text-[#d66b2e]">
            Beta
          </span>
        </div>
        <p className="mt-1 text-[14px] text-[#85858a]">{t("创建、配置和测试实时语音助手。")}</p>
      </header>

      <div className="mt-7 flex items-center gap-2.5 sm:mt-8 sm:justify-between lg:mt-[26px]">
        <label className="relative min-w-0 flex-1 sm:max-w-[282px]">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[#a2a29b]" strokeWidth={1.8} />
          <input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t("搜索助手")}
            className="h-10 w-full rounded-lg border border-[#e1e1dc] bg-[#fbfbfa] pl-9 pr-3 text-[13px] text-[#20201e] shadow-[0_1px_1px_rgba(0,0,0,0.02)] placeholder:text-[#a2a29b]"
          />
        </label>

        <div ref={createRef} className="relative flex shrink-0">
          <button
            onClick={() => useTemplate()}
            className="inline-flex h-10 min-w-[120px] items-center justify-center rounded-l-full bg-[#090909] px-5 text-[14px] font-medium text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition hover:bg-[#252523] active:scale-[0.98]"
          >
            <span className="hidden sm:inline">{t("创建助手")}</span>
            <span className="sm:hidden">{t("创建")}</span>
          </button>
          <button
            aria-label={t("显示模板")}
            aria-expanded={createOpen}
            onClick={() => setCreateOpen(open => !open)}
            className="flex h-10 w-10 items-center justify-center rounded-r-full border-l border-white/20 bg-[#090909] text-white shadow-[0_1px_2px_rgba(0,0,0,0.18)] transition hover:bg-[#252523]"
          >
            <ChevronDown className={`size-3.5 transition-transform ${createOpen ? "rotate-180" : ""}`} />
          </button>

          {createOpen && (
            <div className="absolute right-0 top-12 z-30 w-[300px] overflow-hidden rounded-xl border border-[#e2e2dd] bg-white p-1.5 shadow-[0_14px_40px_rgba(0,0,0,0.13)]">
              <button
                onClick={() => useTemplate()}
                className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-[#f5f5f2]"
              >
                <span className="flex size-8 items-center justify-center rounded-full bg-[#f1f1ed] text-[#50504b]">
                  <Sparkles className="size-4" strokeWidth={1.8} />
                </span>
                <span>
                  <span className="block text-[13px] font-medium text-[#20201e]">{t("空白助手")}</span>
                  <span className="mt-0.5 block text-[11px] text-[#96968e]">{t("从零开始")}</span>
                </span>
              </button>
              <div className="mx-2 my-1.5 border-t border-[#ecece8]" />
              <div className="px-2.5 pb-1 pt-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-[#a0a098]">
                {t("模板")}
              </div>
              {templates.map(template => {
                const Icon = template.icon;
                return (
                  <button
                    key={template.name}
                    onClick={() => useTemplate(template)}
                    className="flex w-full items-center gap-3 rounded-lg px-2.5 py-2 text-left hover:bg-[#f5f5f2]"
                  >
                    <span className={`flex size-8 items-center justify-center rounded-full ${template.color}`}>
                      <Icon className="size-4" strokeWidth={1.8} />
                    </span>
                    <span>
                      <span className="block text-[13px] font-medium text-[#20201e]">{t(template.name)}</span>
                      <span className="mt-0.5 block text-[11px] text-[#96968e]">{t(template.description)}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <div className="mt-5 lg:mt-[34px]">
        <div className="grid grid-cols-[minmax(0,1fr)_100px_34px] items-center border-b border-[#e4e4e0] px-2 pb-2 text-[12px] text-[#85858a] sm:grid-cols-[54%_minmax(0,1fr)_44px]">
          <span>{t("助手")}</span>
          <span>{t("更新时间")}</span>
          <span />
        </div>

        {hasMatch ? (
          <div
            role="button"
            tabIndex={0}
            onClick={onOpenAgent}
            onKeyDown={event => {
              if (event.key === "Enter" || event.key === " ") onOpenAgent();
            }}
            className="group grid min-h-[54px] cursor-pointer grid-cols-[minmax(0,1fr)_100px_34px] items-center border-b border-[#e8e8e4] px-2 transition hover:bg-[#fafaf8] sm:grid-cols-[54%_minmax(0,1fr)_44px]"
          >
            <span className="flex min-w-0 items-center gap-3">
              <span
                aria-hidden
                className="size-6 shrink-0 rounded-full border border-black/10 shadow-[inset_0_0_8px_rgba(255,255,255,0.22)]"
                style={{
                  background:
                    "radial-gradient(circle at 68% 26%, #d6bcff 0 5%, transparent 21%), radial-gradient(circle at 28% 70%, #6439a3 0 8%, transparent 34%), radial-gradient(circle at 72% 76%, #334b72 0 5%, transparent 28%), #101019",
                }}
              />
              <span className="truncate text-[14px] font-medium text-[#20201e]">{agentName}</span>
            </span>
            <span className="text-[13px] text-[#85858a]">{t("刚刚")}</span>
            <span ref={actionsRef} className="relative justify-self-end">
              <button
                aria-label={t("助手操作")}
                aria-expanded={actionsOpen}
                onClick={event => {
                  event.stopPropagation();
                  setActionsOpen(open => !open);
                }}
                className="flex size-8 items-center justify-center rounded-lg text-[#888881] opacity-70 transition hover:bg-[#eeeeea] hover:text-[#20201e] group-hover:opacity-100"
              >
                <MoreHorizontal className="size-4.5" />
              </button>
              {actionsOpen && (
                <div className="absolute right-0 top-9 z-20 w-44 rounded-xl border border-[#e2e2dd] bg-white p-1.5 shadow-[0_12px_32px_rgba(0,0,0,0.12)]">
                  <button
                    onClick={event => {
                      event.stopPropagation();
                      void navigator.clipboard?.writeText(agentId);
                      setActionsOpen(false);
                      toast("info", t("已复制助手 ID"));
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12px] text-[#33332f] hover:bg-[#f5f5f2]"
                  >
                    <Copy className="size-3.5 text-[#85857e]" />
                    {t("复制助手 ID")}
                  </button>
                  <button
                    onClick={event => {
                      event.stopPropagation();
                      setDraftName(agentName);
                      setRenameOpen(true);
                      setActionsOpen(false);
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12px] text-[#33332f] hover:bg-[#f5f5f2]"
                  >
                    <Pencil className="size-3.5 text-[#85857e]" />
                    {t("重命名")}
                  </button>
                  <button
                    onClick={event => {
                      event.stopPropagation();
                      setAgentVisible(false);
                      setActionsOpen(false);
                      toast("info", t("已从列表移除助手"));
                    }}
                    className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[12px] text-[#c94c43] hover:bg-[#fff3f1]"
                  >
                    <Trash2 className="size-3.5" />
                    {t("删除助手")}
                  </button>
                </div>
              )}
            </span>
          </div>
        ) : (
          <div className="flex min-h-24 items-center justify-center border-b border-[#ecece8] text-[12px] text-[#96968f]">
            {query ? t("没有匹配的助手。") : t("还没有助手。")}
          </div>
        )}
      </div>

      <div className="mt-4 flex flex-col items-start gap-2.5 sm:flex-row sm:flex-wrap">
        {templates.map(template => {
          const Icon = template.icon;
          return (
            <button
              key={template.name}
              onClick={() => useTemplate(template)}
              style={{ minWidth: template.width }}
              className="inline-flex h-10 w-full items-center gap-2 rounded-full border border-[#dededb] bg-white py-1 pl-1 pr-4 text-[13px] font-medium text-[#242422] shadow-[0_1px_1px_rgba(0,0,0,0.02)] transition hover:border-[#c9c9c4] hover:bg-[#fafaf8] active:scale-[0.98] sm:w-auto"
            >
              <span className={`flex size-8 items-center justify-center rounded-full ${template.color}`}>
                <Icon className="size-4" strokeWidth={1.8} />
              </span>
              {t(template.name)}
            </button>
          );
        })}
        <button
          onClick={() => useTemplate()}
          className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-full border border-[#dededb] bg-white px-4 text-[13px] font-medium text-[#242422] shadow-[0_1px_1px_rgba(0,0,0,0.02)] transition hover:border-[#c9c9c4] hover:bg-[#fafaf8] active:scale-[0.98] sm:w-40"
        >
          <Plus className="size-[18px] text-[#55555a]" strokeWidth={1.8} />
          {t("从零开始")}
        </button>
      </div>

      {renameOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 px-4 backdrop-blur-[1px]"
          onMouseDown={event => {
            if (event.target === event.currentTarget) setRenameOpen(false);
          }}
        >
          <div role="dialog" aria-modal="true" aria-labelledby="rename-agent-title" className="w-full max-w-[400px] rounded-2xl border border-[#e3e3de] bg-white p-5 shadow-[0_20px_60px_rgba(0,0,0,0.16)]">
            <h2 id="rename-agent-title" className="text-[16px] font-semibold tracking-[-0.02em] text-[#20201e]">
              {t("重命名助手")}
            </h2>
            <p className="mt-1 text-[12px] text-[#8a8a83]">{t("输入一个容易识别的助手名称。")}</p>
            <input
              autoFocus
              value={draftName}
              onChange={event => setDraftName(event.target.value)}
              onKeyDown={event => {
                if (event.key === "Enter") saveName();
                if (event.key === "Escape") setRenameOpen(false);
              }}
              className="mt-5 h-10 w-full rounded-lg border border-[#deded8] bg-[#fbfbfa] px-3 text-[13px]"
            />
            <div className="mt-5 flex justify-end gap-2">
              <button onClick={() => setRenameOpen(false)} className="h-9 rounded-lg border border-[#deded9] px-3.5 text-[12px] font-medium text-[#55554f] hover:bg-[#f5f5f2]">
                {t("取消")}
              </button>
              <button onClick={saveName} disabled={!draftName.trim()} className="h-9 rounded-lg bg-[#171715] px-3.5 text-[12px] font-medium text-white hover:bg-[#292926] disabled:opacity-40">
                {t("保存")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
