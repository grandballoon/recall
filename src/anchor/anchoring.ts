/* Putting a check back on its span when the stored offsets no longer fit.
 *
 * CM6 maps a live decoration through every edit, so this is not the everyday
 * path — it is the reload path, and the repair path for a note edited while
 * the plugin was not watching. Ported from `findQuote` in the shared UI so
 * both surfaces put a check back in the same place.
 */

export interface Anchor {
  /** Offsets into the document as it was when the check was recorded. */
  from: number;
  to: number;
  /** The text the check was written about. */
  quote: string;
}

export type Resolution =
  | { kind: 'exact'; from: number; to: number }
  | { kind: 'quote'; from: number; to: number }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'absent' };

export interface QuoteMatch {
  count: number;
  from: number;
  to: number;
}

/** Whitespace is normalised on both sides: a quote recorded from a selection
 *  renders block boundaries as newlines the source does not carry. `points`
 *  maps each kept character back to where it sits in the document. */
function textIndex(doc: string): { norm: string; points: number[] } {
  const points: number[] = [];
  let norm = '';
  let gap = false;
  for (let i = 0; i < doc.length; i++) {
    const ch = doc[i]!;
    if (/\s/.test(ch)) {
      gap = norm.length > 0;
      continue;
    }
    if (gap) {
      norm += ' ';
      points.push(i);
      gap = false;
    }
    norm += ch;
    points.push(i);
  }
  return { norm, points };
}

export function normaliseQuote(quote: string): string {
  return String(quote ?? '').replace(/\s+/g, ' ').trim();
}

/** A check is put back only where its quote appears exactly once.
 *
 *  An ambiguous or absent quote is left alone and reported, because putting a
 *  check on the wrong sentence is worse than leaving it unplaced. */
export function findQuote(doc: string, quote: string): QuoteMatch {
  const needle = normaliseQuote(quote);
  if (needle.length < 3) return { count: 0, from: -1, to: -1 };

  const { norm, points } = textIndex(doc);
  let count = 0;
  let at = -1;
  let from = 0;
  let i: number;
  while ((i = norm.indexOf(needle, from)) !== -1) {
    count++;
    if (count === 1) at = i;
    from = i + 1;
  }
  if (count !== 1) return { count, from: -1, to: -1 };

  const first = points[at];
  const last = points[at + needle.length - 1];
  if (first === undefined || last === undefined) return { count: 0, from: -1, to: -1 };
  return { count: 1, from: first, to: last + 1 };
}

/** Trusts the stored offsets when the text still standing there is the text
 *  the check was written about, and falls back to the quote when it is not. */
export function resolveAnchor(doc: string, anchor: Anchor): Resolution {
  const { from, to } = anchor;
  const inRange = from >= 0 && to <= doc.length && from < to;
  if (inRange && normaliseQuote(doc.slice(from, to)) === normaliseQuote(anchor.quote)) {
    return { kind: 'exact', from, to };
  }

  const found = findQuote(doc, anchor.quote);
  if (found.count === 1) return { kind: 'quote', from: found.from, to: found.to };
  if (found.count > 1) return { kind: 'ambiguous', count: found.count };
  return { kind: 'absent' };
}
