export interface CodeBlock {
  id: string;
  language: string;
  content: string;
}

// [knauf] KK20-410 — persisted revision metadata for generated chat artifacts.
export interface ArtifactRevisionEntry {
  id: string | null;
  version: number;
  available: boolean;
  title?: string;
  type?: string;
  language?: string;
}
// End [knauf]

export interface Artifact {
  id: string;
  lastUpdateTime: number;
  index?: number;
  messageId?: string;
  identifier?: string;
  language?: string;
  content?: string;
  title?: string;
  type?: string;
  // [knauf] Server-owned locator for generated file artifacts; content is never trusted from the client. (NO-TICKET)
  sourceFileId?: string;
  // End [knauf]
  // [knauf] KK20-410 — immutable revision identity for generated chat artifacts.
  knaufRevision?: {
    identifier: string;
    version: number;
  };
  knaufRevisionHistory?: ArtifactRevisionEntry[];
  // End [knauf]
}

export type ArtifactFiles =
  | {
      'App.tsx': string;
      'index.tsx': string;
      '/components/ui/MermaidDiagram.tsx': string;
    }
  | Partial<{
      [x: string]: string | undefined;
    }>;
