import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type { SandpackPreviewRef } from '@codesandbox/sandpack-react/unstyled';
import type { Artifact } from '~/common';
import useArtifactProps from '~/hooks/Artifacts/useArtifactProps';
import { ArtifactPreview } from '~/components/Artifacts/ArtifactPreview';
import { artifactExportSnapshot } from '~/knauf/data-provider/api-endpoints';
import { useLocalize } from '~/hooks';

function ArtifactExportPreview({ artifact }: Readonly<{ artifact: Artifact }>) {
  const previewRef = useRef<SandpackPreviewRef>();
  const { files, fileKey, template, sharedProps } = useArtifactProps({ artifact });

  return (
    <div
      data-testid="artifact-export-root"
      data-knauf-artifact-export="rendering"
      className="h-screen w-screen overflow-hidden bg-white"
    >
      <ArtifactPreview
        artifact={artifact}
        files={files}
        fileKey={fileKey}
        template={template}
        sharedProps={sharedProps}
        previewRef={previewRef as React.MutableRefObject<SandpackPreviewRef>}
        isSharedConvo={true}
      />
    </div>
  );
}

export default function ArtifactExportPage() {
  const localize = useLocalize();
  const { token = '' } = useParams();
  const [artifact, setArtifact] = useState<Artifact | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const secret = decodeURIComponent(window.location.hash.slice(1));
    fetch(artifactExportSnapshot(token), {
      headers: { 'X-Knauf-Export-Secret': secret },
      signal: controller.signal,
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error('Export snapshot unavailable');
        }
        return response.json();
      })
      .then(({ artifact: snapshot }) =>
        setArtifact({ ...snapshot, id: `artifact-export-${token}`, lastUpdateTime: 0 }),
      )
      .catch((error) => {
        if (error.name !== 'AbortError') {
          setFailed(true);
        }
      });
    return () => controller.abort();
  }, [token]);

  if (failed) {
    return <main className="p-6">{localize('com_knauf_artifact_download_unavailable')}</main>;
  }
  return artifact ? <ArtifactExportPreview artifact={artifact} /> : null;
}
