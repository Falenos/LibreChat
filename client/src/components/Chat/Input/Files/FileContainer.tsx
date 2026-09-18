import type { ReactNode } from 'react';
import type { TFile } from 'librechat-data-provider';
import type { ExtendedFile } from '~/common';
import { getFileType, cn } from '~/utils';
import FilePreview from './FilePreview';
import RemoveFile from './RemoveFile';

const FileContainer = ({
  file,
  overrideType,
  displayName,
  subtitle,
  buttonClassName,
  containerClassName,
  onDelete,
  onClick,
  // [knauf] KK20-366 — generated download cards need an in-flight lockout.
  disabled = false,
  busy = false,
  // End [knauf]
  // [knauf] KK20-297 — explicit affordance for actionable file cards.
  action,
  // End [knauf]
}: {
  file: Partial<ExtendedFile | TFile>;
  overrideType?: string;
  /**
   * Optional pre-computed label for the chip. Callers in code-execution
   * artifact contexts pass the de-suffixed name; upload chips and
   * persisted user files leave this undefined and render the raw filename.
   */
  displayName?: string;
  /**
   * Optional override for the subtitle line (defaults to the file
   * type's localized title — e.g. "PowerPoint Presentation"). Used by
   * the deferred-preview flow to surface "Preparing preview…" /
   * "Preview unavailable" inline within the chip rather than as a
   * loose-feeling annotation below it. Pass a ReactNode so callers
   * can include icons (spinner, alert) alongside the text.
   */
  subtitle?: ReactNode;
  buttonClassName?: string;
  containerClassName?: string;
  onDelete?: () => void;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
  // [knauf] KK20-366 — keep the card's native control inaccessible while download resolution runs.
  disabled?: boolean;
  busy?: boolean;
  // End [knauf]
  // [knauf] KK20-297 — upload and preview-only chips omit this.
  action?: Readonly<{ icon: ReactNode; label: string }>;
  // End [knauf]
}) => {
  const fileType = getFileType(overrideType ?? file.type);
  const visibleName = displayName ?? file.filename ?? '';

  return (
    <div
      className={cn('group relative inline-block text-sm text-text-primary', containerClassName)}
    >
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-busy={busy || undefined}
        aria-label={
          // [knauf] KK20-297 — action cards get a descriptive localized label.
          action?.label ?? visibleName
          // End [knauf]
        }
        className={cn(
          'relative overflow-hidden rounded-2xl border border-border-light bg-surface-hover-alt',
          buttonClassName,
        )}
      >
        <div className="w-56 p-1.5">
          <div className="flex flex-row items-center gap-2">
            <FilePreview file={file} fileType={fileType} className="relative" />
            <div className="overflow-hidden">
              <div className="truncate font-medium" title={visibleName}>
                {visibleName}
              </div>
              {subtitle != null ? (
                subtitle
              ) : (
                <div className="truncate text-text-secondary" title={fileType.title}>
                  {fileType.title}
                </div>
              )}
            </div>
            {/* [knauf] KK20-297 — affordance inside the existing button; no nested control. */}
            {action && <span className="ml-auto shrink-0 text-text-secondary">{action.icon}</span>}
            {/* End [knauf] */}
          </div>
        </div>
      </button>
      {onDelete && <RemoveFile onRemove={onDelete} />}
    </div>
  );
};

export default FileContainer;
