"""Pin the voxkit mirror to the shared text fixtures.

Production is `packages/text/src/index.ts`, verified against the same JSON by bun test.
If voxkit drifts from those fixtures, the calibration scripts are measuring against
different semantics than production runs -- that is the failure this file exists to catch.
"""

import json
from pathlib import Path

import pytest

from voxkit import chunk_text, est_seconds

FIXTURES = Path(__file__).parents[2] / "fixtures" / "text"


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", fixture("estimate.json"), ids=lambda case: case["name"])
def test_estimate_matches_shared_contract(case):
    expected = est_seconds(case["sameAs"]) if "sameAs" in case else case["expected"]
    assert est_seconds(case["input"]) == pytest.approx(expected, abs=1e-12)


@pytest.mark.parametrize("case", fixture("chunks.json"), ids=lambda case: case["name"])
def test_chunks_match_shared_contract(case):
    cap = est_seconds(case["capText"]) if "capText" in case else case["maxSeconds"]
    first = (est_seconds(case["firstCapText"]) if "firstCapText" in case
             else case.get("firstMaxSeconds"))
    assert chunk_text(case["input"], cap, first_max_seconds=first) == case["expected"]


def test_candidate_rate_table_changes_the_estimate():
    # `measure_speech_rates.py` validates a fit by re-pricing under the candidate table.
    slow = est_seconds("啊啊啊啊啊", rates={"Han": 1.0})
    assert slow == pytest.approx(5.0)
    assert est_seconds("啊啊啊啊啊") != slow
