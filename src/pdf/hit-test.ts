// src/pdf/hit-test.ts
// Map a (page, x,y) selection point to (column, block) context.

import type { PdfNarrativeIndex, PdfSelectionContext, PdfBlock } from './types';

function pointIn(b: PdfBlock, x: number, y: number): boolean {
  return x >= b.x0n && x <= b.x1n && y >= b.y0n && y <= b.y1n;
}

export function hitTestBlock(
  index: PdfNarrativeIndex,
  pageIndex: number,
  xMidN: number,
  yMidN: number
): PdfSelectionContext | null {
  const page = index.pages.find((p) => p.pageIndex === pageIndex);
  if (!page) return null;
  const blocks = page.blocks.filter((b) => b.included);
  // Prefer the smallest block that contains the point.
  let best: PdfBlock | null = null;
  let bestArea = Number.POSITIVE_INFINITY;
  for (const b of blocks) {
    if (!pointIn(b, xMidN, yMidN)) continue;
    const area = Math.max(1e-6, (b.x1n - b.x0n) * (b.y1n - b.y0n));
    if (area < bestArea) {
      bestArea = area;
      best = b;
    }
  }

  if (!best) {
    // Fallback: nearest block by vertical distance in same page.
    let bestD = Number.POSITIVE_INFINITY;
    for (const b of blocks) {
      const yD = yMidN < b.y0n ? (b.y0n - yMidN) : yMidN > b.y1n ? (yMidN - b.y1n) : 0;
      const xD = xMidN < b.x0n ? (b.x0n - xMidN) : xMidN > b.x1n ? (xMidN - b.x1n) : 0;
      const d = yD * 2 + xD;
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
  }
  if (!best) return null;
  return {
    pageIndex,
    columnIndex: best.columnIndex,
    blockIndex: best.blockIndex,
    xMidN,
    yMidN,
  };
}
