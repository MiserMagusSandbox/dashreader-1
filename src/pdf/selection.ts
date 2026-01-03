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
    if (page) {
      const order = (bb: any) => (bb.columnIndex * 1_000_000) + Math.round(bb.y0n * 10_000) + Math.round(bb.x0n * 1_000) + bb.blockIndex;
      const wanted = ctx.spanBlocks?.length
        ? ctx.spanBlocks
        : [{ columnIndex: ctx.columnIndex, blockIndex: ctx.blockIndex }];

      const blocks = wanted
        .map((w) => page.blocks.find((bb) => bb.columnIndex === w.columnIndex && bb.blockIndex === w.blockIndex))
        .filter((bb): bb is any => !!bb && bb.included && !!bb.tokenKeys && !!bb.tokenRange)
        .sort((a, b) => order(a) - order(b));

      // Ensure primary block is first.
      const primaryIdx = blocks.findIndex((bb) => bb.columnIndex === ctx.columnIndex && bb.blockIndex === ctx.blockIndex);
      if (primaryIdx > 0) {
        const [p] = blocks.splice(primaryIdx, 1);
        blocks.unshift(p);
      }

      const hits: Array<{ b: any; local: number }> = [];
      for (const b of blocks) {
        for (let i = 0; i < b.tokenKeys.length; i++) {
          if (b.tokenKeys[i] === key) hits.push({ b, local: i });
        }
      }

      if (hits.length === 1) return hits[0].b.tokenRange.start + hits[0].local;

      // If the primary block has any hits, restrict to it.
      const primaryHits = hits.filter((h) => h.b.columnIndex === ctx.columnIndex && h.b.blockIndex === ctx.blockIndex);
      const scoped = primaryHits.length ? primaryHits : hits;

      if (scoped.length) {
        const cks = (opts?.contextKeys ?? []).map(normaliseTokenKey).filter(Boolean);
        const window = 4;

        const scoreHit = (h: { b: any; local: number }): number => {
          let score = 0;
          // Prefer blocks containing the selection midpoint.
          const inside = ctx.xMidN >= h.b.x0n && ctx.xMidN <= h.b.x1n && ctx.yMidN >= h.b.y0n && ctx.yMidN <= h.b.y1n;
          score += inside ? 2 : 0;
          // Prefer closer block geometrically (deterministic).
          const dx = ctx.xMidN < h.b.x0n ? (h.b.x0n - ctx.xMidN) : ctx.xMidN > h.b.x1n ? (ctx.xMidN - h.b.x1n) : 0;
          const dy = ctx.yMidN < h.b.y0n ? (h.b.y0n - ctx.yMidN) : ctx.yMidN > h.b.y1n ? (ctx.yMidN - h.b.y1n) : 0;
          score -= (dy * 2 + dx);

          // Tie-break within-block by vertical fraction.
          if (Number.isFinite(ctx.yMidN) && (h.b.y1n - h.b.y0n) > 1e-6) {
            const frac = Math.max(0, Math.min(1, (ctx.yMidN - h.b.y0n) / (h.b.y1n - h.b.y0n)));
            const approx = Math.round(frac * Math.max(0, h.b.tokenKeys.length - 1));
            score -= Math.abs(h.local - approx) * 0.01;
          }

          // Optional context-key scoring.
          if (cks.length) {
            for (const ck of cks) {
              let found = false;
              for (let d = 1; d <= window; d++) {
                if (h.b.tokenKeys[h.local - d] === ck || h.b.tokenKeys[h.local + d] === ck) {
                  found = true;
                  score += 0.25;
                  break;
                }
              }
              if (!found) score -= 0.05;
            }
          }

          return score;
        };

        let best = scoped[0];
        let bestScore = scoreHit(best);
        for (const h of scoped.slice(1)) {
          const s = scoreHit(h);
          if (s > bestScore) {
            best = h;
            bestScore = s;
          }
        }
        return best.b.tokenRange.start + best.local;
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
