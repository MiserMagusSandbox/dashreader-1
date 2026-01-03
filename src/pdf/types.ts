// src/pdf/types.ts
// Spec-compliant (pdf_rsvp_behaviour_specification.md) PDF pipeline data model.
// NOTE: This is intentionally PDF-layout-first. The RSVP engine can consume the
// resulting `fullText` string without being coupled to PDF internals.

export type PdfBlockType =
  | 'Paragraph'
  | 'Heading'
  | 'ListItem'
  | 'FigureCaption'
  | 'TableCaption'
  | 'InlineEquation'
  | 'DisplayEquation' // excluded
  | 'FigureInternal'  // excluded
  | 'TableInternal'   // excluded
  | 'HeaderFooter'    // excluded
  | 'MarginDecorative'; // excluded

export type PdfExcludeReason =
  | 'HEADER_FOOTER'
  | 'MARGIN_DECORATIVE'
  | 'ROTATED_OR_WATERMARK'
  | 'DISPLAY_EQUATION'
  | 'TABLE_INTERNAL'
  | 'FIGURE_INTERNAL'
  | 'JOURNAL_FRONT_MATTER'
  | 'JOURNAL_BACK_MATTER'
  | 'REFERENCES_HARD_STOP'
  | 'AMBIGUOUS_NON_NARRATIVE';

export type PdfBBox = {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
};

export type PdfTextItem = {
  pageIndex: number;
  str: string;
  // PDF coordinates (origin bottom-left, from PDF.js transform)
  x: number;
  y: number;
  x2: number;
  y2: number;
  fontSize: number;
  rotationRad: number;
  // Normalized [0..1] coordinates, origin top-left (more convenient)
  x0n: number;
  x1n: number;
  y0n: number;
  y1n: number;
};

export type PdfLine = {
  pageIndex: number;
  items: PdfTextItem[];
  text: string;
  bbox: PdfBBox;
  // normalized, origin top-left
  x0n: number;
  x1n: number;
  y0n: number;
  y1n: number;
  yMid: number;
  fontSize: number;
  maxAbsRotationRad: number;
  rotatedFraction: number;
  // structural line features
  approxCellCount: number;
  cellXs: number[]; // normalized x-centers of detected "cells"
};

export type PdfColumn = {
  pageIndex: number;
  columnIndex: number;
  x0n: number;
  x1n: number;
  lines: PdfLine[];
};

export type PdfBlock = {
  pageIndex: number;
  columnIndex: number;
  blockIndex: number;
  type: PdfBlockType;
  bbox: PdfBBox;
  x0n: number;
  x1n: number;
  y0n: number;
  y1n: number;
  text: string;
  lines: PdfLine[];

  // Inclusion/exclusion per spec
  included: boolean;
  excludeReason?: PdfExcludeReason;
  confidence: number; // 0..1 (used for ambiguity policy)

  // For anchoring/token mapping
  tokens?: string[];
  tokenKeys?: string[];
  tokenRange?: { start: number; end: number }; // in flattened token stream
};

export type PdfExclusionLogEntry = {
  pageIndex: number;
  columnIndex: number;
  blockIndex: number;
  type: PdfBlockType;
  reason: PdfExcludeReason;
  confidence: number;
  bbox: PdfBBox;
  excerpt: string;
};

export type PdfNarrativeIndex = {
  pageCount: number;
  pages: {
    pageIndex: number;
    pageWidth: number;
    pageHeight: number;
    bodyFontSize: number;
    columns: PdfColumn[];
    blocks: PdfBlock[]; // all blocks (included + excluded)
  }[];

  // Flattened narrative
  fullText: string;
  tokens: string[];
  tokenMeta: Array<{ pageIndex: number; columnIndex: number; blockIndex: number }>;

  exclusions: PdfExclusionLogEntry[];

  // Structural markers
  isLikelyScholarly: boolean;
  referencesHardStopTokenIndex?: number;
};

export type PdfSelectionContext = {
  pageIndex: number;
  columnIndex: number;
  blockIndex: number;
  // Approximate selection position in page coords (normalized)
  xMidN: number;
  yMidN: number;
};

export type PdfAnchor = {
  pageIndex: number;
  columnIndex: number;
  // Prefer block anchoring, but allow re-resolution if block split/merged.
  blockSignature: string;
  // Token-based hint (token-agnostic matching uses keys, not raw tokens)
  tokenKey: string;
  contextKeys: string[];
  // Optional resolved token index at time of creation
  tokenIndex?: number;
};

/**
 * Minimal PDF.js document surface used by this pipeline.
 *
 * We intentionally do NOT depend on the full PDFDocumentProxy type.
 * Obsidian sometimes supplies a PDF document object that is compatible at
 * runtime but not assignable to pdfjs-dist's exported TS type.
 */
export type PdfPageLike = {
  getTextContent: (params?: any) => Promise<any>;
  getViewport: (params: { scale: number }) => { width: number; height: number };
};

export type PdfDocLike = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<PdfPageLike>;
};
