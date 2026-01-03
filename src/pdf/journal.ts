// src/pdf/journal.ts
// Journal-article specific constraints (spec section 7):
// - Exclude front matter (authors/affiliations/metadata) structurally
// - References hard stop structurally
// - Conservative back-matter exclusion by position/layout
//
// IMPORTANT: No keyword lists. All logic is layout/structure based.

import type { PdfBlock, PdfExcludeReason } from './types';
import { median } from './utils';

type ScholarlyHeuristic = {
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

function isReferenceEntryLike(b: PdfBlock): boolean {
  if (!b.included) return false;
  if (b.type !== 'Paragraph' && b.type !== 'ListItem') return false;
  const lines = b.lines?.length ?? 0;
  if (lines < 2) return false;
  // Structural bibliography heuristic: hanging indent with many short-ish lines.
  const xFirst = b.lines[0].x0n;
  const xRest = b.lines.slice(1).map((l) => l.x0n).sort((a, c) => a - c);
  const indent = (median(xRest) || xFirst) - xFirst;
  const w = b.x1n - b.x0n;
  return indent >= 0.02 && w <= 0.95; // width not informative; keep permissive.
}

export function detectScholarlyAndReferences(blocksInReadingOrder: PdfBlock[]): ScholarlyHeuristic {
  // Heuristic: scholarly docs tend to have sustained multi-page content and a references-like tail.
  const pageSet = new Set(blocksInReadingOrder.map((b) => b.pageIndex));
  const pages = pageSet.size;
  if (pages < 2) return { isLikelyScholarly: false };

  // Find references start from the end: first long run of reference-entry-like blocks.
  let run = 0;
  for (let i = blocksInReadingOrder.length - 1; i >= 0; i--) {
    const b = blocksInReadingOrder[i];
    if (!b.included) continue;
    if (isReferenceEntryLike(b)) run += 1;
    else run = 0;
    if (run >= 6) {
      // references likely started a few blocks earlier
      return { isLikelyScholarly: true, referencesStartBlockGlobalIndex: Math.max(0, i) };
    }
  }

  // If no references-like run, treat as non-scholarly to avoid over-excluding.
  return { isLikelyScholarly: false };
}

export function applyJournalConstraints(
  blocksInReadingOrder: PdfBlock[],
  scholarly: ScholarlyHeuristic
): { blocks: PdfBlock[]; referencesHardStopIndex?: number } {
  if (!scholarly.isLikelyScholarly) return { blocks: blocksInReadingOrder };

  const out = blocksInReadingOrder.map((b) => ({ ...b }));

  // 1) Front matter exclusion: drop everything before first body-paragraph-like block.
  // We infer column width from each block's column span (normalized) conservatively.
  let firstBody = -1;
  for (let i = 0; i < out.length; i++) {
    const b = out[i];
    if (!b.included) continue;
    if (isBodyParagraphLike(b)) {
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

  // 2) References hard stop.
  let hardStop = scholarly.referencesStartBlockGlobalIndex;
  if (Number.isFinite(hardStop)) {
    for (let i = hardStop!; i < out.length; i++) {
      if (!out[i].included) continue;
      out[i].included = false;
      out[i].excludeReason = 'REFERENCES_HARD_STOP';
      out[i].confidence = Math.min(out[i].confidence, 0.95);
    }
  }

  // 3) Conservative back-matter exclusion (between body end and references) is intentionally
  // minimal here. Without semantics, we only exclude if blocks become predominantly short
  // single-line fragments for a sustained run.
  // This errs toward inclusion, but references remains the hard stop per spec.
  if (Number.isFinite(hardStop) && (hardStop as number) > 0) {
    let shortRun = 0;
    for (let i = Math.max(0, (hardStop as number) - 40); i < (hardStop as number); i++) {
      const b = out[i];
      if (!b.included) continue;
      const isShort = (b.lines?.length ?? 0) <= 1 && (b.text ?? '').length < 180;
      shortRun = isShort ? shortRun + 1 : 0;
      if (shortRun >= 10) {
        // Exclude remaining blocks up to hardStop as likely back matter.
        for (let j = i - shortRun + 1; j < (hardStop as number); j++) {
          if (!out[j].included) continue;
          out[j].included = false;
          out[j].excludeReason = 'JOURNAL_BACK_MATTER';
          out[j].confidence = Math.min(out[j].confidence, 0.7);
        }
        break;
      }
    }
  }

  return { blocks: out };
}
