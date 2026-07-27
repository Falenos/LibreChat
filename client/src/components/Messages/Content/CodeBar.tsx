import React from 'react';
import { InfoIcon } from 'lucide-react';
import type { CodeBarProps } from '~/common';
import useCopyCode from '~/components/Messages/Content/useCopyCode';
import CopyButton from '~/components/Messages/Content/CopyButton';
import LangIcon from '~/components/Messages/Content/LangIcon';
import RunCode from '~/components/Messages/Content/RunCode';
import { useLocalize } from '~/hooks';
// [knauf] Expose generated-code download and HTML preview actions in the standard toolbar.
import KnaufCodeExportActions from '~/knauf/components/Chat/KnaufCodeExportActions';
// End [knauf]

const CodeBar: React.FC<CodeBarProps> = React.memo(
  ({ lang, error, codeRef, blockIndex, plugin = null, allowExecution = true }) => {
    const localize = useLocalize();
    const { isCopied, handleCopy } = useCopyCode(codeRef);

    return (
      <div className="flex items-center justify-between bg-surface-primary-alt px-1.5 py-1.5 font-sans text-xs text-text-secondary dark:bg-transparent">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          <LangIcon lang={lang} className="size-3.5" />
          {lang}
        </span>
        {plugin === true ? (
          <InfoIcon className="ml-auto flex h-4 w-4 gap-2 text-text-secondary" />
        ) : (
          <div className="flex items-center justify-center gap-2">
            {allowExecution === true && (
              <RunCode lang={lang} codeRef={codeRef} blockIndex={blockIndex} />
            )}
            {error !== true && (
              <>
                {/* [knauf] Keep export actions beside the existing copy action. */}
                <KnaufCodeExportActions lang={lang} codeRef={codeRef} />
                {/* End [knauf] */}
                <CopyButton
                  isCopied={isCopied}
                  onClick={handleCopy}
                  label={localize('com_ui_copy_code')}
                />
              </>
            )}
          </div>
        )}
      </div>
    );
  },
);

export default CodeBar;
