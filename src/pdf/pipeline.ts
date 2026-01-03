// src/pdf/pipeline.ts
// Entry-point: build a spec-compliant PDF → Narrative pipeline.

import type { PdfDocLike, PdfNarrativeIndex, PdfExclusionLogEntry, PdfBlock } from './types';
import { extractPdfPages, loadPdfDocument } from './extract';
import { buildLines } from './lines';
import { inferColumns } from './columns';
import { detectMarginDecorativeLines, detectRepeatedHeaderFooterLines, makeLineId } from './exclusions';
import { buildAndClassifyBlocks } from './blocks';
import { tagCaptions } from './captions';
import { detectScholarlyAndReferences, applyJournalConstraints } from './journal';
import { attachBlockTokenRanges, flattenNarrative } from './flatten';

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
  const headerFooterLineIds = detectRepeatedHeaderFooterLines(allPageLines);

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
    for (const [colIdx, arr] of byCol.entries()) {
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

  // Journal constraints (only when detected structurally).
  const scholarly = detectScholarlyAndReferences(captionTagged);
  const journalApplied = applyJournalConstraints(captionTagged, scholarly);
  const finalBlocks = journalApplied.blocks;

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
