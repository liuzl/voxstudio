import { useState } from "react";
import { ConversationPanel } from "./panels/ConversationPanel";
import { PlaceholderPanel } from "./panels/PlaceholderPanel";
import { SettingsPanel } from "./panels/SettingsPanel";
import { useStudio } from "./store";

type Tab = "conversation" | "generate" | "voices" | "library" | "settings";

const tabs: { id: Tab; label: string; icon: string }[] = [
  { id: "conversation", label: "对话", icon: "🎙" },
  { id: "generate", label: "生成", icon: "✍️" },
  { id: "voices", label: "音色", icon: "🎭" },
  { id: "library", label: "素材库", icon: "🗂" },
  { id: "settings", label: "设置", icon: "⚙️" },
];

const connectionLabels: Record<string, { text: string; tone: string }> = {
  disconnected: { text: "未连接", tone: "bg-ink-500" },
  connecting: { text: "连接中", tone: "bg-yellow-400" },
  reconnecting: { text: "重连中", tone: "bg-yellow-400" },
  connected: { text: "已连接", tone: "bg-emerald-400" },
};

export function App() {
  const [tab, setTab] = useState<Tab>("conversation");
  const connection = useStudio(state => state.connection);
  const status = connectionLabels[connection] ?? connectionLabels.disconnected as { text: string; tone: string };

  return (
    <div className="flex h-full">
      <aside className="flex w-52 shrink-0 flex-col border-r border-ink-700 bg-ink-900">
        <div className="px-5 py-5">
          <div className="text-lg font-semibold tracking-wide">VoxStudio</div>
          <div className="text-xs text-ink-300">self-hosted voice studio</div>
        </div>
        <nav className="flex flex-1 flex-col gap-1 px-3">
          {tabs.map(item => (
            <button
              key={item.id}
              onClick={() => setTab(item.id)}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors ${
                tab === item.id ? "bg-ink-700 text-ink-100" : "text-ink-300 hover:bg-ink-800 hover:text-ink-100"
              }`}
            >
              <span aria-hidden>{item.icon}</span>
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-2 border-t border-ink-700 px-5 py-4 text-xs text-ink-300">
          <span className={`inline-block size-2 rounded-full ${status.tone}`} />
          <span>{status.text}</span>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">
        {tab === "conversation" && <ConversationPanel />}
        {tab === "generate" && (
          <PlaceholderPanel
            title="生成"
            phase="Web Studio Phase 3"
            description="文本进、音频出：音色/设计档选择、能力开关（克隆 / 设计 / 快车道）、长文本分块预览、每条提示词的 takes 历史。REST facade 已就绪（/v1/audio/speech 经网关代理），面板随 Phase 3 交付。"
          />
        )}
        {tab === "voices" && (
          <PlaceholderPanel
            title="音色"
            phase="Web Studio Phase 3"
            description="注册音色与设计档，带 SHA-256 指纹徽章与 audit 状态；create / reproduce / verify / audition 流程对齐 CLI 动词。"
          />
        )}
        {tab === "library" && (
          <PlaceholderPanel
            title="素材库"
            phase="Web Studio Phase 4"
            description="每条录音/话语与其转写配对：重转写、行内修正（回馈 ASR 参考集工作流）、一键升级为音色样本。落库为网关侧 SQLite。"
          />
        )}
        {tab === "settings" && <SettingsPanel />}
      </main>
    </div>
  );
}
