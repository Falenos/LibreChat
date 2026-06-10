/**
 * Fullscreen editor overlay for agent instructions (OGDialog).
 * Monaco Editor in markdown mode, adaptive right panel (formatted / template+preview),
 * context-aware mobile tabs. Right panel hidden for plain text without a template.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFormContext, useWatch } from 'react-hook-form';
import MonacoEditor from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { X, Undo2, BookOpen, Pencil, FileText, Sparkles, Loader2, Check } from 'lucide-react';
import { OGDialog, OGDialogContent } from '@librechat/client';
import type { AgentForm } from '~/common';
import { cn } from '~/utils';
import { looksLikeMarkdown } from './markdownDetect';
import AutoGenerateButton from './AutoGenerateButton';
import MarkdownPreview from './MarkdownPreview';
import VariablesPopover from './VariablesPopover';

type MobileTab = 'edit' | 'formatted';
type RightTab = 'template' | 'preview';

export default function InstructionsEditorOverlay({
  open,
  onOpenChange,
  drafting,
  onAutogenerate,
  canUndo,
  onUndo,
  onUserEdit,
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
  onUserEdit?: () => void;
  templatePicker?: React.ReactNode;
  onTemplatePanelClose?: () => void;
  /** Raw template content for the read-only reference panel. Display only — never persisted. */
  templateReferenceContent?: string;
  /** Generates a preview of the user's draft merged into a template. */
  onGeneratePreview?: (templateContent: string) => Promise<string>;
  /** Commits the previewed text to the editor with undo support. */
  onApplyPreview?: (text: string) => void;
}>) {
  const { control, setValue, getValues } = useFormContext<AgentForm>();
  const instructions = useWatch({ control, name: 'instructions' });
  const monacoRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const [mobileTab, setMobileTab] = useState<MobileTab>('edit');
  const [showTemplates, setShowTemplates] = useState(false);

  // Right panel: context-aware tabs when a template is selected
  const hasTemplate = Boolean(templateReferenceContent);
  const isMd = looksLikeMarkdown(instructions ?? '');
  // Show right panel when there's markdown to preview or a template is active
  const showRightPanel = hasTemplate || isMd;
  const [rightTab, setRightTab] = useState<RightTab>('template');
  const [previewText, setPreviewText] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewForTemplateRef = useRef<string | undefined>(undefined);

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

  // Reset preview when template changes
  useEffect(() => {
    if (templateReferenceContent !== previewForTemplateRef.current) {
      setPreviewText(null);
      setPreviewError(null);
      setPreviewLoading(false);
      previewForTemplateRef.current = templateReferenceContent;
      if (templateReferenceContent) {
        setRightTab('template');
      }
    }
  }, [templateReferenceContent]);

  // Focus editor when overlay opens; end template browsing when it closes
  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => monacoRef.current?.focus());
    } else if (showTemplates) {
      setShowTemplates(false);
      onTemplatePanelClose?.();
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-switch to formatted tab on mobile after polish completes
  const wasDrafting = useRef(false);
  useEffect(() => {
    if (wasDrafting.current && !drafting) {
      if (showRightPanel) setMobileTab('formatted');
    }
    wasDrafting.current = drafting;
  }, [drafting, showRightPanel]);

  // Sync external form changes into Monaco (e.g., after Polish or Apply)
  const lastExternalValue = useRef(instructions ?? '');
  useEffect(() => {
    const ed = monacoRef.current;
    if (!ed) return;
    const current = instructions ?? '';
    const editorValue = ed.getValue();
    // Only update if the form value changed externally (not from our own onChange)
    if (current !== editorValue && current !== lastExternalValue.current) {
      ed.setValue(current);
    }
    lastExternalValue.current = current;
  }, [instructions]);

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      const text = value ?? '';
      lastExternalValue.current = text;
      setValue('instructions', text, { shouldDirty: true });
      onUserEdit?.();
    },
    [setValue, onUserEdit],
  );

  const handleEditorMount = useCallback(
    (ed: editor.IStandaloneCodeEditor) => {
      monacoRef.current = ed;
    },
    [],
  );

  const insertVariable = useCallback(
    (token: string) => {
      setMobileTab('edit');
      const ed = monacoRef.current;
      if (ed) {
        const selection = ed.getSelection();
        if (selection) {
          ed.executeEdits('insertVariable', [{
            range: selection,
            text: token,
            forceMoveMarkers: true,
          }]);
          ed.focus();
        }
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
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const text = await onGeneratePreview(templateReferenceContent);
      setPreviewText(text);
    } catch (err: unknown) {
      setPreviewError(err instanceof Error ? err.message : 'Preview generation failed.');
    } finally {
      setPreviewLoading(false);
    }
  }, [templateReferenceContent, onGeneratePreview]);

  const handleApply = useCallback(() => {
    if (!previewText || !onApplyPreview) return;
    onApplyPreview(previewText);
    setShowTemplates(false);
    onTemplatePanelClose?.();
  }, [previewText, onApplyPreview, onTemplatePanelClose]);

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent
        showCloseButton={false}
        className={cn(
          // Override OGDialogContent's default centered/constrained layout
          // to go fullscreen. The base class uses translate-x/y-[-50%] +
          // left/top [50%] — we zero those and use inset-0 instead.
          '!fixed !inset-0 !left-0 !top-0 !max-h-screen !max-w-full',
          '!h-screen !w-screen !translate-x-0 !translate-y-0',
          '!rounded-none !border-0 !gap-0 !p-0',
          'flex flex-col bg-surface-primary',
        )}
      >
        {/* ── Header ──────────────────────────────────────────────── */}
        <header className="flex items-center gap-2 border-b border-border-light px-4 py-3">
          <h2 className="flex-grow text-base font-semibold text-text-primary">
            Instructions
          </h2>

          <span className="text-xs text-text-tertiary">
            {(instructions ?? '').length} chars
          </span>

          {canUndo && (
            <button
              type="button"
              onClick={onUndo}
              title="Undo polish"
              className="flex h-8 items-center gap-1 rounded-md border border-border-medium bg-surface-secondary px-2 text-sm text-text-primary transition-colors hover:bg-surface-tertiary"
            >
              <Undo2 className="h-3.5 w-3.5 text-text-secondary" aria-hidden />
              <span>Undo</span>
            </button>
          )}

          <AutoGenerateButton
            hasDraft={hasContent}
            drafting={drafting}
            onClick={onAutogenerate}
          />
          <VariablesPopover onPick={insertVariable} />

          {templatePicker && (
            <button
              type="button"
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
              📄 <span>Templates</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => onOpenChange(false)}
            title="Close editor"
            className="flex h-8 w-8 items-center justify-center rounded-md text-text-secondary transition-colors hover:bg-surface-tertiary hover:text-text-primary"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        {/* ── Templates panel (collapsible) ───────────────────── */}
        {showTemplates && templatePicker && (
          <div className="border-b border-border-light bg-surface-secondary px-4 py-3">
            {templatePicker}
          </div>
        )}

        {/* ── Mobile tab bar (visible < md) — context-aware ──── */}
        {showRightPanel && (
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
              Edit
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
                  <FileText className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
                  Template
                </>
              ) : (
                <>
                  <BookOpen className="mr-1.5 inline h-3.5 w-3.5" aria-hidden />
                  Formatted
                </>
              )}
            </button>
          </div>
        )}

        {/* ── Body ────────────────────────────────────────────── */}
        <div className="flex flex-1 overflow-hidden">
          {/* Editor pane — Monaco editor in markdown mode */}
          <div
            className={cn(
              'flex flex-col overflow-hidden',
              showRightPanel
                ? 'md:flex md:w-1/2 md:border-r md:border-border-light'
                : 'md:flex md:w-full',
              // Narrow: tab-gated when right panel exists, otherwise full width
              showRightPanel
                ? (mobileTab === 'edit' ? 'flex w-full' : 'hidden')
                : 'flex w-full',
            )}
          >
            <div className="flex-1 overflow-hidden">
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

          {/* Right pane — hidden when plain text + no template.
              "Formatted" when markdown only, "Template | Preview" tabs when template selected */}
          {showRightPanel && (
            <div
              className={cn(
                'flex flex-col overflow-hidden',
                'md:flex md:w-1/2',
                mobileTab === 'formatted' ? 'flex w-full' : 'hidden',
              )}
            >
              {hasTemplate ? (
                <>
                  {/* Tab bar */}
                  <div className="flex border-b border-border-light">
                    <button
                      type="button"
                      onClick={() => setRightTab('template')}
                      className={cn(
                        'flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors',
                        rightTab === 'template'
                          ? 'border-b-2 border-text-primary text-text-primary'
                          : 'text-text-secondary hover:text-text-primary',
                      )}
                    >
                      <FileText className="h-3.5 w-3.5" aria-hidden />
                      Template
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRightTab('preview');
                        if (!previewText && !previewLoading && !previewError) {
                          handleGeneratePreview();
                        }
                      }}
                      className={cn(
                        'flex items-center gap-1.5 px-4 py-2 text-sm font-medium transition-colors',
                        rightTab === 'preview'
                          ? 'border-b-2 border-text-primary text-text-primary'
                          : 'text-text-secondary hover:text-text-primary',
                      )}
                    >
                      <Sparkles className="h-3.5 w-3.5" aria-hidden />
                      Preview
                    </button>
                  </div>

                  {/* Template tab content */}
                  {rightTab === 'template' && (
                    <div className="flex-1 overflow-y-auto p-4">
                      <MarkdownPreview content={templateReferenceContent ?? ''} />
                    </div>
                  )}

                  {/* Preview tab content */}
                  {rightTab === 'preview' && (
                    <div className="flex flex-1 flex-col overflow-hidden">
                      <div className="flex-1 overflow-y-auto p-4">
                        {previewLoading && (
                          <div className="flex items-center gap-2 py-8 text-sm text-text-secondary">
                            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                            Generating preview…
                          </div>
                        )}
                        {previewError && (
                          <div className="py-4">
                            <p className="text-sm text-red-500">{previewError}</p>
                            <button
                              type="button"
                              onClick={handleGeneratePreview}
                              className="mt-2 text-sm text-text-secondary underline hover:text-text-primary"
                            >
                              Retry
                            </button>
                          </div>
                        )}
                        {previewText && !previewLoading && (
                          <MarkdownPreview content={previewText} />
                        )}
                        {!previewText && !previewLoading && !previewError && (
                          <p className="py-8 text-center text-sm text-text-tertiary">
                            Click to see your draft merged with this template.
                          </p>
                        )}
                      </div>

                      {/* Apply button */}
                      {previewText && !previewLoading && (
                        <div className="border-t border-border-light px-4 py-3">
                          <button
                            type="button"
                            onClick={handleApply}
                            className="flex w-full items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-green-700"
                          >
                            <Check className="h-4 w-4" aria-hidden />
                            Apply to editor
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <>
                  {/* Default: formatted view of editor content */}
                  <div className="flex items-center gap-2 border-b border-border-light px-4 py-2">
                    <BookOpen className="h-3.5 w-3.5 text-text-secondary" aria-hidden />
                    <span className="text-xs font-medium text-text-secondary">Formatted view</span>
                  </div>
                  <div className="flex-1 overflow-y-auto p-4">
                    <MarkdownPreview content={instructions ?? ''} />
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
