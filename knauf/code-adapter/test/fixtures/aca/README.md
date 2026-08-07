# ACA data-plane fixtures (KK20-108 spike)

Raw responses captured from **live Azure Container Apps dynamic session pools**
in West Europe (CT-SANDBOX subscription) on 2026-08-07, during the KK20-108
spike. They pin the two pool contracts the adapter targets; `../unit/acaShape.spec.ts`
asserts against them and is the tripwire for an api-version shape change.

| File                        | Pool   | Call                                        | What it proves                                                                                      |
| --------------------------- | ------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `execution-success.json`    | Python | `POST /code/execute` @ `2024-02-02-preview` | success shape: `properties.status="Success"`, `stdout`                                              |
| `execution-nonzero.json`    | Python | same                                        | failure shape; IPython swallows `sys.exit()` → no numeric code (⇒ the sentinel wrapper is required) |
| `shell-s1.json`             | Shell  | `POST /executions` @ `2025-02-02-preview`   | **S1 gate**: the Shell image carries `python3` 3.10.12, `base64`, `head`, `wc`, `bash`              |
| `shell-nonzero.json`        | Shell  | same                                        | native exit code: `status="7"`, real `stdout`/`stderr`                                              |
| `shell-python-heredoc.json` | Shell  | same                                        | `python3 -c …` via `shellCommand` works (the `bash_tool` traffic pattern)                           |

To refresh (e.g. after an `ACA_API_VERSION_*` bump): re-run the exec calls
against a pool, save the raw JSON here, and update `acaShape.spec.ts` in the
same commit. See the pool contract table in `../../README.md`.
