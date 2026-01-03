import { Plugin, Notice, MarkdownView, Menu, Editor } from 'obsidian';
import { DashReaderModal } from './src/rsvp-view';
import { DashReaderSettingTab } from './src/settings';
import { DashReaderSettings } from './src/types';
import { validateSettings } from './src/services/settings-validator';
import { PdfViewIntegration } from './src/pdf-view-integration';
import { hitTestBlock, resolveSelectionToTokenIndex } from './src/pdf';
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
        page: (selInfo as any).page,
        xMidN: (selInfo as any).xMidN,
        yMidN: (selInfo as any).yMidN,
      });
    }

    const isSingle = this.pdf.countTokensLikeEngineNoBreaks(normalized) === 1;
    const selection = isSingle ? normalized : '';

    if (!selection) {
      new Notice('Double-click a single word (no drag selection). Use “Read selected text” for ranges.');
      return;
    }

    const selPage = selInfo.page ?? this.pdf.getCurrentPdfPageNumber(pdfView);
    const selYMidN = (selInfo as any).yMidN;

    if (!selPage) {
      new Notice('Could not determine which PDF page the selection is on');
      return;
    }

    const inHeaderFooterBand =
      typeof selYMidN === 'number' &&
      Number.isFinite(selYMidN) &&
      (selYMidN <= 0.10 || selYMidN >= 0.90);

    try {
      // Spec-compliant PDF pipeline: narrative-only + column/block aware.
      const index = await this.pdf.getOrParseNarrativeIndex(file, { maxPages: 200 });
      if (!index.fullText) {
        new Notice('No narrative text could be extracted from this PDF');
        return;
      }

      const pageIndex = Math.max(0, (selPage | 0) - 1);

      const ctx =
        typeof (selInfo as any).xMidN === 'number' &&
        typeof (selInfo as any).yMidN === 'number'
          ? hitTestBlock(index, pageIndex, (selInfo as any).xMidN, (selInfo as any).yMidN)
          : null;

      const tokenIndex = resolveSelectionToTokenIndex(index, selection, ctx);
      if (tokenIndex === null) {
        if (inHeaderFooterBand) {
          new Notice('Selected word appears near a header/footer; it may be excluded. Reading the selected text only.');
        }
        fallbackToSelectionOnly('selection-not-found-in-narrative');
        return;
      }

      const modal = this.openModal({ skipInitialAutoLoad: true });
      modal.loadPlainText(index.fullText, {
        fileName: file.name,
        lineNumber: 1,
        cursorPosition: tokenIndex,
      });
    } catch (err) {
      console.error('[DashReader] Launch from cursor (PDF) failed', err);
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(msg ? `Could not parse this PDF: ${msg}` : 'Could not parse this PDF');
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
        page: (selInfo as any).page,
        xMidN: (selInfo as any).xMidN,
        yMidN: (selInfo as any).yMidN,
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
      const index = await this.pdf.getOrParseNarrativeIndex(file, { maxPages: 200 });
      if (!index.fullText) {
        new Notice('No narrative text could be extracted from this PDF');
        return;
      }
      modal.loadPlainText(index.fullText, { fileName: file.name, lineNumber: 1 });
    } catch (err) {
      console.error('[DashReader] PDF parse failed', err);
      const msg = err instanceof Error ? err.message : String(err);
      new Notice(msg ? `Could not parse this PDF: ${msg}` : 'Could not parse this PDF');
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
      const index = await this.pdf.getOrParseNarrativeIndex(file, { maxPages: 60 });

      const exclusionCountsByReason: Record<string, number> = {};
      for (const e of index.exclusions ?? []) {
        const k = String((e as any).reason ?? 'UNKNOWN');
        exclusionCountsByReason[k] = (exclusionCountsByReason[k] ?? 0) + 1;
      }

      const selection = this.pdf.getCachedPdfSelection();

      const slim = {
        file: String((file as any)?.path ?? (file as any)?.name ?? ''),
        parsedPages: index.pageCount,
        isLikelyScholarly: index.isLikelyScholarly,
        referencesHardStopTokenIndex: (index as any).referencesHardStopTokenIndex,
        tokenCount: index.tokens?.length ?? 0,
        exclusionCountsByReason,
        sampleExclusions: (index.exclusions ?? []).slice(0, 40),
      };

      const bundle = {
        slim,
        selection: {
          text: selection.text,
          page: selection.page,
          xMidN: (selection as any).xMidN,
          yMidN: (selection as any).yMidN,
          ageMs: selection.ageMs,
          filePath: selection.filePath,
          eventType: (selection as any).eventType,
        },
      };
      
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

      console.debug('[DashReader][pdf-extraction-report] appended', { file: slim.file, parsedPages: slim.parsedPages });

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
