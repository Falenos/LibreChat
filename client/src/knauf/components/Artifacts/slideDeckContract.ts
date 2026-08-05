type ArtifactSemanticError = {
  title: string;
  message: string;
  path: string;
};

/** Detect slide decks that compile but cannot navigate, render, or export correctly. */
export function getSlideDeckContractError(
  source: string | undefined,
): ArtifactSemanticError | null {
  if (!source || !source.includes('data-knauf-export-pages')) {
    return null;
  }
  if (source.includes("from '/knauf/slides'") || source.includes('from "/knauf/slides"')) {
    return null;
  }

  const failures: string[] = [];
  if (/data-knauf-export-pages(?:\s|>)/.test(source)) {
    failures.push('data-knauf-export-pages has no numeric value');
  }
  if (!/<(?:button|Button)\b[^>]*data-knauf-export-next/.test(source)) {
    failures.push('multi-page export has no data-knauf-export-next control');
  }
  if (/display\s*:\s*['"]none['"]/.test(source)) {
    failures.push('one or more slides are permanently hidden with display: none');
  }
  if (/\[[^\]]+\]\(https?:\/\//.test(source)) {
    failures.push('Markdown links were inserted into TSX instead of rendered links');
  }

  if (failures.length === 0) {
    return null;
  }

  return {
    title: 'Slide deck contract failed',
    message:
      failures.join('; ') +
      ". Rebuild the deck with `import { KnaufSlideDeck } from '/knauf/slides';` and pass all slides as data so navigation, theming, and PDF/PNG export remain platform-owned.",
    path: '/App.tsx',
  };
}
