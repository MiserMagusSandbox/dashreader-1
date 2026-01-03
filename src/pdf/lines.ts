// src/pdf/lines.ts
// Convert raw text items into ordered lines with structural features.

import type { PdfLine, PdfTextItem } from './types';
import { bboxUnion, clamp01, median, stableSortBy } from './utils';
import { estimateLineYToleranceNorm, estimateSpaceThresholdPx } from './extract';

type LineBuilderOpts = {
  pageHeightPx: number;
  bodyFontSize: number;
  // Rotation threshold: anything rotated beyond this is excluded upstream.
  maxRotationAbsRad: number;
};

function mkBBoxFromItem(it: PdfTextItem) {
  return { x0: it.x0n, y0: it.y0n, x1: it.x1n, y1: it.y1n };
}

function mergeLineText(itemsSortedX: PdfTextItem[], spacePx: number): { text: string; approxCellCount: number; cellXs: number[] } {
  let out = '';
  let prevX2 = Number.NEGATIVE_INFINITY;
  const cellCenters: number[] = [];
  let cellCount = 0;

  for (const it of itemsSortedX) {
    const s = String(it.str ?? '').replace(/\s+/g, ' ').trim();
    if (!s) continue;

    const gapPx = it.x - prevX2;
    const needSpace = out.length > 0 && Number.isFinite(prevX2) && gapPx > spacePx;
    if (needSpace) out += ' ';
    out += s;
    prevX2 = Math.max(prevX2, it.x2);
  }

  // Approximate "cells" by clustering x0 positions with large gaps.
  // This is structural (uses geometry), used for table detection.
  const xs = itemsSortedX.map((it) => clamp01((it.x0n + it.x1n) / 2)).sort((a, b) => a - b);
  const centers: number[] = [];
  const gapN = 0.06; // ~6% page width is a large intra-line gap.
  for (let i = 0; i < xs.length; i++) {
    if (i === 0 || (xs[i] - xs[i - 1]) > gapN) {
      centers.push(xs[i]);
    } else {
      centers[centers.length - 1] = (centers[centers.length - 1] + xs[i]) / 2;
    }
  }
  cellCount = Math.max(1, centers.length);
  for (const c of centers) cellCenters.push(c);

  return { text: out.trim(), approxCellCount: cellCount, cellXs: cellCenters };
}

export function buildLines(pageIndex: number, items: PdfTextItem[], opts: LineBuilderOpts): PdfLine[] {
  if (!items.length) return [];

  // Keep all items; rotated/watermark text is handled later as a structural exclusion (and logged).
  const kept = items;
  if (!kept.length) return [];

  const yTol = estimateLineYToleranceNorm(opts.bodyFontSize, opts.pageHeightPx);
  const spacePx = estimateSpaceThresholdPx(opts.bodyFontSize);

  // Sort by yMid, then x.
  const sorted = stableSortBy(kept, (it) => (it.y0n * 10_000) + it.x0n);

  type LineAcc = {
    items: PdfTextItem[];
    yMid: number;
    fontSizes: number[];
  };

  const lines: LineAcc[] = [];

  for (const it of sorted) {
    const yMid = (it.y0n + it.y1n) / 2;
    const font = it.fontSize;

    let placed = false;
    // Deterministic placement: first matching line by insertion order.
    for (const ln of lines) {
      if (Math.abs(ln.yMid - yMid) <= yTol) {
        ln.items.push(it);
        ln.fontSizes.push(font);
        ln.yMid = (ln.yMid + yMid) / 2;
        placed = true;
        break;
      }
    }
    if (!placed) {
      lines.push({ items: [it], yMid, fontSizes: [font] });
    }
  }

  const out: PdfLine[] = [];
  for (const ln of lines) {
    const itemsX = stableSortBy(ln.items, (it) => it.x0n);
    const textInfo = mergeLineText(itemsX, spacePx);
    if (!textInfo.text) continue;

    // bbox
    let bb = mkBBoxFromItem(itemsX[0]);
    for (let i = 1; i < itemsX.length; i++) bb = bboxUnion(bb, mkBBoxFromItem(itemsX[i]));

    const fonts = ln.fontSizes.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
    const fontSize = fonts.length ? median(fonts) : 0;

    const maxAbsRotationRad = Math.max(...itemsX.map((it) => Math.abs(it.rotationRad)));
    const rotatedCount = itemsX.filter((it) => Math.abs(it.rotationRad) > opts.maxRotationAbsRad).length;
    const rotatedFraction = itemsX.length ? (rotatedCount / itemsX.length) : 0;

    out.push({
      pageIndex,
      items: itemsX,
      text: textInfo.text,
      bbox: bb,
      x0n: bb.x0,
      x1n: bb.x1,
      y0n: bb.y0,
      y1n: bb.y1,
      yMid: ln.yMid,
      fontSize,
      maxAbsRotationRad,
      rotatedFraction,
      approxCellCount: textInfo.approxCellCount,
      cellXs: textInfo.cellXs,
    });
  }

  // Order lines top-to-bottom.
  return out.sort((a, b) => a.yMid - b.yMid || a.x0n - b.x0n);
}
