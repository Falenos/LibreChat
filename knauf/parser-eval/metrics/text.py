"""Classic text-fidelity metrics vs a ground-truth reference (CER/WER + edit similarity).

Only used for docs that have corpus/ground_truth/<stem>.md. Whitespace is normalized
first so wrapping/spacing noise doesn't dominate the score.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common import normalize_ws  # noqa: E402


def text_metrics(hypothesis: str, reference: str) -> dict:
    ref = normalize_ws(reference)
    hyp = normalize_ws(hypothesis)
    if not ref:
        return {}
    out: dict = {}
    try:
        import jiwer

        out["cer"] = round(jiwer.cer(ref, hyp), 4)
        out["wer"] = round(jiwer.wer(ref, hyp), 4)
    except Exception as e:  # noqa: BLE001
        out["cer_error"] = str(e)
    try:
        from rapidfuzz.distance import Levenshtein

        out["norm_edit_sim"] = round(Levenshtein.normalized_similarity(ref, hyp), 4)
    except Exception:  # noqa: BLE001
        pass
    return out
