import { useEffect, useState } from "react";
import { listEngines, type EngineEntry } from "../lib/api";
import { useStudio } from "../store";

interface Health {
  ok: boolean;
  protocol: number;
  sessions: number;
}

function EnginesTable() {
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
        <h2 className="text-sm font-medium text-ink-300">引擎（注册表）</h2>
        <div className="flex-1" />
        <button
          onClick={load}
          className="rounded-lg border border-ink-700 px-3 py-1 text-xs text-ink-300 hover:text-ink-100"
        >
          刷新
        </button>
      </div>
      {engines === undefined && <p className="mt-2 text-sm text-ink-500">探测中…</p>}
      {engines === "error" && <p className="mt-2 text-sm text-red-300">无法获取引擎列表（/v1/engines）</p>}
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
                  aria-label={entry.healthy ? "在线" : "离线"}
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
                <th className="pb-2 pr-3 font-normal">实例</th>
                <th className="pb-2 pr-3 font-normal">类型</th>
                <th className="pb-2 pr-3 font-normal">模型</th>
                <th className="pb-2 pr-3 font-normal">角色</th>
                <th className="pb-2 pr-3 font-normal">能力</th>
                <th className="pb-2 font-normal">状态</th>
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
                      aria-label={entry.healthy ? "在线" : "离线"}
                      title={entry.healthy ? "在线" : "离线"}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-3 text-xs text-ink-500">
        实例与角色在网关侧配置（见 docs/engine-registry.md）；地址与密钥不出网关。
      </p>
    </section>
  );
}

export function SettingsPanel() {
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
    <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 md:space-y-8 md:px-8 md:py-10">
      <h1 className="text-2xl font-semibold">设置</h1>

      <section className="rounded-xl border border-ink-700 bg-ink-900 p-5">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium text-ink-300">网关</h2>
          <div className="flex-1" />
          <button
            onClick={probe}
            className="rounded-lg border border-ink-700 px-3 py-1 text-xs text-ink-300 hover:text-ink-100"
          >
            刷新
          </button>
        </div>
        {health === undefined && <p className="mt-2 text-sm text-ink-500">探测中…</p>}
        {health === "unreachable" && <p className="mt-2 text-sm text-red-300">无法连接网关（/healthz）</p>}
        {health !== undefined && health !== "unreachable" && (
          <dl className="mt-3 grid grid-cols-3 gap-3 text-sm">
            <div>
              <dt className="text-xs text-ink-500">状态</dt>
              <dd className="mt-0.5 text-emerald-300">{health.ok ? "在线" : "异常"}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">协议</dt>
              <dd className="mt-0.5">v{health.protocol}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">活动会话</dt>
              <dd className="mt-0.5">{health.sessions}</dd>
            </div>
          </dl>
        )}
        <p className="mt-3 text-xs text-ink-500">
          引擎地址与凭据只存在于网关侧；浏览器仅访问 /v1 契约与 /v1/realtime。
        </p>
      </section>

      <EnginesTable />

      <section className="rounded-xl border border-ink-700 bg-ink-900 p-5">
        <h2 className="text-sm font-medium text-ink-300">端点能力（本次会话协商结果）</h2>
        {!capability && <p className="mt-2 text-sm text-ink-500">尚未开始对话；开始后展示 getUserMedia 协商到的 AEC/NS/AGC 与采样率。</p>}
        {capability && (
          <dl className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 text-sm">
            <div>
              <dt className="text-xs text-ink-500">回声消除</dt>
              <dd className="mt-0.5">{capability.echoCancellation === false ? "关" : "开"}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">降噪</dt>
              <dd className="mt-0.5">{capability.noiseSuppression === false ? "关" : "开"}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">自动增益</dt>
              <dd className="mt-0.5">{capability.autoGainControl === false ? "关" : "开"}</dd>
            </div>
            <div>
              <dt className="text-xs text-ink-500">采集采样率</dt>
              <dd className="mt-0.5">{capability.contextSampleRate}Hz</dd>
            </div>
          </dl>
        )}
        {sessionId && <p className="mt-3 text-xs text-ink-500">会话 {sessionId}</p>}
      </section>

      <section className="rounded-xl border border-ink-700 bg-ink-900 p-5 text-sm leading-relaxed text-ink-300">
        <h2 className="text-sm font-medium">关于</h2>
        <p className="mt-2">
          VoxStudio Web —— 自托管多语言语音工作台。设计与分期见 <code>docs/web-studio.md</code>；
          实时会话契约见 <code>docs/duplex-audio-architecture.md</code>。
        </p>
      </section>
    </div>
  );
}
