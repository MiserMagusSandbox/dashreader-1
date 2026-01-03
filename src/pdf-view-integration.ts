// src/pdf-view-integration.ts
// PDF-view integration: active PDF targeting + selection caching + PDF file bytes.
// NOTE: All PDF parsing/classification is done in src/pdf/* (spec-compliant pipeline).

import type { App, Plugin, TFile } from 'obsidian';
import type { PdfNarrativeIndex } from './pdf';
import { parsePdfToNarrativeIndex, parsePdfDocumentToNarrativeIndex } from './pdf';
import { tokenizeForEngine } from './rsvp-engine';

export type PdfSelectionSnapshot = {
  text: string;
  rawText?: string;
  filePath?: string;
  eventType?: string;
  page?: number; // 1-based
  xMidN?: number; // 0..1 (page-local, DOM top-left origin)
  yMidN?: number; // 0..1 (page-local, DOM top-left origin)
  x0n?: number;
  x1n?: number;
  y0n?: number;
  y1n?: number;
  at?: number;
  ageMs?: number;
};

type NarrativeCacheEntry = {
  key: string;
  index?: PdfNarrativeIndex;
  inFlight?: Promise<PdfNarrativeIndex>;
};

type PdfDocLike = {
  numPages: number;
  getPage: (pageNumber: number) => Promise<any>;
};

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

export class PdfViewIntegration {
  private lastSelection: PdfSelectionSnapshot = { text: '' };
  private lastSelectionAt = 0;

  private captureRafId: number | null = null;
  private pendingCaptureEvent: Event | undefined;

  private registeredTargets = new WeakSet<EventTarget>();

  // Workaround: Obsidian can move focus away from a PDF leaf after closing the command palette.
  private lastPdfLeaf: any | null = null;
  private lastPdfLeafAt = 0;

  private narrativeCache = new Map<string, NarrativeCacheEntry>();

  constructor(private app: App, private plugin: Plugin) {}

  public setupSelectionCaching(): void {
    this.plugin.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        const view: any = (this.app.workspace as any).activeLeaf?.view;
        const type = view?.getViewType?.() ?? view?.type;
        if (type === 'pdf') {
          this.lastPdfLeaf = (this.app.workspace as any).activeLeaf ?? null;
          this.lastPdfLeafAt = Date.now();
          this.attachListenersForActivePdfView();
        }
      })
    );

    // If a PDF is already active when the plugin loads, attach listeners immediately.
    if (this.getActivePdfViewAny()) this.attachListenersForActivePdfView();
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

  public getCachedPdfSelection(): PdfSelectionSnapshot {
    const at = this.lastSelectionAt > 0 ? this.lastSelectionAt : undefined;
    const ageMs = at ? Math.max(0, Date.now() - at) : undefined;
    return {
      ...this.lastSelection,
      at,
      ageMs,
    };
  }

  /**
   * Returns the CURRENT PDF selection without using any cached value.
   * This is used by commands where stale selection is unacceptable.
   */
  public getLivePdfSelection(): PdfSelectionSnapshot {
    const pv: any = this.getActivePdfViewAny();
    if (!pv) return { text: '' };

    const file = this.getPdfFileFromView(pv);
    const filePath = String((file as any)?.path ?? file?.name ?? '').trim() || undefined;

    // 1) Main window selection.
    const winSel = window.getSelection?.() ?? null;
    const info1 = this.isSelectionWithinActivePdfView(winSel, pv)
      ? this.extractSelectionSnapshot(winSel, pv)
      : { text: '' };

    if (info1.text) return { ...info1, filePath };

    // 2) iframe selection (some Obsidian builds render PDF inside an iframe).
    const root: HTMLElement | null = pv?.containerEl ?? null;
    if (root) {
      const iframes = Array.from(root.querySelectorAll('iframe')) as HTMLIFrameElement[];
      for (const iframe of iframes) {
        try {
          const sel = iframe.contentWindow?.getSelection?.() ?? null;
          const info = this.extractSelectionSnapshot(sel, pv);
          if (info.text) return { ...info, filePath };
        } catch {
          // ignore
        }
      }
    }

    return { text: '' };
  }

  /**
   * In Obsidian, the command palette can disrupt DOM selection.
   * Cache the most recent meaningful PDF selection so commands can still anchor.
   */
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
    const live = this.getLivePdfSelection();

    // Don't clear cached selection on transient focus changes; only clear on explicit user action.
    if (!live.text) {
      if (evt?.type === 'keyup' && (evt as KeyboardEvent)?.key === 'Escape') {
        this.lastSelection = { text: '' };
        this.lastSelectionAt = Date.now();
      }
      return;
    }

    this.lastSelection = {
      text: String(live.text ?? '').trim(),
      rawText: String(live.rawText ?? ''),
      filePath: live.filePath,
      eventType: (evt as any)?.type,
      page: live.page,
      xMidN: live.xMidN,
      yMidN: live.yMidN,
      x0n: live.x0n,
      x1n: live.x1n,
      y0n: live.y0n,
      y1n: live.y1n,
    };
    this.lastSelectionAt = Date.now();
  }

  private attachListenersForActivePdfView(): void {
    const pv: any = this.getActivePdfViewAny();
    if (!pv) return;

    const container: HTMLElement | null = pv?.containerEl ?? null;
    if (!container) return;

    const register = (target: EventTarget | null) => {
      if (!target || this.registeredTargets.has(target)) return;
      this.registeredTargets.add(target);

      const handler = (evt: Event) => this.capturePdfSelection(evt);
      // selectionchange is on Document; mouse/pointer events on both.
      this.plugin.registerDomEvent(target as any, 'selectionchange', handler);
      this.plugin.registerDomEvent(target as any, 'mouseup', handler);
      this.plugin.registerDomEvent(target as any, 'pointerup', handler);
      this.plugin.registerDomEvent(target as any, 'dblclick', handler);
      this.plugin.registerDomEvent(target as any, 'keyup', handler);
    };

    register(container);
    register(container.ownerDocument);

    // iframe documents (if any)
    const iframes = Array.from(container.querySelectorAll('iframe')) as HTMLIFrameElement[];
    for (const iframe of iframes) {
      try {
        register(iframe.contentDocument);
        register(iframe.contentWindow);
      } catch {
        // ignore
      }
    }
  }

  public normalizeSingleWordSelection(raw: string): string {
    const s = String(raw ?? '').trim();
    if (!s) return '';

    // Strip common wrappers/punctuation that PDF text layers frequently include.
    // Keep internal characters unchanged.
    let out = s
      .replace(/^[\s\(\[\{<\"'“”‘’`]+/g, '')
      .replace(/[\s\)\]\}>\"'“”‘’`]+$/g, '');

    out = out
      .replace(/^[\s\.,;:!?]+/g, '')
      .replace(/[\s\.,;:!?]+$/g, '')
      .trim();

    return out;
  }

  public countTokensLikeEngineNoBreaks(text: string): number {
    const toks = tokenizeForEngine(String(text ?? ''));
    let n = 0;
    for (const t of toks) {
      if (!t || t === '\n') continue;
      n++;
    }
    return n;
  }

  public async readPdfFileData(file: TFile): Promise<ArrayBuffer> {
    // Obsidian: readBinary returns an ArrayBuffer
    return await this.app.vault.readBinary(file);
  }

  /** Parse/cached narrative index for a PDF file. */
  public async getOrParseNarrativeIndex(file: TFile, opts?: { maxPages?: number }): Promise<PdfNarrativeIndex> {
    const path = String((file as any)?.path ?? file?.name ?? '').trim();
    const mtime = Number((file as any)?.stat?.mtime ?? 0) || 0;
    const size = Number((file as any)?.stat?.size ?? 0) || 0;
    const maxPages = opts?.maxPages ?? 200;
    const key = `${mtime}:${size}:${maxPages}`;

    const existing = this.narrativeCache.get(path);
    if (existing?.key === key) {
      if (existing.index) return existing.index;
      if (existing.inFlight) return await existing.inFlight;
    }

    const inFlight = (async () => {
      // Prefer the already-loaded PDFDocument from the active PDF view when it matches the file.
      // This avoids pdf.js worker/module quirks and matches Obsidian's own viewer instance.
      const pv = this.getActivePdfViewAny();
      const pvFile = this.getPdfFileFromView(pv);
      const pvPath = String((pvFile as any)?.path ?? '').trim();
      const sameFile =
        (!!pvFile && !!path && pvPath && pvPath === path) ||
        (!!pvFile && !path && !!pvFile.name && pvFile.name === file.name) ||
        (!!pvFile && !!path && !pvPath && pvFile.name === file.name);

      if (pv && sameFile) {
        try {
          const pdfDoc = await this.getPdfDocumentFromActiveView(6000);
          return await parsePdfDocumentToNarrativeIndex(pdfDoc as unknown as PdfDocLike, { maxPages });
        } catch (e) {
          // Fall back to file-bytes parsing.
          console.warn('[DashReader][pdf] active-view pdfDocument parse failed; falling back to file bytes', e);
        }
      }

      const data = await this.readPdfFileData(file);
      return await parsePdfToNarrativeIndex(data, { maxPages });
    })();

    this.narrativeCache.set(path, { key, inFlight });
    const index = await inFlight;
    this.narrativeCache.set(path, { key, index });
    return index;
  }

  // ---------- PDFDocument access (active view) ----------

  private async getPdfDocumentFromActiveView(timeoutMs = 6000): Promise<PdfDocLike> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const pdfView: any = this.getActivePdfViewAny();
      if (!pdfView) throw new Error('No active PDF view');

      // Obsidian internal paths vary by version; probe common ones.
      const pdfDoc: any =
        pdfView?.viewer?.child?.pdfViewer?.pdfDocument ??
        pdfView?.viewer?.pdfViewer?.pdfDocument ??
        pdfView?.viewer?.child?.pdfDocument ??
        pdfView?.viewer?.pdfDocument ??
        pdfView?.pdfViewer?.pdfDocument ??
        pdfView?.pdfDocument;

      if (pdfDoc?.numPages) return pdfDoc as PdfDocLike;
      await new Promise((r) => setTimeout(r, 50));
    }

    const pv: any = this.getActivePdfViewAny();
    console.error('[DashReader][pdf] PDF document not available in active view', {
      viewKeys: pv ? Object.keys(pv) : null,
      viewerKeys: pv?.viewer ? Object.keys(pv.viewer) : null,
      viewerChildKeys: pv?.viewer?.child ? Object.keys(pv.viewer.child) : null,
    });
    throw new Error('PDF document not available');
  }

  // ---------- Selection helpers ----------

  private isSelectionWithinActivePdfView(sel: Selection | null, pv: any): boolean {
    if (!sel || sel.isCollapsed || sel.rangeCount < 1) return false;
    const container: HTMLElement | null = pv?.containerEl ?? null;
    if (!container) return false;

    try {
      const r = sel.getRangeAt(0);
      const n = r.commonAncestorContainer;
      if (container.contains(n as any)) return true;

      // iframe build: selection lives in a different document.
      const doc = (n as any)?.ownerDocument ?? null;
      const iframes = Array.from(container.querySelectorAll('iframe')) as HTMLIFrameElement[];
      return iframes.some((f) => f.contentDocument === doc);
    } catch {
      return false;
    }
  }

  private extractSelectionSnapshot(sel: Selection | null, pv: any): PdfSelectionSnapshot {
    if (!sel || sel.isCollapsed) return { text: '' };
    const rawText = String(sel.toString?.() ?? '');
    const text = rawText.trim();
    if (!text) return { text: '' };

    let page: number | undefined;
    let xMidN: number | undefined;
    let yMidN: number | undefined;
    let x0n: number | undefined;
    let x1n: number | undefined;
    let y0n: number | undefined;
    let y1n: number | undefined;

    try {
      if (sel.rangeCount < 1) return { text, rawText };
      const range = sel.getRangeAt(0);
      const pageEl = this.findPageElementForRange(pv, range);

      if (pageEl) {
        const num = this.readPageNumber(pageEl);
        if (num) page = num;

        const pr = pageEl.getBoundingClientRect();
        if (pr.width > 0 && pr.height > 0) {
          const rects = Array.from(range.getClientRects?.() ?? []);
          const cand = rects.length ? rects : [range.getBoundingClientRect()];

          let minL = Number.POSITIVE_INFINITY;
          let maxR = Number.NEGATIVE_INFINITY;
          let minT = Number.POSITIVE_INFINITY;
          let maxB = Number.NEGATIVE_INFINITY;
          let any = false;

          for (const rr of cand) {
            // Only include the portion intersecting this page.
            const left = Math.max(rr.left, pr.left);
            const right = Math.min(rr.right, pr.right);
            const top = Math.max(rr.top, pr.top);
            const bottom = Math.min(rr.bottom, pr.bottom);
            if (!(right > left && bottom > top)) continue;
            any = true;
            if (left < minL) minL = left;
            if (right > maxR) maxR = right;
            if (top < minT) minT = top;
            if (bottom > maxB) maxB = bottom;
          }

          if (!any) {
            const r = range.getBoundingClientRect();
            minL = r.left; maxR = r.right; minT = r.top; maxB = r.bottom;
          }

          const xm = (((minL + maxR) / 2) - pr.left) / pr.width;
          const ym = (((minT + maxB) / 2) - pr.top) / pr.height;
          const rx0 = (minL - pr.left) / pr.width;
          const rx1 = (maxR - pr.left) / pr.width;
          const ry0 = (minT - pr.top) / pr.height;
          const ry1 = (maxB - pr.top) / pr.height;
          if (Number.isFinite(xm)) xMidN = clamp01(xm);
          if (Number.isFinite(ym)) yMidN = clamp01(ym);
          if (Number.isFinite(rx0)) x0n = clamp01(rx0);
          if (Number.isFinite(rx1)) x1n = clamp01(rx1);
          if (Number.isFinite(ry0)) y0n = clamp01(ry0);
          if (Number.isFinite(ry1)) y1n = clamp01(ry1);
        }
      }
    } catch {
      // ignore
    }

    // Fallback page number from viewer if not found.
    if (!page) page = this.getCurrentPdfPageNumber(pv);

    return { text, rawText, page, xMidN, yMidN, x0n, x1n, y0n, y1n };
  }

  private readPageNumber(pageEl: HTMLElement): number | undefined {
    const attr = pageEl.getAttribute('data-page-number') ?? pageEl.getAttribute('data-page') ?? '';
    const ds = (pageEl as any)?.dataset?.pageNumber ?? (pageEl as any)?.dataset?.page;
    const raw = String(ds ?? attr ?? '').trim();
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }

  private findPageElementForRange(pv: any, range: Range): HTMLElement | null {
    // 1) Walk up from the selection node.
    const fromNode = this.walkUpToPageElement(range.startContainer);
    if (fromNode) return fromNode;

    // 2) Use the selection rectangle midpoint to find the page element.
    const container: HTMLElement | null = pv?.containerEl ?? null;
    if (!container) return null;

    try {
      const r = range.getBoundingClientRect();
      const x = (r.left + r.right) / 2;
      const y = (r.top + r.bottom) / 2;
      const pages = this.queryPageElements(container);

      // Prefer a page that contains the point.
      for (const p of pages) {
        const pr = p.getBoundingClientRect();
        if (x >= pr.left && x <= pr.right && y >= pr.top && y <= pr.bottom) return p;
      }

      // Fallback: nearest page by vertical distance.
      let best: HTMLElement | null = null;
      let bestD = Number.POSITIVE_INFINITY;
      for (const p of pages) {
        const pr = p.getBoundingClientRect();
        const d = y < pr.top ? (pr.top - y) : y > pr.bottom ? (y - pr.bottom) : 0;
        if (d < bestD) { bestD = d; best = p; }
      }
      return best;
    } catch {
      return null;
    }
  }

  private walkUpToPageElement(node: Node | null): HTMLElement | null {
    let el: HTMLElement | null = null;
    let cur: any = node;
    while (cur) {
      if (cur instanceof HTMLElement) {
        const has = cur.hasAttribute('data-page-number') || cur.hasAttribute('data-page') || cur.classList.contains('page');
        if (has) {
          const num = this.readPageNumber(cur);
          if (num) return cur;
        }
        el = cur;
      }
      cur = cur.parentNode;
    }
    return null;
  }

  private queryPageElements(container: HTMLElement): HTMLElement[] {
    const out: HTMLElement[] = [];
    const els = Array.from(container.querySelectorAll('[data-page-number], [data-page], .page')) as HTMLElement[];
    for (const e of els) {
      if (this.readPageNumber(e)) out.push(e);
    }
    return out;
  }
}
