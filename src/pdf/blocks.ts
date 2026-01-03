// src/pdf/blocks.ts
// Group lines within each column into blocks, then classify blocks structurally.

import type { PdfBlock, PdfBlockType, PdfColumn, PdfLine, PdfExcludeReason } from './types';
import { bboxUnion, median, stableSortBy } from './utils';

type BlockBuildOpts = {
  pageIndex: number;
  columnIndex: number;
  columnX0n: number;
  columnX1n: number;
  bodyFontSize: number;
};

function mkBBoxFromLine(l: PdfLine) {
  return { x0: l.x0n, y0: l.y0n, x1: l.x1n, y1: l.y1n };
}

function computeMedianLineGap(lines: PdfLine[]): number {
  if (lines.length < 2) return 0.02;
  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1];
    const cur = lines[i];
    const gap = cur.y0n - prev.y1n;
    if (gap > 0) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  return Math.max(0.005, median(gaps) || 0.02);
}

function isHeadingLike(blockLines: PdfLine[], bodyFontSize: number): boolean {
  if (!blockLines.length) return false;
  if (blockLines.length > 3) return false;
  const fonts = blockLines.map((l) => l.fontSize).filter((n) => n > 0).sort((a, b) => a - b);
  const f = fonts.length ? median(fonts) : 0;
  if (!f || !bodyFontSize) return false;
  const larger = f >= bodyFontSize * 1.15;
  // Heading is often short-ish and not full width.
  const w = Math.max(...blockLines.map((l) => l.x1n)) - Math.min(...blockLines.map((l) => l.x0n));
  return larger && w < 0.9;
}

function hangingIndentScore(lines: PdfLine[]): number {
  if (lines.length < 2) return 0;
  const xFirst = lines[0].x0n;
  const xRest = lines.slice(1).map((l) => l.x0n);
  const medRest = median(xRest.sort((a, b) => a - b));
  const indent = medRest - xFirst;
  return indent;
}

function isListItemLike(lines: PdfLine[]): boolean {
  // Structural list detection: hanging indent and relatively short first line.
  const indent = hangingIndentScore(lines);
  if (indent < 0.02) return false;
  if (lines.length < 2) return false;
  const firstW = lines[0].x1n - lines[0].x0n;
  const restW = median(lines.slice(1).map((l) => l.x1n - l.x0n).sort((a, b) => a - b));
  return firstW < restW;
}

function looksTabular(lines: PdfLine[]): boolean {
  // Structural table heuristic: many lines with 3+ "cells" aligned.
  const tabLines = lines.filter((l) => l.approxCellCount >= 3);
  if (tabLines.length < Math.max(3, Math.ceil(lines.length * 0.6))) return false;
  // Alignment check: cell centers roughly stable.
  const first = tabLines[0].cellXs;
  if (first.length < 3) return true;
  let aligned = 0;
  for (const l of tabLines.slice(1, Math.min(6, tabLines.length))) {
    const xs = l.cellXs;
    const m = Math.min(xs.length, first.length);
    let ok = 0;
    for (let i = 0; i < m; i++) {
      if (Math.abs(xs[i] - first[i]) <= 0.04) ok++;
    }
    if (ok >= Math.max(2, Math.floor(m * 0.6))) aligned++;
  }
  return aligned >= 2;
}

function looksFigureInternal(lines: PdfLine[], colX0n: number, colX1n: number): boolean {
  // Structural figure-internal heuristic: lots of short, scattered lines not aligned to column left.
  const colW = colX1n - colX0n;
  const short = lines.filter((l) => (l.x1n - l.x0n) < Math.max(0.12, colW * 0.35));
  if (short.length < Math.max(3, Math.ceil(lines.length * 0.6))) return false;
  const leftAligned = lines.filter((l) => Math.abs(l.x0n - colX0n) <= 0.02);
  if (leftAligned.length >= Math.ceil(lines.length * 0.5)) return false;
  return true;
}

function looksDisplayEquation(lines: PdfLine[], colX0n: number, colX1n: number, medianGap: number): boolean {
  // Layout-only: centered + isolated + short width.
  const colMid = (colX0n + colX1n) / 2;
  const colW = colX1n - colX0n;
  const centered = lines.every((l) => {
    const xMid = (l.x0n + l.x1n) / 2;
    return Math.abs(xMid - colMid) <= Math.max(0.03, colW * 0.08);
  });
  if (!centered) return false;
  const w = Math.max(...lines.map((l) => l.x1n)) - Math.min(...lines.map((l) => l.x0n));
  if (w > colW * 0.7) return false;
  // Multi-line centered blocks are more likely equations.
  if (lines.length >= 2) return true;
  // Single-line: require strong isolation (caller provides medianGap; we will require bigger gaps via block split rule).
  return true;
}

function joinBlockText(lines: PdfLine[]): string {
  return lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
}

export function buildAndClassifyBlocks(column: PdfColumn, opts: { bodyFontSize: number }): PdfBlock[] {
  const lines = column.lines;
  if (!lines.length) return [];

  const medianGap = computeMedianLineGap(lines);
  const blocks: PdfBlock[] = [];

  let current: PdfLine[] = [];

  const flush = () => {
    if (!current.length) return;
    let bb = mkBBoxFromLine(current[0]);
    for (let i = 1; i < current.length; i++) bb = bboxUnion(bb, mkBBoxFromLine(current[i]));

    const text = joinBlockText(current);
    if (!text) {
      current = [];
      return;
    }

    // Classification (purely structural)
    let type: PdfBlockType = 'Paragraph';
    let included = true;
    let reason: PdfExcludeReason | undefined;
    let confidence = 0.9;

    const headingLike = isHeadingLike(current, opts.bodyFontSize);
    const listLike = isListItemLike(current);

    // Exclusions first.
    if (looksTabular(current)) {
      type = 'TableInternal';
      included = false;
      reason = 'TABLE_INTERNAL';
      confidence = 0.95;
    } else if (looksFigureInternal(current, column.x0n, column.x1n)) {
      type = 'FigureInternal';
      included = false;
      reason = 'FIGURE_INTERNAL';
      confidence = 0.9;
    } else if (!headingLike && !listLike && looksDisplayEquation(current, column.x0n, column.x1n, medianGap)) {
      type = 'DisplayEquation';
      included = false;
      reason = 'DISPLAY_EQUATION';
      confidence = 0.7;
    }

    // If still included, decide narrative subtype.
    if (included) {
      if (headingLike) type = 'Heading';
      else if (listLike) type = 'ListItem';
      else type = 'Paragraph';
    }

    // Ambiguity policy: if low confidence, exclude.
    if (included && confidence < 0.55) {
      included = false;
      reason = 'AMBIGUOUS_NON_NARRATIVE';
      type = 'MarginDecorative';
    }

    blocks.push({
      pageIndex: column.pageIndex,
      columnIndex: column.columnIndex,
      blockIndex: blocks.length,
      type,
      bbox: bb,
      x0n: bb.x0,
      x1n: bb.x1,
      y0n: bb.y0,
      y1n: bb.y1,
      text,
      lines: current,
      included,
      excludeReason: reason,
      confidence,
    });

    current = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!current.length) {
      current = [ln];
      continue;
    }

    const prev = current[current.length - 1];
    const gap = ln.y0n - prev.y1n;
    const indentDelta = Math.abs(ln.x0n - current[0].x0n);

    const newBlockByGap = gap > Math.max(medianGap * 1.8, 0.02);
    const newBlockByIndent = indentDelta > 0.08;

    if (newBlockByGap || newBlockByIndent) {
      flush();
      current = [ln];
    } else {
      current.push(ln);
    }
  }

  flush();

  return blocks;
}
