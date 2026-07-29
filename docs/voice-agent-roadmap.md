# 语音 Agent 路线图：多模态输入 / agent 执行器 / 对话-行动一体化

三个方向的评估与调研记录（2026-07-28 立项，07-29 完成全部前置调研）。
机器与部署细节在内部运维仓，此处只保留架构结论。当前状态见文末。

## 方向 1：LLM 原生音频输入（双通道用户 turn）

**事实基础**：本地对话 LLM（Gemma 4 12B）是原生多模态模型；2026-06-13
的内部实测确认 llama.cpp 对其 `input_audio` content 原生可用（音频经
mmproj projector 编码为 token），仅 video 需要 MLX 后端或抽帧。当前对话
所用的 llama-server 实例未挂 mmproj——启用只差一个启动参数。

**价值**：不是替代 ASR，而是补回 ASR 丢掉的一层——语气/情绪、迟疑与
笑声、非语音声音事件、口音与语码切换。说话人识别需清醒：LLM 在单次
上下文内对比声音尚可，跨会话稳定身份识别应交给声纹嵌入 sidecar
（CAM++/ECAPA 级别的小模型），LLM 负责理解与表达，声纹负责身份判定。

**建议架构**：ASR 不下岗（实时字幕、keyterm 纠错、历史记录仍靠它）。
用户 turn 消息体升级为双通道：`input_audio`（原始音频）+ ASR 文本
（作为 hint），模型自行融合，天然容错 ASR 错字。

**风险/待验证（已由下方评测回答）**：mmproj 与 MTP 兼容性 → 可共存但
音频 turn 的 draft 加速失效（发现 3）；mmproj 内存 +~1GB → 可接受；
QAT 对音频理解的影响 → 常规任务表现良好，领域词短板与量化无关
（纯文本同样失败，见评测表）。

**离线评测结果（2026-07-29，素材库 202 条真实录音 + 已知文本 TTS 语料）**：

| 任务 | 结果 |
|---|---|
| ASR 纠错（干净音频 + 错字 hint） | ✅ 完美——单字错误精准纠正，其余逐字保留 |
| ASR 纠错（真实录音、领域词） | ⚠️ 「过拟合/欠拟合」被 ASR 听成「过你荷和欠你合」后，音频输入也未能救回（猜成「权利和责任」）——领域词仍需 keyterm 偏置，音频不是万能解 |
| 说话人同异判定（8 对已知金标） | ✅ 7/8，上下文内对比可用性超预期，单对 1-2.5s |
| 语气/副语言（定性） | ✅ 正常长度语句描述合理（如单字「诶」判为「局促试探、寻求确认」） |

**三条关键工程发现**：

1. **≤1s 的短音频会被静默丢弃**（模型答"我听不到声音"，prompt 无音频
   token）——补静音垫到 ≥2s 后感知恢复。生产接入必须对短语句做填充；
2. 音频开销约 **27 token/秒**，一个 5s 发言 ≈ 135 token，可忽略；
3. **MTP 与 mmproj 可共存**（同实例无冲突），但音频条件下 draft 接受率
   从纯文本的 ~95% 跌到 ~19%——音频 turn 的 decode 提速基本失效，
   需接受降速或对音频 turn 关 draft。

**下一步（阶段 B）**：对话流程原型——用户 turn 消息体改为
`input_audio`（垫长后的音频）+ ASR 文本 hint，加会话级开关灰度。

## 方向 2：引入 pi 作为 agent 执行器

按 earendil-works/pi（原 badlogic/pi-mono，TypeScript agent 工具箱：
provider 无关 LLM client、工具 harness、session 管理）评估。

**契合度**：与 voxstudio 同为 bun/TS，可进程内引用；provider 无关，
可直接指向本地 OpenAI 兼容端点，不绑云。注意与现有资产的重叠：
conversation 包已有 typed tools + 口头确认流 + MCP 工具设计
（docs/mcp-tools.md、docs/agent-voice-mcp.md）——pi 的增量在成熟的
多步执行循环与工具生态，不在"有无工具调用"。

**风险**：项目年轻、API 迭代快（scope 已迁移过一次，锁版本+适配层
隔离）；bun 兼容 → spike 已证实可用；长任务执行与语音实时性约束的
适配 → spike 确认 pi 原生接缝足够（见下）。

**Spike 结果（2026-07-29，结论：采用，进程内嵌入）**：

先澄清项目身份：badlogic/pi-mono 已迁移为 **earendil-works/pi**（GitHub
旧地址重定向），npm 现行 scope 为 `@earendil-works/*`（`@mariozechner/*`
已标记弃用）。

实测（`pi-agent-core` + `pi-ai`，bun 运行，指向本地 llama-server 的
Gemma 4 12B）：

- ✅ `createProvider` + `openai-completions` API 对本地端点开箱即用
  （官方文档就有 Ollama/vLLM 配方）；
- ✅ 多步工具链完整跑通：write_file → read_file → 正确汇总，三轮
  6.6s（12B QAT 的工具调用遵循度对简单链足够，复杂链待评）；
- ✅ **集成面与 voxstudio 需求逐点对上**：`Agent` 事件流
  （`tool_execution_start` → 进度旁白；`text_delta` → 可说通道直连
  SentenceAssembler）、`abort()` → barge-in、`beforeToolCall` 钩子 →
  口头确认门、`queueMessage`/steering → 对话轮次。方向 3 需要的接缝
  pi 原生全有，无需走 MCP 间接层；
- ⚠️ 小坑：README 的无钥 provider 配方实测报 "No API key"，需给哑 key
  绕过（疑文档/实现小分歧）。

**选型结论**：pi-agent-core 作为 executor 进程内嵌入 gateway，
conversation 包保持语音前端职责，按方向 3 的事件映射对接。

## 方向 3：对话与 agent 执行一体化

**关键设计判断：不用整体结构化 JSON 输出**——JSON 未闭合前无法切句，
会杀死句级流式与 TTS 首音。正确的双通道是现成的 tool-calling 协议：

- **text 通道 = 可说通道**：天然流式，走现有 SentenceAssembler → TTS；
- **tool_calls 通道 = 行动通道**：结构化、类型安全，conversation 已
  实现 `{type:"text"|"tool_calls"}` 交错流与 external 工具的口头确认门。

以 system prompt 立约：说出的部分短、口语化、只讲结论与意图；数据、
代码、长内容一律走工具与产物，不进语音。

**需新建的三块**：

1. 进度旁白：长任务里程碑事件 → 一句话口头汇报（agent 事件流 →
   toSpeakable 的映射）；
2. 打断语义：barge-in 目前只停播放；一体化后建议"打断只停嘴、明确
   说停才停手（经确认门）"；
3. `speak` 工具：agent 在长执行中主动开口的显式通道，与被动 text 流
   互补。

**依赖**：executor 已选定 pi（方向 2 已定），事件映射表见方向 2 的
spike 结论；方向 1 是其输入增强（听得懂语气的 agent），可后置并行。

## 生态评测与观察（2026-07-29 实测补记）

**audio.cpp（0xShug0，ggml 系全能音频推理框架，35+ 家族）**——全面实测
（M3 Max Metal 构建，克隆/design/流式/ASR/VAD/对齐全跑）：

| 结论 | 依据 |
|---|---|
| ✅ **Qwen3-ASR-0.6B 采用**（终稿修订档，已落地） | 中文金标逐字全对；funasr(SenseVoice)/Gemma+音频都救不回的「过拟合/欠拟合」一次答对；常驻 ~0.5s/句，RTF 0.15。接入方式：funasr 适配器 `revise=true` 旁路（engines/qwen3-asr-revision/） |
| ❌ TTS 引擎不换 | 其 voxcpm2 Metal RTF 1.46 / qwen3_tts 1.18（均不实时）vs 我们 0.41-0.63。慢因：conv_transpose 占用率（正是我们已修、上游未合的 kernel）+ 模块间每步 host 往返 |
| ❌ 中文流式 ASR 缺口未解 | Nemotron 0.6B 快但 CER ~6% 且领域词全错；Voxtral 4B 错字+截断+无标点。**推测式 turn-taking 仍无中文引擎** |
| ➖ Silero VAD（内置）可用但对我们无增量 | 其流式 `speech_start` 事件正常，但 voxstudio 已进程内集成同款 Silero v5（platforms/bun/silero.ts，conversation 默认检测器，energy 兜底）——不需要再经它 |
| ⚠️ Qwen3 对齐器可用但非 badcase 首选 | 时间戳干净（0.16s/字）；幽灵句只被压缩不报错（0.099s/字）——TTS badcase 检测更直接的方案是 Qwen3-ASR 回环比对 |
| 不 fork，按需取件 + 上游贡献 | 项目月龄 1 个月日更节奏，深度 fork = rebase 地狱；其 CONTRIBUTING 无 AI 禁令，我们的 Metal conv_transpose 占用率修复计划直接 PR 给它 |

**顺带发现**：voice design（`(风格描述)前缀`）是 VoxCPM2 模型自身的提示词
约定——我们的引擎原生支持，只是 server 强制要求 voice 参数。已改为可选
（liuzl/VoxCPM.cpp `9c5733c`），design 模式在离线/SSE/流式三路径全部可用。

**Moonshine（moonshine-ai）**——仅观察：中文 CER 25.76%、无中文流式；
其"流式 ASR 作为默认架构"的理念是对的，等它或其它引擎补上中文再评。

**观察名单触发条件**：audio.cpp 出现中文达标的流式 ASR 家族，或其
voxcpm2 Metal 路径合入占用率修复后 RTF 进入 0.7 以下 → 重新评估。

## 当前状态与下一步（2026-07-29）

前置调研全部完成：

| 事项 | 状态 |
|---|---|
| 方向 1 离线评测 | ✅ 完成——双通道输入可行，三条工程约束已知（垫短音频 / token 成本可忽略 / 音频 turn 弃 MTP） |
| 方向 2 pi spike | ✅ 完成——选型定案：pi-agent-core 进程内嵌入 |
| 方向 3 地基盘点 | ✅ 完成——所需接缝 pi 原生齐备 |

接下来是集成开发，建议顺序：

1. **方向 3 打断语义设计文档**（小，先定交互契约：打断只停嘴、明确
   叫停才停手、经确认门）；
2. **pi executor 集成**：gateway 内嵌 pi-agent-core，落地事件映射
   （进度旁白、可说通道、barge-in→abort、beforeToolCall→口头确认）
   与 `speak` 工具；
3. **方向 1 阶段 B**：用户 turn 双通道消息体（垫长音频 + ASR hint）
   加会话级灰度开关，可与 2 并行；声纹 sidecar 另立项。

补记（07-29）：方向 1 评测遗留的「领域词仍需 keyterm 偏置」已被更简单的
方案解决——Qwen3-ASR 终稿修订档（见生态评测节）在 ASR 层直接修对领域词，
hint 通道的纠错压力大幅下降。
