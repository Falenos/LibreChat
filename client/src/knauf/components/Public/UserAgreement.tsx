import { useCallback, useMemo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import { ArrowLeft } from 'lucide-react';
import remarkGfm from 'remark-gfm';
import { Link, useNavigate } from 'react-router-dom';
import { useGetStartupConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';

function joinModalContent(modalContent: string | string[] | undefined): string {
  if (typeof modalContent === 'string') {
    return modalContent;
  }

  if (Array.isArray(modalContent)) {
    return modalContent.join('\n');
  }

  return '';
}

function normalizeAgreementMarkdown(content: string): string {
  const trimmed = content.trim();
  if (trimmed === '') {
    return '';
  }

  return trimmed
    .split('\n')
    .map((line, index) => {
      const text = line.trim();
      if (index === 0 && text !== '' && !text.startsWith('#')) {
        return `# ${text}`;
      }

      const boldSection = text.match(/^\*\*(\d+)\.\s+(.+?)\*\*$/);
      if (boldSection) {
        return `## ${boldSection[1]}. ${boldSection[2]}`;
      }

      const section = text.match(/^(\d+)\.\s+(.+)$/);
      if (section) {
        return `## ${section[1]}. ${section[2]}`;
      }

      const dotBullet = text.match(/^·\s+(.+)$/);
      if (dotBullet) {
        return `- ${dotBullet[1]}`;
      }

      return line;
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

const markdownComponents: Components = {
  h1: ({ node: _node, children, ...props }) => (
    <h1 className="mb-8 text-3xl font-semibold tracking-normal text-text-primary" {...props}>
      {children}
    </h1>
  ),
  h2: ({ node: _node, children, ...props }) => (
    <h2 className="mb-3 mt-9 text-xl font-semibold tracking-normal text-text-primary" {...props}>
      {children}
    </h2>
  ),
  p: ({ node: _node, ...props }) => (
    <p className="my-4 text-base leading-7 text-text-primary" {...props} />
  ),
  ul: ({ node: _node, ...props }) => (
    <ul
      className="my-5 list-disc space-y-2 pl-6 text-base leading-7 text-text-primary"
      {...props}
    />
  ),
  ol: ({ node: _node, ...props }) => (
    <ol
      className="my-5 list-decimal space-y-2 pl-6 text-base leading-7 text-text-primary"
      {...props}
    />
  ),
  li: ({ node: _node, ...props }) => <li className="pl-1 text-text-primary" {...props} />,
  a: ({ node: _node, children, ...props }) => (
    <a
      className="font-medium text-blue-600 underline underline-offset-2 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300"
      rel="noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
  strong: ({ node: _node, ...props }) => (
    <strong className="font-semibold text-text-primary" {...props} />
  ),
};

export default function UserAgreement() {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { data: config, isFetching } = useGetStartupConfig();

  const termsOfService = config?.interface?.termsOfService;
  const content = useMemo(
    () => normalizeAgreementMarkdown(joinModalContent(termsOfService?.modalContent)),
    [termsOfService?.modalContent],
  );
  const handleBack = useCallback(() => {
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }

    navigate('/login?redirect=false');
  }, [navigate]);

  return (
    <main className="min-h-dvh bg-surface-secondary text-text-primary">
      <header className="border-b border-border-light bg-surface-primary px-4 py-3">
        <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4">
          <button
            type="button"
            onClick={handleBack}
            className="inline-flex min-h-10 items-center gap-2 rounded-md px-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-tertiary hover:text-text-primary"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
            {localize('com_ui_back')}
          </button>
          <img src="/assets/knauf-logo.png" alt="Knauf" className="h-8 w-auto object-contain" />
          <Link
            to="/login?redirect=false"
            className="min-h-10 rounded-md px-2 py-2 text-sm font-medium text-text-secondary transition-colors hover:bg-surface-tertiary hover:text-text-primary"
          >
            {localize('com_auth_login')}
          </Link>
        </div>
      </header>
      <article className="mx-auto w-full max-w-3xl px-5 py-8 sm:px-6 sm:py-12">
        <div className="rounded-lg border border-border-light bg-surface-primary px-5 py-7 shadow-sm sm:px-8 sm:py-9">
          {content !== '' ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {content}
            </ReactMarkdown>
          ) : (
            <p>{isFetching ? localize('com_ui_loading') : localize('com_ui_no_terms_content')}</p>
          )}
        </div>
      </article>
    </main>
  );
}
