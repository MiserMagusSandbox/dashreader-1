// src/pdf/flatten.ts
// Flatten included blocks into a narrative text stream suitable for RSVP.
// Also produces token meta so anchoring can remain within (page,column,block).

import type { PdfBlock, PdfNarrativeIndex } from './types';
import { tokenizeForEngine } from '../rsvp-engine';
import { normaliseTokenKey } from './utils';

export function flattenNarrative(blocksInReadingOrder: PdfBlock[]): {
  fullText: string;
  tokens: string[];
  tokenMeta: Array<{ pageIndex: number; columnIndex: number; blockIndex: number }>;
} {
  const segments: Array<{
    text: string;
    meta?: { pageIndex: number; columnIndex: number; blockIndex: number };
  }> = [];

  for (const b of blocksInReadingOrder) {
    if (!b.included) continue;
    if (segments.length) segments.push({ text: '\n\n' });
    const blockText = b.type === 'Heading'
      ? `[H${Math.min(6, Math.max(1, b.headingLevel ?? 3))}]${b.text}`
      : b.text;
    segments.push({
      text: blockText,
      meta: { pageIndex: b.pageIndex, columnIndex: b.columnIndex, blockIndex: b.blockIndex },
    });
  }

  const fullText = segments.map((s) => s.text).join('').trim();
  const tokens: string[] = [];
  const tokenMeta: Array<{ pageIndex: number; columnIndex: number; blockIndex: number }> = [];

  for (const seg of segments) {
    const segTokens = tokenizeForEngine(seg.text);
    for (const t of segTokens) {
      tokens.push(t);
      if (seg.meta) tokenMeta.push(seg.meta);
      else tokenMeta.push({ pageIndex: -1, columnIndex: -1, blockIndex: -1 });
    }
  }

  return { fullText, tokens, tokenMeta };
}

export function attachBlockTokenRanges(index: PdfNarrativeIndex): void {
  // Assign token ranges by scanning tokenMeta.
  const blockMap = new Map<string, { start: number; end: number }>();
  for (let i = 0; i < index.tokenMeta.length; i++) {
    const m = index.tokenMeta[i];
    const k = `${m.pageIndex}:${m.columnIndex}:${m.blockIndex}`;
    const ex = blockMap.get(k);
    if (!ex) blockMap.set(k, { start: i, end: i + 1 });
    else ex.end = i + 1;
  }

  for (const p of index.pages) {
    for (const b of p.blocks) {
      const k = `${b.pageIndex}:${b.columnIndex}:${b.blockIndex}`;
      const r = blockMap.get(k);
      if (!r) continue;
      b.tokenRange = { start: r.start, end: r.end };
      const slice = index.tokens.slice(r.start, r.end);
      b.tokens = slice;
      b.tokenKeys = slice.map(normaliseTokenKey);
    }
  }
}
