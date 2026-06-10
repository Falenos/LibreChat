"""[knauf] Route RAG API logs to stdout/stderr by severity.

Python imports this module automatically from /app before main.py starts. The
upstream RAG API configures the root logger with logging.StreamHandler() and no
explicit stream, so Python defaults to stderr. Datadog marks stderr container
logs as errors when log pipelines/status remappers are unavailable.

Keep normal INFO/DEBUG records on stdout, while preserving WARNING+ on stderr.
"""

from __future__ import annotations

import logging
import sys
_ORIGINAL_STREAM_HANDLER_INIT = logging.StreamHandler.__init__
_ORIGINAL_STREAM_HANDLER_EMIT = logging.StreamHandler.emit


class _SeverityRoutingStream:
    encoding = getattr(sys.stdout, "encoding", "utf-8")
    errors = getattr(sys.stdout, "errors", "replace")

    def write(self, message: str) -> int:
        return sys.stdout.write(message)

    def flush(self) -> None:
        sys.stdout.flush()
        sys.stderr.flush()


def _stream_handler_init(self, stream=None):
    if stream is None:
        stream = _SeverityRoutingStream()
    _ORIGINAL_STREAM_HANDLER_INIT(self, stream)


def _stream_handler_emit(self, record):
    if not isinstance(getattr(self, "stream", None), _SeverityRoutingStream):
        return _ORIGINAL_STREAM_HANDLER_EMIT(self, record)

    try:
        message = self.format(record)
        stream = sys.stderr if record.levelno >= logging.WARNING else sys.stdout
        stream.write(message + self.terminator)
        self.flush()
    except RecursionError:
        raise
    except Exception:
        self.handleError(record)


logging.StreamHandler.__init__ = _stream_handler_init
logging.StreamHandler.emit = _stream_handler_emit
