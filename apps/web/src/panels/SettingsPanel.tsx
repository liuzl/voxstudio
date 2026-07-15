import { useEffect, useState } from "react";
import { useStudio } from "../store";

interface Health {
  ok: boolean;
  protocol: number;
  sessions: number;
}

export function SettingsPanel() {
  const [health, setHealth] = useState<Health | "unreachable" | undefined>(undefined);
  const capability = useStudio(state => state.capability);
  const sessionId = useStudio(state => state.sessionId);

  useEffect(() => {
    let cancelled = false;
    fetch("/healthz")
      .then(async response => {
        if (!cancelled) setHealth(response.ok ? ((await response.json()) as Health) : "unreachable");
      })
      .catch(() => {
        if (!cancelled) setHealth("unreachable");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-6 md:space-y-8 md:px-8 md:py-10">
      <h1 className="text-2xl font-semibold">设置</h1>

      <section className="rounded-xl border border-ink-700 bg-ink-900 p-5">
        <h2 className="text-sm font-medium text-ink-300">网关</h2>
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
          VoxStudio Web —— 自托管中文优先语音工作台。设计与分期见 <code>docs/web-studio.md</code>；
          实时会话契约见 <code>docs/duplex-audio-architecture.md</code>。
        </p>
      </section>
    </div>
  );
}
