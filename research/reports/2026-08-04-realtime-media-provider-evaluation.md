# Realtime media provider evaluation

Status: Research snapshot, 2026-08-04. Prices and quotas are observations on this
date, not enduring architecture constants. Re-check official pricing before any
production commitment.

```yaml
taxonomy_version: 1
primary_domain: runtime-orchestration-and-distributed-systems
secondary_domains:
  - reliability-observability-and-operations
  - efficiency-cost-and-sustainability
  - acoustic-capture-and-audio-front-end
  - security-privacy-identity-and-governance
evaluation_lenses:
  - interoperability
  - latency-and-throughput
  - robustness
  - efficiency
  - maintainability
  - privacy
system_level: subsystem
evidence_level: E1
disposition: candidate
```

This document evaluates managed and self-hosted WebRTC media infrastructure for the
remote/mobile path defined in
[realtime-media-transport.md](../../docs/realtime-media-transport.md). It does not reopen the
decision to use WebRTC for remote clients. It decides how to validate and deploy that
path without coupling the VoxStudio conversation kernel to one provider.

## Recommendation

1. Use **LiveKit Cloud Build** for the first remote-adapter implementation and the
   iPhone/browser acceptance gate. It has no fixed cost at the current development
   volume and minimizes media-infrastructure work.
2. Preserve **self-hosted LiveKit** as the private/on-premises deployment. The same
   client and server SDK boundary makes Cloud-to-self-host migration materially
   smaller than changing media vendors.
3. Run a bounded **Cloudflare RealtimeKit or Realtime SFU spike** only after the
   LiveKit behavior gate, or earlier if an explicit procurement, data-residency, or
   scale-cost requirement appears. Cloudflare's transport price is lower, but its
   lower-level surface moves more room, presence, track, and server-media lifecycle
   work into VoxStudio.
4. Keep **WebSocket Media v2** for local/single-binary operation. A managed RTC
   provider must never become a requirement for loopback Studio or the native CLI.

This recommendation selects an implementation baseline, not an irreversible hosting
contract. The provider boundary remains an endpoint adapter; ASR, LLM, TTS, VAD,
turns, tools, voices, and traces remain provider-neutral.

## Research question and evidence boundary

Which managed or self-hosted WebRTC media service is the lowest-risk first transport
for VoxStudio remote/mobile audio, and which cost, privacy, or interoperability
conditions would justify changing it?

The promotion hypothesis for the next gate is:

> A LiveKit endpoint adapter can pass the existing Vox interruption, audible-clock,
> iPhone, telemetry, and identity contracts on LiveKit Cloud, then switch to a
> single-node self-hosted LiveKit endpoint by configuration without changing the
> conversation loop.

This report is E1 evidence. It reviews official product, architecture, deployment,
quota, billing, and pricing sources as available on 2026-08-04 and derives transparent
cost examples from them. No provider account, SDK, raw-audio server participant,
WebRTC call, network route, invoice, or real-device behavior was exercised. Product
fit and cost remain candidates until the gates below reproduce them.

## Workload and billing model

The normal VoxStudio remote session contains two connected media participants:

```text
participant 1 = browser/mobile user
participant 2 = self-hosted VoxStudio media adapter
```

Therefore one wall-clock conversation minute normally consumes two participant
minutes. A ten-minute conversation consumes about twenty participant minutes. Each
provider may round each connection independently, so short sessions can cost more
than this continuous-session approximation.

The initial transport estimate is mono Opus with roughly 32–48 kbps Agent downlink and
a lower-rate speech uplink. For comparison calculations this document uses **80 kbps
combined downstream from the SFU**, or approximately 36 MB per conversation hour.
Actual SDK statistics, not this estimate, decide production cost.

The calculation excludes VoxStudio's own compute, ASR/LLM/TTS engines, storage, taxes,
support contracts, and recording. Prices are USD.

## Provider snapshot

| Option | Current allowance/rate | Product fit | Main trade-off |
|---|---|---|---|
| LiveKit Cloud Build | $0/month; 5,000 WebRTC participant minutes; 50 GB downstream; 100 concurrent participants | Best first implementation | Free allowance is a hard cap |
| LiveKit Cloud Ship | $50/month; 150,000 minutes, then $0.0005/participant-minute; 250 GB, then $0.12/GB; 1,000 concurrent participants | Managed production baseline | Monthly floor and two metered resources |
| LiveKit Cloud Scale | $500/month; 1.5M minutes, then $0.0004/participant-minute; 3 TB, then $0.10/GB; 5,000 concurrent participants | Higher-volume managed deployment | Premature for current scale |
| Self-hosted LiveKit | Software is open source; infrastructure and operations are ours | Private/on-premises and data-boundary deployments | TLS, UDP, TURN, upgrades, monitoring, capacity |
| Cloudflare RealtimeKit | Beta is currently free; announced GA audio-only rate $0.0005/participant-minute | Higher-level managed meetings/voice | Beta maturity and Agent server-track gate still open |
| Cloudflare Realtime SFU | First 1,000 GB/month free; then $0.05/GB downstream; TURN and SFU are not double charged | Lowest media cost; global edge | Low-level surface; VoxStudio owns more WebRTC logic |
| Daily audio-only | 10,000 participant minutes/month free; then $0.00099/participant-minute at the first paid tier | Mature RTC and voice-agent ecosystem | Different SDK/runtime integration and higher unit price |
| Twilio Video | $0.004/participant-minute | Mature enterprise communications | Highest unit price in this shortlist |

### One-hour comparison

For two continuously connected participants and, where relevant, the 80 kbps transport
estimate:

| Option | Marginal media cost for one conversation hour |
|---|---:|
| LiveKit Build | $0 while both monthly allowances remain |
| LiveKit Ship minutes overage | $0.06, before any data overage |
| LiveKit Scale minutes overage | $0.048, before any data overage |
| Cloudflare RealtimeKit announced GA audio rate | $0.06 |
| Cloudflare Realtime SFU after its free data allowance | approximately $0.0018 |
| Daily first paid audio-only tier | approximately $0.1188 |
| Twilio Video | $0.48 |

Fixed plan fees and included allowances make marginal figures unsuitable for choosing a
plan alone. At VoxStudio's current development volume, integration risk and behavioral
correctness dominate media cost.

## LiveKit billing boundary for VoxStudio

The intended first integration uses LiveKit Cloud only for realtime media and data:

```text
LiveKit Cloud                 VoxStudio-owned infrastructure
---------------------------   -----------------------------------
room + WebRTC transport       Agent execution
SFU + TURN                    VAD + ASR + LLM + TTS
short-lived room token        tool loop + turn/revision semantics
transport statistics          Trace/Conversation/Media Stores
```

This shape consumes:

- WebRTC participant minutes for the browser and the connected VoxStudio adapter;
- downstream data transfer from LiveKit to those participants;
- optional separately requested ingress, egress, recording, or telephony services.

It does **not** inherently consume:

- LiveKit-hosted Agent session minutes;
- LiveKit Inference STT, LLM, or TTS;
- LiveKit Agent observability or audio recording;
- LiveKit phone numbers or SIP minutes.

Those meters apply only if VoxStudio deliberately adopts the corresponding LiveKit
Cloud product. The deployment must not enable them as an incidental side effect of
joining a room. Build's included allowance is a hard cap: exhaustion rejects new
usage rather than silently creating overage.

At two participants, the Build allowance of 5,000 WebRTC participant minutes is about
2,500 wall-clock conversation minutes, or 41.7 continuous hours per month. Ship's
150,000 included participant minutes are about 1,250 continuous conversation hours.
With the 80 kbps assumption, connection minutes are expected to become limiting before
the included downstream data; the live gate must verify that assumption.

## Option analysis

### LiveKit Cloud

Strengths:

- room, participant, track, token, data-message, server SDK, and WebRTC statistics
  surfaces align closely with the accepted endpoint-adapter design;
- globally managed media removes SFU/TURN deployment from the first implementation;
- the Cloud and self-hosted products share the central room/track model;
- Build is sufficient for a measured development and device gate.

Risks:

- participant-minute rounding makes very short, reconnect-heavy sessions inefficient;
- free projects have hard quotas and possible cold starts for LiveKit-hosted Agents
  (the latter is not relevant when the VoxStudio adapter is self-hosted);
- Cloud media introduces a third-party data processor and requires an explicit
  deployment/privacy decision;
- playback completion, stream flushing on interruption, and route behavior still need
  VoxStudio-specific real-device proof.

### Self-hosted LiveKit

Strengths:

- media placement and operational data boundary are controlled by the deployer;
- no provider participant-minute meter;
- reuses the LiveKit endpoint adapter and browser integration;
- appropriate for organization-wide private and on-premises VoxStudio deployments.

Costs and risks:

- a trusted domain/certificate and secure signaling endpoint;
- public or private candidate-address correctness;
- UDP media ports, TCP fallback, and embedded TURN/TLS/UDP;
- monitoring, upgrades, incident response, bandwidth, and regional placement;
- Redis and load balancing when the deployment grows beyond a single node.

A single Linux VM using the official Docker Compose/Caddy generator is the production
pilot. Kubernetes and multi-region operation are non-goals until one-node capacity or
availability measurements require them. A pure Tailnet deployment is a separate gate:
candidate advertisement, iOS reachability, and UDP behavior must be measured rather
than inferred from HTTPS reachability.

### Cloudflare RealtimeKit

RealtimeKit is the higher-level Cloudflare product: App, Meeting, Session,
Participant, Preset, Web/mobile SDKs, and optional UI. It is a closer product-level
comparison to LiveKit Cloud than the raw SFU.

Reasons to spike it:

- Beta currently has no usage charge;
- announced GA audio-only pricing is competitive;
- Cloudflare supplies a global media edge and managed client connectivity;
- Core SDK allows a custom VoxStudio UI rather than requiring its meeting UI.

Blocking unknowns:

- stable server-side raw-audio publication and subscription for a self-hosted Agent;
- immediate removal of queued Agent audio after turn interruption;
- reliable data/RPC mapping for the existing session protocol;
- iPhone AEC, output-route change, reconnection, and statistics behavior;
- migration guarantees while the product remains Beta.

### Cloudflare Realtime SFU

The SFU is a low-level, globally managed forwarding and TURN primitive priced only on
downstream data. It is economically attractive for compressed audio, but its official
positioning explicitly leaves sessions, tracks, presence, and WebRTC logic to the
application.

It should be selected only when at least one of these becomes true:

- measured LiveKit transport cost is material to gross margin;
- Cloudflare edge placement produces a measured latency/reliability gain;
- procurement or platform consolidation mandates Cloudflare;
- VoxStudio already needs a provider-independent RTC session layer for another reason.

The free allowance alone is not sufficient justification for rebuilding mature room
and server-track behavior.

### Daily and Twilio

Daily is a credible fallback with mature WebRTC infrastructure, audio-only pricing,
and a voice-agent ecosystem around Pipecat. It deserves reconsideration if VoxStudio
adopts Pipecat interoperability or LiveKit fails a required device/region gate.

Twilio is operationally mature and attractive when PSTN, SIP, procurement, or an
existing Twilio enterprise relationship dominates the decision. It is not the
cost/architecture default for the current browser-only Agent path.

## Industry architecture rationale

Online meeting systems and Voice Agents share the same media foundation even when
their native clients use proprietary RTC engines rather than the browser's WebRTC
stack:

- endpoint AEC, noise suppression, gain control, and route management;
- compressed audio frames and media timestamps;
- UDP-preferred realtime transport with TCP/TLS or relay fallback;
- SFU forwarding, adaptive bitrate/congestion control, jitter buffers, FEC/PLC, and
  bounded retransmission;
- geographically close ingress and multi-region backbone/cascading;
- separate reliable signaling/control and time-sensitive media planes.

Zoom publicly describes UDP-preferred media with TCP/TLS fallback and geographically
steered resources. Tencent Meeting publishes UDP/TCP media endpoints, dynamic bitrate,
and QUIC-related access endpoints; Tencent exposes the same product category through
TRTC. These are architectural analogues, not evidence that either product runs
LiveKit.

VoxStudio's case is considerably smaller: normally one user and one AI participant,
two audio tracks, no video layout, and no multi-party subscription graph. It should
reuse the proven media layer while retaining its distinctive turn/revision,
cancellation, model routing, tools, voice, and trace semantics.

## Provider boundary

Do not build an abstract universal RTC framework before one provider works. The
minimum boundary is a VoxStudio endpoint adapter with these responsibilities:

- issue or consume short-lived, session-scoped credentials;
- connect/disconnect one server media participant;
- deliver ordered, timestamped canonical input PCM to `DuplexSession`;
- accept canonical output PCM and publish one continuous Agent track;
- send and receive the required reliable control/data events;
- stop and flush a superseded playback stream;
- report transport statistics and route state;
- close every resource on session cancellation or disconnect.

Provider-specific room, participant, and track types remain inside the adapter. The
conversation kernel and Agent model never receive them. A second provider is added by
another adapter only after its spike passes the same behavioral contract.

## Evaluation gates

Every managed-provider spike uses the media acceptance matrix in
[realtime-media-transport.md](../../docs/realtime-media-transport.md#acceptance-matrix), plus:

1. **Server media:** self-hosted VoxStudio receives microphone PCM and publishes TTS
   without deploying Agent inference to the provider.
2. **Interruption:** p95 interrupt-to-silence meets the transport gate and no queued
   stale audio returns after a new revision starts.
3. **Control:** captions, lifecycle, tools, mute/end, and playback acknowledgement map
   without provider-specific state leaking into the conversation kernel.
4. **Identity:** credentials are short-lived, least privilege, owner/session scoped,
   and revocable on stop.
5. **Devices/routes:** iPhone Safari and macOS browsers pass Wi-Fi, cellular, direct,
   relay, headset, speaker, and route-change cases.
6. **Observability:** bitrate, packet loss, jitter, concealment, and route data reach
   the shared trace without enabling audio/content retention.
7. **Cost:** a test project records participant minutes and downstream bytes close to
   the estimator; reconnection and rounding overhead are reported separately.
8. **Portability:** switching LiveKit Cloud to a one-node self-hosted LiveKit endpoint
   requires configuration and credentials, not conversation-loop changes.

## Revisit triggers

Re-evaluate the baseline when any of the following occurs:

- monthly managed-media cost exceeds the cost of an adequately operated private node;
- a required geography, residency, or procurement policy is unsupported;
- the provider fails the iPhone, interruption, data, or playback-clock gate;
- concurrency or quota ceilings block the product plan;
- Cloudflare RealtimeKit reaches GA and passes the server-media contract;
- Cloudflare SFU demonstrates a material measured benefit after including engineering
  and operational cost;
- the product adopts PSTN/SIP at a scale that changes the platform comparison.

## Primary sources

- [LiveKit Cloud pricing](https://livekit.com/pricing)
- [LiveKit Cloud billing and rounding](https://docs.livekit.io/deploy/admin/billing/)
- [LiveKit Cloud quotas and free allowances](https://docs.livekit.io/deploy/admin/quotas-and-limits/)
- [LiveKit Cloud and self-hosted comparison](https://docs.livekit.io/intro/cloud/)
- [LiveKit self-hosted deployment](https://docs.livekit.io/transport/self-hosting/deployment/)
- [LiveKit VM deployment](https://docs.livekit.io/transport/self-hosting/vm/)
- [LiveKit ports and firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
- [Cloudflare Realtime overview and product comparison](https://developers.cloudflare.com/realtime/)
- [Cloudflare RealtimeKit pricing](https://developers.cloudflare.com/realtime/realtimekit/pricing/)
- [Cloudflare Realtime SFU pricing](https://developers.cloudflare.com/realtime/sfu/pricing/)
- [Daily audio-only pricing](https://www.daily.co/pricing/video-sdk/)
- [Twilio Video pricing](https://www.twilio.com/en-us/video/pricing)
- [Zoom reliability architecture](https://library.zoom.com/admin-corner/architecture-and-design/zoom-architected-for-reliability)
- [Tencent Meeting firewall/media endpoints](https://meeting.tencent.com/support/topic/1929)
- [Tencent TRTC](https://cloud.tencent.com/product/trtc)
