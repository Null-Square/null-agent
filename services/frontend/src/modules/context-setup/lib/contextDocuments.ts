/**
 * The one text helper left from the context-setup module.
 *
 * The organization brief was a three-step wizard that composed a markdown
 * document out of six fields, and the scope brief was a two-step wizard behind
 * a dialog. Both are single controls on their own pages now, so the document
 * builders, the section parser and the answer types they needed are gone.
 */
const normalizeText = (value: string | null | undefined): string => {
  if (typeof value !== 'string') return '';
  return value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
};

export const toNullableText = (value: string | null | undefined): string | null => {
  const normalized = normalizeText(value);
  return normalized.length > 0 ? normalized : null;
};
