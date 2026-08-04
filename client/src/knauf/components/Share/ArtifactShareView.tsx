import { useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Code, MessageSquareText, Play } from 'lucide-react';
import { Button, Radio } from '@librechat/client';
import * as Tabs from '@radix-ui/react-tabs';
import type { SandpackPreviewRef } from '@codesandbox/sandpack-react/unstyled';
import type { TSharedArtifact } from 'librechat-data-provider';
import type { Artifact } from '~/common';
import { isCodeOnlyArtifact, isPreviewOnlyArtifact } from '~/utils/artifacts';
import ArtifactDownloadMenu from '~/knauf/components/Artifacts/ArtifactDownloadMenu';
import { extractSharedArtifactBody } from '~/knauf/utils/artifactBody';
import { getSharedArtifactContinuationPath } from '~/knauf/utils/sharedArtifactContinuation';
import ArtifactTabs from '~/components/Artifacts/ArtifactTabs';
import { ArtifactsProvider, EditorProvider } from '~/Providers';
import { useLocalize } from '~/hooks';

export default function ArtifactShareView({
  artifact: snapshot,
  shareId,
}: Readonly<{
  artifact: TSharedArtifact;
  shareId: string;
}>) {
  const localize = useLocalize();
  const previewRef = useRef<SandpackPreviewRef>();
  const artifact = useMemo<Artifact>(
    () => ({
      id: `shared-artifact-${shareId}`,
      title: snapshot.title,
      type: snapshot.type,
      content: extractSharedArtifactBody(snapshot.content, snapshot.type),
      language: snapshot.language,
      lastUpdateTime: 0,
    }),
    [shareId, snapshot],
  );
  let constrainedTab: 'code' | 'preview' | null = null;
  if (isCodeOnlyArtifact(artifact.type)) {
    constrainedTab = 'code';
  } else if (isPreviewOnlyArtifact(artifact.type)) {
    constrainedTab = 'preview';
  }
  const [activeTab, setActiveTab] = useState(constrainedTab ?? 'preview');
  const displayedTab = constrainedTab ?? activeTab;
  const handleTabChange = (value: string) => {
    if (value === 'code' || value === 'preview') {
      setActiveTab(value);
    }
  };
  const options = useMemo(
    () => [
      { value: 'code', label: localize('com_ui_code'), icon: <Code className="size-4" /> },
      { value: 'preview', label: localize('com_ui_preview'), icon: <Play className="size-4" /> },
    ],
    [localize],
  );
  const visibleOptions = constrainedTab
    ? options.filter((option) => option.value === constrainedTab)
    : options;

  return (
    <ArtifactsProvider>
      <EditorProvider>
        <Tabs.Root value={displayedTab} onValueChange={handleTabChange} asChild>
          <div className="flex h-screen w-full flex-col bg-surface-primary text-text-primary">
            <header className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-border-light bg-surface-primary-alt px-4 py-3 md:px-6">
              <div className="min-w-0">
                <h1 className="truncate text-lg font-semibold md:text-xl">{artifact.title}</h1>
                <p className="truncate text-xs text-text-secondary">{artifact.type}</p>
              </div>
              <div className="flex items-center gap-2">
                <Button type="button" size="sm" className="gap-1.5" asChild>
                  <Link to={getSharedArtifactContinuationPath(shareId)}>
                    <MessageSquareText className="size-4" aria-hidden="true" />
                    {localize('com_knauf_artifact_continue')}
                  </Link>
                </Button>
                <Radio
                  options={visibleOptions}
                  value={displayedTab}
                  onChange={handleTabChange}
                  buttonClassName="h-9 px-3 gap-1.5"
                />
                <ArtifactDownloadMenu artifact={artifact} shareId={shareId} />
              </div>
            </header>
            <main className="min-h-0 flex-1">
              <ArtifactTabs
                artifact={artifact}
                previewRef={previewRef as React.MutableRefObject<SandpackPreviewRef>}
                isSharedConvo={true}
              />
            </main>
          </div>
        </Tabs.Root>
      </EditorProvider>
    </ArtifactsProvider>
  );
}
