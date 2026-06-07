"""Shared helpers for the parser-eval harness."""
from __future__ import annotations

import re
from pathlib import Path

# OmniDocBench-style corpus categories (subfolders under corpus/).
CATEGORIES = ["digital_pdf", "scanned_pdf", "tables", "multicol", "office"]
# Reserved corpus subfolders that are NOT documents to parse.
RESERVED = {"ground_truth", "qa"}

_MIME_BY_EXT = {
    "pdf": "application/pdf",
    "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "doc": "application/msword",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "xls": "application/vnd.ms-excel",
    "pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "ppt": "application/vnd.ms-powerpoint",
    "html": "text/html",
    "md": "text/markdown",
    "txt": "text/plain",
    "json": "application/json",
    "csv": "text/csv",
}


def guess_mime(filepath: str) -> str:
    ext = Path(filepath).suffix.lower().lstrip(".")
    return _MIME_BY_EXT.get(ext, "application/octet-stream")


def count_pages(filepath: str) -> int | None:
    """Best-effort page count (PDF only). Returns None for non-PDF / on failure."""
    ext = Path(filepath).suffix.lower().lstrip(".")
    if ext != "pdf":
        return None
    try:
        from pypdf import PdfReader

        return len(PdfReader(filepath).pages)
    except Exception:
        try:
            import fitz  # pymupdf

            with fitz.open(filepath) as doc:
                return doc.page_count
        except Exception:
            return None


def normalize_ws(text: str | None) -> str:
    """Collapse whitespace — used before text-similarity metrics so formatting noise
    (line wraps, double spaces) doesn't dominate CER/WER."""
    return re.sub(r"\s+", " ", text or "").strip()


def slugify(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_")


def iter_corpus(corpus_dir: str):
    """Yield (category, path) for every document under corpus/<category>/,
    skipping the reserved ground_truth/ and qa/ folders and dotfiles."""
    root = Path(corpus_dir)
    for cat_dir in sorted(p for p in root.iterdir() if p.is_dir()):
        if cat_dir.name in RESERVED:
            continue
        for f in sorted(cat_dir.rglob("*")):
            name = f.name
            # skip dotfiles, Office lock/temp files (~$...), and the corpus README
            if not f.is_file() or name.startswith((".", "~$")) or name.lower() == "readme.md":
                continue
            yield cat_dir.name, str(f)


def ground_truth_path(corpus_dir: str, doc_name: str) -> str | None:
    """Reference markdown for a doc, if present at corpus/ground_truth/<stem>.md."""
    gt = Path(corpus_dir) / "ground_truth" / (Path(doc_name).stem + ".md")
    return str(gt) if gt.exists() else None


def qa_path(corpus_dir: str, doc_name: str) -> str | None:
    """Q&A file for a doc, if present at corpus/qa/<stem>.yaml."""
    qa = Path(corpus_dir) / "qa" / (Path(doc_name).stem + ".yaml")
    return str(qa) if qa.exists() else None
