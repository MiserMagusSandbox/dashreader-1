/**
 * WordDisplay - Manages word display with highlighting and formatting
 *
 * Responsibilities:
 * - Display words with center character highlighting
 * - Handle heading display with dynamic font sizes
 * - Handle callout display with icons
 * - Show visual separators before headings
 * - Escape HTML to prevent XSS
 */

import { DashReaderSettings } from './types';
import { HEADING_MULTIPLIERS, ICONS } from './constants';
import { setIcon } from "obsidian";

export class WordDisplay {
  private wordEl: HTMLElement;
  private settings: DashReaderSettings;
  private overlayEl: HTMLElement;
  private contentEl: HTMLElement;
  private focusDashesEl: HTMLElement;
  private baseFontSizePx: number;
  private baseChunkSize: number;

  /**
   * Callout icon mapping
   */
  private readonly calloutIcons: Record<string, string> = {
    note: '📝',
    abstract: '📄',
    info: 'ℹ️',
    tip: '💡',
    success: '✅',
    question: '❓',
    warning: '⚠️',
    failure: '❌',
    danger: '⚡',
    bug: '🐛',
    example: '📋',
    quote: '💬'
  };

  constructor(wordEl: HTMLElement, settings: DashReaderSettings, baseFontSizePx: number, baseChunkSize: number) {
    this.wordEl = wordEl;
    this.settings = settings;

    // Build a permanent overlay + a content host so focus bars never get removed
    this.wordEl.empty();
    this.wordEl.style.position = 'relative';
    this.wordEl.setAttribute('data-running', 'false'); // prevents focus-bar flash on first paint
    this.baseFontSizePx = baseFontSizePx;
    this.baseChunkSize = Math.max(1, baseChunkSize);
    this.overlayEl = this.wordEl.createDiv({ cls: 'dashreader-focus-overlay' });
    this.overlayEl.createDiv({ cls: 'dashreader-focus-lines' });
    this.focusDashesEl = this.overlayEl.createDiv({ cls: 'dashreader-focus-dashes' });

    this.contentEl = this.wordEl.createDiv({ cls: 'dashreader-word-content' });

    // default (single-word) focus position: near center
    this.wordEl.style.setProperty('--dashreader-focus-left', '48%');
  }

  public setBaseFontSize(px: number): void {
    this.baseFontSizePx = px;
  }

  public setChunkSize(n: number): void {
    this.baseChunkSize = Math.max(1, n);
  }

  /**
   * Updates settings (when user changes font size, etc.)
   *
   * @param settings - New settings to apply
   */
  updateSettings(settings: DashReaderSettings): void {
    this.settings = settings;
  }

  /**
   * Displays a word with optional heading level or callout type
   * Handles font size adjustment, icons, and separators
   *
   * @param word - The word to display
   * @param headingLevel - Heading level (1-6) or 0 for normal text/callouts
   * @param showSeparator - Whether to show separator line before heading/callout
   * @param calloutType - Callout type (note, abstract, info, etc.) if this is a callout
   */
  displayWord(word: string, headingLevel: number, showSeparator: boolean = false, calloutType?: string): void {
    // Calculate font size based on heading level or callout
    let fontSizeMultiplier = 1.0;
    let fontWeight = 'normal';
    let iconPrefix = '';

    if (calloutType) {
      // Callouts: slightly larger font, with icon prefix
      fontSizeMultiplier = 1.2;
      fontWeight = 'bold';
      iconPrefix = this.calloutIcons[calloutType.toLowerCase()] || '📌';
    } else if (headingLevel > 0) {
      // Headings: size based on level
      const multipliers = [
        0,
        HEADING_MULTIPLIERS.h1,
        HEADING_MULTIPLIERS.h2,
        HEADING_MULTIPLIERS.h3,
        HEADING_MULTIPLIERS.h4,
        HEADING_MULTIPLIERS.h5,
        HEADING_MULTIPLIERS.h6
      ];
      fontSizeMultiplier = multipliers[headingLevel] || 1.0;
      fontWeight = 'bold';
    }

    const adjustedFontSize = this.baseFontSizePx * fontSizeMultiplier;
    const cleanedTrimmed = this.stripMarkers(word).trim();
    const isPhrase = /\s/.test(cleanedTrimmed);
    const cleaned = this.stripMarkers(word).trim();
    const displayText = cleaned.length ? cleaned : word.trim();

    // Focus position depends ONLY on configured chunk size (stationary for a fixed setting)
    const chunkSize = Math.max(1, this.baseChunkSize || 1);

    // 1 word => near centre, 2/3/4... progressively more left, capped at 6+
    const center = 48;
    const left = 15;
    const maxChunkForFullShift = 5;

    const t = Math.min(1, Math.max(0, (chunkSize - 1) / (maxChunkForFullShift - 1)));
    const focus = center - t * (center - left);

    this.wordEl.style.setProperty('--dashreader-focus-left', `${focus}%`);
    this.wordEl.setAttribute('data-running', 'true');

    // Remove any old welcome/ready nodes that were appended to wordEl in older versions
    this.wordEl
      .querySelectorAll('.dashreader-welcome-message, .dashreader-ready-message')
      .forEach(el => el.remove());

    // Clear and rebuild using DOM API (not innerHTML)
    this.contentEl.empty();

    // Add separator if needed
    if (showSeparator) {
      this.contentEl.createDiv({ cls: 'dashreader-heading-separator' });
    }

    // Create word container
    const wordContainer = this.contentEl.createDiv({ cls: 'dashreader-word-with-heading' });
    wordContainer.style.fontSize = `${adjustedFontSize}px`;
    wordContainer.style.fontWeight = fontWeight;

    // Add icon prefix if callout
    if (iconPrefix) {
      wordContainer.createSpan({
        text: iconPrefix,
        cls: 'dashreader-callout-icon'
      });
    }

    // ORP viewport + line (measured + shifted)
    // Use a dedicated viewport so ORP anchoring is stable frame-to-frame.
    const viewport = wordContainer.createDiv({ cls: 'dashreader-orp-viewport' });
    const line = viewport.createDiv({ cls: 'dashreader-orp-line' });

    const chunkMode = (this.baseChunkSize || 1) > 1;
    const orpEl = (chunkMode && /\s/.test(cleaned))
      ? this.buildChunkSpans(line, cleaned)
      : this.buildWordSpans(line, cleaned);

    const focusWordEl = line.querySelector('.dashreader-focus-word') as HTMLElement | null;

    // Only shrink for a single token (no whitespace) and not for line breaks
    const shouldShrink = cleanedTrimmed !== '\n';

    // Defer measurement until layout is available
    requestAnimationFrame(() => {
      // Reset to intended size first
      wordContainer.style.fontSize = `${adjustedFontSize}px`;

      if (viewport.clientWidth === 0) {
        requestAnimationFrame(() => {
          wordContainer.style.fontSize = `${adjustedFontSize}px`;

          if (shouldShrink) {
            const minSize = Math.max(8, this.settings.minTokenFontSize || 12);
            this.shrinkFocusWordToFit(viewport, line, focusWordEl, orpEl, adjustedFontSize, minSize);
          }

          this.applyOrpAnchoring(viewport, line, orpEl);
        });
        return;
      }

      if (shouldShrink) {
        const minSize = Math.max(8, this.settings.minTokenFontSize || 12);
        this.shrinkFocusWordToFit(viewport, line, focusWordEl, orpEl, adjustedFontSize, minSize);
      }

      // After any shrink, anchor ORP
      this.applyOrpAnchoring(viewport, line, orpEl);
    });
  }

  private stripMarkers(rawWord: string): string {
    return rawWord.replace(/^\[H\d\]/, '').replace(/^\[CALLOUT:[\w-]+\]/, '');
  }

  private renderIcon(into: HTMLElement, icon: string): void {
    if (icon.startsWith("lucide:")) setIcon(into, icon.slice("lucide:".length));
    else into.setText(icon);
  }

  /**
   * Squirt-style ORP index (punctuation-aware).
   * Matches squirtSquirt.js getORPIndex logic.
   */
  private getORPIndex(word: string): number {
    const str = word.endsWith('\n') ? word.slice(0, -1) : word;
    const len = str.length;
    if (len <= 0) return 0;

    let point = 4;
    if (len < 2) point = 0;
    else if (len < 6) point = 1;
    else if (len < 10) point = 2;
    else if (len < 14) point = 3;

    const isLetterOrDigit = (ch: string | undefined) =>
      !!ch && (/\d/.test(ch) || ch.toLowerCase() !== ch.toUpperCase());

    if (!isLetterOrDigit(str[point])) {
      if (isLetterOrDigit(str[point - 1])) point--;
      else if (isLetterOrDigit(str[point + 1])) point++;
    }

    if (point < 0) point = 0;
    if (point >= str.length) point = str.length - 1;
    return point;
  }

  /**
   * Builds spans for the word into `lineEl` and returns the ORP span.
   */
  private buildWordSpans(lineEl: HTMLElement, displayWord: string): HTMLElement | null {
    lineEl.empty();
    if (!displayWord || displayWord === '\n') return null;

    const focusWordEl = lineEl.createSpan({ cls: 'dashreader-focus-word' });

    const orpIndex = this.getORPIndex(displayWord);
    for (let i = 0; i < displayWord.length; i++) {
      const ch = displayWord.charAt(i);
      const span = focusWordEl.createSpan({ text: ch });
      if (i === orpIndex) {
        span.addClass('dashreader-highlight');
        span.addClass('dashreader-orp');
      }
    }

    return focusWordEl.querySelector('.dashreader-orp') as HTMLElement | null;
  }

  private buildChunkSpans(lineEl: HTMLElement, chunkText: string): HTMLElement | null {
    lineEl.empty();
    if (!chunkText || chunkText === '\n') return null;

    const parts = chunkText.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return null;

    const main = parts[0];
    const sequel = parts.slice(1).join(' ');

    const focusWordEl = lineEl.createSpan({ cls: 'dashreader-focus-word' });

    const orpIndex = this.getORPIndex(main);
    for (let i = 0; i < main.length; i++) {
      const ch = main.charAt(i);
      const span = focusWordEl.createSpan({ text: ch });
      if (i === orpIndex) {
        span.addClass('dashreader-highlight');
        span.addClass('dashreader-orp');
      }
    }

    if (sequel.length) {
      // Hard space that won’t collapse / disappear inside an inline-flex row
      lineEl.appendChild(document.createTextNode('\u00A0'));
      lineEl.createSpan({ text: sequel, cls: 'dashreader-inline-context' });
    }

    return lineEl.querySelector('.dashreader-orp') as HTMLElement | null;
  }

  /**
   * Applies ORP anchoring by measuring the ORP span and shifting the whole line.
   * Anchor is the horizontal centre of the viewport.
   */
  private applyOrpAnchoring(viewportEl: HTMLElement, lineEl: HTMLElement, orpEl: HTMLElement | null): void {
    if (!orpEl) {
      lineEl.style.transform = 'translateX(0px)';
      return;
    }

    lineEl.style.transform = 'translateX(0px)';

    const viewportRect = viewportEl.getBoundingClientRect();
    const focusRect = this.focusDashesEl.getBoundingClientRect();
    const focusX = (focusRect.left + focusRect.width / 2) - viewportRect.left; // viewport-local

    const lineLeft = lineEl.offsetLeft; // because viewport centers line
    const orpCenterInLine = orpEl.offsetLeft + orpEl.offsetWidth / 2;

    const delta = focusX - (lineLeft + orpCenterInLine);
    lineEl.style.transform = `translateX(${Math.round(delta)}px)`;
  }

  /**
   * Binary-search shrink for a single token if it overflows the viewport.
   * Returns the font size actually applied.
   */
  private shrinkFocusWordToFit(
    viewportEl: HTMLElement,
    lineEl: HTMLElement,
    focusWordEl: HTMLElement | null,
    orpEl: HTMLElement | null,
    startSize: number,
    minSize: number
  ): number {
    if (!focusWordEl || !orpEl) return startSize;

    const prevTransition = focusWordEl.style.transition;
    focusWordEl.style.transition = 'none';

    const fitsFocusWord = (): boolean => {
      const viewportW = viewportEl.clientWidth;
      if (viewportW <= 0) return true;

      const viewportRect = viewportEl.getBoundingClientRect();
      const focusRect = this.focusDashesEl.getBoundingClientRect();
      const focusX = (focusRect.left + focusRect.width / 2) - viewportRect.left; // viewport-local

      const orpCenter = orpEl.offsetLeft + orpEl.offsetWidth / 2;

      const wordLeft = focusWordEl.offsetLeft;
      const wordRight = wordLeft + focusWordEl.offsetWidth;

      const leftDist = orpCenter - wordLeft;
      const rightDist = wordRight - orpCenter;

      const leftEdge = focusX - leftDist;
      const rightEdge = focusX + rightDist;

      return leftEdge >= 0 && rightEdge <= viewportW;
    };

    // Reset focus word to requested size
    focusWordEl.style.fontSize = `${startSize}px`;
    lineEl.getBoundingClientRect();

    if (fitsFocusWord()) {
      focusWordEl.style.transition = prevTransition;
      return startSize;
    }

    let lo = Math.max(8, minSize);
    let hi = startSize;
    let best = lo;

    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      focusWordEl.style.fontSize = `${mid}px`;
      lineEl.getBoundingClientRect();

      if (fitsFocusWord()) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    focusWordEl.style.fontSize = `${best}px`;
    lineEl.getBoundingClientRect();
    focusWordEl.style.transition = prevTransition;

    return best;
  }

  /**
   * Adds a processed word to the container using DOM API
   * This prevents XSS attacks by never using innerHTML with user content
   *
   * @param container - Container element to add word to
   * @param rawWord - Raw word (may contain special characters)
   */
  private addProcessedWord(container: HTMLElement, rawWord: string): void {
    // Special case: line breaks (don't highlight, just display)
    if (rawWord === '\n') {
      container.createEl('br');
      return;
    }

    // Remove heading and callout markers (already processed by engine)
    const word = rawWord.replace(/^\[H\d\]/, '').replace(/^\[CALLOUT:[\w-]+\]/, '');

    // Apply center character highlighting (always enabled)
    if (word.length > 0) {
      const centerIndex = Math.floor(word.length / 3);
      const before = word.substring(0, centerIndex);
      const center = word.charAt(centerIndex);
      const after = word.substring(centerIndex + 1);

      // Build using DOM API to prevent XSS
      if (before) {
        container.createSpan({ text: before });
      }
      container.createSpan({
        text: center,
        cls: 'dashreader-highlight'
      });
      if (after) {
        container.createSpan({ text: after });
      }
    } else {
      // Empty word, just add as text
      container.setText(word);
    }
  }

  /**
   * Displays a welcome message (no text loaded)
   * Uses DOM API to build the message instead of innerHTML
   *
   * @param icon - Icon to display
   * @param mainText - Main message text
   * @param subText - Instruction text
   */
  displayWelcomeMessage(icon: string, mainText: string, subText: string): void {
    this.contentEl.empty();
    this.wordEl.setAttribute('data-running', 'false');
    const welcomeDiv = this.contentEl.createDiv({ cls: 'dashreader-welcome-message' });
    welcomeDiv.createDiv({
      text: `${icon} ${mainText}`,
      cls: 'dashreader-welcome-icon'
    });
    welcomeDiv.createDiv({
      text: subText,
      cls: 'dashreader-welcome-instruction'
    });
  }

  /**
   * Displays a ready message (text loaded, ready to start)
   * Uses DOM API to build the message instead of innerHTML
   *
   * @param wordsToRead - Number of words to read
   * @param totalWords - Total words in document
   * @param startIndex - Starting word index (if resuming)
   * @param durationText - Formatted estimated duration
   * @param fileName - Optional source file name
   * @param lineNumber - Optional source line number
   */
  displayReadyMessage(
    wordsToRead: number,
    totalWords: number,
    startIndex: number | undefined,
    durationText: string,
    fileName?: string,
    lineNumber?: number
  ): void {
    this.contentEl.empty();
    this.wordEl.setAttribute('data-running', 'false');
    const readyDiv = this.contentEl.createDiv({ cls: 'dashreader-ready-message' });

    // Add source info if provided
    if (fileName) {
      const sourceDiv = readyDiv.createDiv({ cls: 'dashreader-ready-source' });
      const iconSpan = sourceDiv.createSpan({ cls: 'dashreader-inline-icon' });
          setIcon(
            iconSpan,
            ICONS.file.startsWith('lucide:')
              ? ICONS.file.slice('lucide:'.length)
              : ICONS.file
          );
          sourceDiv.createSpan({ text: ' ' });
          sourceDiv.createSpan({ text: fileName });
      if (lineNumber) {
        sourceDiv.createSpan({ text: ` (line ${lineNumber})` });
      }
    }

    // Build main message
    const mainText = readyDiv.createSpan();
    mainText.createSpan({ text: `Ready to read ${wordsToRead} words` });

    if (startIndex !== undefined && startIndex > 0) {
      const startInfo = mainText.createSpan({ cls: 'dashreader-ready-start-info' });
      startInfo.setText(` (starting at word ${startIndex + 1}/${totalWords})`);
    }

    readyDiv.createEl('br');
    readyDiv.createSpan({
      text: `Estimated time: ~${durationText}`,
      cls: 'dashreader-ready-duration'
    });
    readyDiv.createEl('br');
    readyDiv.createSpan({
      text: 'Press Space to start',
      cls: 'dashreader-ready-duration'
    });
  }

  /**
   * Clears the word display
   */
  clear(): void {
    this.contentEl.empty();
    this.wordEl.setAttribute('data-running', 'false');
  }
}
