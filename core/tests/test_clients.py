"""Parsing and error normalization -- the parts that need no engine."""

import json
from pathlib import Path

import pytest

from voxcore import normalize_error
from voxcore.clients.asr import parse_transcript
from voxcore.clients.llm import extract_content


FIXTURES = Path(__file__).parents[2] / "fixtures" / "contracts"


def load_fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", load_fixture("errors.json"), ids=lambda case: case["name"])
def test_error_contract(case):
    err = normalize_error(case["status"], case["body"])
    expected = case["expected"]
    assert err.status == case["status"]
    assert err.code == expected["code"]
    if message := expected.get("message"):
        assert err.message == message
    if fragment := expected.get("messageContains"):
        assert fragment in err.message
    assert err.type == expected.get("type")


@pytest.mark.parametrize("case", load_fixture("transcripts.json"), ids=lambda case: case["name"])
def test_transcript_contract(case):
    result = parse_transcript(case["raw"])
    assert {"text": result.text, "lang": result.lang} == case["expected"]


@pytest.mark.parametrize("case", load_fixture("chat-content.json"), ids=lambda case: case["name"])
def test_chat_content_contract(case):
    assert extract_content(case["payload"]) == case["expected"]
