/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_ENABLE_LOGGER: string;
  readonly VITE_LOGGER_FILTER: string;
  // [knauf] KK20-248 — frontend project file polling interval override.
  readonly VITE_PROJECT_FILE_INDEX_POLL_MS?: string;
  // End [knauf]
  // Add other env variables here
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
