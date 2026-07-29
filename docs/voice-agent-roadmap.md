# 语音 Agent 路线图：多模态输入 / agent 执行器 / 对话-行动一体化

2026-07-28 的方向评估，三个候选方向的价值、可行性与排序。机器与部署细节
在内部运维仓，此处只保留架构结论。

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

**风险/待验证**：mmproj 与 MTP draft 加速的兼容性（可能要在多模态与
最快 decode 之间取舍）；mmproj 常驻内存约 +1GB；QAT 量化对音频理解
质量的影响未测。

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

按 Mario Zechner 的 pi-mono（TypeScript 极简 agent 工具箱：provider
无关 LLM client、工具 harness、session 管理）评估。

**契合度**：与 voxstudio 同为 bun/TS，可进程内引用；provider 无关，
可直接指向本地 OpenAI 兼容端点，不绑云。注意与现有资产的重叠：
conversation 包已有 typed tools + 口头确认流 + MCP 工具设计
（docs/mcp-tools.md、docs/agent-voice-mcp.md）——pi 的增量在成熟的
多步执行循环与工具生态，不在"有无工具调用"。

**风险**：项目年轻、API 迭代快；bun 兼容需冒烟；长任务执行模型与
语音实时性约束（barge-in、取消）需要适配层。

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
  pi 原生全有，无需走 MCC/MCP 间接层；
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

**依赖**：方向 3 依赖方向 2 的 executor 选型；方向 1 是其输入增强
（听得懂语气的 agent）。

## 排序

| 优先级 | 事项 | 理由 |
|---|---|---|
| 1 | 方向 1 离线评测（约半天） | 零风险、素材现成，直接决定双通道输入是否值得 |
| 2 | 方向 2 pi spike（约一天） | 定 executor 选型，是方向 3 的前置 |
| 3 | 方向 3 打断语义设计文档 | 地基已有，难点在交互语义而非工程 |
