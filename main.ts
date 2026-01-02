import { Plugin, Notice, MarkdownView, Menu, Editor } from 'obsidian';
import { DashReaderModal } from './src/rsvp-view';
import { DashReaderSettingTab } from './src/settings';
import { DashReaderSettings } from './src/types';
import { validateSettings } from './src/services/settings-validator';
import { PdfViewIntegration } from './src/pdf-view-integration';
import { PdfParser } from './src/pdf-parser';
import { TFile } from 'obsidian';

// Temporary Step-2 debug (remove when PDF command behaviour is stable).
const DEBUG_PDF_SELECTION = true;

export default class DashReaderPlugin extends Plugin {
  private currentModal: DashReaderModal | null = null;
  private pdf!: PdfViewIntegration;

  settings!: DashReaderSettings;

  async onload() {
    await this.loadSettings();

    // PDF selection + active-view tracking (selection caching for command palette).
    this.pdf = new PdfViewIntegration(this.app, this);
    this.pdf.setupSelectionCaching();

    this.addRibbonIcon('zap', 'Launch speed-reader from cursor', () => {
      void this.launchFromCursor();
    });

    this.addCommand({
      id: 'pdf-dump-extraction-report',
      name: 'PDF: Dump extraction report (DashReader)',
      callback: () => void this.dumpPdfExtractionReport(),
    });

    this.addCommand({
      id: 'open',
      name: 'Launch (cursor / selected word)',
      callback: () => void this.launchFromCursor(),
    });

    this.addCommand({
      id: 'read-selection',
      name: 'Read selected text',
      callback: () => void this.readSelectedTextFromActiveView(),
    });

    this.addCommand({
      id: 'read-note',
      name: 'Read entire note (or PDF)',
      callback: () => void this.readActiveFileOrPdf(),
    });

    // Context menu (Markdown editor only)
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
        const selection = editor.getSelection();
        if (!selection) return;
        menu.addItem((item) => {
          item
            .setTitle('Read with speed reader')
            .setIcon('zap')
            .onClick(() => {
              const modal = this.openModal({ skipInitialAutoLoad: true });
              modal.loadText(selection);
            });
        });
      })
    );

    this.addSettingTab(new DashReaderSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on('layout-change', () => {
        if (this.currentModal && this.currentModal.isOpen) {
          this.currentModal.updateSettings(this.settings);
        }
      })
    );
  }

  onunload() {
    if (this.currentModal) {
      this.currentModal.close();
      this.currentModal = null;
    }
  }

  async loadSettings() {
    const rawSettings = (await this.loadData()) as Partial<DashReaderSettings> | null;
    this.settings = validateSettings(rawSettings);

    // Create data.json immediately on first run so it exists on disk
    if (!rawSettings) {
      await this.saveData(this.settings);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    if (this.currentModal && this.currentModal.isOpen) {
      this.currentModal.updateSettings(this.settings);
    }
  }

  private getActiveFileSafe(): any | null {
    const ws = this.app.workspace;
    return ws.getActiveFile() ?? ((ws.activeLeaf?.view as any)?.file ?? null);
  }

  private getDomSelectionText(): string {
    return (window.getSelection?.()?.toString?.() ?? '').trim();
  }

  private openModal(options?: { skipInitialAutoLoad?: boolean }): DashReaderModal {
    if (this.currentModal && this.currentModal.isOpen) return this.currentModal;
    if (this.currentModal) this.currentModal.close();

    this.currentModal = new DashReaderModal(
      this.app,
      this.settings,
      () => {
        this.currentModal = null;
      },
      () => void this.saveSettings()
    );

    if (options?.skipInitialAutoLoad) {
      this.currentModal.requestSkipInitialAutoLoadOnce();
    }

    this.currentModal.open();

    // If a PDF view is active, auto-load the PDF into the modal.
    // IMPORTANT: do not auto-load when the caller asked to skip initial autoload.
    if (!options?.skipInitialAutoLoad) {
      if (this.pdf.getActivePdfViewAny()) {
        void this.readActiveFileOrPdf();
      }
    }

    return this.currentModal;
  }

  private async launchFromCursor(): Promise<void> {
    const pdfView = this.pdf.getActivePdfViewAny();
    const file = this.pdf.getActiveFilePreferPdf(this.getActiveFileSafe());
    if (!file) {
      new Notice('No active file found');
      return;
    }
  
    // Markdown (or anything that isn't a PDF view): keep existing behavior.
    // The modal's AutoLoadManager will load from the cursor.
    if (!pdfView) {
      this.openModal();
      return;
    }

    // PDF: start from a single selected word.
    const liveSel = this.pdf.getLivePdfSelection();
    const cachedSel = this.pdf.getCachedPdfSelection();

    const activePdfPath = String((file as any)?.path ?? file.name ?? '').trim();

    const liveOk =
      !!liveSel.text && (!liveSel.filePath || !activePdfPath || liveSel.filePath === activePdfPath);

    const cachedOk =
      !!cachedSel.text &&
      (cachedSel.ageMs ?? Number.POSITIVE_INFINITY) <= 10_000 &&
      (!cachedSel.filePath || !activePdfPath || cachedSel.filePath === activePdfPath);

    const liveNormForSingle = liveOk ? this.pdf.normalizeSingleWordSelection(liveSel.text) : '';

    const liveTokRaw = liveOk ? this.pdf.countTokensLikeEngineNoBreaks(liveSel.text) : 0;
    const liveTokNorm = liveOk ? this.pdf.countTokensLikeEngineNoBreaks(liveNormForSingle) : 0;
    const liveIsSingle = liveOk && liveTokRaw === 1;

    const cachedIsSingle = cachedOk && this.pdf.countTokensLikeEngineNoBreaks(cachedSel.text) === 1;
    const cachedVeryRecent = cachedOk && (cachedSel.ageMs ?? Number.POSITIVE_INFINITY) <= 5000;

    // If live selection is 2 tokens but normalizing would clamp to 1, treat as PDF.js "bleed".
    // In that case, prefer the cached single-token selection captured from the click event.
    const liveLooksLikeBleed = liveOk && !liveIsSingle && liveTokRaw <= 2 && liveTokNorm === 1;

    const selectionSource: 'live' | 'cache' | 'none' = liveIsSingle
      ? 'live'
      : cachedIsSingle && cachedVeryRecent && liveLooksLikeBleed
        ? 'cache'
        : liveOk
          ? 'live'
          : cachedOk
            ? 'cache'
            : 'none';

    const selInfo =
      selectionSource === 'live'
        ? liveSel
        : selectionSource === 'cache'
          ? cachedSel
          : { text: '' };

    const selectionRaw = (selInfo.text ?? '').trim();
    if (!selectionRaw) {
      new Notice('Double-click a single word in the PDF first');
      return;
    }

    // CRITICAL: clamp/normalize the selection BEFORE enforcing “exactly one word”.
    // This strips wrapping brackets (e.g. "(word)" / "word)") and ignores punctuation-only bleed.
    const normalized = this.pdf.normalizeSingleWordSelection(selectionRaw);

    const fallbackToSelectionOnly = (why: string) => {
      console.info('[DashReader][pdf-launch:fallback-selection]', { why, selectionRaw, normalized });
      const modal = this.openModal({ skipInitialAutoLoad: true });
      modal.loadPlainText(selectionRaw || normalized, { fileName: file.name, lineNumber: 1, cursorPosition: 1 });
      new Notice('Could not anchor selection in PDF; reading the selected text only.');
    };

    if (DEBUG_PDF_SELECTION) {
      console.debug('[DashReader][pdf-select]', {
        command: 'launchFromCursor',
        selectionSource,
        selectionRaw,
        normalized,
        selectionTokens: this.pdf.tokenizeLikeEngine(normalized),
        page: (selInfo as any).page,
        wordHintInPage: (selInfo as any).wordHintInPage,
        yInPage: (selInfo as any).yInPage,
        probe: (selInfo as any).probe,
      });
    }

    const isSingle = this.pdf.countTokensLikeEngineNoBreaks(normalized) === 1;
    const selection = isSingle ? normalized : '';

    if (!selection) {
      new Notice('Double-click a single word (no drag selection). Use “Read selected text” for ranges.');
      return;
    }

    const selPage = selInfo.page ?? this.pdf.getCurrentPdfPageNumber(pdfView);
    const selWordHintInPage = selInfo.wordHintInPage;
    const selProbe = selInfo.probe;
    const selYInPage = selInfo.yInPage;

    if (!selPage) {
      new Notice('Could not determine which PDF page the selection is on');
      return;
    }

    const inHeaderFooterBand =
      typeof selYInPage === 'number' &&
      Number.isFinite(selYInPage) &&
      (selYInPage <= 0.10 || selYInPage >= 0.90);

    try {
      let fullText = '';
      let pageMap: { pageTexts: string[]; pageWordStarts: number[] } | undefined;

      try {
        const res = await this.pdf.extractAllTextFromActivePdfViewWithPageMap(200);
        fullText = res.fullText;
        pageMap = { pageTexts: res.pageTexts, pageWordStarts: res.pageWordStarts };
      } catch {
        const res = await this.pdf.extractFullTextViaFileFallbackWithPageMap(file, 200);
        fullText = res.fullText;
        pageMap = { pageTexts: res.pageTexts, pageWordStarts: res.pageWordStarts };
      }

      if (!fullText) {
        new Notice('No text could be extracted from this PDF');
        return;
      }

      const selectionLookup = this.pdf.findStartWordIndexFromPdfSelection(
        fullText,
        selection,
        pageMap,
        selPage,
        selWordHintInPage,
        selProbe,
        selYInPage
      );

      let startWordIndex = selectionLookup.index;

      if (startWordIndex === undefined) {
        // Step 1 DEVLOG instrumentation (console): selection anchor debug on failures.
        console.info('[DashReader][pdf-anchor-miss]', {
          selectionRaw,
          selectionClamped: selection,
          diagnostics: selectionLookup.diagnostics,
        });

        if (inHeaderFooterBand) {
          new Notice(
            'Selected word may be in a header/footer region (and could be removed during extraction). Trying selected text only.'
          );
        }
        fallbackToSelectionOnly('start-index-not-found');
        return;
      }

      // Enforce "no drift": align to the nearest actual occurrence of the selected token.
      const aligned = this.pdf.alignStartWordIndexToSelection(fullText, selection, startWordIndex, selProbe, 80);
      if (aligned === undefined) {
        try {
          console.debug('[DashReader][pdf-anchor-align-fail]', {
            selectionRaw,
            selectionClamped: selection,
            normMatchKey: this.pdf.getMatchKeyForToken(selection),
            startWordIndex,
            page: selPage,
            wordHintInPage: selWordHintInPage,
            yInPage: selYInPage,
            probe: selProbe,
            windowAtStart: this.pdf.getEngineTokenWindow(fullText, startWordIndex, 6),
          });
        } catch {}
        fallbackToSelectionOnly('anchor-align-fail');
        return;
      }
      if (aligned !== startWordIndex) {
        selectionLookup.diagnostics.chosenReason = `${selectionLookup.diagnostics.chosenReason ?? 'match'} -> aligned-nearby`;
      }
      startWordIndex = aligned;

      // Final hard guard: token at startWordIndex must match the selected token key.
      // If not, scan locally for the nearest matching token.
      {
        const toks = this.pdf.tokenizeLikeEngine(fullText);
        const selTok = selection; // already clamped by normalizeSingleWordSelection
        const tokenAt = toks[startWordIndex] ?? '';

        if (!this.pdf.tokenMatchesSelectionToken(tokenAt, selTok)) {
          const radius = 12;
          let best: number | undefined;
          let bestDist = Number.POSITIVE_INFINITY;

          const lo = Math.max(0, startWordIndex - radius);
          const hi = Math.min(toks.length - 1, startWordIndex + radius);

          for (let i = lo; i <= hi; i++) {
            const tok = toks[i];
            if (!tok || tok === '\n') continue;
            if (this.pdf.tokenMatchesSelectionToken(tok, selTok)) {
              const d = Math.abs(i - startWordIndex);
              if (d < bestDist) {
                best = i;
                bestDist = d;
              }
            }
          }

          if (best !== undefined) {
            selectionLookup.diagnostics.chosenReason = `${selectionLookup.diagnostics.chosenReason ?? 'match'} -> snapped-nearby`;
            startWordIndex = best;
          } else {
            fallbackToSelectionOnly('selection-token-not-found-nearby');
            return;
          }
        }
      }

      selectionLookup.diagnostics.chosenIndex = startWordIndex;

      const dbg = this.pdf.getEngineTokenWindow(fullText, startWordIndex, 20);

      console.info('[DashReader][pdf-launch]', {
        selectionRaw,
        selectionNormalized: selection,
        selectionMatchKey: selectionLookup.diagnostics.selectionMatchKey,
        selectionTokens: this.pdf.tokenizeLikeEngine(selection),
        page: selPage,
        wordHintInPage: selWordHintInPage,
        yInPage: selYInPage,
        probe: selProbe,
        tokenWindow: dbg,
        candidates: selectionLookup.diagnostics.candidates,
        preferredEngineIndex: selectionLookup.diagnostics.preferredEngineIndex,
        preferredSource: selectionLookup.diagnostics.preferredSource,
        chosenIndex: selectionLookup.diagnostics.chosenIndex,
        chosenReason: selectionLookup.diagnostics.chosenReason,
      });

      const modal = this.openModal({ skipInitialAutoLoad: true });

      modal.loadPlainText(fullText, {
        fileName: file.name,
        lineNumber: 1,
        cursorPosition: startWordIndex,
      });
    } catch (err) {
      console.error('[DashReader] Launch from cursor (PDF) failed', err);
      new Notice('Could not extract text from this PDF');
    }
  }

  private async readSelectedTextFromActiveView(): Promise<void> {
    const pdfView = this.pdf.getActivePdfViewAny();
    const file = this.pdf.getActiveFilePreferPdf(this.getActiveFileSafe());
    if (!file) {
      new Notice('No active file found');
      return;
    }

    const ext = String(file.extension ?? '').toLowerCase();
    const isPdf = !!pdfView || ext === 'pdf';

    if (!isPdf) {
      const mdView = this.app.workspace.getActiveViewOfType(MarkdownView);
      const editorSelection = mdView?.editor?.getSelection?.()?.trim?.() ?? '';
      const domSelection = this.getDomSelectionText();
      const selection = editorSelection || domSelection;
  
      if (!selection) {
        new Notice('Please select some text first');
        return;
      }

      const lineNumber = mdView?.editor ? mdView.editor.getCursor().line + 1 : undefined;
      const modal = this.openModal({ skipInitialAutoLoad: true });
      modal.loadText(selection, { fileName: file.name, lineNumber });
      return;
    }

    if (!pdfView) {
      new Notice('Open the PDF and select some text first');
      return;
    }

    const live = this.pdf.getLivePdfSelection();
    const cached = this.pdf.getCachedPdfSelection();

    const activePdfPath = String((file as any)?.path ?? file.name ?? '').trim();

    const liveOk = !!live.text && (!live.filePath || !activePdfPath || live.filePath === activePdfPath);
    const cachedOk =
      !!cached.text &&
      (cached.ageMs ?? Number.POSITIVE_INFINITY) <= 8000 &&
      (!cached.filePath || !activePdfPath || cached.filePath === activePdfPath);

    const selectionSource: 'live' | 'cache' | 'none' =
      liveOk ? 'live' : cachedOk ? 'cache' : 'none';

    const selInfo =
      selectionSource === 'live'
        ? live
        : selectionSource === 'cache'
          ? cached
          : { text: '' };

    const selection = (selInfo.text ?? '').trim();

    if (DEBUG_PDF_SELECTION) {
      console.debug('[DashReader][pdf-select]', {
        command: 'readSelectedText',
        selectionSource,
        rawSelection: (selInfo as any).rawText,
        selection,
        normalizedSingleWord: this.pdf.normalizeSingleWordSelection(selection),
        selectionTokens: this.pdf.tokenizeLikeEngine(selection),
        page: (selInfo as any).page,
        wordHintInPage: (selInfo as any).wordHintInPage,
        yInPage: (selInfo as any).yInPage,
        probe: (selInfo as any).probe,
      });
    }

    if (!selection) {
      new Notice('Select some text in the PDF first');
      return;
    }

    const modal = this.openModal({ skipInitialAutoLoad: true });
    modal.loadPlainText(selection, { fileName: file.name, lineNumber: 1 });
  }

  private async readActiveFileOrPdf(): Promise<void> {
    const pdfView = this.pdf.getActivePdfViewAny();
    const file = this.pdf.getActiveFilePreferPdf(this.getActiveFileSafe());
    if (!file) {
      new Notice('No active file found');
      return;
    }

    const ext = String(file.extension ?? '').toLowerCase();
    const isPdf = !!pdfView || ext === 'pdf';
    const modal = this.openModal({ skipInitialAutoLoad: true });

    if (!isPdf) {
      const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
      const content = activeView?.editor?.getValue() ?? (await this.app.vault.read(file));
      modal.loadText(content, { fileName: file.name, lineNumber: 1 });
      return;
    }

    try {
      const text = pdfView
        ? await this.pdf.extractAllTextFromActivePdfView(200)
        : await this.pdf.extractFullTextViaFileFallback(file, 200);

      if (!text) {
        new Notice('No text could be extracted from this PDF');
        return;
      }
      modal.loadPlainText(text, { fileName: file.name, lineNumber: 1 });
    } catch (err) {
      console.error('[DashReader] PDF extract failed; trying file fallback', err);

      if (pdfView) {
        try {
          const text = await this.pdf.extractFullTextViaFileFallback(file, 200);
          if (!text) {
            new Notice('No text could be extracted from this PDF');
            return;
          }
          modal.loadPlainText(text, { fileName: file.name, lineNumber: 1 });
          return;
        } catch (err2) {
          console.error('[DashReader] PDF file fallback extract failed', err2);
        }
      }

      new Notice('Could not extract text from this PDF');
    }
  }

  private async dumpPdfExtractionReport(): Promise<void> {
    const pdfView = this.pdf.getActivePdfViewAny();
    const file = this.pdf.getActiveFilePreferPdf(this.getActiveFileSafe());

    if (!pdfView || !file || String((file as any)?.extension ?? '').toLowerCase() !== 'pdf') {
      new Notice('Open a PDF first');
      return;
    }

    try {
      const pdfDoc = await this.pdf.getPdfDocumentForDebug(6000);

      const report = await PdfParser.parsePdfDocumentToDebugReport(pdfDoc, {
        maxPages: 60,
        sampleLines: 10,
      });

      const page1 = report.pages.find((p) => p.page === 1) ?? null;

      const slim = {
        file: String((file as any)?.path ?? (file as any)?.name ?? ''),
        totalPages: report.totalPages,
        headerBand: report.headerBand,
        footerBand: report.footerBand,
        headerSigs: report.headerSigs,
        footerSigs: report.footerSigs,
        page1: page1
          ? {
              removedHeaderLines: page1.removedHeaderLines,
              removedFooterLines: page1.removedFooterLines,
              topLines: page1.topLines.map((l) => ({ yNorm: l.yNorm, text: l.text, norm: l.norm })),
              bottomLines: page1.bottomLines.map((l) => ({ yNorm: l.yNorm, text: l.text, norm: l.norm })),
            }
          : null,
        removedCountsByPage: report.pages.map((p) => ({
          page: p.page,
          removedHeaderLines: p.removedHeaderLines,
          removedFooterLines: p.removedFooterLines,
        })),
      };

      // --- Anchor trace: capture selection -> preferred -> candidates (NO behaviour changes) ---
      const filePath = String((file as any)?.path ?? (file as any)?.name ?? '').trim();

      const liveSel = this.pdf.getLivePdfSelection();
      const cachedSel = this.pdf.getCachedPdfSelection();

      const liveOk = !!liveSel.text && (!liveSel.filePath || liveSel.filePath === filePath);
      const cachedOk =
        !!cachedSel.text &&
        (cachedSel.ageMs ?? Number.POSITIVE_INFINITY) <= 15_000 &&
        (!cachedSel.filePath || cachedSel.filePath === filePath);

      const selInfo = cachedOk ? cachedSel : liveOk ? liveSel : { text: '' } as any;

      const selectionRaw = String(selInfo.text ?? '').trim();
      const normalized = selectionRaw ? this.pdf.normalizeSingleWordSelection(selectionRaw) : '';

      const anchorTrace: any = {
        selection: {
          selectionRaw,
          normalizedSingleWord: normalized,
          selectionTokens: normalized ? this.pdf.tokenizeLikeEngine(normalized) : [],
          selectionSource: cachedOk ? 'cache' : liveOk ? 'live' : 'none',
          eventType: (selInfo as any).eventType ?? undefined,
          page: selInfo.page,
          wordHintInPage: selInfo.wordHintInPage,
          yInPage: selInfo.yInPage,
          probe: selInfo.probe,
          filePath,
          ageMs: (selInfo as any).ageMs,
        },
        preferred: null,
        candidatesOnPage: [],
        note: '',
      };

      if (!normalized) {
        anchorTrace.note = 'No cached/live PDF selection available. Double-click a token in the PDF, then run this command immediately.';
      } else if (this.pdf.countTokensLikeEngineNoBreaks(normalized) !== 1) {
        anchorTrace.note = 'Selection is not a single engine token after normalisation (needs single word).';
      } else {
        // Extract text + pageMap (same extraction family as launch uses)
        let fullText = '';
        let pageTexts: string[] = [];
        let pageWordStarts: number[] = [];

        try {
          const res = await this.pdf.extractAllTextFromActivePdfViewWithPageMap(200);
          fullText = res.fullText;
          pageTexts = res.pageTexts;
          pageWordStarts = res.pageWordStarts;
        } catch {
          const res = await this.pdf.extractFullTextViaFileFallbackWithPageMap(file, 200);
          fullText = res.fullText;
          pageTexts = res.pageTexts;
          pageWordStarts = res.pageWordStarts;
        }

        const page = Number(selInfo.page ?? 1) || 1;
        const pageIdx = Math.max(0, page - 1);
        const pageText = pageTexts[pageIdx] ?? '';
        const pageBase = pageWordStarts[pageIdx] ?? 0;

        const pageToks = this.pdf.tokenizeLikeEngine(pageText);
        const wordsInPageNoBreaks = this.pdf.countTokensLikeEngineNoBreaks(pageText);

        const noBreakToEngineIndex = (text: string, noBreakIdx: number): number => {
          const toks = this.pdf.tokenizeLikeEngine(text);
          let nb = 0;
          const target = Math.max(0, noBreakIdx | 0);
          for (let i = 0; i < toks.length; i++) {
            const tok = toks[i];
            if (!tok || tok === '\n') continue;
            if (nb >= target) return i;
            nb++;
          }
          return Math.max(0, toks.length - 1);
        };

        let preferredNoBreak: number | undefined =
          (typeof selInfo.wordHintInPage === 'number' && Number.isFinite(selInfo.wordHintInPage))
            ? Math.max(0, selInfo.wordHintInPage)
            : undefined;

        if (preferredNoBreak === undefined && typeof selInfo.yInPage === 'number' && Number.isFinite(selInfo.yInPage)) {
          preferredNoBreak = Math.max(0, Math.min(wordsInPageNoBreaks - 1, Math.round(wordsInPageNoBreaks * selInfo.yInPage)));
        }

        const preferredEngineInPage =
          preferredNoBreak === undefined ? undefined : noBreakToEngineIndex(pageText, preferredNoBreak);

        const windowTokens = (toks: string[], idx: number, r: number) => {
          const lo = Math.max(0, idx - r);
          const hi = Math.min(toks.length, idx + r + 1);
          return toks.slice(lo, hi);
        };

        anchorTrace.preferred = {
          preferredNoBreak,
          preferredEngineInPage,
          preferredTokenWindow: typeof preferredEngineInPage === 'number'
            ? windowTokens(pageToks, preferredEngineInPage, 12)
            : [],
          wordsInPageNoBreaks,
          pageTextLen: pageText.length,
        };

        // pull candidates (top 25) using the same matcher helper you already have
        const inPageCandidates = this.pdf.findCandidateMatchIndicesInText(
          pageText,
          normalized,
          preferredEngineInPage,
          25
        );

        anchorTrace.candidatesOnPage = inPageCandidates.map((inPageIdx2: number) => ({
          inPageIndex: inPageIdx2,
          globalIndex: pageBase + inPageIdx2,
          distToPreferred: typeof preferredEngineInPage === 'number' ? Math.abs(inPageIdx2 - preferredEngineInPage) : undefined,
          tokenAt: pageToks[inPageIdx2] ?? '',
          tokenWindow: windowTokens(pageToks, inPageIdx2, 6),
        }));

        // optional: show the actual extracted token at the preferred slot
        if (typeof preferredEngineInPage === 'number') {
          anchorTrace.preferred.preferredTokenAt = pageToks[preferredEngineInPage] ?? '';
        }

        anchorTrace.note = 'If candidates are empty, selection cannot be located in the extracted token stream (this is the “unlaunchable” root cause).';
      }

      const bundle = { slim, anchorTrace };
      
      const mdBlock =
        `\n### ${file.name} – extraction + anchor trace\n\n` +
        `\`\`\`json\n${JSON.stringify(bundle, null, 2)}\n\`\`\`\n`;

      // Append to vault root DEVLOG_PDF.md (create if missing)
      const devlogPath = 'DEVLOG_PDF.md';
      const existing = this.app.vault.getAbstractFileByPath(devlogPath);

      if (existing instanceof TFile) {
        await this.app.vault.append(existing, mdBlock);
      } else if (existing) {
        // Name exists but isn't a file (e.g., folder) -> don't overwrite
        throw new Error(`${devlogPath} exists but is not a file`);
      } else {
        await this.app.vault.create(devlogPath, `# DashReader PDF Debug Log\n${mdBlock}`);
      }

      // Optional: tiny console line so you can confirm it ran without huge logs
      console.debug('[DashReader][pdf-extraction-report-slim] appended', {
        file: slim.file,
        totalPages: slim.totalPages,
        headerSigs: slim.headerSigs.length,
        footerSigs: slim.footerSigs.length,
      });

      new Notice('Extraction report appended to DEVLOG_PDF.md');
    } catch (e) {
      console.error('[DashReader] dumpPdfExtractionReport failed', e);
      new Notice('Failed (see console)');
    }
  }

  private async copyTextToClipboard(text: string): Promise<boolean> {
    // 1) Modern API (works in most Obsidian/Electron builds)
    try {
      if (navigator?.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // fall through
    }

    // 2) Fallback that also works in Electron: execCommand('copy')
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', 'true');
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.left = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}
