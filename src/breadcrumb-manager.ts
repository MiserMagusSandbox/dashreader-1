/**
 * BreadcrumbManager - Manages breadcrumb navigation and heading menus
 *
 * Responsibilities:
 * - Display hierarchical breadcrumb (H1 > H2 > H3)
 * - Show outline button (≡) for full document structure
 * - Show dropdown (▼) for sibling navigation
 * - Navigate to headings with play/pause handling
 */

import { HeadingContext } from './types';
import { setIcon } from "obsidian";
import { MenuBuilder } from './menu-builder';
import { RSVPEngine } from './rsvp-engine';
import { TimeoutManager } from './services/timeout-manager';
import { CSS_CLASSES } from './constants';

type BreadcrumbManagerOptions = {
  onPlayStateChange?: (isPlaying: boolean) => void;
  canAutoResume?: () => boolean;
};

export class BreadcrumbManager {
  private breadcrumbEl: HTMLElement;
  private engine: RSVPEngine;
  private timeoutManager: TimeoutManager;
  private lastHeadingContext: HeadingContext | null = null;
  private onPlayStateChange?: (isPlaying: boolean) => void;
  private canAutoResume?: () => boolean;
  private activeOutlineMenu: import('./menu-builder').MenuHandle | null = null;

  /**
   * Callout icon mapping (consistent with WordDisplay)
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

  constructor(
    breadcrumbEl: HTMLElement,
    engine: RSVPEngine,
    timeoutManager: TimeoutManager,
    opts: BreadcrumbManagerOptions = {}
  ) {
    this.breadcrumbEl = breadcrumbEl;
    this.engine = engine;
    this.timeoutManager = timeoutManager;
    this.onPlayStateChange = opts.onPlayStateChange;
    this.canAutoResume = opts.canAutoResume;
  }

  /**
   * Updates the breadcrumb navigation bar with current heading context
   * Shows hierarchical path (H1 > H2 > H3) and makes it clickable for navigation
   *
   * @param context - Current heading context from engine
   */
  updateBreadcrumb(context: HeadingContext): void {
    const hasAnyHeadings = this.engine.getHeadings().length > 0;

    this.breadcrumbEl.empty();

    // Lucide icon (no emoji)
    const docIcon = this.breadcrumbEl.createSpan({ cls: "dashreader-breadcrumb-icon" });
    setIcon(docIcon, "file-text");
    if (hasAnyHeadings) {
      docIcon.addEventListener("click", () => this.showOutlineMenu(docIcon));
    }

    // NEW: wrapper that will shrink (ellipsis) while icons stay visible
    const pathEl = this.breadcrumbEl.createSpan({ cls: "dashreader-breadcrumb-path" });

    // PDF / plain-text docs have no headings: keep the bar stable with a placeholder.
    if (!hasAnyHeadings) {
      pathEl.createSpan({
        text: "Document",
        cls: "dashreader-breadcrumb-item dashreader-breadcrumb-item--last"
      });
      return;
    }

    // If we’re before the first heading, show a placeholder instead of hiding
    if (!context || context.breadcrumb.length === 0) {
      pathEl.createSpan({
        text: "Top",
        cls: "dashreader-breadcrumb-item dashreader-breadcrumb-item--last"
      });
    } else {
      const lastIdx = context.breadcrumb.length - 1;
      
      // existing breadcrumb path rendering (keep your current loop here)
      context.breadcrumb.forEach((heading, index) => {
        if (index > 0) {
          pathEl.createSpan({ text: "›", cls: "dashreader-breadcrumb-separator" });
        }

        const itemSpan = pathEl.createSpan({
          cls: `dashreader-breadcrumb-item ${index === lastIdx ? "dashreader-breadcrumb-item--last" : ""}`.trim()
        });

        const displayText = heading.text.replace(/^\[CALLOUT:[\w-]+\]/, "").trim();
        itemSpan.textContent = displayText;

        itemSpan.addEventListener("click", () => this.navigateToHeading(heading.wordIndex));
      });
    }

    // Chevron dropdown stays OUTSIDE pathEl so it never gets pushed off-screen
    const dropdown = this.breadcrumbEl.createSpan({ cls: "dashreader-breadcrumb-dropdown" });
    setIcon(dropdown, "chevron-down");
    dropdown.addEventListener("click", () => this.showOutlineMenu(dropdown));

    this.lastHeadingContext = context;
  }

  /**
   * Closes all open menus (outline menus)
   * Called before opening a new menu to ensure only one menu is visible
   */
  private closeAllMenus(): void {
    if (this.activeOutlineMenu?.isOpen()) {
      this.activeOutlineMenu.close('dismiss');
    }
    this.activeOutlineMenu = null;

    // safety: remove any stray menus
    document.querySelectorAll('.dashreader-outline-menu').forEach(menu => menu.remove());
  }

  /**
   * Checks if heading context has changed (to avoid unnecessary updates)
   *
   * @param newContext - New heading context to check
   * @returns True if context has changed, false otherwise
   */
  hasHeadingContextChanged(newContext: HeadingContext): boolean {
    if (!this.lastHeadingContext) return true;

    if (this.lastHeadingContext.breadcrumb.length !== newContext.breadcrumb.length) {
      return true;
    }

    for (let i = 0; i < newContext.breadcrumb.length; i++) {
      if (this.lastHeadingContext.breadcrumb[i].wordIndex !== newContext.breadcrumb[i].wordIndex) {
        return true;
      }
    }

    return false; // No change
  }

  /**
   * Shows outline menu with all headings in the document
   * Displays complete document structure with indentation by level
   * Highlights current position in the list
   *
   * @param anchorEl - The element to position the menu relative to
   */
  private showOutlineMenu(anchorEl: HTMLElement): void {
    // Toggle: if already open, close and stop (do NOT re-open)
    if (this.activeOutlineMenu?.isOpen()) {
      this.activeOutlineMenu.close('dismiss');
      this.activeOutlineMenu = null;
      return;
    }

    // Otherwise ensure nothing else is hanging around
    this.closeAllMenus();

    const allHeadings = this.engine.getHeadings();

    if (allHeadings.length === 0) {
      return; // No headings to display
    }

    const wasPlayingBeforeMenu = this.engine.getIsPlaying();
    if (wasPlayingBeforeMenu) {
      this.engine.pause();
      this.onPlayStateChange?.(false);
    }

    let didSelect = false;

    // Get current position to highlight active heading
    const currentIndex = this.engine.getCurrentIndex();
    const relevantHeadings = allHeadings.filter(h => h.wordIndex <= currentIndex);
    const currentHeading = relevantHeadings.length > 0
      ? relevantHeadings[relevantHeadings.length - 1]
      : null;

    // Create menu using MenuBuilder
    const menu = MenuBuilder.createMenu({
      anchorEl: anchorEl,
      cssClass: 'dashreader-outline-menu',
      title: 'Document Outline',
      items: allHeadings.map(h => ({
        text: h.text,
        wordIndex: h.wordIndex,
        level: h.level,
        isCurrent: currentHeading ? h.wordIndex === currentHeading.wordIndex : false
      })),
      onItemClick: (wordIndex) => {
        didSelect = true;
        this.navigateToHeading(wordIndex);
      },
      showLevel: true,
      indentByLevel: true,
      timeoutManager: this.timeoutManager,
      onClose: (reason) => {
        this.activeOutlineMenu = null; // <-- FIRST LINE

        const canResume = this.canAutoResume ? this.canAutoResume() : true;
        if (!canResume) return;

        if (reason === 'dismiss') {
          if (wasPlayingBeforeMenu) {
            this.engine.play();
            this.onPlayStateChange?.(true);
          }
          return;
        }

        // only resume if we were playing before opening the menu
        if (reason === 'select' && didSelect) {
          if (wasPlayingBeforeMenu) {
            this.engine.play();
            this.onPlayStateChange?.(true);
          } else {
            this.onPlayStateChange?.(false);
          }
        }
      }
    });
    this.activeOutlineMenu = menu;
    MenuBuilder.scrollToCurrentItem(menu.el, this.timeoutManager);
  }

  /**
   * Navigates to a specific heading by word index
   * Pauses playback, jumps to the heading position, and resumes if it was playing
   *
   * @param wordIndex - Word index to navigate to
   */
  private navigateToHeading(wordIndex: number): void {
    // Direct seek: exact heading index (no linebreak drift)
    this.engine.jumpToIndex(wordIndex);
    this.onPlayStateChange?.(this.engine.getIsPlaying());
  }

  /**
   * Resets the breadcrumb state (for new text loading)
   */
  reset(): void {
    this.lastHeadingContext = null;
  }
}
