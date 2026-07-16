---
title: Files — Overview & upload paths
spec-id: AGK-ARCH-files-overview
status: implemented
owners: ["@jorgecostak"]
last-reviewed: 2026-06-17
code-refs:
  - client/src/components/Chat/Input/Files/AttachFileMenu.tsx
  - api/server/routes/files/files.js
tests:
  - packages/api/src/files/validation.spec.ts
acceptance:
  - "Six upload paths covered (chat / agent knowledge / vision / etc.)"
  - "Visibility matrix per upload mode"
  - "Lifecycle + delete behaviour documented"
relations:
  - links: [AGK-ARCH-files-storage, AGK-ARCH-files-processing, AGK-ARCH-files-rag-search]
---

# Files — overview & upload taxonomy

The **map** of file handling in KARL: every way a file can enter, what each path does, what the model actually receives, and how long the file survives. Start here, then follow the links into the two domain docs for depth.

> This doc owns the cross-cutting picture (the diagrams, the binding model, lifecycle, delete, config). It deliberately does **not** repeat storage or retrieval mechanics:
> - **[`storage.md`](./storage.md)** — where the bytes live: the `fileStrategy` adapters and the Azure SAS / serving / refresh machinery.
> - **[`rag-search.md`](./rag-search.md)** — how file search works: `rag_api` + pgvector, embed/query, the `file_search` tool, citations.
> - **[`async-indexing.md`](./async-indexing.md)** — how File Search ingestion is tracked and executed since KK20-195: the `KnaufFileAsset` state machine, worker + reconciler, status/retry endpoints, and the before/after of the sync-embed era this doc's §2e/§2f used to imply.

---

## 1. The 30-second version

- A file enters KARL through one of **six upload paths**, chosen at upload time by the user (chat composer) or the panel context (agent builder).
- Every path writes to some subset of **four infrastructure components**: blob storage, the Mongo `files` collection, `rag_api`+pgvector, and the provider's own Files API.
- A file is **bound** to one of two things: a *message* (visible only inside that conversation) or an *agent* (visible in every conversation with that agent). This one distinction answers almost every "why did my file disappear / persist?" question — §3.
- **Delete is metadata-only.** Removing a conversation does not remove the bytes, the provider copy, or the vector embeddings — a known GDPR exposure (§5).

If you remember one diagram, remember §3 (binding).

---

## 2. The six upload paths

Picked at upload time. In chat the chooser is [AttachFileMenu.tsx](../../../../client/src/components/Chat/Input/Files/AttachFileMenu.tsx) (around L199-L254); in the agent builder it's the Knauf File Search panel.

### 2a. Which infrastructure each path touches

```mermaid
flowchart LR
    subgraph Paths["Upload paths"]
        direction TB
        P1[a. Upload to Provider]
        P2[b. Upload Image]
        P3[c. Upload as Text]
        P4[d. File Search<br/>ephemeral agent]
        P5[e. Agent Knowledge]
        P6[f. Code Files]
    end

    subgraph Infra["Infrastructure components"]
        direction TB
        Blob[Blob storage<br/>see storage.md]
        Mongo[(Mongo files)]
        RAG[rag_api + pgvector<br/>see rag-search.md]
        Prov[Provider Files API]
    end

    P1 --> Blob
    P1 --> Mongo
    P1 --> Prov

    P2 --> Blob
    P2 --> Mongo

    P3 --> Blob
    P3 --> Mongo

    P4 --> Blob
    P4 --> Mongo
    P4 --> RAG

    P5 --> Blob
    P5 --> Mongo
    P5 --> RAG

    P6 --> Blob
    P6 --> Mongo
```

The four components, in one line each (deep-dives linked):

| Component | What it is | Owner doc |
|---|---|---|
| **Blob storage** (`fileStrategy`) | The bytes. `azure_blob` today (private container, SAS-served). | [`storage.md`](./storage.md) |
| **Mongo `files`** | Metadata index — one doc per file (`user`, `file_id`, `context`, `conversationId`, `embedded`, `expiresAt`). [file.ts](../../../../packages/data-schemas/src/schema/file.ts) | this doc (§3, §5) |
| **`rag_api` + pgvector** | Embedding + retrieval pipeline (external upstream image). | [`rag-search.md`](./rag-search.md) |
| **Provider Files API** | Azure OpenAI's own file store, via `openai.files.create`. | §2b below |

### 2b. "Upload files" (chat) — *documents → File Search, images → vision* (KK20-190)

- **UI label**: "Upload files" (paperclip menu) — the single chat upload affordance.
- **What it does now:** on the Knauf Azure chat, this item routes **documents to File Search** (RAG, chat-scoped via an ephemeral agent — mechanics in §2e) and **images to the vision path** (§2c). The split is per-file: [AttachFileMenu.tsx](../../../../client/src/components/Chat/Input/Files/AttachFileMenu.tsx) sets `tool_resource: file_search` on the item; [useFileHandling.ts](../../../../client/src/hooks/Files/useFileHandling.ts) drops it back to `undefined` for image files (the server rejects images on `file_search`). The label deliberately hides the "file search" mechanism from users.
- **Gated by:** `isAzureWithResponsesApi && capabilities.fileSearchEnabled` ([AttachFileMenu.tsx](../../../../client/src/components/Chat/Input/Files/AttachFileMenu.tsx)). It deliberately does **not** require `fileSearchAllowedByAgent` — on a fresh ephemeral chat that flag is false, which would leave the picker offering only images + PDF (the chicken-and-egg fix). `interface.fileSearch` is **`false`** and only hides the BYOK chip (§6); it does not gate routing. `useResponsesApi` stays on (it also drives reasoning / web-search) — it's no longer what document upload depends on.
- **Provider whole-document upload (retired from chat):** previously this item sent documents whole to Azure via `uploadOpenAIFile()` ([OpenAI/crud.js#L18](../../../../api/server/services/Files/OpenAI/crud.js#L18)) so the provider parsed them each turn. That path still exists for genuinely document-capable providers (anthropic/openai/google/bedrock) but is **no longer the Knauf chat default**.
- **Binding**: message-level (§3a) for both the file_search docs and the vision images.

### 2c. Image attachment (vision)

- **`tool_resource`**: `undefined`. **Reached via** the "Upload files" item (§2b) for image files, or "Upload Image" on non-document providers.
- **Server entry**: `processImageFile()` ([process.js#L297](../../../../api/server/services/Files/process.js#L297)).
- **Reader at chat time**: `addImageURLs()` ([agents/client.js#L169](../../../../api/server/controllers/agents/client.js#L169)) → `encodeAndFormat()` reads bytes from blob and base64-encodes them. **Re-fetched + re-encoded every turn — no caching**; on `azure_blob` that's a fresh download per turn per image.
- **What the model receives**: an `{ type: 'image_url', image_url: { url: 'data:image/...;base64,...' } }` content part. **Binding**: message-level (§3a).
- **Why images don't use File Search or the provider:** `file_search` rejects images ([process.js#L492](../../../../api/server/services/Files/process.js#L492)), and images never go to the provider Files API — vision is always inline base64, independent of `useResponsesApi`. So "Upload to Provider" is **not needed** for image support. Limited to **PNG/JPG/JPEG/WebP** by the allow-list.

### 2d. Upload as Text (OCR / extraction)

- **UI label**: "Upload as Text". **`tool_resource`**: `context`.
- **When visible**: when `capabilities.contextEnabled` is true. *Not* enabled on the curated `agents` endpoint ([librechat.yaml#L463-L465](../../../../librechat.yaml#L463) lists only `file_search` + `tools`).
- **Server entry**: `processFileUpload()` → text extraction via the configured document_parser / OCR strategy (`pdf-parse`, `mammoth`, Mistral OCR, …).
- **Reader at chat time**: `encodeAndFormatDocuments()` ([BaseClient.js#L1089](../../../../api/app/clients/BaseClient.js#L1089)) injects extracted text inline into the user message. Bounded by `fileConfig.fileTokenLimit`; hard cap **15 MB extracted text** ([process.js#L539](../../../../api/server/services/Files/process.js#L539)).
- **What the model receives**: plain text concatenated into the user message. **Binding**: message-level (§3a).

### 2e. File Search — chat-time RAG via ephemeral agent

- **`tool_resource`**: `file_search`. **Surfaced in chat under the "Upload files" label** (§2b) — documents uploaded in chat take this path. Enabled by the `agents` endpoint carrying the `file_search` capability (`capabilities.fileSearchEnabled`), **not** by `interface.fileSearch` (which is `false` and only hides the BYOK chip). The standalone "Upload for File Search" menu item stays hidden (`KNAUF_SHOW_FILE_SEARCH_IN_CHAT = false`) since "Upload files" now serves it.
- **Mechanics**: see [`rag-search.md`](./rag-search.md) — `processAgentFileUpload()` embeds to pgvector under an **ephemeral** `entity_id`; the agent's `file_search` tool queries it and feeds top-k chunks back.
- **What the model receives**: nothing directly — chunks arrive as a tool result. **Binding**: message-level (§3a — the ephemeral agent dies with the conversation).
- **⚠ Lifecycle / cleanup gap:** the file is "tied to the chat" for *visibility*, but **deleting the chat does NOT delete the file** — the bytes, Mongo `files` doc, and pgvector embeddings all orphan (§5). Cascade cleanup is a deferred follow-up (see `.claude/notes/Architecture/files-problems-and-fixes.md`).

### 2f. Agent Knowledge — *the persistent RAG path*

- **UI**: the Knauf agent builder's File Search panel — [KnaufFileSearch.tsx](../../../../client/src/knauf/components/Agents/KnaufFileSearch.tsx). Handles unsaved (ephemeral) agents by queuing files locally and draining once the agent is saved.
- **`tool_resource`**: `file_search`. Same server code as §2e, but `entity_id` is the **real** agent_id, and the `file_id` is pushed onto `agent.tool_resources.file_search.file_ids`.
- **Mechanics**: see [`rag-search.md`](./rag-search.md).
- **What the model receives**: top-k chunks via tool call. **Binding**: agent-level (§3b — persists across all conversations with the agent).

### 2g. Code Files

- **UI label**: "Upload for Code Files". **`tool_resource`**: `execute_code`.
- **Server entry**: [Code/process.js](../../../../api/server/services/Files/Code/process.js). Sets `expiresAt = now + 86400000` (24 h) at three call sites (L132, L202, L267) — **the only path that writes `expiresAt`**, so the only path the Mongo TTL index fires for.
- **Note**: `execute_code` is *not* in the curated `agents` capabilities, so it's hidden from end users today. Listed for completeness. **Binding**: message-level (§3a).

---

## 3. The two binding points

The single most important distinction in the system.

```mermaid
flowchart LR
    F([file_id])

    F --> M[message.files array<br/>on Mongo messages doc]
    F --> A[agent.tool_resources<br/>.file_search.file_ids<br/>on Mongo agents doc]

    M -->|replayed each turn by<br/>addPreviousAttachments| MC[Model sees the file<br/>only in this conversation]
    A -->|queried by<br/>file_search tool| AC[Model sees the file<br/>in every conversation<br/>with this agent]
```

### 3a. Message-level binding

The file_id sits on the `message.files` array ([message.ts#L102](../../../../packages/data-schemas/src/schema/message.ts#L102), `Mixed`, `default: undefined`). At chat time, `BaseClient.addPreviousAttachments()` ([BaseClient.js#L1252](../../../../api/app/clients/BaseClient.js#L1252), called at [L694](../../../../api/app/clients/BaseClient.js#L694)) walks the history and re-hydrates each message's files before the whole history goes to the provider; a `seen` Set dedups across replay.

Consequence: **the model sees a message-bound file every turn for as long as that message stays in the replayed history.** New conversation → new conversationId → no replay → not seen.

Applies to: Upload to Provider, Upload Image, Upload as Text, File Search (ephemeral), Code Files.

### 3b. Agent-level binding

The file_id sits on `agent.tool_resources.file_search.file_ids` ([agent.ts](../../../../packages/data-schemas/src/schema/agent.ts)). Every invocation can query the agent's vectors via `entity_id`; the binding is on the agent, not a message, so it persists across all conversations with that agent. Applies to: Agent Knowledge only.

### 3c. Visibility matrix

| Path | Same conversation | New conversation, same agent | New conversation, different agent | After convo deleted |
|---|---|---|---|---|
| Chat docs → File Search (§2b/§2e, ephemeral) | yes (tool) | no (ephemeral dies) | no | model can't see, **but bytes + vectors orphan** (§5) |
| Chat images → vision (§2c) | yes (replay) | no | no | no (metadata orphans, §5) |
| Provider upload (retired from chat; non-Azure only) | yes (replay) | no | no | no (file still on provider) |
| Upload as Text (`context`, dormant) | yes | no | no | no |
| Agent Knowledge | yes (tool) | **yes** | no | n/a (agent lifecycle, not convo) |

---

## 4. Lifecycle across turns — what fires when

"User uploads at T0, follow-up at T1, new conversation at T2 with the same agent."

```mermaid
sequenceDiagram
    autonumber
    participant U as User
    participant API as api
    participant Blob as Blob
    participant Mongo as Mongo
    participant RAG as rag_api+pgvector
    participant Prov as Provider Files

    Note over U,Prov: T0 - upload
    U->>API: POST file
    API->>Blob: write bytes
    API->>Mongo: insert files doc
    alt File Search or Agent Knowledge
        API->>RAG: POST /embed with entity_id
    else Upload to Provider
        API->>Prov: openai.files.create
    end

    Note over U,Prov: T1 - follow-up in same conversation
    U->>API: POST message, no new file
    API->>Mongo: read prior messages and their files
    API->>Blob: re-read bytes for replay
    Note right of Blob: images re-encode every turn, doc text extracted once at upload
    alt File Search or Agent Knowledge
        API->>RAG: POST /query with entity_id (tool call)
    end

    Note over U,Prov: T2 - new conversation, same agent
    U->>API: open new chat with agent
    Note right of API: Message-bound files gone (new conversationId, no replay)
    Note right of API: Agent-bound files survive, file_search still queries by agent_id
```

- Blob, Mongo `files`, and Mongo `messages` are touched on **every** upload regardless of path.
- pgvector only by the two file_search paths (§2e, §2f), via `rag_api`.
- Provider Files API only by §2b.
- Images re-fetch + re-encode every turn; document text is extracted once at upload and stored as text on the message.

---

## 5. Conversation delete behaviour

Two seams cooperate: the **method** [`deleteConvos`](../../../../packages/data-schemas/src/methods/conversation.ts#L454) (deletes Mongo conversations + their messages) and the **route handler** [convos.js#L129](../../../../api/server/routes/convos.js#L129) (orchestrates everything else).

### What gets deleted

| # | Step | Where |
|---|---|---|
| 1 | `Conversation` documents | `deleteConvos` method (L454) |
| 2 | All `Message` documents in those conversations | `deleteConvos` method |
| 3 | Tool call records (`db.deleteToolCalls`) | route handler ([convos.js#L131](../../../../api/server/routes/convos.js#L131)) — **not** in the method |
| 4 | Shared links (`db.deleteConvoSharedLink`) | route handler ([convos.js#L132](../../../../api/server/routes/convos.js#L132)) — **not** in the method |
| 5 | Assistants thread (only on an Assistants client) | route handler — **dead branch** here (`assistants: false`) |

### What does NOT get deleted

> **Delete is metadata-only.** No path cleans up blob bytes, provider files, or vector embeddings. This is a GDPR exposure.

| Resource | Survives delete | Why it matters |
|---|---|---|
| Mongo `files` docs | yes | Orphan docs, still listed in `/files` |
| Blob storage bytes | yes | The actual bytes — **GDPR exposure** |
| Provider Files copies (Upload to Provider) | yes | Counts against Azure OpenAI Files quota |
| pgvector embeddings (chat-time file_search) | yes | Ephemeral agent dies; vectors orphan |
| Code sandbox files | TTL after 24 h | Only path with automatic cleanup |

A `getConvoFiles(conversationId)` helper exists ([conversation.ts#L124](../../../../packages/data-schemas/src/methods/conversation.ts#L124)) but **`deleteConvos` does not call it**. The cascade plumbing exists; the wiring does not. Same gap for message-level delete.

---

## 6. `librechat.yaml` knobs that affect files

Cross-cutting config index. Storage-specific and RAG-specific detail lives in the respective domain docs.

### Exposed
- **`fileStrategy`** / **`fileStrategies`** — pick the blob backend (global or per-context). → [`storage.md`](./storage.md)
- **`fileConfig.serverFileSizeLimit`** — global single-upload ceiling (default 512 MB).
- **`fileConfig.fileTokenLimit`** — how much extracted document text can ride inline in a prompt (the "talk-to-doc" budget; §2d).
- **`fileConfig.endpoints.<name>`** — per-endpoint `disabled` / `fileLimit` / `fileSizeLimit` / `totalSizeLimit` / `supportedMimeTypes`. Knauf sets a **restricted allow-list** + distinct limits: chat (`azureOpenAI`) 5 files / 50 MB combined, agent (`agents`) 20 files / 100 MB combined; per-file caps are **per-category** (25 MB docs / 50 MB data / 20 MB images), enforced in code on top of the 50 MB backstop. Exact list → [`processing.md`](./processing.md) §5–6.
- **`fileConfig.ocr|text|stt.supportedMimeTypes`** — MIME routing into OCR / text-parse / speech-to-text. → [`processing.md`](./processing.md).
- **`interface.fileSearch`** — `false` — hides the BYOK file-search **chip** in the composer. It does **not** gate routing: the chat "Upload files" item routes documents to File Search whenever `endpoints.agents.capabilities` includes `file_search` (`capabilities.fileSearchEnabled`) on an Azure-Responses endpoint (§2b/§2e). → [`rag-search.md`](./rag-search.md)
- **`endpoints.agents.capabilities`** — must include `file_search` for the RAG path (`tools` + `file_search` today). → [`rag-search.md`](./rag-search.md)
- **`modelSpecs.list[].preset.useResponsesApi`** — enables the Azure Responses API (reasoning / web-search). No longer gates document upload — chat docs go to File Search regardless (§2b).

### Not exposed
- No retention / TTL / expiry for any path except the 24 h code-sandbox TTL.
- No `expires_after` on the provider Files API call; no cascade-on-delete switch; no per-agent file count/size cap; no conversation-scoped vector store.
- No `cloudfront.*` block — see [`storage.md`](./storage.md).

---

## 7. Enums & schemas worth knowing

| Concern | Path |
|---|---|
| `FileContext` enum (`message_attachment`, `agents`, `execute_code`, …) | [packages/data-provider/src/types/files.ts](../../../../packages/data-provider/src/types/files.ts) |
| `EToolResources` enum (`file_search`, `execute_code`, `context`) | [packages/data-provider/src/types/assistants.ts](../../../../packages/data-provider/src/types/assistants.ts) |
| File schema + TTL on `expiresAt` | [file.ts#L77-L80](../../../../packages/data-schemas/src/schema/file.ts#L77) |
| Message schema (`files` array, Mixed) | [message.ts#L102](../../../../packages/data-schemas/src/schema/message.ts#L102) |
| Agent schema (`tool_resources.file_search.file_ids`) | [agent.ts](../../../../packages/data-schemas/src/schema/agent.ts) |
| `documentSupportedProviders` set | [schemas.ts#L49-L64](../../../../packages/data-provider/src/schemas.ts#L49) |
| YAML schema validation | [packages/data-provider/src/config.ts](../../../../packages/data-provider/src/config.ts) |
| Current librechat.yaml | [librechat.yaml](../../../../librechat.yaml) |
