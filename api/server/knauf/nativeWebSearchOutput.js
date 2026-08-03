function getFinalWebSearchResponseText(output) {
  if (!Array.isArray(output) || !output.some((item) => item?.type === 'web_search_call')) {
    return '';
  }

  const messages = output.filter((item) => item?.type === 'message');
  const message = messages.findLast((item) => item.phase === 'final_answer') ?? messages.at(-1);
  return (message?.content ?? [])
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function replaceLastTextPart(contentParts, text) {
  if (!Array.isArray(contentParts) || text === '') {
    return contentParts;
  }
  const index = contentParts.findLastIndex((part) => part?.type === 'text');
  if (index < 0) {
    return contentParts;
  }
  return contentParts.with(index, { ...contentParts[index], text });
}

module.exports = { getFinalWebSearchResponseText, replaceLastTextPart };
