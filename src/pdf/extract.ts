// src/pdf/extract.ts
// PDF.js extraction + deterministic conversion into geometric text items.

import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import type {
  DocumentInitParameters,
  PDFDocumentLoadingTask,
  TextItem,
} from 'pdfjs-dist/types/src/display/api';

import { clamp01, percentile, stableSortBy } from './utils';
import type { PdfDocLike, PdfPageLike, PdfTextItem } from './types';

export type PdfPageRaw = {
  pageIndex: number;
  width: number;
  height: number;
  bodyFontSize: number;
  items: PdfTextItem[];
};

type TextContentLike = { items?: unknown[] };

function parsePageTextItems(pageIndex: number, page: PdfPageLike, content: unknown): PdfPageRaw {
  const rawItems = (content as TextContentLike | null)?.items;
  const items = Array.isArray(rawItems)
    ? rawItems.filter((it: unknown): it is TextItem => typeof (it as Partial<TextItem>)?.str === 'string')
    : [];

  const viewport = page.getViewport({ scale: 1 });
  const pageW = Number(viewport?.width ?? 1) || 1;
  const pageH = Number(viewport?.height ?? 1) || 1;

  const parsed: PdfTextItem[] = [];
  const fontSizes: number[] = [];

  for (const it of items) {
    const s = typeof it?.str === 'string' ? it.str : '';
    if (!s || !s.trim()) continue;

    const tr = (it?.transform ?? []) as number[];
    const a = Number(tr[0] ?? 0);
    const b = Number(tr[1] ?? 0);
    const c = Number(tr[2] ?? 0);
    const d = Number(tr[3] ?? 0);
    const x = Number(tr[4] ?? 0);
    const y = Number(tr[5] ?? 0);
    const rotationRad = Math.atan2(b, a);

    // Approx font size; deterministic and purely geometric.
    const fontSize = Math.max(Math.hypot(a, b), Math.hypot(c, d), Math.abs(d), 0);
    if (Number.isFinite(fontSize) && fontSize > 0) fontSizes.push(fontSize);

    const w = Number(it?.width ?? 0);
    const h = Number(it?.height ?? 0);
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
  const loadingTask: PDFDocumentLoadingTask = getDocument({
    data: uint8,
    // Required in Obsidian to avoid spawning a worker.
    disableWorker: true,
  } as DocumentInitParameters);
  // At runtime this is a PDFDocumentProxy, but we type it as PdfDocLike to keep the
  // pipeline compatible with Obsidian's viewer-supplied pdfDocument object.
  return (await loadingTask.promise) as unknown as PdfDocLike;
}

export async function extractPdfPages(pdf: PdfDocLike, opts?: { maxPages?: number }): Promise<PdfPageRaw[]> {
  const maxPages = opts?.maxPages ?? 200;
  const totalPages = Math.min(Number(pdf?.numPages ?? 0), maxPages);
  if (!totalPages) return [];

  const out: PdfPageRaw[] = [];
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    try {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      out.push(parsePageTextItems(pageNum - 1, page, content));
    } catch (err) {
      console.error('[DashReader][pdf-pipeline] failed to extract page', { pageNum, err });
      // Preserve page indexing: emit empty page.
      out.push({ pageIndex: pageNum - 1, width: 1, height: 1, bodyFontSize: 0, items: [] });
    }
  }
  return out;
}

export function estimateLineYToleranceNorm(bodyFontSize: number, pageHeightPx: number): number {
  // Baseline tolerance in normalized units, derived only from geometry.
  // Slightly generous to survive PDF text-layer fragmentation.
  const px = Math.max(1, bodyFontSize || 10);
  const tolPx = Math.max(1.5, px * 0.55);
  return tolPx / Math.max(1, pageHeightPx);
}

export function estimateSpaceThresholdPx(bodyFontSize: number): number {
  // Deterministic, geometry-derived spacing threshold.
  const px = Math.max(1, bodyFontSize || 10);
  return Math.max(1.5, px * 0.25);
}
