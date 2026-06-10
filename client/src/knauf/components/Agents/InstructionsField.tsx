/**
 * Dual-mode instructions field: formatted markdown view (click to edit)
 * and raw textarea (blur to return to formatted when content has markdown).
 * Undo state managed by parent (KnaufAgentConfig).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Controller, useFormContext, useWatch } from 'react-hook-form';
import { Maximize2, Undo2 } from 'lucide-react';
import type { AgentForm } from '~/common';
import { cn, defaultTextProps, removeFocusOutlines } from '~/utils';
import { useLocalize } from '~/hooks';
import AutoGenerateButton from './AutoGenerateButton';
import KnaufInfoBadge from './KnaufInfoBadge';
import MarkdownPreview from './MarkdownPreview';
import VariablesPopover from './VariablesPopover';
import { looksLikeMarkdown } from './markdownDetect';

const inputClass = cn(
  defaultTextProps,
  'flex w-full px-3 py-2 border-border-light bg-surface-secondary focus-visible:ring-2 focus-visible:ring-ring-primary',
  removeFocusOutlines,
);

const labelClass = 'mb-2 text-token-text-primary block text-sm font-medium';

type ViewMode = 'edit' | 'formatted';

export default function InstructionsField({
  drafting,
  onAutogenerate,
  onExpandClick,
  canUndo,
  onUndo,
  onUserEdit,
  templatePicker,
}: Readonly<{
  /** Whether the autogenerate mutation is in-flight. */
  drafting: boolean;
  /** Handler for the Generate/Polish button click (parent caches undo before calling). */
  onAutogenerate: () => void;
  /** Handler for the Expand button click. */
  onExpandClick: () => void;
  /** Whether an undo action is available (managed by parent). */
  canUndo: boolean;
  /** Handler for the Undo button click (managed by parent). */
  onUndo: () => void;
  /** Called when the user manually edits the textarea (to dismiss undo). */
  onUserEdit?: () => void;
  /** Template picker element to render when instructions are empty. */
  templatePicker?: React.ReactNode;
}>) {
  const localize = useLocalize();
  const { control, setValue, getValues } = useFormContext<AgentForm>();
  const instructions = useWatch({ control, name: 'instructions' });
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const blurTimerRef = useRef<ReturnType<typeof setTimeout>>();

  // Clear blur timer on unmount to prevent state-update-on-unmounted
  useEffect(() => () => clearTimeout(blurTimerRef.current), []);

  // ── View mode ──────────────────────────────────────────────────────────
  const hasContent = (instructions ?? '').trim().length > 0;
  const isMd = looksLikeMarkdown(instructions ?? '');

  // Default to formatted view if content looks like markdown
  const [mode, setMode] = useState<ViewMode>(() =>
    hasContent && isMd ? 'formatted' : 'edit',
  );

  // When switching to a different agent that has markdown content, reset mode
  const agentId = useWatch({ control, name: 'id' });
  const prevAgentId = useRef(agentId);
  useEffect(() => {
    if (agentId !== prevAgentId.current) {
      prevAgentId.current = agentId;
      const text = getValues('instructions') ?? '';
      setMode(looksLikeMarkdown(text) ? 'formatted' : 'edit');
    }
  }, [agentId, getValues]);

  // Auto-switch to formatted view when polish completes
  const wasDrafting = useRef(false);
  useEffect(() => {
    if (wasDrafting.current && !drafting) {
      const text = getValues('instructions') ?? '';
      if (text.trim().length > 0) {
        setMode('formatted');
      }
    }
    wasDrafting.current = drafting;
  }, [drafting, getValues]);

  // ── Variable insertion ──────────────────────────────────────────────────
  const insertVariable = useCallback(
    (token: string) => {
      // If in formatted view, switch to edit mode first
      if (mode === 'formatted') setMode('edit');

      const current = getValues('instructions') ?? '';
      const ta = textareaRef.current;
      if (!ta) {
        setValue('instructions', current + token, { shouldDirty: true });
        return;
      }
      const start = ta.selectionStart ?? current.length;
      const end = ta.selectionEnd ?? current.length;
      const next = current.slice(0, start) + token + current.slice(end);
      setValue('instructions', next, { shouldDirty: true });
      requestAnimationFrame(() => {
        ta.focus();
        const pos = start + token.length;
        ta.setSelectionRange(pos, pos);
      });
    },
    [mode, getValues, setValue],
  );

  // ── Render ──────────────────────────────────────────────────────────────

  // Show template picker when instructions are empty
  if (!hasContent && templatePicker && mode === 'edit') {
    return (
      <div className="mb-6">
        <div className="mb-2 flex items-center gap-2">
          <label
            className={cn(labelClass, 'mb-0 inline-flex min-w-0 flex-grow items-center gap-1.5')}
          >
            <span className="truncate">{localize('com_ui_instructions')}</span>
            <KnaufInfoBadge tip="Tell the agent what to do, who it is, and how to behave. Pick a template to get started, or click Generate to have AI draft instructions for you." />
          </label>
          <AutoGenerateButton
            hasDraft={false}
            drafting={drafting}
            onClick={onAutogenerate}
          />
        </div>
        {templatePicker}
      </div>
    );
  }

  return (
    <div className="mb-6">
      {/* Header row */}
      <div className="mb-2 flex items-center gap-2">
        <label
          htmlFor="knauf-agent-instructions"
          className={cn(labelClass, 'mb-0 inline-flex min-w-0 flex-grow items-center gap-1.5')}
        >
          <span className="truncate">{localize('com_ui_instructions')}</span>
          <KnaufInfoBadge tip="Tell the agent what to do, who it is, and how to behave. You can write this yourself, or click Generate to have AI draft it. Once you have something written the button changes to Polish, so AI can tighten it up." />
        </label>

        {/* Undo after polish */}
        {canUndo && (
          <button
            type="button"
            onClick={onUndo}
            title="Undo polish — revert to previous version"
            className="flex h-7 flex-shrink-0 items-center gap-1 rounded-md border border-border-medium bg-surface-secondary px-2 text-sm text-text-primary transition-colors hover:bg-surface-tertiary"
          >
            <Undo2 className="h-3 w-3 text-text-secondary" aria-hidden />
          </button>
        )}

        <AutoGenerateButton
          hasDraft={hasContent}
          drafting={drafting}
          onClick={onAutogenerate}
        />
        <VariablesPopover onPick={insertVariable} />

        {/* Expand to fullscreen */}
        <button
          type="button"
          onClick={onExpandClick}
          title="Open in full editor"
          className="flex h-7 flex-shrink-0 items-center justify-center rounded-md border border-border-medium bg-surface-secondary px-1.5 text-text-primary transition-colors hover:bg-surface-tertiary"
        >
          <Maximize2 className="h-3 w-3 text-text-secondary" aria-hidden />
        </button>
      </div>

      {/* Content area */}
      {mode === 'formatted' ? (
        <div
          className={cn(
            'cursor-pointer rounded-lg border border-border-light bg-surface-secondary px-3 py-2',
            'min-h-[140px] overflow-y-auto',
          )}
          onClick={() => setMode('edit')}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') setMode('edit');
          }}
          aria-label="Click to edit instructions"
        >
          <MarkdownPreview content={instructions ?? ''} />
        </div>
      ) : (
        <Controller
          name="instructions"
          control={control}
          render={({ field }) => (
            <textarea
              {...field}
              value={field.value ?? ''}
              ref={(el) => {
                field.ref(el);
                textareaRef.current = el;
              }}
              onChange={(e) => {
                field.onChange(e);
                onUserEdit?.();
              }}
              onBlur={() => {
                const text = getValues('instructions') ?? '';
                if (looksLikeMarkdown(text)) {
                  // Small delay to avoid flicker when clicking other buttons
                  blurTimerRef.current = setTimeout(() => setMode('formatted'), 200);
                }
              }}
              rows={6}
              placeholder="What should this agent do? Describe its role, voice, and any guardrails."
              className={cn(inputClass, 'min-h-[140px] resize-y leading-relaxed')}
              id="knauf-agent-instructions"
              aria-label="Agent instructions"
            />
          )}
        />
      )}

      {/* Footer: character count */}
      <div className="mt-1 flex items-center justify-end text-xs text-text-tertiary">
        <span>
          {(instructions ?? '').length}
          {' characters'}
        </span>
      </div>
    </div>
  );
}

export { looksLikeMarkdown } from './markdownDetect';
