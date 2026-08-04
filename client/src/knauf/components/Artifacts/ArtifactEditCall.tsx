import { useMemo } from 'react';
import { FilePenLine } from 'lucide-react';
import { useRecoilState, useRecoilValue, useSetRecoilState } from 'recoil';
import { useLocalize } from '~/hooks';
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
  const [artifacts, setArtifacts] = useRecoilState(store.artifactsState);
  const visibleArtifacts = useRecoilValue(store.visibleArtifacts);
  const setCurrentArtifactId = useSetRecoilState(store.currentArtifactId);
  const setArtifactsVisible = useSetRecoilState(store.artifactsVisibility);
  const artifact = useMemo(
    () =>
      Object.values(artifacts ?? {}).find(
        (candidate) =>
          candidate?.identifier === result.identifier && candidate.messageId === result.messageId,
      ) ??
      Object.values(visibleArtifacts ?? {}).find(
        (candidate) =>
          candidate?.identifier === result.identifier && candidate.messageId === result.messageId,
      ),
    [artifacts, result.identifier, result.messageId, visibleArtifacts],
  );

  return (
    <div className="my-3">
      <button
        type="button"
        aria-label={localize('com_ui_updated_file', { 0: result.title })}
        disabled={!artifact}
        onClick={() => {
          if (!artifact) {
            return;
          }
          setCurrentArtifactId(artifact.id);
          setArtifactsVisible(true);
          if (artifacts?.[artifact.id] == null) {
            setArtifacts(visibleArtifacts);
          }
        }}
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
    </div>
  );
}
