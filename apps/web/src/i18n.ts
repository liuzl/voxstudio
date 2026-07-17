import { create } from "zustand";

/**
 * The i18n scheme: the Chinese source string IS the message key. There is exactly one
 * catalog to maintain (English), and `t()` only accepts keys that exist in it — a missing
 * translation is a compile error, not a runtime fallback. `{name}` placeholders are
 * substituted in both languages.
 */
const en = {
  // App shell
  "对话": "Conversation",
  "生成": "Generate",
  "音色": "Voices",
  "素材库": "Library",
  "设置": "Settings",
  "规划中": "planned",
  "主导航": "Main navigation",
  "点击关闭": "Click to dismiss",
  "连接中": "Connecting",
  "重连中": "Reconnecting",
  "会话中": "In session",
  "就绪": "Ready",
  "网关离线": "Gateway offline",
  "探测中": "Probing",
  "每条录音/话语与其转写配对：重转写、行内修正（回馈 ASR 参考集工作流）、一键升级为音色样本。落库为网关侧 SQLite。":
    "Every recording/utterance paired with its transcript: re-transcribe, correct inline (feeding the ASR reference-set workflow), promote to a voice sample in one click. Persisted in gateway-side SQLite.",

  "分期与验收门见 docs/web-studio.md。": "Phases and acceptance gates: docs/web-studio.md.",

  // Conversation panel — session states
  "未开始": "Not started",
  "空闲": "Idle",
  "聆听中": "Listening",
  "你在说话": "You are speaking",
  "断句中": "Finalizing",
  "思考中": "Thinking",
  "回答中": "Speaking",
  "重配置": "Reconfiguring",
  "已结束": "Ended",

  // Conversation panel — timing chips
  "断句": "segment",
  "识别": "asr",
  "首字": "first token",
  "首音": "first audio",
  "开播": "playback",

  // Conversation panel — turn cards
  "思考中…": "Thinking…",
  "已等待 {n}s": "waited {n}s",
  "取消本轮": "cancel this turn",
  "收起耗时": "hide timings",
  "耗时": "timings",
  "复制": "copy",
  "已复制回复内容": "Reply copied",
  "续说 ×{n}": "resumed ×{n}",
  "忽略杂音 ×{n}": "noise ignored ×{n}",
  "（被打断）": "(interrupted)",

  // Conversation panel — mic and controls
  "已静音": "Muted",
  "麦克风电平": "Microphone level",
  "麦克风已静音": "Microphone muted",
  "静音": "Mute",
  "空格键切换": "Space toggles",
  "停止回答": "Stop reply",
  "停止当前回答（也可以直接开口打断）": "Stop the current reply (you can also just start speaking)",
  "结束": "End",
  "本次对话的 TTS 音色": "This session's TTS voice",
  "默认音色": "Default voice",

  // Conversation panel — start card and flow
  "开始对话": "Start conversation",
  "启动中…": "Starting…",
  "语言": "Language",
  "识别语言": "Speech language",
  "中文": "Chinese",
  "自动": "Auto",
  "授权麦克风后进入全双工对话：断句、识别、回答全自动，回答播放时直接开口即可打断，停顿后续说会自动合并。":
    "Grant microphone access to enter a full-duplex conversation: segmentation, recognition, and replies are automatic; just speak over a playing reply to interrupt, and resuming after a pause merges into the same turn.",
  "开口即说 —— 断句、识别、回答全自动；回答播放时直接说话就能打断。":
    "Just speak — segmentation, recognition, and replies are automatic; speaking over a playing reply interrupts it.",
  "重新开始": "Restart",
  "清空记录": "Clear history",
  "启动失败：{error}": "Failed to start: {error}",

  // Voice picker
  "默认（{engine}）": "Default ({engine})",
  "引擎默认": "engine default",

  // Generate panel
  "输入要合成的文本…（⌘+Enter 生成）": "Text to synthesize… (⌘+Enter to generate)",
  "预计 {seconds}s": "est. {seconds}s",
  " · 长文将按 {chunks} 块合成（CLI 长文管线）": " · long text synthesizes in {chunks} chunks (the CLI long-form pipeline)",
  "取消": "Cancel",
  "合成中…": "Synthesizing…",
  "已取消合成": "Synthesis cancelled",
  "生成记录（本页保留最近 30 条，刷新即失）": "Takes (last 30 kept on this page; lost on reload)",
  "还没有生成记录。": "No takes yet.",
  "下载": "Download",
  "删除": "Delete",
  "默认": "default",

  // Voices panel — bank
  "音色库": "Voice bank",
  "全部": "All",
  "我的音色": "My voices",
  "中文·女": "Chinese · F",
  "中文·男": "Chinese · M",
  "英文·女": "English · F",
  "英文·男": "English · M",
  "英文·女(英)": "English · F (UK)",
  "英文·男(英)": "English · M (UK)",
  "搜索…": "Search…",
  "收起注册": "Hide registration",
  "＋ 注册音色": "＋ Register voice",
  "引擎没有返回音色；克隆型引擎可用下方表单注册。": "The engines returned no voices; clone-capable engines accept registration below.",
  "没有匹配的音色。": "No matching voices.",
  "试听 {id}（{engine}）": "Audition {id} ({engine})",
  "停止": "Stop",
  "▶ 合成中…": "▶ Synthesizing…",
  "设为生成音色": "Use on the Generate page",
  "已将 {id} 设为「生成」页的音色": "{id} is now the Generate page's voice",
  "删除（引擎侧参考音一并删除）": "Delete (the engine-side reference audio goes too)",
  "点音色名试听；「用」发送到生成页。": "Click a name to audition; 用 sends it to the Generate page.",
  "用": "use",
  "已删除 {id}": "Deleted {id}",

  // Voices panel — registration
  "注册到克隆型引擎：5–15 秒干净参考音（上传或现场录制）+ 与音频逐字对应的文本；逐字稿可先用 ASR 识别再修正。":
    "Registers on a clone-capable engine: 5–15 s of clean reference audio (uploaded or recorded here) plus its verbatim transcript; draft the transcript with ASR, then correct it.",
  "音色 ID（字母数字._-）": "Voice ID (alphanumeric ._-)",
  "上传文件": "Upload file",
  "现场录制": "Record here",
  "停止（{elapsed}s / 30s）": "Stop ({elapsed}s / 30s)",
  "重新录制": "Re-record",
  "开始录制": "Start recording",
  "参考音的逐字稿…": "Verbatim transcript of the reference audio…",
  "ASR 识别": "Transcribe",
  "识别中…": "Transcribing…",
  "用 ASR 识别参考音，生成逐字稿草稿": "Draft the transcript by running ASR on the reference audio",
  "注册": "Register",
  "注册中…": "Registering…",
  "无法开始录音：{error}": "Could not start recording: {error}",
  "录音太短：参考音需要至少 2 秒（建议 5–15 秒）。": "Recording too short: a reference sample needs at least 2 s (5–15 s recommended).",
  "先录制或选择参考音频，再识别逐字稿。": "Record or choose the reference audio first, then transcribe.",
  "ASR 没有识别出内容；请人工填写逐字稿。": "ASR recognized nothing; please fill in the transcript manually.",
  "注册需要：ID、参考音频（上传或录制）、参考音的逐字稿。": "Registration needs: an ID, reference audio (uploaded or recorded), and its verbatim transcript.",
  "已注册 {id} —— 见音色库首位，可试听或直接用于生成。": "Registered {id} — first in the bank now; audition it or use it to generate.",

  // Voices panel — design profiles
  "设计档（{n}）": "Design profiles ({n})",
  "新建设计档": "New design profile",
  "收起": "Hide",
  "零样本声音设计：描述 + 锚文本 + seed 固定一个可复现的音色；指纹（SHA-256）保证同一运行时可逐字节重现。":
    "Zero-shot voice design: a description + anchor text + seed pin a reproducible voice; the SHA-256 fingerprint guarantees byte-for-byte reproduction on the same runtime.",
  "设计档 ID": "Profile ID",
  "声音描述（英文，如 calm clear female voice）": "Voice description (English, e.g. calm clear female voice)",
  "锚文本（将被固定为该音色的参考语料）": "Anchor text (pinned as the voice's reference corpus)",
  "创建": "Create",
  "生成中…": "Generating…",
  "创建需要：ID、英文声音描述、锚文本、整数 seed。": "Creation needs: an ID, an English voice description, anchor text, and an integer seed.",
  "生成锚音频并登记指纹…": "Generating the anchor audio and recording its fingerprint…",
  "已创建设计档 {id}": "Created design profile {id}",
  "还没有设计档；需要具备 design 能力的引擎（见设置页注册表）。": "No design profiles yet; requires a design-capable engine (see the Settings registry).",
  "未知": "Unknown",
  "引擎身份不可达": "Engine identity unreachable",
  "模型漂移": "Model drift",
  "档案 {profile} ≠ 运行时 {runtime}": "Profile {profile} ≠ runtime {runtime}",
  "清单漂移": "Manifest drift",
  "模型清单指纹与运行时不一致": "The model-manifest fingerprint disagrees with the runtime",
  "与运行时一致": "Matches runtime",
  "模型与清单指纹均一致": "Model and manifest fingerprints both match",
  "试听": "Audition",
  "■ 停止": "■ Stop",
  "验证": "Verify",
  "验证中…": "Verifying…",
  "同参数重新生成一次并比对音频指纹（可逐字节重现性检验）": "Regenerate once with identical parameters and compare audio fingerprints (a byte-for-byte reproducibility check)",
  "{id} 缺少锚文本或指纹，无法验证。": "{id} lacks anchor text or a fingerprint; cannot verify.",
  "正在重现 {id}（同参数重新生成并比对指纹）…": "Reproducing {id} (regenerating with identical parameters and comparing fingerprints)…",
  "✓ {id} 可逐字节重现（指纹一致）": "✓ {id} reproduces byte-for-byte (fingerprints match)",
  "✗ {id} 重现结果指纹不一致 —— 运行时已漂移或参数缺失": "✗ {id} reproduction fingerprint mismatch — the runtime drifted or parameters are missing",
  "无指纹": "no fingerprint",
  "（点击复制）": " (click to copy)",

  // Settings panel
  "网关": "Gateway",
  "探测中…": "Probing…",
  "无法连接网关（/healthz）": "Cannot reach the gateway (/healthz)",
  "状态": "Status",
  "协议": "Protocol",
  "活动会话": "Active sessions",
  "在线": "online",
  "异常": "unhealthy",
  "离线": "offline",
  "刷新": "Refresh",
  "引擎地址与凭据只存在于网关侧；浏览器仅访问 /v1 契约与 /v1/realtime。":
    "Engine addresses and credentials live only on the gateway; the browser touches only the /v1 contract and /v1/realtime.",
  "引擎（注册表）": "Engines (registry)",
  "无法获取引擎列表（/v1/engines）": "Could not fetch the engine list (/v1/engines)",
  "实例": "Instance",
  "类型": "Kind",
  "模型": "Model",
  "角色": "Roles",
  "能力": "Capabilities",
  "实例与角色在网关侧配置（见 docs/engine-registry.md）；地址与密钥不出网关。":
    "Instances and roles are configured gateway-side (see docs/engine-registry.md); addresses and keys never leave it.",
  "端点能力（本次会话协商结果）": "Endpoint capabilities (negotiated this session)",
  "尚未开始对话；开始后展示 getUserMedia 协商到的 AEC/NS/AGC 与采样率。":
    "No conversation yet; once one starts, the AEC/NS/AGC and sample rate negotiated by getUserMedia show here.",
  "回声消除": "Echo cancellation",
  "降噪": "Noise suppression",
  "自动增益": "Auto gain",
  "采集采样率": "Capture sample rate",
  "开": "on",
  "关": "off",
  "会话 {id}": "Session {id}",
  "关于": "About",
  "VoxStudio Web —— 自托管多语言语音工作台。设计与分期见 docs/web-studio.md；实时会话契约见 docs/duplex-audio-architecture.md。":
    "VoxStudio Web — a self-hosted multilingual voice studio. Design and phases: docs/web-studio.md; the realtime session contract: docs/duplex-audio-architecture.md.",
  "自动（跟随浏览器）": "Auto (follow browser)",

  // REST facade error verbs (lib/api.ts)
  "获取音色列表": "Fetching the voice list",
  "创建设计档": "Creating the design profile",
  "获取引擎列表": "Fetching the engine list",
  "注册音色": "Registering the voice",
  "删除音色": "Deleting the voice",
  "合成": "Synthesis",
  "{what}失败（{status}{detail}）": "{what} failed ({status}{detail})",
} as const;

export type MessageKey = keyof typeof en;
export type Locale = "auto" | "zh" | "en";

const storageKey = "voxstudio.locale";
const hasDom = typeof document !== "undefined";

function detect(): "zh" | "en" {
  if (typeof navigator === "undefined") return "zh";
  return (navigator.language ?? "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function resolveLocale(locale: Locale): "zh" | "en" {
  return locale === "auto" ? detect() : locale;
}

interface I18nState {
  locale: Locale;
  setLocale(locale: Locale): void;
}

export const useI18n = create<I18nState>(set => ({
  locale: (typeof localStorage !== "undefined" && (localStorage.getItem(storageKey) as Locale)) || "auto",
  setLocale: locale => {
    if (typeof localStorage !== "undefined") localStorage.setItem(storageKey, locale);
    if (hasDom) document.documentElement.lang = resolveLocale(locale) === "zh" ? "zh-CN" : "en";
    set({ locale });
  },
}));

if (hasDom) {
  document.documentElement.lang = resolveLocale(useI18n.getState().locale) === "zh" ? "zh-CN" : "en";
}

function format(template: string, params?: Record<string, string | number>): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match);
}

/** Translate a message; usable outside React (reads the store imperatively). */
export function t(key: MessageKey, params?: Record<string, string | number>): string {
  const locale = resolveLocale(useI18n.getState().locale);
  return format(locale === "zh" ? key : en[key], params);
}

/** React hook version: subscribes to locale changes so components re-render on switch. */
export function useT(): typeof t {
  useI18n(state => state.locale);
  return t;
}
