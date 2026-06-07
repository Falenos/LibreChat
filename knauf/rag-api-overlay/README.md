# RAG API overlay — Azure AI Document Intelligence parser

Thin Docker overlay on the upstream LibreChat RAG API (`danny-avila/rag_api`). It routes
file-search (RAG) document parsing through **Azure AI Document Intelligence** so that
**scanned / image-based PDFs** are OCR'd into searchable markdown before embedding.

Without this overlay the stock image parses PDFs with `PyPDFLoader`, which only extracts
*embedded* text — scanned PDFs end up empty and unsearchable.

## Why an overlay (not a fork)

The change is **one additive branch** in `get_loader()`. Shipping it as `FROM <upstream> +
COPY one file` keeps the maintenance surface to a single vendored file and mirrors KARL's
existing Tier-2 `Dockerfile.knauf` pattern — no rag_api repo fork, no separate CI.

## Files

- `document_loader.py` — vendored verbatim from the base image's `/app/app/utils/document_loader.py`,
  plus a `[knauf]` env block, an Azure DI branch in `get_loader()`, and a `_AzureDIWithFallback`
  wrapper that falls back to the upstream loader if the DI call fails.
- `Dockerfile.knauf-rag` — `FROM` the upstream image, `pip install azure-ai-documentintelligence`,
  `COPY` the patched loader.

## Configuration (env)

Opt-in. When `RAG_AZURE_DI_ENDPOINT` and `RAG_AZURE_DI_KEY` are unset, behaviour is identical
to upstream.

| Var | Default | Notes |
|-----|---------|-------|
| `RAG_AZURE_DI_ENDPOINT` | `""` | Cognitive Services endpoint, e.g. `https://cst-karl-dev.cognitiveservices.azure.com/`. **Not** the Foundry `*.services.ai.azure.com/api/projects/...` endpoint. |
| `RAG_AZURE_DI_KEY` | `""` | API key from the resource's *Azure AI Services* keys blade. |
| `RAG_AZURE_DI_API_MODEL` | `prebuilt-layout` | `prebuilt-layout` (markdown + tables) or `prebuilt-read` (plain OCR text). |
| `RAG_AZURE_DI_MODE` | `markdown` | `markdown` \| `page` \| `single`. Fall back to `page`/`single` if the region/API version lacks markdown. |
| `RAG_AZURE_DI_FILE_EXTS` | `pdf` | Comma-list of extensions routed through DI. **Recommended: `pdf,docx,pptx,html`.** `.xlsx` is intentionally **not** routed to DI (DI can't analyze xlsx tables and has an 8 M-char cap) — spreadsheets go to the native `_LeanExcelLoader` (per-sheet markdown, free, no limit). |

**Graceful fallback:** if a DI call fails for a file (unsupported/too large, transient error, or
outage), `_AzureDIWithFallback` logs a warning and re-parses it with the upstream loader — so a DI
error never hard-fails the file-search upload.

## Local build & run

The local stack wires this in via `docker-compose.override.yml` (builds `knauf/rag-api:local`).

```bash
# from repo root
docker compose build rag_api      # builds the overlay
docker compose up -d              # runs the stack with the overlay rag_api
```

Set the `RAG_AZURE_DI_*` vars (at minimum endpoint + key) in `.env` to enable OCR routing.

## Re-vendoring on a base-image bump

```bash
docker pull registry.librechat.ai/danny-avila/librechat-rag-api-dev-lite:latest
docker run --rm registry.librechat.ai/danny-avila/librechat-rag-api-dev-lite:latest \
  cat /app/app/utils/document_loader.py > knauf/rag-api-overlay/document_loader.py
# then re-apply the two [knauf] blocks (import + env constants, and the get_loader() branch)
```

Drift surface = this one file.
