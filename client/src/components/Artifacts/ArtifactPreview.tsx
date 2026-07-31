import React, { memo, useMemo, type MutableRefObject } from 'react';
import { SandpackPreview, SandpackProvider } from '@codesandbox/sandpack-react/unstyled';
import type {
  SandpackProviderProps,
  SandpackPreviewRef,
} from '@codesandbox/sandpack-react/unstyled';
import type { SandpackStartupConfig } from '~/utils/artifacts';
import type { Artifact, ArtifactFiles } from '~/common';
import { sharedFiles, buildSandpackOptions } from '~/utils/artifacts';
// [knauf] Broken generated artifacts expose a repair action fed by Sandpack's structured error. (NO-TICKET)
import ArtifactRepairButton from '~/knauf/components/Artifacts/ArtifactRepairButton';
// End [knauf]

export const ArtifactPreview = memo(function ({
  files,
  fileKey,
  template,
  sharedProps,
  previewRef,
  currentCode,
  startupConfig,
  artifact,
  isSharedConvo,
}: {
  files: ArtifactFiles;
  fileKey: string;
  template: SandpackProviderProps['template'];
  sharedProps: Partial<SandpackProviderProps>;
  previewRef: MutableRefObject<SandpackPreviewRef>;
  currentCode?: string;
  startupConfig?: SandpackStartupConfig;
  // [knauf] Repair targets the originating assistant message; shared previews remain read-only. (NO-TICKET)
  artifact: Artifact;
  isSharedConvo?: boolean;
  // End [knauf]
}) {
  const artifactFiles = useMemo(() => {
    if (Object.keys(files).length === 0) {
      return files;
    }
    const code = currentCode ?? '';
    if (!code) {
      return files;
    }
    return {
      ...files,
      [fileKey]: { code },
    };
  }, [currentCode, files, fileKey]);

  const options: SandpackProviderProps['options'] = useMemo(
    () => buildSandpackOptions(template, startupConfig),
    [startupConfig, template],
  );

  if (Object.keys(artifactFiles).length === 0) {
    return null;
  }

  return (
    <SandpackProvider
      files={{ ...artifactFiles, ...sharedFiles }}
      options={options}
      {...sharedProps}
      template={template}
    >
      <SandpackPreview
        showOpenInCodeSandbox={false}
        showRefreshButton={false}
        tabIndex={0}
        ref={previewRef}
      >
        {/* [knauf] Keep the repair action above the generated app's error overlay for owners only. (NO-TICKET) */}
        {isSharedConvo === true ? undefined : <ArtifactRepairButton artifact={artifact} />}
        {/* End [knauf] */}
      </SandpackPreview>
    </SandpackProvider>
  );
});
