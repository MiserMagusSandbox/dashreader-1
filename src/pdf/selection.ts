// src/pdf/selection.ts
// Best-effort mapping from a selected token key to a narrative token index.
// Token-agnostic: matches on normalized token keys and optional context keys.

import type { PdfNarrativeIndex, PdfSelectionContext } from './types';
import { normaliseTokenKey } from './utils';

export function resolveSelectionToTokenIndex(
  index: PdfNarrativeIndex,
  selectionText: string,
  ctx: PdfSelectionContext | null,
  opts?: { contextKeys?: string[] }
): number | null {
  const key = normaliseTokenKey(selectionText);
  if (!key) return null;

  // Prefer block-scoped search (spec: anchors should not be page-global without column context).
  if (ctx) {
    const page = index.pages.find((p) => p.pageIndex === ctx.pageIndex);
    const b = page?.blocks.find((bb) => bb.columnIndex === ctx.columnIndex && bb.blockIndex === ctx.blockIndex);
    if (b?.tokenKeys && b.tokenRange) {
      const cand: number[] = [];
      for (let i = 0; i < b.tokenKeys.length; i++) if (b.tokenKeys[i] === key) cand.push(i);
      if (cand.length === 1) return b.tokenRange.start + cand[0];

      if (cand.length > 1) {
        // Tie-break using the selection's relative vertical position within the block.
        // (Purely geometric; does not depend on token boundaries beyond count.)
        if (Number.isFinite(ctx.yMidN) && (b.y1n - b.y0n) > 1e-6) {
          const frac = Math.max(0, Math.min(1, (ctx.yMidN - b.y0n) / (b.y1n - b.y0n)));
          const approx = Math.round(frac * Math.max(0, b.tokenKeys.length - 1));
          let best = cand[0];
          let bestD = Number.POSITIVE_INFINITY;
          for (const i of cand) {
            const d = Math.abs(i - approx);
            if (d < bestD) { bestD = d; best = i; }
          }
          return b.tokenRange.start + best;
        }

        // Tie-break using optional context keys within a small window.
        const cks = (opts?.contextKeys ?? []).map(normaliseTokenKey).filter(Boolean);
        if (cks.length) {
          const window = 4;
          let bestLocal = cand[0];
          let bestScore = -1e9;
          for (const i of cand) {
            let score = 1;
            for (const ck of cks) {
              let found = false;
              for (let d = 1; d <= window; d++) {
                if (b.tokenKeys[i - d] === ck || b.tokenKeys[i + d] === ck) { found = true; score += 0.25; break; }
              }
              if (!found) score -= 0.05;
            }
            if (score > bestScore) { bestScore = score; bestLocal = i; }
          }
          return b.tokenRange.start + bestLocal;
        }

        // Without context, choose the earliest occurrence within the block.
        return b.tokenRange.start + cand[0];
      }
    }
  }

  // Fallback: page-local search.
  for (let i = 0; i < index.tokens.length; i++) {
    if (normaliseTokenKey(index.tokens[i]) !== key) continue;
    if (ctx && index.tokenMeta[i]?.pageIndex !== ctx.pageIndex) continue;
    return i;
  }
  return null;
}
