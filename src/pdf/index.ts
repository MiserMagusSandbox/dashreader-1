// src/pdf/index.ts
// Public entrypoints for the spec-compliant PDF pipeline.

export type {
  PdfAnchor,
  PdfBlock,
  PdfBlockType,
  PdfBBox,
  PdfColumn,
  PdfDocLike,
  PdfExcludeReason,
  PdfExclusionLogEntry,
  PdfLine,
  PdfNarrativeIndex,
  PdfPageLike,
  PdfSelectionContext,
  PdfTextItem,
} from './types';

export { parsePdfToNarrativeIndex, parsePdfDocumentToNarrativeIndex } from './pipeline';

// Selection / anchoring helpers (block+column scoped).
export { hitTestBlock } from './hit-test';
export { resolveSelectionToTokenIndex } from './selection';
export { createAnchorFromTokenIndex, resolveAnchor } from './anchor';
