// src/pdf/journal.ts
// Journal-article specific constraints (spec section 7).
//
// Strictly structural heuristics only:
// - No keyword lists / publisher templates.
// - Prefer false exclusion to false inclusion (spec §7.5).
//
// Implemented:
// - Structural front-matter exclusion (authors/affiliations/metadata).
// - References hard-stop via structural bibliography detection.
// - Conservative back-matter exclusion (funding/ethics/etc.) using
//   position + density shift cues (no vocabulary).

import type { PdfBlock } from './types';
import { median, percentile } from './utils';

export type ScholarlyHeuristic = {
  isLikelyScholarly: boolean;
  referencesStartBlockGlobalIndex?: number;
};

export type JournalLayout = {
  getColumnBounds: (pageIndex: number, columnIndex: number) => { x0n: number; x1n: number } | null;
};

function blockFontMedian(b: PdfBlock): number {
  const fs = (b.lines ?? [])
    .map((l) => l.fontSize)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, c) => a - c);
  return fs.length ? median(fs) : 0;
}

function colWidth(layout: JournalLayout | undefined, b: PdfBlock): number {
  const bounds = layout?.getColumnBounds(b.pageIndex, b.columnIndex);
  const w = bounds ? (bounds.x1n - bounds.x0n) : (b.x1n - b.x0n);
  return Math.max(1e-6, w);
}

function widthRatio(layout: JournalLayout | undefined, b: PdfBlock): number {
  return (b.x1n - b.x0n) / colWidth(layout, b);
}

function isCaption(b: PdfBlock): boolean {
  return b.type === 'FigureCaption' || b.type === 'TableCaption';
}

function isBodyLike(layout: JournalLayout | undefined, b: PdfBlock, bodyFont: number): boolean {
  if (!b.included) return false;
  if (isCaption(b)) return false;
  if (b.type !== 'Paragraph' && b.type !== 'ListItem') return false;

  const lines = b.lines?.length ?? 0;
  if (lines < 2) return false;

  const wr = widthRatio(layout, b);
  if (wr < 0.70) return false;

  const f = blockFontMedian(b);
  if (bodyFont > 0 && f > 0) {
    // Allow some variation (PDF renderers differ), but reject tiny metadata.
    if (f < bodyFont * 0.78) return false;
    if (f > bodyFont * 1.35) return false;
  }

  return true;
}

function isStrongBodyLike(layout: JournalLayout | undefined, b: PdfBlock, bodyFont: number): boolean {
  if (!isBodyLike(layout, b, bodyFont)) return false;
  const lines = b.lines?.length ?? 0;
  const wr = widthRatio(layout, b);
  return lines >= 3 && wr >= 0.78;
}

function looksMarkerOnly(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (t.length > 10) return false;
  return /^[\[\(\{]?[0-9]{1,4}[\]\)\}]?[\.:,;]?$/.test(t);
}

function hangingIndentScore(b: PdfBlock): number {
  const lines = b.lines ?? [];
  if (lines.length < 2) return 0;
  const xFirst = lines[0].x0n;
  const xRest = lines
    .slice(1)
    .map((l) => l.x0n)
    .filter((n) => Number.isFinite(n))
    .sort((a, c) => a - c);
  if (!xRest.length) return 0;
  const indent = (median(xRest) ?? xFirst) - xFirst;
  if (!Number.isFinite(indent)) return 0;
  if (indent >= 0.035) return 2;
  if (indent >= 0.018) return 1;
  return 0;
}

function referenceEntryScore(layout: JournalLayout | undefined, b: PdfBlock, bodyFont: number): number {
  if (!b.included) return 0;
  if (isCaption(b)) return 0;
  if (b.type !== 'Paragraph' && b.type !== 'ListItem') return 0;

  const lines = b.lines?.length ?? 0;
  const wr = widthRatio(layout, b);
  const f = blockFontMedian(b);

  // Marker-only blocks (numbering sometimes separated by the PDF text layer).
  if (lines === 1 && wr < 0.45 && looksMarkerOnly(b.text)) return 1.2;

  let s = 0;
  if (b.type === 'ListItem') s += 0.6;
  if (lines >= 2) s += 0.4;
  s += hangingIndentScore(b);

  // References often slightly smaller than body.
  if (bodyFont > 0 && f > 0 && f <= bodyFont * 0.95) s += 0.25;

  // References are rarely full-width banner blocks.
  if (wr <= 0.97) s += 0.2;

  return s;
}

function pageCountFromBlocks(blocks: PdfBlock[]): number {
  const s = new Set<number>();
  for (const b of blocks) s.add(b.pageIndex);
  return s.size;
}

function inferMultiColumnShare(blocks: PdfBlock[]): number {
  const pages = new Map<number, number>();
  for (const b of blocks) {
    if (!b.included) continue;
    const prev = pages.get(b.pageIndex) ?? 0;
    pages.set(b.pageIndex, Math.max(prev, b.columnIndex));
  }
  const keys = Array.from(pages.keys());
  if (!keys.length) return 0;
  const multi = keys.filter((p) => (pages.get(p) ?? 0) >= 1).length;
  return multi / keys.length;
}

function estimateDocBodyFont(blocks: PdfBlock[]): number {
  const fs: number[] = [];
  for (const b of blocks) {
    if (!b.included) continue;
    if (b.type !== 'Paragraph' && b.type !== 'ListItem') continue;
    const yMid = (b.y0n + b.y1n) / 2;
    if (yMid < 0.15 || yMid > 0.85) continue;
    for (const l of (b.lines ?? [])) {
      const n = l.fontSize;
      if (Number.isFinite(n) && n > 0) fs.push(n);
    }
  }
  fs.sort((a, c) => a - c);
  return fs.length ? percentile(fs, 0.5) : 0;
}

function adjustFrontMatterBackward(blocks: PdfBlock[], idx: number, bodyFont: number): number {
  // Pull the boundary upward to include a nearby heading (e.g., abstract label),
  // but avoid swallowing the big title at the very top.
  let j = idx;
  for (let k = 0; k < 2; k++) {
    const prev = blocks[j - 1];
    const cur = blocks[j];
    if (!prev || !cur) break;
    if (!prev.included) {
      j = j - 1;
      continue;
    }
    if (prev.type !== 'Heading') break;
    const sameCol = prev.pageIndex == cur.pageIndex && prev.columnIndex == cur.columnIndex;
    if (!sameCol) break;
    const close = Math.abs(prev.y1n - cur.y0n) <= 0.06;
    if (!close) break;

    // Avoid very-top headings (titles) and very-large headings.
    if (prev.y0n < 0.14) break;
    const f = blockFontMedian(prev);
    if (bodyFont > 0 && f > bodyFont * 1.6) break;

    j = j - 1;
  }
  return Math.max(0, j);
}

function adjustHardStopBackward(blocks: PdfBlock[], i: number): number {
  // Pull the hard stop up to include a small, header-like block immediately preceding
  // the reference-entry run (e.g., a section title). Structural only.
  let j = i;
  for (let k = 0; k < 2; k++) {
    const prev = blocks[j - 1];
    const cur = blocks[j];
    if (!prev || !cur) break;
    if (!prev.included) {
      j = j - 1;
      continue;
    }
    const samePage = prev.pageIndex === cur.pageIndex;
    const close = samePage && Math.abs(prev.y1n - cur.y0n) <= 0.06;
    const short = (prev.lines?.length ?? 0) <= 2;
    const narrow = (prev.x1n - prev.x0n) <= 0.85;
    if (close && short && narrow && prev.type === 'Heading') {
      j = j - 1;
      continue;
    }
    break;
  }
  return Math.max(0, j);
}

export function detectScholarlyAndReferences(
  blocksInReadingOrder: PdfBlock[],
  layout?: JournalLayout
): ScholarlyHeuristic {
  const pages = pageCountFromBlocks(blocksInReadingOrder);
  if (pages < 2) return { isLikelyScholarly: false };

  const multiColShare = inferMultiColumnShare(blocksInReadingOrder);
  const likelyLayoutScholarly = pages >= 4 && multiColShare >= 0.25;

  const bodyFont = estimateDocBodyFont(blocksInReadingOrder);

  // Reference detection: search from the end for a sustained run of high-scoring entries.
  // Only consider the tail portion of the document to avoid matching ordinary lists.
  const tailStartIdx = Math.floor(blocksInReadingOrder.length * 0.55);
  const pageMax = Math.max(...blocksInReadingOrder.map((b) => b.pageIndex));

  let run = 0;
  let runStart = -1;
  const need = pages >= 6 ? 6 : 4;

  for (let i = blocksInReadingOrder.length - 1; i >= 0; i--) {
    const b = blocksInReadingOrder[i];
    if (i < tailStartIdx) break;
    if (!b.included) continue;

    // Restrict to last ~40% of pages.
    if (b.pageIndex < pageMax - Math.max(2, Math.ceil(pages * 0.4))) {
      run = 0;
      runStart = -1;
      continue;
    }

    const s = referenceEntryScore(layout, b, bodyFont);
    const inc = s >= 2.0 ? 1 : s >= 1.0 ? 0.6 : 0;
    if (inc > 0) {
      run += inc;
      runStart = i;
    } else {
      run = 0;
      runStart = -1;
    }

    if (run >= need && runStart >= 0) {
      const start = adjustHardStopBackward(blocksInReadingOrder, runStart);
      return { isLikelyScholarly: true, referencesStartBlockGlobalIndex: start };
    }
  }

  return { isLikelyScholarly: likelyLayoutScholarly };
}

export function applyJournalConstraints(
  blocksInReadingOrder: PdfBlock[],
  scholarly: ScholarlyHeuristic,
  layout?: JournalLayout
): { blocks: PdfBlock[] } {
  if (!scholarly.isLikelyScholarly) return { blocks: blocksInReadingOrder };

  const out = blocksInReadingOrder.map((b) => ({ ...b }));
  const bodyFont = estimateDocBodyFont(out);

  // 1) Front matter exclusion: drop everything before the first strong body-like paragraph.
  let firstBody = -1;
  for (let i = 0; i < out.length; i++) {
    if (isStrongBodyLike(layout, out[i], bodyFont)) {
      firstBody = i;
      break;
    }
  }

  if (firstBody > 0) {
    const start = adjustFrontMatterBackward(out, firstBody, bodyFont);
    for (let i = 0; i < start; i++) {
      if (!out[i].included) continue;
      out[i].included = false;
      out[i].excludeReason = 'JOURNAL_FRONT_MATTER';
      out[i].confidence = Math.min(out[i].confidence, 0.9);
    }
  }



  // 1.1) Early metadata blocks on the first page (often keywords / publication metadata)
  // can slip past the boundary. Exclude narrow/short blocks structurally.
  for (const b of out) {
    if (!b.included) continue;
    if (b.pageIndex !== 0) continue;
    if (b.y0n > 0.40) continue;
    if (isCaption(b) || b.type === 'Heading') continue;

    const linesN = b.lines?.length ?? 0;
    const wr = widthRatio(layout, b);
    const f = blockFontMedian(b);

    const short = linesN <= 2;
    const narrow = wr < 0.68;
    const smallish = bodyFont > 0 && f > 0 && f <= bodyFont * 0.95;

    if (short && (narrow || smallish)) {
      b.included = false;
      b.excludeReason = 'JOURNAL_FRONT_MATTER';
      b.confidence = Math.min(b.confidence, 0.88);
    }
  }

  // 2) Back-matter exclusion (pre-references): detect a density shift away from body-like paragraphs.
  const refStart = scholarly.referencesStartBlockGlobalIndex;
  if (Number.isFinite(refStart) && (refStart as number) > 0) {
    const startIdx = out.findIndex((b) => b.included);
    const start = startIdx >= 0 ? startIdx : 0;
    const end = Math.max(start, (refStart as number) - 1);

    const window = 10;
    let mainBodyEnd = -1;

    for (let i = end; i >= start; i--) {
      if (!out[i].included) continue;
      const lo = Math.max(start, i - window + 1);
      let bodyCnt = 0;
      const pages = new Set<number>();
      for (let j = lo; j <= i; j++) {
        if (isBodyLike(layout, out[j], bodyFont)) {
          bodyCnt++;
          pages.add(out[j].pageIndex);
        }
      }
      if (bodyCnt >= 6 && pages.size >= 2) {
        mainBodyEnd = i;
        break;
      }
    }

    if (mainBodyEnd < 0) {
      for (let i = end; i >= start; i--) {
        if (isBodyLike(layout, out[i], bodyFont)) {
          mainBodyEnd = i;
          break;
        }
      }
    }

    if (mainBodyEnd >= 0 && mainBodyEnd < end) {
      for (let i = mainBodyEnd + 1; i <= end; i++) {
        const b = out[i];
        if (!b.included) continue;
        if (isCaption(b)) continue;
        // Allow clearly body-like paragraphs to remain; everything else is treated as back matter.
        if (isStrongBodyLike(layout, b, bodyFont)) continue;

        b.included = false;
        b.excludeReason = 'JOURNAL_BACK_MATTER';
        b.confidence = Math.min(b.confidence, 0.82);
      }
    }
  }

  // 3) References hard stop (spec §7.3): once references begin, everything after is excluded.
  let hardStop = scholarly.referencesStartBlockGlobalIndex;
  if (!Number.isFinite(hardStop)) {
    // Fallback: if the final page is dominated by reference-like entries, hard-stop at its first block.
    const pageMax = Math.max(...out.map((b) => b.pageIndex));
    const lastPageIdxs = out.map((b, i) => (b.pageIndex === pageMax ? i : -1)).filter((i) => i >= 0);
    if (lastPageIdxs.length) {
      const bodyFont2 = bodyFont;
      const lastPageBlocks = lastPageIdxs.map((i) => out[i]).filter((b) => b.included);
      const refish = lastPageBlocks.filter((b) => referenceEntryScore(layout, b, bodyFont2) >= 1.6).length;
      if (lastPageBlocks.length >= 6 && refish / Math.max(1, lastPageBlocks.length) >= 0.6) {
        hardStop = lastPageIdxs[0];
      }
    }
  }

  if (Number.isFinite(hardStop)) {
    for (let i = hardStop as number; i < out.length; i++) {
      if (!out[i].included) continue;
      out[i].included = false;
      out[i].excludeReason = 'REFERENCES_HARD_STOP';
      out[i].confidence = Math.min(out[i].confidence, 0.95);
    }
  }

  return { blocks: out };
}
