"""Current upstream loaders — mirrors the extension→loader mapping in the overlay's
get_loader() (knauf/rag-api-overlay/document_loader.py) when Azure DI is disabled.

We instantiate the langchain loaders directly rather than importing the overlay module,
because that module imports app.config (which connects to the rag_api DB on import) and
would not load standalone. The mapping below is kept in sync with the overlay's branches.
"""
from __future__ import annotations

import os
from pathlib import Path

from .base import BaseAdapter


def _md_cell(value) -> str:
    s = "" if value is None else str(value)
    return s.replace("|", "\\|").replace("\n", " ").strip()


def _lean_xlsx_markdown(filepath: str) -> str:
    """`.xlsx` -> compact, RAG-friendly text: one self-describing record per row
    ("(<sheet>) Header: value; ...") so the char splitter keeps rows + headers together. Skips
    hidden sheets; above RAG_XLSX_MAX_CHARS emits a per-sheet summary. Mirrors the overlay's
    `_LeanExcelLoader` — keep the two in sync."""
    import openpyxl

    max_chars = int(os.getenv("RAG_XLSX_MAX_CHARS") or "1500000")  # 0 = unlimited
    summary_rows = int(os.getenv("RAG_XLSX_SUMMARY_ROWS") or "50")

    wb = openpyxl.load_workbook(filepath, read_only=True, data_only=True)
    sheets = []  # (title, [record, ...], n_cols)
    try:
        for ws in wb.worksheets:
            if getattr(ws, "sheet_state", "visible") != "visible":
                continue
            rows = [
                cells
                for row in ws.iter_rows(values_only=True)
                if any(cells := [_md_cell(c) for c in row])
            ]
            if not rows:
                continue
            width = max((i + 1 for r in rows for i, c in enumerate(r) if c), default=0)
            if not width:
                continue
            # header = the most-populated row among the first few (skips title rows above it)
            hdr_idx = max(range(len(rows[:8])), key=lambda i: sum(1 for c in rows[i] if c))
            header = (list(rows[hdr_idx]) + [""] * width)[:width]
            records = []
            for r in rows[hdr_idx + 1:]:
                r = (list(r) + [""] * width)[:width]
                pairs = [f"{header[i] or f'col{i + 1}'}: {v}" for i, v in enumerate(r) if v]
                if pairs:
                    records.append(f"({ws.title}) " + "; ".join(pairs))
            if records:
                sheets.append((ws.title, records, width))
    finally:
        wb.close()

    full = "\n\n".join(f"# {t}\n" + "\n".join(recs) for t, recs, _ in sheets)
    if not max_chars or len(full) <= max_chars:
        return full
    total = sum(len(recs) for _, recs, _ in sheets)
    parts = [
        f"[knauf] Large workbook summary — {total:,} rows across {len(sheets)} sheet(s); "
        f"full content omitted to keep ingestion fast. Showing up to {summary_rows} rows per sheet."
    ]
    for t, recs, ncol in sheets:
        shown = recs[:summary_rows]
        block = [f"# {t} ({len(recs):,} rows x {ncol} cols)"] + shown
        if len(recs) > len(shown):
            block.append(f"... (+{len(recs) - len(shown):,} more rows omitted)")
        parts.append("\n".join(block))
    return "\n\n".join(parts)


class UpstreamAdapter(BaseAdapter):
    name = "upstream"

    def __init__(self, **_ignore):
        pass

    def _extract(self, filepath: str, mimetype: str):
        from langchain_community.document_loaders import (
            CSVLoader,
            Docx2txtLoader,
            PyPDFLoader,
            TextLoader,
            UnstructuredExcelLoader,
            UnstructuredMarkdownLoader,
            UnstructuredPowerPointLoader,
        )

        ext = Path(filepath).suffix.lower().lstrip(".")
        if ext == "xlsx":
            return _lean_xlsx_markdown(filepath), None
        if ext == "pdf":
            # Overlay uses SafePyPDFLoader (PyPDFLoader + image-OCR fallback); for the
            # comparison we use plain PyPDFLoader (extract_images=False) — the digital-text
            # path, i.e. exactly what production does for non-scanned PDFs.
            loader = PyPDFLoader(filepath, extract_images=False)
        elif ext == "csv":
            loader = CSVLoader(filepath)
        elif ext in ("doc", "docx"):
            loader = Docx2txtLoader(filepath)
        elif ext == "xls":
            loader = UnstructuredExcelLoader(filepath)
        elif ext in ("ppt", "pptx"):
            loader = UnstructuredPowerPointLoader(filepath)
        elif ext == "md":
            loader = UnstructuredMarkdownLoader(filepath)
        else:
            loader = TextLoader(filepath, autodetect_encoding=True)

        docs = loader.load()
        text = "\n\n".join(d.page_content for d in docs)
        return text, None
