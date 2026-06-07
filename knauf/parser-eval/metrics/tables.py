"""TEDS (Tree-Edit-Distance Similarity) for tables — the PubTabNet/OmniDocBench standard.

We extract tables from the predicted and reference markdown (pipe tables and/or HTML
<table>s), model each as a tree (table → tr → td[content]), and compute
    TEDS = 1 - TreeEditDistance / max(|T_pred|, |T_ref|)
with cell-content rename cost = (1 - normalized edit similarity). Tables are paired by
order; surplus tables on either side score 0. Returns None when neither side has a table
(metric not applicable), so the report can distinguish "no tables" from "bad tables".

Requires `apted` (+ rapidfuzz). Degrades to None if apted is unavailable.
"""
from __future__ import annotations

import re

_PIPE_ROW = re.compile(r"^\s*\|.*\|\s*$")
_SEP_ROW = re.compile(r"^\s*\|?[\s:|-]+\|?\s*$")


class _Node:
    __slots__ = ("tag", "content", "children")

    def __init__(self, tag: str, content: str = "", children=None):
        self.tag = tag
        self.content = content
        self.children = children or []


def _count(node: _Node) -> int:
    return 1 + sum(_count(c) for c in node.children)


def _grid_to_tree(grid: list[list[str]]) -> _Node:
    rows = [
        _Node("tr", "", [_Node("td", (cell or "").strip()) for cell in row])
        for row in grid
    ]
    return _Node("table", "", rows)


def _extract_markdown_tables(md: str) -> list[list[list[str]]]:
    tables: list[list[list[str]]] = []
    lines = (md or "").splitlines()
    i = 0
    while i < len(lines):
        if _PIPE_ROW.match(lines[i]) and i + 1 < len(lines) and _SEP_ROW.match(lines[i + 1]):
            block = [lines[i]]
            j = i + 2
            while j < len(lines) and _PIPE_ROW.match(lines[j]):
                block.append(lines[j])
                j += 1
            grid = []
            for k, line in enumerate(block):
                if k == 1:  # separator row already excluded (block has header + body)
                    pass
                cells = [c.strip() for c in line.strip().strip("|").split("|")]
                grid.append(cells)
            tables.append(grid)
            i = j
        else:
            i += 1
    return tables


def _extract_html_tables(md: str) -> list[list[list[str]]]:
    if "<table" not in (md or "").lower():
        return []
    try:
        from bs4 import BeautifulSoup
    except Exception:  # noqa: BLE001
        return []
    soup = BeautifulSoup(md, "html.parser")
    tables = []
    for tbl in soup.find_all("table"):
        grid = []
        for tr in tbl.find_all("tr"):
            cells = [c.get_text(" ", strip=True) for c in tr.find_all(["td", "th"])]
            if cells:
                grid.append(cells)
        if grid:
            tables.append(grid)
    return tables


def _extract_tables(md: str) -> list[list[list[str]]]:
    return _extract_markdown_tables(md) + _extract_html_tables(md)


def _teds_one(grid_pred, grid_ref) -> float:
    try:
        from apted import APTED, Config
        from rapidfuzz.distance import Levenshtein
    except Exception:  # noqa: BLE001
        return 0.0

    class _Cfg(Config):
        def rename(self, n1, n2):
            if n1.tag != n2.tag:
                return 1.0
            if n1.tag == "td":
                return 1.0 - Levenshtein.normalized_similarity(n1.content, n2.content)
            return 0.0

        def children(self, node):
            return node.children

    t_pred = _grid_to_tree(grid_pred)
    t_ref = _grid_to_tree(grid_ref)
    dist = APTED(t_pred, t_ref, _Cfg()).compute_edit_distance()
    denom = max(_count(t_pred), _count(t_ref)) or 1
    return max(0.0, 1.0 - dist / denom)


def teds(pred_md: str, ref_md: str) -> float | None:
    pred = _extract_tables(pred_md)
    ref = _extract_tables(ref_md)
    if not pred and not ref:
        return None
    n = max(len(pred), len(ref))
    scores = []
    for i in range(n):
        if i < len(pred) and i < len(ref):
            scores.append(_teds_one(pred[i], ref[i]))
        else:
            scores.append(0.0)
    return round(sum(scores) / n, 4)
