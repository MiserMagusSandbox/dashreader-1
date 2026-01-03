// src/pdf/utils.ts
// Small, deterministic, token-agnostic helpers used throughout the PDF pipeline.

import type { PdfBBox } from './types';

export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

export function quantize(n: number, step: number): number {
  if (!Number.isFinite(n)) return 0;
  const s = Math.max(1e-9, Math.abs(step));
  return Math.round(n / s) * s;
}

export function bboxUnion(a: PdfBBox, b: PdfBBox): PdfBBox {
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

export function bboxArea(b: PdfBBox): number {
  return Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);
}

export function bboxIntersects(a: PdfBBox, b: PdfBBox): boolean {
  return !(a.x1 <= b.x0 || b.x1 <= a.x0 || a.y1 <= b.y0 || b.y1 <= a.y0);
}

export function median(sortedAsc: number[]): number {
  if (!sortedAsc.length) return 0;
  const n = sortedAsc.length;
  const mid = Math.floor(n / 2);
  return n % 2 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

export function percentile(sortedAsc: number[], p01: number): number {
  if (!sortedAsc.length) return 0;
  const p = Math.max(0, Math.min(1, p01));
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAsc[lo];
  const w = idx - lo;
  return sortedAsc[lo] * (1 - w) + sortedAsc[hi] * w;
}

// Normalization for repetition detection: purely structural, no vocabulary lists.
// - lowercases
// - collapses whitespace
// - replaces digit runs with '#'
// - strips most punctuation
export function normaliseForRepetition(raw: string): string {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  return s
    .replace(/\d+/g, '#')
    .replace(/[^\p{L}\p{N}# ]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Token key normalization for anchor matching.
// Designed to be tolerant of PDF tokenization quirks; avoids domain heuristics.
export function normaliseTokenKey(raw: string): string {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  // strip leading/trailing punctuation
  const core = s
    .replace(/^[^\p{L}\p{N}]+/gu, '')
    .replace(/[^\p{L}\p{N}]+$/gu, '')
    .toLowerCase();
  return core;
}

export function stableSortBy<T>(arr: T[], key: (t: T) => number): T[] {
  return arr
    .map((v, i) => ({ v, i, k: key(v) }))
    .sort((a, b) => (a.k - b.k) || (a.i - b.i))
    .map((o) => o.v);
}
