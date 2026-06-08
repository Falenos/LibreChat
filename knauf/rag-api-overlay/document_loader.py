# app/utils/document_loader.py

import os
import codecs
import tempfile

from typing import Iterator, List, Optional
import chardet

from langchain_core.documents import Document

from app.config import known_source_ext, PDF_EXTRACT_IMAGES, CHUNK_OVERLAP, logger
from langchain_community.document_loaders import (
    AzureAIDocumentIntelligenceLoader,  # [knauf]
    TextLoader,
    PyPDFLoader,
    CSVLoader,
    Docx2txtLoader,
    UnstructuredEPubLoader,
    UnstructuredMarkdownLoader,
    UnstructuredXMLLoader,
    UnstructuredRSTLoader,
    UnstructuredExcelLoader,
    UnstructuredPowerPointLoader,
)


# [knauf] Azure AI Document Intelligence routing for file-search (RAG) ingestion.
# Opt-in: when endpoint + key are set, the configured file extensions are parsed
# via Azure DI (OCR + layout -> markdown) so scanned/image PDFs become searchable.
# When the RAG_AZURE_DI_* vars are unset, this module behaves identically to upstream.
_AZURE_DI_ENDPOINT = os.getenv("RAG_AZURE_DI_ENDPOINT", "").strip()
_AZURE_DI_KEY = os.getenv("RAG_AZURE_DI_KEY", "").strip()
_AZURE_DI_API_MODEL = os.getenv("RAG_AZURE_DI_API_MODEL", "prebuilt-layout").strip()
_AZURE_DI_MODE = os.getenv("RAG_AZURE_DI_MODE", "markdown").strip()
_AZURE_DI_FILE_EXTS = {
    ext.strip().lower()
    for ext in os.getenv("RAG_AZURE_DI_FILE_EXTS", "pdf").split(",")
    if ext.strip()
}

# [knauf] Native xlsx guard: above _XLSX_MAX_CHARS of extracted text, emit a per-sheet SUMMARY
# (first _XLSX_SUMMARY_ROWS rows/sheet) instead of the full dump, so a giant workbook doesn't
# become ~thousands of embedding chunks. 0 = unlimited (always full).
_XLSX_MAX_CHARS = int(os.getenv("RAG_XLSX_MAX_CHARS") or "1500000")
_XLSX_SUMMARY_ROWS = int(os.getenv("RAG_XLSX_SUMMARY_ROWS") or "50")


# Extensions that identify binary file formats handled by dedicated loaders.
# Used to prevent a conflicting multipart Content-Type (e.g. ``text/markdown``)
# from hijacking these files into a text loader.
_BINARY_FILE_EXTENSIONS = frozenset(
    {"pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "epub"}
)


def detect_file_encoding(filepath: str) -> str:
    """
    Detect the encoding of a file using BOM markers and chardet for broader support.
    Returns the detected encoding or 'utf-8' as default.
    """
    with open(filepath, "rb") as f:
        raw = f.read(4096)  # Read a larger sample for better detection

    # Check for BOM markers first
    if raw.startswith(codecs.BOM_UTF16_LE):
        return "utf-16-le"
    elif raw.startswith(codecs.BOM_UTF16_BE):
        return "utf-16-be"
    elif raw.startswith(codecs.BOM_UTF16):
        return "utf-16"
    elif raw.startswith(codecs.BOM_UTF8):
        return "utf-8-sig"
    elif raw.startswith(codecs.BOM_UTF32_LE):
        return "utf-32-le"
    elif raw.startswith(codecs.BOM_UTF32_BE):
        return "utf-32-be"

    # Use chardet to detect encoding if no BOM is found
    result = chardet.detect(raw)
    encoding = result.get("encoding")
    if encoding:
        return encoding.lower()
    # Default to utf-8 if detection fails
    return "utf-8"


def cleanup_temp_encoding_file(loader) -> None:
    """
    Clean up temporary UTF-8 file if it was created for encoding conversion.

    :param loader: The document loader that may have created a temporary file
    """
    if hasattr(loader, "_temp_filepath") and loader._temp_filepath is not None:
        try:
            os.remove(loader._temp_filepath)
        except Exception as e:
            logger.warning(f"Failed to remove temporary UTF-8 file: {e}")


class _AzureDIWithFallback:
    """[knauf] Parse via Azure AI Document Intelligence; if the DI call fails (e.g. an xlsx
    that exceeds DI's Office limits, an unsupported/odd file, or a transient error/outage),
    fall back to the upstream loader for this file so the file-search upload still succeeds
    instead of erroring. DI is built for OCR/layout of documents; native spreadsheets etc.
    are best left to the upstream loaders (and excluded from RAG_AZURE_DI_FILE_EXTS)."""

    def __init__(self, filename, file_content_type, filepath, raw_text):
        self.filename = filename
        self.file_content_type = file_content_type
        self.filepath = filepath
        self.raw_text = raw_text
        self._temp_filepath = None  # for cleanup_temp_encoding_file() compatibility

    def _load_via_di(self):
        logger.info(
            f"[knauf] Parsing '{self.filename}' via Azure AI Document Intelligence "
            f"(model={_AZURE_DI_API_MODEL}, mode={_AZURE_DI_MODE})"
        )
        return AzureAIDocumentIntelligenceLoader(
            api_endpoint=_AZURE_DI_ENDPOINT,
            api_key=_AZURE_DI_KEY,
            file_path=self.filepath,
            api_model=_AZURE_DI_API_MODEL,
            mode=_AZURE_DI_MODE,
        ).load()

    def load(self):
        try:
            docs = self._load_via_di()
        except Exception as e:  # noqa: BLE001 — degrade, don't fail the upload
            logger.warning(
                f"[knauf] Azure DI failed for '{self.filename}' ({type(e).__name__}: {e}); "
                "falling back to the upstream loader."
            )
            loader, _, _ = get_loader(
                self.filename, self.file_content_type, self.filepath, self.raw_text, _no_di=True
            )
            return loader.load()
        # [knauf] The Azure DI loader does NOT set metadata["source"]: in markdown/single mode it
        # stores the raw analyze result (result.as_dict()), in page mode only "page" — never the
        # file path. Every upstream loader sets source=filepath, and both rag_api's
        # process_documents() and LibreChat's file_search tool (docInfo.metadata.source.split("/"))
        # rely on it — a missing source throws "Cannot read properties of undefined (reading
        # 'split')" at query time. Normalize to the loader contract (and drop the multi-MB DI
        # result dict we'd otherwise embed as per-chunk metadata).
        for doc in docs:
            page = doc.metadata.get("page") if isinstance(doc.metadata, dict) else None
            doc.metadata = {"source": self.filepath}
            if page is not None:
                doc.metadata["page"] = page
        return docs

    def lazy_load(self):
        yield from self.load()


def _md_cell(value) -> str:
    s = "" if value is None else str(value)
    return s.replace("|", "\\|").replace("\n", " ").strip()


class _LeanExcelLoader:
    """[knauf] .xlsx -> compact, RAG-friendly text. Emits one self-describing record per row
    ("(<sheet>) Header: value; Header: value; ...") so rag_api's char-based splitter packs whole
    rows per chunk and never drops the headers — structure-aware chunking via input shaping, with
    no rag_api change. Skips hidden sheets + empty rows/cols; reads cached cell VALUES via openpyxl.
    Above _XLSX_MAX_CHARS it emits a per-sheet summary instead of the full dump (see guard above).
    NOTE: keep in sync with knauf/parser-eval/adapters/upstream.py."""

    def __init__(self, filepath: str):
        self.filepath = filepath
        self._temp_filepath = None  # cleanup_temp_encoding_file() compatibility

    def _render(self):
        import openpyxl

        wb = openpyxl.load_workbook(self.filepath, read_only=True, data_only=True)
        sheets = []  # (title, [record, ...], n_cols)
        try:
            for ws in wb.worksheets:
                if getattr(ws, "sheet_state", "visible") != "visible":
                    continue  # skip hidden / veryHidden tabs
                rows = [
                    cells
                    for row in ws.iter_rows(values_only=True)
                    if any(cells := [_md_cell(c) for c in row])  # drop fully-empty rows
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
        if not _XLSX_MAX_CHARS or len(full) <= _XLSX_MAX_CHARS:
            text = full
        else:
            total = sum(len(recs) for _, recs, _ in sheets)
            logger.warning(
                f"[knauf] xlsx '{os.path.basename(self.filepath)}' is large "
                f"({len(full):,} chars / {total:,} rows) > RAG_XLSX_MAX_CHARS={_XLSX_MAX_CHARS:,}; "
                f"emitting a summary (first {_XLSX_SUMMARY_ROWS} rows/sheet)."
            )
            parts = [
                f"[knauf] Large workbook summary — {total:,} rows across {len(sheets)} sheet(s); "
                f"full content omitted from search to keep ingestion fast. Showing up to "
                f"{_XLSX_SUMMARY_ROWS} rows per sheet — ask a specific lookup or open the source file."
            ]
            for t, recs, ncol in sheets:
                shown = recs[:_XLSX_SUMMARY_ROWS]
                block = [f"# {t} ({len(recs):,} rows x {ncol} cols)"] + shown
                if len(recs) > len(shown):
                    block.append(f"... (+{len(recs) - len(shown):,} more rows omitted)")
                parts.append("\n".join(block))
            text = "\n\n".join(parts)
        return [Document(page_content=text, metadata={"source": self.filepath})]

    def load(self):
        return self._render()

    def lazy_load(self):
        yield from self._render()


def get_loader(
    filename: str,
    file_content_type: str,
    filepath: str,
    raw_text: bool = False,
    _no_di: bool = False,
):
    """Get the appropriate document loader based on file type and\or content type.

    When ``raw_text`` is True, text-formatted files (e.g. Markdown) are loaded
    verbatim with :class:`TextLoader` so their original formatting is
    preserved. This is intended for the ``/text`` endpoint, where the caller
    wants the raw file contents. The embedding path should keep the default
    (``raw_text=False``) so semantic loaders continue to strip formatting for
    better vector search quality.
    """
    file_ext = filename.split(".")[-1].lower()
    known_type = True

    # [knauf] Route configured doc types through Azure AI Document Intelligence (OCR +
    # layout -> markdown), with graceful fallback to the upstream loader if the DI call
    # fails (see _AzureDIWithFallback). Opt-in via RAG_AZURE_DI_* env; _no_di=True is used
    # internally by the fallback path to take the upstream branches below.
    if not _no_di and _AZURE_DI_ENDPOINT and _AZURE_DI_KEY and file_ext in _AZURE_DI_FILE_EXTS:
        return (
            _AzureDIWithFallback(filename, file_content_type, filepath, raw_text),
            True,
            file_ext,
        )

    # File Content Type reference:
    # ref.: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/MIME_types/Common_types
    if file_ext == "pdf" or file_content_type == "application/pdf":
        loader = SafePyPDFLoader(filepath, extract_images=PDF_EXTRACT_IMAGES)
    elif file_ext == "csv" or file_content_type == "text/csv":
        # Detect encoding for CSV files
        encoding = detect_file_encoding(filepath)

        if encoding != "utf-8":
            # For non-UTF-8 encodings, convert to UTF-8 using streaming
            # to avoid holding the entire file in memory as a single string
            temp_file = None
            try:
                with tempfile.NamedTemporaryFile(
                    mode="w", encoding="utf-8", suffix=".csv", delete=False
                ) as temp_file:
                    with open(
                        filepath, "r", encoding=encoding, errors="replace"
                    ) as original_file:
                        while True:
                            chunk = original_file.read(64 * 1024)
                            if not chunk:
                                break
                            temp_file.write(chunk)

                    temp_filepath = temp_file.name

                loader = CSVLoader(temp_filepath)
                loader._temp_filepath = temp_filepath
            except Exception as e:
                if temp_file and os.path.exists(temp_file.name):
                    os.unlink(temp_file.name)
                raise e
        else:
            loader = CSVLoader(filepath)
    elif file_ext == "rst":
        loader = UnstructuredRSTLoader(filepath, mode="elements")
    elif file_ext == "xml" or file_content_type in [
        "application/xml",
        "text/xml",
        "application/xhtml+xml",
    ]:
        loader = UnstructuredXMLLoader(filepath)
    elif file_ext in ["ppt", "pptx"] or file_content_type in [
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ]:
        loader = UnstructuredPowerPointLoader(filepath)
    elif file_ext == "md" or (
        file_content_type
        in [
            "text/markdown",
            "text/x-markdown",
            "application/markdown",
            "application/x-markdown",
        ]
        and file_ext not in _BINARY_FILE_EXTENSIONS
    ):
        if raw_text:
            loader = TextLoader(filepath, autodetect_encoding=True)
        else:
            loader = UnstructuredMarkdownLoader(filepath)
    elif file_ext == "epub" or file_content_type == "application/epub+zip":
        loader = UnstructuredEPubLoader(filepath)
    elif file_ext in ["doc", "docx"] or file_content_type in [
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ]:
        loader = Docx2txtLoader(filepath)
    elif file_ext in ["xls", "xlsx"] or file_content_type in [
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]:
        # [knauf] lean per-sheet markdown for .xlsx; legacy .xls stays on Unstructured
        # (openpyxl can't read the old binary .xls format).
        loader = _LeanExcelLoader(filepath) if file_ext == "xlsx" else UnstructuredExcelLoader(filepath)
    elif file_ext == "json" or file_content_type == "application/json":
        loader = TextLoader(filepath, autodetect_encoding=True)
    elif file_ext in known_source_ext or (
        file_content_type and file_content_type.find("text/") >= 0
    ):
        loader = TextLoader(filepath, autodetect_encoding=True)
    else:
        loader = TextLoader(filepath, autodetect_encoding=True)
        known_type = False

    return loader, known_type, file_ext


def clean_text(text: str) -> str:
    """
    Clean up text from PDF lopader

    :param text: The original text
    :return: Cleaned text
    """
    text = remove_null(text)
    text = remove_non_utf8(text)
    return text


def remove_null(text: str) -> str:
    """
    Remove NUL (0x00) characters from a string.

    :param text: The original text with potential NUL characters.
    :return: Cleaned text without NUL characters.
    """
    return text.replace("\x00", "")


def remove_non_utf8(text: str) -> str:
    """
    Remove invalid UTF-8 characters from a string, such as surrogate characters

    :param text: The original text with potential invalid utf-8 characters
    :return: Cleaned text without invalid utf-8 characters.
    """
    try:
        return text.encode("utf-8", "ignore").decode("utf-8")
    except UnicodeError:
        return text


def process_documents(documents: List[Document]) -> str:
    processed_text = ""
    last_page: Optional[int] = None
    doc_basename = ""

    for doc in documents:
        if "source" in doc.metadata:
            doc_basename = doc.metadata["source"].split("/")[-1]
            break

    processed_text += f"{doc_basename}\n"

    for doc in documents:
        current_page = doc.metadata.get("page")
        if current_page and current_page != last_page:
            processed_text += f"\n# PAGE {doc.metadata['page']}\n\n"
            last_page = current_page

        new_content = doc.page_content
        if processed_text.endswith(new_content[:CHUNK_OVERLAP]):
            processed_text += new_content[CHUNK_OVERLAP:]
        else:
            processed_text += new_content

    return processed_text.strip()


class SafePyPDFLoader:
    """
    A wrapper around PyPDFLoader that handles image extraction failures gracefully.
    Falls back to text-only extraction when image extraction fails.

    This is a workaround for issues with PyPDFLoader that can occur when extracting images
    from PDFs, which can lead to KeyError exceptions if the PDF is malformed or has unsupported
    image formats. This class attempts to load the PDF with image extraction enabled, and if it
    fails due to a KeyError related to image filters, it falls back to loading the PDF
    without image extraction.
    ref.: https://github.com/langchain-ai/langchain/issues/26652
    """

    def __init__(self, filepath: str, extract_images: bool = False):
        self.filepath = filepath
        self.extract_images = extract_images
        self._temp_filepath = None  # For compatibility with cleanup function

    def lazy_load(self) -> Iterator[Document]:
        """Lazy load PDF documents with automatic fallback on image extraction errors."""
        loader = PyPDFLoader(self.filepath, extract_images=self.extract_images)

        if not self.extract_images:
            # No image extraction: no fallback needed, stream directly
            yield from loader.lazy_load()
            return

        # extract_images=True: must collect eagerly so that a mid-stream
        # KeyError doesn't leave already-yielded pages duplicated by the
        # fallback (yield from + try/except would deliver partial + full).
        try:
            pages = list(loader.lazy_load())
        except KeyError as e:
            if "/Filter" in str(e):
                logger.warning(
                    f"PDF image extraction failed for {self.filepath}, falling back to text-only: {e}"
                )
                fallback_loader = PyPDFLoader(self.filepath, extract_images=False)
                pages = list(fallback_loader.lazy_load())
            else:
                # Re-raise if it's a different error
                raise
        yield from pages

    def load(self) -> List[Document]:
        """Load PDF documents with automatic fallback on image extraction errors."""
        return list(self.lazy_load())
