// src/pdf/exclusions.ts
// Structural exclusions: headers/footers, margins, repetition-based stamps.
// No vocabulary-based filtering.

import type { PdfLine } from './types';
import { normaliseForRepetition, quantize } from './utils';

export type LineExclusion = {
  lineId: string;
  reason: 'HEADER_FOOTER' | 'MARGIN_DECORATIVE' | 'REPEATED_STAMP';
};

function lineKey(pageIndex: number, idx: number): string {
  return `${pageIndex}:${idx}`;
}

type SignatureOcc = { key: string; count: number };

export function detectRepeatedHeaderFooterLines(pages: { pageIndex: number; lines: PdfLine[] }[]): Set<string> {
  const counts = new Map<string, number>();

  for (const p of pages) {
    p.lines.forEach((l, idx) => {
      // candidate bands only
      if (!(l.yMid < 0.08 || l.yMid > 0.92)) return;
      const sig = normaliseForRepetition(l.text);
      if (!sig || sig.length < 3) return;

      const yBand = l.yMid < 0.08 ? 'H' : 'F';
      const qx = Math.round(quantize((l.x0n + l.x1n) / 2, 0.02) * 100);
      const qy = yBand;
      const key = `${yBand}|${qx}|${sig}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    });
  }

  const repeatedKeys = new Set<string>();
  for (const [k, c] of counts.entries()) {
    if (c >= 2) repeatedKeys.add(k);
  }

  const out = new Set<string>();
  for (const p of pages) {
    p.lines.forEach((l, idx) => {
      if (!(l.yMid < 0.08 || l.yMid > 0.92)) return;
      const sig = normaliseForRepetition(l.text);
      if (!sig || sig.length < 3) return;
      const yBand = l.yMid < 0.08 ? 'H' : 'F';
      const qx = Math.round(quantize((l.x0n + l.x1n) / 2, 0.02) * 100);
      const key = `${yBand}|${qx}|${sig}`;
      if (repeatedKeys.has(key)) out.add(lineKey(p.pageIndex, idx));
    });
  }
  return out;
}

export function detectMarginDecorativeLines(lines: PdfLine[], columnRanges: Array<{ x0n: number; x1n: number }>): Set<string> {
  const out = new Set<string>();

  // Main content x-range as union of columns.
  const x0 = Math.min(...columnRanges.map((c) => c.x0n));
  const x1 = Math.max(...columnRanges.map((c) => c.x1n));
  const pad = 0.03; // allow small drift

  lines.forEach((l, idx) => {
    const w = l.x1n - l.x0n;
    if (w <= 0) return;

    const outside = (l.x1n < (x0 - pad)) || (l.x0n > (x1 + pad));
    const nearEdge = l.x0n < 0.05 || l.x1n > 0.95;
    const veryShort = w < 0.18;
    const midBand = l.yMid > 0.08 && l.yMid < 0.92;

    if (midBand && (outside || (nearEdge && veryShort))) {
      out.add(lineKey(l.pageIndex, idx));
    }
  });

  return out;
}

export function makeLineId(pageIndex: number, lineIndex: number): string {
  return lineKey(pageIndex, lineIndex);
}
