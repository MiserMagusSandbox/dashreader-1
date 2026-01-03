// src/pdf/exclusions.ts
// Structural exclusions: headers/footers, margins, repetition-based stamps.
// No vocabulary-based filtering.

import type { PdfLine } from './types';
import { median, normaliseForRepetition, quantize } from './utils';

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
      // Slightly wider than 8% to survive PDF crop-box variations.
      if (!(l.yMid < 0.12 || l.yMid > 0.88)) return;
      const sig = normaliseForRepetition(l.text);
      if (!sig || sig.length < 3) return;

      const yBand = l.yMid < 0.12 ? 'H' : 'F';
      // Coarser quantization makes repetition robust to minor renderer/layout variation.
      const qx = Math.round(quantize((l.x0n + l.x1n) / 2, 0.05) * 100);
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
      if (!(l.yMid < 0.12 || l.yMid > 0.88)) return;
      const sig = normaliseForRepetition(l.text);
      if (!sig || sig.length < 3) return;
      const yBand = l.yMid < 0.12 ? 'H' : 'F';
      const qx = Math.round(quantize((l.x0n + l.x1n) / 2, 0.05) * 100);
      const key = `${yBand}|${qx}|${sig}`;
      if (repeatedKeys.has(key)) out.add(lineKey(p.pageIndex, idx));
    });
  }
  return out;
}

export function detectSingletonEdgeHeaderFooterLines(pages: { pageIndex: number; lines: PdfLine[] }[]): Set<string> {
  // Structural per-page header/footer detection for non-repeated page chrome
  // (e.g., a journal logo on page 1 like "Cells").
  //
  // This intentionally uses only geometry:
  // - extreme top/bottom position
  // - short width
  // - misalignment with the dominant body left edge
  const out = new Set<string>();

  for (const p of pages) {
    const lines = p.lines;
    if (!lines.length) continue;

    // Estimate body font-size (mid-band) for small-font footer / boilerplate detection.
    const bodyFonts = lines
      .filter((l) => l.yMid > 0.15 && l.yMid < 0.85)
      .map((l) => l.fontSize)
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    const bodyFont = bodyFonts.length ? median(bodyFonts) : 0;

    // Estimate dominant body-left x0n from wide mid-band lines.
    const bodyCandidates = lines
      .filter((l) => l.yMid > 0.15 && l.yMid < 0.85)
      .filter((l) => (l.x1n - l.x0n) >= 0.35)
      .map((l) => l.x0n)
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 1)
      .sort((a, b) => a - b);

    const bodyLeft = bodyCandidates.length ? median(bodyCandidates) : 0.0;

    for (let idx = 0; idx < lines.length; idx++) {
      const l = lines[idx];
      const w = l.x1n - l.x0n;
      if (!(w > 0)) continue;

      const extremeTop = l.yMid < 0.09;
      const extremeBottom = l.yMid > 0.91;
      if (!(extremeTop || extremeBottom)) continue;

      const smallFont = bodyFont > 0 && Number.isFinite(l.fontSize) && l.fontSize > 0 && l.fontSize <= bodyFont * 0.85;

      // Very wide lines near the *top* edge are likely titles/section headers; keep them.
      // Wide lines near the *bottom* edge are often publication boilerplate; allow exclusion
      // when they are small-font relative to body.
      if (w >= 0.55 && (extremeTop || !smallFont)) continue;

      // If the line's left edge doesn't match the dominant body-left, treat as page chrome.
      // Threshold chosen to tolerate minor drift but still catch logos/running titles.
      const misaligned = Math.abs((l.x0n ?? 0) - bodyLeft) > 0.035;
      if (!misaligned) continue;

      out.add(lineKey(p.pageIndex, idx));
    }
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
