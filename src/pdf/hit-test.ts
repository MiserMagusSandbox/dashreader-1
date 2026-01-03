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

function intersects(b: PdfBlock, x0: number, x1: number, y0: number, y1: number): boolean {
  return !(b.x1n < x0 || b.x0n > x1 || b.y1n < y0 || b.y0n > y1);
}

export function hitTestSelection(
  index: PdfNarrativeIndex,
  pageIndex: number,
  xMidN: number,
  yMidN: number,
  rect?: { x0n: number; x1n: number; y0n: number; y1n: number }
): PdfSelectionContext | null {
  const base = hitTestBlock(index, pageIndex, xMidN, yMidN);
  if (!base) return null;
  if (!rect) return base;

  const x0n = Math.min(rect.x0n, rect.x1n);
  const x1n = Math.max(rect.x0n, rect.x1n);
  const y0n = Math.min(rect.y0n, rect.y1n);
  const y1n = Math.max(rect.y0n, rect.y1n);
  if (![x0n, x1n, y0n, y1n].every((n) => Number.isFinite(n))) return base;

  const page = index.pages.find((p) => p.pageIndex === pageIndex);
  if (!page) return base;
  const blocks = page.blocks.filter((b) => b.included);

  const touched = blocks.filter((b) => intersects(b, x0n, x1n, y0n, y1n));
  if (!touched.length) return { ...base, x0n, x1n, y0n, y1n };

  // Primary block: one containing the midpoint if possible, else earliest in reading order.
  let primary = touched.find((b) => xMidN >= b.x0n && xMidN <= b.x1n && yMidN >= b.y0n && yMidN <= b.y1n);
  if (!primary) {
    primary = touched
      .slice()
      .sort((a, b) => a.columnIndex - b.columnIndex || a.y0n - b.y0n || a.x0n - b.x0n || a.blockIndex - b.blockIndex)[0];
  }

  const spanColumns = Array.from(new Set(touched.map((b) => b.columnIndex))).sort((a, b) => a - b);
  const spanBlocks = touched.map((b) => ({ columnIndex: b.columnIndex, blockIndex: b.blockIndex }));

  return {
    pageIndex,
    columnIndex: primary.columnIndex,
    blockIndex: primary.blockIndex,
    xMidN,
    yMidN,
    x0n,
    x1n,
    y0n,
    y1n,
    spanColumns: spanColumns.length > 1 ? spanColumns : undefined,
    spanBlocks: spanBlocks.length > 1 ? spanBlocks : undefined,
  };
}
