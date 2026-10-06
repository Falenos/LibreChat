import { useEffect, useRef, useState } from 'react';
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
  beginArtifactRevisionOpen,
  finishArtifactRevisionOpen,
  isCurrentArtifactRevisionOpen,
  mergeArtifactRevisionRegistry,
  projectArtifactRevisionHistory,
  projectArtifactRevisionSnapshot,
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
  const activeRequestRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      const requestId = activeRequestRef.current;
      if (requestId != null) {
        finishArtifactRevisionOpen(requestId);
      }
      activeRequestRef.current = null;
    };
  }, []);

  const handleOpen = async () => {
    const lineage = { messageId: result.messageId, identifier: result.identifier };
    const requestId = beginArtifactRevisionOpen();
    activeRequestRef.current = requestId;
    setFailed(false);
    setIsLoading(true);
    try {
      const history = await getArtifactRevisionHistory(result);
      if (!isCurrentArtifactRevisionOpen(requestId)) {
        return;
      }
      const revisionHistory = projectArtifactRevisionHistory({
        history,
        ...lineage,
      });
      const metadata = revisionHistory.find(
        (revision) => revision.available && revision.id === revisionId,
      );
      if (!metadata) {
        setFailed(true);
        return;
      }
      const cached = artifacts?.[revisionId] ?? visibleArtifacts?.[revisionId];
      const selected =
        cached?.content != null
          ? {
              ...cached,
              title: metadata.title ?? cached.title,
              type: metadata.type ?? cached.type,
              language: metadata.language ?? cached.language,
              knaufRevisionHistory: revisionHistory,
            }
          : projectArtifactRevisionSnapshot({
              snapshot: await getArtifactRevision(result),
              base: lineage,
              rootTime: Date.now() - history.currentVersion + 1,
              history: revisionHistory,
            });
      if (!isCurrentArtifactRevisionOpen(requestId)) {
        return;
      }
      const register = (current: Record<string, Artifact | undefined> | null) =>
        mergeArtifactRevisionRegistry({
          current,
          additions: [selected],
          ...lineage,
          history: revisionHistory,
        });
      setArtifacts(register);
      setVisibleArtifacts(register);
      setCurrentArtifactId(selected.id);
      setArtifactsVisible(true);
    } catch {
      if (isCurrentArtifactRevisionOpen(requestId)) {
        setFailed(true);
      }
    } finally {
      if (activeRequestRef.current === requestId) {
        setIsLoading(false);
        activeRequestRef.current = null;
      }
      finishArtifactRevisionOpen(requestId);
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
