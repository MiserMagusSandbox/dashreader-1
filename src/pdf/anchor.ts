// src/pdf/anchor.ts
// Deterministic, column-aware anchors for PDF narrative tokens.

import type { PdfAnchor, PdfNarrativeIndex, PdfBlock } from './types';
import { normaliseForRepetition, normaliseTokenKey } from './utils';

function blockSignature(b: PdfBlock): string {
  const sig = normaliseForRepetition(b.text);
  // include coarse geometric bucket so reordering doesn't cross columns/blocks
  const y = Math.round(b.y0n * 100);
  const x = Math.round(b.x0n * 100);
  return `${x}:${y}:${sig.slice(0, 60)}`;
}

export function createAnchorFromTokenIndex(index: PdfNarrativeIndex, tokenIndex: number): PdfAnchor | null {
  if (!Number.isFinite(tokenIndex)) return null;
  const ti = Math.max(0, Math.min(tokenIndex, index.tokens.length - 1));
  const meta = index.tokenMeta[ti];
  if (!meta) return null;
  const page = index.pages.find((p) => p.pageIndex === meta.pageIndex);
  const block = page?.blocks.find((b) => b.columnIndex === meta.columnIndex && b.blockIndex === meta.blockIndex);
  if (!block || !block.tokenKeys || !block.tokenRange) return null;

  const local = ti - block.tokenRange.start;
  const key = block.tokenKeys[local] ?? normaliseTokenKey(index.tokens[ti]);
  if (!key) return null;

  // capture small token-key context, skipping empty keys.
  const ctx: string[] = [];
  const offsets = [-2, -1, 1, 2, 3];
  for (const off of offsets) {
    const k = block.tokenKeys[local + off];
    if (k) ctx.push(k);
    if (ctx.length >= 4) break;
  }

  return {
    pageIndex: meta.pageIndex,
    columnIndex: meta.columnIndex,
    blockSignature: blockSignature(block),
    tokenKey: key,
    contextKeys: ctx,
    tokenIndex: ti,
  };
}

function scoreBlockSignature(anchorSig: string, candidate: PdfBlock): number {
  const candSig = blockSignature(candidate);
  if (candSig === anchorSig) return 1;
  // token-agnostic similarity: longest common prefix length / max
  const a = anchorSig;
  const b = candSig;
  let n = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) break;
    n++;
  }
  return n / Math.max(1, Math.max(a.length, b.length));
}

function scoreTokenHit(localIdx: number, keys: string[], anchor: PdfAnchor): number {
  const key = keys[localIdx];
  if (!key) return 0;
  let score = key === anchor.tokenKey ? 1 : 0;
  if (!anchor.contextKeys?.length) return score;

  const window = 4;
  for (const ck of anchor.contextKeys) {
    let found = false;
    for (let d = 1; d <= window; d++) {
      if (keys[localIdx - d] === ck || keys[localIdx + d] === ck) {
        score += 0.25;
        found = true;
        break;
      }
    }
    if (!found) score -= 0.05;
  }

  return score;
}

export function resolveAnchor(index: PdfNarrativeIndex, anchor: PdfAnchor): number | null {
  const page = index.pages.find((p) => p.pageIndex === anchor.pageIndex);
  if (!page) return null;

  const candidates = page.blocks.filter(
    (b) => b.included && b.columnIndex === anchor.columnIndex && b.tokenRange && b.tokenKeys
  );
  if (!candidates.length) return null;

  // Choose best block by signature.
  let bestBlock: PdfBlock | null = null;
  let bestSig = -1;
  for (const b of candidates) {
    const s = scoreBlockSignature(anchor.blockSignature, b);
    if (s > bestSig) {
      bestSig = s;
      bestBlock = b;
    }
  }
  const blk = bestBlock ?? candidates[0];
  if (!blk.tokenKeys || !blk.tokenRange) return null;

  // Find best token hit within block.
  let bestIdx = -1;
  let bestScore = -1e9;
  for (let i = 0; i < blk.tokenKeys.length; i++) {
    if (!blk.tokenKeys[i]) continue;
    const s = scoreTokenHit(i, blk.tokenKeys, anchor);
    if (s > bestScore) {
      bestScore = s;
      bestIdx = i;
    }
  }

  if (bestIdx < 0) return null;
  if (bestScore < 0.6) return null;
  return blk.tokenRange.start + bestIdx;
}
