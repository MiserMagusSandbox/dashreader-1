// src/pdf/blocks.ts
// Group lines within each column into blocks, then classify blocks structurally.

import type { PdfBlock, PdfBlockType, PdfColumn, PdfLine, PdfExcludeReason } from './types';
import { bboxUnion, median, percentile, stableSortBy } from './utils';

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

function estimateBodyLeftX(lines: PdfLine[], colX0n: number, colX1n: number, bodyFontSize: number): number {
  const cand = lines.filter((l) => l.fontSize > 0 && Math.abs(l.fontSize - bodyFontSize) <= bodyFontSize * 0.12);
  const xs = (cand.length ? cand : lines).map((l) => l.x0n).filter((x) => Number.isFinite(x));
  xs.sort((a, b) => a - b);
  const m = xs.length ? median(xs) : colX0n;
  // Clamp within column bounds.
  return Math.min(Math.max(m, colX0n), colX1n);
}

function estimateBodyLineWidth(lines: PdfLine[], colX0n: number, colX1n: number, bodyFontSize: number): number {
  const colW = colX1n - colX0n;
  const cand = lines.filter((l) => l.fontSize > 0 && Math.abs(l.fontSize - bodyFontSize) <= bodyFontSize * 0.12);
  const ws = (cand.length ? cand : lines)
    .map((l) => (l.x1n - l.x0n))
    .filter((w) => Number.isFinite(w) && w > 0)
    .sort((a, b) => a - b);
  return ws.length ? median(ws) : colW * 0.92;
}

function estimateParagraphIndent(lines: PdfLine[], bodyLeftX: number, bodyFontSize: number): number {
  // Detect common first-line indent purely structurally: x0n - bodyLeftX.
  const cand = lines
    .filter((l) => l.fontSize > 0 && Math.abs(l.fontSize - bodyFontSize) <= bodyFontSize * 0.12)
    .map((l) => l.x0n - bodyLeftX)
    .filter((d) => d > 0.012 && d < 0.10)
    .sort((a, b) => a - b);
  if (cand.length < 8) return 0;
  return median(cand);
}

function isHeadingLike(blockLines: PdfLine[], bodyFontSize: number): boolean {
  if (!blockLines.length) return false;
  if (blockLines.length > 4) return false;
  const fonts = blockLines.map((l) => l.fontSize).filter((n) => n > 0).sort((a, b) => a - b);
  const f = fonts.length ? median(fonts) : 0;
  if (!f || !bodyFontSize) return false;
  const ratio = f / bodyFontSize;
  const larger = ratio >= 1.12;
  const w = Math.max(...blockLines.map((l) => l.x1n)) - Math.min(...blockLines.map((l) => l.x0n));
  // Many headings are not full-width, but allow full-width if the font jump is large.
  const shortish = w < 0.92;
  const strongFontJump = ratio >= 1.28;
  return larger && (shortish || strongFontJump);
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
  // Structural table heuristic (spec §6):
  // - prefer false exclusion to false inclusion
  // - handle both 2-column and 3+ column tables
  const clusterCenters = (l: PdfLine, gapN: number): number[] => {
    const xs = (l.items ?? [])
      .map((it) => (it.x0n + it.x1n) / 2)
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    if (xs.length < 4) return [];
    const centers: number[] = [];
    let cur: number[] = [xs[0]];
    for (let i = 1; i < xs.length; i++) {
      if (xs[i] - xs[i - 1] <= gapN) cur.push(xs[i]);
      else {
        centers.push(cur.reduce((a, b) => a + b, 0) / cur.length);
        cur = [xs[i]];
      }
    }
    centers.push(cur.reduce((a, b) => a + b, 0) / cur.length);
    // De-dup close centers.
    const out: number[] = [];
    for (const c of centers) {
      if (!out.length || Math.abs(out[out.length - 1] - c) > gapN * 0.8) out.push(c);
    }
    return out;
  };

  const tightGap = 0.04;
  const looseGap = 0.055;

  const per = lines.map((l) => ({
    l,
    tight: clusterCenters(l, tightGap),
    loose: l.cellXs?.length ? l.cellXs : clusterCenters(l, looseGap),
  }));

  const strong = per.filter((p) => p.loose.length >= 3);
  if (strong.length >= Math.max(3, Math.ceil(lines.length * 0.5))) {
    const first = strong[0].loose;
    if (first.length < 3) return true;
    let aligned = 0;
    for (const p of strong.slice(1, Math.min(6, strong.length))) {
      const xs = p.loose;
      const m = Math.min(xs.length, first.length);
      let ok = 0;
      for (let i = 0; i < m; i++) if (Math.abs(xs[i] - first[i]) <= 0.05) ok++;
      if (ok >= Math.max(2, Math.floor(m * 0.6))) aligned++;
    }
    if (aligned >= 2) return true;
  }

  // 2-column tables: many lines show 2+ aligned clusters.
  const twoish = per.filter((p) => p.tight.length >= 2);
  if (twoish.length >= Math.max(4, Math.ceil(lines.length * 0.7))) {
    const base = twoish[0].tight;
    if (base.length >= 2) {
      let aligned = 0;
      for (const p of twoish.slice(1, Math.min(8, twoish.length))) {
        const xs = p.tight;
        if (xs.length < 2) continue;
        const ok0 = Math.abs(xs[0] - base[0]) <= 0.06;
        const ok1 = Math.abs(xs[xs.length - 1] - base[base.length - 1]) <= 0.06;
        if (ok0 && ok1) aligned++;
      }
      if (aligned >= 2) return true;
    }
  }

  return false;
}

function looksFigureInternal(lines: PdfLine[], colX0n: number, colX1n: number, bodyFontSize: number): boolean {
  // Structural figure-internal heuristic: lots of short, scattered lines not aligned to column left.
  const colW = colX1n - colX0n;
  const short = lines.filter((l) => (l.x1n - l.x0n) < Math.max(0.12, colW * 0.35));
  if (short.length < Math.max(3, Math.ceil(lines.length * 0.6))) return false;
  const leftAligned = lines.filter((l) => Math.abs(l.x0n - colX0n) <= 0.02);
  if (leftAligned.length >= Math.ceil(lines.length * 0.5)) return false;
  const xs = lines.map((l) => l.x0n).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  const spread = xs.length >= 2 ? (percentile(xs, 0.9) - percentile(xs, 0.1)) : 0;

  // Small-font clusters are often axis labels / figure overlays.
  const fonts = lines.map((l) => l.fontSize).filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  const fMed = fonts.length ? median(fonts) : 0;
  const smallFont = bodyFontSize > 0 && fMed > 0 && fMed <= bodyFontSize * 0.82;

  return spread >= 0.10 || smallFont;
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
  const bodyLeftX = estimateBodyLeftX(lines, column.x0n, column.x1n, opts.bodyFontSize);
  const bodyWidth = estimateBodyLineWidth(lines, column.x0n, column.x1n, opts.bodyFontSize);
  const paraIndent = estimateParagraphIndent(lines, bodyLeftX, opts.bodyFontSize);
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
    } else if (looksFigureInternal(current, column.x0n, column.x1n, opts.bodyFontSize)) {
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
    const prevW = prev.x1n - prev.x0n;

    // Structural paragraph boundaries.
    // Many PDFs encode paragraph breaks with only a modest extra vertical gap.
    // Prefer over-splitting to missing paragraph boundaries.
    const newBlockByGap = gap > Math.max(medianGap * 1.25, 0.010);

    // Font discontinuity (often headings, captions, etc.).
    const fontJump = Math.abs((ln.fontSize ?? 0) - (prev.fontSize ?? 0)) > Math.max(0.8, opts.bodyFontSize * 0.22);

    // First-line indent paragraphs: an indented line that follows a non-indented line.
    const indented = (ln.x0n - bodyLeftX) > Math.max(0.018, paraIndent * 0.6);
    const prevAtBodyLeft = Math.abs(prev.x0n - bodyLeftX) <= 0.02;
    const newBlockByFirstLineIndent = paraIndent > 0 && indented && prevAtBodyLeft;

    // Non-indented paragraphs (common in PDFs): detect paragraph break by a short last line.
    // This is layout-only and works for ragged-right and many justified layouts.
    const shortLastLine = prevW < Math.max(bodyWidth * 0.78, 0.18);
    const curAtBodyLeft = Math.abs(ln.x0n - bodyLeftX) <= 0.02;
    const newBlockByShortLastLine = shortLastLine && curAtBodyLeft && gap >= Math.max(medianGap * 0.75, 0.006);

    // Large indent shifts are usually structural boundaries (e.g., list start, quote block).
    const indentDeltaFromPrev = Math.abs(ln.x0n - prev.x0n);
    const newBlockByIndentShift = indentDeltaFromPrev > 0.06;

    if (newBlockByGap || fontJump || newBlockByFirstLineIndent || newBlockByShortLastLine || newBlockByIndentShift) {
      flush();
      current = [ln];
    } else {
      current.push(ln);
    }
  }

  flush();

  return blocks;
}
