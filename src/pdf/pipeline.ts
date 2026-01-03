// src/pdf/pipeline.ts
// Entry-point: build a spec-compliant PDF → Narrative pipeline.

import type { PdfDocLike, PdfNarrativeIndex, PdfExclusionLogEntry, PdfBlock } from './types';
import { extractPdfPages, loadPdfDocument } from './extract';
import { buildLines } from './lines';
import { inferColumns } from './columns';
import {
  detectMarginDecorativeLines,
  detectRepeatedHeaderFooterLines,
  detectSingletonEdgeHeaderFooterLines,
  makeLineId,
} from './exclusions';
import { buildAndClassifyBlocks } from './blocks';
import { tagCaptions } from './captions';
import { detectScholarlyAndReferences, applyJournalConstraints } from './journal';
import { attachBlockTokenRanges, flattenNarrative } from './flatten';
import { median } from './utils';

function blockMedianFontSize(b: PdfBlock): number {
  const sizes = (b.lines ?? [])
    .map((l) => l.fontSize)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, c) => a - c);
  return sizes.length ? median(sizes) : 0;
}

function assignHeadingLevels(blocksInReadingOrder: PdfBlock[]): void {
  // Purely structural: map distinct heading font-size bands to [H1]..[H6].
  // This is optional metadata used when flattening, and does not affect exclusion logic.
  const headingBlocks = blocksInReadingOrder.filter((b) => b.included && b.type === 'Heading');
  if (!headingBlocks.length) return;

  const sizes = headingBlocks
    .map(blockMedianFontSize)
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => b - a); // descending

  if (!sizes.length) return;

  // Build size "bands" (merge near-equal sizes to tolerate renderer variation).
  // Ratio threshold chosen to be layout-tolerant without collapsing clearly distinct levels.
  const bands: number[] = [];
  for (const s of sizes) {
    if (!bands.length) {
      bands.push(s);
      continue;
    }
    const last = bands[bands.length - 1];
    const ratio = last / s; // >= 1 because sorted desc
    if (ratio <= 1.08) {
      // Same band.
      continue;
    }
    bands.push(s);
    if (bands.length >= 6) break;
  }

  for (const b of headingBlocks) {
    const s = blockMedianFontSize(b);
    if (!s) {
      b.headingLevel = 3;
      continue;
    }
    // Find closest band by relative difference.
    let bestIdx = 0;
    let bestScore = Number.POSITIVE_INFINITY;
    for (let i = 0; i < bands.length; i++) {
      const score = Math.abs(Math.log((bands[i] ?? s) / s));
      if (score < bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    b.headingLevel = Math.min(6, Math.max(1, bestIdx + 1)) as 1 | 2 | 3 | 4 | 5 | 6;
  }
}

export async function parsePdfToNarrativeIndex(
  data: ArrayBuffer,
  opts?: { maxPages?: number }
): Promise<PdfNarrativeIndex> {
  const pdf = await loadPdfDocument(data);
  return await parsePdfDocumentToNarrativeIndex(pdf, opts);
}

export async function parsePdfDocumentToNarrativeIndex(
  pdf: PdfDocLike,
  opts?: { maxPages?: number }
): Promise<PdfNarrativeIndex> {
  const rawPages = await extractPdfPages(pdf, opts);
  const pagesOut: PdfNarrativeIndex['pages'] = [];

  const maxRotationAbsRad = Math.PI / 18; // 10° (structural watermark/rotation cutoff)

  // Pass 1: build lines + columns per page.
  const allPageLines: Array<{ pageIndex: number; lines: ReturnType<typeof buildLines> }> = [];

  for (const p of rawPages) {
    const lines = buildLines(p.pageIndex, p.items, {
      pageHeightPx: p.height,
      bodyFontSize: p.bodyFontSize,
      maxRotationAbsRad, // 10°
    });
    allPageLines.push({ pageIndex: p.pageIndex, lines });
  }

  // Structural header/footer repetition across pages.
  const repeatedHeaderFooterLineIds = detectRepeatedHeaderFooterLines(allPageLines);
  const singletonHeaderFooterLineIds = detectSingletonEdgeHeaderFooterLines(allPageLines);
  const headerFooterLineIds = new Set<string>([...repeatedHeaderFooterLineIds, ...singletonHeaderFooterLineIds]);

  // Pass 2: columns → blocks.
  for (const p of rawPages) {
    const lines = (allPageLines.find((x) => x.pageIndex === p.pageIndex)?.lines ?? []).slice();
    const cols = inferColumns(p.pageIndex, lines);
    const marginLineIds = detectMarginDecorativeLines(lines, cols.map((c) => ({ x0n: c.x0n, x1n: c.x1n })));

    const rotatedLineIds = new Set<string>();
    lines.forEach((ln, idx) => {
      if ((ln.maxAbsRotationRad ?? 0) > maxRotationAbsRad) {
        rotatedLineIds.add(makeLineId(p.pageIndex, idx));
      }
    });

    const columnForLine = (ln: any): number => {
      const xMid = (ln.x0n + ln.x1n) / 2;
      let best = 0;
      let bestD = Number.POSITIVE_INFINITY;
      for (const c of cols) {
        const cMid = (c.x0n + c.x1n) / 2;
        const d = Math.abs(cMid - xMid);
        if (d < bestD) { bestD = d; best = c.columnIndex; }
      }
      return best;
    };

    // Build excluded-line pseudo-blocks for traceability.
    const excludedLineBlocks: PdfBlock[] = [];
    lines.forEach((ln, idx) => {
      const id = makeLineId(p.pageIndex, idx);
      if (headerFooterLineIds.has(id)) {
        excludedLineBlocks.push({
          pageIndex: p.pageIndex,
          columnIndex: columnForLine(ln),
          blockIndex: -1,
          type: 'HeaderFooter',
          bbox: ln.bbox,
          x0n: ln.x0n,
          x1n: ln.x1n,
          y0n: ln.y0n,
          y1n: ln.y1n,
          text: ln.text,
          lines: [ln],
          included: false,
          excludeReason: 'HEADER_FOOTER',
          confidence: 0.95,
        });
      } else if (rotatedLineIds.has(id)) {
        excludedLineBlocks.push({
          pageIndex: p.pageIndex,
          columnIndex: columnForLine(ln),
          blockIndex: -1,
          type: 'MarginDecorative',
          bbox: ln.bbox,
          x0n: ln.x0n,
          x1n: ln.x1n,
          y0n: ln.y0n,
          y1n: ln.y1n,
          text: ln.text,
          lines: [ln],
          included: false,
          excludeReason: 'ROTATED_OR_WATERMARK',
          confidence: 0.9,
        });
      } else if (marginLineIds.has(id)) {
        excludedLineBlocks.push({
          pageIndex: p.pageIndex,
          columnIndex: columnForLine(ln),
          blockIndex: -1,
          type: 'MarginDecorative',
          bbox: ln.bbox,
          x0n: ln.x0n,
          x1n: ln.x1n,
          y0n: ln.y0n,
          y1n: ln.y1n,
          text: ln.text,
          lines: [ln],
          included: false,
          excludeReason: 'MARGIN_DECORATIVE',
          confidence: 0.85,
        });
      }
    });

    // Apply line-level exclusions before block building.
    const filteredCols = cols.map((c) => {
      const kept: typeof c.lines = [];
      c.lines.forEach((ln, idx) => {
        const globalIdx = lines.indexOf(ln);
        const id = makeLineId(p.pageIndex, globalIdx >= 0 ? globalIdx : idx);
        if (headerFooterLineIds.has(id)) return;
        if (rotatedLineIds.has(id)) return;
        if (marginLineIds.has(id)) return;
        kept.push(ln);
      });
      return { ...c, lines: kept };
    });

    // Build blocks per column.
    const blocks: PdfBlock[] = [];
    const byCol = new Map<number, PdfBlock[]>();
    for (const b of excludedLineBlocks) {
      const arr = byCol.get(b.columnIndex) ?? [];
      arr.push(b);
      byCol.set(b.columnIndex, arr);
    }

    for (const c of filteredCols) {
      const bs = buildAndClassifyBlocks(c, { bodyFontSize: p.bodyFontSize });
      const arr = byCol.get(c.columnIndex) ?? [];
      arr.push(...bs);
      byCol.set(c.columnIndex, arr);
    }

    // Deterministic block indexing per column.
    for (const [, arr] of byCol.entries()) {
      arr.sort((a, b) => a.y0n - b.y0n || a.x0n - b.x0n);
      arr.forEach((b, i) => (b.blockIndex = i));
      blocks.push(...arr);
    }

    pagesOut.push({
      pageIndex: p.pageIndex,
      pageWidth: p.width,
      pageHeight: p.height,
      bodyFontSize: p.bodyFontSize,
      columns: filteredCols,
      blocks,
    });
  }

  // Build global reading order blocks list.
  const blocksInReadingOrder: PdfBlock[] = [];
  for (const pg of pagesOut) {
    const cols = pg.columns.slice().sort((a, b) => a.x0n - b.x0n || a.columnIndex - b.columnIndex);
    for (const col of cols) {
      const bs = pg.blocks
        .filter((b) => b.columnIndex === col.columnIndex)
        .sort((a, b) => a.y0n - b.y0n || a.x0n - b.x0n || a.blockIndex - b.blockIndex);
      blocksInReadingOrder.push(...bs);
    }
  }

  // Tag captions (included narrative blocks adjacent to excluded figure/table regions).
  const captionTagged = tagCaptions(blocksInReadingOrder);

  // Conservative footnote/boilerplate exclusion: small-font blocks near the bottom of a page.
  // Structural only; prefer exclusion over inclusion.
  const byPageBodyFont = new Map<number, number>();
  for (const p of pagesOut) {
    const mids = p.blocks
      .filter((b) => {
        if (!b.included) return false;
        if (b.type !== 'Paragraph' && b.type !== 'ListItem') return false;
        const yMid = (b.y0n + b.y1n) / 2;
        return yMid > 0.15 && yMid < 0.85;
      })
      .map(blockMedianFontSize)
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    byPageBodyFont.set(p.pageIndex, mids.length ? median(mids) : 0);
  }

  for (const b of captionTagged) {
    if (!b.included) continue;
    // Never exclude captions by this rule.
    if (b.type === 'FigureCaption' || b.type === 'TableCaption') continue;
    const bodyFont = byPageBodyFont.get(b.pageIndex) ?? 0;
    if (!(bodyFont > 0)) continue;
    const bFont = blockMedianFontSize(b);
    if (!(bFont > 0)) continue;
    const w = b.x1n - b.x0n;
    if (b.y0n > 0.83 && w < 0.95 && bFont <= bodyFont * 0.82) {
      b.included = false;
      b.excludeReason = 'MARGIN_DECORATIVE';
      b.type = 'MarginDecorative';
      b.confidence = Math.min(b.confidence, 0.95);
    }
  }

  // Column bounds lookup for journal heuristics (column-relative width ratios).
  const colBounds = new Map<string, { x0n: number; x1n: number }>();
  for (const pg of pagesOut) {
    for (const c of pg.columns) {
      colBounds.set(`${pg.pageIndex}:${c.columnIndex}`, { x0n: c.x0n, x1n: c.x1n });
    }
  }
  const journalLayout = {
    getColumnBounds: (pageIndex: number, columnIndex: number) => colBounds.get(`${pageIndex}:${columnIndex}`) ?? null,
  };

  // Journal constraints (only when detected structurally).
  const scholarly = detectScholarlyAndReferences(captionTagged, journalLayout);
  const journalApplied = applyJournalConstraints(captionTagged, scholarly, journalLayout);
  const finalBlocks = journalApplied.blocks;

  // Assign Markdown-style heading levels (1..6) structurally, based on font-size bands.
  // This only affects how headings are emitted in the flattened narrative.
  assignHeadingLevels(finalBlocks);

  // Persist post-processing decisions back onto per-page blocks.
  const byKey = new Map<string, PdfBlock>();
  for (const b of finalBlocks) byKey.set(`${b.pageIndex}:${b.columnIndex}:${b.blockIndex}`, b);
  for (const pg of pagesOut) {
    for (let i = 0; i < pg.blocks.length; i++) {
      const k = `${pg.blocks[i].pageIndex}:${pg.blocks[i].columnIndex}:${pg.blocks[i].blockIndex}`;
      const upd = byKey.get(k);
      if (!upd) continue;
      pg.blocks[i] = { ...pg.blocks[i], ...{
        type: upd.type,
        included: upd.included,
        excludeReason: upd.excludeReason,
        confidence: upd.confidence,
        headingLevel: upd.headingLevel,
      }};
    }
  }

  // Exclusion log.
  const exclusions: PdfExclusionLogEntry[] = [];
  for (const b of finalBlocks) {
    if (b.included) continue;
    if (!b.excludeReason) continue;
    exclusions.push({
      pageIndex: b.pageIndex,
      columnIndex: b.columnIndex,
      blockIndex: b.blockIndex,
      type: b.type,
      reason: b.excludeReason,
      confidence: b.confidence,
      bbox: b.bbox,
      excerpt: String(b.text ?? '').slice(0, 180),
    });
  }

  const flat = flattenNarrative(finalBlocks);
  const index: PdfNarrativeIndex = {
    pageCount: pagesOut.length,
    pages: pagesOut,
    fullText: flat.fullText,
    tokens: flat.tokens,
    tokenMeta: flat.tokenMeta,
    exclusions,
    isLikelyScholarly: scholarly.isLikelyScholarly,
  };

  // Column token ranges (for column-bounded RSVP stepping / navigation).
  const colRanges = new Map<string, { pageIndex: number; columnIndex: number; start: number; endExclusive: number }>();
  for (let ti = 0; ti < index.tokenMeta.length; ti++) {
    const m: any = index.tokenMeta[ti] as any;
    const pi = Number(m.pageIndex);
    const ci = Number(m.columnIndex);
    if (!(pi >= 0 && ci >= 0)) continue;
    const key = `${pi}:${ci}`;
    const prev = colRanges.get(key);
    if (!prev) colRanges.set(key, { pageIndex: pi, columnIndex: ci, start: ti, endExclusive: ti + 1 });
    else {
      if (ti < prev.start) prev.start = ti;
      if (ti + 1 > prev.endExclusive) prev.endExclusive = ti + 1;
    }
  }
  index.columnTokenRanges = Array.from(colRanges.values()).sort((a, b) => (a.pageIndex - b.pageIndex) || (a.columnIndex - b.columnIndex));

  // Attach token ranges + keys for anchoring.
  attachBlockTokenRanges(index);

  if (scholarly.isLikelyScholarly && Number.isFinite(scholarly.referencesStartBlockGlobalIndex)) {
    // Approximate hard-stop token index as the first token in the first excluded references block.
    const refStartBlock = finalBlocks[scholarly.referencesStartBlockGlobalIndex!];
    if (refStartBlock?.tokenRange?.start !== undefined) {
      index.referencesHardStopTokenIndex = refStartBlock.tokenRange.start;
    }
  }
  return index;
}