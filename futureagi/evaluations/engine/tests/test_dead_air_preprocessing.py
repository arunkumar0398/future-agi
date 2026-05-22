"""
Tests for the dead_air_detection preprocessor.

The preprocessor decodes audio with librosa on the API server and injects
``_dead_air_*`` kwargs into the sandbox payload. The sandbox body (in
evaluations/catalog/system_eval_code.py) just reads those numbers and
applies user-tunable pass/fail thresholds; that logic is trivial enough
to verify by inspection so we focus tests on the decode/SSRF path here.
"""

from __future__ import annotations

import io
import math
from unittest.mock import MagicMock, patch

import pytest

from evaluations.engine.preprocessing import PREPROCESSORS, preprocess_inputs


def test_dead_air_preprocessor_registered():
    assert "dead_air_detection" in PREPROCESSORS


def test_missing_audio_returns_error():
    out = preprocess_inputs("dead_air_detection", {})
    assert out["_dead_air_error"] == "Missing input_audio"


def test_unresolvable_input_returns_error():
    out = preprocess_inputs("dead_air_detection", {"input_audio": "not-a-url"})
    assert "_dead_air_error" in out


def test_blocked_host_never_fetches():
    with patch("evaluations.engine.preprocessing.requests.get") as mock_get:
        out = preprocess_inputs(
            "dead_air_detection",
            {"input_audio": "http://169.254.169.254/audio.wav"},
        )
        mock_get.assert_not_called()
    assert "_dead_air_error" in out


def _synth_wav_bytes(duration_sec=2.0, sr=8000, silence_segments=None):
    try:
        import numpy as np
        import soundfile as sf
    except ImportError:
        pytest.skip("numpy/soundfile not installed")
    n = int(duration_sec * sr)
    t = np.linspace(0, duration_sec, n, endpoint=False)
    y = 0.5 * np.sin(2 * math.pi * 440 * t).astype("float32")
    for (s, e) in silence_segments or []:
        y[int(s * sr):int(e * sr)] = 0.0
    buf = io.BytesIO()
    sf.write(buf, y, sr, format="WAV")
    return buf.getvalue()


def _mock_audio_response(body):
    resp = MagicMock()
    resp.status_code = 200
    resp.headers = {"Content-Type": "audio/wav"}

    def _iter(chunk_size=64 * 1024):
        for i in range(0, len(body), chunk_size):
            yield body[i:i + chunk_size]

    resp.iter_content = _iter
    resp.__enter__.return_value = resp
    resp.__exit__.return_value = False
    return resp


def test_clean_audio_has_low_dead_air():
    body = _synth_wav_bytes(duration_sec=1.0, silence_segments=None)
    with patch(
        "evaluations.engine.preprocessing.requests.get",
        return_value=_mock_audio_response(body),
    ):
        out = preprocess_inputs(
            "dead_air_detection",
            {"input_audio": "https://example.com/clean.wav"},
        )
    assert "_dead_air_error" not in out
    assert out["_dead_air_percentage"] < 5.0
    assert out["_dead_air_max_gap_ms"] < 200.0


def test_silent_audio_is_mostly_dead_air():
    body = _synth_wav_bytes(
        duration_sec=2.0,
        silence_segments=[(0.0, 1.6)],
    )
    with patch(
        "evaluations.engine.preprocessing.requests.get",
        return_value=_mock_audio_response(body),
    ):
        out = preprocess_inputs(
            "dead_air_detection",
            {"input_audio": "https://example.com/silent.wav"},
        )
    assert "_dead_air_error" not in out
    assert out["_dead_air_percentage"] > 50.0
    assert out["_dead_air_max_gap_ms"] > 1000.0
