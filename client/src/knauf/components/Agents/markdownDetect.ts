/** Heuristic: does the text look like it contains markdown formatting? */
export function looksLikeMarkdown(text: string): boolean {
  if (!text || text.trim().length === 0) return false;
  // Check for # to ### headings (not ####+), **bold**, bullet lists (- or *), ordered lists (1.)
  return /^#{1,3}(?!#)\s|\*\*[^*]+\*\*|^[-*]\s|^\d+\.\s/m.test(text);
}
