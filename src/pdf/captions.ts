// src/pdf/captions.ts
// Structural caption tagging (Figure/Table captions) based on proximity to excluded regions.
// Captions remain included narrative text.

import type { PdfBlock, PdfBlockType } from './types';

function isShortNarrativeBlock(b: PdfBlock): boolean {
  if (!b.included) return false;
  const lineCount = b.lines?.length ?? 0;
  if (lineCount < 1 || lineCount > 4) return false;
  const charLen = (b.text ?? '').length;
  return charLen > 0 && charLen <= 300;
}

function verticalDistance(a: PdfBlock, b: PdfBlock): number {
  if (a.y1n <= b.y0n) return b.y0n - a.y1n;
  if (b.y1n <= a.y0n) return a.y0n - b.y1n;
  return 0;
}

export function tagCaptions(blocks: PdfBlock[]): PdfBlock[] {
  // Operate per page+column order; caller passes blocks already in reading order.
  const out = blocks.map((b) => ({ ...b }));
  for (let i = 0; i < out.length; i++) {
    const b = out[i];
    if (b.type !== 'TableInternal' && b.type !== 'FigureInternal') continue;

    // Look for the nearest included short block immediately above or below in same column.
    const candidates: Array<{ idx: number; dist: number }> = [];
    for (const j of [i - 1, i + 1]) {
      if (j < 0 || j >= out.length) continue;
      const n = out[j];
      if (n.pageIndex !== b.pageIndex || n.columnIndex !== b.columnIndex) continue;
      if (!isShortNarrativeBlock(n)) continue;
      const dist = verticalDistance(n, b);
      if (dist <= 0.04) candidates.push({ idx: j, dist });
    }

    // Prefer the closer one.
    candidates.sort((a, b2) => a.dist - b2.dist);
    const chosen = candidates[0];
    if (!chosen) continue;

    const cap = out[chosen.idx];
    const newType: PdfBlockType = b.type === 'TableInternal' ? 'TableCaption' : 'FigureCaption';
    out[chosen.idx] = { ...cap, type: newType };
  }
  return out;
}
