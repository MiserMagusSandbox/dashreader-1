// src/pdf-parser.ts
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { tokenizeForEngine } from './rsvp-engine';

export type PdfParsePageMap = {
  fullText: string;
  pageTexts: string[];
  pageWordStarts: number[];
};

export type PdfExtractionDebugLine = {
  yNorm: number;
  tokenCountNoBreaks: number;
  norm: string;
  text: string;
};

export type PdfExtractionDebugPage = {
  page: number;
  totalLines: number;
  keptLines: number;
  removedHeaderLines: number;
  removedFooterLines: number;
  headerBand: number;
  footerBand: number;

  topLines: PdfExtractionDebugLine[];
  bottomLines: PdfExtractionDebugLine[];

  removedHeaderSample: PdfExtractionDebugLine[];
  removedFooterSample: PdfExtractionDebugLine[];
};

export type PdfExtractionDebugReport = {
  totalPages: number;
  headerBand: number;
  footerBand: number;
  headerSigs: string[];
  footerSigs: string[];
  pages: PdfExtractionDebugPage[];
};

type PdfLine = {
  text: string;                // output text (may include heading marker)
  norm: string;                // repetition signature (computed from raw line, no markers)
  yNorm: number;               // y / pageHeight
  tokenCountNoBreaks: number;  // engine-token count excluding '\n'
};

export class PdfParser {
  // ---------------------------------------------------------------------------
  // Shared helpers (also used by PdfViewIntegration)
  // ---------------------------------------------------------------------------

  private static percentile(sorted: number[], p: number): number {
    if (!sorted.length) return 0;
    const clamped = Math.max(0, Math.min(1, p));
    const idx = (sorted.length - 1) * clamped;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi) return sorted[lo];
    const w = idx - lo;
    return sorted[lo] * (1 - w) + sorted[hi] * w;
  }

  // Insert whitespace boundaries inside common immunology/biochem “marker chains”
  // so the RSVP engine can start on any component (CD11b+ CD14- HLA-DR- ...).
  // IMPORTANT: PdfViewIntegration must apply the same transform to probes/hints.
  static insertBiomedicalTokenBreaks(input: string): string {
    let s = String(input ?? '');

    // normalize common plus/minus/dash variants first
    s = s
      .replace(/[＋﹢⁺]/g, '+')
      .replace(/[−﹣－⁻]/g, '-')
      .replace(/[‐-‒–—−]/g, '-');

    // 1) Break after '+' when it’s immediately followed by a marker-ish uppercase start.
    //    CD33+CD15 -> CD33+ CD15
    s = s.replace(/([A-Za-z0-9])\+(?=[A-Z])/g, '$1+ ');

    // 2) Break after '-' when it is acting like a “negative marker” separator before another marker.
    //    CD14-HLA -> CD14- HLA
    //    HLA-DR-CD33 -> HLA-DR- CD33   (second '-' only; first is internal)
    const MARKER_PREFIX =
      '(?:CD|HLA|TCR|MHC|CCR|CXCR|IL|IFN|TNF|FC|IG|TLR|MCP|LAMP|TAM)';
    s = s.replace(
      new RegExp(`([A-Z0-9])-(?=(?:${MARKER_PREFIX})[A-Za-z0-9]|[A-Z]{2,}\\d)`, 'g'),
      '$1- '
    );

    // 3) Break after digit-slash when followed by letters (common receptor pairs)
    //    CD47/SIRP -> CD47/ SIRP
    s = s.replace(/(\d)\/(?=[A-Za-z])/g, '$1/ ');

    return s;
  }

  private static cleanupLineText(s: string): string {
    let out = String(s ?? '');

    // Replace common PDF private-use glyphs (PUA) that show as tofu/squares.
    // This fixes “FIRST”/“specific”/“filters”/etc and makes token matching stable.
    const replacePua = (x: string): string => {
      // targeted fixes first (JWHT “coecients” case)
      x = x.replace(/\bcoe\uE04Ccients\b/g, 'coefficients');
      x = x.replace(/\bcoe\uE04Ccient\b/g, 'coefficient');

      // ligature-ish PUA seen in your reports
      x = x
        .replace(/[\uE004\uE053\uE0AE]/g, 'ff')
        .replace(/[\uE007]/g, 'ffi')
        .replace(/[\uE054\uE0B1]/g, 'ffi')
        .replace(/[\uE005\uE04A\uE04C\uE04D\uE055\uE0AF]/g, 'fi')
        .replace(/\uE006/g, '/')

        // a few math-ish PUA that appear in your reports (optional but harmless)
        .replace(/\uE036/g, '≠')
        .replace(/\uE068/g, '⟨')
        .replace(/\uE069/g, '⟩')
        .replace(/\uE000/g, 'Δ');

      return x;
    };

    out = replacePua(out);

    // Strip inline watermark tails that get merged into body lines (OUP, etc.)
    out = out.replace(/\s*[-–—]?\s*Downloaded from https?:\/\/\S.*$/i, '');

    // Fix common PDF glyphs that render as missing squares in the RSVP view font.
    out = out
      .replace(/\u00AD/g, '') // soft hyphen
      .replace(/ﬀ/g, 'ff')
      .replace(/ﬁ/g, 'fi')
      .replace(/ﬂ/g, 'fl')
      .replace(/ﬃ/g, 'ffi')
      .replace(/ﬄ/g, 'ffl');

    out = out
      .replace(/[\s\u00A0]+/g, ' ')
      .replace(/\s+([,.;:!?\])}])/g, '$1')
      .replace(/([\[(\{])\s+/g, '$1')
      .replace(/\s+([\-‐-‒–—])/g, '$1');

    // CRITICAL: prevent glued “)next” / “]next” / “}next”
    try {
      out = out.replace(/([\)\]\}])(?=[\p{L}\p{N}])/gu, '$1 ');
    } catch {
      out = out.replace(/([\)\]\}])(?=[A-Za-z0-9])/g, '$1 ');
    }
    // Make biomarker chains startable anywhere (must match PdfViewIntegration probes/hints)
    out = PdfParser.insertBiomedicalTokenBreaks(out);

    return out.trim();
  }

  private static isBoilerplateLine(line: string): boolean {
    const t = String(line ?? '').trim();
    if (!t) return true;

    // Lone page number
    if (/^\d{1,4}$/.test(t)) return true;

    // “Page X of Y” styles
    if (/^page\s+\d+\s+of\s+\d+$/i.test(t)) return true;
    if (/^\d+\s+of\s+\d+$/i.test(t)) return true;

    const tc = PdfParser.countTokensLikeEngineNoBreaks(t);

    // Download / access watermark
    if (/^downloaded\s+from\b/i.test(t) && /https?:\/\//i.test(t) && tc <= 16) return true;

    // Standalone URL / DOI lines (short)
    const hasUrl = /https?:\/\//i.test(t) || /\bwww\./i.test(t);
    const hasDoi = /\bdoi\b/i.test(t) || /dx\.doi\.org/i.test(t) || /\b10\.\d{4,9}\/\S+/i.test(t);
    if ((hasUrl || hasDoi) && tc <= 14) return true;

    // ISSN lines
    if ((/\bissn\b/i.test(t) || /\b\d{4}-\d{3}[\dxX]\b/.test(t)) && tc <= 14) return true;

    // Email / corresponding author lines (short)
    if ((/@/.test(t) || /\b(e-?mail|corresponding author|correspondence)\b/i.test(t)) && tc <= 18) return true;

    // Copyright / license lines (short)
    if ((/[©]/.test(t) || /\bcopyright\b/i.test(t) || /\ball rights reserved\b/i.test(t) || /\blicen[cs]e\b/i.test(t)) && tc <= 26) {
      return true;
    }

    return false;
  }

  private static normaliseForRepetition(s: string): string {
    const base = String(s ?? '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, ' ')
      .replace(/\d+/g, '#')
      .replace(/[“”‘’]/g, "'")
      .replace(/[‐-‒–—]/g, '-');

    try {
      return base
        .replace(/[^\p{L}\p{N}\s#\-\(\)\[\]\{\}\.,;:!?/+=*<>^_%|\\]/gu, '')
        .trim();
    } catch {
      // Fallback if unicode property escapes ever fail
      return base
        .replace(/[^a-z0-9\s#\-\(\)\[\]\{\}\.,;:!?/+=*<>^_%|\\]/g, '')
        .trim();
    }
  }

  private static computeHeaderFooterSignatureSets(
    pagesLines: PdfLine[][],
    opts: { headerBand?: number; footerBand?: number; maxTokens?: number; edgeLines?: number } = {}
  ) {
    const headerBand = opts.headerBand ?? 0.8;
    const footerBand = opts.footerBand ?? 0.2;

    const maxTokens = opts.maxTokens ?? 40;
    const edgeLines = opts.edgeLines ?? 6;

    const nPages = pagesLines.length;

    // Backstop global thresholds (local runs are the primary signal).
    const minHeaderOccur = Math.max(3, Math.ceil(nPages * 0.12));
    const minFooterOccur = Math.max(2, Math.ceil(nPages * 0.08));

    // Canonicalize odd/even page-number placement:
    // "# optimization" and "optimization #" -> "optimization"
    const canonicalize = (rawNorm: string): string => {
      const parts = String(rawNorm ?? '').trim().split(/\s+/).filter(Boolean);
      if (!parts.length) return String(rawNorm ?? '').trim();

      let i = 0;
      let j = parts.length - 1;
      while (i <= j && parts[i] === '#') i++;
      while (j >= i && parts[j] === '#') j--;

      const out = parts.slice(i, j + 1).join(' ').trim();
      return out || String(rawNorm ?? '').trim();
    };

    const isJunkCanon = (canon: string): boolean => {
      const s = String(canon ?? '').trim();
      if (!s) return true;

      const tokCount = PdfParser.countTokensLikeEngineNoBreaks(s);

      // Reject tiny garbage; allow single-word real headers like "Optimization".
      if (tokCount === 1) {
        if (s.length < 8) return true;
      } else {
        if (tokCount < 2) return true;
      }

      if (s.length < 6) return true;

      const compact = s.replace(/\s+/g, '');
      if (!compact) return true;

      let alphaNum = 0;
      try {
        for (const ch of compact) if (/\p{L}|\p{N}/u.test(ch)) alphaNum++;
      } catch {
        for (const ch of compact) if (/[A-Za-z0-9]/.test(ch)) alphaNum++;
      }

      if (alphaNum / compact.length < 0.3) return true;
      return false;
    };

    type Stats = {
      count: number;

      lastAny: number;
      curAny: number;
      maxAny: number;

      lastParity: [number, number];
      curParity: [number, number];
      maxParity: [number, number];
    };

    const mkStats = (): Stats => ({
      count: 0,
      lastAny: -999999,
      curAny: 0,
      maxAny: 0,
      lastParity: [-999999, -999999],
      curParity: [0, 0],
      maxParity: [0, 0],
    });

    const update = (m: Map<string, Stats>, canon: string, page1: number) => {
      let st = m.get(canon);
      if (!st) {
        st = mkStats();
        m.set(canon, st);
      }

      st.count++;

      // consecutive pages
      if (st.lastAny === page1 - 1) st.curAny++;
      else st.curAny = 1;
      st.lastAny = page1;
      st.maxAny = Math.max(st.maxAny, st.curAny);

      // consecutive in same parity (page-2)
      const p = page1 % 2;
      if (st.lastParity[p] === page1 - 2) st.curParity[p]++;
      else st.curParity[p] = 1;
      st.lastParity[p] = page1;
      st.maxParity[p] = Math.max(st.maxParity[p], st.curParity[p]);
    };

    const headerStats = new Map<string, Stats>(); // canon -> stats
    const footerStats = new Map<string, Stats>();

    const headerCanonToRaw = new Map<string, Set<string>>(); // canon -> raw norms
    const footerCanonToRaw = new Map<string, Set<string>>();

    for (let idx = 0; idx < pagesLines.length; idx++) {
      const pageNum = idx + 1;
      const lines = pagesLines[idx];

      const topBand = lines.filter((l) => l.yNorm >= headerBand);
      const botBand = lines.filter((l) => l.yNorm <= footerBand);

      const headerCandidates = (topBand.length ? topBand : lines.slice(0, edgeLines))
        .filter((l) => l.tokenCountNoBreaks <= maxTokens);

      const footerCandidates = (botBand.length ? botBand : lines.slice(Math.max(0, lines.length - edgeLines)))
        .filter((l) => l.tokenCountNoBreaks <= maxTokens);

      const seenH = new Set<string>();
      const seenF = new Set<string>();

      for (const ln of headerCandidates) {
        const canon = canonicalize(ln.norm);
        if (isJunkCanon(canon)) continue;

        if (!headerCanonToRaw.has(canon)) headerCanonToRaw.set(canon, new Set());
        headerCanonToRaw.get(canon)!.add(ln.norm);

        seenH.add(canon);
      }

      for (const ln of footerCandidates) {
        const canon = canonicalize(ln.norm);
        if (isJunkCanon(canon)) continue;

        if (!footerCanonToRaw.has(canon)) footerCanonToRaw.set(canon, new Set());
        footerCanonToRaw.get(canon)!.add(ln.norm);

        seenF.add(canon);
      }

      for (const canon of seenH) update(headerStats, canon, pageNum);
      for (const canon of seenF) update(footerStats, canon, pageNum);
    }

    const acceptHeader = (st: Stats): boolean => {
      const maxParity = Math.max(st.maxParity[0], st.maxParity[1]);
      return st.maxAny >= 2 || maxParity >= 2 || st.count >= minHeaderOccur;
    };

    const acceptFooter = (st: Stats): boolean => {
      const maxParity = Math.max(st.maxParity[0], st.maxParity[1]);
      return st.maxAny >= 2 || maxParity >= 2 || st.count >= minFooterOccur;
    };

    const headerSigs = new Set<string>();
    const footerSigs = new Set<string>();

    for (const [canon, st] of headerStats.entries()) {
      if (!acceptHeader(st)) continue;
      const raws = headerCanonToRaw.get(canon);
      if (!raws) continue;
      for (const r of raws) headerSigs.add(r);
    }

    for (const [canon, st] of footerStats.entries()) {
      if (!acceptFooter(st)) continue;
      const raws = footerCanonToRaw.get(canon);
      if (!raws) continue;
      for (const r of raws) footerSigs.add(r);
    }

    return { headerBand, footerBand, headerSigs, footerSigs, edgeLines };
  }

  private static looksLikeHeading(line: string, avgFont: number, bodyFont: number): { level: number } | null {
    const t = String(line ?? '').trim();
    if (!t) return null;

    // Avoid obvious running headers like "... 67" (page number at end)
    if (/\s\d{1,4}$/.test(t) && t.length < 120) return null;

    const wordCount = PdfParser.countTokensLikeEngineNoBreaks(t);
    if (wordCount === 0) return null;
    if (wordCount > 20) return null;

    // Numeric headings (e.g., "2", "2.6", "2.6.1")
    const m = t.match(/^(\d+(?:\.\d+){0,5})\s+\S/);
    if (m) {
      const dotCount = (m[1].match(/\./g) ?? []).length;
      const level = Math.min(6, Math.max(1, dotCount + 1));
      return { level };
    }

    // Short title-case-ish lines with larger font than body
    const endsWithPeriod = /[.!?]$/.test(t);
    const startsUpper = /^[A-Z]/.test(t);
    const fontBoost = bodyFont > 0 ? avgFont / bodyFont : 1;

    if (!endsWithPeriod && startsUpper && wordCount <= 10 && fontBoost >= 1.12) {
      return { level: 3 };
    }

    return null;
  }

  private static buildLinesFromTextContent(page: any, content: any): PdfLine[] {
    const items = (content?.items ?? []) as any[];
    if (!items.length) return [];

    type It = { str: string; x: number; y: number; w: number; x2: number; font: number };
    const parsed: It[] = [];

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

      const font = Math.max(Math.hypot(a, b), Math.hypot(c, d), Math.abs(d), 0);
      const w = Number(it?.width ?? 0);
      const x2 = x + (Number.isFinite(w) ? w : 0);
      parsed.push({ str: s, x, y, w, x2, font });
    }

    if (!parsed.length) return [];

    const viewport = page.getViewport({ scale: 1 });
    const pageH = Number(viewport?.height ?? 1) || 1;

    // Body font estimate (median over all page text)
    const allFonts = parsed
      .map((p) => p.font)
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
    const bodyFont = PdfParser.percentile(allFonts, 0.5);

    const tolY = Math.max(1.5, bodyFont * 0.35);

    // Group into "raw lines" by Y (PDF coords: higher Y = closer to top)
    parsed.sort((a, b) => (b.y - a.y) || (a.x - b.x));
    const rawLines: { y: number; items: It[] }[] = [];
    for (const it of parsed) {
      const last = rawLines[rawLines.length - 1];
      if (!last || Math.abs(last.y - it.y) > tolY) rawLines.push({ y: it.y, items: [it] });
      else last.items.push(it);
    }

    // ---------------------------------------------------------------------
    // Split each raw line into one or more "segments" separated by a large
    // X gap (typical two-column gutter). This prevents left+right columns
    // being merged into one line string.
    // ---------------------------------------------------------------------
    const splitGap = Math.max(24, bodyFont * 6.5);
    const splitRawLineIntoSegments = (ln: { y: number; items: It[] }): { y: number; items: It[] }[] => {
      const its = [...ln.items].sort((a, b) => a.x - b.x);
      const segs: { y: number; items: It[] }[] = [];
      let cur: It[] = [];
      let prevX2: number | null = null;

      for (const it of its) {
        if (!cur.length) {
          cur = [it];
          prevX2 = Number(it.x2 ?? it.x ?? 0);
          continue;
        }

        const gap = Number(it.x ?? 0) - Number(prevX2 ?? it.x ?? 0);
        if (Number.isFinite(gap) && gap > splitGap) {
          segs.push({ y: ln.y, items: cur });
          cur = [it];
        } else {
          cur.push(it);
        }

        prevX2 = Math.max(Number(prevX2 ?? 0), Number(it.x2 ?? it.x ?? 0));
      }

      if (cur.length) segs.push({ y: ln.y, items: cur });
      return segs;
    };

    // Start from the segmented lines list; later we will re-order by columns.
    const lines: { y: number; items: It[] }[] = [];
    for (const rl of rawLines) lines.push(...splitRawLineIntoSegments(rl));
    // Keep a stable initial order for subsequent merging passes.
    lines.sort((a, b) => (b.y - a.y) || ((a.items[0]?.x ?? 0) - (b.items[0]?.x ?? 0)));

    // ------------------------------------------------------------
    // Merge superscript/subscript-like short lines (dim/bright/neg/+/-/2+)
    // back into nearby baseline lines (prevents detached "lines").
    // ------------------------------------------------------------
    const normSupText = (s: string): string =>
      String(s ?? '')
        .replace(/[＋﹢⁺]/g, '+')
        .replace(/[−﹣－⁻]/g, '-')
        .replace(/[¹]/g, '1')
        .replace(/[²]/g, '2')
        .replace(/[³]/g, '3')
        .replace(/[\u2070-\u2079]/g, (c) => String('⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(c)))
        .trim();

    const lineJoined = (its: It[]): string =>
      normSupText(its.map((x: It) => String(x.str ?? '')).join('')).replace(/\s+/g, '');

    const medianFont = (its: It[]): number => {
      const a = its.map((x) => Number(x.font ?? 0)).filter((v) => Number.isFinite(v) && v > 0).sort((x, y) => x - y);
      if (!a.length) return 0;
      return a[Math.floor(a.length / 2)];
    };

    const lineXRange = (its: It[]): { x1: number; x2: number } => {
      let x1 = Number.POSITIVE_INFINITY;
      let x2 = Number.NEGATIVE_INFINITY;
      for (const it of its) {
        x1 = Math.min(x1, Number(it.x ?? 0));
        x2 = Math.max(x2, Number(it.x2 ?? it.x ?? 0));
      }
      if (!Number.isFinite(x1)) x1 = 0;
      if (!Number.isFinite(x2)) x2 = x1;
      return { x1, x2 };
    };

    const isChargeRun = (t: string): boolean => {
      if (!t) return false;
      if (!/[+-]/.test(t)) return false;
      return /^[0-9+-]+$/.test(t);
    };

    const isSupKeyword = (t: string): boolean => {
      const low = String(t ?? '').toLowerCase();
      return low === 'dim' || low === 'dimm' || low === 'bright' || low === 'neg' || low === 'pos';
    };

    const isSupModifierCompact = (t: string): boolean => {
      const low = String(t ?? '').toLowerCase();
      // allow: dim, ^neg, -/dim, /pos, -neg, etc. (tight to avoid false merges)
      if (isSupKeyword(low)) return true;
      return (
        /^[-+\/^]{0,3}(dim|dimm|bright|neg|pos)$/.test(low) ||
        /^(dim|dimm|bright|neg|pos)[-+\/^]{0,3}$/.test(low)
      );
    };

    const isSuperscriptLikeLine = (ln: { y: number; items: It[] }): boolean => {
      const compact = lineJoined(ln.items);
      if (!compact) return false;
      if (compact.length > 10) return false;

      const f = medianFont(ln.items);
      const base = bodyFont || 10;
      const ratio = (f > 0 && base > 0) ? (f / base) : 1;

      if (isChargeRun(compact)) return ratio <= 1.35;              // charges can be close to base size
      if (isSupModifierCompact(compact)) return ratio <= 1.10;     // dim/bright/neg/pos can be near base
      return false;
    };

    // For each sup-like line, merge into nearest baseline line within a small neighborhood.
    const maxNeighbor = 4;
    for (let i = 0; i < lines.length; i++) {
      const sup = lines[i];
      if (!isSuperscriptLikeLine(sup)) continue;

      const supX = lineXRange(sup.items);
      const supFont = Math.max(medianFont(sup.items) || 0, bodyFont || 10);

      let bestJ: number | null = null;
      let bestDy = Number.POSITIVE_INFINITY;

      const j0 = Math.max(0, i - maxNeighbor);
      const j1 = Math.min(lines.length - 1, i + maxNeighbor);

      for (let j = j0; j <= j1; j++) {
        if (j === i) continue;
        const baseLn = lines[j];
        if (isSuperscriptLikeLine(baseLn)) continue;

        const dy = Math.abs((sup.y ?? 0) - (baseLn.y ?? 0));
        const baseFont = Math.max(medianFont(baseLn.items) || 0, bodyFont || 10);
        const maxDy = Math.max(tolY * 4.0, Math.max(baseFont, supFont) * 2.6);
        if (dy > maxDy) continue;

        const baseX = lineXRange(baseLn.items);
        const pad = Math.max(10, Math.max(baseFont, supFont) * 2.2);
        const overlaps = !(supX.x2 < baseX.x1 - pad || supX.x1 > baseX.x2 + pad);
        if (!overlaps) continue;

        if (dy < bestDy) {
          bestDy = dy;
          bestJ = j;
        }
      }

      if (bestJ != null) {
        const baseLn = lines[bestJ];
        baseLn.items.push(...sup.items);
        baseLn.items.sort((a, b) => a.x - b.x);

        lines.splice(i, 1);
        i -= 1;
      }
    }

    // ---------------------------------------------------------------------
    // Column-aware ordering
    // ---------------------------------------------------------------------
    const pageW = Number(viewport?.width ?? 1) || 1;

    const lineXRange2 = (its: It[]): { x1: number; x2: number; xMid: number; w: number } => {
      let x1 = Number.POSITIVE_INFINITY;
      let x2 = Number.NEGATIVE_INFINITY;
      for (const it of its) {
        x1 = Math.min(x1, Number(it.x ?? 0));
        x2 = Math.max(x2, Number(it.x2 ?? it.x ?? 0));
      }
      if (!Number.isFinite(x1)) x1 = 0;
      if (!Number.isFinite(x2)) x2 = x1;
      const w = Math.max(0, x2 - x1);
      const xMid = x1 + w / 2;
      return { x1, x2, xMid, w };
    };

    const isFullWidthSegment = (its: It[]): boolean => {
      const r = lineXRange2(its);
      if (!pageW || pageW <= 1) return false;
      if (r.w >= pageW * 0.78) return true;
      // also treat near-full spans as full-width even if slightly clipped
      if (r.x1 <= pageW * 0.10 && r.x2 >= pageW * 0.90) return true;
      return false;
    };

    const detectTwoColumns = (lns: { y: number; items: It[] }[]): { splitX: number } | null => {
      if (!pageW || pageW <= 1) return null;

      // Use segment midpoints, ignoring full-width segments and tiny fragments.
      const mids: number[] = [];
      for (const ln of lns) {
        if (isFullWidthSegment(ln.items)) continue;
        const joined = lineJoined(ln.items);
        if (!joined || joined.length < 2) continue;

        const r = lineXRange2(ln.items);
        if (r.w >= pageW * 0.72) continue;

        mids.push(r.xMid);
      }

      if (mids.length < 18) return null; // not enough evidence

      mids.sort((a, b) => a - b);
      let bestGap = 0;
      let bestIdx = -1;
      for (let i = 0; i < mids.length - 1; i++) {
        const g = mids[i + 1] - mids[i];
        if (g > bestGap) {
          bestGap = g;
          bestIdx = i;
        }
      }

      const gapThresh = Math.max(pageW * 0.18, bodyFont * 10);
      if (bestIdx < 0 || bestGap < gapThresh) return null;

      const leftCount = bestIdx + 1;
      const rightCount = mids.length - leftCount;
      if (leftCount < 7 || rightCount < 7) return null;

      const splitX = (mids[bestIdx] + mids[bestIdx + 1]) / 2;
      return Number.isFinite(splitX) ? { splitX } : null;
    };

    const orderByColumns = (lns: { y: number; items: It[] }[]): { y: number; items: It[] }[] => {
      const cols = detectTwoColumns(lns);
      if (!cols) {
        // Single-column / unknown: preserve the existing top-to-bottom order.
        return [...lns].sort((a, b) => (b.y - a.y) || (lineXRange2(a.items).x1 - lineXRange2(b.items).x1));
      }

      const splitX = cols.splitX;

      const seps = lns
        .filter((ln) => isFullWidthSegment(ln.items))
        .sort((a, b) => b.y - a.y);

      const isLeft = (ln: { y: number; items: It[] }): boolean => lineXRange2(ln.items).xMid < splitX;
      const sortYX = (a: { y: number; items: It[] }, b: { y: number; items: It[] }) =>
        (b.y - a.y) || (lineXRange2(a.items).x1 - lineXRange2(b.items).x1);

      // No full-width separators: emit down left column, then down right column.
      if (!seps.length) {
        const left = lns.filter((ln) => !isFullWidthSegment(ln.items) && isLeft(ln)).sort(sortYX);
        const right = lns.filter((ln) => !isFullWidthSegment(ln.items) && !isLeft(ln)).sort(sortYX);
        return [...left, ...right];
      }

      // Banded ordering: between full-width separators, read left then right.
      const out: { y: number; items: It[] }[] = [];
      const nonSep = lns.filter((ln) => !isFullWidthSegment(ln.items));

      // Group separators that sit on the same y band.
      const sepGroups: { y: number; lines: { y: number; items: It[] }[] }[] = [];
      for (const s of seps) {
        const last = sepGroups[sepGroups.length - 1];
        if (!last || Math.abs(last.y - s.y) > tolY * 0.8) sepGroups.push({ y: s.y, lines: [s] });
        else last.lines.push(s);
      }

      let prevY = Number.POSITIVE_INFINITY;
      const emitBand = (topY: number, bottomY: number) => {
        const band = nonSep.filter((ln) => ln.y < topY && ln.y > bottomY);
        const left = band.filter((ln) => isLeft(ln)).sort(sortYX);
        const right = band.filter((ln) => !isLeft(ln)).sort(sortYX);
        out.push(...left, ...right);
      };

      for (const g of sepGroups) {
        emitBand(prevY, g.y);
        g.lines.sort(sortYX);
        out.push(...g.lines);
        prevY = g.y;
      }

      emitBand(prevY, Number.NEGATIVE_INFINITY);
      return out;
    };

    const orderedLines = orderByColumns(lines);

    const out: PdfLine[] = [];

    for (const ln of orderedLines) {
      ln.items.sort((a, b) => a.x - b.x);

      const avgFont = ln.items.reduce((acc, it) => acc + (it.font || 0), 0) / Math.max(1, ln.items.length);
      const base = (bodyFont || avgFont || 10);

      // baseline y for detecting raised/lowered items after merge
      const ys = ln.items.map((it) => Number(it.y ?? 0)).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
      const baseY = ys.length ? ys[Math.floor(ys.length / 2)] : Number(ln.y ?? 0);
      const supDy = Math.max(tolY * 0.55, base * 0.22);

      const wordGap = Math.max(0.6, base * 0.10);
      const glyphGap = Math.max(0.9, base * 0.16);
      const afterClosingGap = Math.max(0.25, base * 0.04);

      const startsWord = (str: string): boolean => {
        const t = String(str ?? '');
        try { return /^[\p{L}\p{N}]/u.test(t); } catch { return /^[A-Za-z0-9]/.test(t); }
      };

      const normSup = (x: string): string =>
        String(x ?? '')
          .replace(/[＋﹢⁺]/g, '+')
          .replace(/[−﹣－⁻]/g, '-')
          .replace(/[¹]/g, '1')
          .replace(/[²]/g, '2')
          .replace(/[³]/g, '3')
          .replace(/[\u2070-\u2079]/g, (c) => String('⁰¹²³⁴⁵⁶⁷⁸⁹'.indexOf(c)));

      const isChargeChar = (x: string): boolean => {
        const t = normSup(x).trim();
        return t === '+' || t === '-';
      };

      const isSupDigit = (x: string): boolean => /^\d+$/.test(normSup(x).trim());

      const isSupKeywordToken = (x: string): boolean => {
        const t = normSup(x).trim();
        if (!t) return false;
        const low = t.toLowerCase();
        if (isSupKeyword(low)) return true;
        return (
          /^[-+\/^]{0,3}(dim|dimm|bright|neg|pos)$/.test(low) ||
          /^(dim|dimm|bright|neg|pos)[-+\/^]{0,3}$/.test(low)
        );
      };

      const endsWithAlphaNum = (x: string): boolean => {
        const t = String(x ?? '');
        try { return /[\p{L}\p{N}]$/u.test(t); } catch { return /[A-Za-z0-9]$/.test(t); }
      };

      const isDashChar = (c: string): boolean => /[‐-‒–—−]/.test(c);
      const prevEndsWithDash = (x: string): boolean => {
        const t = String(x ?? '');
        const ch = t.charAt(Math.max(0, t.length - 1));
        return isDashChar(ch);
      };

      const isSlashChar = (c: string): boolean => c === '/' || c === '⁄' || c === '∕' || c === '／';
      const endsWithCharge = (x: string): boolean => /[a-z0-9][+\-]$/i.test(String(x ?? ''));
      const looksLikeCdMarker = (x: string): boolean => /^cd[-]?\d{1,3}/i.test(String(x ?? ''));

      let s = '';
      let prevX2: number | null = null;
      let prevPart = '';
      let prevWasSupWord = false;
      let prevWasSupItem = false;

      for (let idx = 0; idx < ln.items.length; idx++) {
        const it = ln.items[idx];
        const partRaw = String(it.str ?? '');
        if (!partRaw) continue;

        const part = normSup(partRaw);

        // sup detection at item-level (raised/lowered or small font)
        const curFont = Number(it.font ?? 0);
        const curIsSmall = curFont > 0 && base > 0 && (curFont / base) <= 0.92;
        const dyFromBase = Number(it.y ?? 0) - baseY;
        const curIsRaised = dyFromBase > supDy;
        const curIsLowered = (-dyFromBase) > supDy;
        const curIsSupItem = curIsSmall || curIsRaised || curIsLowered;

        const curIsSupWord = isSupKeywordToken(part);

        // lookahead to detect "-/dim" style clusters so '-' isn't treated as a charge glued to the base token
        const next = idx + 1 < ln.items.length ? ln.items[idx + 1] : null;
        const nextPart = next ? normSup(String(next.str ?? '')) : '';
        const nextGap = next ? (Number(next.x ?? 0) - Number(it.x2 ?? it.x ?? 0)) : Number.POSITIVE_INFINITY;
        const dashIsPrefixCluster =
          part === '-' &&
          curIsSupItem &&
          (
            nextPart === '/' ||
            nextPart.startsWith('/') ||
            isSupKeywordToken(nextPart)
          ) &&
          nextGap <= (glyphGap * 1.6);

        if (prevX2 != null) {
          const gap = it.x - prevX2;

          const prevIsSingle = prevPart.length <= 1;
          const curIsSingle = part.length <= 1;

          const prevEndsWithClosing = /[\)\]\}.,;:!?]$/.test(prevPart);
          const prevEndsWithOpening = /[\(\[\{]$/.test(prevPart);

          let threshold = (prevIsSingle || curIsSingle) ? glyphGap : wordGap;

          if (prevEndsWithClosing && startsWord(part)) threshold = Math.min(threshold, afterClosingGap);
          if (prevEndsWithOpening) threshold = Math.max(threshold, glyphGap);

          // glue close-bracket + dash (and dash + suffix) so (CCL)-3 and (..)—3 remain single tokens
          const glueCloseDash =
            /[\)\]\}]$/.test(prevPart) &&
            part.length >= 1 &&
            isDashChar(part.charAt(0)) &&
            gap <= Math.max(glyphGap, wordGap) * 1.6;

          const glueDashSuffix =
            prevEndsWithDash(prevPart) &&
            startsWord(part) &&
            gap <= Math.max(glyphGap, wordGap) * 1.8;

          // glue charge markers/digits to previous token (CD16+, Ca2+ etc.)
          // but DO NOT treat '-' as charge if it starts a "-/dim" cluster
          const glueCharge =
            endsWithAlphaNum(prevPart) &&
            !dashIsPrefixCluster &&
            (isChargeChar(part) || isSupDigit(part)) &&
            (curIsSupItem || gap <= Math.max(glyphGap, wordGap) * 1.35);

          // Glue "+/-" cluster onto the preceding marker (CD16+/-), avoiding spaces around '/'.
          const glueChargeClusterSlash =
            endsWithCharge(prevPart) &&
            isSlashChar(part) &&
            gap <= Math.max(glyphGap, wordGap) * 1.6;

          const glueChargeClusterAfterSlash =
            isSlashChar(prevPart) &&
            (part === '+' || part === '-') &&
            gap <= Math.max(glyphGap, wordGap) * 1.6;

          // Force a split after a digit-slash marker prefix so SIRPα becomes a real token:
          // "CD47/" + "SIRPα" => "CD47/ SIRPα"
          const forceBreakAfterDigitSlash =
            /[0-9]\/$/.test(prevPart) &&
            startsWord(part) &&
            gap <= Math.max(glyphGap, wordGap) * 2.2;

          // Force a split between back-to-back markers when the first ends in a charge:
          // "CD47+" + "CD20" => "CD47+ CD20"
          const forceBreakAfterChargeBeforeMarker =
            endsWithCharge(prevPart) &&
            looksLikeCdMarker(part) &&
            gap <= Math.max(glyphGap, wordGap) * 2.2;

          // start a superscript-modifier cluster (space before "-/dim", "^neg", etc.)
          const splitSupPrefixClusterStart =
            endsWithAlphaNum(prevPart) &&
            dashIsPrefixCluster &&
            gap <= Math.max(glyphGap, wordGap) * 1.6;

          // glue prefix pieces inside a superscript modifier: "-/dim", "^neg"
          const glueSupPrefix =
            (prevPart === '-' || prevPart === '/' || prevPart === '^') &&
            (curIsSupWord || isSupKeywordToken(part)) &&
            (curIsSupItem || gap <= Math.max(glyphGap, wordGap) * 1.35);

          // split superscript words as their own token: "CD56 dim"
          const splitSupWord =
            endsWithAlphaNum(prevPart) &&
            curIsSupWord &&
            (curIsSupItem || (curFont > 0 && base > 0 && (curFont / base) <= 1.06)) &&
            gap <= (Math.max(glyphGap, wordGap) * 1.6);

          // prevent "dimCD16" gluing when whitespace is minimal
          const forceBreakAfterSupWord =
            prevWasSupWord &&
            prevWasSupItem &&
            !curIsSupItem &&
            startsWord(part) &&
            gap <= Math.max(glyphGap, wordGap) * 1.6;

          if (
            forceBreakAfterSupWord ||
            splitSupPrefixClusterStart ||
            splitSupWord ||
            forceBreakAfterDigitSlash ||
            forceBreakAfterChargeBeforeMarker
          ) {
            s += ' ';
          } else if (
            !glueCharge &&
            !glueSupPrefix &&
            !glueCloseDash &&
            !glueDashSuffix &&
            !glueChargeClusterSlash &&
            !glueChargeClusterAfterSlash
          ) {
            if (gap > threshold) s += ' ';
          }
        }

        s += part;

        prevX2 = it.x2;
        prevPart = part;
        prevWasSupWord = curIsSupWord;
        prevWasSupItem = curIsSupItem;
      }

      s = PdfParser.cleanupLineText(s);
      if (!s) continue;
      if (PdfParser.isBoilerplateLine(s)) continue;

      const sigSource = s;
      const norm = PdfParser.normaliseForRepetition(sigSource);
      if (!norm) continue;

      const tokenCountNoBreaks = PdfParser.countTokensLikeEngineNoBreaks(sigSource);

      const yNorm = ln.y / pageH;
      const inHeaderFooterBand = yNorm >= 0.82 || yNorm <= 0.18;

      const heading = inHeaderFooterBand ? null : PdfParser.looksLikeHeading(s, avgFont, bodyFont);
      if (heading) {
        const firstSpace = s.indexOf(' ');
        if (firstSpace === -1) s = `[H${heading.level}]` + s;
        else {
          const first = s.slice(0, firstSpace);
          const rest = s.slice(firstSpace + 1);
          s = `[H${heading.level}]${first} ${rest}`;
        }
      }

      out.push({
        text: s,
        norm,
        yNorm,
        tokenCountNoBreaks,
      });
    }

    return out;
  }

  static extractPageTextFromTextContent(page: any, content: any): string {
    const lines = PdfParser.buildLinesFromTextContent(page, content);
    return lines.map((l) => l.text).join('\n').trim();
  }

  static normalizeExtractedText(text: string): string {
    return String(text ?? '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  static async parseToPlainTextWithPageMap(
    data: ArrayBuffer,
    opts?: { maxPages?: number }
  ): Promise<PdfParsePageMap> {
    const maxPages = opts?.maxPages ?? 200;
    const uint8 = new Uint8Array(data);

    const loadingTask = getDocument({
      data: uint8,
      disableWorker: true,
    } as any);

    const pdf = await (loadingTask as any).promise;

    return await PdfParser.parsePdfDocumentToPlainTextWithPageMap(pdf, opts);
  }

  static async parseToPlainText(data: ArrayBuffer, opts?: { maxPages?: number }): Promise<string> {
    const res = await PdfParser.parseToPlainTextWithPageMap(data, opts);
    return res.fullText;
  }

  // ---------------------------------------------------------------------------
  // Tokenization helpers
  // ---------------------------------------------------------------------------
  // IMPORTANT: Use the RSVP engine tokenizer (single source of truth).
  static readonly LINEBREAK_MARKER = '\n';

  static tokenizeLikeEngine(text: string): string[] {
    const toks = tokenizeForEngine(String(text ?? ''));
    // Avoid weird empty-text case: tokenizeForEngine('') => [''] but PDF pipeline wants [].
    return toks.length === 1 && toks[0] === '' ? [] : toks;
  }

  static countTokensLikeEngine(text: string): number {
    return PdfParser.tokenizeLikeEngine(text).length;
  }

  static countTokensLikeEngineNoBreaks(text: string): number {
    return PdfParser.tokenizeLikeEngine(text).filter((t) => t && t !== PdfParser.LINEBREAK_MARKER).length;
  }

  static async parsePdfDocumentToPlainTextWithPageMap(
    pdf: any,
    opts?: { maxPages?: number }
  ): Promise<PdfParsePageMap> {
    const maxPages = opts?.maxPages ?? 200;
    const totalPages = Math.min(Number(pdf?.numPages ?? 0), maxPages);
    if (!totalPages) return { fullText: '', pageTexts: [], pageWordStarts: [] };

    const pagesLines: PdfLine[][] = [];

    // Pass 1: build lines for every page
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      pagesLines.push(PdfParser.buildLinesFromTextContent(page, content));
    }

    // Learn repeating header/footer signatures across pages.
    // NOTE: This relies on your computeHeaderFooterSignatureSets implementation.
    const sigs: any = PdfParser.computeHeaderFooterSignatureSets(pagesLines, {
      headerBand: 0.80,
      footerBand: 0.20,
      maxTokens: 40,
      edgeLines: 6,
    });

    const headerSigs: Set<string> = sigs.headerSigs ?? new Set<string>();
    const footerSigs: Set<string> = sigs.footerSigs ?? new Set<string>();
    const edgeLines: number = typeof sigs.edgeLines === 'number' ? sigs.edgeLines : 6;

    // Pass 2: filter + emit
    const pageTexts: string[] = [];
    const pageWordStarts: number[] = [];
    let wordCursor = 0;

        const stripHeadingMarker = (s: string): string => String(s ?? '').replace(/^\[H\d+\]/, '').trim();

    const collapse = (s: string): string =>
      stripHeadingMarker(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

    const isTocLine = (s: string): boolean => {
      const t = stripHeadingMarker(s);
      // dotted leader + page number
      return /\.{5,}\s*\d{1,4}\s*$/.test(t);
    };

    const isPortalChromeLine = (ln: PdfLine): boolean => {
      const t = stripHeadingMarker(ln.text);
      if (!t) return false;
      if (isTocLine(t)) return false;

      // only treat as chrome near the top of page 1
      if (ln.yNorm < 0.72) return false;

      // generic “platform/nav” cues (not publisher names)
      if (/^contents\s+lists\s+available\s+at\b/i.test(t)) return true;
      if (collapse(t).includes('journalhomepage')) return true;

      // URL-ish / navigation paths
      if (/https?:\/\//i.test(t) || /\bwww\./i.test(t)) return true;
      if (/\/locate\//i.test(t)) return true;

      // spaced-out “w w w . …” style chrome lines
      if (/\bw\s*w\s*w\b/i.test(t) && (t.match(/\s/g)?.length ?? 0) > 10) return true;

      return false;
    };

    const isAffiliationLine = (ln: PdfLine): boolean => {
      const t = stripHeadingMarker(ln.text);
      if (!t) return false;
      if (isTocLine(t)) return false;

      // affiliation blocks usually sit under title/authors on page 1
      if (ln.yNorm < 0.60) return false;

      if (/\b(department|university|institute|school|faculty|hospital|centre|center|laborator(?:y|ies)|division|unit)\b/i.test(t)) {
        return true;
      }

      // address-ish: multiple commas + digits (street numbers, postal codes, etc.)
      const commas = (t.match(/,/g) ?? []).length;
      const digits = (t.match(/\d/g) ?? []).length;
      if (commas >= 2 && digits >= 2) return true;

      // common postal-code patterns (generic)
      if (/\b\d{5}(?:-\d{4})?\b/.test(t)) return true; // US ZIP
      if (/\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(t)) return true; // UK-ish

      return false;
    };

    const findBodyStartIndexPage1 = (lines: PdfLine[]): number => {
      // Look for Abstract/Introduction (including spaced-out headings or merged “article info abstract”)
      for (let k = 0; k < lines.length; k++) {
        const c = collapse(lines[k].text);
        if (c === 'abstract' || c === 'introduction') return k;

        // Elsevier-style merge: “article info abstract”
        if (c.includes('abstract') && (c.includes('articleinfo') || c.includes('articlehistory'))) return k;
      }
      // fallback: don’t over-strip; only treat a small prefix as “front matter”
      return Math.min(lines.length, 12);
    };

    const filterPage1FrontMatter = (lines: PdfLine[]): PdfLine[] => {
      const start = findBodyStartIndexPage1(lines);
      const out: PdfLine[] = [];

      for (let k = 0; k < lines.length; k++) {
        const ln = lines[k];

        if (k < start) {
          if (isPortalChromeLine(ln)) continue;
          if (isAffiliationLine(ln)) continue;

          // Fix merged “article info abstract” heading line by rewriting it to “Abstract”
          const c = collapse(ln.text);
          if (c.includes('articleinfo') && c.includes('abstract') && ln.tokenCountNoBreaks <= 6) {
            out.push({
              ...ln,
              text: '[H3]Abstract',
              norm: PdfParser.normaliseForRepetition('Abstract'),
              tokenCountNoBreaks: PdfParser.countTokensLikeEngineNoBreaks('Abstract'),
            });
            continue;
          }
        }

        out.push(ln);
      }

      return out;
    };

    for (let i = 0; i < pagesLines.length; i++) {
      const lines = pagesLines[i];

      // Column-aware extraction reorders lines, so we must not rely on the first/last N
      // *indices* to decide header/footer removal. Prefer yNorm bands; fall back to
      // edge indices only when the band contains no lines at all.
      const hasTopBand = lines.some((ln) => ln.yNorm >= sigs.headerBand);
      const hasBotBand = lines.some((ln) => ln.yNorm <= sigs.footerBand);

      const kept = lines.filter((ln, idx) => {
        const isHeaderRegion = (ln.yNorm >= sigs.headerBand) || (!hasTopBand && idx < edgeLines);
        const isFooterRegion = (ln.yNorm <= sigs.footerBand) || (!hasBotBand && idx >= Math.max(0, lines.length - edgeLines));

        // Remove only if: (a) in edge region AND (b) matches a learned signature.
        if (isHeaderRegion && headerSigs.has(ln.norm)) return false;
        if (isFooterRegion && footerSigs.has(ln.norm)) return false;

        return true;
      });

      const kept2 = (i === 0) ? filterPage1FrontMatter(kept) : kept;
      const cleaned = PdfParser.normalizeExtractedText(kept2.map((l) => l.text).join('\n'));

      pageWordStarts.push(wordCursor);
      wordCursor += PdfParser.countTokensLikeEngine(cleaned);
      pageTexts.push(cleaned);

      if (i < pagesLines.length - 1) {
        wordCursor += PdfParser.countTokensLikeEngine('\n\n');
      }
    }

    const fullText = PdfParser.normalizeExtractedText(pageTexts.join('\n\n'));
    return { fullText, pageTexts, pageWordStarts };
  }

  static async parsePdfDocumentToDebugReport(
    pdfDoc: any,
    opts?: { maxPages?: number; sampleLines?: number }
  ): Promise<PdfExtractionDebugReport> {
    const maxPages = opts?.maxPages ?? 60;
    const sampleLines = opts?.sampleLines ?? 10;

    const totalPages = Math.min(Number(pdfDoc?.numPages ?? 0), maxPages);
    if (!totalPages) {
      return {
        totalPages: 0,
        headerBand: 0,
        footerBand: 0,
        headerSigs: [],
        footerSigs: [],
        pages: [],
      };
    }

    const pagesLines: PdfLine[][] = [];

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const content = await page.getTextContent();
      pagesLines.push(PdfParser.buildLinesFromTextContent(page, content));
    }

    const { headerSigs, footerSigs, headerBand, footerBand } =
      PdfParser.computeHeaderFooterSignatureSets(pagesLines, {
        headerBand: 0.80,
        footerBand: 0.20,
        maxTokens: 40,
      });

    const toDbg = (ln: PdfLine): PdfExtractionDebugLine => ({
      yNorm: Number(ln.yNorm.toFixed(4)),
      tokenCountNoBreaks: ln.tokenCountNoBreaks,
      norm: ln.norm,
      text: ln.text,
    });

    const pages: PdfExtractionDebugPage[] = [];

    for (let i = 0; i < pagesLines.length; i++) {
      const lines = pagesLines[i];

      const removedHeader = lines.filter((ln) => ln.yNorm >= headerBand && headerSigs.has(ln.norm));
      const removedFooter = lines.filter((ln) => ln.yNorm <= footerBand && footerSigs.has(ln.norm));

      const kept = lines.filter((ln) => {
        if (ln.yNorm >= headerBand && headerSigs.has(ln.norm)) return false;
        if (ln.yNorm <= footerBand && footerSigs.has(ln.norm)) return false;
        return true;
      });

      const sortedTop = [...lines].sort((a, b) => (b.yNorm - a.yNorm));
      const sortedBottom = [...lines].sort((a, b) => (a.yNorm - b.yNorm));

      pages.push({
        page: i + 1,
        totalLines: lines.length,
        keptLines: kept.length,
        removedHeaderLines: removedHeader.length,
        removedFooterLines: removedFooter.length,
        headerBand,
        footerBand,
        topLines: sortedTop.slice(0, sampleLines).map(toDbg),
        bottomLines: sortedBottom.slice(0, sampleLines).map(toDbg),
        removedHeaderSample: removedHeader.slice(0, sampleLines).map(toDbg),
        removedFooterSample: removedFooter.slice(0, sampleLines).map(toDbg),
      });
    }

    return {
      totalPages,
      headerBand,
      footerBand,
      headerSigs: Array.from(headerSigs),
      footerSigs: Array.from(footerSigs),
      pages,
    };
  }
}
