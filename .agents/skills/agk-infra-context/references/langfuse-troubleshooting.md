# Langfuse Troubleshooting

Use the generic `langfuse` skill for current Langfuse CLI/API syntax and official documentation. Use this reference for AGK-specific wiring and trace interpretation.

## Authentication And Ownership

Browser login uses Okta. CLI/API access uses the target Langfuse project's public/secret key pair; browser authentication does not prove API access.

Resolve the current host, project bootstrap values, and secret mapping from:

- `agk-deployment-configs/agentic-karl/<env>/services/langfuse-web/values.yaml`;
- `agk-deployment-configs/agentic-karl/<env>/services/agentic-karl/values.yaml` for application trace export;
- the environment's Key Vault secret-name metadata and ExternalSecret status.

Do not trust an old public key, secret name, or expected `sk-lf-...` prefix. Verify authenticated project scope. Never print the secret or place it in documentation, command history, logs, or process output.

Repo-local helpers may include:

```bash
npm run langfuse:project
npm run langfuse:traces
```

Inspect the current `package.json` scripts before relying on them. Start with trace metadata and error summaries; do not dump inputs or outputs by default.

## Trace Lookup

- Use the trace ID displayed after `Trace <name>:` in the trace detail view as the API trace ID.
- Do not assume a URL `peek=<id>` value is a fetchable trace ID; it can represent stale UI state or a missing row.
- If a trace lookup returns `Trace <id> not found within authorized project`, verify project scope, then list traces by timestamp, session, or user before diagnosing authentication.
- Treat trace input/output as sensitive. It can include conversation state, prompts, file-search snippets, user IDs, filenames, and model responses.

Summaries should prefer identifiers, timestamps, environment, latency, observation names/types/models, usage, levels, and bounded status messages. Include full input/output only when explicitly required and authorized.

## LangGraph Interpretation

Agent runs commonly appear as `AgentRun`. A typical observation hierarchy is:

```text
AgentRun
  LangGraph
    agent__... / agent=...
      RunnableSequence
        prompt
        ChatOpenAI
```

- `prompt` observations contain rendered prompt messages.
- `ChatOpenAI` observations represent model calls; inspect model, usage, level, and bounded status metadata before sensitive input/output.
- A UI note such as `hidden observations below DEFAULT level` means lower-level spans are filtered from the view, not necessarily absent from storage.

## AGK Failure Signatures

- `Error while downloading file. Upstream status code: 403` with `innererror.code=StorageAccessDenied` on a model observation indicates the provider could not fetch an uploaded-file URL. Diagnose URL/SAS/storage reachability and expiry; this is not a Langfuse authentication failure.
- Project/session APIs can succeed while trace queries are empty because session/project metadata lives in PostgreSQL and trace observations live in ClickHouse.
- Missing older traces with surviving sessions therefore points first to ClickHouse retention/data or worker ingestion, not automatically to deleted sessions.
- Confirm `langfuse-web`, `langfuse-worker`, `langfuse-clickhouse`, and `langfuse-redis` health in the target namespace and compare their GitOps revisions before attributing the problem to the application SDK.

For current environment wiring, secret mapping, service topology, and known drift, read the Langfuse sections of the [architecture reference](../../../../knauf/docs/reference/agentic-karl-architecture.md) and verify them against GitOps and runtime state.
