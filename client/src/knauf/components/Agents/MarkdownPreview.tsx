/** Lightweight markdown renderer for the agent builder's formatted view. */
import { memo } from 'react';
import remarkGfm from 'remark-gfm';
import ReactMarkdown from 'react-markdown';
import { cn } from '~/utils';

const MarkdownPreview = memo(function MarkdownPreview({
  content,
  className,
}: Readonly<{
  content: string;
  className?: string;
}>) {
  if (!content.trim()) {
    return (
      <p className={cn('text-sm italic text-text-tertiary', className)}>
        No instructions yet.
      </p>
    );
  }

  return (
    <div
      className={cn(
        // Prose-like styling that fits the sidebar width. Uses Tailwind's
        // prose utilities where available, falls back to manual spacing.
        'knauf-md-preview text-sm leading-relaxed text-text-primary',
        // Scope markdown element styles
        '[&_h2]:mb-1.5 [&_h2]:mt-4 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-text-primary',
        '[&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-sm [&_h3]:font-medium [&_h3]:text-text-primary',
        '[&_p]:mb-2 [&_p]:leading-relaxed',
        '[&_ul]:mb-2 [&_ul]:ml-4 [&_ul]:list-disc [&_ul]:space-y-0.5',
        '[&_ol]:mb-2 [&_ol]:ml-4 [&_ol]:list-decimal [&_ol]:space-y-0.5',
        '[&_li]:text-sm [&_li]:leading-relaxed',
        '[&_strong]:font-semibold',
        '[&_code]:rounded [&_code]:bg-surface-tertiary [&_code]:px-1 [&_code]:py-0.5 [&_code]:text-xs',
        '[&_blockquote]:border-l-2 [&_blockquote]:border-border-medium [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-text-secondary',
        // First heading shouldn't have top margin
        '[&_:first-child]:mt-0',
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
    </div>
  );
});

export default MarkdownPreview;
