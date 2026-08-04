import { RefreshCw, Settings2 } from "lucide-react";
import { useEffect, useState } from "react";
import { AccountSection } from "./AccountSection";
import { PageHeader, PageShell, StatusBadge } from "../components/StudioPage";
import { listEngines, type EngineEntry } from "../lib/api";
import { useStudio } from "../store";
import { useTheme, type ThemePreference } from "../theme";
import { localeNames, uiLocales, useI18n, useT, type Locale } from "../i18n";

interface Health {
  ok: boolean;
  protocol: number;
  /** Self-hosted only: a hosted deployment does not disclose its live traffic. */
  sessions?: number;
}

function EnginesTable() {
  const t = useT();
  const [engines, setEngines] = useState<EngineEntry[] | "error" | undefined>(undefined);

  const load = () => {
    setEngines(undefined);
    listEngines()
      .then(setEngines)
      .catch(() => setEngines("error"));
  };

  useEffect(load, []);

  return (
    <section className="rounded-xl border border-ink-700 bg-ink-900 p-5">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-medium text-ink-300">{t("引擎（注册表）")}</h2>
        <div className="flex-1" />
        <button
          onClick={load}
          className="rounded-lg border border-ink-700 px-3 py-1 text-xs text-ink-300 hover:text-ink-100"
        >
          {t("刷新")}
        </button>
      </div>
      {engines === undefined && <p className="mt-2 text-sm text-ink-500">{t("探测中…")}</p>}
      {engines === "error" && <p className="mt-2 text-sm text-red-300">{t("无法获取引擎列表（/v1/engines）")}</p>}
      {/* A six-column table has no honest 390px rendering; small screens get cards. */}
      {Array.isArray(engines) && (
        <div className="mt-3 space-y-2 md:hidden">
          {engines.map(entry => (
            <div key={entry.name} className="rounded-lg border border-ink-700/60 bg-ink-800/40 px-3 py-2.5">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">{entry.name}</span>
                <span className="text-xs text-ink-500">{entry.kind ?? ""}</span>
                <div className="flex-1" />
                <span
                  className={`inline-block size-2 rounded-full ${entry.healthy ? "bg-emerald-400" : "bg-red-400"}`}
                  role="img"
                  aria-label={entry.healthy ? t("在线") : t("离线")}
                />
              </div>
              <div className="mt-1 text-xs text-ink-300">{entry.model || "—"}</div>
              {(entry.roles.length > 0 || entry.capabilities.length > 0) && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {entry.roles.map(role => (
                    <span key={role} className="rounded bg-accent-600/20 px-1.5 py-0.5 text-[10px] text-accent-500">{role}</span>
                  ))}
                  {entry.capabilities.map(capability => (
                    <span key={capability} className="rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-300">{capability}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {Array.isArray(engines) && (
        <div className="mt-3 hidden overflow-x-auto md:block">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs text-ink-500">
                <th className="pb-2 pr-3 font-normal">{t("实例")}</th>
                <th className="pb-2 pr-3 font-normal">{t("类型")}</th>
                <th className="pb-2 pr-3 font-normal">{t("模型")}</th>
                <th className="pb-2 pr-3 font-normal">{t("角色")}</th>
                <th className="pb-2 pr-3 font-normal">{t("能力")}</th>
                <th className="pb-2 font-normal">{t("状态")}</th>
              </tr>
            </thead>
            <tbody>
              {engines.map(entry => (
                <tr key={entry.name} className="border-t border-ink-700/60">
                  <td className="py-2 pr-3 font-medium">{entry.name}</td>
                  <td className="py-2 pr-3 text-ink-300">{entry.kind ?? "—"}</td>
                  <td className="py-2 pr-3 text-ink-300">{entry.model || "—"}</td>
                  <td className="py-2 pr-3">
                    {entry.roles.length === 0 ? <span className="text-ink-500">—</span> : entry.roles.map(role => (
                      <span key={role} className="mr-1 rounded bg-accent-600/20 px-1.5 py-0.5 text-[10px] text-accent-500">{role}</span>
                    ))}
                  </td>
                  <td className="py-2 pr-3">
                    {entry.capabilities.length === 0 ? <span className="text-ink-500">—</span> : entry.capabilities.map(capability => (
                      <span key={capability} className="mr-1 rounded bg-ink-800 px-1.5 py-0.5 text-[10px] text-ink-300">{capability}</span>
                    ))}
                  </td>
                  <td className="py-2">
                    <span
                      className={`inline-block size-2 rounded-full ${entry.healthy ? "bg-emerald-400" : "bg-red-400"}`}
                      role="img"
                      aria-label={entry.healthy ? t("在线") : t("离线")}
                      title={entry.healthy ? t("在线") : t("离线")}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-ink-500">
        {t("实例与角色在网关侧配置（见 docs/engine-registry.md）；地址与密钥不出网关。")}
      </p>
    </section>
  );
}

/** Etiquette (docs/conversation-etiquette.md): applies to sessions started after saving. */
function EtiquetteSection() {
  const t = useT();
  const welcome = useStudio(state => state.welcome);
  const nudgeAfterSeconds = useStudio(state => state.nudgeAfterSeconds);
  const setWelcome = useStudio(state => state.setWelcome);
  const setNudgeAfterSeconds = useStudio(state => state.setNudgeAfterSeconds);
  const studioTools = useStudio(state => state.studioTools);
  const setStudioTools = useStudio(state => state.setStudioTools);

  return (
    <section className="rounded-xl border border-ink-700 bg-ink-900 p-5">
      <h2 className="text-sm font-medium text-ink-300">{t("对话礼仪")}</h2>
      <div className="mt-3 space-y-3">
        <label className="block">
          <span className="text-xs text-ink-500">{t("开场白（留空则不说）")}</span>
          <input
            type="text"
            value={welcome}
            onChange={event => setWelcome(event.target.value)}
            placeholder={t("例如：你好，我在，请讲。")}
            className="mt-1 w-full rounded border border-ink-700 bg-ink-800 px-2 py-1.5 text-sm text-ink-100 placeholder:text-ink-600"
          />
        </label>
        <label className="block">
          <span className="text-xs text-ink-500">{t("静默追问（秒，0 关闭）")}</span>
          <input
            type="number"
            min={0}
            step={5}
            value={nudgeAfterSeconds}
            onChange={event => setNudgeAfterSeconds(Math.max(0, Number(event.target.value) || 0))}
            className="mt-1 w-28 rounded border border-ink-700 bg-ink-800 px-2 py-1.5 text-sm text-ink-100"
          />
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={studioTools}
            onChange={event => setStudioTools(event.target.checked)}
            className="h-4 w-4 rounded border-ink-700 bg-ink-800"
          />
          <span className="text-xs text-ink-500">{t("工作台语音工具（存音色、重念、记发音等，说话就能操作）")}</span>
        </label>
      </div>
      <p className="mt-3 text-xs text-ink-500">
        {t("开场白在会话开始时先说、可打断；静默追问在回答播完后你不说话时轻声追问一次。下次开始对话生效。")}
      </p>
    </section>
  );
}

export function SettingsPanel() {
  const t = useT();
  const locale = useI18n(state => state.locale);
  const setLocale = useI18n(state => state.setLocale);
  const themePreference = useTheme(state => state.preference);
  const setThemePreference = useTheme(state => state.setPreference);
  const [health, setHealth] = useState<Health | "unreachable" | undefined>(undefined);
  const capability = useStudio(state => state.capability);
  const sessionId = useStudio(state => state.sessionId);

  const probe = () => {
    setHealth(undefined);
    fetch("/healthz")
      .then(async response => {
        setHealth(response.ok ? ((await response.json()) as Health) : "unreachable");
      })
      .catch(() => setHealth("unreachable"));
  };

  useEffect(probe, []);

  return (
    <PageShell>
      <PageHeader
        title={t("运行时与设置")}
        description={t("查看运行状态、引擎能力，并管理对话与界面偏好。")}
        badge={(
          <StatusBadge tone={health !== undefined && health !== "unreachable" && health.ok ? "success" : "neutral"}>
            {health === undefined ? t("探测中") : health === "unreachable" ? t("网关离线") : health.ok ? t("在线") : t("异常")}
          </StatusBadge>
        )}
      />

      <section className="rounded-xl border border-ink-700 bg-ink-900 p-5">
        <div className="flex items-center gap-3">
          <span className="flex size-8 items-center justify-center rounded-lg bg-ink-800">
            <Settings2 className="size-4 text-ink-500" />
          </span>
          <div>
            <h2 className="text-[13px] font-medium text-ink-100">{t("网关")}</h2>
            <p className="text-[10px] text-ink-500">{t("实时会话与 REST 门面")}</p>
          </div>
          <div className="flex-1" />
          <button
            onClick={probe}
            className="flex size-8 items-center justify-center rounded-lg border border-ink-700 text-ink-500 hover:bg-ink-800 hover:text-ink-100"
            title={t("刷新")}
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>
        {health === undefined && <p className="mt-2 text-sm text-ink-500">{t("探测中…")}</p>}
        {health === "unreachable" && <p className="mt-2 text-sm text-red-300">{t("无法连接网关（/healthz）")}</p>}
        {health !== undefined && health !== "unreachable" && (
          <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-xs text-ink-500">{t("状态")}</dt>
              <dd className="mt-0.5 text-emerald-300">{health.ok ? t("在线") : t("异常")}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">{t("协议")}</dt>
              <dd className="mt-0.5">v{health.protocol}</dd>
            </div>
            {health.sessions !== undefined && (
              <div>
                <dt className="text-xs text-ink-500">{t("活动会话")}</dt>
                <dd className="mt-0.5">{health.sessions}</dd>
              </div>
            )}
          </dl>
        )}
        <p className="mt-3 text-xs text-ink-500">
          {t("引擎地址与凭据只存在于网关侧；浏览器仅访问 /v1 契约与 /v1/realtime。")}
        </p>
      </section>

      <EnginesTable />

      <section className="rounded-xl border border-ink-700 bg-ink-900 p-5">
        <h2 className="text-sm font-medium text-ink-300">{t("端点能力（本次会话协商结果）")}</h2>
        {!capability && <p className="mt-2 text-sm text-ink-500">{t("尚未开始对话；开始后展示 getUserMedia 协商到的 AEC/NS/AGC 与采样率。")}</p>}
        {capability && (
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5 text-sm">
            <div className="min-w-0">
              <dt className="text-xs text-ink-500">{t("输入设备")}</dt>
              <dd className="mt-0.5 truncate" title={capability.deviceLabel ?? t("系统默认输入")}>
                {capability.deviceLabel ?? t("系统默认输入")}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">{t("回声消除")}</dt>
              <dd className="mt-0.5">{capability.echoCancellation === false ? t("关") : t("开")}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">{t("降噪")}</dt>
              <dd className="mt-0.5">{capability.noiseSuppression === false ? t("关") : t("开")}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">{t("自动增益")}</dt>
              <dd className="mt-0.5">{capability.autoGainControl === false ? t("关") : t("开")}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">{t("采集采样率")}</dt>
              <dd className="mt-0.5">{capability.trackSampleRate ?? "?"}Hz → {capability.contextSampleRate}Hz</dd>
            </div>
          </dl>
        )}
        {sessionId && <p className="mt-3 text-xs text-ink-500">{t("会话 {id}", { id: sessionId })}</p>}
      </section>

      <EtiquetteSection />

      {/* Hosted deployments only; renders nothing in a self-hosted studio. */}
      <AccountSection />

      <section className="rounded-xl border border-ink-700 bg-ink-900 p-5">
        <h2 className="text-sm font-medium text-ink-300">{t("语言")}</h2>
        <select
          value={locale}
          onChange={event => setLocale(event.target.value as Locale)}
          className="mt-3 rounded border border-ink-700 bg-ink-800 px-2 py-1.5 text-sm text-ink-100"
        >
          <option value="auto">{t("自动（跟随浏览器）")}</option>
          {uiLocales.map(code => (
            <option key={code} value={code}>{localeNames[code]}</option>
          ))}
        </select>
      </section>

      <section className="rounded-xl border border-ink-700 bg-ink-900 p-5">
        <h2 className="text-sm font-medium text-ink-300">{t("外观")}</h2>
        <select
          value={themePreference}
          onChange={event => setThemePreference(event.target.value as ThemePreference)}
          className="mt-3 rounded border border-ink-700 bg-ink-800 px-2 py-1.5 text-sm text-ink-100"
        >
          <option value="system">{t("跟随系统")}</option>
          <option value="light">{t("浅色")}</option>
          <option value="dark">{t("深色")}</option>
        </select>
      </section>

      <section className="rounded-xl border border-ink-700 bg-ink-900 p-5 text-sm leading-relaxed text-ink-300">
        <h2 className="text-sm font-medium">{t("关于")}</h2>
        <p className="mt-2">
          {t("VoxStudio Web —— 自托管多语言语音工作台。设计与分期见 docs/web-studio.md；实时会话契约见 docs/duplex-audio-architecture.md。")}
        </p>
      </section>
    </PageShell>
  );
}
