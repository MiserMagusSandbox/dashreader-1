/**
 * MenuBuilder - Creates and manages dropdown menus
 *
 * Factorizes common menu functionality:
 * - Menu creation with proper positioning
 * - Item rendering with indentation
 * - Click handlers and navigation
 * - Outside click detection for closing
 */

import { TimeoutManager } from './services/timeout-manager';

export interface MenuItem {
  text: string;
  wordIndex: number;
  level?: number;
  isCurrent?: boolean;
}

export interface MenuOptions {
  anchorEl: HTMLElement;
  cssClass: string;
  title?: string;
  items: MenuItem[];
  onItemClick: (wordIndex: number) => void;
  showLevel?: boolean;
  indentByLevel?: boolean;
  timeoutManager: TimeoutManager;
  onClose?: (reason: 'select' | 'dismiss') => void;
}

export type MenuHandle = {
  el: HTMLElement;
  close: (reason?: 'select' | 'dismiss') => void;
  isOpen: () => boolean;
}

export class MenuBuilder {
  /**
   * Creates a dropdown menu near an anchor element
   *
   * @param options - Menu configuration
   * @returns The created menu element
   */
  static createMenu(options: MenuOptions): MenuHandle {
    const {
      anchorEl,
      cssClass,
      title,
      items,
      onItemClick,
      showLevel = false,
      indentByLevel = false,
      timeoutManager
    } = options;

    // Create menu in document body for proper positioning
    const menu = document.body.createDiv({ cls: cssClass });

    menu.style.visibility = 'hidden';

    try {
      menu.style.fontFamily = getComputedStyle(anchorEl).fontFamily;
    } catch {
      // ignore
    }

    let closed = false;

    const cleanup = (reason: 'select' | 'dismiss') => {
      if (closed) return;
      closed = true;

      menu.remove();
      document.removeEventListener('pointerdown', closeMenuOnPointerDown, true);
      options.onClose?.(reason);
    };

    // Add title if provided
    if (title) {
      menu.createDiv({
        text: title,
        cls: 'dashreader-menu-title'
      });
    }

    // Add menu items
    items.forEach((item, index) => {
      const menuItem = menu.createDiv({
        cls: item.isCurrent
          ? 'dashreader-menu-item dashreader-menu-item-current'
          : 'dashreader-menu-item'
      });

      // Apply indentation if needed
      if (indentByLevel && item.level) {
        const indent = (item.level - 1) * 16;
        menuItem.style.paddingLeft = item.isCurrent ? `${8 + indent - 3}px` : `${8 + indent}px`;
      }

      // Add level indicator if needed
      if (showLevel && item.level) {
        menuItem.createSpan({
          text: `H${item.level}`,
          cls: 'dashreader-outline-level'
        });
      } else if (!showLevel) {
        // Add number for heading menu
        menuItem.createSpan({
          text: `${index + 1}.`,
          cls: 'dashreader-outline-level'
        });
      }

      // Add item text
      menuItem.createSpan({
        text: item.text,
        cls: 'dashreader-outline-text'
      });

      // Click handler
      menuItem.addEventListener('click', () => {
        onItemClick(item.wordIndex);
        cleanup('select');
      });
    });

    // Position AFTER content exists (so we can measure). Mobile outline = centered.
    const positionMenu = () => {
      const anchorRect = anchorEl.getBoundingClientRect();

      const isMobile = window.matchMedia('(max-width: 768px)').matches;
      const isOutlineMenu = cssClass.includes('dashreader-outline-menu');
      const isHeadingMenu = cssClass.includes('heading-menu');

      // Default behavior (desktop / non-outline): keep what you already had
      let top = anchorRect.bottom + 5;
      let left = anchorRect.left;

      if (isHeadingMenu) {
        // Preserve your existing heading-menu centering behavior (fixed 300)
        const menuWidth = 300;
        const centerLeft = anchorRect.left + (anchorRect.width - menuWidth) / 2;
        const viewportWidth = window.innerWidth;
        const finalLeft = Math.max(10, Math.min(centerLeft, viewportWidth - menuWidth - 10));
        left = finalLeft;
      }

      if (isMobile && isOutlineMenu) {
        const menuRect = menu.getBoundingClientRect();
        const viewportW = window.innerWidth;
        const viewportH = window.innerHeight;
        const margin = 10;

        // X: keep it under the chevron but centered on the chevron, then clamp into viewport
        left = anchorRect.left + (anchorRect.width - menuRect.width) / 2;
        left = Math.max(margin, Math.min(left, viewportW - menuRect.width - margin));

        // Y: prefer directly under chevron; if it would overflow, try above; otherwise clamp
        const belowTop = anchorRect.bottom + 5;
        const aboveTop = anchorRect.top - menuRect.height - 5;

        top = belowTop;

        if (belowTop + menuRect.height > viewportH - margin) {
          if (aboveTop >= margin) {
            top = aboveTop; // flip above chevron
          } else {
            top = Math.max(margin, viewportH - menuRect.height - margin); // last-resort clamp
          }
        }
      }

      menu.style.left = `${left}px`;
      menu.style.top = `${top}px`;
      menu.style.visibility = '';
    };

    requestAnimationFrame(positionMenu);


    // Close menu when clicking/tapping outside.
    // Use pointerdown + capture so the dismiss gesture does NOT reach the reader surface (prevents accidental play/pause).
    const closeMenuOnPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (!target) return;

      if (menu.contains(target)) return;

      // Eat the gesture so it doesn't toggle play/pause underneath,
      // and doesn't trigger the breadcrumb button click after dismiss.
      e.preventDefault();
      e.stopPropagation();
      (e as any).stopImmediatePropagation?.();

      cleanup('dismiss');
    };

    // Delay adding the listener to avoid immediate dismiss from the opening click
    timeoutManager.setTimeout(() => {
      document.addEventListener('pointerdown', closeMenuOnPointerDown, true);
    }, 10);

    return {
      el: menu,
      close: (reason: 'select' | 'dismiss' = 'dismiss') => cleanup(reason),
      isOpen: () => !closed
    };
  }

  /**
   * Scrolls to the current item in the menu (for outline menu)
   *
   * @param menu - The menu element
   * @param timeoutManager - Timeout manager for proper cleanup
   */
  static scrollToCurrentItem(menu: HTMLElement, timeoutManager: TimeoutManager): void {
    timeoutManager.setTimeout(() => {
      const currentItem = menu.querySelector('.dashreader-menu-item-current') as HTMLElement;
      if (currentItem) {
        currentItem.scrollIntoView({ block: 'center' });
      }
    }, 10);
  }
}
