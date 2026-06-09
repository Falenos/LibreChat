"""LLM-as-judge — the highest-human-correlation scorer (SCORE-Bench: r≈0.93 vs TEDS 0.68).

Vision-grounded: each source page is rendered to an image and shown to a vision LLM
(Azure OpenAI gpt-4o on cst-karl-dev) alongside a strategy's extracted markdown. Produces:
  - a rubric score (completeness / table_fidelity / reading_order / cleanliness, 1-5 + overall)
  - pairwise A/B verdicts between two strategies' outputs.

Judgements are cached on disk (.judge_cache/) keyed by a content hash so re-runs are cheap
and comparable. Degrades gracefully (`available=False`) when creds/SDK are missing.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path

PROMPT_VERSION = "v1"
_CACHE_DIR = Path(__file__).resolve().parent.parent / ".judge_cache"

_RUBRIC_SYS = (
    "You are a meticulous evaluator of document-parsing quality. You are shown one or more "
    "images of the SOURCE document pages and the TEXT that a parser extracted from them. "
    "Rate how faithfully the extracted text represents the source. Reply with STRICT JSON: "
    '{"completeness":1-5,"table_fidelity":1-5,"reading_order":1-5,"cleanliness":1-5,'
    '"overall":1-5,"notes":"<=2 sentences"}. '
    "completeness=all text/numbers captured; table_fidelity=tables/structure preserved "
    "(use 3 if the document has no tables); reading_order=logical flow matches the page; "
    "cleanliness=free of OCR garble, hallucinations, and junk. Be strict and consistent."
)

_PAIR_SYS = (
    "You compare two parser outputs (A and B) against the SOURCE page image(s). Decide which "
    "extraction is more faithful overall (completeness, tables, reading order, cleanliness). "
    'Reply STRICT JSON: {"winner":"A"|"B"|"tie","reason":"<=2 sentences"}.'
)


def render_pages(filepath: str, max_pages: int = 3) -> list[str]:
    """Return base64 PNGs of the first `max_pages` pages (PDF only; [] otherwise)."""
    if not filepath.lower().endswith(".pdf"):
        return []
    try:
        import fitz  # pymupdf
    except Exception:  # noqa: BLE001
        return []
    out = []
    try:
        with fitz.open(filepath) as doc:
            for page in list(doc)[:max_pages]:
                pix = page.get_pixmap(dpi=150)
                out.append(base64.b64encode(pix.tobytes("png")).decode())
    except Exception:  # noqa: BLE001
        return []
    return out


def _img_part(b64: str) -> dict:
    return {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}


class JudgeClient:
    def __init__(self, cfg: dict):
        jcfg = (cfg or {}).get("judge", {}) or {}
        self.enabled = jcfg.get("enabled", True)
        self.deployment = jcfg.get("deployment", "gpt-4o")
        self.api_version = jcfg.get("api_version", "2024-10-21")
        self.max_pages = int(jcfg.get("max_pages_judged", 3))
        endpoint = jcfg.get("azure_endpoint") or _derive_endpoint()
        key = os.getenv("AZURE_OPENAI_API_KEY", "")
        self.endpoint = endpoint  # reused by the ragas backend (metrics/rag.py)
        self._client = None
        self.reason_unavailable = None
        if not self.enabled:
            self.reason_unavailable = "judge.enabled=false"
        elif not (endpoint and key):
            self.reason_unavailable = "AZURE_OPENAI_API_KEY / endpoint not set"
        else:
            try:
                from openai import AzureOpenAI

                self._client = AzureOpenAI(
                    api_key=key, azure_endpoint=endpoint, api_version=self.api_version
                )
            except Exception as e:  # noqa: BLE001
                self.reason_unavailable = f"openai SDK init failed: {e}"
        _CACHE_DIR.mkdir(exist_ok=True)

    @property
    def available(self) -> bool:
        return self._client is not None

    # -- internal -----------------------------------------------------------
    def _chat_json(self, system: str, parts: list[dict], cache_key: str) -> dict:
        ck = hashlib.sha256(
            (PROMPT_VERSION + self.deployment + cache_key).encode()
        ).hexdigest()
        cache_file = _CACHE_DIR / f"{ck}.json"
        if cache_file.exists():
            return json.loads(cache_file.read_text())
        resp = self._client.chat.completions.create(
            model=self.deployment,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": parts},
            ],
            response_format={"type": "json_object"},
            temperature=0,
        )
        data = json.loads(resp.choices[0].message.content)
        cache_file.write_text(json.dumps(data))
        return data

    # -- public -------------------------------------------------------------
    def rubric(self, images_b64: list[str], markdown: str, cache_key: str) -> dict:
        if not self.available:
            return {}
        parts: list[dict] = [{"type": "text", "text": "SOURCE PAGE IMAGE(S):"}]
        parts += [_img_part(b) for b in images_b64]
        parts.append(
            {"type": "text", "text": "EXTRACTED TEXT:\n\n" + (markdown or "")[:14000]}
        )
        try:
            d = self._chat_json(_RUBRIC_SYS, parts, "rubric|" + cache_key)
            return {f"judge_{k}": v for k, v in d.items() if k != "notes"} | {
                "judge_notes": d.get("notes", "")
            }
        except Exception as e:  # noqa: BLE001
            return {"judge_error": str(e)}

    def pairwise(self, images_b64, md_a, md_b, cache_key) -> dict:
        if not self.available:
            return {}
        parts: list[dict] = [{"type": "text", "text": "SOURCE PAGE IMAGE(S):"}]
        parts += [_img_part(b) for b in images_b64]
        parts.append({"type": "text", "text": "OUTPUT A:\n\n" + (md_a or "")[:9000]})
        parts.append({"type": "text", "text": "OUTPUT B:\n\n" + (md_b or "")[:9000]})
        try:
            return self._chat_json(_PAIR_SYS, parts, "pair|" + cache_key)
        except Exception as e:  # noqa: BLE001
            return {"winner": "tie", "reason": f"error: {e}"}


def _derive_endpoint() -> str:
    """Prefer an explicit Azure OpenAI endpoint; else derive from RAG_OPENAI_BASEURL
    (e.g. https://cst-karl-dev.openai.azure.com/openai/v1 -> https://cst-karl-dev.openai.azure.com/)."""
    base = os.getenv("RAG_OPENAI_BASEURL", "")
    if base:
        return base.split("/openai")[0].rstrip("/") + "/"
    return ""
