"""liteparse (run-llama) — local OSS parser, the open core of LlamaParse.

liteparse ships a CLI (`lit parse <file> --format ... -o <out>`). We shell out to it so
the harness doesn't depend on a specific Python binding/version. The exact command is
configurable in config.yaml (`liteparse.command`); adjust it to match your install.
Requires LibreOffice / ImageMagick / Tesseract for non-PDF + OCR (see Dockerfile.eval).
"""
from __future__ import annotations

import os
import shlex
import subprocess
import tempfile

from .base import BaseAdapter


class LiteParseAdapter(BaseAdapter):
    name = "liteparse"

    def __init__(
        self,
        command: str = "lit parse {input} --format text -o {output}",
        output_suffix: str = ".txt",
        timeout_s: int = 300,
        **_ignore,
    ):
        self.command = command
        self.output_suffix = output_suffix
        self.timeout_s = timeout_s

    def _extract(self, filepath: str, mimetype: str):
        with tempfile.TemporaryDirectory() as tmp:
            out_path = os.path.join(tmp, "out" + self.output_suffix)
            cmd = self.command.format(input=shlex.quote(filepath), output=shlex.quote(out_path))
            proc = subprocess.run(
                cmd,
                shell=True,
                capture_output=True,
                text=True,
                timeout=self.timeout_s,
            )
            if proc.returncode != 0:
                raise RuntimeError(
                    f"liteparse command failed (exit {proc.returncode}): "
                    f"{proc.stderr.strip() or proc.stdout.strip()}"
                )
            # Prefer the output file; fall back to stdout if the CLI streams.
            if os.path.exists(out_path):
                with open(out_path, "r", encoding="utf-8", errors="replace") as fh:
                    text = fh.read()
            else:
                text = proc.stdout
            if not text.strip():
                raise RuntimeError("liteparse produced empty output")
            return text, None
