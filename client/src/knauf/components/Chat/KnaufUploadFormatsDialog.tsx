/**
 * [knauf] "Supported file types" dialog for the chat upload affordance.
 *
 * Progressive-disclosure surface opened from the ⓘ in the attachment menu
 * (AttachFileMenu). Explains, in grouped bullets, which formats the Knauf chat
 * accepts + the per-category size/count limits, and gives the Save-As steps to
 * migrate legacy Office binaries (.doc/.xls/.ppt) that the allow-list rejects.
 *
 * The size caps are DERIVED from `knaufCategorySizeLimits` (the single source of
 * truth enforced client + server), so the displayed numbers can't drift from what
 * the validator actually allows. The format *extension* lists remain curated copy
 * (the allow-list MIME regexes don't map cleanly to friendly labels) — keep those
 * in sync with the Tier-0 allow-list in librechat.yaml. KK20-190 (upload-guidance).
 */
import { knaufCategorySizeLimits, megabyte } from 'librechat-data-provider';
import { OGDialog, OGDialogContent, OGDialogHeader, OGDialogTitle } from '@librechat/client';
import { useLocalize } from '~/hooks';

interface KnaufUploadFormatsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The three accepted-format groups: a label, a ` · `-delimited item list, and the
 * per-category per-file size cap (MB) shown as a badge on the header. `mb` is derived
 * from `knaufCategorySizeLimits` so it always matches the enforced cap.
 */
const FORMAT_GROUPS = [
  {
    labelKey: 'com_knauf_upload_formats_documents_label',
    itemsKey: 'com_knauf_upload_formats_documents_items',
    mb: knaufCategorySizeLimits.document / megabyte,
  },
  {
    labelKey: 'com_knauf_upload_formats_data_label',
    itemsKey: 'com_knauf_upload_formats_data_items',
    mb: knaufCategorySizeLimits.data / megabyte,
  },
  {
    labelKey: 'com_knauf_upload_formats_images_label',
    itemsKey: 'com_knauf_upload_formats_images_items',
    mb: knaufCategorySizeLimits.image / megabyte,
  },
] as const;

/** The legacy → modern conversion steps, one bullet each. */
const LEGACY_STEP_KEYS = [
  'com_knauf_upload_formats_legacy_doc',
  'com_knauf_upload_formats_legacy_xls',
  'com_knauf_upload_formats_legacy_ppt',
] as const;

function KnaufUploadFormatsDialog({ open, onOpenChange }: Readonly<KnaufUploadFormatsDialogProps>) {
  const localize = useLocalize();

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent className="w-11/12 max-w-md">
        <OGDialogHeader>
          <OGDialogTitle>{localize('com_knauf_upload_formats_title')}</OGDialogTitle>
        </OGDialogHeader>
        <div className="space-y-4 text-sm text-text-primary">
          {FORMAT_GROUPS.map(({ labelKey, itemsKey, mb }) => (
            <div key={labelKey}>
              <div className="flex items-baseline justify-between gap-2">
                <p className="font-medium">{localize(labelKey)}</p>
                <span className="shrink-0 text-xs text-text-secondary">
                  {localize('com_knauf_upload_formats_cap', { mb })}
                </span>
              </div>
              <ul className="mt-1 list-disc space-y-0.5 pl-5 text-text-secondary">
                {/* Items are stored as a ` · `-delimited string (split-safe — no item
                    contains the delimiter) so each format renders as its own bullet. */}
                {localize(itemsKey)
                  .split(' · ')
                  .map((item) => (
                    <li key={item}>{item}</li>
                  ))}
              </ul>
            </div>
          ))}
          <p className="text-xs text-text-secondary">
            {localize('com_knauf_upload_formats_limits')}
          </p>
          <div className="rounded-lg border border-border-light p-3">
            <p className="font-medium">{localize('com_knauf_upload_formats_legacy_title')}</p>
            <p className="mt-1 text-text-secondary">
              {localize('com_knauf_upload_formats_legacy_intro')}
            </p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-text-secondary">
              {LEGACY_STEP_KEYS.map((key) => (
                <li key={key}>{localize(key)}</li>
              ))}
            </ul>
          </div>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}

export default KnaufUploadFormatsDialog;
