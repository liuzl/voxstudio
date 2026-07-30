# VoxStudio research taxonomy

Status: proposed living taxonomy. Opened 2026-07-30.

This document defines the research space for VoxStudio. It is intentionally
broader than the repository's current packages and engines. The taxonomy is a
stable way to classify questions, protocols, datasets, experiments, and
reports as VoxStudio evolves from a speech I/O product into a realtime,
multimodal, action-capable agent platform.

Machine inventories, private endpoints, operational timelines, credentials,
private voice samples, and identifiable participant data do not belong in this
public repository.

## 1. Purpose

VoxStudio research must answer more than whether an individual model performs
well. It must establish whether a complete system can perceive, converse,
remember, act, recover, and remain trustworthy under realistic conditions.

The taxonomy has five jobs:

1. define research domains independently of the current implementation;
2. separate the object being studied from the lens used to evaluate it;
3. give every experiment a primary home without hiding cross-domain effects;
4. expose important work that has no product implementation yet;
5. support reproducible comparisons across models, versions, machines, and
   system architectures.

It is not:

- a mirror of `apps/`, `packages/`, or `engines/`;
- a roadmap or statement that every listed capability will be built;
- a benchmark catalog;
- an authorization to retain user audio or other sensitive data;
- a substitute for product, security, or operational documentation.

## 2. System under study

For research purposes, VoxStudio is:

> A continuously perceptive, realtime, multimodal agent platform that can
> communicate, maintain context, use tools, and take governed action on behalf
> of a person.

This definition is deliberately independent of a cascaded
ASR → LLM → TTS architecture. A future native speech model, embodied avatar,
multi-agent planner, wearable client, or edge runtime still fits the same
research space.

The unit of evaluation may be:

- a signal-processing stage;
- a learned model;
- an engine or protocol adapter;
- a dialogue behavior;
- an agent capability;
- a deployed system configuration;
- a complete human task;
- a longitudinal user experience.

Component quality and system quality are related but not interchangeable.

## 3. Taxonomic model

Every research item is classified on two independent axes.

### 3.1 Axis A: research domain

The domain identifies **what is being studied**. Every experiment has exactly
one primary domain and may name multiple secondary domains.

Example:

```yaml
primary_domain: dialogue-intelligence
secondary_domains:
  - speech-perception
  - agent-execution
```

The primary domain is the place where the central hypothesis would still make
sense if implementation details changed. Secondary domains identify material
dependencies or downstream effects.

### 3.2 Axis B: evaluation lens

The lens identifies **how the subject is judged**. Lenses are orthogonal to
domains and may apply to every experiment.

The standard lenses are:

| Lens | Central question |
|---|---|
| correctness | Did the system produce the right result or action? |
| task success | Did the person achieve the intended outcome? |
| quality and naturalness | Is the output perceptually and socially acceptable? |
| latency and throughput | How quickly and at what load does it respond? |
| stability | Does repeated operation remain consistent? |
| robustness | Does it tolerate noise, ambiguity, faults, and distribution shift? |
| safety | Can it avoid or contain physical, psychological, and informational harm? |
| security | Can it resist manipulation, unauthorized action, and data exfiltration? |
| privacy | Is sensitive data minimized, isolated, controlled, and removable? |
| fairness | Does performance remain acceptable across affected populations? |
| accessibility | Can people with different sensory, motor, speech, and cognitive needs use it? |
| transparency | Can users and operators understand state, uncertainty, and provenance? |
| controllability | Can behavior be directed, interrupted, corrected, and reversed? |
| interoperability | Does it behave correctly across protocols, providers, and clients? |
| efficiency | What compute, memory, bandwidth, energy, storage, and money does it consume? |
| maintainability | Can behavior be diagnosed, upgraded, and reproduced safely? |
| reproducibility | Can an independent run recover the claimed result? |

An experiment must not use a domain name such as `security` as a reason to omit
security lenses from ordinary agent, tool, memory, or multimodal experiments.

## 4. Research domain groups

The taxonomy contains nineteen domains grouped into seven stable families.
The groups are navigation aids, not claims that their contents are isolated.

```text
human and experience
├── human-use-cases-and-field-research
└── product-experience-and-interface-science

perception and generation
├── acoustic-capture-and-audio-front-end
├── speech-and-acoustic-perception
├── speech-and-audio-generation
└── multimodal-perception-generation-and-embodiment

cognition, dialogue, and memory
├── language-reasoning-and-knowledge
├── dialogue-intelligence-and-social-interaction
└── memory-context-and-personalization

agency, tools, and extensions
├── agent-reasoning-planning-and-execution
└── tools-mcp-skills-and-extension-ecosystem

runtime, platform, and operations
├── runtime-orchestration-and-distributed-systems
├── reliability-observability-and-operations
├── data-model-and-artifact-lifecycle
└── efficiency-cost-and-sustainability

trust, safety, and governance
├── security-privacy-identity-and-governance
└── safety-trustworthiness-fairness-and-accessibility

evaluation and systems
├── evaluation-science-and-reproducibility
└── end-to-end-systems-and-emergent-behavior
```

## 5. Human and experience

### 5.1 Human, use cases, and field research

Studies the people, goals, institutions, and environments that give system
metrics meaning.

Topics include:

- user intent and task taxonomies;
- consumer, professional, assistive, educational, and companion scenarios;
- cognitive load, trust, reliance, and mental models;
- proactive assistance and interruption boundaries;
- individual, group, and human-team interaction;
- short-term usability and longitudinal behavior;
- field studies in homes, workplaces, vehicles, and public environments;
- adoption, abandonment, satisfaction, and real task completion.

Representative questions:

- Which tasks benefit from voice rather than text or direct manipulation?
- When does proactive speech help, and when does it become disruptive?
- Does a more expressive voice improve comprehension or merely increase trust?
- Which laboratory metrics predict sustained real-world use?

This domain owns the definition of meaningful user populations and tasks. It
does not own UI implementation, model internals, or production analytics in
isolation.

### 5.2 Product experience and interface science

Studies how state and capability are presented and controlled across voice,
text, visual, touch, and accessibility surfaces.

Topics include:

- listening, thinking, speaking, acting, waiting, and error states;
- selection of engines, voices, accounts, tools, and execution environments;
- progressive disclosure of expert controls;
- spoken versus visual presentation of results;
- confirmation, consent, undo, cancellation, and recovery interactions;
- perceived latency and continuity across devices;
- captions, artifacts, avatars, and multimodal feedback;
- discoverability, learnability, workload, and accessibility.

Representative questions:

- Can a user tell whether the system is listening, generating, or acting?
- Which choices belong inline, in a panel, or in advanced configuration?
- Does an acknowledgement reduce perceived latency without becoming noise?
- Can a user accurately predict the effect of a high-risk confirmation?

## 6. Perception and generation

### 6.1 Acoustic capture and audio front end

Studies the physical and signal-processing path before semantic speech
recognition.

Topics include:

- microphones, device variance, gain control, clipping, and resampling;
- denoising, dereverberation, beamforming, and far-field capture;
- acoustic echo cancellation and self-speech leakage;
- wake words and privacy-preserving activation;
- packet loss, jitter, clock drift, and device switching;
- full-duplex capture while TTS is playing;
- music, television, traffic, crosstalk, and other realistic interference.

Key outcomes include signal quality, echo leakage, word recovery downstream,
false activation, interruption reliability, and end-to-end latency.

### 6.2 Speech and acoustic perception

Studies inference from speech and environmental audio. ASR is one major
subfield, not the boundary of the domain.

Topics include:

- streaming and offline ASR;
- punctuation, inverse text normalization, numbers, names, and keyterms;
- language, dialect, accent, and code-switch detection;
- voice activity and endpoint detection;
- speaker verification, identification, separation, and diarization;
- emotion, prosody, hesitation, laughter, and other paralinguistics;
- disfluency, repetition, repair, and self-correction;
- non-speech acoustic event recognition;
- children, older adults, impaired speech, and atypical voices;
- adversarial or hidden instructions carried by audio.

Metrics must distinguish final transcript accuracy from streaming revision
behavior, endpoint correctness, first-token latency, and downstream task
impact.

### 6.3 Speech and audio generation

Studies generated speech and other audio. TTS is one implementation family
within the domain.

Topics include:

- intelligibility, naturalness, and fidelity;
- voice cloning, voice design, and voice conversion;
- speaking rate, emphasis, pause, pitch, energy, emotion, and style;
- cross-language cloning and accent preservation;
- incremental text input and true streaming audio;
- long-form consistency and multi-character generation;
- non-verbal vocalization, sound effects, and music where product-relevant;
- watermarking, provenance, and synthetic-speech detection;
- voice authorization, revocation, misuse resistance, and consent;
- edge deployment, quantization, and low-resource synthesis.

Automatic ASR, speaker embeddings, and acoustic statistics are proxy
measurements. They do not replace blinded listening tests or user studies.

### 6.4 Multimodal perception, generation, and embodiment

Studies modalities and embodiments beyond speech.

Topics include:

- image, screen, document, camera, and video understanding;
- OCR, gesture, gaze, posture, and scene context;
- image and video generation;
- avatars, facial expression, gesture, and lip synchronization;
- spatial audio and audiovisual temporal alignment;
- conflict resolution when modalities disagree;
- multimodal accessibility;
- hidden or adversarial instructions in images, audio, video, and documents;
- sensor fusion for wearables, vehicles, robots, or spatial computing.

An avatar benchmark that measures lip timing belongs here even if the audio is
produced by a TTS engine. A complete avatar conversation may instead have
`end-to-end-systems` as its primary domain.

## 7. Cognition, dialogue, and memory

### 7.1 Language, reasoning, and knowledge

Studies linguistic and cognitive capability regardless of which LLM or native
speech model implements it.

Topics include:

- instruction following and structured output;
- reasoning, decomposition, planning support, and uncertainty;
- factuality, hallucination, calibration, and abstention;
- multilingual and cross-language reasoning;
- long-context behavior and context compression;
- retrieval, grounding, citation, and private knowledge;
- temporal knowledge and conflict resolution;
- model routing, ensembles, local models, and edge models;
- the capability gap between text and spoken input.

Text-only model benchmarks are insufficient evidence for a voice system.
Recent end-to-end voice-agent work reports substantial task-performance gaps
between text and voice conditions, with many failures attributable to agent
behavior rather than transcription alone
([τ-Voice](https://arxiv.org/abs/2603.13686)).

### 7.2 Dialogue intelligence and social interaction

Studies the temporal and social behavior of conversation.

Topics include:

- turn-taking, endpointing, overlap, and silence;
- backchannels and acknowledgement;
- user and agent interruption;
- barge-in, steering, cancellation, and resumption;
- hesitation and self-correction;
- repair, clarification, grounding, and topic change;
- politeness, etiquette, affect adaptation, and social norms;
- multi-party conversation and floor control;
- proactive speech and rate-limited progress narration;
- half-duplex, cascaded full-duplex, and native full-duplex systems.

Content correctness alone cannot certify this domain. Full-duplex evaluation
must separately test pause handling, backchanneling, turn-taking, and
interruption management, as demonstrated by
[Full-Duplex-Bench](https://arxiv.org/abs/2503.04721).

### 7.3 Memory, context, and personalization

Studies what the system retains, retrieves, forgets, and adapts.

Topics include:

- working, session, episodic, semantic, and long-term memory;
- user preferences, pronunciations, voices, and interaction history;
- extraction, consolidation, retrieval, summarization, and forgetting;
- provenance, confidence, contradiction, and temporal decay;
- multi-user, multi-tenant, and multi-device isolation;
- user inspection, correction, export, deletion, and revocation;
- memory poisoning and persistent malicious instructions;
- personalization benefit, overfitting, and filter bubbles;
- privacy-preserving and on-device personalization.

More retained information is not automatically better. Evaluation must include
correct forgetting, source visibility, isolation, and resistance to poisoning.

## 8. Agency, tools, and extensions

### 8.1 Agent reasoning, planning, and execution

Studies the conversion of goals into governed, multi-step action.

Topics include:

- goal interpretation, decomposition, planning, and replanning;
- long-running tasks, parallel work, delegation, and multi-agent cooperation;
- external-state verification and completion evidence;
- cancellation, steering, pause, resume, and restart recovery;
- retry safety, idempotency, commit points, and compensation;
- human approval and risk-sensitive autonomy;
- file, process, network, and application execution;
- sandbox policy, isolation, resource limits, and escape resistance;
- proactive and scheduled agents;
- ownership, quotas, and task lifecycle.

Sandbox research belongs here when the central question is execution
capability, and in security when the central question is containment. Most
sandbox experiments therefore carry both domains.

### 8.2 Tools, MCP, skills, and extension ecosystem

Studies capability discovery, invocation, composition, packaging, and supply
chains.

Topics include:

- tool discovery, naming, descriptions, and schema comprehension;
- tool selection and argument construction;
- MCP compatibility, transport, lifecycle, and reconnection;
- timeout, cancellation, retry, streaming, and idempotency semantics;
- authentication, credential delegation, and permission declarations;
- tool-result validation and untrusted-content boundaries;
- skill triggering, instruction adherence, composition, and conflicts;
- plugin installation, update, revocation, provenance, and signatures;
- version drift and compatibility;
- malicious tools, skills, plugins, and compromised dependencies;
- authoring, testing, and developer experience.

An evaluation that proves a tool can be called is incomplete. It must also
test whether the right tool is chosen, whether its arguments and authorization
are correct, whether effects are duplicated, and whether failures are safely
recovered. Agentic systems add risks including tool misuse, identity abuse,
supply-chain compromise, unexpected code execution, and memory poisoning
([OWASP AI Agent Security](https://cheatsheetseries.owasp.org/cheatsheets/AI_Agent_Security_Cheat_Sheet.html)).

## 9. Runtime, platform, and operations

### 9.1 Runtime, orchestration, and distributed systems

Studies execution architecture across models, processes, hosts, and clients.

Topics include:

- cascaded, unified, and hybrid model architectures;
- streaming pipelines, scheduling, batching, and backpressure;
- capability and cost-aware routing;
- caching and speculative execution;
- session state and cancellation propagation;
- load balancing, service discovery, and multi-tenant isolation;
- local, edge, cloud, and hybrid placement;
- network latency, jitter, partitions, and reconnect;
- failover, fallback, and quality-aware degradation;
- heterogeneous CPU, GPU, NPU, ANE, Metal, CUDA, and accelerator use;
- protocol contracts and cross-client consistency.

### 9.2 Reliability, observability, and operations

Studies whether correct behavior persists and remains diagnosable.

Topics include:

- service-level objectives and error budgets;
- latency distributions and tail behavior;
- deadlock, livelock, leaks, starvation, and resource exhaustion;
- soak, concurrency, chaos, and fault-injection testing;
- disconnect, restart, and disaster recovery;
- logging, tracing, replay, and causal diagnosis;
- model and data drift;
- shadow evaluation, canaries, rollback, and release gates;
- production anomaly detection and feedback loops.

Health checks prove liveness, not task correctness. Research in this domain
must connect system telemetry to behavioral outcomes.

### 9.3 Data, model, and artifact lifecycle

Studies provenance and change across data, models, generated artifacts, and
their dependencies.

Topics include:

- data collection, annotation, quality, licensing, and versioning;
- consent, retention, deletion, and sensitive-data handling;
- training/test contamination and benchmark leakage;
- model cards, revisions, manifests, and checksums;
- fine-tuning, adaptation, quantization, distillation, and regression;
- artifact lineage and reproducible builds;
- dependency and model supply chains;
- deprecation, migration, and retirement.

Private reference voices and participant data are external controlled
artifacts. The public repository may retain only approved metadata, consent
classification, content-independent identifiers, and cryptographic checksums.

### 9.4 Efficiency, cost, and sustainability

Studies resource use relative to delivered quality and successful outcomes.

Topics include:

- cold start, warm latency, throughput, concurrency, and tail latency;
- memory, VRAM, bandwidth, storage, and download size;
- energy, thermals, and sustained device performance;
- hosted API and infrastructure cost;
- edge feasibility and offline operation;
- quantization, caching, batching, and heterogeneous placement;
- quality–latency–cost Pareto frontiers;
- cost and energy per successful user task.

Performance claims must pair accuracy or quality constraints with explicit
load scenarios and system descriptions. This follows the general discipline
used by [MLPerf Inference](https://docs.mlcommons.org/inference/), where
accuracy, scenario, latency, and reproducible system configuration are
reported together.

## 10. Trust, safety, and governance

### 10.1 Security, privacy, identity, and governance

Studies adversarial behavior, authorization, information control, and
accountability.

Topics include:

- authentication, authorization, identity, and least privilege;
- credential handling and delegated access;
- direct, indirect, persistent, and multimodal prompt injection;
- unauthorized tool use and excessive agency;
- data leakage, exfiltration, cross-tenant access, and inference attacks;
- untrusted remote code, models, tools, skills, and dependencies;
- sandbox escape and unsafe system interaction;
- audit trails, approvals, policy enforcement, and incident response;
- data classification, retention, deletion, and regional requirements;
- voiceprints and other biometric data;
- consent, impersonation, revocation, and synthetic-content provenance.

Prompt injection may be carried through external documents and multimodal
inputs, not only visible chat text. High-risk effects require deterministic
policy boundaries and, where appropriate, human approval
([OWASP Prompt Injection](https://genai.owasp.org/llmrisk/llm01-prompt-injection/)).

### 10.2 Safety, trustworthiness, fairness, and accessibility

Studies harmful outcomes and equitable, understandable human control.

Topics include:

- harmful content, dangerous advice, deception, and overreliance;
- impersonation, fraud, and synthetic-media misuse;
- emotional dependency and crisis behavior;
- uncertainty, transparency, explanation, and human oversight;
- bias across language, dialect, accent, age, gender, disability, and culture;
- hearing, vision, motor, speech, and cognitive accessibility;
- captions, pace adaptation, alternative modalities, and reversible actions;
- complaint, redress, and evaluation with affected communities.

This domain adopts the lifecycle view of trustworthiness in the
[NIST AI Risk Management Framework](https://www.nist.gov/itl/ai-risk-management-framework):
risk is mapped, measured, managed, and governed continuously rather than
checked once after implementation.

## 11. Evaluation and systems

### 11.1 Evaluation science and reproducibility

Studies whether VoxStudio's evidence is valid.

Topics include:

- construct validity and metric definitions;
- dataset representativeness and contamination;
- automatic metrics versus human judgment;
- MOS, pairwise preference, AB, ABX, and blinded study design;
- sample size, statistical power, confidence intervals, and multiple testing;
- randomization, seeds, exclusions, and failure accounting;
- cold, warm, steady-state, and loaded-system separation;
- raw versus derived data;
- environment capture and independent reproduction;
- protocol preregistration and immutable completed runs;
- benchmark maintenance and longitudinal comparability.

This domain exists to prevent mistakes such as counting a lazy model download
as inference time or presenting a speaker-embedding score as human voice
preference.

### 11.2 End-to-end systems and emergent behavior

Studies outcomes that cannot be inferred from component scores.

Topics include:

- real task completion and policy compliance;
- speech-versus-text capability gaps;
- full-path latency and perceived responsiveness;
- error propagation across perception, reasoning, tools, and generation;
- disfluency and self-correction during multi-step tool use;
- version interactions and configuration-dependent behavior;
- degradation, fallback, and recovery under failures;
- realistic noise, accents, networks, devices, and concurrent load;
- longitudinal behavior and field performance;
- emergent unsafe, deceptive, or socially inappropriate behavior.

This is the correct primary domain when the research question concerns a
complete path such as:

```text
human speech
  → capture / VAD / ASR
  → dialogue / agent
  → MCP tools and external effects
  → TTS / playback
  → human response
```

Contemporary full-duplex benchmarks increasingly combine natural speech,
disfluency, interruption, multi-step tools, task success, and latency rather
than evaluating these in isolation
([Full-Duplex-Bench v3](https://arxiv.org/abs/2604.04847)).

## 12. Inclusion and boundary rules

A topic merits a named research domain or subdomain when at least two of the
following are true:

1. it has independent scientific questions rather than only implementation
   tasks;
2. it needs a distinct dataset, protocol, metric, or participant population;
3. it crosses multiple implementation components;
4. it can materially change user outcomes, system risk, or product decisions.

Otherwise it is a topic, method, or tag inside an existing domain.

Examples:

| Concept | Classification |
|---|---|
| ASR | major subdomain of speech and acoustic perception |
| TTS | major subdomain of speech and audio generation |
| LLM | implementation family spanning language, dialogue, memory, and agency |
| MCP | protocol and ecosystem topic under tools and extensions |
| Skill | capability-package and instruction-governance topic under tools and extensions |
| sandbox | cross-domain topic spanning agent execution, runtime, and security |
| avatar | embodiment topic; full avatar conversation may be end-to-end |
| voice agent | end-to-end system under study, not one component domain |
| latency | evaluation lens, except when methods for measuring latency are the research subject |
| model installation | engineering task unless provenance, supply chain, or lifecycle is under study |

The taxonomy may grow, but new top-level domains require an explicit boundary
argument using these rules.

## 13. Required classification for research records

Every protocol and experiment record must declare:

```yaml
taxonomy_version: 1
primary_domain: speech-and-audio-generation
secondary_domains:
  - efficiency-cost-and-sustainability
  - data-model-and-artifact-lifecycle
evaluation_lenses:
  - quality-and-naturalness
  - correctness
  - latency-and-throughput
  - stability
  - efficiency
  - reproducibility
system_level: component
```

Allowed `system_level` values are:

- `method`: a metric, dataset, evaluator, or experimental technique;
- `component`: one bounded capability;
- `subsystem`: several composed components behind one contract;
- `end-to-end`: a complete user-to-outcome path;
- `field`: use in a natural environment over meaningful time.

Experiments must additionally state:

- research question and falsifiable hypothesis;
- protocol revision fixed before result interpretation;
- system under test and comparison baselines;
- code, model, data, and artifact revisions;
- environment and hardware class without public private-infrastructure detail;
- seeds, repetitions, sample selection, and exclusions;
- metric definitions and aggregation rules;
- raw-data location and checksums;
- privacy, consent, license, and retention classification;
- known limitations and unresolved confounders.

## 14. Directory implications

The taxonomy is defined before a research directory is created. The eventual
top-level structure should use stable domain groups rather than current product
module names:

```text
research/
├── README.md
├── governance/
├── schemas/
├── datasets/
├── protocols/
├── experiments/
│   ├── human-and-experience/
│   ├── perception-and-generation/
│   ├── cognition-dialogue-and-memory/
│   ├── agency-tools-and-extensions/
│   ├── runtime-platform-and-operations/
│   ├── trust-safety-and-governance/
│   └── evaluation-and-end-to-end/
├── reports/
└── registry/
```

The group directory is followed by the primary domain and immutable experiment
identifier:

```text
research/experiments/
  perception-and-generation/
    speech-and-audio-generation/
      2026-07-30-audio8-vs-voxcpm2/
```

Secondary domains and lenses belong in metadata, not duplicate copies of the
same experiment.

Large generated audio, models, private samples, raw participant data, and
machine-specific logs remain outside Git. The repository stores manifests,
approved aggregate results, content-independent identifiers, and checksums.

Existing product tools do not need to move merely to match the taxonomy.
Research runners may invoke `tools/`, engine probes, and application measurement
commands while recording their revisions. Migration should standardize
protocols and result formats before reorganizing executable code.

## 15. Initial application

The Audio8 versus VoxCPM2 voice-cloning study is the first candidate to be
backfilled under this taxonomy.

Its classification is:

```yaml
primary_domain: speech-and-audio-generation
secondary_domains:
  - efficiency-cost-and-sustainability
  - evaluation-science-and-reproducibility
evaluation_lenses:
  - correctness
  - quality-and-naturalness
  - latency-and-throughput
  - stability
  - efficiency
  - reproducibility
system_level: component
```

The current ASR, realtime conversation, agent-tool, MCP, skill, voice-design,
long-form audio, and sandbox investigations should be mapped in the registry
before new directories are created for them. Classification does not imply
that historical measurements already satisfy the evidence requirements in
this document.

## 16. Governance and revision

This taxonomy is living but versioned.

- Clarifications and new examples do not require a version change.
- Renaming, splitting, merging, or changing the meaning of a domain increments
  `taxonomy_version`.
- Completed experiments retain the taxonomy version under which they were
  classified.
- A migration table records mappings between versions.
- Repository structure follows the taxonomy; it does not define it.
- Product implementation status must never be used to remove a legitimate
  research domain.

The taxonomy should be reviewed when VoxStudio adds a new modality, execution
surface, deployment class, affected user population, or materially different
risk profile.
