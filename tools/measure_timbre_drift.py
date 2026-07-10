#!/usr/bin/env python
"""Measure how far the timbre drifts from the reference voice as a generation runs.

This is the experiment behind `max_seconds` in `docs/chunking.md`. Re-run it when you
change the default reference voice or the TTS model; the drift rate is a property of both.

    uv run python tools/measure_timbre_drift.py --reference ref.wav --voice alice

It needs a speaker-verification encoder, which the workspace lock does not carry -- it is
the only tool here with a heavy dependency. Run it in a throwaway environment:

    uv run --with speechbrain --with torch --with torchaudio \\
      python tools/measure_timbre_drift.py --reference ref.wav --voice alice

**Run this on the engine host.** The encoder wants the audio the engine just made, and a
full sweep moves half an hour of it. Give the encoder the CPU (`CUDA_VISIBLE_DEVICES=`):
the GPU is holding the TTS model and has nothing to spare.

## What it measures

The same passage under several `max_seconds` budgets, plus one arm with no chunking. Each
chunk is cut into 6s windows, each window embedded, each embedding compared by cosine
against the reference audio the voice was cloned from. Two views of the same windows:

  - per arm, does mean similarity fall as the budget grows?
  - pooled by "seconds since this chunk began", where does the decay actually live?

## Two traps

**The unchunked arm may not survive its own repeats.** Peak VRAM grows with the length of
one generation and torch's allocator never gives it back, so a long single-pass generation
succeeds on a freshly restarted engine and 500s on the next identical request. If
`--repeats` on the `whole` arm keeps failing, restart the engine between runs -- results
are appended, so a re-run resumes where it stopped.

**Cosine scales do not survive a change of encoder.** The same cloned voice scores 0.911
on one and 0.737 on another. Compare arms within a run; never compare an absolute number
against a table measured with something else.
"""

import argparse
import json
import os
import statistics
import sys
import time

import numpy as np

from voxcore import chunk_text, load_config, read_wav, trim_edge_silence
from voxcore.clients.tts import TTSClient

WINDOW_S = 6.0

# ~140s of ordinary Chinese prose. Long enough that the unchunked arm runs well past the
# point where drift is audible, and that a 60s budget still needs three chunks.
PASSAGE = (
    "人工智能正在改变我们与机器交流的方式，而语音合成是其中最直观的一环。过去要让机器说出一句自然的话，"
    "需要在录音棚里录制大量语料，还要请专人逐句校对；如今只要几秒钟的参考音，模型就能把陌生的文字念成那个人的声音。"
    "这项变化来得比很多人预想的都快，也比很多人准备好的要早。真正困难的部分不在于让机器开口，"
    "而在于让它一直保持同一个人的声音。单次生成越长，音色离参考音就越远。所以长文本必须切块，"
    "每一块重新以参考音为条件，把音色拉回来。切块的代价是接缝。两块之间如果直接拼接，停顿的长度会忽长忽短，"
    "听感上像是叙述者的呼吸乱了。正确的做法是把每块边缘的静音按语音电平裁掉，再插入一个固定的停顿，"
    "并把每块的响度对齐到第一块。这些数字都不是拍脑袋定的，而是量出来的：模型自己的句间停顿中位数是二百一十毫秒，"
    "而块与块之间的响度差最大可以到四个分贝。把它们对齐之后，听众就不会觉得叙述者忽远忽近。"
    "还有一件事容易被忽略，就是不要把开头的辅音裁掉。送气音几乎不携带能量，却决定了听众听到的是哪个音节。"
    "把音频切到第一个超过能量门限的帧，开头就会变成一个光秃秃的元音，听起来含混不清。所以每一侧都要留出四十毫秒的门限以下音频。"
    "流式播放又带来另一个约束。听众在第一块生成出来之前什么也听不到，所以第一块必须短。"
    "但从第二块开始，每一块的播放时长都必须超过下一块的合成时长，否则播放就会追上生成，出现卡顿。"
    "合成速度大约是实时的三分之一，所以一块可以是前一块的两倍多而不至于让听众等待。"
    "还有一个陷阱是播放器本身。它按播放速度排空管道，如果直接在合成循环里往里写，生成就会被播放拖住。"
    "把管道放到后台线程里，问题就消失了。这些约束彼此纠缠，任何一个没处理好，整段朗读听起来都会不自然。"
    "最后要说的是，所有这些常数都依赖于具体的参考音。换一个说话人，语速会变，句间停顿会变，响度也会变。"
    "所以它们不是物理常数，而是这一把嗓子的性质。换嗓子就要重新量一遍。"
)

BUCKETS = ((0, 6), (6, 12), (12, 18), (18, 24), (24, 30), (30, 45), (45, 60), (60, 10**6))


class Encoder:
    """ECAPA-TDNN speaker verification, imported late so `--help` needs no torch."""

    def __init__(self, cache: str):
        import torch
        import torchaudio.functional as functional
        from speechbrain.inference.speaker import EncoderClassifier

        self._torch = torch
        self._resample = functional.resample
        self._model = EncoderClassifier.from_hparams(
            source="speechbrain/spkrec-ecapa-voxceleb", savedir=cache,
            run_opts={"device": "cpu"})

    def __call__(self, samples: np.ndarray, rate: int) -> np.ndarray:
        tensor = self._torch.from_numpy(np.ascontiguousarray(samples, dtype="float32"))
        if rate != 16000:
            tensor = self._resample(tensor, rate, 16000)
        vector = self._model.encode_batch(tensor[None, :]).squeeze()
        return (vector / vector.norm()).numpy()


def windows(samples: np.ndarray, rate: int):
    """Non-overlapping 6s windows. A trailing stub under half a window is dropped."""
    size = int(WINDOW_S * rate)
    for start in range(0, len(samples), size):
        piece = samples[start:start + size]
        if len(piece) < size / 2:
            return
        yield start / rate, piece


def synth(tts: TTSClient, text: str, voice: str, attempts: int = 3):
    """A 500 on the unchunked arm is expected, not exceptional. See the module docstring."""
    for attempt in range(1, attempts + 1):
        try:
            return read_wav(tts.speech(text, voice=voice))
        except Exception as exc:
            if attempt == attempts:
                raise
            print(f"    retry {attempt}: {type(exc).__name__}", file=sys.stderr, flush=True)
            time.sleep(20 * attempt)


def already_measured(path: str) -> set:
    """`(arm, rep)` pairs on disk. A crash must not cost half an hour of GPU."""
    if not os.path.exists(path):
        return set()
    with open(path, encoding="utf-8") as fh:
        return {(row["arm"], row["rep"]) for row in map(json.loads, fh)}


def slope_per_min(xs, ys) -> float:
    if len(xs) < 3:
        return float("nan")
    mx, my = statistics.mean(xs), statistics.mean(ys)
    den = sum((x - mx) ** 2 for x in xs)
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den * 60 if den else float("nan")


def report(rows: list[dict]) -> None:
    # Arms come from the data, not from `--arms`: a report over a file someone else wrote
    # must not depend on spelling its labels the same way again.
    arms = list(dict.fromkeys(r["arm"] for r in rows))

    print("\n=== per arm ===")
    print(f"{'max_seconds':>12} {'chunks':>7} {'windows':>8} {'mean cos':>9} {'std':>7} {'trend/min':>10}")
    for arm in arms:
        sel = [r for r in rows if r["arm"] == arm]
        if not sel:
            continue
        cos = [r["cos"] for r in sel]
        print(f"{arm:>12} {max(r['chunk'] for r in sel) + 1:>7} {len(sel):>8} "
              f"{statistics.mean(cos):>9.4f} {statistics.pstdev(cos):>7.4f} "
              f"{slope_per_min([r['since_start'] for r in sel], cos):>+10.4f}")

    print("\n=== pooled by seconds since the chunk began ===")
    print("A decay here with no plateau means chunk length trades similarity for seams.")
    print(f"{'window':>12} {'n':>5} {'mean cos':>9}")
    for lo, hi in BUCKETS:
        cos = [r["cos"] for r in rows if lo <= r["since_chunk"] < hi]
        if cos:
            print(f"{f'{lo}-{hi}s' if hi < 10**6 else f'{lo}s+':>12} {len(cos):>5} "
                  f"{statistics.mean(cos):>9.4f}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--reference", help="the audio the voice was cloned from")
    parser.add_argument("--voice", help="registered voice id to synthesize with")
    parser.add_argument("--arms", default="15,30,45,60,whole",
                        help="`max_seconds` budgets, plus `whole` for no chunking")
    parser.add_argument("--repeats", type=int, default=3,
                        help="generations per arm; the engine is not reproducible")
    parser.add_argument("--out", default="drift.jsonl",
                        help="every window is appended here; a re-run resumes from it")
    parser.add_argument("--cache", default="./ecapa", help="where to keep the encoder weights")
    parser.add_argument("--report-only", action="store_true",
                        help="re-run the analysis over --out without touching the engine")
    args = parser.parse_args()

    if args.report_only:
        with open(args.out, encoding="utf-8") as fh:
            return report([json.loads(line) for line in fh])

    if not (args.reference and args.voice):
        parser.error("--reference and --voice are required unless --report-only")
    arms = [a.strip() for a in args.arms.split(",") if a.strip()]

    encoder = Encoder(args.cache)
    import soundfile as sf
    reference, ref_rate = sf.read(args.reference, dtype="float32")
    if reference.ndim > 1:
        reference = reference.mean(axis=1)
    ref = encoder(reference, ref_rate)

    cfg = load_config()
    done = already_measured(args.out)
    with TTSClient(cfg.engine("tts"), cfg.tts_defaults) as tts, \
            open(args.out, "a", encoding="utf-8") as out:
        for arm in arms:
            for rep in range(args.repeats):
                if (arm, rep) in done:
                    print(f"{arm:>6} rep{rep}  already measured", flush=True)
                    continue
                chunks = [PASSAGE] if arm == "whole" else chunk_text(PASSAGE, float(arm))
                elapsed = 0.0
                for index, chunk in enumerate(chunks):
                    samples, rate = synth(tts, chunk, args.voice)
                    samples = trim_edge_silence(samples, rate)
                    for offset, piece in windows(samples, rate):
                        out.write(json.dumps({
                            "arm": arm, "rep": rep, "chunk": index,
                            "since_chunk": offset + WINDOW_S / 2,
                            "since_start": elapsed + offset + WINDOW_S / 2,
                            "cos": float(ref @ encoder(piece, rate)),
                        }) + "\n")
                    elapsed += len(samples) / rate
                out.flush()  # a crash in a later arm must not cost this one
                print(f"{arm:>6} rep{rep}  {len(chunks):>2} chunk(s)  {elapsed:6.1f}s audio",
                      flush=True)

    with open(args.out, encoding="utf-8") as fh:
        report([json.loads(line) for line in fh])


if __name__ == "__main__":
    main()
