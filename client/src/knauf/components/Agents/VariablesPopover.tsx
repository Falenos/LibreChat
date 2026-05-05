/**
 * Variables popover for the Instructions textarea.
 *
 * Sources the canonical token list from `librechat-data-provider`'s
 * `specialVariables` — the same list the upstream Instructions component
 * uses (4 tokens, double-brace format: `{{current_date}}`,
 * `{{current_user}}`, `{{iso_datetime}}`, `{{current_datetime}}`). These
 * are substituted server-side at agent init via
 * packages/data-provider/src/parsers.ts `replaceSpecialVars()`.
 *
 * Visual treatment: a `+ Variables` button matching upstream's Instructions
 * component styling (border-border-medium, bg-surface-secondary, hover
 * surface-tertiary), opening a Radix Popover with one row per token.
 */
import { PlusCircle } from 'lucide-react';
import * as Popover from '@radix-ui/react-popover';
import { specialVariables } from 'librechat-data-provider';
import type { TSpecialVarLabel } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface VariableOption {
  /** i18n key like `com_ui_special_var_current_date` */
  label: TSpecialVarLabel;
  /** Token to insert, e.g. `{{current_date}}` */
  value: string;
}

const variableOptions: VariableOption[] = Object.keys(specialVariables).map(
  (key) => ({
    label: `com_ui_special_var_${key}` as TSpecialVarLabel,
    value: `{{${key}}}`,
  }),
);

export default function VariablesPopover({
  onPick,
}: Readonly<{
  onPick: (token: string) => void;
}>) {
  const localize = useLocalize();

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          aria-label={localize('com_ui_variables')}
          className={cn(
            'flex h-7 flex-shrink-0 items-center gap-1 whitespace-nowrap rounded-md border border-border-medium bg-surface-secondary px-2 text-sm text-text-primary transition-colors',
            'hover:bg-surface-tertiary',
          )}
        >
          <PlusCircle className="h-3 w-3 text-text-secondary" aria-hidden />
          {localize('com_ui_variables')}
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          side="top"
          sideOffset={6}
          className="z-30 w-56 overflow-hidden rounded-md border border-border-light bg-surface-primary p-1 shadow-lg"
        >
          {variableOptions.map((option) => (
            <Popover.Close key={option.value} asChild>
              <button
                type="button"
                onClick={() => onPick(option.value)}
                className="flex w-full items-center justify-between gap-2 rounded-md px-2.5 py-1.5 text-left text-sm text-text-primary transition-colors hover:bg-surface-tertiary"
              >
                <span>{localize(option.label) || option.label}</span>
                <span className="font-mono text-[11px] text-text-tertiary">
                  {option.value}
                </span>
              </button>
            </Popover.Close>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
