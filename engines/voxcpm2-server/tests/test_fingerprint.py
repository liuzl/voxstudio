from fingerprint import audio_fingerprint


def test_audio_fingerprint_is_stable_and_content_addressed():
    assert audio_fingerprint(b"generated wav") == audio_fingerprint(b"generated wav")
    assert audio_fingerprint(b"generated wav") != audio_fingerprint(b"other wav")
    assert audio_fingerprint(b"generated wav") == (
        "42a0b3526ac433b227ee7f3e643a08247495329c4305e491b22da25f5fd65e9e"
    )
