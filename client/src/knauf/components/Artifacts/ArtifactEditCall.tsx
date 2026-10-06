import { useState } from 'react';
import { useRecoilState, useSetRecoilState } from 'recoil';
import type { Artifact } from '~/common';
import FilePreview from '~/components/Chat/Input/Files/FilePreview';
import { useLocalize } from '~/hooks';
import {
  getArtifactRevision,
  getArtifactRevisionHistory,
} from '~/knauf/data-provider/data-service';
import {
  artifactRevisionId,
  isArtifactRevisionHistoryUnavailable,
  projectArtifactRevisionHistory,
} from '~/knauf/utils/artifactRevisions';
import store from '~/store';
import { getFileType } from '~/utils';

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
  const fileType = getFileType('artifact');
  const [isLoading, setIsLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [artifacts, setArtifacts] = useRecoilState(store.artifactsState);
  const [visibleArtifacts, setVisibleArtifacts] = useRecoilState(store.visibleArtifacts);
  const setCurrentArtifactId = useSetRecoilState(store.currentArtifactId);
  const setArtifactsVisible = useSetRecoilState(store.artifactsVisibility);
  const revisionId = artifactRevisionId(result);

  const openArtifact = (artifact: Artifact) => {
    setArtifacts((current) => ({ ...(current ?? {}), [artifact.id]: artifact }));
    setVisibleArtifacts((current) => ({ ...(current ?? {}), [artifact.id]: artifact }));
    setCurrentArtifactId(artifact.id);
    setArtifactsVisible(true);
  };

  const handleOpen = async () => {
    const cached = artifacts?.[revisionId] ?? visibleArtifacts?.[revisionId];
    if (cached?.knaufUnavailableVersions != null) {
      openArtifact(cached);
      return;
    }

    setFailed(false);
    setIsLoading(true);
    try {
      const history = await getArtifactRevisionHistory(result);
      const { artifacts: revisions } = projectArtifactRevisionHistory({
        history,
        base: {
          identifier: result.identifier,
          messageId: result.messageId,
        },
        rootTime: Date.now() - history.currentVersion,
      });
      const selected = revisions[revisionId];
      if (!selected) {
        setFailed(true);
        return;
      }
      setArtifacts((current) => ({ ...(current ?? {}), ...revisions }));
      setVisibleArtifacts((current) => ({ ...(current ?? {}), ...revisions }));
      setCurrentArtifactId(selected.id);
      setArtifactsVisible(true);
    } catch (error) {
      if (!isArtifactRevisionHistoryUnavailable(error)) {
        setFailed(true);
        return;
      }
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
        });
      } catch {
        setFailed(true);
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="group relative my-4 rounded-xl text-sm text-text-primary">
      <button
        type="button"
        aria-label={localize('com_ui_updated_file', { 0: result.title })}
        disabled={isLoading}
        onClick={handleOpen}
        className="relative overflow-hidden rounded-xl border-border-light bg-surface-tertiary shadow-sm transition-all duration-300 hover:border-border-medium hover:bg-surface-hover hover:shadow-lg active:scale-[0.98] disabled:cursor-wait disabled:opacity-70"
      >
        <div className="w-fit p-2">
          <div className="flex flex-row items-center gap-2">
            <FilePreview fileType={fileType} className="relative" />
            <div className="overflow-hidden text-left">
              <div className="truncate font-medium">{result.title}</div>
              <div className="truncate text-text-secondary">
                {localize('com_ui_version_var', { 0: String(result.version) })}
              </div>
            </div>
          </div>
        </div>
      </button>
      {failed ? (
        <span role="alert" className="mt-1 block text-xs text-red-600">
          {localize('com_ui_error')}
        </span>
      ) : null}
    </div>
  );
}
