/**
 * @file rsvp-view.ts
 * @description Main view component for DashReader RSVP speed reading
 *
 * ARCHITECTURE:
 * This view implements a clean separation of concerns using utility classes:
 * - ViewState: Centralized reactive state management with event emission
 * - DOMRegistry: Efficient DOM element caching and batch updates
 * - AutoLoadManager: Automatic text loading from editor with cursor tracking
 * - UI Builders: Reusable component factories for consistent UI
 *
 * OUTLINE:
 * ├─ 1. IMPORTS & CONSTANTS
 * ├─ 2. CLASS DEFINITION
 * │  ├─ Properties & Constructor
 * │  └─ Obsidian View Lifecycle
 * ├─ 3. UI CONSTRUCTION
 * │  ├─ buildUI() orchestrator
 * │  ├─ buildToggleBar()
 * │  ├─ buildDisplayArea()
 * │  ├─ buildProgressBar()
 * │  ├─ buildControls()
 * │  └─ buildInlineSettings()
 * ├─ 4. USER INTERACTIONS
 * │  ├─ changeValue() - Unified value changes
 * │  ├─ togglePanel() - Panel visibility
 * │  ├─ toggleContextDisplay()
 * │  └─ openInNewTab() - Open in fullscreen tab
 * ├─ 5. AUTO-LOAD SYSTEM
 * │  └─ setupAutoLoad() - Event registration
 * ├─ 6. HOTKEYS & KEYBOARD
 * │  ├─ setupHotkeys()
 * │  ├─ handleKeyPress()
 * │  └─ togglePlay()
 * ├─ 7. READING ENGINE CALLBACKS
 * │  ├─ onWordChange()
 * ├─ 8. TEXT LOADING
 * │  └─ loadText() - Main text loading method
 * └─ 9. SETTINGS & LIFECYCLE
 *    ├─ updateSettings()
 *    └─ onClose()
 *
 * @author DashReader Team
 * @version 2.0.0 - Refactored for maintainability
 */

// ============================================================================
// SECTION 1: IMPORTS & CONSTANTS
// ============================================================================

import { Modal, App, EventRef, Platform } from "obsidian";
import { RSVPEngine } from './rsvp-engine';
import { DashReaderSettings, WordChunk, HeadingInfo } from './types';
import { MarkdownParser } from './markdown-parser';
import { ViewState } from './view-state';
import { DOMRegistry } from './dom-registry';
import { BreadcrumbManager } from './breadcrumb-manager';
import { WordDisplay } from './word-display';
import { HotkeyHandler } from './hotkey-handler';
import { TimeoutManager } from './services/timeout-manager';
import {
  createButton,
  createNumberControl,
  createToggleControl,
  createPlayPauseButtons,
  updatePlayPauseButtons,
} from './ui-builders';
import {
  CSS_CLASSES,
  ICONS,
  TIMING,
  TEXT_LIMITS,
  INCREMENTS,
  LIMITS,
} from './constants';
import { AutoLoadManager, isNavigationKey, isSelectionKey } from './auto-load-manager';

// ============================================================================
// SECTION 2: CLASS DEFINITION
// ============================================================================

/**
 * Main view component for DashReader RSVP speed reading
 *
 * Implements Obsidian's ItemView interface to provide a custom view for
 * displaying text word-by-word at configurable speeds (WPM).
 *
 * @extends ItemView
 */
export class DashReaderView extends Modal {

public isOpen = false;
private onModalClose?: () => void;
private onSettingsSave?: () => void;

// debounce handle (so we don't write data.json 30 times in a second)
private _saveSettingsTimer: number | null = null;
  // ──────────────────────────────────────────────────────────────────────
  // Core Dependencies
  // ──────────────────────────────────────────────────────────────────────

  /** RSVP reading engine - handles word iteration and timing */
  private engine: RSVPEngine;

  /** Plugin settings (WPM, font size, colors, etc.) */
  private settings: DashReaderSettings;

  /** Centralized reactive state manager */
  private state: ViewState;

  /** DOM element registry for efficient updates */
  private dom: DOMRegistry;

  /** Automatic text loading from editor */
  private autoLoadManager: AutoLoadManager;

  /** Breadcrumb navigation manager */
  private breadcrumbManager: BreadcrumbManager;

  /** Word display manager */
  private wordDisplay: WordDisplay;

  /** Hotkey handler */
  private hotkeyHandler: HotkeyHandler;

  /** Timeout manager for preventing memory leaks */
  private timeoutManager: TimeoutManager;

  // ──────────────────────────────────────────────────────────────────────
  // DOM Element References
  // ──────────────────────────────────────────────────────────────────────

  /** Main container element */
  private mainContainerEl: HTMLElement;

  /** Toggle buttons bar (settings) */
  private toggleBar: HTMLElement;

  /** Main word display area */
  private wordEl: HTMLElement;

  /** Context before current word */
  private contextBeforeEl: HTMLElement;

  /** Context after current word */
  private contextAfterEl: HTMLElement;

  /** Settings panel (inline configuration) */
  private settingsEl: HTMLElement;

  /** Progress bar container */
  private progressEl: HTMLElement;

  /** Breadcrumb navigation showing current heading context */
  private breadcrumbEl: HTMLElement;

  private isInitialized = false;
  private pendingLoad: { text: string; source?: { fileName?: string; lineNumber?: number; cursorPosition?: number } } | null = null;

  private skipInitialAutoLoad = false;

  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  private _eventRefs: EventRef[] = [];

  private _domUnsubs: Array<() => void> = [];

  // Keep existing call sites working:
  private _eventUnsubs: Array<() => void> = [];

  private registerEvent(emitter: { offref: (ref: EventRef) => void }, ref: EventRef): void {
    this._eventUnsubs.push(() => {
      try {
        emitter.offref(ref);
      } catch {
        // ignore
      }
    });
  }

  private registerDomEvent(
    target: EventTarget,
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions
  ): void {
    target.addEventListener(type, listener, options);
    this._domUnsubs.push(() => target.removeEventListener(type, listener, options));
  }

  private _cleanupRegistered(): void {
    for (const unsub of this._eventUnsubs) unsub();
    this._eventUnsubs = [];

    for (const unsub of this._domUnsubs) unsub();
    this._domUnsubs = [];
  }

  private headingNav = { lastTime: 0, dir: null as ('up' | 'down' | null), cursor: null as (number | null) };
  private static readonly HEADING_NAV_WINDOW_MS = 700;

  /** Toggle buttons (so we can defocus them / detect clicks) */
  private controlsToggleBtn?: HTMLButtonElement;

  /** Track whether we paused due to opening a panel */
  private pausedByPanelOpen = false;
  private wasPlayingBeforePanelOpen = false;

  private bottomBarEl: HTMLElement;
  private mobileControlsEl: HTMLElement;

  private isMobileUI(): boolean {
    const p = Platform as any;
    if (typeof p?.isMobileApp === "boolean") return p.isMobileApp;
    if (typeof p?.isMobile === "boolean") return p.isMobile;

    const a = this.app as any;
    if (typeof a?.isMobile === "boolean") return a.isMobile;

    // fallback only
    return window.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches ?? false;
  }

  private getActiveFontSize(): number {
    return this.isMobileUI() ? this.settings.mobileFontSize : this.settings.fontSize;
  }

  // Add near other fields in the class:
  private progressBarEl: HTMLProgressElement | null = null
  private isProgressBarHovering = false;
  private progressBarHoverIndex: number | null = null;
  private progressBarHoverRaf: number | null = null;
  private progressBarLastTooltipIndex: number | null = null;
  private progressInfoLeftEl: HTMLElement | null = null;
  private progressInfoRightEl: HTMLElement | null = null;

  private suppressAutoLoadUntil = 0;

  private sessionStartIndex = 0;
  private sessionTotalTokens = 0;
  private sessionTotalDurationSec = 0;

  private ignoreNextDisplayToggleClick = false;

  private _contextMeasureHostEl?: HTMLElement;
  private _contextMeasureBeforeEl?: HTMLElement;
  private _contextMeasureAfterEl?: HTMLElement;
  private _contextUpdateRaf: number | null = null;
  private _pendingContextIndex: number | null = null;
  private _contextResizeObserver?: ResizeObserver;
  private suppressContextUntilPlay = true;

  private lastDisplayedIndex: number | null = null;

  // ──────────────────────────────────────────────────────────────────────
  // Constructor
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Creates a new DashReaderView instance
   *
   * @param leaf - Obsidian workspace leaf to attach to
   * @param settings - Plugin settings
   */
  constructor(
    app: App,
    settings: DashReaderSettings,
    onModalClose?: () => void,
    onSettingsSave?: () => void
  ) {
    super(app);
    this.settings = settings;
    this.onModalClose = onModalClose;
    this.onSettingsSave = onSettingsSave;

    // Initialize state manager with curyrent settings
    this.state = new ViewState({
      currentWpm: this.isMobileUI() ? settings.mobileWpm : settings.wpm,
      currentChunkSize: this.isMobileUI() ? settings.mobileChunkSize : settings.chunkSize,
      currentFontSize: this.getActiveFontSize(),
    });

    // Initialize DOM registry for efficient element updates
    this.dom = new DOMRegistry();

    // Initialize timeout manager for memory leak prevention
    this.timeoutManager = new TimeoutManager();

    // Initialize RSVP engine with callbacks
    this.engine = new RSVPEngine(
      settings,
      this.onWordChange.bind(this) as (chunk: WordChunk) => void,
      this.timeoutManager
    );

    this.engine.setUseMobileProfile(this.isMobileUI());

    // Initialize auto-load manager for editor integration
    this.autoLoadManager = new AutoLoadManager(
      this.app,
      this.loadText.bind(this) as (text: string, source?: { fileName?: string; lineNumber?: number; cursorPosition?: number }) => void,
      () => this.mainContainerEl?.isShown() ?? false,
      this.timeoutManager
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // Obsidian View Lifecycle
  // ──────────────────────────────────────────────────────────────────────

  /**
   * Called when the view is opened
   * Builds UI, sets up hotkeys, and registers auto-load
   */
  async onOpen(): Promise<void> {
    this.isOpen = true;
    this.contentEl.empty();              // important if reopened
    this.modalEl.addClass('dashreader-modal');
    this.containerEl.addClass('dashreader-modal-container');
    this.modalEl.querySelector('.modal-close-button')?.remove();
    this.modalEl.querySelector(".modal-header")?.remove();
    this.modalEl.setAttr('tabindex', '-1');
    this.applyAppearanceCssVars();
    this.mainContainerEl = this.contentEl.createDiv({ cls: CSS_CLASSES.container });
    // Apply font family broadly (not just the focus word).
    this.applyDashReaderFont(this.settings.fontFamily);
    this.buildUI();
    this.engine.setUseMobileProfile(this.isMobileUI());
    this.syncBoldColorToTheme();
    this.suppressContextUntilPlay = true;
    this.toggleContextDisplay();

    // Initialize modules after UI is built
    this.breadcrumbManager = new BreadcrumbManager(this.breadcrumbEl, this.engine, this.timeoutManager, {
      onPlayStateChange: (isPlaying) => updatePlayPauseButtons(this.dom, isPlaying),
      canAutoResume: () => !this.isAnyInlinePanelOpen()
    });
    this.wordDisplay = new WordDisplay(
      this.wordEl,
      this.settings,
      this.getActiveFontSize(),
      this.engine.getChunkSize()
    );
    this.hotkeyHandler = new HotkeyHandler(this.settings, {
      onTogglePlay: () => this.togglePlay(),
      onRewind: () => this.engine.rewindSeconds(10),
      onForward: () => this.engine.forwardSeconds(10),
      onIncrementWpm: () => this.changeValue('wpm', INCREMENTS.wpm),
      onDecrementWpm: () => this.changeValue('wpm', -INCREMENTS.wpm),
      onQuit: () => this.engine.stop()
    });
    this.engine.setUseMobileProfile(this.isMobileUI());

    // Note: don't render the welcome message immediately. Auto-load usually
    // loads content right after open, and the immediate welcome render causes
    // a visible flicker (welcome → cleared → ready).

    // Apply initial visibility settings
    this.toggleContextDisplay();
    this.toggleBreadcrumbDisplay();
    this.setupOutsideClickToClosePanels();
    this.defocusInteractiveElements();
    requestAnimationFrame(() => this.defocusInteractiveElements());
    this.setupHotkeys();

    // Setup auto-load when layout is ready
    this.app.workspace.onLayoutReady(() => {
      this.setupAutoLoad();

      const hasExplicitLoadQueued = !!this.pendingLoad || this.engine.getTotalWords() > 0;

      if (!this.skipInitialAutoLoad && !hasExplicitLoadQueued) {
        this.autoLoadManager.loadFromEditor(50); // load current note shortly after open
      }
      this.skipInitialAutoLoad = false;

      // If nothing gets auto-loaded (no active markdown view, empty doc, etc.),
      // show the welcome message after a short grace period.
      this.timeoutManager.setTimeout(() => {
        if (this.engine.getTotalWords() === 0) {
          this.wordDisplay.displayWelcomeMessage(
            ICONS.book,
            'Select text to start reading',
            'or use Cmd+P → "Read selected text"'
          );
        }
      }, 500);
    });
    this.isInitialized = true;
    if (this.pendingLoad) {
      const { text, source } = this.pendingLoad;
      this.pendingLoad = null;
      this.loadText(text, source);
    }
  }

  /**
   * Called when the view is closed
   * Stops reading and cleans up resources
   */
  async onClose(): Promise<void> {
    this.isOpen = false;
    this._cleanupRegistered();

    this.engine.stop();
    this.timeoutManager.clearAll();
    this.dom.clear();

    if (this.keydownHandler) {
      document.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }

    this.contentEl.empty();
    this.onModalClose?.();
    this.requestSettingsSave();
  }

  // ============================================================================
  // SECTION 3: UI CONSTRUCTION
  // ============================================================================

  /**
   * Orchestrates the construction of all UI components
   * Called once during view initialization
   *
   * Order matters: toggle bar, breadcrumb, display, progress, controls, settings
   */
  private buildUI(): void {
    this.buildToggleBar();
    this.buildBreadcrumb();
    this.buildDisplayArea();
    this.buildProgressBar();
    this.buildInlineSettings();
  }

  /**
   * Builds the toggle bar with settings button
   * Located at the top of the view
   */
  private buildToggleBar(): void {
    this.toggleBar = this.mainContainerEl.createDiv({ cls: CSS_CLASSES.toggleBar });

    this.controlsToggleBtn = createButton(this.toggleBar, {
      icon: ICONS.settings,
      title: 'Toggle Settings (S)',
      onClick: () => this.togglePanel('controls'),
      className: CSS_CLASSES.toggleBtn,
    });
  }

  /**
   * Builds the breadcrumb navigation bar
   * Shows the hierarchical position in the document (H1 > H2 > H3 etc.)
   * Updated automatically as reading progresses through headings
   */
  private buildBreadcrumb(): void {
    this.breadcrumbEl = this.mainContainerEl.createDiv({
      cls: `dashreader-breadcrumb ${CSS_CLASSES.hidden}`
    });
    // Initially empty, will be populated by updateBreadcrumb()
  }

  /**
   * Builds the main display area for word presentation
   * Includes context before/after if enabled
   */
  private buildDisplayArea(): void {
    const displayArea = this.mainContainerEl.createDiv({ cls: CSS_CLASSES.display });
    const showContextNow =
      this.getActiveShowContext() &&
      this.engine.getTotalWords() > 0 &&
      !this.suppressContextUntilPlay;
    // Tap/click anywhere in the display toggles play/pause.
    // Do not rely on 'click' here: the focus word DOM is rebuilt every tick.
    let displayPointerDown = false;
    let displayPointerMoved = false;
    let displayPointerX = 0;
    let displayPointerY = 0;
    let displayPointerId: number | null = null;
    let displayShouldToggle = false;

    const computeShouldToggle = (target: HTMLElement | null): boolean => {
      if (!target) return false;
      const clickedInWord = !!target.closest(`.${CSS_CLASSES.word}`);

      // Don’t toggle if user is interacting with controls/inputs/menus (outside the word area)
      if (!clickedInWord && target.closest('button, a, input, textarea, select, .dashreader-outline-menu')) return false;

      return true;
    };

    (this.registerDomEvent as any)(displayArea, 'pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;

      const shouldToggle = computeShouldToggle(e.target as HTMLElement | null);
      if (!shouldToggle) return;

      displayPointerDown = true;
      displayPointerMoved = false;
      displayPointerX = e.clientX;
      displayPointerY = e.clientY;
      displayPointerId = e.pointerId;
      displayShouldToggle = true;

      const t = e.target as HTMLElement | null;
      const startedInContext = !!t?.closest(
        `.${CSS_CLASSES.contextBefore}, .${CSS_CLASSES.contextAfter}`
      );

      if (!startedInContext) {
        try { displayArea.setPointerCapture(e.pointerId); } catch {}
      }
    }, { capture: true });

    this.registerDomEvent(
      displayArea,
      'pointermove',
      (e: PointerEvent) => {
        if (!displayPointerDown || displayPointerId !== e.pointerId) return;
        const dx = e.clientX - displayPointerX;
        const dy = e.clientY - displayPointerY;
        if (Math.abs(dx) > 6 || Math.abs(dy) > 6) displayPointerMoved = true;
      },
      { capture: true }
    );

    const resetDisplayPointer = (e?: PointerEvent) => {
      if (e && displayPointerId === e.pointerId) {
        try { displayArea.releasePointerCapture(e.pointerId); } catch {}
      }
      displayPointerDown = false;
      displayPointerMoved = false;
      displayPointerId = null;
      displayShouldToggle = false;
    };

    this.registerDomEvent(
      displayArea,
      'pointerup',
      (e: PointerEvent) => {
        if (displayPointerId !== e.pointerId) return;

        const shouldToggle = displayShouldToggle && !displayPointerMoved;
        resetDisplayPointer(e);

        if (!shouldToggle) return;
        if (this.ignoreNextDisplayToggleClick) {
          this.ignoreNextDisplayToggleClick = false;
          return;
        }

        this.togglePlay();
      },
      { capture: true }
    );

    this.registerDomEvent(
      displayArea,
      'pointercancel',
      (e: PointerEvent) => resetDisplayPointer(e),
      { capture: true }
    );

    let wheelAccum = 0;
    let wheelDir = 0;
    const WHEEL_THRESHOLD = 80;

    (this.registerDomEvent as any)(
      displayArea,
      'wheel',
      (e: WheelEvent) => {
        if (this.engine.getIsPlaying()) return;
        if (e.ctrlKey || e.metaKey) return; // don't fight zoom gestures

        const t = e.target as HTMLElement | null;
        if (t?.closest('button, a, input, textarea, select, .dashreader-outline-menu')) return;

        e.preventDefault();

        let dy = e.deltaY;
        if (e.deltaMode === 1) dy *= 16;      // lines -> px-ish
        else if (e.deltaMode === 2) dy *= 800; // pages -> px-ish

        const dir = Math.sign(dy);
        if (dir !== 0 && dir !== wheelDir) {
          wheelAccum = 0;
          wheelDir = dir;
        }

        wheelAccum += dy;

        // At most ONE word step per wheel event (prevents occasional double-steps)
        if (wheelAccum >= WHEEL_THRESHOLD) {
          wheelAccum -= WHEEL_THRESHOLD;
          // keep remainder bounded so it can’t trigger another step in the same event
          wheelAccum = Math.min(wheelAccum, WHEEL_THRESHOLD - 1);
          this.engine.stepWords(1);
        } else if (wheelAccum <= -WHEEL_THRESHOLD) {
          wheelAccum += WHEEL_THRESHOLD;
          wheelAccum = Math.max(wheelAccum, -(WHEEL_THRESHOLD - 1));
          this.engine.stepWords(-1);
        }
      },
      { passive: false, capture: true }
    );

    // Always create context nodes (toggle just hides/shows them)
    this.contextBeforeEl = displayArea.createDiv({
      cls: `${CSS_CLASSES.contextBefore} ${showContextNow ? '' : CSS_CLASSES.hidden}`,
    });
    this.dom.register('contextBeforeEl', this.contextBeforeEl);
    this.contextBeforeEl.style.whiteSpace = 'pre-wrap';
    this.applyContextLayout();

    this.wordEl = displayArea.createDiv({ cls: CSS_CLASSES.word });
    this.wordEl.style.setProperty("font-size", `${this.getActiveFontSize()}px`, "important");
    this.applyDashReaderFont(this.settings.fontFamily);
    this.wordEl.style.textShadow = "none";
    this.wordEl.style.filter = "none";
    this.dom.register('wordEl', this.wordEl);

    this.contextAfterEl = displayArea.createDiv({
      cls: `${CSS_CLASSES.contextAfter} ${showContextNow ? '' : CSS_CLASSES.hidden}`,
    });
    this.dom.register('contextAfterEl', this.contextAfterEl);
    this.contextAfterEl.style.whiteSpace = 'pre-wrap';
    this.applyContextLayout();
    // Ensure context scrolling state matches initial playback state
    this.setContextScrollEnabled(!this.engine.getIsPlaying());

    this.ensureContextMeasureHost();
    this.setupContextResizeObserver();
  }

  /**
   * Builds the progress bar at the bottom of display
   * Updates during reading to show progress
   */
  private buildProgressBar(): void {
    // Bottom bar wrapper: progress on top, controls beneath
    this.bottomBarEl = this.mainContainerEl.createDiv({ cls: "dashreader-bottom-bar" });

    // Keep progressEl wrapper so other code doesn't break
    this.progressEl = this.bottomBarEl.createDiv({ cls: CSS_CLASSES.progressContainer });

    // Native progress element (matches mainOriginal.ts approach) :contentReference[oaicite:1]{index=1}
    this.progressBarEl = this.progressEl.createEl("progress", {
      cls: "metadata-progress rsvp-progress-bar",
    }) as HTMLProgressElement;

    this.registerDomEvent(this.progressBarEl, 'pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;

      const bar = this.progressBarEl;
      if (!bar) return;
      const rect = bar.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
      const ratio = rect.width > 0 ? (x / rect.width) : 0;

      const total = this.engine.getTotalWords();
      if (total <= 0) return;

      const targetIndex = Math.min(total - 1, Math.max(0, Math.floor(ratio * (total - 1))));
      const wasPlaying = this.engine.getIsPlaying();
      this.engine.jumpToIndex(targetIndex);

      this.updateBottomProgressInfo(targetIndex);

      if (!wasPlaying) {
        this.engine.pause();
        updatePlayPauseButtons(this.dom, false);
        this.setContextScrollEnabled(true);
        if (this.getActiveShowContext()) this.scheduleContextUpdate(this.getContextAnchorIndex());
      }
    }, { capture: true });

    this.registerDomEvent(this.progressBarEl, "pointerenter", (e: PointerEvent) => {
      this.isProgressBarHovering = true;
      this.progressBarLastTooltipIndex = null;
      this.updateProgressTooltipForClientX(e.clientX); // set immediately
    });

    this.registerDomEvent(this.progressBarEl, "pointermove", (e: PointerEvent) => {
      if (!this.isProgressBarHovering) return;
      this.updateProgressTooltipForClientX(e.clientX);
    });

    this.registerDomEvent(this.progressBarEl, "pointerleave", () => {
      this.isProgressBarHovering = false;
      this.progressBarHoverIndex = null;
      this.progressBarLastTooltipIndex = null;

      if (this.progressBarHoverRaf !== null) {
        cancelAnimationFrame(this.progressBarHoverRaf);
        this.progressBarHoverRaf = null;
      }

      this.restoreProgressTooltipToPercent();
    });

    // Register under the same key so existing show/hide wiring doesn’t explode
    this.dom.register("progressBar", this.progressBarEl);

    // Respect setting without relying on CSS
    this.progressBarEl.style.display = this.settings.showProgress ? "" : "none";

    // Initialize values safely
    this.progressBarEl.max = Math.max(1, this.engine.getTotalWords());
    this.progressBarEl.value = Math.min(this.progressBarEl.max, this.getContextAnchorIndex() + 1);
    this.progressBarEl.setAttr("data-tooltip-position", "top");
    this.progressBarEl.setAttr("data-tooltip-delay", "0"); // immediate
    this.restoreProgressTooltipToPercent();

    // On-screen controls row
    this.buildMobileControls();
  }

  private refreshContextNow(): void {
    if (!this.getActiveShowContext() || !this.contextBeforeEl || !this.contextAfterEl) return;
    const idx = this.getContextAnchorIndex();
    const ctx = this.engine.getContextLines(idx, this.getActiveContextLines());
    this.contextBeforeEl.setText(this.renderContextTokens(ctx.before));
    this.contextAfterEl.setText(this.renderContextTokens(ctx.after));
  }

  private applyAppearanceCssVars(): void {
    const root = this.modalEl;
    if (!root) return;

    const apply = (name: string, value: string) => {
      const v = (value ?? '').trim();
      // blank (or "theme") means: do not set -> CSS/theme/snippets decide
      if (!v || v.toLowerCase() === 'theme') root.style.removeProperty(name);
      else root.style.setProperty(name, v);
    };

    apply('--dashreader-highlight-color', this.settings.highlightColor);
    apply('--dashreader-font-color', this.settings.fontColor);
    apply('--dashreader-background-color', this.settings.backgroundColor);
  }

  private ensureContextMeasureHost(): void {
    if (this._contextMeasureHostEl) return;

    const host = this.modalEl.createDiv();
    host.style.position = 'fixed';
    host.style.left = '-100000px';
    host.style.top = '0';
    host.style.visibility = 'hidden';
    host.style.pointerEvents = 'none';
    host.style.zIndex = '-1';
    host.style.overflow = 'visible';

    const mk = () => {
      const el = host.createDiv();
      el.style.boxSizing = 'border-box';
      el.style.whiteSpace = 'pre-wrap';
      (el.style as any).overflowWrap = 'anywhere';
      el.style.wordBreak = 'break-word';
      return el;
    };

    this._contextMeasureHostEl = host;
    this._contextMeasureBeforeEl = mk();
    this._contextMeasureAfterEl = mk();
  }

  private syncMeasureStyle(fromEl: HTMLElement, measureEl: HTMLElement): void {
    const cs = getComputedStyle(fromEl);
    const w = fromEl.getBoundingClientRect().width;

    measureEl.style.width = `${Math.max(1, w)}px`;
    measureEl.style.padding = cs.padding;

    measureEl.style.fontFamily = cs.fontFamily;
    measureEl.style.fontSize = cs.fontSize;
    measureEl.style.fontWeight = cs.fontWeight;
    measureEl.style.lineHeight = cs.lineHeight;
    measureEl.style.letterSpacing = cs.letterSpacing;
  }

  private formatTime(seconds: number): string {
    const s = Math.max(0, Math.round(seconds));
    const mins = Math.floor(s / 60);
    const secs = s % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }

  private getWrappedLinesSubset(
    text: string,
    targetEl: HTMLElement,
    measureEl: HTMLElement,
    count: number,
    mode: 'first' | 'last'
  ): string[] {
    const n = Math.max(0, Math.floor(count));
    if (n === 0) return [];

    this.syncMeasureStyle(targetEl, measureEl);
    measureEl.setText(text ?? '');

    const node = measureEl.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) {
      return mode === 'first' ? Array(n).fill('') : Array(n).fill('');
    }

    const textNode = node as Text;
    const full = textNode.data ?? '';
    const len = full.length;

    if (len === 0) {
      return mode === 'first' ? Array(n).fill('') : Array(n).fill('');
    }

    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, len);

    const rects = Array.from(range.getClientRects());
    if (rects.length === 0) {
      return mode === 'first' ? Array(n).fill('') : Array(n).fill('');
    }

    // Unique visual line "tops"
    const tops: number[] = [];
    for (const r of rects) {
      const t = Math.round(r.top);
      if (!tops.length || Math.abs(t - tops[tops.length - 1]) > 1) tops.push(t);
    }

    const totalLines = tops.length;
    const startLine = mode === 'first' ? 0 : Math.max(0, totalLines - n);
    const endLineExcl = mode === 'first' ? Math.min(totalLines, n) : totalLines;

    const lastTopAt = (end: number): number => {
      const e = Math.max(0, Math.min(len, end));
      if (e === 0) return -Infinity;
      range.setStart(textNode, 0);
      range.setEnd(textNode, e);
      const rs = range.getClientRects();
      if (!rs.length) return -Infinity;
      return Math.round(rs[rs.length - 1].top);
    };

    const findStartOffsetForTop = (targetTop: number): number => {
      // Binary search smallest "end" where the last line top reaches targetTop
      let lo = 1;
      let hi = len;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        const t = lastTopAt(mid);
        if (t < targetTop) lo = mid + 1;
        else hi = mid;
      }
      return Math.max(0, lo - 1);
    };

    // Compute offsets for the contiguous subset of lines we want, plus the next-line start as end boundary
    const offsets: number[] = [];
    for (let i = startLine; i < endLineExcl; i++) {
      offsets.push(i === 0 ? 0 : findStartOffsetForTop(tops[i]));
    }
    const endOffset =
      endLineExcl < totalLines ? findStartOffsetForTop(tops[endLineExcl]) : len;
    offsets.push(endOffset);

    const lines: string[] = [];
    for (let i = 0; i < offsets.length - 1; i++) {
      let seg = full.slice(offsets[i], offsets[i + 1]);

      // Clean boundaries introduced by explicit '\n' or wrapping at spaces
      seg = seg.replace(/^\n+/, '');
      seg = seg.replace(/\n+$/, '');
      seg = seg.replace(/^\s+/, '');
      seg = seg.trimEnd();

      lines.push(seg);
    }

    // Pad to EXACTLY N line slots
    if (mode === 'first') {
      while (lines.length < n) lines.push('');
    } else {
      while (lines.length < n) lines.unshift('');
    }

    return lines;
  }

  private getContextAnchorIndex(): number {
    return this.lastDisplayedIndex ?? this.engine.getCurrentIndex();
  }

  private scheduleContextUpdate(index: number): void {
    this._pendingContextIndex = index;

    if (this._contextUpdateRaf !== null) return;
    this._contextUpdateRaf = window.requestAnimationFrame(() => {
      this._contextUpdateRaf = null;
      const idx = this._pendingContextIndex;
      this._pendingContextIndex = null;
      if (idx == null) return;

      this.updateContextByBrowserWrap(idx);
    });
  }

  private updateContextByBrowserWrap(wordIndex: number): void {
    if (!this.getActiveShowContext() || !this.contextBeforeEl || !this.contextAfterEl) return;

    const extraLines = Math.max(0, this.getActiveContextLines()); // 0..10
    const visibleLines = extraLines + 1;                          // 1..11

    this.ensureContextMeasureHost();
    if (!this._contextMeasureBeforeEl || !this._contextMeasureAfterEl) return;

    // Token window: big enough to cover 10+ wrapped lines even in wide layouts
    const windowTokens = Math.max(300, visibleLines * 80);
    const ctx = this.engine.getContextTokenWindow(wordIndex, windowTokens, windowTokens);

    const beforeText = this.renderContextTokens(ctx.before);
    const afterText = this.renderContextTokens(ctx.after);

    const beforeLines = this.getWrappedLinesSubset(
      beforeText,
      this.contextBeforeEl,
      this._contextMeasureBeforeEl,
      visibleLines,
      'last'
    );

    const afterLines = this.getWrappedLinesSubset(
      afterText,
      this.contextAfterEl,
      this._contextMeasureAfterEl,
      visibleLines,
      'first'
    );

    // These now contain explicit '\n' at the browser’s own wrap boundaries
    this.contextBeforeEl.setText(beforeLines.join('\n'));
    this.contextAfterEl.setText(afterLines.join('\n'));
  }

  private setupContextResizeObserver(): void {
    if (this._contextResizeObserver || !this.contextBeforeEl || !this.contextAfterEl) return;

    const ro = new ResizeObserver(() => {
      this.scheduleContextUpdate(this.getContextAnchorIndex());
    });

    ro.observe(this.contextBeforeEl);
    ro.observe(this.contextAfterEl);

    this._contextResizeObserver = ro;
    this._domUnsubs.push(() => {
      try { ro.disconnect(); } catch {}
    });
  }

  private buildMobileControls(): void {
    this.mobileControlsEl = this.bottomBarEl.createDiv({ cls: "dashreader-mobile-controls" });

    const wrap = this.mobileControlsEl.createDiv({ cls: "dashreader-mobile-controls-wrap" });

    this.progressInfoLeftEl = wrap.createSpan({
      cls: "dashreader-progress-info dashreader-progress-info-left",
    });

    const row = wrap.createDiv({ cls: "dashreader-mobile-controls-row" });

    this.progressInfoRightEl = wrap.createSpan({
      cls: "dashreader-progress-info dashreader-progress-info-right",
    });

    this.updateBottomProgressInfo();

    createButton(row, {
      icon: "lucide:chevrons-left",
      title: "Jump to start (Ctrl+←)",
      onClick: () => { this.engine.jumpToStart(); this.defocusInteractiveElements(); },
      className: CSS_CLASSES.toggleBtn,
    });

    createButton(row, {
      icon: "lucide:arrow-up",
      title: "Previous heading (↑)",
      onClick: () => { this.jumpHeading("up"); this.defocusInteractiveElements(); },
      className: CSS_CLASSES.toggleBtn,
    });

    createButton(row, {
      icon: "lucide:arrow-left",
      title: "Rewind (←)",
      onClick: () => { this.engine.rewindSeconds(10); this.defocusInteractiveElements(); },
      className: CSS_CLASSES.toggleBtn,
    });

    createPlayPauseButtons(
      row,
      () => { if (!this.engine.getIsPlaying()) this.togglePlay(); else this.defocusInteractiveElements(); },
      () => { if (this.engine.getIsPlaying()) this.togglePlay(); else this.defocusInteractiveElements(); },
      this.dom
    );
    updatePlayPauseButtons(this.dom, this.engine.getIsPlaying());

    createButton(row, {
      icon: "lucide:arrow-right",
      title: "Forward (→)",
      onClick: () => { this.engine.forwardSeconds(10); this.defocusInteractiveElements(); },
      className: CSS_CLASSES.toggleBtn,
    });

    createButton(row, {
      icon: "lucide:arrow-down",
      title: "Next heading (↓)",
      onClick: () => { this.jumpHeading("down"); this.defocusInteractiveElements(); },
      className: CSS_CLASSES.toggleBtn,
    });

    createButton(row, {
      icon: "lucide:chevrons-right",
      title: "Jump to end (Ctrl+→)",
      onClick: () => { this.engine.jumpToEnd(); this.defocusInteractiveElements(); },
      className: CSS_CLASSES.toggleBtn,
    });
  }

  /**
   * Builds the inline settings panel
   * Allows quick adjustments to WPM, acceleration, font size, etc.
   */
  private buildInlineSettings(): void {
    this.settingsEl = this.mainContainerEl.createDiv({
      cls: `${CSS_CLASSES.settings} ${CSS_CLASSES.hidden}`,
    });
    this.dom.register('settingsEl', this.settingsEl);

    // WPM control (duplicate for inline settings)
    createNumberControl(
      this.settingsEl,
      {
        label: 'Speed (WPM): ',
        value: this.engine.getWpm(),
        onIncrement: () => this.changeValue('wpm', INCREMENTS.wpm),
        onDecrement: () => this.changeValue('wpm', -INCREMENTS.wpm),
        increment: INCREMENTS.wpm,
        registryKey: 'wpmInlineValue',
        decrementTitle: 'Slower (-25)',
        incrementTitle: 'Faster (+25)',
      },
      this.dom
    );

    // Font size control
    createNumberControl(
      this.settingsEl,
      {
        label: 'Font Size: ',
        value: this.getActiveFontSize(),
        onIncrement: () => this.changeValue('fontSize', INCREMENTS.fontSize),
        onDecrement: () => this.changeValue('fontSize', -INCREMENTS.fontSize),
        registryKey: 'fontValue',
        decrementTitle: 'Smaller',
        incrementTitle: 'Larger',
      },
      this.dom
    );

    // Chunk size control
    createNumberControl(
      this.settingsEl,
      {
        label: 'Words: ',
        value: this.engine.getChunkSize(),
        onIncrement: () => this.changeValue('chunkSize', INCREMENTS.chunkSize),
        onDecrement: () => this.changeValue('chunkSize', -INCREMENTS.chunkSize),
        registryKey: 'chunkValue',
      },
      this.dom
    );

    // Slow Start toggle (replaces Speed Acceleration)
    createToggleControl(this.settingsEl, {
      label: 'Slow Start',
      checked: this.isMobileUI() ? this.settings.mobileEnableSlowStart : this.settings.enableSlowStart,
      onChange: (checked) => {
        if (this.isMobileUI()) this.settings.mobileEnableSlowStart = checked;
        else this.settings.enableSlowStart = checked;

        this.engine.updateSettings(this.settings);
        this.requestSettingsSave();
      },
    });

    // Micropause toggle
    createToggleControl(this.settingsEl, {
      label: 'Micropause',
      checked: this.isMobileUI() ? this.settings.mobileEnableMicropause : this.settings.enableMicropause,
      onChange: (checked) => {
        if (this.isMobileUI()) this.settings.mobileEnableMicropause = checked;
        else this.settings.enableMicropause = checked;
        this.engine.updateSettings(this.settings);
        this.requestSettingsSave();
      },
    });

    // Breadcrumb toggle
    createToggleControl(this.settingsEl, {
      label: 'Breadcrumb',
      checked: this.getActiveShowBreadcrumb(),
      onChange: (checked) => {
        this.setActiveShowBreadcrumb(checked);
        this.toggleBreadcrumbDisplay();
        this.requestSettingsSave();
      },
    });

    // Show context toggle
    createToggleControl(this.settingsEl, {
      label: 'Show Context',
      checked: this.getActiveShowContext(),
      onChange: (checked) => {
        this.setActiveShowContext(checked);
        this.toggleContextDisplay();
        if (checked && this.contextBeforeEl && this.contextAfterEl) {
          this.scheduleContextUpdate(this.getContextAnchorIndex());
        };
        this.requestSettingsSave();
      },
    });

    // Context lines control
    createNumberControl(
      this.settingsEl,
      {
        label: 'Context Lines: ',
        value: this.getActiveContextLines(), // reflects current settings (defaults to 10 if that's what settings holds)
        increment: INCREMENTS.contextLines,
        registryKey: 'contextLinesValue',
        decrementTitle: 'Fewer lines (-1)',
        incrementTitle: 'More lines (+1)',

        onIncrement: () => {
          const next = Math.max(0, Math.min(10, this.getActiveContextLines() + INCREMENTS.contextLines));
          this.setActiveContextLines(next);

          this.dom.updateText('contextLinesValue', String(next));
          this.applyContextLayout();

          if (this.getActiveShowContext()) {
            this.scheduleContextUpdate(this.getContextAnchorIndex());
          }

          this.requestSettingsSave(); // persists to data.json via your onSettingsSave hook
        },

        onDecrement: () => {
          const next = Math.max(0, Math.min(10, this.getActiveContextLines() - INCREMENTS.contextLines));
          this.setActiveContextLines(next);

          this.dom.updateText('contextLinesValue', String(next));
          this.applyContextLayout();

          if (this.getActiveShowContext()) {
            this.scheduleContextUpdate(this.getContextAnchorIndex());
          }

          this.requestSettingsSave(); // persists to data.json
        },
      },
      this.dom
    );
  }

  private syncBoldColorToTheme(): void {
    const probe = document.createElement('span');
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.innerHTML = '<strong>probe</strong>';

    this.modalEl.appendChild(probe);

    const strongEl = probe.querySelector('strong') as HTMLElement | null;
    const boldColor = strongEl ? getComputedStyle(strongEl).color : '';

    probe.remove();
  
    if (boldColor) {
      this.modalEl.style.setProperty('--dashreader-bold-color', boldColor);
    }
  }

  private setContextScrollEnabled(enabled: boolean): void {
    const before = this.contextBeforeEl;
    const after = this.contextAfterEl;

    for (const el of [before, after]) {
      if (!el) continue;
      el.toggleClass('dashreader-context-scrollable-on', enabled);
      el.toggleClass('dashreader-context-scrollable-off', !enabled);
    }
  }

  private requestSettingsSave(): void {
    if (!this.onSettingsSave) return;

    if (this._saveSettingsTimer !== null) {
      this.timeoutManager.clearTimeout(this._saveSettingsTimer);
    }

    this._saveSettingsTimer = this.timeoutManager.setTimeout(() => {
      this._saveSettingsTimer = null;
      try {
        this.onSettingsSave?.();
      } catch {
        // ignore
      }
    }, 200);
  }

  // ============================================================================
  // SECTION 4: USER INTERACTIONS
  // ============================================================================

  /**
   * Unified value change handler
   * Replaces 5 separate change functions (changeWpm, changeWpmInline, etc.)
   *
   * @param type - Type of value to change
   * @param delta - Amount to change (positive or negative)
   */
  private changeValue(
    type: 'wpm' | 'chunkSize' | 'fontSize',
    delta: number
  ): void {
    switch (type) {
      case 'wpm': {
        const newWpm = this.engine.getWpm() + delta;
        this.engine.setWpm(newWpm);
        const wpm = this.engine.getWpm();
        this.state.set('currentWpm', wpm);

        this.dom.updateMultipleText({
          wpmValue: String(wpm),
          wpmInlineValue: String(wpm),
        });
        break;
      }

      case 'chunkSize': {
        const newSize = this.engine.getChunkSize() + delta;
        this.engine.setChunkSize(newSize);
        const size = this.engine.getChunkSize();
        this.state.set('currentChunkSize', size);
        this.dom.updateText('chunkValue', size);
        this.wordDisplay?.setChunkSize(size);
        break;
      }

      case 'fontSize': {
        const key: 'mobileFontSize' | 'fontSize' = this.isMobileUI() ? 'mobileFontSize' : 'fontSize';
        const next = Math.max(
          LIMITS.fontSize.min,
          Math.min(LIMITS.fontSize.max, this.settings[key] + delta)
        );

        this.settings[key] = next;
        this.state.set('currentFontSize', next);
        if (this.wordEl) this.wordEl.style.fontSize = `${next}px`;
        this.dom.updateText('fontValue', next);
        this.wordDisplay?.setBaseFontSize(next);
        break;
      }
    }

    // Save after a successful change (NOT inside the switch body)
    this.requestSettingsSave();
  }

  /**
   * Unified panel toggle handler
   * Replaces 3 separate toggle functions (toggleControls, etc.)
   *
   * @param panel - Panel to toggle ('controls')
   */
  private togglePanel(panel: 'controls' ): void {
    const wasAnyOpen = this.isAnyInlinePanelOpen();

    if (panel === 'controls') {
      this.state.toggle('showingControls');
      const showing = this.state.get('showingControls');
      this.settingsEl.toggleClass(CSS_CLASSES.hidden, !showing);
    }

    const isAnyOpenNow = this.isAnyInlinePanelOpen();

    // If we just opened any panel, pause playback (and remember state)
    if (!wasAnyOpen && isAnyOpenNow) {
      this.pausePlaybackForInlinePanel();
    }

    // If we just closed the last open panel, resume if we paused for panels
    if (wasAnyOpen && !isAnyOpenNow) {
      this.resumePlaybackAfterInlinePanelsClose();
    }

    this.defocusInteractiveElements();
  }

  private isAnyInlinePanelOpen(): boolean {
    return !!(this.state.get('showingControls'));
  }

  private pausePlaybackForInlinePanel(): void {
    if (!this.engine.getIsPlaying()) return;

    this.wasPlayingBeforePanelOpen = true;
    this.pausedByPanelOpen = true;
    this.engine.pause();
    updatePlayPauseButtons(this.dom, false);
    this.setContextScrollEnabled(true);
  }

  private resumePlaybackAfterInlinePanelsClose(): void {
    if (!this.pausedByPanelOpen || !this.wasPlayingBeforePanelOpen) return;

    this.pausedByPanelOpen = false;
    this.wasPlayingBeforePanelOpen = false;
    this.engine.play();
    updatePlayPauseButtons(this.dom, true);
    this.setContextScrollEnabled(false);
  }

  private closeInlinePanels(): void {
    const wasAnyOpen = this.isAnyInlinePanelOpen();
    if (!wasAnyOpen) return;

    this.state.set('showingControls', false);
    this.settingsEl.toggleClass(CSS_CLASSES.hidden, true);

    this.resumePlaybackAfterInlinePanelsClose();
  }

  private setupOutsideClickToClosePanels(): void {
    this.registerDomEvent(
      document,
      'pointerdown',
      (evt: PointerEvent) => {
        if (!this.isAnyInlinePanelOpen()) return;

        const target = evt.target as Node | null;
        if (!target) return;
        const clickedInsidePanels =
          (this.settingsEl?.contains(target) ?? false);
        const clickedOnToggleBar = this.toggleBar?.contains(target) ?? false;

        if (clickedInsidePanels || clickedOnToggleBar) return;

        const controlsOpen = this.settingsEl && !this.settingsEl.hasClass(CSS_CLASSES.hidden);
        if (!controlsOpen) return;
        this.ignoreNextDisplayToggleClick = true;
        this.closeInlinePanels();
      },
      true
    );
  }

  private suppressAutoLoad(ms: number = 250): void {
    this.suppressAutoLoadUntil = Date.now() + ms;
  }

  private isAutoLoadSuppressed(): boolean {
    return Date.now() < this.suppressAutoLoadUntil;
  }

  private defocusInteractiveElements(): void {
    const active = document.activeElement as HTMLElement | null;

    // Only blur buttons, and only inside this modal (don’t break typing in inputs)
    if (active && this.modalEl.contains(active) && active.tagName.toLowerCase() === "button") {
      active.blur();
    }

    // Always take focus away from the first toggle button on open (mobile can focus it late)
    this.modalEl.focus();
  }

  /**
   * Toggles the visibility of context before/after current word
   */
  private toggleContextDisplay(): void {
    const hasText = this.engine.getTotalWords() > 0;

    const shouldHide =
      !this.getActiveShowContext() ||
      !hasText ||
      this.suppressContextUntilPlay;

    if (this.contextBeforeEl) this.contextBeforeEl.toggleClass(CSS_CLASSES.hidden, shouldHide);
    if (this.contextAfterEl) this.contextAfterEl.toggleClass(CSS_CLASSES.hidden, shouldHide);
  }

  /**
   * Toggle breadcrumb visibility
   */
  private toggleBreadcrumbDisplay(): void {
    const shouldHide = !this.getActiveShowBreadcrumb();
    if (this.breadcrumbEl) {
      this.breadcrumbEl.toggleClass(CSS_CLASSES.hidden, shouldHide);
    }
  }

  private normalizeFontFamily(input?: string): string {
    const raw = (input ?? "").trim();
    if (!raw || raw.toLowerCase() === "default") return "inherit";

    // Back-compat + typo guard
    const lower = raw.toLowerCase();
    if (lower === "literata" || lower === "litterata") return '"Literata"';

    // Generic families / keywords
    const generics = new Set([
      "inherit", "serif", "sans-serif", "monospace", "cursive", "fantasy",
      "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded",
      "emoji", "math", "fangsong"
    ]);
    if (generics.has(lower)) return lower;

    // Support comma-separated fallback lists; quote names with spaces
    const parts = raw.split(",").map(p => p.trim()).filter(Boolean);
    const normalized = parts.map(p => {
      if (/^["'].*["']$/.test(p)) return p;            // already quoted
      if (/\s/.test(p)) return `"${p.replace(/"/g, '\\"')}"`;
      return p;
    });

    return normalized.join(", ");
  }

  private applyDashReaderFont(fontFamily?: string): void {
    const ff = this.normalizeFontFamily(fontFamily);
    this.mainContainerEl?.style.setProperty("font-family", ff, "important");
    this.wordEl?.style.setProperty("font-family", ff, "important");
  }

  // ============================================================================
  // SECTION 5: AUTO-LOAD SYSTEM
  // ============================================================================

  /**
   * Sets up automatic text loading from editor
   *
   * Registers event handlers for:
   * - file-open: Load text when opening a file
   * - active-leaf-change: Load text when switching files
   * - mouseup: Check for selection/cursor changes
   * - keyup: Check for navigation/selection keys
   *
   * Actual tracking logic is encapsulated in AutoLoadManager
   */
  private setupAutoLoad(): void {
    // Event: file-open - Auto-load entire page
    this.registerEvent(
      this.app.workspace,
      this.app.workspace.on('file-open', (file) => {
        if (this.isAutoLoadSuppressed()) return;   // <-- added
        if (!file) return;

        this.autoLoadManager.resetForNewFile(file.path);
        this.autoLoadManager.loadFromEditor(TIMING.autoLoadDelay);
      })
    );

    // Event: active-leaf-change - Backup loader
    this.registerEvent(
      this.app.workspace,
      this.app.workspace.on('active-leaf-change', () => {
        if (this.isAutoLoadSuppressed()) return;   // <-- added
        if (!this.mainContainerEl || !this.mainContainerEl.isShown()) return;

        const currentFile = this.app.workspace.getActiveFile();
        if (currentFile && this.autoLoadManager.hasFileChanged(currentFile.path)) {
          this.autoLoadManager.resetForNewFile(currentFile.path);
          this.autoLoadManager.loadFromEditor(TIMING.autoLoadDelayShort);
        }
      })
    );

    // Mouse events for cursor tracking
    this.registerDomEvent(document, 'mouseup', (evt: MouseEvent) => {
      if (this.isAutoLoadSuppressed()) return;

      const target = evt.target as Node | null;
      if (target && this.modalEl.contains(target)) return;

      this.timeoutManager.setTimeout(() => {
        if (this.mainContainerEl.isShown() && !this.isAutoLoadSuppressed()) {
          this.autoLoadManager.checkSelectionOrCursor();
        }
      }, TIMING.autoLoadDelayVeryShort);
    });

    // Keyboard events for navigation and selection
    this.registerDomEvent(document, 'keyup', (evt: KeyboardEvent) => {
      // If DashReader just handled a hotkey, do NOT auto-reload from editor
      if (this.isAutoLoadSuppressed()) return;

      // While actively playing, never auto-load (it will constantly fight navigation hotkeys)
      if (this.engine.getIsPlaying()) return;

      const active = document.activeElement as Node | null;
      if (active && this.modalEl.contains(active)) return;

      if (isNavigationKey(evt) || isSelectionKey(evt)) {
        this.timeoutManager.setTimeout(() => {
          if (this.mainContainerEl.isShown() && !this.isAutoLoadSuppressed() && !this.engine.getIsPlaying()) {
            this.autoLoadManager.checkSelectionOrCursor();
          }
        }, TIMING.autoLoadDelayVeryShort);
      }
    });
  }

  // ============================================================================
  // SECTION 6: HOTKEYS & KEYBOARD
  // ============================================================================

  /**
   * Sets up keyboard shortcuts for playback control
   */
  private setupHotkeys(): void {
    if (this.keydownHandler) return; // prevent duplicates
    this.keydownHandler = (e: KeyboardEvent) => this.handleKeyPress(e);
    this.registerDomEvent(document, 'keydown', this.keydownHandler);
  }

  /**
   * Handles keyboard shortcuts
   *
   * Shortcuts:
   * - C: Toggle controls (when not playing)
   * - Shift+Space: Play/Pause
   * - Arrow keys: Rewind/Forward, WPM adjustment
   * - Escape: Stop reading
   *
   * @param e - Keyboard event
   */
  private handleKeyPress(e: KeyboardEvent): void {
    if (!this.mainContainerEl.isShown()) return;

    // Don’t hijack keys while typing in an input
    const tag = (document.activeElement?.tagName ?? '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;

    const isCmd = e.ctrlKey || e.metaKey;

    // Ctrl+Left = beginning, Ctrl+Right = end
    if (isCmd && e.key === 'ArrowLeft') {
      e.preventDefault();
      this.suppressAutoLoad();
      this.engine.jumpToStart();
      return;
    }
    if (isCmd && e.key === 'ArrowRight') {
      e.preventDefault();
      this.suppressAutoLoad();
      this.engine.jumpToEnd();
      return;
    }

    // Up/Down = heading navigation (with repeat “latency”)
    if (!e.shiftKey && !e.altKey && !isCmd && e.key === 'ArrowUp') {
      e.preventDefault();
      this.suppressAutoLoad();
      this.jumpHeading('up');
      return;
    }
    if (!e.shiftKey && !e.altKey && !isCmd && e.key === 'ArrowDown') {
      e.preventDefault();
      this.suppressAutoLoad();
      this.jumpHeading('down');
      return;
    }

    // Quick toggles for panels (allow anytime; don't steal Ctrl/Cmd+C)
    if (!isCmd && e.key.toLowerCase() === 's') {
      e.preventDefault();
      this.suppressAutoLoad();
      this.togglePanel('controls');
      return;
    }

    // Delegate hotkey handling to HotkeyHandler
    this.hotkeyHandler.handleKeyPress(e);
    if (e.defaultPrevented) {
      this.suppressAutoLoad();
    }
  }

  /**
   * Toggles play/pause state
   * Updates UI buttons accordingly
   */
  private togglePlay(): void {
    if (this.isAnyInlinePanelOpen()) {
      this.pausedByPanelOpen = false;
      this.wasPlayingBeforePanelOpen = false;
    }

    if (this.engine.getIsPlaying()) {
      this.engine.pause();
      updatePlayPauseButtons(this.dom, false);

      // 3.2: PAUSED => context scroll ON
      this.setContextScrollEnabled(true);
      if (this.getActiveShowContext()) {
        this.scheduleContextUpdate(this.getContextAnchorIndex());
      }

    } else {
      if (this.state.get('startTime') === 0) {
        this.state.set('startTime', Date.now());
      }
      this.engine.play();
      updatePlayPauseButtons(this.dom, true);

      if (this.suppressContextUntilPlay) {
        this.suppressContextUntilPlay = false;
        this.toggleContextDisplay();
        if (this.getActiveShowContext()) {
          this.scheduleContextUpdate(this.getContextAnchorIndex());
        }
      }

      // 3.2: PLAYING => context scroll OFF
      this.setContextScrollEnabled(false);
    }

    this.defocusInteractiveElements();
  }

  private getIndexFromProgressClientX(clientX: number): number | null {
    const bar = this.progressBarEl;
    if (!bar) return null;

    const rect = bar.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const ratio = rect.width > 0 ? (x / rect.width) : 0;

    const total = this.engine.getTotalWords();
    if (total <= 0) return null;

    return Math.min(total - 1, Math.max(0, Math.floor(ratio * (total - 1))));
  }

  private buildProgressHoverTooltip(targetIndex: number): string {
    const totalWords = this.engine.getTotalWords();

    // Virtual time model (accounts for acceleration/micropauses/etc. as implemented in the engine)
    const totalSec = this.engine.getVirtualTotalSeconds();
    const atSec = this.engine.getVirtualElapsedSecondsAtIndex(targetIndex);

    const ctx = this.engine.getCurrentHeadingContext(targetIndex);
    const headingText =
      (ctx?.breadcrumb?.length ?? 0) > 0
        ? ctx.breadcrumb
            .map(h => h.text.replace(/^\[CALLOUT:[\w-]+\]/, "").trim())
            .filter(Boolean)
            .join(" › ")
        : "Top";

    const parts: string[] = [
      headingText,
      totalWords > 0 ? `${targetIndex + 1}/${totalWords} words` : `0/0 words`,
    ];

    if (totalSec > 0) {
      parts.push(
        `${this.formatTime(atSec)}/${this.formatTime(totalSec)}`
      );
    }

    return parts.join(" • ");
  }

  private updateProgressTooltipForClientX(clientX: number): void {
    const idx = this.getIndexFromProgressClientX(clientX);
    if (idx === null || !this.progressBarEl) return;

    if (this.progressBarLastTooltipIndex === idx) return;
    this.progressBarLastTooltipIndex = idx;
  
    this.progressBarEl.setAttr("aria-label", this.buildProgressHoverTooltip(idx));
  }

  private restoreProgressTooltipToPercent(): void {
    if (!this.progressBarEl) return;

    const total = this.progressBarEl.max || (this.engine.getTotalWords() || 1);
    const current = this.progressBarEl.value || Math.min(total, this.getContextAnchorIndex() + 1);
    const percent = Math.min(100, (current / total) * 100);

    this.progressBarEl.setAttr("aria-label", `${Math.round(percent)} %`);
  }

  private updateProgressBar(chunk: WordChunk): void {
    if (!this.progressBarEl || !this.settings.showProgress) return;

    const total = this.engine.getTotalWords() || 1;

    // Advance by the *displayed* chunk size so chunkSize > 1 doesn’t lie
    const current = Math.min(total, chunk.index + 1);

    this.progressBarEl.max = total;
    this.progressBarEl.value = current;

    const percent = Math.min(100, (current / total) * 100);
    if (!this.isProgressBarHovering) {
      this.progressBarEl.setAttr("aria-label", `${Math.round(percent)} %`);
    }
    this.updateBottomProgressInfo(chunk.index);
  }

  private updateBottomProgressInfo(wordIndex?: number): void {
    if (this.engine.getTotalWords() === 0) {
      this.progressInfoLeftEl?.setText("");
      this.progressInfoRightEl?.setText("");
      return;
    }
    if (!this.progressInfoLeftEl || !this.progressInfoRightEl) return;

    const total = Math.max(1, this.engine.getTotalWords());
    const idx0 = typeof wordIndex === "number" ? wordIndex : this.getContextAnchorIndex();
    const at = Math.min(total, Math.max(1, idx0 + 1));

    // left: current word / total
    this.progressInfoLeftEl.setText(`${at}/${total}`);

    // Stable total time based on fixed WPM at load
    const wpm = this.engine.getWpm();
    const totalSec = this.engine.getVirtualTotalSeconds();
    const atSec = this.engine.getVirtualElapsedSecondsAtCurrentIndex();

    this.progressInfoRightEl.setText(
      `${this.formatTime(atSec)}/${this.formatTime(totalSec)}`
    );
  }

  private renderContextTokens(tokens: string[]): string {
    const isBreak = (t: string) => t === '\n' || t === '§§LINEBREAK§§';

    let out = '';
    let atLineStart = true;

    for (const raw of tokens) {
      if (isBreak(raw)) {
        // Keep structure
        out = out.replace(/[ \t]+$/g, '');
        out += '\n';
        atLineStart = true;
        continue;
      }

      // Strip internal markers so context looks like the note
      const t = raw
        .replace(/^\[H\d\]/, '')
        .replace(/^\[CALLOUT:[\w-]+\]/, '');

      if (!t) continue;

      if (!atLineStart) out += ' ';
      out += t;
      atLineStart = false;
    }

    // Clean punctuation spacing
    out = out.replace(/ +([,.;:!?])/g, '$1');
    // Remove spaces right after newlines
    out = out.replace(/\n +/g, '\n');

    return out.trimEnd();
  }

  private getNavigableHeadings(): HeadingInfo[] {
    return this.engine.getHeadings().filter(h => h.level >= 1);
  }

  private getActiveShowContext(): boolean {
    return this.isMobileUI() ? this.settings.mobileShowContext : this.settings.showContext;
  }
  private setActiveShowContext(v: boolean): void {
    if (this.isMobileUI()) this.settings.mobileShowContext = v;
    else this.settings.showContext = v;
    this.requestSettingsSave();
  }

  private getActiveShowBreadcrumb(): boolean {
    return this.isMobileUI() ? this.settings.mobileShowBreadcrumb : this.settings.showBreadcrumb;
  }
  private setActiveShowBreadcrumb(v: boolean): void {
    if (this.isMobileUI()) this.settings.mobileShowBreadcrumb = v;
    else this.settings.showBreadcrumb = v;
    this.requestSettingsSave();
  }

  private getActiveContextLines(): number {
    return this.isMobileUI() ? this.settings.mobileContextLines : this.settings.contextLines;
  }
  private setActiveContextLines(v: number): void {
    if (this.isMobileUI()) this.settings.mobileContextLines = v;
    else this.settings.contextLines = v;
  }

  private getActiveContextFontSize(): number {
    return this.isMobileUI() ? this.settings.mobileContextFontSize : this.settings.contextFontSize;
  }
  private setActiveContextFontSize(v: number): void {
    if (this.isMobileUI()) this.settings.mobileContextFontSize = v;
    else this.settings.contextFontSize = v;
  }

  private jumpHeading(dir: 'up' | 'down'): void {
    const headings = this.getNavigableHeadings();
    if (headings.length === 0) return;

    const now = Date.now();
    const withinWindow =
      this.headingNav.dir === dir &&
      (now - this.headingNav.lastTime) <= DashReaderView.HEADING_NAV_WINDOW_MS;

    const curWord = this.getContextAnchorIndex();

    // current heading index = last heading whose wordIndex <= curWord
    let curHeadingIdx = -1;
    for (let i = headings.length - 1; i >= 0; i--) {
      if (headings[i].wordIndex <= curWord) { curHeadingIdx = i; break; }
    }

    if (!withinWindow || this.headingNav.cursor === null) {
      if (dir === 'up') {
        let target = curHeadingIdx;
        if (target >= 0 && headings[target].wordIndex === curWord) target -= 1; // if already at start, go previous
        this.headingNav.cursor = target;
      } else {
        this.headingNav.cursor = curHeadingIdx + 1; // next heading
      }
    } else {
      this.headingNav.cursor = (this.headingNav.cursor ?? curHeadingIdx) + (dir === 'up' ? -1 : 1);
    }

    this.headingNav.dir = dir;
    this.headingNav.lastTime = now;

    const idx = this.headingNav.cursor ?? -1;

    if (dir === 'up') {
      if (idx < 0) { this.engine.jumpToStart(); return; }
    } else {
      if (idx >= headings.length) { this.engine.jumpToEnd(); return; }
    }
  this.engine.jumpToIndex(headings[idx].wordIndex);
  }

  private applyContextLayout(): void {
    if (!this.contextBeforeEl || !this.contextAfterEl) return;

    const fontPx = this.getActiveContextFontSize();
    const fullLines = Math.max(0, this.getActiveContextLines());
    const totalLinesPerPanel = fullLines + 1; // anchor + extra

    const lineHeightPx = Math.round(fontPx * 1.6);
    const panelHeightPx = totalLinesPerPanel * lineHeightPx;

    for (const el of [this.contextBeforeEl, this.contextAfterEl]) {
      el.style.fontSize = `${fontPx}px`;
      el.style.lineHeight = `${lineHeightPx}px`;

      el.style.height = `${panelHeightPx}px`;
      el.style.minHeight = `${panelHeightPx}px`;
      el.style.maxHeight = `${panelHeightPx}px`;

      // IMPORTANT: prevent browser “double wrapping”
      el.style.whiteSpace = 'pre-wrap';
      (el.style as any).overflowWrap = 'anywhere';
      el.style.wordBreak = 'break-word';
      el.style.wordBreak = 'normal';
      (el.style as any).overflowWrap = 'normal';
      el.style.overflowX = 'hidden';

      el.style.textAlign = 'left';
    }
  }

  // ============================================================================
  // SECTION 7: READING ENGINE CALLBACKS
  // ============================================================================

  /**
   * Called by engine when a new word is displayed
   * Updates the UI with the current word, context, progress, and stats
   *
   * @param chunk - Word chunk with text, index, delay info
   */
  private onWordChange(chunk: WordChunk): void {
    this.lastDisplayedIndex = chunk.index;
    // Detect heading markers [H1], [H2], etc.
    const headingMatch = chunk.text.match(/^\[H(\d)\]/);
    // Detect callout markers [CALLOUT:type]
    const calloutMatch = chunk.text.match(/^\[CALLOUT:([\w-]+)\]/);

    let displayText = chunk.text;
    let headingLevel = 0;
    let showSeparator = false;
    let calloutType: string | undefined;

    if (headingMatch) {
      headingLevel = parseInt(headingMatch[1]);
      displayText = chunk.text.replace(/^\[H\d\]/, '');
      showSeparator = false;
    } else if (calloutMatch) {
      calloutType = calloutMatch[1];
      displayText = chunk.text.replace(/^\[CALLOUT:[\w-]+\]/, '');
      showSeparator = false;
    }

    // Delegate word display to WordDisplay module
    this.wordDisplay.displayWord(displayText, headingLevel, false, calloutType);

    // Update breadcrumb navigation (only if context changed)
    if (chunk.headingContext && this.breadcrumbManager) {
      if (this.breadcrumbManager.hasHeadingContextChanged(chunk.headingContext)) {
        this.breadcrumbManager.updateBreadcrumb(chunk.headingContext);
      }
    }

    // Update context
    if (this.getActiveShowContext() && this.contextBeforeEl && this.contextAfterEl) {
      this.scheduleContextUpdate(chunk.index);
    }

    // Update progress bar
    this.updateProgressBar(chunk);

    this.requestSettingsSave();
  }

  // ============================================================================
  // SECTION 8: TEXT LOADING
  // ============================================================================

  /**
   * Parses markdown and calculates start position from cursor
   *
   * @param text - Raw markdown text
   * @param cursorPosition - Optional cursor position in raw text
   * @returns Object with plainText and wordIndex
   */
  private parseAndCalculateStartPosition(
    text: string,
    cursorPosition?: number
  ): { plainText: string; wordIndex?: number } {
    // Parse markdown FIRST (remove syntax, keep content)
    const plainText = MarkdownParser.parseToPlainText(text);

    // Calculate word index from cursor position
    let wordIndex: number | undefined;
    if (cursorPosition !== undefined) {
      // Parse text up to cursor position
      const textUpToCursor = text.substring(0, cursorPosition);
      const parsedUpToCursor = MarkdownParser.parseToPlainText(textUpToCursor);

      const cleanedUpToCursor = parsedUpToCursor
        .replace(/\n+/g, ' §§LINEBREAK§§ ')
        .replace(/[ \t]+/g, ' ')
        .trim();

      const tokensBeforeCursor = cleanedUpToCursor.split(/\s+/).filter(Boolean);
      wordIndex = tokensBeforeCursor.length;
    }

    return { plainText, wordIndex };
  }

  /**
   * Updates stats display and word display with ready message
   *
   * @param wordIndex - Starting word index (if resuming from cursor)
   * @param source - Optional source information (filename, line number)
   */
  private updateStatsDisplay(
    wordIndex: number | undefined,
    source?: { fileName?: string; lineNumber?: number }
  ): void {
      // Include any configured auto-start delay in "ready"-state duration displays.
      // Engine estimates cover virtual reading time; autoStartDelay is extra wait time before playback begins.
      const startDelaySec = this.settings.autoStart ? Math.max(0, Math.round(this.settings.autoStartDelay)) : 0;

      const estimatedDurationSec = this.engine.getVirtualRemainingSeconds() + startDelaySec;

      // Display ready message in main word area
      const durationText = this.formatTime(estimatedDurationSec);

    // Display ready message in main word area
    this.wordDisplay.displayReadyMessage(
      this.engine.getRemainingWords(),
      this.engine.getTotalWords(),
      wordIndex,
      durationText,
      source?.fileName,
      source?.lineNumber
    );
  }

  /**
   * Builds and displays initial breadcrumb based on starting position
   *
   * @param wordIndex - Starting word index (0 if starting from beginning)
   */
  private buildInitialBreadcrumb(wordIndex: number): void {
    // Get heading context from engine (reuses breadcrumb building logic)
    const context = this.engine.getCurrentHeadingContext(wordIndex);

    // Update breadcrumb manager if we have headings
    if (context.breadcrumb.length > 0) {
      this.breadcrumbManager.updateBreadcrumb(context);
    }
  }

  /**
   * Handles auto-start functionality if enabled in settings
   * Starts reading after the configured delay
   */
  private handleAutoStart(): void {
    if (!this.settings.autoStart) return;

    this.timeoutManager.setTimeout(() => {
      this.suppressContextUntilPlay = false;
      this.toggleContextDisplay();
      this.engine.play();
      if (this.getActiveShowContext()) this.scheduleContextUpdate(this.getContextAnchorIndex());
      updatePlayPauseButtons(this.dom, true);
      this.state.set('startTime', Date.now());

      // Auto-start is playing => context scroll OFF
      this.setContextScrollEnabled(false);
    }, this.settings.autoStartDelay * 1000);
  }

  /**
   * Loads text for reading
   *
   * Process:
   * 1. Stop current reading if playing
   * 2. Parse markdown to plain text
   * 3. Calculate word index from cursor position (if provided)
   * 4. Validate text length
   * 5. Load into engine
   * 6. Update UI with ready message
   * 7. Auto-start if enabled
   *
   * @param text - Text to load (raw markdown)
   * @param source - Optional source information (filename, line, cursor position)
   */
  public loadText(
    text: string,
    source?: { fileName?: string; lineNumber?: number; cursorPosition?: number }
  ): void {
    if (!this.isInitialized) {
      this.pendingLoad = { text, source };
      this.skipInitialAutoLoad = true;
      return;
    }

    if (!source || source.cursorPosition === undefined) {
      this.suppressAutoLoad(1000);
      this.autoLoadManager.syncStateToEditor();
    }

    // Always reset session state before loading new text/index (playing OR paused)
    this.engine.stop();
    updatePlayPauseButtons(this.dom, false);

    // After stopping/loading (paused state), allow context panels to be scrollable
    // (scrolling is disabled again automatically when playback starts).
    this.setContextScrollEnabled(true);

    // Reset breadcrumb context for new text
    this.breadcrumbManager.reset();

    // Parse markdown and calculate start position
    const { plainText, wordIndex: wordIndexFromCursor } = this.parseAndCalculateStartPosition(
      text,
      source?.cursorPosition
    );

    // Verify text length
    if (!plainText || plainText.trim().length < TEXT_LIMITS.minParsedLength) {
      return;
    }

    // Load text into engine
    this.engine.setText(plainText, undefined, wordIndexFromCursor);
    this.state.update({ wordsRead: 0, startTime: 0 });

    this.sessionStartIndex = this.getContextAnchorIndex();
    this.sessionTotalTokens = Math.max(1, this.engine.getTotalWords() - this.sessionStartIndex);
    this.sessionTotalDurationSec = this.engine.getEstimatedDuration(); // same source as welcome

    // Remove welcome message
    const welcomeMsg = this.wordEl.querySelector(`.${CSS_CLASSES.welcome}`);
    if (welcomeMsg) {
      welcomeMsg.remove();
    }

    if (this.wordDisplay) this.wordDisplay.clear();
    else this.wordEl.empty();

    // Update stats and display ready message
    this.updateStatsDisplay(wordIndexFromCursor, source);

    // Build and display initial breadcrumb
    this.buildInitialBreadcrumb(wordIndexFromCursor ?? 0);

    // Context should only appear after text is loaded.
    this.toggleContextDisplay();
    if (this.getActiveShowContext()) {
      this.scheduleContextUpdate(this.getContextAnchorIndex());
    }

    // Auto-start reading if enabled
    this.handleAutoStart();
  }

  // ============================================================================
  // SECTION 9: SETTINGS & LIFECYCLE
  // ============================================================================

  /**
   * Updates settings from plugin settings tab
   * Called when user changes settings in main settings panel
   *
   * @param settings - New settings
   */

  public togglePlayPause(): void {
    this.togglePlay();
  }

  public requestSkipInitialAutoLoadOnce(): void {
    this.skipInitialAutoLoad = true;
  }

  public updateSettings(settings: DashReaderSettings): void {
    this.settings = settings;
    this.engine.updateSettings(settings);
    this.engine.setUseMobileProfile(this.isMobileUI());
    this.applyContextLayout();
    this.applyAppearanceCssVars();

    if (this.mainContainerEl) {
      this.applyDashReaderFont(settings.fontFamily);
    }

    if (this.wordEl) {
      this.wordEl.style.setProperty("font-size", `${this.getActiveFontSize()}px`, "important");
      this.wordDisplay?.setBaseFontSize(this.getActiveFontSize());
      this.wordDisplay?.setChunkSize(this.engine.getChunkSize());
      this.applyDashReaderFont(settings.fontFamily);
    }
    if (this.progressBarEl) {
      this.progressBarEl.style.display = settings.showProgress ? "" : "none";
    }
    this.wordDisplay?.updateSettings(this.settings);
    this.toggleContextDisplay();
    this.toggleBreadcrumbDisplay();
  }
}

export { DashReaderView as DashReaderModal };