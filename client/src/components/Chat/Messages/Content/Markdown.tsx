import React, { memo, useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { getRemarkPlugins, getRehypePlugins, getMarkdownComponents } from './markdownConfig';
import MarkdownErrorBoundary from './MarkdownErrorBoundary';
import MarkdownBlocks from './MarkdownBlocks';
import { preprocessLaTeX } from '~/utils';
// [knauf] KK20-365 — repair near-miss artifact emissions; see the call site below.
import { normalizeArtifactDirectives } from '~/knauf/utils/normalizeArtifactDirectives';
// End [knauf]
import store from '~/store';

type TContentProps = {
  content: string;
  isLatestMessage: boolean;
};

const Markdown = memo(function Markdown({ content = '', isLatestMessage }: TContentProps) {
  const LaTeXParsing = useRecoilValue<boolean>(store.LaTeXParsing);
  const isInitializing = content === '';

  // [knauf] KK20-365 — normalize before anything parses this string.
  //
  // An artifact reaches the preview panel only if `:::artifact{…}` tokenizes as a
  // `containerDirective`. When the model indents the block, wraps it in a fence, writes an
  // XML tag, splits the opening line, or puts a space after the colons, it does not — and
  // the source is printed into the conversation instead. Nothing catches that: Sandpack
  // never mounts, so `ArtifactRepairButton` sees no error and there is no repair path.
  //
  // This is the right and only mount point: `currentContent` is what `MarkdownBlocks` hands
  // to `splitMarkdownIntoBlocks` *and* to the per-block `ReactMarkdown`, so one call keeps
  // block splitting and rendering agreeing. Runs ahead of `preprocessLaTeX` so the directive
  // is already well-formed before any other rewrite touches the string, and returns its
  // input unchanged when there is nothing to repair.
  const currentContent = useMemo(() => {
    if (isInitializing) {
      return '';
    }
    const normalized = normalizeArtifactDirectives(content);
    return LaTeXParsing ? preprocessLaTeX(normalized) : normalized;
  }, [content, LaTeXParsing, isInitializing]);
  // End [knauf]

  if (isInitializing) {
    return (
      <div className="absolute">
        <p className="relative">
          <span className={isLatestMessage ? 'result-thinking' : ''} />
        </p>
      </div>
    );
  }

  return (
    <MarkdownErrorBoundary content={content} codeExecution={true}>
      <MarkdownBlocks
        content={currentContent}
        remarkPlugins={getRemarkPlugins()}
        rehypePlugins={getRehypePlugins()}
        components={getMarkdownComponents()}
      />
    </MarkdownErrorBoundary>
  );
});
Markdown.displayName = 'Markdown';

export default Markdown;
