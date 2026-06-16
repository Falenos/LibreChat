"""Azure AI Document Intelligence — identical call to the production overlay
(knauf/rag-api-overlay/document_loader.py): AzureAIDocumentIntelligenceLoader,
prebuilt-layout, markdown mode."""
from __future__ import annotations

import os
from typing import Optional

from .base import BaseAdapter


class AzureDIAdapter(BaseAdapter):
    name = "azure_di"

    def __init__(
        self,
        api_model: str = "prebuilt-layout",
        mode: str = "markdown",
        cost_per_page_usd: float = 0.01,
        endpoint: str | None = None,
        key: str | None = None,
        **_ignore,
    ):
        self.endpoint = (endpoint or os.getenv("RAG_AZURE_DI_ENDPOINT", "")).strip()
        self.key = (key or os.getenv("RAG_AZURE_DI_KEY", "")).strip()
        self.api_model = api_model
        self.mode = mode
        self.cost_per_page_usd = cost_per_page_usd

    def _extract(self, filepath: str, mimetype: str):
        if not (self.endpoint and self.key):
            raise RuntimeError(
                "RAG_AZURE_DI_ENDPOINT / RAG_AZURE_DI_KEY not set "
                "(needed for the azure_di strategy)"
            )
        from langchain_community.document_loaders import AzureAIDocumentIntelligenceLoader

        loader = AzureAIDocumentIntelligenceLoader(
            api_endpoint=self.endpoint,
            api_key=self.key,
            file_path=filepath,
            api_model=self.api_model,
            mode=self.mode,
        )
        docs = loader.load()
        markdown = "\n\n".join(d.page_content for d in docs)
        return markdown, None  # page count filled in by BaseAdapter

    def cost(self, n_pages: Optional[int]) -> Optional[float]:
        if n_pages is None:
            return None
        return round(n_pages * self.cost_per_page_usd, 4)
