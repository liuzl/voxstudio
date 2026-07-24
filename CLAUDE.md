# CLAUDE 入口

**voxstudio** = 自托管、多语言的语音 I/O 产品仓：ASR + LLM + TTS 引擎统一在一层 OpenAI 兼容契约后，之上是核心编排层 + 瘦表面（CLI/Web/MCP/移动端）。项目背景见 [README.md](./README.md)。

## 仓边界（SoT）

- **本仓**：我们自己的引擎 wrapper（`engines/`）+ 核心编排层（`packages/`）+ 应用入口（`apps/`）+ 产品设计文档（`docs/`）。
- **不进本仓**：上游 C++ 引擎源码（`liuzl/VoxCPM.cpp`、`mudler/parakeet.cpp` —— 本仓只放我们的 wrapper/适配/部署模板）；网关部署、运维时间线、机器清单等归各自的内部仓。

## 维护约定

- **公开仓**：绝不提交密钥（`.env` / 上游 key / token）、**内网基础设施细节**（tailnet IP / 内网主机名 / 机器拓扑 / 显存占用）、个人私有绝对路径（用 env 或 `~` 参数化）、大体积模型/音频。
- 引擎服务的**可部署物 + runbook** 放对应 `engines/<name>/`（脚本 + systemd unit 模板 + README，均用占位/env，不写死具体机器）。
- 引擎调用一律走 **OpenAI 兼容契约**（`/v1/audio/speech`、`/v1/audio/transcriptions`、`/v1/chat/completions`、扩展 `/v1/voices`）——保持托管/本地可换。
- 具体机器上的部署/升级/故障等运维事件，记录到**内部运维仓**，不写进本公开仓。
