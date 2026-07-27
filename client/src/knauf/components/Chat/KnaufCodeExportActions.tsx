import React, { type RefObject } from 'react';
import { Download, ExternalLink } from 'lucide-react';
import { useLocalize } from '~/hooks';
import { triggerDownload } from '~/utils/downloadFile';

type CodeFile = Readonly<{ extension: string; mime: string; filename?: string }>;

const CODE_FILES: Record<string, CodeFile> = {
  html: { extension: 'html', mime: 'text/html' },
  htm: { extension: 'html', mime: 'text/html' },
  javascript: { extension: 'js', mime: 'text/javascript' },
  js: { extension: 'js', mime: 'text/javascript' },
  jsx: { extension: 'jsx', mime: 'text/javascript' },
  react: { extension: 'jsx', mime: 'text/javascript' },
  typescript: { extension: 'ts', mime: 'text/x-typescript' },
  ts: { extension: 'ts', mime: 'text/x-typescript' },
  tsx: { extension: 'tsx', mime: 'text/x-typescript' },
  css: { extension: 'css', mime: 'text/css' },
  json: { extension: 'json', mime: 'application/json' },
  jsonc: { extension: 'jsonc', mime: 'application/json' },
  markdown: { extension: 'md', mime: 'text/markdown' },
  md: { extension: 'md', mime: 'text/markdown' },
  yaml: { extension: 'yaml', mime: 'application/yaml' },
  yml: { extension: 'yaml', mime: 'application/yaml' },
  xml: { extension: 'xml', mime: 'application/xml' },
  python: { extension: 'py', mime: 'text/x-python' },
  py: { extension: 'py', mime: 'text/x-python' },
  bash: { extension: 'sh', mime: 'application/x-sh' },
  shell: { extension: 'sh', mime: 'application/x-sh' },
  sh: { extension: 'sh', mime: 'application/x-sh' },
  zsh: { extension: 'sh', mime: 'application/x-sh' },
  powershell: { extension: 'ps1', mime: 'application/x-powershell' },
  ps1: { extension: 'ps1', mime: 'application/x-powershell' },
  sql: { extension: 'sql', mime: 'application/sql' },
  java: { extension: 'java', mime: 'text/x-java' },
  c: { extension: 'c', mime: 'text/x-c' },
  cpp: { extension: 'cpp', mime: 'text/x-c++' },
  csharp: { extension: 'cs', mime: 'text/x-csharp' },
  cs: { extension: 'cs', mime: 'text/x-csharp' },
  go: { extension: 'go', mime: 'text/x-go' },
  rust: { extension: 'rs', mime: 'text/x-rust' },
  rs: { extension: 'rs', mime: 'text/x-rust' },
  ruby: { extension: 'rb', mime: 'text/x-ruby' },
  rb: { extension: 'rb', mime: 'text/x-ruby' },
  php: { extension: 'php', mime: 'application/x-php' },
  swift: { extension: 'swift', mime: 'text/x-swift' },
  kotlin: { extension: 'kt', mime: 'text/x-kotlin' },
  kt: { extension: 'kt', mime: 'text/x-kotlin' },
  scala: { extension: 'scala', mime: 'text/x-scala' },
  r: { extension: 'r', mime: 'text/x-r' },
  lua: { extension: 'lua', mime: 'text/x-lua' },
  perl: { extension: 'pl', mime: 'text/x-perl' },
  vue: { extension: 'vue', mime: 'text/plain' },
  svelte: { extension: 'svelte', mime: 'text/plain' },
  dockerfile: { extension: '', mime: 'text/plain', filename: 'Dockerfile' },
  makefile: { extension: '', mime: 'text/plain', filename: 'Makefile' },
  text: { extension: 'txt', mime: 'text/plain' },
  plaintext: { extension: 'txt', mime: 'text/plain' },
  txt: { extension: 'txt', mime: 'text/plain' },
};
const FALLBACK_FILE: CodeFile = { extension: 'txt', mime: 'text/plain' };
const ACTION_CLASS =
  'inline-flex select-none items-center justify-center gap-2 rounded-md px-2 py-1 text-text-secondary transition-all duration-200 ease-out hover:bg-surface-hover hover:text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-border-heavy';

export default function KnaufCodeExportActions({
  lang,
  codeRef,
  iconOnly = false,
  tabIndex,
}: Readonly<{
  lang: string;
  codeRef: RefObject<HTMLElement>;
  iconOnly?: boolean;
  tabIndex?: number;
}>) {
  const localize = useLocalize();
  const isHtml = ['html', 'htm'].includes(lang.toLowerCase());

  const handleDownload = () => {
    const code = codeRef.current?.textContent;
    if (code == null) {
      return;
    }

    const normalizedLang = lang.toLowerCase();
    const file = Object.hasOwn(CODE_FILES, normalizedLang)
      ? CODE_FILES[normalizedLang]
      : FALLBACK_FILE;
    const url = URL.createObjectURL(new Blob([code], { type: `${file.mime};charset=utf-8` }));
    triggerDownload(url, file.filename ?? `generated-code.${file.extension}`);
  };

  const handlePreview = () => {
    const code = codeRef.current?.textContent;
    if (code == null) {
      return;
    }

    const url = URL.createObjectURL(new Blob([code], { type: 'text/html;charset=utf-8' }));
    const previewWindow = window.open('', '_blank');
    if (!previewWindow) {
      URL.revokeObjectURL(url);
      return;
    }

    previewWindow.opener = null;
    const previewDocument = previewWindow.document;
    previewDocument.title = localize('com_ui_preview');
    previewDocument.documentElement.style.height = '100%';
    previewDocument.body.replaceChildren();
    previewDocument.body.style.height = '100%';
    previewDocument.body.style.margin = '0';

    const iframe = previewDocument.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = '0';
    iframe.addEventListener('load', () => URL.revokeObjectURL(url), { once: true });
    iframe.src = url;
    previewDocument.body.appendChild(iframe);
  };

  return (
    <>
      {isHtml && (
        <button
          type="button"
          onClick={handlePreview}
          tabIndex={tabIndex}
          aria-label={localize('com_ui_preview')}
          className={ACTION_CLASS}
        >
          <ExternalLink size={18} aria-hidden="true" />
          {!iconOnly && <span>{localize('com_ui_preview')}</span>}
        </button>
      )}
      <button
        type="button"
        onClick={handleDownload}
        tabIndex={tabIndex}
        aria-label={localize('com_ui_download')}
        className={ACTION_CLASS}
      >
        <Download size={18} aria-hidden="true" />
        {!iconOnly && <span>{localize('com_ui_download')}</span>}
      </button>
    </>
  );
}
