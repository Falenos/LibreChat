"""Parser strategy adapters. Add a new strategy = add one module here + register below."""
from __future__ import annotations

from .azure_di import AzureDIAdapter
from .base import BaseAdapter, ParseResult
from .liteparse_adapter import LiteParseAdapter
from .upstream import UpstreamAdapter

_REGISTRY = {
    AzureDIAdapter.name: AzureDIAdapter,
    UpstreamAdapter.name: UpstreamAdapter,
    LiteParseAdapter.name: LiteParseAdapter,
}


def build_adapter(name: str, cfg: dict) -> BaseAdapter:
    if name not in _REGISTRY:
        raise KeyError(f"Unknown strategy '{name}'. Known: {sorted(_REGISTRY)}")
    return _REGISTRY[name](**(cfg.get(name) or {}))


__all__ = ["build_adapter", "BaseAdapter", "ParseResult"]
