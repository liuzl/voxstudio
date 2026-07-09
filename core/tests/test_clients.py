"""Parsing and error normalization -- the parts that need no engine."""

import pytest

from voxcore import normalize_error
from voxcore.clients.asr import parse_transcript
from voxcore.clients.llm import extract_content


@pytest.mark.parametrize("body", [
    {"detail": {"error": {"code": "voice_not_found", "message": "Unknown voice id."}}},  # FastAPI
    {"error": {"code": "voice_not_found", "message": "Unknown voice id."}},              # C++ server
])
def test_both_error_envelopes_normalize_the_same(body):
    err = normalize_error(400, body)
    assert (err.status, err.code, err.message) == (400, "voice_not_found", "Unknown voice id.")


def test_non_json_body_still_yields_an_error():
    err = normalize_error(502, b"<html>bad gateway</html>")
    assert err.status == 502 and err.code == "engine_error"


def test_fastapi_validation_detail_is_stringified():
    err = normalize_error(422, {"detail": [{"loc": ["body", "input"]}]})
    assert err.status == 422 and "loc" in err.message


def test_transcript_strips_trailing_language_tag():
    assert parse_transcript("今天天气很好 <zh-CN>") == ("今天天气很好", "zh")


def test_transcript_strips_a_tag_per_sentence():
    result = parse_transcript("Hello there.<en-US> How are you?<en-US>")
    assert result.text == "Hello there. How are you?"
    assert result.lang == "en"


def test_transcript_without_a_tag_has_no_language():
    # verbose_json.language is hardcoded "en" upstream, so absence means unknown.
    assert parse_transcript("bare text") == ("bare text", None)


def test_llm_content_is_taken_and_reasoning_ignored():
    payload = {"choices": [{"message": {"reasoning_content": "thinking...", "content": "答案"}}]}
    assert extract_content(payload) == "答案"


def test_llm_truncated_reasoning_yields_empty_content():
    # A max_tokens small enough to cut off the reasoning leaves content missing.
    payload = {"choices": [{"message": {"reasoning_content": "thinking..."}}]}
    assert extract_content(payload) == ""


def test_llm_no_choices():
    assert extract_content({}) == ""
