// src/pdf/extract.ts
// PDF.js extraction + deterministic conversion into geometric text items.
//
// IMPORTANT (spec):
// - No vocabulary heuristics.
// - Deterministic ordering.
// - Tolerate renderer differences by relying on geometry + token-key normalisation downstream.

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

import { clamp01, percentile, stableSortBy } from './utils';
import type { PdfDocLike, PdfPageLike, PdfTextContentLike, PdfTextItemLike, PdfTextItem } from './types';

export type PdfPageRaw = {
  pageIndex: number;
  width: number;
  height: number;
  bodyFontSize: number;
  items: PdfTextItem[];
};

function asNum(n: unknown, fallback = 0): number {
  const v = Number(n);
  return Number.isFinite(v) ? v : fallback;
}

function parseTransform(t: unknown): [number, number, number, number, number, number] {
  const tr = Array.isArray(t) ? t : [];
  return [asNum(tr[0]), asNum(tr[1]), asNum(tr[2]), asNum(tr[3]), asNum(tr[4]), asNum(tr[5])];
}

function parsePageTextItems(pageIndex: number, page: PdfPageLike, content: PdfTextContentLike): PdfPageRaw {
  const rawItems: unknown[] = Array.isArray((content as any)?.items) ? (content as any).items : [];

  const viewport = page.getViewport({ scale: 1 });
  const pageW = asNum((viewport as any)?.width, 1) || 1;
  const pageH = asNum((viewport as any)?.height, 1) || 1;

  const parsed: PdfTextItem[] = [];
  const fontSizes: number[] = [];

  for (const raw of rawItems) {
    const it = raw as PdfTextItemLike;
    const s = typeof (it as any)?.str === 'string' ? String((it as any).str) : '';
    if (!s || !s.trim()) continue;

    const [a, b, c, d, x, y] = parseTransform((it as any)?.transform);
    const rotationRad = Math.atan2(b, a);

    // Approx font size (purely geometric, deterministic).
    const fontSize = Math.max(Math.hypot(a, b), Math.hypot(c, d), Math.abs(d), 0);
    if (Number.isFinite(fontSize) && fontSize > 0) fontSizes.push(fontSize);

    const w = asNum((it as any)?.width, 0);
    const h = asNum((it as any)?.height, 0);
    const x2 = x + (Number.isFinite(w) ? w : 0);
    const y2 = y + (Number.isFinite(h) ? h : 0);

    // Normalized to top-left origin.
    const x0n = clamp01(x / pageW);
    const x1n = clamp01(x2 / pageW);
    // PDF origin bottom-left, so invert.
    const y0n = clamp01(1 - (y2 / pageH));
    const y1n = clamp01(1 - (y / pageH));

    parsed.push({
      pageIndex,
      str: s,
      x,
      y,
      x2,
      y2,
      fontSize,
      rotationRad,
      x0n,
      x1n,
      y0n,
      y1n,
    });
  }

  const sortedFonts = fontSizes.filter((n) => n > 0 && Number.isFinite(n)).sort((a, b) => a - b);
  const bodyFontSize = percentile(sortedFonts, 0.5);

  return {
    pageIndex,
    width: pageW,
    height: pageH,
    bodyFontSize,
    items: stableSortBy(parsed, (p) => (p.y0n * 10_000) + p.x0n),
  };
}

export async function loadPdfDocument(data: ArrayBuffer): Promise<PdfDocLike> {
  const uint8 = new Uint8Array(data);
  const loadingTask: any = getDocument({
    data: uint8,
    // Required in Obsidian to avoid spawning a worker.
    disableWorker: true,
  } as any);
  return (await loadingTask.promise) as PdfDocLike;
}

export async function extractPdfPages(pdf: PdfDocLike, opts?: { maxPages?: number }): Promise<PdfPageRaw[]> {
  const maxPages = opts?.maxPages ?? 200;
  const totalPages = Math.min(Number((pdf as any)?.numPages ?? 0), maxPages);
  if (!totalPages) return [];

  const out: PdfPageRaw[] = [];
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    try {
      const page = (await (pdf as any).getPage(pageNum)) as PdfPageLike;
      const content = (await (page as any).getTextContent()) as PdfTextContentLike;
      out.push(parsePageTextItems(pageNum - 1, page, content));
    } catch (err) {
      console.error('[DashReader][pdf-pipeline] failed to extract page', { pageNum, err });
      // Preserve page indexing: emit empty page.
      out.push({ pageIndex: pageNum - 1, width: 1, height: 1, bodyFontSize: 0, items: [] });
    }
  }
  return out;
}


// ---- Line-building parameter estimates (structural-only, deterministic)
// These helpers live here because they depend on PDF.js geometric font size estimates.

export function estimateSpaceThresholdPx(bodyFontSize: number): number {
  // Insert a space between adjacent text items when their x-gap exceeds this.
  // Structural: proportional to font size.
  if (!(bodyFontSize > 0) || !Number.isFinite(bodyFontSize)) return 2.5;
  return Math.min(10, Math.max(1.5, bodyFontSize * 0.33));
}

export function estimateLineYToleranceNorm(bodyFontSize: number, pageHeightPx: number): number {
  // When grouping items into a line, treat y-mids within this tolerance as the same line.
  // Structural: proportional to font size, normalized by page height.
  const h = (pageHeightPx > 0 && Number.isFinite(pageHeightPx)) ? pageHeightPx : 1000;
  const tolPx = (bodyFontSize > 0 && Number.isFinite(bodyFontSize))
    ? Math.min(12, Math.max(2.0, bodyFontSize * 0.45))
    : 3.5;
  const tolN = tolPx / h;
  // Clamp to avoid pathological grouping on very small/large pages.
  return Math.min(0.02, Math.max(0.001, tolN));
}
