# Avatar from a single image: routes survey

Status: pre-research survey, 2026-07-24. Nothing here is measured yet — this
document maps the option space and orders the experiments. It extends
[lipsync-bridge.md](./lipsync-bridge.md), which answered "can voxstudio drive a
face"; this one asks "where does the face come from, given one picture."

## The question

A user brings one image — an anime illustration or a photo — and wants a
character that speaks with a voxstudio voice. What turns that image into a
drivable avatar, and which of the two signals voxstudio already produces does
each option consume:

- **the mouth signal** — the amplitude/viseme channel the lip-sync bridge
  built (today a 0..1 float; the planned upgrade is `a/i/u/e/o` visemes), or
- **the audio itself** — the raw TTS output, no extraction step at all.

Every route below plugs into one of those two. None of them require gateway
changes — the same conclusion the lip-sync POC reached from the other side.

## Route A — expression-sheet PNGTuber (works today)

Generate a handful of derived frames from the source image (mouth closed /
open, blink, 2–3 emotions) with an image model — local SDXL + IP-Adapter, or a
hosted API. Render them with either the aituber-onair PNGTuber template or a
few dozen lines of our own against the existing mouth channel (threshold the
float: `mouth > 0.5` → open frame).

- Consumes: mouth signal (amplitude is enough).
- Ceiling: frame swapping, no continuous deformation. Reads as "retro
  PNGTuber", which is a legitimate aesthetic, not a defect.
- Cost: days. This is the full-chain validation step, not the destination.

## Route B — 2.5D layer decomposition (current best for anime)

The 2026 development that changes this space:
[See-through](https://github.com/shitagaki-lab/see-through) (SIGGRAPH 2026,
open source) decomposes a **single anime illustration into up to 24 semantic
RGBA layers** — front hair, back hair, face, eyes, clothing — inpainting the
occluded regions, exporting a layered PSD. A
[ComfyUI plugin](https://github.com/jtydhr88/ComfyUI-See-through) adds
per-layer depth maps. A third-party
[hands-on](https://lilting.ch/en/articles/see-through-anime-layer-decomposition)
confirms a usable 23-layer PSD from one image.

What it eliminates is the most laborious half of Live2D authoring (manual
segmentation + occlusion inpainting). What remains manual is the **rigging**
in Cubism Editor; fully automatic image→Live2D is credibly one or two years
out. aituber-onair has both PSD and Live2D render templates to receive the
output.

- Consumes: mouth signal (Live2D mouth parameter; visemes when we have them).
- Anime-style input only.
- Cost to evaluate: run one image locally, judge the PSD, count the manual
  hours from layers to a moving face.

## Route C — neural talking head (current best for photos)

Single photo + **audio** → video frames. Two self-hostable references:
[LivePortrait](https://github.com/KwaiVGI/LivePortrait) (Kuaishou, MIT) and
[Ditto](https://github.com/antgroup/ditto-talkinghead) (Ant Group, ACM MM
2025, Apache-2.0) — Ditto is an audio-driven, **realtime** motion-space
diffusion model built on top of LivePortrait. The research frontier is
single-image Gaussian head avatars
([VASA-3D](https://arxiv.org/pdf/2512.14677),
[SEGA](https://arxiv.org/pdf/2504.14373)) — watch, don't build on, yet.

The distinctive property: this route eats **audio directly**. voxstudio's TTS
output goes straight in; no viseme extraction, the shortest possible chain.
The price: one GPU per live session doing continuous inference, and the
product is a video stream — a web digital-human surface, not a 118 MB RSS
desktop widget. Complements rather than competes with the
pocket-character form factor.

- Consumes: audio.
- Photo-realistic input; realtime needs a dedicated GPU.
- Cost to evaluate: stand up Ditto next to an engine, measure latency and
  GPU residency for one session.

## Route D — image → 3D → auto-rig → VRM (the ideal endpoint, with a gap)

The only route that lands on the format the lip-sync bridge's production plan
assumes: VRM with the `a/i/u/e/o` preset visemes, rendered by
pocket-character. Current state:

- **Geometry is commoditized.** Hunyuan3D 2.5/3.1 produces a quad-topology
  mesh with 4K textures from one image in ~3 minutes, with an Auto-Rig step in
  its studio ([walkthrough](https://www.vset3d.com/hunyuan-3d-2-5-create-and-rig-a-3d-character-in-5-steps/));
  open-source counterparts are
  [CharacterGen](https://github.com/zjp-shadow/CharacterGen) (SIGGRAPH '24,
  ships VRM render scripts) and
  [Make-A-Character 2](https://arxiv.org/pdf/2501.07870).
- **Body rigging is roughly solved** (UniRig and peers).
- **Facial viseme blendshapes are the unsolved link.** No surveyed tool
  automatically produces the VRM expression/viseme morph set; today that step
  is manual (Blender/VRoid) or research-grade. Likeness to the source image
  is the other persistent weakness.

- Consumes: mouth signal (visemes).
- Verdict: do not invest now; re-survey quarterly for an auto-blendshape
  breakthrough. When that lands, this route absorbs the others' use cases.

## Recommended order

1. **A first** (days): validates generated-frame quality end-to-end on the
   channel that already exists.
2. **B next, for anime**: one local See-through run; the open question is
   manual hours from PSD to motion, not whether the decomposition works.
3. **C next, for photos**: Ditto beside an engine; voxstudio supplies audio,
   Ditto supplies the face, nothing new invented between them.
4. **D on watch**: quarterly check on auto-blendshape progress.

## References

- [lipsync-bridge.md](./lipsync-bridge.md) — the mouth channel and the
  VRM/viseme production plan all mouth-signal routes target.
- [duplex-audio-architecture.md](./duplex-audio-architecture.md) — the
  realtime session that route C's audio (and any streamed mouth signal)
  rides on.
- Surveyed 2026-07-24: [See-through](https://github.com/shitagaki-lab/see-through) ·
  [ComfyUI-See-through](https://github.com/jtydhr88/ComfyUI-See-through) ·
  [See-through hands-on](https://lilting.ch/en/articles/see-through-anime-layer-decomposition) ·
  [Ditto](https://github.com/antgroup/ditto-talkinghead) ·
  [LivePortrait](https://github.com/KwaiVGI/LivePortrait) ·
  [VASA-3D](https://arxiv.org/pdf/2512.14677) · [SEGA](https://arxiv.org/pdf/2504.14373) ·
  [CharacterGen](https://github.com/zjp-shadow/CharacterGen) ·
  [Make-A-Character 2](https://arxiv.org/pdf/2501.07870) ·
  [Hunyuan 3D-2.5 rig walkthrough](https://www.vset3d.com/hunyuan-3d-2-5-create-and-rig-a-3d-character-in-5-steps/)
