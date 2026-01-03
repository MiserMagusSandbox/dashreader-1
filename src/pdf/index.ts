// src/pdf/index.ts
// Public entrypoints for the spec-compliant PDF pipeline.

export type {
  PdfDocLike,
  PdfPageLike,
  PdfAnchor,
  PdfBlock,
  PdfBlockType,
  PdfBBox,
  PdfColumn,
  PdfExcludeReason,
  PdfExclusionLogEntry,
  PdfLine,
  PdfNarrativeIndex,
  PdfSelectionContext,
  PdfTextItem,
} from './types';

export { parsePdfToNarrativeIndex, parsePdfDocumentToNarrativeIndex } from './pipeline';

// Selection / anchoring helpers (block+column scoped).
export { hitTestBlock, hitTestSelection } from './hit-test';
export { resolveSelectionToTokenIndex } from './selection';
export { createAnchorFromTokenIndex, resolveAnchor } from './anchor';
