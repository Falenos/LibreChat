"""Current upstream loaders — mirrors the extension→loader mapping in the overlay's
get_loader() (knauf/rag-api-overlay/document_loader.py) when Azure DI is disabled.

We instantiate the langchain loaders directly rather than importing the overlay module,
because that module imports app.config (which connects to the rag_api DB on import) and
would not load standalone. The mapping below is kept in sync with the overlay's branches.
"""
from __future__ import annotations

from pathlib import Path

from .base import BaseAdapter


def _md_cell(value) -> str:
    s = "" if value is None else str(value)
    return s.replace("|", "\\|").replace("\n", " ").strip()


def _lean_xlsx_markdown(filepath: str) -> str:
    """Compact .xlsx -> per-sheet markdown (non-empty rows/cols only). Mirrors the overlay's
    `_LeanExcelLoader` so the benchmark reflects production — keep the two in sync."""
    import openpyxl

    wb = openpyxl.load_workbook(filepath, read_only=True, data_only=True)
    try:
        blocks = []
        for ws in wb.worksheets:
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
            rows = [r[:width] + [""] * (width - len(r)) for r in rows]
            header, body = rows[0], rows[1:]
            lines = [
                f"## {ws.title}", "",
                "| " + " | ".join(header) + " |",
                "| " + " | ".join("---" for _ in header) + " |",
            ]
            lines += ["| " + " | ".join(r) + " |" for r in body]
            blocks.append("\n".join(lines))
    finally:
        wb.close()
    return "\n\n".join(blocks)


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
