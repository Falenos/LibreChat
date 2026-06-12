/**
 * Fullscreen editor overlay for agent instructions (OGDialog).
 * Monaco Editor in markdown mode, always-visible right panel (formatted
 * preview or stacked template+preview), context-aware mobile tabs.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFormContext, useWatch } from 'react-hook-form';
import MonacoEditor from '@monaco-editor/react';
import type { editor, IPosition } from 'monaco-editor';
import { X, Undo2, BookOpen, Pencil, FileText, Sparkles, Loader2, Check, ChevronDown, ChevronRight, LayoutTemplate } from 'lucide-react';
import { OGDialog, OGDialogContent } from '@librechat/client';
import type { AgentForm } from '~/common';
import { cn } from '~/utils';
import { useLocalize } from '~/hooks';
import AutoGenerateButton from './AutoGenerateButton';
import MarkdownPreview from './MarkdownPreview';
import VariablesPopover from './VariablesPopover';

type MobileTab = 'edit' | 'formatted';

// ── Right-panel sub-components (extracted to reduce cognitive complexity) ──

/** Template reference + AI preview panel (shown when a template is active).
 *  Layout: template reference takes more space when no preview exists,
 *  preview CTA is compact. After preview is generated, both areas split
 *  the space. */
function TemplatePreviewPanel({
  templateContent,
  templateCollapsed,
  onToggleCollapse,
  previewText,
  previewLoading,
  previewError,
  onGeneratePreview,
  onApply,
}: Readonly<{
  templateContent: string;
  templateCollapsed: boolean;
  onToggleCollapse: () => void;
  previewText: string | null;
  previewLoading: boolean;
  previewError: string | null;
  onGeneratePreview: () => void;
  onApply: () => void;
}>) {
  const localize = useLocalize();
  const hasPreview = previewText != null || previewLoading;
  return (
    <>
      {/* Collapsible template reference — takes flex-1 when no preview */}
      <div className={cn(
        'flex flex-col overflow-hidden border-b border-border-light',
        hasPreview ? 'max-h-[40%] shrink-0' : 'flex-1 min-h-0',
      )}>
        <button
          type="button"
          onClick={onToggleCollapse}
          className="flex w-full items-center gap-1.5 px-4 py-2 text-sm font-medium text-text-secondary transition-colors hover:text-text-primary shrink-0"
        >
          {templateCollapsed
            ? <ChevronRight className="h-3.5 w-3.5" aria-hidden />
            : <ChevronDown className="h-3.5 w-3.5" aria-hidden />}
          <FileText className="h-3.5 w-3.5" aria-hidden />
          {localize('com_knauf_prompt_template_reference')}
        </button>
        {!templateCollapsed && (
          <div className="flex-1 min-h-0 overflow-y-auto border-t border-border-light px-4 py-3">
            <MarkdownPreview content={templateContent} />
          </div>
        )}
      </div>

      {/* Preview area — shrink-to-fit when only the CTA is showing,
           flex-1 once a preview or loading state needs scroll space */}
      <div className={cn(
        'flex min-h-0 flex-col overflow-hidden',
        hasPreview ? 'flex-1' : 'shrink-0',
      )}>
        <div className={cn(hasPreview ? 'flex-1 overflow-y-auto' : '', 'p-4')}>
          {previewLoading && (
            <div className="flex items-center gap-2 py-4 text-sm text-text-secondary">
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
              {localize('com_knauf_prompt_generating_preview')}
            </div>
          )}
          {previewError && (
            <div className="py-3">
              <p className="text-sm text-red-500">{previewError}</p>
              <button
                type="button"
                onClick={onGeneratePreview}
                className="mt-2 text-sm text-text-secondary underline hover:text-text-primary"
              >
                {localize('com_knauf_prompt_retry')}
              </button>
            </div>
          )}
          {previewText && !previewLoading && (
            <MarkdownPreview content={previewText} />
          )}
          {!previewText && !previewLoading && !previewError && (
            <div className="flex items-center gap-3 py-4">
              <button
                type="button"
                onClick={onGeneratePreview}
                className="flex items-center gap-1.5 rounded-lg border border-border-medium bg-surface-secondary px-3 py-1.5 text-sm font-medium text-text-primary transition-colors hover:bg-surface-tertiary"
              >
                <Sparkles className="h-3.5 w-3.5" aria-hidden />
                {localize('com_knauf_prompt_preview_with_template')}
              </button>
              <span className="text-xs text-text-tertiary">
                {localize('com_knauf_prompt_preview_hint')}
              </span>
            </div>
          )}
        </div>

        {/* Apply button — pinned at bottom */}
        {previewText && !previewLoading && (
          <div className="border-t border-border-light px-4 py-2.5 shrink-0">
            <button
              type="button"
              onClick={onApply}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-700"
            >
              <Check className="h-4 w-4" aria-hidden />
              {localize('com_knauf_prompt_apply_to_editor')}
            </button>
          </div>
        )}
      </div>
    </>
  );
}

/** Formatted markdown preview of editor content (shown when no template is active). */
function FormattedPreviewPanel({ content }: Readonly<{ content: string }>) {
  const localize = useLocalize();
  return (
    <>
      <div className="flex items-center gap-2 border-b border-border-light px-4 py-2">
        <BookOpen className="h-3.5 w-3.5 text-text-secondary" aria-hidden />
        <span className="text-xs font-medium text-text-secondary">{localize('com_knauf_prompt_formatted_view')}</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        <MarkdownPreview content={content} />
      </div>
    </>
  );
}

// ── Main overlay component ────────────────────────────────────────────────

export default function InstructionsEditorOverlay({
  open,
  onOpenChange,
  drafting,
  onAutogenerate,
  canUndo,
  onUndo,
  templatePicker,
  onTemplatePanelClose,
  templateReferenceContent,
  onGeneratePreview,
  onApplyPreview,
}: Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  drafting: boolean;
  onAutogenerate: () => void;
  canUndo: boolean;
  onUndo: () => void;
  templatePicker?: React.ReactNode;
  onTemplatePanelClose?: () => void;
  /** Raw template content for the read-only reference panel. Display only — never persisted. */
  templateReferenceContent?: string;
  /** Generates a preview of the user's draft merged into a template. */
  onGeneratePreview?: (templateContent: string) => Promise<string>;
  /** Commits the previewed text to the editor with undo support. */
  onApplyPreview?: (text: string) => void;
}>) {
  const localize = useLocalize();
  const { control, setValue, getValues } = useFormContext<AgentForm>();
  const instructions = useWatch({ control, name: 'instructions' });
  const monacoRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const [mobileTab, setMobileTab] = useState<MobileTab>('edit');
  const [showTemplates, setShowTemplates] = useState(false);

  // Right panel: always visible — formatted preview or stacked template+preview
  const hasTemplate = Boolean(templateReferenceContent);
  const [templateCollapsed, setTemplateCollapsed] = useState(false);
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewForTemplateRef = useRef<string | undefined>(undefined);
  const previewGenRef = useRef(0);

  // Detect dark mode for Monaco theme
  const isDark = typeof document !== 'undefined'
    && document.documentElement.classList.contains('dark');

  // Monaco editor options — markdown-optimized, minimal chrome
  const editorOptions = useMemo<editor.IStandaloneEditorConstructionOptions>(() => ({
    minimap: { enabled: false },
    lineNumbers: 'off',
    scrollBeyondLastLine: false,
    fontSize: 14,
    tabSize: 2,
    wordWrap: 'on',
    automaticLayout: true,
    padding: { top: 12, bottom: 12 },
    renderLineHighlight: 'none',
    scrollbar: {
      vertical: 'auto',
      horizontal: 'auto',
      verticalScrollbarSize: 8,
      horizontalScrollbarSize: 8,
      useShadows: false,
    },
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    overviewRulerBorder: false,
    folding: false,
    glyphMargin: false,
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    parameterHints: { enabled: false },
    occurrencesHighlight: 'off',
    selectionHighlight: true,
    matchBrackets: 'never',
  }), []);

  // Reset preview when template changes — expand template reference for the new selection
  useEffect(() => {
    if (templateReferenceContent !== previewForTemplateRef.current) {
      previewGenRef.current += 1; // invalidate in-flight preview requests
      setPreviewText(null);
      setPreviewError(null);
      setPreviewLoading(false);
      setTemplateCollapsed(false);
      previewForTemplateRef.current = templateReferenceContent;
    }
  }, [templateReferenceContent]);

  // Stable ref for onTemplatePanelClose to avoid re-triggering the effect
  const onTemplatePanelCloseRef = useRef(onTemplatePanelClose);
  onTemplatePanelCloseRef.current = onTemplatePanelClose;

  // Focus editor when overlay opens; end template browsing when it closes
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => monacoRef.current?.focus());
    } else {
      setShowTemplates((prev) => {
        if (prev) onTemplatePanelCloseRef.current?.();
        return false;
      });
    }
  }, [open]);

  // Auto-switch to formatted tab on mobile after polish completes
  const wasDrafting = useRef(false);
  useEffect(() => {
    if (wasDrafting.current && !drafting) {
      setMobileTab('formatted');
    }
    wasDrafting.current = drafting;
  }, [drafting]);

  // Sync external form changes into Monaco (e.g., after Polish or Apply).
  // `suppressOnChange` prevents ed.setValue from re-triggering handleEditorChange
  // which would cause a redundant form write cycle.
  const lastExternalValue = useRef(instructions ?? '');
  const suppressOnChange = useRef(false);
  useEffect(() => {
    const ed = monacoRef.current;
    if (!ed) return;
    const current = instructions ?? '';
    const editorValue = ed.getValue();
    if (current !== editorValue && current !== lastExternalValue.current) {
      suppressOnChange.current = true;
      ed.setValue(current);
      suppressOnChange.current = false;
    }
    lastExternalValue.current = current;
  }, [instructions]);

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (suppressOnChange.current) return;
      const text = value ?? '';
      lastExternalValue.current = text;
      setValue('instructions', text, { shouldDirty: true });
    },
    [setValue],
  );

  // Track the last known cursor position so variable insertion works
  // even after the popover button steals focus from Monaco.
  const lastCursorPosition = useRef<IPosition | null>(null);

  const handleEditorMount = useCallback(
    (ed: editor.IStandaloneCodeEditor) => {
      monacoRef.current = ed;
      ed.onDidChangeCursorPosition((e) => {
        lastCursorPosition.current = e.position;
      });
    },
    [],
  );

  const insertVariable = useCallback(
    (token: string) => {
      setMobileTab('edit');
      const ed = monacoRef.current;
      if (ed) {
        const selection = ed.getSelection();
        // If the selection is the default (1,1)→(1,1) and we have a stored
        // cursor position, use that instead — the popover stole focus.
        const useStoredPos =
          selection &&
          selection.startLineNumber === 1 &&
          selection.startColumn === 1 &&
          selection.endLineNumber === 1 &&
          selection.endColumn === 1 &&
          lastCursorPosition.current;

        if (useStoredPos) {
          const pos = lastCursorPosition.current!;
          const range = {
            startLineNumber: pos.lineNumber,
            startColumn: pos.column,
            endLineNumber: pos.lineNumber,
            endColumn: pos.column,
          };
          ed.executeEdits('insertVariable', [{ range, text: token, forceMoveMarkers: true }]);
        } else if (selection) {
          ed.executeEdits('insertVariable', [{ range: selection, text: token, forceMoveMarkers: true }]);
        }
        ed.focus();
      } else {
        const current = getValues('instructions') ?? '';
        setValue('instructions', current + token, { shouldDirty: true });
      }
    },
    [getValues, setValue],
  );

  const hasContent = (instructions ?? '').trim().length > 0;

  const handleGeneratePreview = useCallback(async () => {
    if (!templateReferenceContent || !onGeneratePreview) return;
    const thisGen = ++previewGenRef.current;
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const text = await onGeneratePreview(templateReferenceContent);
      if (previewGenRef.current !== thisGen) return; // template changed — discard stale result
      setPreviewText(text);
      setTemplateCollapsed(true);
    } catch (err: unknown) {
      if (previewGenRef.current !== thisGen) return;
      setPreviewError(err instanceof Error ? err.message : localize('com_knauf_prompt_preview_failed'));
    } finally {
      if (previewGenRef.current === thisGen) setPreviewLoading(false);
    }
  }, [templateReferenceContent, onGeneratePreview, localize]);

  const handleApply = useCallback(() => {
    if (!previewText || !onApplyPreview) return;
    onApplyPreview(previewText);
    setShowTemplates(false);
    onTemplatePanelClose?.();
  }, [previewText, onApplyPreview, onTemplatePanelClose]);

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent
        ref={dialogRef}
        showCloseButton={false}
        className={cn(
          // Override OGDialogContent's default centered/constrained layout
          // to go fullscreen. The base class uses translate-x/y-[-50%] +
          // left/top [50%] — we zero those and use inset-0 instead.
          // !overflow-hidden prevents the base overflow-y-auto from
          // fighting our flex layout — each child scrolls independently.
          '!fixed !inset-0 !left-0 !top-0 !max-h-screen !max-w-full',
          '!h-screen !w-screen !translate-x-0 !translate-y-0',
          '!rounded-none !border-0 !gap-0 !p-0 !overflow-hidden',
          'flex flex-col bg-surface-primary',
        )}
      >
        {/* ── Header ──────────────────────────────────────────────── */}
        <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border-light px-4 py-2 md:py-3">
          <h2 className="mr-auto text-base font-semibold text-text-primary">
            {localize('com_knauf_prompt_instructions')}
          </h2>

          <span className="text-xs text-text-tertiary">
            {localize('com_knauf_prompt_chars', { 0: `${(instructions ?? '').length}` })}
          </span>

          {canUndo && (
            <button
              type="button"
              onClick={onUndo}
              title={localize('com_knauf_prompt_undo_revert')}
              className="flex h-8 items-center gap-1 rounded-md border border-border-medium bg-surface-secondary px-2 text-sm text-text-primary transition-colors hover:bg-surface-tertiary"
            >
              <Undo2 className="h-3.5 w-3.5 text-text-secondary" aria-hidden />
              <span className="hidden sm:inline">{localize('com_knauf_prompt_undo')}</span>
            </button>
          )}

          <AutoGenerateButton
            hasDraft={hasContent}
            drafting={drafting}
            onClick={onAutogenerate}
            labelClassName="hidden sm:inline"
          />
          <VariablesPopover onPick={insertVariable} labelClassName="hidden sm:inline" portalContainer={dialogRef.current} />

          {templatePicker && (
            <button
              type="button"
              title={localize('com_knauf_prompt_templates')}
              onClick={() => setShowTemplates((v) => {
                const next = !v;
                if (!next) onTemplatePanelClose?.();
                return next;
              })}
              className={cn(
                'flex h-8 items-center gap-1 rounded-md border px-2 text-sm transition-colors',
                showTemplates
                  ? 'border-border-heavy bg-surface-tertiary text-text-primary'
                  : 'border-border-medium bg-surface-secondary text-text-primary hover:bg-surface-tertiary',
              )}
            >
              <LayoutTemplate className="h-3.5 w-3.5 text-text-secondary" aria-hidden />
              <span className="hidden sm:inline">{localize('com_knauf_prompt_templates')}</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => onOpenChange(false)}
            title={localize('com_knauf_prompt_close_editor')}
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-surface-tertiary hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* ── Templates panel (collapsible) ───────────────────── */}
        {showTemplates && templatePicker && (
          <div className="shrink-0 overflow-y-auto border-b border-border-light bg-surface-secondary px-4 py-3 max-h-[40vh] md:max-h-none">
            {templatePicker}
          </div>
        )}

        {/* ── Mobile tab bar (visible < md) — context-aware ──── */}
        <div className="flex border-b border-border-light md:hidden">
            <button
              type="button"
              onClick={() => setMobileTab('edit')}
              className={cn(
                'flex-1 px-4 py-2 text-sm font-medium transition-colors',
                mobileTab === 'edit'
                  ? 'border-b-2 border-text-primary text-text-primary'
                  : 'text-text-secondary hover:text-text-primary',
              )}
            >
              <Pencil className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
              {localize('com_knauf_prompt_edit_tab')}
            </button>
            <button
              type="button"
              onClick={() => setMobileTab('formatted')}
              className={cn(
                'flex-1 px-4 py-2 text-sm font-medium transition-colors',
                mobileTab === 'formatted'
                  ? 'border-b-2 border-text-primary text-text-primary'
                  : 'text-text-secondary hover:text-text-primary',
              )}
            >
              {hasTemplate ? (
                <>
                  <Sparkles className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
                  {localize('com_knauf_prompt_preview_tab')}
                </>
              ) : (
                <>
                  <BookOpen className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
                  {localize('com_knauf_prompt_formatted_tab')}
                </>
              )}
            </button>
          </div>

        {/* ── Body ────────────────────────────────────────────── */}
        <div className="flex min-h-0 flex-1 overflow-hidden">
          {/* Editor pane — Monaco editor in markdown mode.
              min-h-0 on the flex child is required for Firefox to allow
              the flex item to shrink below its content height. */}
          <div
            className={cn(
              'flex min-h-0 flex-col overflow-hidden',
              'md:flex md:w-1/2 md:border-r md:border-border-light',
              mobileTab === 'edit' ? 'flex w-full' : 'hidden',
            )}
          >
            <div className="min-h-0 flex-1 overflow-hidden">
              <MonacoEditor
                height="100%"
                language="markdown"
                theme={isDark ? 'vs-dark' : 'vs'}
                value={instructions ?? ''}
                onChange={handleEditorChange}
                onMount={handleEditorMount}
                options={editorOptions}
              />
            </div>
          </div>

          {/* Right pane — always visible. Formatted preview when no template,
              stacked template reference + AI preview when template selected */}
          <div
              className={cn(
                'flex min-h-0 flex-col overflow-hidden',
                'md:flex md:w-1/2',
                mobileTab === 'formatted' ? 'flex w-full' : 'hidden',
              )}
            >
              {hasTemplate ? (
                <TemplatePreviewPanel
                  templateContent={templateReferenceContent ?? ''}
                  templateCollapsed={templateCollapsed}
                  onToggleCollapse={() => setTemplateCollapsed((v) => !v)}
                  previewText={previewText}
                  previewLoading={previewLoading}
                  previewError={previewError}
                  onGeneratePreview={handleGeneratePreview}
                  onApply={handleApply}
                />
              ) : (
                <FormattedPreviewPanel content={instructions ?? ''} />
              )}
            </div>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
