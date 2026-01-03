// src/pdf/columns.ts
// Infer explicit columns from line geometry. No vocabulary heuristics.

import type { PdfColumn, PdfLine } from './types';
import { clamp01, percentile, stableSortBy } from './utils';

type ColumnInference = {
  boundaries: number[]; // normalized x boundaries (0..1) excluding 0/1
};

function inferBoundariesFromGaps(xMins: number[]): ColumnInference {
  const xs = xMins.filter((n) => n >= 0 && n <= 1).sort((a, b) => a - b);
  if (xs.length < 25) return { boundaries: [] };

  // Find large gaps in the left-edge distribution (classic two-column layout has a big gap).
  const gaps: Array<{ i: number; gap: number }> = [];
  for (let i = 1; i < xs.length; i++) {
    gaps.push({ i, gap: xs[i] - xs[i - 1] });
  }
  gaps.sort((a, b) => b.gap - a.gap);

  const boundaries: number[] = [];
  const minGap = 0.12; // 12% of page width indicates separate columns.

  for (const g of gaps) {
    if (g.gap < minGap) break;

    const leftCount = g.i;
    const rightCount = xs.length - g.i;
    if (leftCount < 10 || rightCount < 10) continue;

    const boundary = clamp01((xs[g.i - 1] + xs[g.i]) / 2);
    boundaries.push(boundary);
    break; // start with 2-column support; extend later if needed.
  }

  return { boundaries: boundaries.sort((a, b) => a - b) };
}

function inferBoundaryByKMeans2(xMins: number[]): number | null {
  const xs = xMins.filter((n) => n >= 0 && n <= 1).sort((a, b) => a - b);
  if (xs.length < 40) return null;

  // Deterministic 1D 2-means.
  let c1 = percentile(xs, 0.25);
  let c2 = percentile(xs, 0.75);
  if (!Number.isFinite(c1) || !Number.isFinite(c2)) return null;
  if (c2 < c1) [c1, c2] = [c2, c1];

  for (let iter = 0; iter < 8; iter++) {
    const g1: number[] = [];
    const g2: number[] = [];
    for (const x of xs) {
      (Math.abs(x - c1) <= Math.abs(x - c2) ? g1 : g2).push(x);
    }
    if (g1.length < 12 || g2.length < 12) return null;
    c1 = g1.reduce((a, b) => a + b, 0) / g1.length;
    c2 = g2.reduce((a, b) => a + b, 0) / g2.length;
    if (c2 < c1) [c1, c2] = [c2, c1];
  }

  const sep = c2 - c1;
  if (sep < 0.18) return null;

  // Prefer an actual gap between clusters when present.
  const split = (c1 + c2) / 2;
  const left = xs.filter((x) => x <= split);
  const right = xs.filter((x) => x > split);
  if (left.length < 12 || right.length < 12) return null;
  const leftMax = left[left.length - 1];
  const rightMin = right[0];
  const gap = rightMin - leftMax;
  const boundary = gap >= 0.05 ? (leftMax + rightMin) / 2 : split;
  return clamp01(boundary);
}

export function inferColumns(pageIndex: number, lines: PdfLine[]): PdfColumn[] {
  if (!lines.length) return [{ pageIndex, columnIndex: 0, x0n: 0, x1n: 1, lines: [] }];

  // Use only likely-body lines (exclude extreme top/bottom and very short widths).
  const candidates = lines.filter((l) => {
    const h = l.y1n - l.y0n;
    const w = l.x1n - l.x0n;
    if (w < 0.25) return false;
    if (h <= 0) return false;
    if (l.yMid < 0.08 || l.yMid > 0.92) return false;
    return true;
  });
  const xMins = candidates.map((l) => clamp01(l.x0n));
  let inf = inferBoundariesFromGaps(xMins);
  if (!inf.boundaries.length) {
    const km = inferBoundaryByKMeans2(xMins);
    if (km !== null) inf = { boundaries: [km] };
  }
  const bounds = [0, ...inf.boundaries, 1];

  const cols: PdfColumn[] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    cols.push({
      pageIndex,
      columnIndex: i,
      x0n: bounds[i],
      x1n: bounds[i + 1],
      lines: [],
    });
  }

  for (const ln of lines) {
    const xMid = (ln.x0n + ln.x1n) / 2;
    let chosen = 0;
    for (let i = 0; i < cols.length; i++) {
      if (xMid >= cols[i].x0n && xMid <= cols[i].x1n) {
        chosen = i;
        break;
      }
    }
    // If line midpoint is outside any interval, choose nearest column center.
    if (cols.length > 1 && !(xMid >= cols[chosen].x0n && xMid <= cols[chosen].x1n)) {
      let best = 0;
      let bestD = Number.POSITIVE_INFINITY;
      for (let i = 0; i < cols.length; i++) {
        const cMid = (cols[i].x0n + cols[i].x1n) / 2;
        const d = Math.abs(cMid - xMid);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      chosen = best;
    }
    cols[chosen].lines.push(ln);
  }

  for (const c of cols) {
    c.lines = stableSortBy(c.lines, (l) => (l.yMid * 10_000) + l.x0n);
  }

  return cols;
}
