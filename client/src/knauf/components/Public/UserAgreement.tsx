import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import MarkdownLite from '~/components/Chat/Messages/Content/MarkdownLite';
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

export default function UserAgreement() {
  const localize = useLocalize();
  const { data: config, isFetching } = useGetStartupConfig();

  const termsOfService = config?.interface?.termsOfService;
  const content = useMemo(
    () => joinModalContent(termsOfService?.modalContent),
    [termsOfService?.modalContent],
  );

  return (
    <main className="min-h-dvh bg-surface-primary text-text-primary">
      <header className="border-b border-border-medium px-6 py-4">
        <div className="mx-auto flex w-full max-w-5xl items-center justify-between gap-4">
          <Link
            to="/login?redirect=false"
            className="text-sm font-semibold text-text-primary hover:underline"
          >
            KARL
          </Link>
          <Link
            to="/login?redirect=false"
            className="text-sm text-text-secondary underline underline-offset-2"
          >
            {localize('com_auth_login')}
          </Link>
        </div>
      </header>
      <article className="mx-auto w-full max-w-5xl px-6 py-8 sm:py-10">
        <div className="prose w-full max-w-none dark:prose-invert prose-headings:text-text-primary prose-p:text-text-primary prose-li:text-text-primary prose-a:text-green-600 dark:prose-a:text-green-500">
          {content !== '' ? (
            <MarkdownLite content={content} />
          ) : (
            <p>{isFetching ? localize('com_ui_loading') : localize('com_ui_no_terms_content')}</p>
          )}
        </div>
      </article>
    </main>
  );
}
