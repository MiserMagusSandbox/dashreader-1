// src/pdf-view-integration.ts
// Encapsulates all PDF-view specific logic (selection caching, active view targeting,
// and text extraction via Obsidian's embedded PDF.js instance).

import type { App, Plugin, TFile } from 'obsidian';
import { PdfParser } from './pdf-parser';

export type PdfPageMap = {
  fullText: string;
  pageTexts: string[];
  pageWordStarts: number[];
};

type PdfAnchorCandidate = {
  globalIndex: number;
  inPageIndex?: number;
  token: string;
  matchKey: string;
  distanceToPreferred?: number;
  contextScore?: number;
};

type PdfLaunchDiagnostics = {
  selectionNormalized: string;
  selectionMatchKey: string;
  selectionPage?: number;
  selectionWordHintInPage?: number;
  selectionYInPage?: number;
  selectionProbe?: string;
  selectionContextKeys?: string[];
  preferredEngineIndex?: number;
  preferredSource?: string;
  pageWordCount?: number;
  pageEngineBase?: number;
  candidates: PdfAnchorCandidate[];
  chosenIndex?: number;
  chosenReason?: string;
};

export class PdfViewIntegration {
  private lastPdfSelectionText = '';

  private lastPdfSelectionRawText = '';
  private lastPdfSelectionFilePath = '';
  private lastPdfSelectionEventType: string = '';

  private lastPdfSelectionAt = 0;
  private lastPdfSelectionPage: number | undefined = undefined;

  private lastPdfSelectionWordHintInPage: number | undefined = undefined;
  private lastPdfSelectionProbe = '';
  private lastPdfSelectionYInPage: number | undefined = undefined;

  private pdfSelectionTargets = new Set<EventTarget>();

  private captureRafId: number | null = null;
  private pendingCaptureEvent: Event | undefined = undefined;

  // Workaround: Obsidian can move focus away from a PDF leaf after closing the command palette,
  // which causes commands to run against the wrong view. Track the most-recent PDF leaf briefly.
  private lastPdfLeaf: any | null = null;
  private lastPdfLeafAt = 0;

  constructor(private app: App, private plugin: Plugin) {}

  public setupSelectionCaching(): void {
    this.plugin.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        const view: any = (this.app.workspace as any).activeLeaf?.view;
        const type = view?.getViewType?.() ?? view?.type;
        if (type === 'pdf') {
          this.lastPdfLeaf = (this.app.workspace as any).activeLeaf ?? null;
          this.lastPdfLeafAt = Date.now();
          this.schedulePdfSelectionTargetScan();
        }
      })
    );

    // If a PDF is already active when the plugin loads, attach listeners immediately.
    if (this.getActivePdfViewAny()) {
      this.schedulePdfSelectionTargetScan();
    }
  }

  private stripChargeSuffixKey(key: string): string {
    if (!key) return key;
    if (key.endsWith('plusminus')) return key.slice(0, -8);
    if (key.endsWith('plus')) return key.slice(0, -4);
    if (key.endsWith('minus')) return key.slice(0, -5);
    return key;
  }

  private stripSuperscriptSuffixKey(tokKey: string, rawTok: string): string | undefined {
    if (!tokKey) return undefined;
    const m = tokKey.match(/(plusminus|plus|minus|dim|dimm|bright|neg|pos|\d{1,3})$/);
    if (!m) return undefined;
    const base = tokKey.slice(0, -m[1].length);
    if (!base) return undefined;

    const supRange = /[\u2070-\u209F]/;
    const rawHasSup = supRange.test(rawTok) || /\^/.test(rawTok);
    const looksSupSuffix = rawHasSup || m[1].length <= 3;
    if (!looksSupSuffix) return undefined;

    return base;
  }

  private isLikelyAcronymFragment(raw: string): boolean {
    const s = String(raw ?? '').trim();
    if (!s) return false;

    let core = s;
    try {
      core = core.replace(/^[^\p{L}\p{N}]+/gu, '').replace(/[^\p{L}\p{N}]+$/gu, '');
    } catch {
      core = core.replace(/^[^A-Za-z0-9]+/g, '').replace(/[^A-Za-z0-9]+$/g, '');
    }

    if (core.length < 2 || core.length > 14) return false;

    if (/^CD\d/i.test(core)) return true;

    // Handle Greek letters mixed with caps/digits (e.g. FcγRIIa/b)
    if (/[Α-Ωα-ω]/.test(core) && (/[A-Z]/.test(core) || /\d/.test(core))) return true;

    const upper = (core.match(/[A-Z]/g) ?? []).length;
    const lower = (core.match(/[a-z]/g) ?? []).length;
    const hasDigit = /\d/.test(core);

    // pure caps acronyms, or caps+digits with maybe one lowercase suffix (CD11b)
    if (upper >= 2 && lower === 0) return true;
    if (upper >= 1 && hasDigit && lower <= 1) return true;
    if (/^[A-Z]{2,}\d/.test(core)) return true;

    return false;
  }

  // Marker chains: CD11b+CD14-HLA-DR-... or FcγRIIa/b etc.
  // We treat these as "noisy" even if PDF.js returns them as a single whitespace-token,
  // because users must be able to start from ANY internal segment they double-click.
  private looksLikeMarkerChainToken(raw: string): boolean {
    const s0 = String(raw ?? '').trim();
    if (!s0) return false;

    const core = s0
      .replace(/^\[(?:H\d+|CALLOUT:[^\]]+)\]/i, '')
      .replace(/^[\(\[\{（［｛]+/, '')
      .replace(/[\)\]\}）］｝]+$/, '')
      .trim();

    if (!core) return false;
    if (!/[\/\\+\-‐-‒–—−]/.test(core)) return false;

    const parts = core.split(/[\/\\+\-‐-‒–—−]+/).map(p => p.trim()).filter(Boolean);
    if (parts.length < 2) return false;

    return parts.some(p =>
      this.isLikelyAcronymFragment(p) ||
      /[0-9]/.test(p) ||
      /[Α-Ωα-ω]/.test(p) ||
      /[A-Z]/.test(p)
    );
  }

  // Given a token and a local caret offset, return the segment under the caret,
  // using marker-chain delimiters as boundaries.
  private extractMarkerChainSegment(token: string, localOffset: number): string {
    const s = String(token ?? '');
    if (!s) return s;

    const isDelim = (c: string): boolean => /[\/\\+\-‐-‒–—−]/.test(c);

    let i = Math.max(0, Math.min(localOffset ?? 0, s.length));
    if (i === s.length && i > 0) i -= 1;

    // If caret lands on a delimiter, pick nearest non-delimiter (prefer right on ties).
    if (i >= 0 && i < s.length && isDelim(s.charAt(i))) {
      let left = i;
      while (left > 0 && isDelim(s.charAt(left))) left--;

      let right = i;
      while (right < s.length && isDelim(s.charAt(right))) right++;

      const leftOk = left >= 0 && left < s.length && !isDelim(s.charAt(left));
      const rightOk = right >= 0 && right < s.length && !isDelim(s.charAt(right));

      if (rightOk && (!leftOk || (right - i) <= (i - left))) i = right;
      else if (leftOk) i = left;
    }

    let l = i;
    while (l > 0 && !isDelim(s.charAt(l - 1))) l--;

    let r = i;
    while (r < s.length && !isDelim(s.charAt(r))) r++;

    return s.slice(l, r);
  }

  private isAmbiguousAcronymSelection(selection: string, matchKey: string): boolean {
    const raw = String(selection ?? '').trim();
    if (!raw || !matchKey) return false;

    if (this.isLikelyAcronymFragment(raw)) return true;

    // Very short all-caps/digit tokens are ambiguous even if not caught above.
    if (/^[A-Z\d]{2,6}$/.test(raw)) return true;
    if (/^[a-z\d]{2,4}$/.test(matchKey) && /^[A-Z]/.test(raw)) return true;

    return false;
  }

  private getTokenKeyAtOffset(tokens: string[], startIndex: number, offset: number): string | undefined {
    if (!Number.isFinite(startIndex) || offset === 0) return undefined;
    const norm = (t: string) => PdfParser.normalizePdfTokenForMatch(t);
    const dir = offset > 0 ? 1 : -1;
    let remaining = Math.abs(offset);
    let idx = startIndex;
    while (idx >= 0 && idx < tokens.length) {
      idx += dir;
      if (idx < 0 || idx >= tokens.length) break;
      const tok = tokens[idx];
      if (!tok || tok === PdfParser.LINEBREAK_MARKER) continue;
      const key = norm(tok);
      if (!key) continue;
      remaining -= 1;
      if (remaining === 0) return key;
    }
    return undefined;
  }

  private captureContextTokens(
    tokens: string[],
    anchorIndex: number | undefined,
    max = 3
  ): { offset: number; key: string }[] {
    if (!Number.isFinite(anchorIndex)) return [];
    const captured: { offset: number; key: string }[] = [];
    // Prefer right-context first (offsets +1, +2, ...), then left.
    for (let step = 1; step <= tokens.length && captured.length < max; step++) {
      const key = this.getTokenKeyAtOffset(tokens, anchorIndex as number, step);
      if (key) captured.push({ offset: step, key });
    }
    for (let step = 1; step <= tokens.length && captured.length < max; step++) {
      const key = this.getTokenKeyAtOffset(tokens, anchorIndex as number, -step);
      if (key) captured.push({ offset: -step, key });
    }
    return captured.slice(0, max);
  }

  private tokenMatchesSelectionKey(token: string, selectionKey: string): boolean {
    const sel = String(selectionKey ?? '').trim();
    if (!sel) return false;

    const rawTok = String(token ?? '').trim();
    if (!rawTok || rawTok === PdfParser.LINEBREAK_MARKER) return false;

    const tokKey = PdfParser.normalizePdfTokenForMatch(rawTok);
    if (!tokKey) return false;

    // Symmetric charge handling:
    // - existing behavior: token has +/- but selection doesn't  (CD38+ token vs "CD38" selection)
    // - missing behavior (your current break): selection has +/- but token doesn't (common due to PDF.js bleed/join)
    const selNoCharge = this.stripChargeSuffixKey(sel);
    const selHasCharge = selNoCharge !== sel;

    const keyMatchesSel = (k: string): boolean => {
      if (!k) return false;
      if (k === sel) return true;

      const kNo = this.stripChargeSuffixKey(k);
      const kHasCharge = kNo !== k;

      // token has charge, selection doesn't
      if (!selHasCharge && kHasCharge && kNo === sel) return true;

      // selection has charge, token doesn't
      if (selHasCharge && !kHasCharge && k === selNoCharge) return true;

      // exactly one side has charge: compare bases (prevents plus-vs-minus when both sides have charge)
      if (kNo && selNoCharge && kNo === selNoCharge && kHasCharge !== selHasCharge) return true;

      return false;
    };

    if (keyMatchesSel(tokKey)) return true;

    const tokNoCharge = this.stripChargeSuffixKey(tokKey);

    // Allow selecting the base when superscript/subscript suffixes are glued to the token
    const supBase =
      this.stripSuperscriptSuffixKey(tokNoCharge, rawTok) ??
      this.stripSuperscriptSuffixKey(tokKey, rawTok);
    if (supBase && keyMatchesSel(supBase)) return true;

    // Allow selecting just the acronym part for common suffix patterns:
    // CCL vs CCL-3, IP3 vs IP3-independent, TAM vs TAM-mediated
    // IMPORTANT: if selection gained +/- via normalization, use its base for this rule.
    const selPrefix = selHasCharge ? selNoCharge : sel;
    if (selPrefix.length >= 2 && tokNoCharge.startsWith(selPrefix)) {
      const rest = tokNoCharge.slice(selPrefix.length);

      const core = rawTok
        .replace(/^\[(?:H\d+|CALLOUT:[^\]]+)\]/i, '')
        .replace(/^[\(\[\{（［｛]+/, '')
        .replace(/[\)\]\}）］｝]+$/, '');
      const firstFrag = core.split(/[\/\\\-\u00AD\u2010\u2011\u2012\u2013\u2014\u2212\uFE63\uFF0D\u207B\u208B]/)[0] ?? '';
      const isAcr = this.isLikelyAcronymFragment(firstFrag);

      if (/^-[0-9]{1,4}$/.test(rest)) return true;           // -3, -10, etc
      if (/^-[ivx]{1,6}$/.test(rest)) return true;           // -II, -IV, etc
      if (/^-[a-z]{2,24}$/.test(rest) && isAcr) return true; // -mediated, -independent, ...
    }

    // Slash-separated tokens: FcγRIIa/b where selection might be only one side
    {
      const core = rawTok
        .replace(/^\[(?:H\d+|CALLOUT:[^\]]+)\]/i, '')
        .replace(/^[\(\[\{（［｛]+/, '')
        .replace(/[\)\]\}）］｝]+$/, '');
      const parts = core.split(/[\/\\]/).filter(Boolean);
      if (parts.length >= 2) {
        for (const p of parts) {
          const k = PdfParser.normalizePdfTokenForMatch(p);
          if (k && keyMatchesSel(k)) return true;
        }
      }
    }

    // Hyphenated tokens: allow matching ANY marker-ish segment (caps/digits/Greek), not just the first
    {
      const core = rawTok
        .replace(/^\[(?:H\d+|CALLOUT:[^\]]+)\]/i, '')
        .replace(/^[\(\[\{（［｛]+/, '')
        .replace(/[\)\]\}）］｝]+$/, '');

      const parts = core
        .split(/[\-\u00AD\u2010\u2011\u2012\u2013\u2014\u2212\uFE63\uFF0D\u207B\u208B]/)
        .map(s => s.trim())
        .filter(Boolean);

      if (parts.length >= 2) {
        for (const p of parts) {
          const markerish =
            this.isLikelyAcronymFragment(p) ||
            /[0-9]/.test(p) ||
            /[A-Z]/.test(p) ||
            /[Α-Ωα-ω]/.test(p);

          if (!markerish) continue;

          const k = PdfParser.normalizePdfTokenForMatch(p);
          if (k && keyMatchesSel(k)) return true;
        }
      }
    }

    return false;
  }

  // Used by main.ts hard-guard / debug paths
  public tokenMatchesSelectionToken(token: string, selectionToken: string): boolean {
    const selKey = PdfParser.normalizePdfTokenForMatch(String(selectionToken ?? '').trim());
    if (!selKey) return false;
    return this.tokenMatchesSelectionKey(token, selKey);
  }

  public getActivePdfViewAny(): any | null {
    const ws: any = this.app.workspace;
    const activeLeaf: any = ws?.activeLeaf ?? null;
    const activeView: any = activeLeaf?.view ?? null;
    const activeType = activeView?.getViewType?.() ?? activeView?.type;

    if (activeType === 'pdf') {
      this.lastPdfLeaf = activeLeaf;
      this.lastPdfLeafAt = Date.now();
      return activeView;
    }

    // Workaround: Obsidian can move focus away from a PDF leaf after closing the command palette.
    // If the PDF leaf was active very recently, treat it as the active PDF for command execution.
    if (this.lastPdfLeaf && Date.now() - this.lastPdfLeafAt < 4000) {
      const v: any = this.lastPdfLeaf?.view ?? null;
      const t = v?.getViewType?.() ?? v?.type;
      if (t === 'pdf') return v;
    }

    return null;
  }

  private getPdfFileFromView(pv: any | null): TFile | null {
    if (!pv) return null;
    return pv?.file ?? pv?.viewer?.child?.file ?? pv?.viewer?.file ?? null;
  }

  public getActivePdfFile(): TFile | null {
    return this.getPdfFileFromView(this.getActivePdfViewAny());
  }

  public getActiveFilePreferPdf(fallback: TFile | null): TFile | null {
    return this.getActivePdfFile() ?? fallback;
  }

  public getCachedPdfSelection(): {
    text: string;
    rawText?: string;
    filePath?: string;
    eventType?: string;
    page?: number;
    wordHintInPage?: number;
    probe?: string;
    yInPage?: number;
    at?: number;
    ageMs?: number;
  } {
    const probe = (this.lastPdfSelectionProbe ?? '').trim();
    const at =
      typeof this.lastPdfSelectionAt === 'number' && this.lastPdfSelectionAt > 0
        ? this.lastPdfSelectionAt
        : undefined;
    const ageMs = at ? Math.max(0, Date.now() - at) : undefined;

    return {
      text: (this.lastPdfSelectionText ?? '').trim(),
      rawText: this.lastPdfSelectionRawText ?? '',
      filePath: this.lastPdfSelectionFilePath || undefined,
      eventType: this.lastPdfSelectionEventType || undefined,
      page: this.lastPdfSelectionPage,
      wordHintInPage: this.lastPdfSelectionWordHintInPage,
      probe: probe || undefined,
      yInPage: typeof this.lastPdfSelectionYInPage === 'number' ? this.lastPdfSelectionYInPage : undefined,
      at,
      ageMs,
    };
  }

  /**
   * Returns the CURRENT PDF selection without using any cached value.
   *
   * This is used by commands where stale selection is unacceptable
   * (e.g. "Read selected text").
   *
   * IMPORTANT: intentionally does NOT fall back to Obsidian internal
   * selection getters, because those can be sticky across deselection.
   */
  public getLivePdfSelection(): {
    text: string;
    rawText?: string;
    filePath?: string;
    page?: number;
    wordHintInPage?: number;
    probe?: string;
    yInPage?: number;
  } {
    const pv: any = this.getActivePdfViewAny();
    if (!pv) return { text: '' };

    const filePath = (() => {
      const f = this.getPdfFileFromView(pv);
      const p = String((f as any)?.path ?? f?.name ?? '').trim();
      return p || undefined;
    })();

    // 1) DOM selection (same document) — ONLY accept if it’s inside the active PDF view.
    const winSel = window.getSelection?.() ?? null;
    const info1 = this.isSelectionWithinActivePdfView(winSel, pv)
      ? this.getSelectionTextAndPage(winSel, pv)
      : { text: '' };

    if (info1.text) {
      return {
        text: (info1.text ?? '').trim(),
        rawText: info1.rawText ?? '',
        filePath,
        page: info1.page,
        wordHintInPage: info1.wordHintInPage,
        probe: (info1.probe ?? '').trim() || undefined,
        yInPage: typeof info1.yInPage === 'number' ? info1.yInPage : undefined,
      };
    }

    // 2) iframe selection (some builds)
    const root: HTMLElement | null = pv?.containerEl ?? null;
    if (root) {
      const iframes = Array.from(root.querySelectorAll('iframe')) as HTMLIFrameElement[];
      for (const iframe of iframes) {
        try {
          const info = this.getSelectionTextAndPage(iframe.contentWindow?.getSelection?.() ?? null, pv);
          if (info.text) {
            return {
              text: (info.text ?? '').trim(),
              rawText: info.rawText ?? '',
              filePath,
              page: info.page,
              wordHintInPage: info.wordHintInPage,
              probe: (info.probe ?? '').trim() || undefined,
              yInPage: typeof info.yInPage === 'number' ? info.yInPage : undefined,
            };
          }
        } catch {
          // ignore
        }
      }
    }

    return { text: '' };
  }

  /**
   * Normalizes a PDF selection for "single-word" commands.
   *
   * PDFs often render footnote/citation markers as a separate token (e.g. "word 1", "word [12]").
   * This helper strips common trailing markers so double-clicking a word behaves as expected.
   */
  public normalizeSingleWordSelection(selection: string): string {
    return PdfParser.normalizeSingleWordSelection(selection);
  }

  private extractTokenAroundOffset(node: Node | null, offset: number): string | undefined {
    // Resolve to a Text node
    const tn: Text | null =
      node && node.nodeType === Node.TEXT_NODE
        ? (node as Text)
        : (() => {
            try {
              const doc = (node as any)?.ownerDocument ?? document;
              const walker = doc.createTreeWalker(node as any, NodeFilter.SHOW_TEXT);
              return (walker?.nextNode() as Text) ?? null;
            } catch {
              return null;
            }
          })();

    if (!tn?.data) return undefined;

    const s = tn.data;
    const isWs = (c: string): boolean =>
      /[\s\u00A0\u2000-\u200A\u200B\u202F\u205F\u2060\u3000\uFEFF]/.test(c);

    let i = Math.max(0, Math.min(offset ?? 0, s.length));
    if (i === s.length && i > 0) i -= 1;

    // If we landed on whitespace (common at token boundaries), choose the nearest non-ws character.
    // Prefer RIGHT on ties so boundary clicks don't drift to the previous token.
    if (i >= 0 && i < s.length && isWs(s.charAt(i))) {
      let left = i;
      while (left > 0 && isWs(s.charAt(left))) left--;

      let right = i;
      while (right < s.length && isWs(s.charAt(right))) right++;

      const leftOk = left >= 0 && left < s.length && !isWs(s.charAt(left));
      const rightOk = right >= 0 && right < s.length && !isWs(s.charAt(right));

      if (rightOk && (!leftOk || (right - i) <= (i - left))) {
        i = right;
      } else if (leftOk) {
        i = left;
      }
    }

    let l = i;
    while (l > 0 && !isWs(s.charAt(l - 1))) l--;

    let r = i;
    while (r < s.length && !isWs(s.charAt(r))) r++;

    const tokRaw = s.slice(l, r);
    let out = tokRaw;

    // If this is a biomarker/marker chain, return the sub-segment under the caret,
    // not the whole chain.
    if (this.looksLikeMarkerChainToken(tokRaw)) {
      out = this.extractMarkerChainSegment(tokRaw, i - l);
    }

    const tok = String(out ?? '').trim();
    return tok || undefined;
  }

  /**
   * Return the single token that was actually clicked (range/caret anchored), even if
   * Selection.toString() bleeds into a neighbour token.
   *
   * NOTE: This is intentionally *not* gated on event.type === 'dblclick' because
   * some Obsidian/PDF.js builds never dispatch a dblclick event to our listeners.
   */
  private getClickedSingleToken(evt?: Event): string | undefined {
    if (!evt) return undefined;

    const accept = (raw: string | undefined): string | undefined => {
      const t = String(raw ?? '').trim();
      if (!t) return undefined;
      const norm = this.normalizeSingleWordSelection(t);
      return this.countTokensLikeEngineNoBreaks(norm) === 1 ? norm : undefined;
    };

    const target: any = (evt as any)?.target ?? null;
    const doc: any = target?.ownerDocument ?? document;

    // 1) caret-from-point first (best signal of what was actually clicked)
    const me: any = evt as any;
    const x = typeof me?.clientX === 'number' ? me.clientX : undefined;
    const y = typeof me?.clientY === 'number' ? me.clientY : undefined;

    if (x != null && y != null) {
      // Firefox-style
      const pos = doc.caretPositionFromPoint?.(x, y);
      if (pos?.offsetNode && typeof pos.offset === 'number') {
        const tok = this.extractTokenAroundOffset(pos.offsetNode, pos.offset);
        const ok = accept(tok);
        if (ok) return ok;
      }

      // WebKit-style
      const range: Range | null = doc.caretRangeFromPoint?.(x, y) ?? null;
      if (range) {
        const tok = this.extractTokenAroundOffset(range.startContainer, range.startOffset);
        const ok = accept(tok);
        if (ok) return ok;
      }
    }

    // 2) Selection range start fallback
    try {
      const sel: any = doc.getSelection?.() ?? window.getSelection?.();
      if (sel && typeof sel.rangeCount === 'number' && sel.rangeCount > 0) {
        const r: Range = sel.getRangeAt(0);
        const tok = this.extractTokenAroundOffset(r.startContainer, r.startOffset);
        const ok = accept(tok);
        if (ok) return ok;
      }
    } catch {
      // ignore
    }

    // 3) Target text last (avoid locking onto whole marker chains when caret info exists)
    const targetText = typeof target?.textContent === 'string' ? target.textContent : undefined;
    const fromTarget = accept(targetText);
    if (fromTarget) return fromTarget;

    return undefined;
  }

  private getParentElementCrossShadow(el: Element | null): Element | null {
    if (!el) return null;
    const p = el.parentElement;
    if (p) return p;
    const root: any = (el as any).getRootNode?.();
    const host: any = root?.host ?? null;
    return host && host instanceof Element ? host : null;
  }

  /**
   * Returns text nodes in DOM order from a "sensible" local container around the selection.
   *
   * Selection expansion needs adjacent text nodes, but `Range.commonAncestorContainer` is often
   * just a single PDF.js `<span>` (one text node). We climb a little to find a container that
   * includes nearby text nodes, without accidentally walking the entire document.
   */
  private getTextNodes(start: Node | null): Text[] {
    const startEl: Element | null =
      !start
        ? null
        : (start as any).nodeType === Node.ELEMENT_NODE
          ? (start as any as Element)
          : ((start as any).parentElement ?? null);

    if (!startEl) return [];

    const looksLikePdfContainer = (el: Element): boolean => {
      const cl: DOMTokenList | undefined = (el as any).classList;
      if (cl?.contains?.('textLayer') || cl?.contains?.('text-layer') || cl?.contains?.('textlayer'))
        return true;

      if (
        cl?.contains?.('page') ||
        cl?.contains?.('pdf-page') ||
        cl?.contains?.('pdfPage') ||
        cl?.contains?.('PDFPageView')
      ) {
        return true;
      }

      const ds: any = (el as any).dataset ?? null;
      if (ds?.pageNumber != null || ds?.page != null || ds?.pageIndex != null) return true;

      if (
        el.getAttribute?.('data-page-number') != null ||
        el.getAttribute?.('data-page') != null ||
        el.getAttribute?.('data-pageindex') != null
      ) {
        return true;
      }

      return false;
    };

    const countTextNodes = (el: Element, cap = 80): number => {
      try {
        const walker = el.ownerDocument?.createTreeWalker?.(el, NodeFilter.SHOW_TEXT);
        if (!walker) return 0;

        let count = 0;
        let n: Node | null = walker.nextNode();
        while (n) {
          count++;
          if (count >= cap) return count;
          n = walker.nextNode();
        }
        return count;
      } catch {
        return 0;
      }
    };

    // Climb until we have enough neighboring text nodes to look left/right.
    let container: Element | null = startEl;
    let depth = 0;
    let best: Element = startEl;
    let bestCount = countTextNodes(startEl, 16);

    while (container && depth < 10 && bestCount < 6 && !looksLikePdfContainer(container)) {
      const p = this.getParentElementCrossShadow(container);
      if (!p) break;
      container = p;

      const c = countTextNodes(container, 32);
      if (c > bestCount) {
        best = container;
        bestCount = c;
      }

      depth++;
    }

    // If we found a known PDF container, prefer it even if it's slightly bigger.
    if (container && looksLikePdfContainer(container)) best = container;

    const out: Text[] = [];
    try {
      const walker = best.ownerDocument?.createTreeWalker?.(best, NodeFilter.SHOW_TEXT);
      let n: Node | null = walker?.nextNode?.() ?? null;
      while (n) {
        out.push(n as Text);
        n = walker?.nextNode?.() ?? null;
      }
    } catch {
      // ignore
    }

    return out;
  }

  /**
   * Returns PDF text-layer text nodes ordered in the same *reading order* as the PDF extractor.
   *
   * Why: DOM order in PDF.js text layers is not reliably reading order on multi-column pages.
   * This ordering is used only for selection anchoring (wordHint/probe), and falls back to
   * DOM order if geometry data is unavailable.
   */
  private getPdfTextNodesInReadingOrder(pageEl: Element): Text[] {
    try {
      const pageRect = (pageEl as HTMLElement).getBoundingClientRect?.();
      if (!pageRect || pageRect.width <= 1 || pageRect.height <= 1) return this.getTextNodes(pageEl);

      const layer: Element | null =
        (pageEl.querySelector?.('.textLayer, .text-layer, .textlayer') as any) ??
        (pageEl as any);

      const spans = Array.from(layer?.querySelectorAll?.('span') ?? []) as HTMLElement[];
      if (!spans.length) return this.getTextNodes(pageEl);

      type DomIt = {
        node: Text;
        text: string;
        x1: number;
        x2: number;
        y: number;
        h: number;
      };

      const items: DomIt[] = [];
      for (const sp of spans) {
        const r = sp.getBoundingClientRect?.();
        if (!r || r.width <= 0 || r.height <= 0) continue;

        const x1 = r.left - pageRect.left;
        const x2 = r.right - pageRect.left;
        const y = r.top - pageRect.top;
        const h = r.height;

        for (let i = 0; i < sp.childNodes.length; i++) {
          const n = sp.childNodes[i];
          if (n?.nodeType !== Node.TEXT_NODE) continue;
          const t = (n as Text).data ?? '';
          if (!t) continue;
          items.push({ node: n as Text, text: t, x1, x2, y, h });
        }
      }

      if (!items.length) return this.getTextNodes(pageEl);

      const pageW = pageRect.width;

      // Median span height as a proxy for "font size" for grouping tolerances.
      const hs = items
        .map((it) => it.h)
        .filter((v) => Number.isFinite(v) && v > 0)
        .sort((a, b) => a - b);
      const bodyH = hs.length ? hs[Math.floor(hs.length / 2)] : 10;
      const tolY = Math.max(1.5, bodyH * 0.45);

      // Group into y-lines (DOM coords: smaller y = closer to top)
      items.sort((a, b) => (a.y - b.y) || (a.x1 - b.x1));
      const rawLines: DomIt[][] = [];
      for (const it of items) {
        const last = rawLines[rawLines.length - 1];
        if (!last || Math.abs(last[0].y - it.y) > tolY) rawLines.push([it]);
        else last.push(it);
      }

      // Split raw lines into segments separated by a large x gap (gutter)
      const splitGap = Math.max(24, bodyH * 6.5, pageW * 0.08);
      type Seg = { y: number; items: DomIt[]; x1: number; x2: number; xMid: number; w: number; full: boolean };
      const segs: Seg[] = [];

      for (const ln of rawLines) {
        ln.sort((a, b) => a.x1 - b.x1);
        let cur: DomIt[] = [];
        let prevX2: number | null = null;

        const flush = () => {
          if (!cur.length) return;
          let x1 = Number.POSITIVE_INFINITY;
          let x2 = Number.NEGATIVE_INFINITY;
          let y = 0;
          for (const it of cur) {
            x1 = Math.min(x1, it.x1);
            x2 = Math.max(x2, it.x2);
            y += it.y;
          }
          y = y / cur.length;
          if (!Number.isFinite(x1)) x1 = 0;
          if (!Number.isFinite(x2)) x2 = x1;
          const w = Math.max(0, x2 - x1);
          const xMid = x1 + w / 2;
          const full = w >= pageW * 0.78 || (x1 <= pageW * 0.10 && x2 >= pageW * 0.90);
          segs.push({ y, items: cur, x1, x2, xMid, w, full });
          cur = [];
          prevX2 = null;
        };

        for (const it of ln) {
          if (!cur.length) {
            cur = [it];
            prevX2 = it.x2;
            continue;
          }
          const gap = it.x1 - Number(prevX2 ?? it.x1);
          if (Number.isFinite(gap) && gap > splitGap) {
            flush();
            cur = [it];
          } else {
            cur.push(it);
          }
          prevX2 = Math.max(Number(prevX2 ?? 0), it.x2);
        }
        flush();
      }

      if (!segs.length) return this.getTextNodes(pageEl);

      const joinedLen = (s: Seg): number => {
        const t = s.items.map((it) => it.text).join('').replace(/[\s\u00A0]+/g, '').trim();
        return t.length;
      };

      // Detect two columns from segment midpoints
      const mids: number[] = [];
      for (const s of segs) {
        if (s.full) continue;
        if (s.w >= pageW * 0.72) continue;
        if (joinedLen(s) < 2) continue;
        mids.push(s.xMid);
      }

      let splitX: number | null = null;
      if (mids.length >= 18) {
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
        const gapThresh = Math.max(pageW * 0.18, bodyH * 10);
        if (bestIdx >= 0 && bestGap >= gapThresh) {
          const leftCount = bestIdx + 1;
          const rightCount = mids.length - leftCount;
          if (leftCount >= 7 && rightCount >= 7) {
            splitX = (mids[bestIdx] + mids[bestIdx + 1]) / 2;
          }
        }
      }

      const sortYX = (a: Seg, b: Seg) => (a.y - b.y) || (a.x1 - b.x1);
      const isLeft = (s: Seg) => (splitX == null ? true : s.xMid < splitX);

      let ordered: Seg[];

      if (splitX == null) {
        ordered = [...segs].sort(sortYX);
      } else {
        const seps = [...segs].filter((s) => s.full).sort(sortYX);
        const nonSep = [...segs].filter((s) => !s.full);

        if (!seps.length) {
          const left = nonSep.filter((s) => isLeft(s)).sort(sortYX);
          const right = nonSep.filter((s) => !isLeft(s)).sort(sortYX);
          ordered = [...left, ...right];
        } else {
          // Group separators in the same y band.
          const groups: { yMin: number; yMax: number; segs: Seg[] }[] = [];
          for (const s of seps) {
            const last = groups[groups.length - 1];
            if (!last || Math.abs(s.y - last.yMin) > tolY * 0.8) {
              groups.push({ yMin: s.y, yMax: s.y, segs: [s] });
            } else {
              last.yMin = Math.min(last.yMin, s.y);
              last.yMax = Math.max(last.yMax, s.y);
              last.segs.push(s);
            }
          }

          const out: Seg[] = [];
          let prevY = Number.NEGATIVE_INFINITY;

          const emitBand = (fromY: number, toY: number) => {
            const band = nonSep.filter((s) => s.y >= fromY && s.y < toY);
            const left = band.filter((s) => isLeft(s)).sort(sortYX);
            const right = band.filter((s) => !isLeft(s)).sort(sortYX);
            out.push(...left, ...right);
          };

          for (const g of groups) {
            emitBand(prevY, g.yMin);
            g.segs.sort(sortYX);
            out.push(...g.segs);
            prevY = g.yMax;
          }
          emitBand(prevY, Number.POSITIVE_INFINITY);
          ordered = out;
        }
      }

      // Flatten into Text[] preserving within-segment x-order
      const outNodes: Text[] = [];
      for (const s of ordered) {
        s.items.sort((a, b) => a.x1 - b.x1);
        for (const it of s.items) outNodes.push(it.node);
      }

      return outNodes.length ? outNodes : this.getTextNodes(pageEl);
    } catch {
      return this.getTextNodes(pageEl);
    }
  }

  private findPdfPageElementByNumber(pv: any | null, pageNumber: number): Element | null {
    const root: HTMLElement | null = pv?.containerEl ?? null;
    if (!root || !pageNumber) return null;

    const selectors = [
      `[data-page-number="${pageNumber}"]`,
      `[data-page="${pageNumber}"]`,
      `[data-pageindex="${pageNumber}"]`,
      `.page[data-page-number="${pageNumber}"]`,
      `.page[data-page="${pageNumber}"]`,
    ];
    for (const sel of selectors) {
      const found = root.querySelector(sel);
      if (found) return found;
    }
    return null;
  }

  private buildStartProbeFromRange(range: Range, pageEl: Element): string | undefined {
    try {
      const startNode = range.startContainer?.nodeType === Node.TEXT_NODE
        ? (range.startContainer as Text)
        : null;
      if (!startNode) return undefined;

      const textNodes = this.getPdfTextNodesInReadingOrder(pageEl);
      const idx = textNodes.indexOf(startNode);
      if (idx < 0) {
        // fallback to old behavior if we can't locate the node
        const ctx = range.cloneRange();
        ctx.setEnd(pageEl, pageEl.childNodes.length);
        const raw = (ctx.toString?.() ?? '').trim();
        const norm = raw.replace(/[\s\u00A0\u2000-\u200A\u200B\u202F\u205F\u2060\u3000\uFEFF]+/g, ' ').trim();
        const toks = PdfParser.tokenizeLikeEngine(norm).filter((t) => t && t !== PdfParser.LINEBREAK_MARKER);
        if (!toks.length) return undefined;
        toks[0] = this.normalizeSingleWordSelection(toks[0]);
        if (toks.length >= 2 && PdfParser.isLikelyFootnoteMarkerToken(toks[1])) toks.splice(1, 1);
        return toks.slice(0, 16).join(' ');
      }

      const startOffset = Math.max(0, Math.min(range.startOffset ?? 0, startNode.data.length));

      // Build a forward "probe" string that matches extractor tokenization as closely as possible.
      // PDF.js splits words across spans; blindly inserting spaces can break tokens like "IL-" + "2".
      const firstNonWs = (s: string): string => {
        for (let i = 0; i < s.length; i++) {
          const ch = s.charAt(i);
          if (!/[\s\u00A0\u2000-\u200A\u200B\u202F\u205F\u2060\u3000\uFEFF]/.test(ch)) return ch;
        }
        return '';
      };

      const lastNonWs = (s: string): string => {
        for (let i = s.length - 1; i >= 0; i--) {
          const ch = s.charAt(i);
          if (!/[\s\u00A0\u2000-\u200A\u200B\u202F\u205F\u2060\u3000\uFEFF]/.test(ch)) return ch;
        }
        return '';
      };

      const isOpenPunct = (ch: string): boolean => /[\(\[\{<"“‘']/u.test(ch);
      const isClosePunct = (ch: string): boolean => /[\)\]\}>,"”’'\.!?;:]/u.test(ch);

      const normCharge = (ch: string): string =>
        String(ch ?? '')
          .replace(/[＋﹢⁺]/g, '+')
          .replace(/[−﹣－⁻]/g, '-');

      const isCharge = (ch: string): boolean => {
        const t = normCharge(ch);
        return t === '+' || t === '-';
      };

      const isSlash = (ch: string): boolean => /[\/\u2044\u2215\uFF0F]/u.test(ch);
      const isDash = (ch: string): boolean => /[\-\u2010\u2011\u2012\u2013\u2014\u2212]/u.test(ch);

      const isAlphaNum = (ch: string): boolean => {
        try {
          return /[\p{L}\p{N}]/u.test(ch);
        } catch {
          return /[A-Za-z0-9]/.test(ch);
        }
      };

      const shouldJoinNoSpace = (prev: string, curr: string): boolean => {
        const a = lastNonWs(prev);
        const b = firstNonWs(curr);
        if (!a || !b) return false;

        if (isOpenPunct(a) && this.isWordChar(b)) return true;
        if (this.isWordChar(a) && isClosePunct(b)) return true;
        if (isDash(a)) return this.isWordChar(b);
        if (isSlash(a)) return this.isWordChar(b);

        // Biochemical charge markers are often rendered as separate spans ("NAD" + "+").
        // Treat them as glued so token-count hints and probe strings match extracted text.
        if (isAlphaNum(a) && isCharge(b)) return true;
        if (isCharge(a) && isSlash(b)) return true;
        if (isSlash(a) && isCharge(b)) return true;

        // footnote-ish markers glued to the previous token
        if (this.isWordChar(a) && /[\d*†‡]/.test(b)) return true;

        return false;
      };

      let buf = startNode.data.slice(startOffset);
      let prevSeg = buf;
      let nodesAdded = 0;

      for (let i = idx + 1; i < textNodes.length && nodesAdded < 80 && buf.length < 5000; i++) {
        const seg = textNodes[i].data;
        if (seg) {
          buf += (shouldJoinNoSpace(prevSeg, seg) ? '' : ' ') + seg;
          prevSeg = seg;
        }
        nodesAdded++;
      }

      const norm0 = buf.replace(/[\s\u00A0\u2000-\u200A\u200B\u202F\u205F\u2060\u3000\uFEFF]+/g, ' ').trim();
      const norm = PdfParser.insertBiomedicalTokenBreaks(norm0);
      if (!norm) return undefined;

      const tokens = PdfParser.tokenizeLikeEngine(norm).filter((t) => t && t !== PdfParser.LINEBREAK_MARKER);

      if (!tokens.length) return undefined;

      tokens[0] = this.normalizeSingleWordSelection(tokens[0]);
      if (tokens.length >= 2 && PdfParser.isLikelyFootnoteMarkerToken(tokens[1])) tokens.splice(1, 1);

      return tokens.slice(0, 16).join(' ');
    } catch {
      return undefined;
    }
  }

  private buildStartProbeFromRangeFallback(range: Range): string | undefined {
    try {
      const doc = (range.startContainer as any)?.ownerDocument ?? null;
      const endRoot: any = doc?.body ?? doc?.documentElement ?? null;
      if (!endRoot) return undefined;

      const ctx = range.cloneRange();
      ctx.setEnd(endRoot, endRoot.childNodes.length);

      const raw = (ctx.toString?.() ?? '').trim();
      if (!raw) return undefined;

      // normalize “PDF weird whitespace”
      const norm0 = raw.replace(/[\s\u00A0\u2000-\u200A\u200B\u202F\u205F\u2060\u3000\uFEFF]+/g, ' ').trim();
      if (!norm0) return undefined;

      // IMPORTANT: apply the same biomedical token splitting used during extraction and
      // event-based probe building so chains (CD33+CD15, CD47/SIRP) split consistently.
      const norm = PdfParser.insertBiomedicalTokenBreaks(norm0);

      const tokens = PdfParser.tokenizeLikeEngine(norm).filter((t) => t && t !== PdfParser.LINEBREAK_MARKER);
      if (!tokens.length) return undefined;

      tokens[0] = this.normalizeSingleWordSelection(tokens[0]);

      if (tokens.length >= 2 && PdfParser.isLikelyFootnoteMarkerToken(tokens[1])) {
        tokens.splice(1, 1);
      }

      return tokens.slice(0, 16).join(' ');
    } catch {
      return undefined;
    }
  }

  public getCurrentPdfPageNumber(pv: any | null): number | undefined {
    if (!pv) return undefined;
    const n =
      pv?.viewer?.child?.pdfViewer?.pdfViewer?.currentPageNumber ??
      pv?.viewer?.pdfViewer?.pdfViewer?.currentPageNumber ??
      pv?.pdfViewer?.pdfViewer?.currentPageNumber ??
      pv?.viewer?.child?.pdfViewer?.currentPageNumber ??
      pv?.viewer?.pdfViewer?.currentPageNumber;

    const num = typeof n === 'number' ? n : parseInt(String(n ?? ''), 10);
    return Number.isFinite(num) && num > 0 ? num : undefined;
  }

  private isExplicitUserClearEvent(evt?: Event): boolean {
    const t = (evt as any)?.type;

    // keyup happens during command-palette / focus transitions and can briefly clear DOM selection.
    // Only treat Escape as an intentional "clear selection" action.
    if (t === 'keyup') {
      const ke = evt as KeyboardEvent;
      return ke?.key === 'Escape';
    }

    return t === 'mouseup' || t === 'pointerup' || t === 'touchend';
  }

  private isWordChar(ch: string): boolean {
    if (!ch) return false;
    try {
      // IMPORTANT: this is NOT the engine tokenizer (engine is whitespace-only).
      // This is only used for expanding a DOM Range to a sensible single-token anchor.
      // Include common biomedical "attached" punctuation and superscripts.
      return /[\p{L}\p{N}'’\-\u2010\u2011\u2012\u2013\u2014\u2212\+\uFF0B\uFE62\u207A\uFE63\uFF0D\u207B\u00B9\u00B2\u00B3\u2070-\u2079\u2080-\u2089\/\u2044\^]/u.test(
        ch
      );
    } catch {
      return /[A-Za-z0-9'’\-\+\/\^]/.test(ch);
    }
  }

  private expandSelectionToWordBoundaries(
    sel: Selection | null
  ): { text: string; rawText: string; range?: Range } {
    const rawText = String(sel?.toString?.() ?? '');
    const rawTrim = rawText.trim();
    if (!rawTrim) return { text: '', rawText: '' };
    if (!sel || sel.rangeCount < 1) return { text: rawTrim, rawText };

    try {
      const r = sel.getRangeAt(0).cloneRange();

      const root = this.getParentElementCrossShadow(r.commonAncestorContainer as any) ?? null;
      const textNodes = this.getTextNodes(root);

      const firstTextIn = (n: Node | null): Text | null => {
        if (!n) return null;
        if (n.nodeType === Node.TEXT_NODE) return n as Text;
        const walker = n.ownerDocument?.createTreeWalker(n, NodeFilter.SHOW_TEXT);
        return (walker?.nextNode() as Text) ?? null;
      };

      const lastTextIn = (n: Node | null): Text | null => {
        if (!n) return null;
        if (n.nodeType === Node.TEXT_NODE) return n as Text;
        const walker = n.ownerDocument?.createTreeWalker(n, NodeFilter.SHOW_TEXT);
        let last: Text | null = null;
        let curr: Node | null = walker?.nextNode() ?? null;
        while (curr) {
          last = curr as Text;
          curr = walker?.nextNode() ?? null;
        }
        return last;
      };

      // IMPORTANT: if container is an Element, use it (NOT its parent)
      if (r.startContainer?.nodeType !== Node.TEXT_NODE) {
        const container =
          (r.startContainer as any)?.nodeType === Node.ELEMENT_NODE
            ? (r.startContainer as any as Element)
            : this.getParentElementCrossShadow(r.startContainer as any);

        const len = container?.childNodes?.length ?? 0;
        const idx = len > 0 ? Math.min(Math.max(r.startOffset ?? 0, 0), len - 1) : 0;
        const child = len > 0 ? (container?.childNodes?.[idx] ?? null) : null;
        const tn = firstTextIn(child) ?? firstTextIn(container);
        if (tn) r.setStart(tn, 0);
      }

      if (r.endContainer?.nodeType !== Node.TEXT_NODE) {
        const container =
          (r.endContainer as any)?.nodeType === Node.ELEMENT_NODE
            ? (r.endContainer as any as Element)
            : this.getParentElementCrossShadow(r.endContainer as any);

        const len = container?.childNodes?.length ?? 0;
        const idxRaw = (r.endOffset ?? 0) - 1;
        const idx = len > 0 ? Math.min(Math.max(idxRaw, 0), len - 1) : 0;
        const child = len > 0 ? (container?.childNodes?.[idx] ?? null) : null;
        const tn = lastTextIn(child) ?? lastTextIn(container);
        if (tn) r.setEnd(tn, tn.data.length);
      }

      const selectionHasWordChar = (s: string): boolean => {
        for (let i = 0; i < s.length; i++) if (this.isWordChar(s.charAt(i))) return true;
        return false;
      };

      // punctuation-only selection -> snap to nearest word char
      if (!selectionHasWordChar(rawTrim)) {
        const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

        const seek = (dir: -1 | 1): { node: Text; off: number } | null => {
          let node = r.startContainer as Text;
          if (!node?.data) return null;
          let off = clamp(r.startOffset ?? 0, 0, node.data.length);

          const scanInNode = (n: Text, from: number): number | null => {
            if (!n?.data) return null;
            if (dir === -1) {
              for (let j = from - 1; j >= 0; j--) if (this.isWordChar(n.data.charAt(j))) return j;
            } else {
              for (let j = from; j < n.data.length; j++) if (this.isWordChar(n.data.charAt(j))) return j;
            }
            return null;
          };

          while (true) {
            const found = scanInNode(node, off);
            if (found != null) return { node, off: found };

            const i = textNodes.indexOf(node);
            if (i === -1) return null;

            const next = dir === -1 ? i - 1 : i + 1;
            if (next < 0 || next >= textNodes.length) return null;

            const adj = textNodes[next];

            const currPage = this.getPdfPageNumberFromNode(node);
            const adjPage = this.getPdfPageNumberFromNode(adj);
            if (currPage && adjPage && currPage !== adjPage) return null;

            node = adj;
            off = dir === -1 ? node.data.length : 0;
          }
        };

        const pos = seek(-1) ?? seek(1);
        if (pos) {
          r.setStart(pos.node, pos.off);
          r.setEnd(pos.node, Math.min(pos.off + 1, pos.node.data.length));
        }
      }

      const isWhitespaceChar = (c: string): boolean =>
        /[\s\u00A0\u2000-\u200A\u200B\u202F\u205F\u2060\u3000\uFEFF]/.test(c);

      // Expand start backwards to word boundary (do NOT require same parent; only avoid crossing pages)
      if (r.startContainer?.nodeType === Node.TEXT_NODE) {
        let node = r.startContainer as Text;
        let off = Math.min(Math.max(r.startOffset ?? 0, 0), node.data.length);

        while (true) {
          while (off > 0 && this.isWordChar(node.data.charAt(off - 1))) off--;
          if (off > 0) break;

          const i = textNodes.indexOf(node);
          if (i <= 0) break;

          const prev = textNodes[i - 1];
          if (!prev?.data) break;

          const currPage = this.getPdfPageNumberFromNode(node);
          const prevPage = this.getPdfPageNumberFromNode(prev);
          if (currPage && prevPage && currPage !== prevPage) break;

          // bridge split biomedical tokens across text nodes (dash, charge, slash)
          const prevTrim = prev.data.replace(/[\s\u00A0\u2000-\u200A\u200B\u202F\u205F\u2060\u3000\uFEFF]+$/g, '');
          const prevLast = prevTrim.charAt(Math.max(0, prevTrim.length - 1));
          if (!/[\-\u2010\u2011\u2012\u2013\u2014\u2212\uFE63\uFF0D\+\uFF0B\uFE62\u207A\u207B\/\u2044\u2215]/.test(prevLast)) break;

          node = prev;
          off = prev.data.length;
        }

        r.setStart(node, off);
      }

      // Expand end forwards to word boundary
      if (r.endContainer?.nodeType === Node.TEXT_NODE) {
        let node = r.endContainer as Text;
        let off = Math.min(Math.max(r.endOffset ?? 0, 0), node.data.length);

        while (off > 0 && isWhitespaceChar(node.data.charAt(off - 1))) off--;

        while (true) {
          while (off < node.data.length && this.isWordChar(node.data.charAt(off))) off++;
          if (off < node.data.length) break;

          const i = textNodes.indexOf(node);
          if (i === -1 || i >= textNodes.length - 1) break;

          const next = textNodes[i + 1];
          if (!next?.data) break;

          const currPage = this.getPdfPageNumberFromNode(node);
          const nextPage = this.getPdfPageNumberFromNode(next);
          if (currPage && nextPage && currPage !== nextPage) break;

          if (!next.data.trim()) break;

          const lastIncluded = off > 0 ? node.data.charAt(off - 1) : '';
          if (!/[\-\u2010\u2011\u2012\u2013\u2014\u2212\uFE63\uFF0D\+\uFF0B\uFE62\u207A\u207B\/\u2044\u2215]/.test(lastIncluded)) break;

          if (!this.isWordChar(next.data.charAt(0))) break;

          node = next;
          off = 0;
        }

        r.setEnd(node, off);
      }

      // -------------------------------------------------------------------
      // Absorb glued biomedical suffixes that cross PDF.js spans:
      //   1) close-bracket + dash + suffix, e.g. (CCL)-3, (IP3)-dependent, (ADP)-ribose
      //   2) superscript charge/number tails, e.g. CD16+, Ca2+ (when +/- lives in another span)
      //
      // Key requirement: do NOT over-consume across whitespace.
      // -------------------------------------------------------------------
      const isClose = (c: string): boolean =>
        c === ')' || c === ']' || c === '}' || c === '）' || c === '］' || c === '｝';

      const isDash = (c: string): boolean =>
        c === '-' || c === '‐' || c === '-' || c === '‒' || c === '–' || c === '—' || c === '−' || c === '－';

      const isWs = (c: string): boolean => /[\s\u00A0\u2000-\u200A\u200B\u202F\u205F\u2060\u3000\uFEFF]/.test(c);

      const isAlphaNum = (c: string): boolean => {
        try {
          return /[\p{L}\p{N}]/u.test(c);
        } catch {
          return /[A-Za-z0-9]/.test(c);
        }
      };

      const isCharge = (c: string): boolean =>
        c === '+' || c === '-' || c === '−' || c === '＋' || c === '－' || c === '⁺' || c === '⁻' || c === '﹢' || c === '﹣';

      const isSupDigit = (c: string): boolean =>
        c === '¹' || c === '²' || c === '³' || /[\u2070-\u2079\u2080-\u2089]/.test(c);

      const nextTextNodeSamePage = (n: Text): Text | null => {
        const i = textNodes.indexOf(n);
        if (i === -1 || i >= textNodes.length - 1) return null;
        const nxt = textNodes[i + 1];
        if (!nxt?.data) return null;
        const p1 = this.getPdfPageNumberFromNode(n);
        const p2 = this.getPdfPageNumberFromNode(nxt);
        if (p1 && p2 && p1 !== p2) return null;
        return nxt;
      };

      const prevTextNodeSamePage = (n: Text): Text | null => {
        const i = textNodes.indexOf(n);
        if (i <= 0) return null;
        const prv = textNodes[i - 1];
        if (!prv?.data) return null;
        const p1 = this.getPdfPageNumberFromNode(n);
        const p2 = this.getPdfPageNumberFromNode(prv);
        if (p1 && p2 && p1 !== p2) return null;
        return prv;
      };

      const peekChar = (n: Text, o: number): { node: Text; off: number; ch: string } | null => {
        if (o < n.data.length) return { node: n, off: o, ch: n.data.charAt(o) };
        const nxt = nextTextNodeSamePage(n);
        if (!nxt) return null;
        return peekChar(nxt, 0);
      };

      const peekPrevChar = (n: Text, o: number): { node: Text; off: number; ch: string } | null => {
        if (o > 0) return { node: n, off: o - 1, ch: n.data.charAt(o - 1) };
        const prv = prevTextNodeSamePage(n);
        if (!prv) return null;
        return peekPrevChar(prv, prv.data.length);
      };

      const advance = (n: Text, o: number): { node: Text; off: number } => {
        if (o < n.data.length) return { node: n, off: o + 1 };
        const nxt = nextTextNodeSamePage(n);
        if (!nxt) return { node: n, off: o };
        return { node: nxt, off: 1 };
      };

      const consumeWhile = (
        startNode: Text,
        startOff: number,
        pred: (ch: string) => boolean,
        maxChars: number
      ): { node: Text; off: number; count: number } => {
        let node = startNode;
        let off = startOff;
        let count = 0;
        while (count < maxChars) {
          const p = peekChar(node, off);
          if (!p) break;
          if (!pred(p.ch)) break;
          const adv = advance(p.node, p.off);
          node = adv.node;
          off = adv.off;
          count++;
        }
        return { node, off, count };
      };

      const consumeCloseDashSuffix = (node: Text, off: number): { node: Text; off: number } | null => {
        // Two entry points:
        //  A) boundary is BEFORE close-bracket(s)
        //  B) boundary is AFTER close-bracket(s)
        const before = peekChar(node, off);
        const prev = peekPrevChar(node, off);

        // Helper: after closes, expect dash then at least 1 "token" char.
        const afterCloses = (n0: Text, o0: number): { node: Text; off: number } | null => {
          // consume 1..4 closes
          const closes = consumeWhile(n0, o0, (ch) => isClose(ch), 4);
          if (closes.count < 1) return null;

          const pDash = peekChar(closes.node, closes.off);
          if (!pDash || !isDash(pDash.ch)) return null;

          // consume dash
          const dashEnd = advance(pDash.node, pDash.off);

          // suffix must start immediately (no whitespace) and begin with alphanum
          const p0 = peekChar(dashEnd.node, dashEnd.off);
          if (!p0 || isWs(p0.ch) || !isAlphaNum(p0.ch)) return null;

          // consume "token" chars (letters/digits, optionally internal dashes)
          const suf = consumeWhile(
            dashEnd.node,
            dashEnd.off,
            (ch) => !isWs(ch) && (this.isWordChar(ch) || isClose(ch)),
            28
          );
          return { node: suf.node, off: suf.off };
        };

        // A) boundary before closes
        if (before && isClose(before.ch)) {
          return afterCloses(before.node, before.off);
        }

        // B) boundary after closes: prev char is close, next char is dash
        if (prev && isClose(prev.ch)) {
          const pDash = before;
          if (pDash && isDash(pDash.ch)) {
            // consume dash + suffix
            const dashEnd = advance(pDash.node, pDash.off);
            const p0 = peekChar(dashEnd.node, dashEnd.off);
            if (!p0 || isWs(p0.ch) || !isAlphaNum(p0.ch)) return null;
            const suf = consumeWhile(dashEnd.node, dashEnd.off, (ch) => !isWs(ch) && this.isWordChar(ch), 28);
            return { node: suf.node, off: suf.off };
          }
        }

        return null;
      };

      const isSlash = (c: string): boolean => c === '/' || c === '⁄' || c === '∕' || c === '／';

      const consumeSupTail = (node: Text, off: number): { node: Text; off: number } | null => {
        // Consume: optional superscript digits then a charge cluster:
        //   +                (CD16+)
        //   + / -            (CD16+/-)
        //   + / −            (CD16+/−)
        //   ±                (rare)
        const p0 = peekChar(node, off);
        if (!p0) return null;

        let curN = node;
        let curO = off;
        let consumedAny = false;

        // 0..3 sup digits
        const digits = consumeWhile(curN, curO, (ch) => !isWs(ch) && isSupDigit(ch), 3);
        if (digits.count > 0) {
          consumedAny = true;
          curN = digits.node;
          curO = digits.off;
        }

        // 1st charge (or ±)
        const pCh = peekChar(curN, curO);
        if (pCh && !isWs(pCh.ch) && (isCharge(pCh.ch) || pCh.ch === '±')) {
          const adv = advance(pCh.node, pCh.off);
          consumedAny = true;
          curN = adv.node;
          curO = adv.off;
        } else {
          return consumedAny ? { node: curN, off: curO } : null;
        }

        // Optional "/-"
        const pSlash = peekChar(curN, curO);
        if (pSlash && !isWs(pSlash.ch) && isSlash(pSlash.ch)) {
          const advS = advance(pSlash.node, pSlash.off);
          const pCh2 = peekChar(advS.node, advS.off);
          if (pCh2 && !isWs(pCh2.ch) && isCharge(pCh2.ch)) {
            // consume slash + second charge
            const advS2 = advance(pCh2.node, pCh2.off);
            curN = advS2.node;
            curO = advS2.off;
            consumedAny = true;
          }
        }

        return consumedAny ? { node: curN, off: curO } : null;
      };

      if (r.endContainer?.nodeType === Node.TEXT_NODE) {
        const startPos = {
          node: r.endContainer as Text,
          off: Math.min(Math.max(r.endOffset ?? 0, 0), (r.endContainer as Text).data.length),
        };

        // 1) close-bracket + dash + suffix
        const suf = consumeCloseDashSuffix(startPos.node, startPos.off);
        if (suf) {
          r.setEnd(suf.node, suf.off);
        }

        // 2) superscript digits / +/- tails
        const after1 = {
          node: r.endContainer as Text,
          off: Math.min(Math.max(r.endOffset ?? 0, 0), (r.endContainer as Text).data.length),
        };
        const tail = consumeSupTail(after1.node, after1.off);
        if (tail) {
          // Only consume charge-like tails when they are glued to an alphanum.
          const prev = peekPrevChar(after1.node, after1.off);
          if (prev && (isAlphaNum(prev.ch) || isClose(prev.ch))) {
            r.setEnd(tail.node, tail.off);
          }
        }
      }

        const isOpenWrap = (c: string): boolean =>
        c === '(' || c === '[' || c === '{' || c === '（' || c === '［' || c === '｛';

      const isCloseWrap = (c: string): boolean =>
        c === ')' || c === ']' || c === '}' || c === '）' || c === '］' || c === '｝';

      // Absorb attached LEFT wrappers: "(NAD+)" should select "(NAD+"
      if (r.startContainer?.nodeType === Node.TEXT_NODE) {
        let n = r.startContainer as Text;
        let o = Math.min(Math.max(r.startOffset ?? 0, 0), n.data.length);

        // pull in up to 3 nested wrappers, only if glued (no whitespace jump)
        for (let k = 0; k < 3; k++) {
          const p = peekPrevChar(n, o);
          if (!p || !isOpenWrap(p.ch)) break;
          n = p.node;
          o = p.off;
        }
        r.setStart(n, o);
      }

      // Absorb attached RIGHT wrappers: "(NAD+)" should include trailing ")"
      if (r.endContainer?.nodeType === Node.TEXT_NODE) {
        let n = r.endContainer as Text;
        let o = Math.min(Math.max(r.endOffset ?? 0, 0), n.data.length);

        for (let k = 0; k < 3; k++) {
          const p = peekChar(n, o);
          if (!p || !isCloseWrap(p.ch)) break;
          const adv = advance(p.node, p.off);
          n = adv.node;
          o = adv.off;
        }
        r.setEnd(n, o);
      }

      const expanded = (r.toString?.() ?? '').trim();
      return { text: expanded || rawTrim, rawText, range: r };
    } catch {
      return { text: rawTrim, rawText };
    }
  }

  public countTokensLikeEngineNoBreaks(text: string): number {
    return PdfParser.countTokensLikeEngineNoBreaks(text);
  }

  public tokenizeLikeEngine(text: string): string[] {
    return PdfParser.tokenizeLikeEngine(String(text ?? ''));
  }

  public getEngineTokenWindow(
    text: string,
    index: number,
    radius = 3
  ): { tokenAt: string; window: string[] } {
    const toks = PdfParser.tokenizeLikeEngine(text);
    const fmt = (t: string) => (t === PdfParser.LINEBREAK_MARKER ? '\\n' : t);

    const tokenAt = fmt(toks[index] ?? '');
    const start = Math.max(0, index - radius);
    const end = Math.min(toks.length, index + radius + 1);
    const window = toks.slice(start, end).map(fmt);

    return { tokenAt, window };
  }

  private getPdfPageElementFromNode(node: Node | null): Element | null {
    if (!node) return null;

    let el: Element | null = null;
    if ((node as any).nodeType === Node.ELEMENT_NODE) el = node as any as Element;
    else el = (node as any).parentElement ?? null;

    while (el) {
      const hasPageAttr =
        el.getAttribute?.('data-page-number') ??
        el.getAttribute?.('data-page') ??
        el.getAttribute?.('data-pageindex') ??
        (el as any).dataset?.pageNumber ??
        (el as any).dataset?.pageNum ??
        (el as any).dataset?.page ??
        (el as any).dataset?.pageIndex;

      if (hasPageAttr != null) return el;

      const cl = (el as any).classList;
      if (
        cl?.contains?.('page') ||
        cl?.contains?.('pdf-page') ||
        cl?.contains?.('pdfPage') ||
        cl?.contains?.('PDFPageView')
      ) {
        return el;
      }

      el = this.getParentElementCrossShadow(el);
    }

    return null;
  }

  /**
   * Fallback when Obsidian/PDF.js nesting makes it hard to walk from a text node
   * up to a page container: infer the page element by geometry.
   *
   * PERF: use elementsFromPoint first (O(1)), only scan page nodes as a last resort.
   */
  private inferPageElementFromRange(pv: any | null, range: Range): Element | null {
    try {
      const rect = range.getBoundingClientRect();
      if (!rect || (!rect.width && !rect.height)) return null;

      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;

      const doc: Document | null = (range.startContainer as any)?.ownerDocument ?? null;
      if (!doc) return null;

      // Fast path: ask the browser what element(s) are at the selection center.
      const stack: Element[] = (() => {
        const anyDoc: any = doc as any;
        if (typeof anyDoc.elementsFromPoint === 'function') {
          return (anyDoc.elementsFromPoint(cx, cy) as Element[]) ?? [];
        }
        const one = typeof doc.elementFromPoint === 'function' ? doc.elementFromPoint(cx, cy) : null;
        return one ? [one] : [];
      })();

      for (const el of stack) {
        const pageEl = this.getPdfPageElementFromNode(el);
        if (pageEl) return pageEl;
      }

      // Second-fast path: try walking up from the range container directly.
      {
        const direct = this.getPdfPageElementFromNode(range.startContainer);
        if (direct) return direct;
      }

      // Last resort: scan page containers in the SAME document as the selection.
      const rootEl: HTMLElement | null = pv?.containerEl ?? null;
      if (!rootEl || rootEl.ownerDocument !== doc) return null;

      const selectors = [
        '[data-page-number]',
        '[data-page]',
        '[data-pageindex]',
        '.page',
        '.PDFPageView',
        '.pdf-page',
        '.pdfPage',
        '.pdfPageView',
      ].join(',');

      const candidates = Array.from(rootEl.querySelectorAll(selectors)) as Element[];
      if (!candidates.length) return null;

      let bestContains: Element | null = null;
      let bestContainsArea = Number.POSITIVE_INFINITY;

      let bestIntersect: Element | null = null;
      let bestIntersectScore = 0;

      for (const el of candidates) {
        const r = (el as HTMLElement).getBoundingClientRect?.();
        if (!r) continue;

        const containsCenter = cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
        if (containsCenter) {
          const area = Math.max(1, r.width * r.height);
          if (area < bestContainsArea) {
            bestContains = el;
            bestContainsArea = area;
          }
          continue;
        }

        const ix = Math.max(0, Math.min(rect.right, r.right) - Math.max(rect.left, r.left));
        const iy = Math.max(0, Math.min(rect.bottom, r.bottom) - Math.max(rect.top, r.top));
        const inter = ix * iy;

        if (inter > bestIntersectScore) {
          bestIntersect = el;
          bestIntersectScore = inter;
        }
      }

      return bestContains ?? bestIntersect;
    } catch {
      return null;
    }
  }

  private registerPdfSelectionTarget(target: EventTarget): void {
    if (this.pdfSelectionTargets.has(target)) return;
    this.pdfSelectionTargets.add(target);

    const capture = (evt?: Event) => this.capturePdfSelection(evt);

    this.plugin.registerDomEvent(target as any, 'pointerup', capture);
    this.plugin.registerDomEvent(target as any, 'touchend', capture);
    this.plugin.registerDomEvent(target as any, 'dblclick', capture);
    this.plugin.registerDomEvent(target as any, 'keyup', capture);

    // Intentionally NOT registering `selectionchange` (too chatty; triggers forced reflow patterns).
  }

  private schedulePdfSelectionTargetScan(): void {
    const scan = () => {
      const pv: any = this.getActivePdfViewAny();
      if (!pv) return;

      const root: HTMLElement | null = pv?.containerEl ?? null;
      if (root) this.registerPdfSelectionTarget(root);

      const iframes = root ? (Array.from(root.querySelectorAll('iframe')) as HTMLIFrameElement[]) : [];
      for (const iframe of iframes) {
        try {
          if (iframe.contentWindow) this.registerPdfSelectionTarget(iframe.contentWindow);
          const doc = iframe.contentDocument;
          if (doc) this.registerPdfSelectionTarget(doc);
        } catch {
          // ignore
        }
      }
    };

    // PDF views can create/replace iframes asynchronously; scan a few times.
    scan();
    window.setTimeout(scan, 150);
    window.setTimeout(scan, 600);
    window.setTimeout(scan, 1500);
  }

  private getPdfPageNumberFromNode(node: Node | null): number | undefined {
    if (!node) return undefined;

    let el: Element | null = null;
    if ((node as any).nodeType === Node.ELEMENT_NODE) el = node as any as Element;
    else el = (node as any).parentElement ?? null;

    while (el) {
      const attr =
        el.getAttribute?.('data-page-number') ??
        el.getAttribute?.('data-page') ??
        el.getAttribute?.('data-pageindex') ??
        (el as any).dataset?.pageNumber ??
        (el as any).dataset?.pageNum ??
        (el as any).dataset?.page ??
        (el as any).dataset?.pageIndex;

      if (attr) {
        const n = parseInt(String(attr), 10);
        if (!Number.isNaN(n) && n > 0) return n;
      }

      el = this.getParentElementCrossShadow(el);
    }
    return undefined;
  }

  private estimateWordHintInPageByTextNodes(pageEl: Element, range: Range): number | undefined {
    try {
      const textNodes = this.getPdfTextNodesInReadingOrder(pageEl);
      if (!textNodes.length) return undefined;

      // Resolve the range start to a Text node.
      let startNode: Text | null = null;
      let startOffset = 0;

      if (range.startContainer?.nodeType === Node.TEXT_NODE) {
        startNode = range.startContainer as Text;
        startOffset = range.startOffset ?? 0;
      } else {
        const walker = range.startContainer?.ownerDocument?.createTreeWalker(
          range.startContainer,
          NodeFilter.SHOW_TEXT
        );
        startNode = (walker?.nextNode?.() as Text) ?? null;
        startOffset = 0;
      }

      if (!startNode) return undefined;

      const idx = textNodes.indexOf(startNode);
      if (idx === -1) return undefined;

      const normalizeWs = (s: string): string =>
        String(s ?? '').replace(
          /[\s\u00A0\u2000-\u200A\u200B\u202F\u205F\u2060\u3000\uFEFF]+/g,
          ' '
        );

      const firstNonWs = (s: string): string => {
        for (let i = 0; i < s.length; i++) {
          const ch = s.charAt(i);
          if (ch !== ' ') return ch;
        }
        return '';
      };

      const lastNonWs = (s: string): string => {
        for (let i = s.length - 1; i >= 0; i--) {
          const ch = s.charAt(i);
          if (ch !== ' ') return ch;
        }
        return '';
      };

      const isOpenPunct = (ch: string): boolean => /[\(\[\{<"“‘']/u.test(ch);
      const isClosePunct = (ch: string): boolean => /[\)\]\}>,"”’'\.!?;:]/u.test(ch);

      const normCharge = (ch: string): string =>
        String(ch ?? '')
          .replace(/[＋﹢⁺]/g, '+')
          .replace(/[−﹣－⁻]/g, '-');

      const isCharge = (ch: string): boolean => {
        const t = normCharge(ch);
        return t === '+' || t === '-';
      };

      const isSlash = (ch: string): boolean => /[\/\u2044\u2215\uFF0F]/u.test(ch);
      const isDash = (ch: string): boolean => /[\-\u2010\u2011\u2012\u2013\u2014\u2212]/u.test(ch);

      const isAlphaNum = (ch: string): boolean => {
        try {
          return /[\p{L}\p{N}]/u.test(ch);
        } catch {
          return /[A-Za-z0-9]/.test(ch);
        }
      };

      const shouldJoinNoSpace = (prev: string, curr: string): boolean => {
        const a = lastNonWs(prev);
        const b = firstNonWs(curr);
        if (!a || !b) return false;

        if (isOpenPunct(a) && this.isWordChar(b)) return true;
        if (this.isWordChar(a) && isClosePunct(b)) return true;
        if (isDash(a)) return this.isWordChar(b);
        if (isSlash(a)) return this.isWordChar(b);

        // Biochemical charge markers are often rendered as separate spans ("NAD" + "+").
        // Treat them as glued so token-count hints and probe strings match extracted text.
        if (isAlphaNum(a) && isCharge(b)) return true;
        if (isCharge(a) && isSlash(b)) return true;
        if (isSlash(a) && isCharge(b)) return true;

        // footnote-ish markers glued to the previous token
        if (this.isWordChar(a) && /[\d*†‡]/.test(b)) return true;

        return false;
      };

      let count = 0;
      let prevText = '';
      let prevHadTokens = false;

      const addSegment = (seg: string) => {
        const t0 = normalizeWs(seg);
        const t = PdfParser.insertBiomedicalTokenBreaks(t0);
        const segCount = PdfParser.countTokensLikeEngineNoBreaks(t);
        if (!segCount) {
          prevText = t;
          prevHadTokens = false;
          return;
        }

        // Default assumption: node boundaries imply a token boundary (PDF.js often omits real spaces),
        // but undo that when the boundary is very likely "no-space" punctuation glue.
        if (prevHadTokens && shouldJoinNoSpace(prevText, t)) count -= 1;

        count += segCount;
        prevText = t;
        prevHadTokens = true;
      };

      for (let i = 0; i < idx; i++) {
        const d = textNodes[i]?.data ?? '';
        if (!d) continue;
        addSegment(d);
      }

      const off = Math.min(Math.max(startOffset, 0), startNode.data.length);
      const head = startNode.data.slice(0, off);
      if (head) addSegment(head);

      // If the selection starts inside a token (prev char is non-whitespace),
      // `head` includes part of the current token, which counts as a full token
      // under whitespace-tokenisation. Convert “tokens up to caret” into
      // “index of token containing caret” by subtracting 1 in that case.
      if (off > 0) {
        const prevCh = startNode.data.charAt(off - 1);
        if (prevCh && !/\s/.test(prevCh)) {
          count = Math.max(0, count - 1);
        }
      }

      return Number.isFinite(count) && count >= 0 ? count : undefined;
    } catch {
      return undefined;
    }
  }

  private getSelectionTextAndPage(
    sel: Selection | null,
    pv: any
  ): { text: string; rawText?: string; page?: number; wordHintInPage?: number; probe?: string; yInPage?: number } {
    if (!sel || sel.isCollapsed) return { text: '' };

    const raw = String(sel.toString?.() ?? '');
    const expanded = this.expandSelectionToWordBoundaries(sel);

    const findByNumberInRoot = (root: ParentNode | null, pageNumber: number): Element | null => {
      if (!root) return null;
      const selectors = [
        `[data-page-number="${pageNumber}"]`,
        `[data-page="${pageNumber}"]`,
        `[data-pageindex="${pageNumber}"]`,
        `.page[data-page-number="${pageNumber}"]`,
        `.page[data-page="${pageNumber}"]`,
      ];
      for (const sel of selectors) {
        const found = (root as any).querySelector?.(sel);
        if (found) return found as Element;
      }
      return null;
    };

    let pageEl = expanded.range ? this.getPdfPageElementFromNode(expanded.range.startContainer) : null;

    let page =
      this.getPdfPageNumberFromNode(sel?.anchorNode ?? null) ??
      this.getPdfPageNumberFromNode(sel?.focusNode ?? null) ??
      (pageEl ? this.getPdfPageNumberFromNode(pageEl as any) : undefined) ??
      this.getCurrentPdfPageNumber(pv);

    // If we couldn’t walk up to a page element, try the selection’s own document first (iframe builds)
    if (!pageEl && page && expanded.range) {
      const doc = expanded.range.startContainer?.ownerDocument ?? null;
      pageEl = findByNumberInRoot(doc as any, page);
    }

    // Finally, try the outer PDF view container (non-iframe builds).
    // Guard against mixing documents: if the selection is in an iframe, pageEl from the outer document
    // can't be used with the selection's Range.
    if (!pageEl && page) {
      const rangeDoc = expanded.range?.startContainer?.ownerDocument ?? null;
      const rootDoc = (pv?.containerEl as any)?.ownerDocument ?? null;
      if (!rangeDoc || !rootDoc || rangeDoc === rootDoc) {
        const byNumber = this.findPdfPageElementByNumber(pv, page);
        if (byNumber) pageEl = byNumber;
      }
    }

    // Geometry fallback (fixes repeated-word selection jumping to the first occurrence).
    if (expanded.range) {
      if (!pageEl) {
        const inferred = this.inferPageElementFromRange(pv, expanded.range);
        if (inferred) pageEl = inferred;
      }
      if (!page && pageEl) {
        page = this.getPdfPageNumberFromNode(pageEl as any) ?? page;
      }
    }

    let wordHintInPage: number | undefined = undefined;
    let probe: string | undefined = undefined;
    let yInPage: number | undefined = undefined;

    if (expanded.range && pageEl) {
      wordHintInPage = this.estimateWordHintInPageByTextNodes(pageEl, expanded.range);

      // If you have these helpers, keep probe; otherwise delete these 2 lines and leave probe undefined.
      probe =
        this.buildStartProbeFromRange(expanded.range, pageEl) ??
        this.buildStartProbeFromRangeFallback(expanded.range);

      // Optional; if you don’t need it, remove this try{} entirely.
      try {
        const r = expanded.range.getBoundingClientRect();
        const pr = (pageEl as HTMLElement).getBoundingClientRect();
        if (pr.height > 0) {
          const y = (r.top - pr.top) / pr.height;
          if (Number.isFinite(y)) yInPage = Math.max(0, Math.min(1, y));
        }
      } catch {
        // ignore
      }
    } else if (expanded.range) {
      // fallback: still try to build a probe even if we couldn't resolve pageEl
      probe = this.buildStartProbeFromRangeFallback(expanded.range);
    }

    return {
      text: expanded.text || raw,
      rawText: expanded.rawText || raw,
      page,
      wordHintInPage,
      probe,
      yInPage,
    };
  }

  private capturePdfSelection(evt?: Event): void {
    this.pendingCaptureEvent = evt;
    if (this.captureRafId != null) return;

    this.captureRafId = window.requestAnimationFrame(() => {
      this.captureRafId = null;
      const e = this.pendingCaptureEvent;
      this.pendingCaptureEvent = undefined;
      this.capturePdfSelectionNow(e);
    });
  }

  private capturePdfSelectionNow(evt?: Event): void {
    const pv: any = this.getActivePdfViewAny();
    if (!pv) return;

    const filePath = (() => {
      const f = this.getPdfFileFromView(pv);
      const p = String((f as any)?.path ?? f?.name ?? '').trim();
      return p;
    })();

    // 1) DOM selection (same document)
    const winSel = window.getSelection?.() ?? null;
    const info1 = this.isSelectionWithinActivePdfView(winSel, pv)
      ? this.getSelectionTextAndPage(winSel, pv)
      : { text: '' };
    if (info1.text) {
      const evtType = String((evt as any)?.type ?? '');

      // Cache a drift-free single token for click/double-click style selections.
      // IMPORTANT: do NOT overwrite an already-clean single-token selection.
      // Only fall back to "clicked token" when the selection looks noisy/bleeds.
      let text = info1.text;

      const tokCount0 = this.countTokensLikeEngineNoBreaks(text);
      const norm0 = this.normalizeSingleWordSelection(text);
      const normTok0 = this.countTokensLikeEngineNoBreaks(norm0);

      // If Selection.toString() is already a single token, keep it (just normalized).
      const selectionAlreadySingle =
        tokCount0 === 1 && normTok0 === 1 && !this.looksLikeMarkerChainToken(text);

      if (selectionAlreadySingle) {
        text = norm0;
      } else {
        const looksTiny = tokCount0 <= 2 && text.length <= 60;
        if (looksTiny) {
          const clicked = this.getClickedSingleToken(evt);
          if (clicked) text = clicked;
        }

        // If the selection is still small and normalizable to a single token (footnotes, punctuation), clamp.
        const normTiny = this.normalizeSingleWordSelection(text);
        const tokCount = this.countTokensLikeEngineNoBreaks(text);
        if (tokCount <= 2 && text.length <= 40 && this.countTokensLikeEngineNoBreaks(normTiny) === 1) {
          text = normTiny;
        }
      }

      this.lastPdfSelectionText = text;
      this.lastPdfSelectionRawText = info1.rawText ?? '';
      this.lastPdfSelectionAt = Date.now();
      this.lastPdfSelectionFilePath = filePath;
      this.lastPdfSelectionEventType = evtType;
      this.lastPdfSelectionPage = info1.page;
      this.lastPdfSelectionWordHintInPage = info1.wordHintInPage;
      this.lastPdfSelectionProbe = info1.probe ?? '';
      this.lastPdfSelectionYInPage = info1.yInPage;
      return;
    }

    // 2) iframe selection (some builds)
    const root: HTMLElement | null = pv?.containerEl ?? null;
    if (root) {
      const iframes = Array.from(root.querySelectorAll('iframe')) as HTMLIFrameElement[];
      for (const iframe of iframes) {
        try {
          const info = this.getSelectionTextAndPage(iframe.contentWindow?.getSelection?.() ?? null, pv);
          if (info.text) {
            const evtType = String((evt as any)?.type ?? '');

            // Cache a drift-free single token for click/double-click style selections.
            let text = info.text;

            const tokCount0 = this.countTokensLikeEngineNoBreaks(text);
            const norm0 = this.normalizeSingleWordSelection(text);
            const normTok0 = this.countTokensLikeEngineNoBreaks(norm0);

            const selectionAlreadySingle =
              tokCount0 === 1 && normTok0 === 1 && !this.looksLikeMarkerChainToken(text);

            if (selectionAlreadySingle) {
              text = norm0;
            } else {
              const looksTiny = tokCount0 <= 2 && text.length <= 60;
              if (looksTiny) {
                const clicked = this.getClickedSingleToken(evt);
                if (clicked) text = clicked;
              }

              const normTiny = this.normalizeSingleWordSelection(text);
              const tokCount = this.countTokensLikeEngineNoBreaks(text);
              if (tokCount <= 2 && text.length <= 40 && this.countTokensLikeEngineNoBreaks(normTiny) === 1) {
                text = normTiny;
              }
            }

            this.lastPdfSelectionText = text;
            this.lastPdfSelectionRawText = info.rawText ?? '';
            this.lastPdfSelectionAt = Date.now();
            this.lastPdfSelectionFilePath = filePath;
            this.lastPdfSelectionEventType = evtType;
            this.lastPdfSelectionPage = info.page;
            this.lastPdfSelectionWordHintInPage = info.wordHintInPage;
            this.lastPdfSelectionProbe = info.probe ?? '';
            this.lastPdfSelectionYInPage = info.yInPage;
            return;
          }
        } catch {
          // ignore
        }
      }
    }

    // 3) Explicit user clear with no detectable selection.
    if (this.isExplicitUserClearEvent(evt)) {
      this.lastPdfSelectionText = '';
      this.lastPdfSelectionRawText = '';
      this.lastPdfSelectionAt = Date.now();
      this.lastPdfSelectionPage = undefined;
      this.lastPdfSelectionFilePath = '';
      this.lastPdfSelectionWordHintInPage = undefined;
      this.lastPdfSelectionProbe = '';
      this.lastPdfSelectionYInPage = undefined;
      return;
    }
    // NOTE: no time-based “staleness” clearing here.
  }

  private isSelectionWithinActivePdfView(sel: Selection | null, pv: any): boolean {
    if (!sel || sel.isCollapsed) return false;
    const root: HTMLElement | null = pv?.containerEl ?? null;
    if (!root) return false;

    const rootDoc = root.ownerDocument ?? null;
    const isInside = (n: Node | null): boolean => {
      if (!n) return false;
      const doc = (n as any).ownerDocument ?? null;
      if (rootDoc && doc && doc !== rootDoc) return false;
      const el =
        (n as any).nodeType === Node.ELEMENT_NODE ? (n as any as Element) : (n as any).parentElement ?? null;
      return !!el && root.contains(el);
    };

    return isInside(sel.anchorNode) || isInside(sel.focusNode);
  }

  /**
   * If the cached probe begins *before* the clamped selection token (e.g. PDF.js bleed),
   * trim the probe so it starts at the first occurrence of the selection token.
   *
   * This prevents "drift" where probe-based anchoring starts on an adjacent token.
   */
  private trimProbeToStartAtSelection(selection: string, probe: string): string {
    const sel = String(selection ?? '').trim();
    const pr = String(probe ?? '').trim();
    if (!sel || !pr) return '';

    const target = PdfParser.normalizePdfTokenForMatch(sel);
    if (!target) return '';

    const isPunctOnly = (t: string): boolean => {
      const txt = String(t ?? '').trim();
      if (!txt) return true;
      try {
        return !/[\p{L}\p{N}]/u.test(txt);
      } catch {
        return !/[A-Za-z0-9]/.test(txt);
      }
    };

    const findMatchIndex = (tokens: string[]): number => {
      for (let i = 0; i < tokens.length; i++) {
        if (this.tokenMatchesSelectionKey(tokens[i], target)) return i;
      }
      return -1;
    };

    let toks = PdfParser.tokenizeLikeEngine(pr).filter((t) => t && t !== PdfParser.LINEBREAK_MARKER);
    if (!toks.length) return '';

    let idx = findMatchIndex(toks);

    // If the first attempt fails (or only hits punctuation glue), drop leading punctuation-only
    // tokens so nested ")ADP)-" probes don't shift the anchor away from the real start.
    if (idx < 0) {
      while (toks.length && isPunctOnly(toks[0])) toks = toks.slice(1);
      idx = findMatchIndex(toks);
    }

    if (idx < 0) return '';
    if (idx === 0) return toks.join(' ').trim();

    return toks.slice(idx).join(' ').trim();
  }

  private findStartWordIndexFromSelection(
    fullText: string,
    selection: string,
    preferredIndex?: number,
    opts: { maxDistanceFromPreferred?: number } = {}
  ): number | undefined {

    // This method is the last line of defence for “launch exactly where I clicked”.
    // It intentionally reuses the RSVP engine tokenization so that every alignment
    // decision maps directly onto what the reader displays. The matcher keeps
    // single-token selections permissive (so CD38 vs CD38+ still works) and relies
    // on the caller-provided preferredIndex to bias toward the clicked occurrence
    // instead of the first duplicate elsewhere in the document.

    const normWord = (t: string) => PdfParser.normalizePdfTokenForMatch(t);

    // Tokenize in the SAME token space the engine will use (includes LINEBREAK_MARKER).
    const hayTokensAll = PdfParser.tokenizeLikeEngine(fullText);

    // For matching, ignore LINEBREAK_MARKER; but keep a map back to engine indices.
    const hay: string[] = [];
    const hayIndexMap: number[] = [];
    for (let i = 0; i < hayTokensAll.length; i++) {
      const tok = hayTokensAll[i];
      if (!tok || tok === PdfParser.LINEBREAK_MARKER) continue;
      const n = normWord(tok);
      if (!n) continue;
      hay.push(n);
      hayIndexMap.push(i);
    }

    const needle = PdfParser.tokenizeLikeEngine(selection)
      .filter((t) => t && t !== PdfParser.LINEBREAK_MARKER)
      .slice(0, 12)
      .map(normWord)
      .filter(Boolean);

    if (needle.length === 0) return undefined;

    // Single-token selections must support loose matching (CCL vs CCL-3, CD38 vs CD38+, etc)
    if (needle.length === 1) {
      const targetKey = needle[0];
      const preferEngine =
        typeof preferredIndex === 'number' && Number.isFinite(preferredIndex) ? preferredIndex : undefined;

      const maxDist = (() => {
        if (preferEngine === undefined) return undefined;
        if (opts?.maxDistanceFromPreferred === undefined && targetKey.length > 1) return undefined;
        const capFromCaller = opts?.maxDistanceFromPreferred;
        const capForSingleChar = targetKey.length === 1 ? Math.max(80, Math.min(240, hayTokensAll.length)) : undefined;
        return capFromCaller ?? capForSingleChar;
      })();

      let best: number | undefined;
      let bestWithinCap: number | undefined;
      let bestDist = Number.POSITIVE_INFINITY;

      for (let i = 0; i < hayTokensAll.length; i++) {
        const tok = hayTokensAll[i];
        if (!tok || tok === PdfParser.LINEBREAK_MARKER) continue;
        if (!this.tokenMatchesSelectionKey(tok, targetKey)) continue;

        if (preferEngine === undefined) return i;

        const d = Math.abs(i - preferEngine);
        if (d < bestDist) {
          best = i;
          bestDist = d;
          if (d === 0) bestWithinCap = i;
        }

        if (maxDist !== undefined && d <= maxDist) {
          if (bestWithinCap === undefined || d < Math.abs(bestWithinCap - preferEngine)) {
            bestWithinCap = i;
          }
          if (d === 0) break;
        }
      }

      return bestWithinCap ?? best;
    }

    const first = needle[0];
    const preferEngine =
      typeof preferredIndex === 'number' && Number.isFinite(preferredIndex) ? preferredIndex : undefined;

    const maxDist = opts?.maxDistanceFromPreferred;

    // Convert preferredIndex from engine-token-space to filtered-token-space (hay[]).
    let preferFiltered: number | undefined = undefined;
    if (preferEngine !== undefined && hayIndexMap.length > 0) {
      let lo = 0;
      let hi = hayIndexMap.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (hayIndexMap[mid] < preferEngine) lo = mid + 1;
        else hi = mid - 1;
      }
      preferFiltered = Math.max(0, Math.min(lo, hayIndexMap.length - 1));
    }

    let bestEngine: number | undefined = undefined;
    let bestDist = Number.POSITIVE_INFINITY;
    let bestWithinCap: number | undefined = undefined;
    let bestWithinCapDist = Number.POSITIVE_INFINITY;

    for (let i = 0; i <= hay.length - needle.length; i++) {
      if (hay[i] !== first) continue;

      let ok = true;
      for (let j = 1; j < needle.length; j++) {
        if (hay[i + j] !== needle[j]) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;

      const engineIdx = hayIndexMap[i];
      if (engineIdx === undefined) continue;

      if (preferFiltered === undefined) return engineIdx;

      const dist = Math.abs(i - preferFiltered);
      if (dist < bestDist) {
        bestEngine = engineIdx;
        bestDist = dist;
        if (dist === 0) bestWithinCap = engineIdx;
      }

      if (maxDist !== undefined && dist <= maxDist) {
        if (bestWithinCap === undefined || dist < bestWithinCapDist) {
          bestWithinCap = engineIdx;
          bestWithinCapDist = dist;
        }
        if (dist === 0) break;
      }
    }

    return bestWithinCap ?? bestEngine;
  }

  public alignStartWordIndexToSelection(
    fullText: string,
    selection: string,
    startWordIndex: number,
    probe?: string,
    lookAround = 80,
    opts: { maxDistanceFromHint?: number } = {}
  ): number | undefined {
    const normWord = (t: string) => PdfParser.normalizePdfTokenForMatch(t);

    const target = normWord(String(selection ?? '').trim());
    if (!target) return undefined;

    const tokens = PdfParser.tokenizeLikeEngine(fullText);
    if (!tokens.length) return undefined;

    const start = Math.max(0, startWordIndex - lookAround);
    const end = Math.min(tokens.length - 1, startWordIndex + lookAround);

    const probeRaw = String(probe ?? '').trim();
    const probeAligned = probeRaw ? this.trimProbeToStartAtSelection(selection, probeRaw) || probeRaw : '';

    const probeTokens = probeAligned
      ? PdfParser.tokenizeLikeEngine(probeAligned)
          .filter((t) => t && t !== PdfParser.LINEBREAK_MARKER)
          .map(normWord)
          .filter(Boolean)
      : [];

    const useProbe = probeTokens.length >= 2;
    const distCap = opts?.maxDistanceFromHint ?? (target.length === 1 ? Math.max(lookAround, 120) : undefined);

    let bestIdx: number | undefined = undefined;
    let bestScore = -1;
    let bestDist = Number.POSITIVE_INFINITY;

    const considerRange = (lo: number, hi: number) => {
      for (let i = Math.max(0, lo); i <= Math.min(tokens.length - 1, hi); i++) {
        const tok = tokens[i];
        if (!tok || tok === PdfParser.LINEBREAK_MARKER) continue;
        if (!this.tokenMatchesSelectionKey(tok, target)) continue;

        let score = 1;

        if (useProbe) {
          // score by how many subsequent probe tokens match starting at i
          let matched = 0;
          let j = i;

          for (let p = 0; p < probeTokens.length && j < tokens.length; p++) {
            while (j < tokens.length && tokens[j] === PdfParser.LINEBREAK_MARKER) j++;
            if (j >= tokens.length) break;

            if (normWord(tokens[j]) !== probeTokens[p]) break;
            matched++;
            j++;
          }

          score = 1 + matched;
        }

        const dist = Math.abs(i - startWordIndex);
        if (distCap !== undefined && dist > distCap) continue;
        if (score > bestScore || (score === bestScore && dist < bestDist)) {
          bestScore = score;
          bestDist = dist;
          bestIdx = i;
          if (bestDist === 0 && bestScore > 1) return true;
        }
      }
      return false;
    };

    // First, search locally around the hint to keep the start anchor stable.
    const hitLocal = considerRange(start, end);
    if (hitLocal && bestIdx !== undefined) return bestIdx;

    // If the local window fails (or hint is badly skewed), perform a full sweep
    // to ensure the exact selection token can still be anchored with zero drift.
    considerRange(0, tokens.length - 1);

    return bestIdx;
  }

  public findStartWordIndexFromPdfSelection(
    fullText: string,
    selection: string,
    pageMap?: { pageTexts: string[]; pageWordStarts: number[] },
    selectionPage?: number,
    selectionWordHintInPage?: number,
    selectionProbe?: string,
    selectionYInPage?: number
  ): { index: number | undefined; diagnostics: PdfLaunchDiagnostics } {
    const matchKey = PdfParser.normalizePdfTokenForMatch(selection);
    const tokensAll = PdfParser.tokenizeLikeEngine(fullText);
    const ambiguousSelection = this.isAmbiguousAcronymSelection(selection, matchKey);

    const diagnostics: PdfLaunchDiagnostics = {
      selectionNormalized: selection,
      selectionMatchKey: matchKey,
      selectionPage,
      selectionWordHintInPage,
      selectionYInPage,
      selectionProbe,
      candidates: [],
    };

    const probeRaw = String(selectionProbe ?? '').trim();
    const probeAligned = probeRaw ? this.trimProbeToStartAtSelection(selection, probeRaw) || probeRaw : '';
    const probeWordCount = probeAligned ? PdfParser.countTokensLikeEngineNoBreaks(probeAligned) : 0;

    let preferGlobal: number | undefined = undefined;
    let chosenReason = '';
    let contextTokens: { offset: number; key: string }[] = [];

    // If we have a multi-token probe, anchor it globally first. This catches repeated-token cases
    // where page resolution fails (iframe/DOM quirks) so we can still bias toward the actual
    // clicked occurrence instead of the first match in the document.
    if (probeWordCount >= 2) {
      const globalProbe = this.findStartWordIndexFromSelection(fullText, probeAligned);
      if (globalProbe !== undefined) preferGlobal = globalProbe;
    }

    if (selectionPage && pageMap) {
      const pageIdx = selectionPage - 1;
      if (pageIdx >= 0 && pageIdx < pageMap.pageTexts.length) {
        const base = pageMap.pageWordStarts[pageIdx];
        const pageText = pageMap.pageTexts[pageIdx] ?? '';
        // IMPORTANT: use a newline-insensitive token space for hints; the DOM selection text rarely matches
        // extracted PDF line breaks 1:1, and counting newline tokens here causes drift that grows with page length.
        const wordsInPageNoBreak = pageText ? PdfParser.countTokensLikeEngineNoBreaks(pageText) : 0;

        diagnostics.pageWordCount = wordsInPageNoBreak;
        diagnostics.pageEngineBase = base;

        let preferInPageNoBreak: number = 0;

        const y =
          typeof selectionYInPage === 'number' && Number.isFinite(selectionYInPage)
            ? Math.max(0, Math.min(1, selectionYInPage))
            : undefined;

        const hint =
          typeof selectionWordHintInPage === 'number' && Number.isFinite(selectionWordHintInPage)
            ? selectionWordHintInPage
            : undefined;

        const yEst =
          y !== undefined && wordsInPageNoBreak > 0
            ? Math.round(y * wordsInPageNoBreak)
            : undefined;

        const geometryMaxDist =
          yEst !== undefined && wordsInPageNoBreak > 0
            ? Math.max(120, Math.floor(wordsInPageNoBreak * 0.35))
            : undefined;

        // Default preference: DOM hint if available, else geometry estimate.
        if (hint !== undefined) preferInPageNoBreak = hint;
        else if (yEst !== undefined) preferInPageNoBreak = yEst;
        else preferInPageNoBreak = 0;

        diagnostics.preferredSource = hint !== undefined ? 'pageHint' : yEst !== undefined ? 'geometryY' : 'none';

        // If figure labels / columns scramble DOM order, the DOM hint diverges sharply from y-based estimate.
        // In that case, trust geometry.
        if (hint !== undefined && yEst !== undefined && wordsInPageNoBreak > 0) {
          const bigDisagreement =
            Math.abs(hint - yEst) > Math.max(40, Math.floor(wordsInPageNoBreak * 0.25));
          if (bigDisagreement) preferInPageNoBreak = yEst;
        }

        if (wordsInPageNoBreak > 0) {
          preferInPageNoBreak = Math.max(0, Math.min(preferInPageNoBreak, wordsInPageNoBreak - 1));
        } else {
          preferInPageNoBreak = 0;
        }

        // Convert no-break word index -> engine token index (which includes line-break tokens).
        const preferInPage = (() => {
          const tokens = PdfParser.tokenizeLikeEngine(pageText);
          let nonBreak = 0;
          let lastWordIdx = 0;
          for (let i = 0; i < tokens.length; i++) {
            const tok = tokens[i];
            if (!tok || tok === PdfParser.LINEBREAK_MARKER) continue;
            lastWordIdx = i;
            if (nonBreak === preferInPageNoBreak) return i;
            nonBreak++;
          }
          return lastWordIdx;
        })();

        preferGlobal = base + preferInPage;
        diagnostics.preferredEngineIndex = preferGlobal;

        if (this.isAmbiguousAcronymSelection(selection, matchKey)) {
          contextTokens = this.captureContextTokens(tokensAll, preferGlobal, 3);
          diagnostics.selectionContextKeys = contextTokens.map((c) => c.key);
        }

        const pageTokens = PdfParser.tokenizeLikeEngine(pageText);
        for (let i = 0; i < pageTokens.length; i++) {
          const tok = pageTokens[i];
          if (!tok || tok === PdfParser.LINEBREAK_MARKER) continue;
          const key = PdfParser.normalizePdfTokenForMatch(tok);
          if (!key || !matchKey) continue;
          if (!this.tokenMatchesSelectionKey(tok, matchKey)) continue;
          diagnostics.candidates.push({
            globalIndex: base + i,
            inPageIndex: i,
            token: tok,
            matchKey: key,
            distanceToPreferred: Number.isFinite(preferInPage) ? Math.abs(i - preferInPage) : undefined,
          });
        }

        // Prefer a longer probe when available (disambiguates repeated words).
        if (probeWordCount >= 2) {
          const withinProbe = this.findStartWordIndexFromSelection(pageText, probeAligned, preferInPage, {
            maxDistanceFromPreferred: geometryMaxDist,
          });
          if (withinProbe !== undefined) {
            chosenReason = 'page:probe-match';
            diagnostics.chosenIndex = base + withinProbe;
            diagnostics.chosenReason = chosenReason;
            return { index: base + withinProbe, diagnostics };
          }
        }

        const within = this.findStartWordIndexFromSelection(pageText, selection, preferInPage, {
          maxDistanceFromPreferred: geometryMaxDist,
        });
        if (within !== undefined) {
          chosenReason = 'page:selection-match';
          diagnostics.chosenIndex = base + within;
          diagnostics.chosenReason = chosenReason;
          return { index: base + within, diagnostics };
        }
      }
    }

    if (diagnostics.preferredEngineIndex === undefined && preferGlobal !== undefined) {
      diagnostics.preferredEngineIndex = preferGlobal;
      diagnostics.preferredSource = diagnostics.preferredSource ?? 'probe-global';
    }

    if (!contextTokens.length && this.isAmbiguousAcronymSelection(selection, matchKey)) {
      contextTokens = this.captureContextTokens(tokensAll, diagnostics.preferredEngineIndex, 3);
      if (contextTokens.length) diagnostics.selectionContextKeys = contextTokens.map((c) => c.key);
    }

    const applyContextDisambiguation = (): number | undefined => {
      if (!contextTokens.length || !diagnostics.candidates.length) return undefined;
      const prefer = diagnostics.preferredEngineIndex;
      let best: PdfAnchorCandidate | undefined;
      let bestScore = Number.POSITIVE_INFINITY;
      let bestTieDist = Number.POSITIVE_INFINITY;

      for (const cand of diagnostics.candidates) {
        if (!Number.isFinite(cand.globalIndex)) continue;
        const distanceComponent = Number.isFinite(prefer)
          ? Math.abs((cand.globalIndex as number) - (prefer as number))
          : cand.distanceToPreferred ?? 0;
        let matches = 0;
        let mismatches = 0;
        for (const ctx of contextTokens) {
          const key = this.getTokenKeyAtOffset(tokensAll, cand.globalIndex, ctx.offset);
          if (!key) {
            mismatches++;
            continue;
          }
          if (key === ctx.key) matches++;
          else mismatches++;
        }

        if (ambiguousSelection && matches === 0) {
          cand.contextScore = Number.POSITIVE_INFINITY;
          continue;
        }

        const mismatchPenalty = mismatches * 50;
        const matchBonus = matches > 0 ? Math.min(matches, contextTokens.length) * 5 : 0;
        let score = distanceComponent + mismatchPenalty - matchBonus;
        if (ambiguousSelection && matches < contextTokens.length) score += (contextTokens.length - matches) * 10;
        cand.contextScore = score;
        const tieDist = cand.distanceToPreferred ?? distanceComponent;
        if (score < bestScore || (score === bestScore && tieDist < bestTieDist)) {
          best = cand;
          bestScore = score;
          bestTieDist = tieDist;
        }
      }

      return best?.globalIndex;
    };

    // If page-scoped match fails, still bias toward where the selection occurred.
    if (!diagnostics.candidates.length) {
      const windowRadius = 400;
      const preferred = Number.isFinite(preferGlobal) ? preferGlobal! : Math.floor(tokensAll.length / 2);
      const lo = Math.max(0, preferred - windowRadius);
      const hi = Math.min(tokensAll.length - 1, preferred + windowRadius);
      for (let i = lo; i <= hi; i++) {
        const tok = tokensAll[i];
        if (!tok || tok === PdfParser.LINEBREAK_MARKER) continue;
        const key = PdfParser.normalizePdfTokenForMatch(tok);
        if (!key || !matchKey) continue;
        if (!this.tokenMatchesSelectionKey(tok, matchKey)) continue;
        diagnostics.candidates.push({
          globalIndex: i,
          token: tok,
          matchKey: key,
          distanceToPreferred: Number.isFinite(preferGlobal) ? Math.abs(i - (preferGlobal as number)) : undefined,
        });
      }
    }

    const contextPick = applyContextDisambiguation();
    if (contextPick !== undefined) {
      chosenReason = 'context-disambiguation';
      diagnostics.chosenIndex = contextPick;
      diagnostics.chosenReason = chosenReason;
      return { index: contextPick, diagnostics };
    }

    // If page-scoped match fails, still bias toward where the selection occurred.
    if (probeWordCount >= 2) {
      const idx = this.findStartWordIndexFromSelection(fullText, probeAligned, preferGlobal, {
        maxDistanceFromPreferred: preferGlobal !== undefined ? 240 : undefined,
      });
      if (idx !== undefined) {
        chosenReason = 'document:probe-match';
        diagnostics.chosenIndex = idx;
        diagnostics.chosenReason = chosenReason;
        return { index: idx, diagnostics };
      }
    }

    const idx = this.findStartWordIndexFromSelection(fullText, selection, preferGlobal, {
      maxDistanceFromPreferred: preferGlobal !== undefined ? 240 : undefined,
    });

    diagnostics.chosenIndex = idx;
    diagnostics.chosenReason = idx !== undefined ? 'document:selection-match' : 'not-found';

    return { index: idx, diagnostics };
  }

  private async getPdfDocumentFromActiveView(timeoutMs = 6000): Promise<any> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const pdfView: any = this.getActivePdfViewAny();
      if (!pdfView) throw new Error('No active PDF view');

      // Obsidian internal paths vary by version; probe the common ones.
      const pdfDoc =
        pdfView?.viewer?.child?.pdfViewer?.pdfDocument ??
        pdfView?.viewer?.pdfViewer?.pdfDocument ??
        pdfView?.viewer?.child?.pdfDocument ??
        pdfView?.viewer?.pdfDocument ??
        pdfView?.pdfViewer?.pdfDocument ??
        pdfView?.pdfDocument;

      if (pdfDoc?.numPages) return pdfDoc;
      await new Promise((r) => setTimeout(r, 50));
    }

    const pv: any = this.getActivePdfViewAny();
    console.error('[DashReader] PDF doc not available', {
      viewKeys: pv ? Object.keys(pv) : null,
      viewerKeys: pv?.viewer ? Object.keys(pv.viewer) : null,
      viewerChildKeys: pv?.viewer?.child ? Object.keys(pv.viewer.child) : null,
    });

    throw new Error('PDF document not available');
  }

  public async extractAllTextFromActivePdfView(maxPages = 200): Promise<string> {
    const res = await this.extractAllTextFromActivePdfViewWithPageMap(maxPages);
    return res.fullText;
  }

  public async extractAllTextFromActivePdfViewWithPageMap(maxPages = 200): Promise<PdfPageMap> {
    const pdfDoc = await this.getPdfDocumentFromActiveView(6000);
    return await PdfParser.parsePdfDocumentToPlainTextWithPageMap(pdfDoc, { maxPages });
  }

  public async extractFullTextViaFileFallbackWithPageMap(
    file: TFile,
    maxPages = 200
  ): Promise<PdfPageMap> {
    const buf = await this.app.vault.readBinary(file);
    return await PdfParser.parseToPlainTextWithPageMap(buf, { maxPages });
  }

  public async extractFullTextViaFileFallback(
    file: TFile,
    maxPages = 200
  ): Promise<string> {
    const res = await this.extractFullTextViaFileFallbackWithPageMap(file, maxPages);
    return res.fullText;
  }

  public async getPdfDocumentForDebug(timeoutMs = 6000): Promise<any> {
    return await this.getPdfDocumentFromActiveView(timeoutMs);
  }

  /**
   * Expose the internal match-normalization key for debugging.
   * (Do NOT use this for display; it is only for anchor matching / logs.)
   */
  public getMatchKeyForToken(token: string): string {
    return PdfParser.normalizePdfTokenForMatch(token);
  }

  /**
   * Debug helper: return up to `maxCandidates` engine-token indices in `text`
   * whose normalized token matches the normalized `selection` token.
   *
   * Indices are returned in engine token space (i.e. include '\n' tokens).
   */
  public findCandidateMatchIndicesInText(
    text: string,
    selection: string,
    preferredEngineIndex?: number,
    maxCandidates = 5
  ): number[] {
    const target = PdfParser.normalizePdfTokenForMatch(String(selection ?? '').trim());
    if (!target) return [];

    const tokens = PdfParser.tokenizeLikeEngine(text);
    const matches: number[] = [];

    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (!tok || tok === PdfParser.LINEBREAK_MARKER) continue;
      if (this.tokenMatchesSelectionKey(tok, target)) matches.push(i);
    }

    if (!matches.length) return [];

    if (typeof preferredEngineIndex === 'number' && Number.isFinite(preferredEngineIndex)) {
      matches.sort((a, b) => Math.abs(a - preferredEngineIndex) - Math.abs(b - preferredEngineIndex));
    }

    return matches.slice(0, Math.max(0, maxCandidates | 0));
  }
}
