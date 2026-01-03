// src/pdf/journal.ts
// Journal-article specific constraints (spec section 7).
//
// Constraints implemented here are intentionally conservative:
// - Prefer false exclusion to false inclusion (spec §7.5).
// - No keyword lists / publisher templates (spec §7.4, §10).
//
// Implemented:
// - Structural front-matter exclusion (authors/affiliations/metadata).
// - References hard-stop via structural bibliography detection.
// - Conservative exclusion of late back-matter blocks (funding/ethics/etc.) using
//   position + structural "non-body" cues only.

import type { PdfBlock } from './types';
import { median, percentile } from './utils';

export type ScholarlyHeuristic = {
  isLikelyScholarly: boolean;
  referencesStartBlockGlobalIndex?: number;
};

function isBodyParagraphLike(b: PdfBlock): boolean {
  if (!b.included) return false;
  if (b.type !== 'Paragraph' && b.type !== 'ListItem') return false;
  const lines = b.lines?.length ?? 0;
  if (lines < 2) return false;
  const w = b.x1n - b.x0n;
  return w >= 0.55;
}

function looksMarkerOnly(text: string): boolean {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (t.length > 8) return false;
  // Digits + simple punctuation only.
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

function referenceEntryScore(b: PdfBlock): number {
  if (!b.included) return 0;
  if (b.type !== 'Paragraph' && b.type !== 'ListItem') return 0;

  const lines = b.lines?.length ?? 0;
  const w = b.x1n - b.x0n;

  // Marker-only blocks (sometimes numbering is separated by PDF extraction).
  if (lines === 1 && w < 0.25 && looksMarkerOnly(b.text)) return 1.1;

  let s = 0;
  if (b.type === 'ListItem') s += 0.6;
  if (lines >= 2) s += 0.4;
  s += hangingIndentScore(b);

  // References are usually not full-width banner blocks.
  if (w <= 0.97) s += 0.2;

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
    const close = samePage && Math.abs(prev.y1n - cur.y0n) <= 0.05;
    const narrow = (prev.x1n - prev.x0n) <= 0.75;
    const short = (prev.lines?.length ?? 0) <= 2;
    if (close && narrow && short && prev.type === 'Heading') {
      j = j - 1;
      continue;
    }
    break;
  }
  return Math.max(0, j);
}

export function detectScholarlyAndReferences(blocksInReadingOrder: PdfBlock[]): ScholarlyHeuristic {
  const pages = pageCountFromBlocks(blocksInReadingOrder);
  if (pages < 2) return { isLikelyScholarly: false };

  const multiColShare = inferMultiColumnShare(blocksInReadingOrder);
  const likelyLayoutScholarly = pages >= 4 && multiColShare >= 0.25;

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
      // Too early in the document; stop accumulating.
      run = 0;
      continue;
    }

    const s = referenceEntryScore(b);
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

  // No detected references run.
  return { isLikelyScholarly: likelyLayoutScholarly };
}

export function applyJournalConstraints(
  blocksInReadingOrder: PdfBlock[],
  scholarly: ScholarlyHeuristic
): { blocks: PdfBlock[] } {
  if (!scholarly.isLikelyScholarly) return { blocks: blocksInReadingOrder };

  const out = blocksInReadingOrder.map((b) => ({ ...b }));

  // 1) Front matter exclusion: drop everything before the first substantial body-paragraph-like block.
  let firstBody = -1;
  for (let i = 0; i < out.length; i++) {
    if (isBodyParagraphLike(out[i])) {
      firstBody = i;
      break;
    }
  }

  if (firstBody > 0) {
    for (let i = 0; i < firstBody; i++) {
      if (!out[i].included) continue;
      out[i].included = false;
      out[i].excludeReason = 'JOURNAL_FRONT_MATTER';
      out[i].confidence = Math.min(out[i].confidence, 0.9);
    }
  }

  // 1.25) Small-font bottom-of-page blocks are usually footnotes/boilerplate in scholarly PDFs.
  // Structural only; prefer exclusion (spec §7.5).
  const bodyFonts = out
    .filter((b) => b.included)
    .flatMap((b) => (b.lines ?? []).map((l) => l.fontSize))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  const bodyFont = bodyFonts.length ? percentile(bodyFonts, 0.5) : 0;
  if (bodyFont > 0) {
    for (const b of out) {
      if (!b.included) continue;
      if (b.pageIndex < 0) continue;
      if (b.y0n < 0.84) continue;
      const fonts = (b.lines ?? []).map((l) => l.fontSize).filter((n) => Number.isFinite(n) && n > 0).sort((a, c) => a - c);
      const fMed = fonts.length ? median(fonts) : 0;
      if (!fMed) continue;
      if (fMed <= bodyFont * 0.82) {
        b.included = false;
        b.excludeReason = 'MARGIN_DECORATIVE';
        b.type = 'MarginDecorative';
        b.confidence = Math.min(b.confidence, 0.85);
      }
    }
  }

  // 1.5) Back-matter exclusion (pre-references): keep only the last substantial run of body-paragraph-like
  // content before references. This avoids letting late non-body blocks into RSVP.
  const refStart = scholarly.referencesStartBlockGlobalIndex;
  if (Number.isFinite(refStart) && (refStart as number) > 0) {
    const start = Math.max(0, firstBody);
    const end = Math.max(start, (refStart as number) - 1);

    let lastBody = -1;
    for (let i = end; i >= start; i--) {
      if (isBodyParagraphLike(out[i])) {
        lastBody = i;
        break;
      }
    }

    if (lastBody >= 0 && lastBody < end) {
      for (let i = lastBody + 1; i <= end; i++) {
        if (!out[i].included) continue;
        out[i].included = false;
        out[i].excludeReason = 'JOURNAL_BACK_MATTER';
        out[i].confidence = Math.min(out[i].confidence, 0.8);
      }
    }
  }

  // 2) References hard stop (spec §7.3): once references begin, everything after is excluded.
  let hardStop = scholarly.referencesStartBlockGlobalIndex;
  if (!Number.isFinite(hardStop)) {
    // If we couldn't confidently detect a references run, try a last-page structural check.
    // If the final page is dominated by reference-like entries, hard-stop at its first block.
    const pageMax = Math.max(...out.map((b) => b.pageIndex));
    const lastPageIdxs = out.map((b, i) => (b.pageIndex === pageMax ? i : -1)).filter((i) => i >= 0);
    if (lastPageIdxs.length) {
      const lastPageBlocks = lastPageIdxs.map((i) => out[i]).filter((b) => b.included);
      const refish = lastPageBlocks.filter((b) => referenceEntryScore(b) >= 1.6).length;
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
