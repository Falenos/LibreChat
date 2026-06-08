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

This is the **authoritative** env reference for the overlay; other docs link here.

| Var | Default | Notes |
|-----|---------|-------|
| `RAG_AZURE_DI_ENDPOINT` | `""` | The resource's **data-plane** endpoint — the AI Services host `https://cst-karl-dev.services.ai.azure.com/` (what we validated; in `.env` + the dev `values.yaml`), or a classic `https://<name>.cognitiveservices.azure.com/`. **Not** the Foundry *project* URL `…/api/projects/<name>` — that's the wrong one. |
| `RAG_AZURE_DI_KEY` | `""` | API key from the resource's *Azure AI Services* keys blade (same `cst-karl-dev` account key as `AZURE_OPENAI_API_KEY`). |
| `RAG_AZURE_DI_API_MODEL` | `prebuilt-layout` | `prebuilt-layout` (markdown + tables) or `prebuilt-read` (plain OCR text). |
| `RAG_AZURE_DI_MODE` | `markdown` | `markdown` \| `page` \| `single`. Fall back to `page`/`single` if the region/API version lacks markdown. |
| `RAG_AZURE_DI_FILE_EXTS` | `pdf` | Comma-list of extensions routed through DI. **Recommended: `pdf,docx,pptx,html`.** `.xlsx` is intentionally **not** routed to DI (DI can't analyze xlsx tables and has an 8 M-char cap) — spreadsheets go to the native `_LeanExcelLoader` (one self-describing record **per row**, free, no limit). |
| `RAG_XLSX_MAX_CHARS` | `1500000` | Native xlsx guard: above this many chars of extracted text, emit a per-sheet **summary** (first `RAG_XLSX_SUMMARY_ROWS` rows/sheet) instead of the full dump — keeps a giant workbook from becoming thousands of chunks. `0` = unlimited. |
| `RAG_XLSX_SUMMARY_ROWS` | `50` | Rows per sheet shown in the summary fallback. |

**Graceful fallback:** if a DI call fails for a file (unsupported/too large, transient error, or
outage), `_AzureDIWithFallback` logs a warning and re-parses it with the upstream loader — so a DI
error never hard-fails the file-search upload.

## Local build & run

The committed [`docker-compose.override.yml`](../../docker-compose.override.yml) already wires the
overlay into the **primary** local stack — its `rag_api` service has an explicit `build:` block:

```yaml
rag_api:
  build:
    context: ./knauf/rag-api-overlay
    dockerfile: Dockerfile.knauf-rag
  image: knauf/rag-api:local
```

So the standard local workflow builds and runs the overlay (no extra wiring needed):

```bash
# from repo root
docker compose build rag_api      # (re)builds the overlay from Dockerfile.knauf-rag
docker compose up -d              # runs the stack with the overlay rag_api
```

Set the `RAG_AZURE_DI_*` vars (at minimum endpoint + key) in `.env` to enable OCR routing.

> The other local composes — `deploy-compose.yml` (`npm run start:deployed`) and `rag.yml` — and
> the in-repo `helm/librechat-rag-api/` chart still reference the **upstream** base image; they are
> not part of the primary local stack and are left on upstream by design.

## Deployed wiring (dev cluster)

The dev cluster does **not** deploy from this repo's compose/Helm files. It deploys from
`Knauf-Group/ct-shared-deployment-configs` → `dev/services/agentic-karl-rag-api/.../values.yaml`,
whose `image` is the overlay published to ACR (`acrctshared001.azurecr.io/tools-non-prod/agentic-karl-rag-api:<tag>`,
built via `az acr build`). That build + the `RAG_AZURE_DI_*` / `RAG_XLSX_*` env + secret wiring are
the **deferred infra step**, tracked end-to-end in
[knauf/docs/implementation-plans/rag-azure-di-rollout.md](../docs/implementation-plans/rag-azure-di-rollout.md).

## Re-vendoring on a base-image bump

```bash
docker pull registry.librechat.ai/danny-avila/librechat-rag-api-dev-lite:latest
docker run --rm registry.librechat.ai/danny-avila/librechat-rag-api-dev-lite:latest \
  cat /app/app/utils/document_loader.py > knauf/rag-api-overlay/document_loader.py
# then re-apply the two [knauf] blocks (import + env constants, and the get_loader() branch)
```

Drift surface = this one file.
