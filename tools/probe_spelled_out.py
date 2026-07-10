#!/usr/bin/env python
"""Probe how the engine reads letter runs: as a word, or spelled out letter by letter.

    uv run python tools/probe_spelled_out.py

This exists to document a rule that is *not* implemented, and to let you re-check that
decision on a new voice or model. `est_seconds` prices a Latin character at the prose
rate. A letter run the model spells out costs three to four times that, and nothing in
the string says which it will be.

Each probe is measured inside a fixed carrier sentence and the empty carrier is
subtracted. The absolute per-character numbers this yields are **not trustworthy** -- the
empty carrier is ungrammatical and is read faster than a real sentence, which drags every
difference down (a two-character Chinese word comes out at 0.06 s/char against a true
0.185). Only compare probes with each other.

What it showed on the default clone voice:

    banana   0.060 s/char   read as a word
    NASA     0.098 s/char   read as a word
    voxcpm   0.205 s/char   spelled out
    TTS      0.203 s/char   spelled out

Case is not the signal: `NASA` is uppercase and read as a word, `voxcpm` is lowercase and
spelled out. Separating the two needs a lexicon or a phonotactic model, which a chunker
has no business carrying. So the estimate is left wrong here, on purpose. It is only wrong
where such runs are dense, and a chunk dense in acronyms is a short chunk: a 25% overshoot
on 2.8 seconds drifts nothing. A 30s chunk dilutes them.
"""

from voxcore import est_seconds, load_config, read_wav, trim_edge_silence
from voxcore.clients.tts import TTSClient

CARRIER = "这是{}的测试。"

PROBES = (
    "苹果",       # a real Chinese word: the control
    "banana",    # a pronounceable lowercase word
    "NASA",      # a pronounceable uppercase acronym
    "voxcpm",    # an unpronounceable lowercase run
    "VoxCPM2",   # what this project is actually called
    "TTS",
    "CPU",
    "GPU",
    "API",
)


def spoken_seconds(tts: TTSClient, text: str) -> float:
    samples, rate = read_wav(tts.speech(text))
    return len(trim_edge_silence(samples, rate)) / rate


def main() -> None:
    cfg = load_config()
    with TTSClient(cfg.engine("tts"), cfg.tts_defaults) as tts:
        baseline = spoken_seconds(tts, CARRIER.format(""))
        print(f"empty carrier {CARRIER.format('')!r}: {baseline:.2f}s")
        print(f"\n{'probe':10} {'chars':>5} {'probe_s':>8} {'s/char':>7} {'est_s/char':>11}")

        for probe in PROBES:
            total = spoken_seconds(tts, CARRIER.format(probe))
            cost = total - baseline
            print(f"{probe:10} {len(probe):>5} {cost:>7.2f}s {cost / len(probe):>7.3f} "
                  f"{est_seconds(probe) / len(probe):>11.3f}")

    print("\nCompare probes with each other, not against est_s/char: the empty carrier is "
          "read faster than real prose, so every difference is biased low.")


if __name__ == "__main__":
    main()
