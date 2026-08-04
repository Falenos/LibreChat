import { useState } from 'react';
import { FilePenLine } from 'lucide-react';
import { useRecoilState, useSetRecoilState } from 'recoil';
import type { Artifact } from '~/common';
import { useLocalize } from '~/hooks';
import { getArtifactRevision } from '~/knauf/data-provider/data-service';
import store from '~/store';

export type ArtifactEditResult = {
  status: 'updated';
  identifier: string;
  messageId: string;
  title: string;
  version: number;
  replacements: number;
};

export function parseArtifactEditResult(output: string): ArtifactEditResult | null {
  try {
    const value = JSON.parse(output) as Partial<ArtifactEditResult>;
    if (
      value.status !== 'updated' ||
      typeof value.identifier !== 'string' ||
      typeof value.messageId !== 'string' ||
      typeof value.title !== 'string' ||
      !Number.isSafeInteger(value.version) ||
      (value.version ?? 0) < 1 ||
      !Number.isSafeInteger(value.replacements) ||
      (value.replacements ?? 0) < 1
    ) {
      return null;
    }
    return value as ArtifactEditResult;
  } catch {
    return null;
  }
}

export default function ArtifactEditCall({ result }: Readonly<{ result: ArtifactEditResult }>) {
  const localize = useLocalize();
  const [isLoading, setIsLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [artifacts, setArtifacts] = useRecoilState(store.artifactsState);
  const [visibleArtifacts, setVisibleArtifacts] = useRecoilState(store.visibleArtifacts);
  const setCurrentArtifactId = useSetRecoilState(store.currentArtifactId);
  const setArtifactsVisible = useSetRecoilState(store.artifactsVisibility);
  const revisionId = `artifact-revision:${result.messageId}:${result.identifier}:version:${result.version}`;

  const openArtifact = (artifact: Artifact) => {
    setArtifacts((current) => ({ ...(current ?? {}), [artifact.id]: artifact }));
    setVisibleArtifacts((current) => ({ ...(current ?? {}), [artifact.id]: artifact }));
    setCurrentArtifactId(artifact.id);
    setArtifactsVisible(true);
  };

  const handleOpen = async () => {
    const cached = artifacts?.[revisionId] ?? visibleArtifacts?.[revisionId];
    if (cached) {
      openArtifact(cached);
      return;
    }

    setFailed(false);
    setIsLoading(true);
    try {
      const snapshot = await getArtifactRevision(result);
      openArtifact({
        id: revisionId,
        identifier: result.identifier,
        messageId: result.messageId,
        title: snapshot.title,
        type: snapshot.type,
        content: snapshot.content,
        language: snapshot.language,
        lastUpdateTime: Date.now(),
        knaufRevision: { identifier: result.identifier, version: result.version },
      } as Artifact & {
        knaufRevision: { identifier: string; version: number };
      });
    } catch {
      setFailed(true);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="my-3">
      <button
        type="button"
        aria-label={localize('com_ui_updated_file', { 0: result.title })}
        disabled={isLoading}
        onClick={handleOpen}
        className="flex items-center gap-3 rounded-xl border border-border-light bg-surface-tertiary px-3 py-2 text-left text-sm transition hover:border-border-medium hover:bg-surface-hover disabled:cursor-wait disabled:opacity-70"
      >
        <FilePenLine className="size-5 shrink-0 text-text-secondary" aria-hidden="true" />
        <span className="min-w-0">
          <span className="block truncate font-medium text-text-primary">
            {localize('com_ui_updated_file', { 0: result.title })}
          </span>
          <span className="block text-text-secondary">
            {localize('com_ui_version_var', { 0: String(result.version) })}
          </span>
        </span>
      </button>
      {failed ? (
        <span role="alert" className="mt-1 block text-xs text-red-600">
          {localize('com_ui_error')}
        </span>
      ) : null}
    </div>
  );
}
