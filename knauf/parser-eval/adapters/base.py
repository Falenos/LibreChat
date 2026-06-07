"""Adapter interface + timing/error wrapper shared by every parsing strategy."""
from __future__ import annotations

import os
import time
from dataclasses import asdict, dataclass
from typing import Optional

from common import count_pages


@dataclass
class ParseResult:
    strategy: str
    doc: str
    category: str = ""
    markdown: str = ""
    n_pages: Optional[int] = None
    seconds: float = 0.0
    cost_usd: Optional[float] = None
    error: Optional[str] = None

    @property
    def ok(self) -> bool:
        return self.error is None and bool(self.markdown.strip())

    def row(self) -> dict:
        """Flat record for results.csv (excludes the bulky markdown body)."""
        d = asdict(self)
        d["chars"] = len(self.markdown)
        d["sec_per_page"] = (
            round(self.seconds / self.n_pages, 3) if self.n_pages else None
        )
        d.pop("markdown", None)
        return d


class BaseAdapter:
    """Subclasses implement ``_extract`` → (markdown, n_pages). Timing, page counting
    and error capture are handled here so one failing parser never aborts a run."""

    name = "base"

    def parse(self, filepath: str, mimetype: str, category: str = "") -> ParseResult:
        doc = os.path.basename(filepath)
        t0 = time.perf_counter()
        try:
            markdown, n_pages = self._extract(filepath, mimetype)
            secs = time.perf_counter() - t0
            if n_pages is None:
                n_pages = count_pages(filepath)
            return ParseResult(
                strategy=self.name,
                doc=doc,
                category=category,
                markdown=markdown or "",
                n_pages=n_pages,
                seconds=round(secs, 3),
                cost_usd=self.cost(n_pages),
                error=None,
            )
        except Exception as e:  # noqa: BLE001 — isolate adapter failures
            secs = time.perf_counter() - t0
            return ParseResult(
                strategy=self.name,
                doc=doc,
                category=category,
                seconds=round(secs, 3),
                error=f"{type(e).__name__}: {e}",
            )

    def _extract(self, filepath: str, mimetype: str) -> tuple[str, Optional[int]]:
        raise NotImplementedError

    def cost(self, n_pages: Optional[int]) -> Optional[float]:
        return 0.0
