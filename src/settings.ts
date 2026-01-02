import { App, PluginSettingTab, Setting } from 'obsidian';
import DashReaderPlugin from '../main';
import { getInstalledFontFamilies } from './services/font-family';

function cssQuoteFont(name: string): string {
  const t = name.trim();
  if (!t) return t;
  if (/^["'].*["']$/.test(t)) return t;
  return /\s/.test(t) ? `"${t.replace(/"/g, '\\"')}"` : t;
}

class FontFamilySuggest {
  private suggestEl: HTMLDivElement;
  private isOpen = false;
  private items: string[] = [];
  private filtered: string[] = [];
  private selectedIndex = -1;

  private ignoreBlurUntil = 0;
  private markIgnoreBlur(ms = 500): void {
    this.ignoreBlurUntil = Date.now() + ms;
  }
  private shouldIgnoreBlur(): boolean {
    return Date.now() < this.ignoreBlurUntil;
  }

  private onDocPointerDown = (evt: PointerEvent) => {
    const t = evt.target as Node | null;
    if (!t) return;
    if (t === this.inputEl || this.inputEl.contains(t)) return;
    if (t === this.suggestEl || this.suggestEl.contains(t)) return;
    this.close();
  };

  private onWinResize = () => this.position();

  constructor(
    private inputEl: HTMLInputElement,
    private getItems: () => string[],
    private onSelect: (value: string) => void
  ) {
    this.suggestEl = document.body.createDiv({
      cls: "dashreader-font-suggest",
    });
    this.suggestEl.style.display = "none";

    // Mobile + desktop: open full list on focus/tap
    this.inputEl.addEventListener("focus", () => this.open("all"));
    this.inputEl.addEventListener("pointerdown", () => {
      // ensures tap opens even if already focused (mobile)
      if (!this.isOpen) queueMicrotask(() => this.open("all"));
    });

    // Keep search narrowing when the user types
    this.inputEl.addEventListener("input", () => this.open("filter"));

    // Keyboard navigation
    this.inputEl.addEventListener("keydown", (e) => this.onKeydown(e));

    // Close when leaving the input (touch-safe: don't rely on :hover)
    this.inputEl.addEventListener("blur", () => {
      window.setTimeout(() => {
        if (this.shouldIgnoreBlur()) return;
        this.close();
      }, 120);
    });

    // If user taps/scrolls inside dropdown, don't let blur-close win
    this.suggestEl.addEventListener("pointerdown", () => this.markIgnoreBlur(700));
  }

  destroy(): void {
    this.close();
    this.suggestEl.remove();
    document.removeEventListener("pointerdown", this.onDocPointerDown);
    window.removeEventListener("resize", this.onWinResize);
  }

  private open(mode: "all" | "filter"): void {
    this.items = this.getItems();
    this.filterAndRender(mode);

    if (!this.filtered.length) {
      this.close();
      return;
    }

    if (!this.isOpen) {
      this.isOpen = true;
      this.suggestEl.style.display = "block";
      document.addEventListener("pointerdown", this.onDocPointerDown);
      window.addEventListener("resize", this.onWinResize);
    }

    this.position();
    this.refreshSelection();
  }

  private close(): void {
    if (!this.isOpen) return;
    this.isOpen = false;
    this.suggestEl.style.display = "none";
    this.suggestEl.empty();
    document.removeEventListener("pointerdown", this.onDocPointerDown);
    window.removeEventListener("resize", this.onWinResize);
  }

  private position(): void {
    if (!this.isOpen) return;

    const r = this.inputEl.getBoundingClientRect();
    const margin = 6;
    const maxH = 320;

    const spaceBelow = window.innerHeight - r.bottom - margin;
    const spaceAbove = r.top - margin;

    const openUp = spaceBelow < 200 && spaceAbove > spaceBelow;
    const height = Math.min(maxH, openUp ? spaceAbove : spaceBelow);

    this.suggestEl.style.left = `${Math.round(r.left)}px`;
    this.suggestEl.style.width = `${Math.round(r.width)}px`;
    this.suggestEl.style.maxHeight = `${Math.max(120, height)}px`;

    if (openUp) {
      this.suggestEl.style.top = `${Math.round(r.top - margin)}px`;
      this.suggestEl.style.transform = "translateY(-100%)";
    } else {
      this.suggestEl.style.top = `${Math.round(r.bottom + margin)}px`;
      this.suggestEl.style.transform = "translateY(0)";
    }
  }

  private currentSelectionKey(): string {
    // Compare against the first family name, unquoted, lowercased.
    const raw = (this.inputEl.value.split(",")[0] ?? "").trim();
    const unquoted = raw.replace(/^["']|["']$/g, "");
    return unquoted.toLowerCase();
  }

  private filterAndRender(mode: "all" | "filter"): void {
    const q = mode === "all" ? "" : this.inputEl.value.trim().toLowerCase();
    const all = this.items;

    const filtered = q ? all.filter((f) => f.toLowerCase().includes(q)) : all;

    // Cap to keep UI snappy with huge font lists
    this.filtered = filtered.slice(0, 400);

    const selKey = this.currentSelectionKey();
    const exactIdx = selKey
      ? this.filtered.findIndex((f) => f.toLowerCase() === selKey)
      : -1;

    this.selectedIndex = exactIdx >= 0 ? exactIdx : (this.filtered.length ? 0 : -1);

    this.render();
  }

  private render(): void {
    this.suggestEl.empty();

    if (!this.filtered.length) {
      this.suggestEl.createDiv({
        cls: "dashreader-font-suggest-empty",
        text: "No matches",
      });
      return;
    }

    // Optional preview: keep it cheap on mobile by limiting when list is large
    const enablePreview = this.filtered.length <= 120;
    const fallback = getComputedStyle(this.inputEl).fontFamily;

    this.filtered.forEach((font, idx) => {
      const item = this.suggestEl.createDiv({
        cls: "dashreader-font-suggest-item",
        text: font,
      });

      if (enablePreview) {
        item.style.fontFamily = `${cssQuoteFont(font)}, ${fallback}`;
      }

      if (idx === this.selectedIndex) item.classList.add("is-selected");

      item.addEventListener("mouseenter", () => {
        this.selectedIndex = idx;
        this.refreshSelection();
      });

      item.addEventListener("click", () => {
        this.onSelect(font);
        this.close();
        this.inputEl.focus();
      });
    });
  }

  private refreshSelection(): void {
    const children = Array.from(this.suggestEl.children) as HTMLElement[];
    children.forEach((el, i) => {
      el.classList.toggle("is-selected", i === this.selectedIndex);
    });

    const selected = children[this.selectedIndex];
    if (selected) selected.scrollIntoView({ block: "nearest" });
  }

  private onKeydown(e: KeyboardEvent): void {
    if (!this.isOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      this.open("all");
      e.preventDefault();
      return;
    }

    if (!this.isOpen) return;

    if (e.key === "Escape") {
      this.close();
      e.preventDefault();
      return;
    }

    if (e.key === "ArrowDown") {
      this.selectedIndex = Math.min(this.filtered.length - 1, this.selectedIndex + 1);
      this.refreshSelection();
      e.preventDefault();
      return;
    }

    if (e.key === "ArrowUp") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.refreshSelection();
      e.preventDefault();
      return;
    }

    if (e.key === "Enter") {
      if (this.selectedIndex >= 0 && this.filtered[this.selectedIndex]) {
        this.onSelect(this.filtered[this.selectedIndex]);
      }
      this.close();
      e.preventDefault();
    }
  }
}

export class DashReaderSettingTab extends PluginSettingTab {
  plugin: DashReaderPlugin;

  constructor(app: App, plugin: DashReaderPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  /**
   * Helper method to create a slider with an editable numeric display
   */
  private createSliderWithInput(
    setting: Setting,
    min: number,
    max: number,
    step: number,
    value: number,
    unit: string = '',
    onChange: (value: number) => Promise<void>
  ): void {
    // Add editable input first
    const inputEl = setting.controlEl.createEl('input', {
      type: 'text',
      value: value.toString(),
      cls: 'dashreader-slider-input'
    });

    // Add unit label if provided
    if (unit) {
      setting.controlEl.createSpan({
        text: unit,
        cls: 'dashreader-slider-unit'
      });
    }

    // Add slider after input is created
    setting.addSlider(slider => slider
      .setLimits(min, max, step)
      .setValue(value)
      .setDynamicTooltip()
      .onChange(async (newValue) => {
        inputEl.value = newValue.toString();
        await onChange(newValue);
      }));

    // Update slider when input changes
    inputEl.addEventListener('change', () => void (async () => {
      let newValue = parseFloat(inputEl.value);

      // Validate and clamp value
      if (isNaN(newValue)) {
        newValue = value; // Reset to current value if invalid
      } else {
        newValue = Math.max(min, Math.min(max, newValue));
        // Round to step precision
        newValue = Math.round(newValue / step) * step;
      }

      inputEl.value = newValue.toString();

      // Update slider
      const sliderEl = setting.controlEl.querySelector('input[type="range"]') as HTMLInputElement;
      if (sliderEl) {
        sliderEl.value = newValue.toString();
      }

      await onChange(newValue);
    })());
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setName("Dashreader Settings").setHeading();

    // Section: Display
    new Setting(containerEl).setName("Display Options").setHeading();

    new Setting(containerEl)
      .setName('Show Breadcrumb')
      .setDesc('Display breadcrumb navigation at the top.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showBreadcrumb)
        .onChange(async (value) => {
          this.plugin.settings.showBreadcrumb = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Show Progress Bar')
      .setDesc('Display reading progress bar.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showProgress)
        .onChange(async (value) => {
          this.plugin.settings.showProgress = value;
          await this.plugin.saveSettings();
        }));

    // Section: Lecture
    new Setting(containerEl).setName("Reading Settings").setHeading();

    const wpmSetting = new Setting(containerEl)
      .setName('Words per Minute')
      .setDesc('Reading speed (50-5000).');
    this.createSliderWithInput(
      wpmSetting,
      50, 5000, 25,
      this.plugin.settings.wpm,
      '',
      async (value) => {
        this.plugin.settings.wpm = value;
        await this.plugin.saveSettings();
      }
    );

    const fontSizeSetting = new Setting(containerEl)
      .setName('Font Size (Desktop)')
      .setDesc('Font size in pixels (20-120px).');
    this.createSliderWithInput(
      fontSizeSetting,
      20, 120, 4,
      this.plugin.settings.fontSize,
      'px',
      async (value) => {
        this.plugin.settings.fontSize = value;
        await this.plugin.saveSettings();
      }
    );

    const chunkSetting = new Setting(containerEl)
      .setName('Words at a Time (Desktop)')
      .setDesc('Number of words displayed simultaneously for desktop profile (1–5).');
    this.createSliderWithInput(
      chunkSetting,
      1, 5, 1,
      this.plugin.settings.chunkSize,
      '',
      async (value) => {
        this.plugin.settings.chunkSize = value;
        await this.plugin.saveSettings();
      }
    );

    const mobileFontSizeSetting = new Setting(containerEl)
      .setName('Font Size (Mobile)')
      .setDesc('Font size in pixels used on mobile/touch devices (12-120px).');

    this.createSliderWithInput(
      mobileFontSizeSetting,
      12, 120, 4,
      this.plugin.settings.mobileFontSize,
      'px',
      async (value) => {
        this.plugin.settings.mobileFontSize = value;
        await this.plugin.saveSettings();
      }
    );

    const mobileChunkSetting = new Setting(containerEl)
      .setName('Words at a Time (Mobile)')
      .setDesc('Number of words displayed simultaneously for mobile/touch profile (1–5).');
    this.createSliderWithInput(
      mobileChunkSetting,
      1, 5, 1,
      this.plugin.settings.mobileChunkSize,
      '',
      async (value) => {
        this.plugin.settings.mobileChunkSize = value;
        await this.plugin.saveSettings();
      }
    );

    const minTokenFontSizeSetting = new Setting(containerEl)
      .setName('Minimum Token Font Size')
      .setDesc('Lowest font size used when a single long token is shrunk to fit (8–48px).');

    this.createSliderWithInput(
      minTokenFontSizeSetting,
      8, 48, 1,
      this.plugin.settings.minTokenFontSize,
      'px',
      async (value) => {
        this.plugin.settings.minTokenFontSize = value;
        await this.plugin.saveSettings();
      }
    );

    // Cleanup any previous suggest dropdowns (settings tab can re-render)
    document.querySelectorAll(".dashreader-font-suggest").forEach((el) => el.remove());

    let installedFonts: string[] = [];
    let suggest: FontFamilySuggest | null = null;

    new Setting(containerEl)
      .setName("Font Family")
      .setDesc("Applies to the entire DashReader UI. Leave blank to inherit the theme default.")
      .addText((text) => {
        text.setPlaceholder("inherit (blank)");
        text.setValue(this.plugin.settings.fontFamily === "inherit" ? "" : this.plugin.settings.fontFamily);

        const input = text.inputEl;
        input.setAttr("spellcheck", "false");
        input.setAttr("autocomplete", "off");

        suggest = new FontFamilySuggest(
          input,
          () => installedFonts, // only installed fonts (no hard-coded generics)
          (value) => {
            text.setValue(value);
            this.plugin.settings.fontFamily = value.trim() || "inherit";
            void this.plugin.saveSettings();
          }
        );
    
        text.onChange(async (value) => {
          this.plugin.settings.fontFamily = value.trim() || "inherit";
          await this.plugin.saveSettings();
        });
      });

    void (async () => {
      const fonts = await getInstalledFontFamilies();

      // Only real installed fonts; de-dupe is already handled in getInstalledFontFamilies()
      installedFonts = fonts.map((f) => f.trim()).filter(Boolean);

      // Mobile often can't enumerate installed families; provide a sane fallback list
      if (installedFonts.length === 0) {
        installedFonts = [
          "system-ui",
          "ui-sans-serif",
          "ui-serif",
          "ui-monospace",
          "sans-serif",
          "serif",
          "monospace",
        ];
      }
    })();

    // Section: Reading Enhancements
    new Setting(containerEl).setName("Reading Enhancements").setHeading();

    new Setting(containerEl)
      .setName('Slow Start')
      .setDesc('Gradually increase speed over first 5 words for comfortable start.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableSlowStart)
        .onChange(async (value) => {
          this.plugin.settings.enableSlowStart = value;
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Enable Acceleration')
      .setDesc('Gradually increase reading speed over time.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableAcceleration)
        .onChange(async (value) => {
          this.plugin.settings.enableAcceleration = value;
          await this.plugin.saveSettings();
        }));

    const accelDurationSetting = new Setting(containerEl)
      .setName('Acceleration Duration')
      .setDesc('Duration to reach target speed (seconds).');
    this.createSliderWithInput(
      accelDurationSetting,
      10, 120, 5,
      this.plugin.settings.accelerationDuration,
      's',
      async (value) => {
        this.plugin.settings.accelerationDuration = value;
        await this.plugin.saveSettings();
      }
    );

    const accelTargetSetting = new Setting(containerEl)
      .setName('Target WPM')
      .setDesc('Target reading speed to reach (50-5000).');
    this.createSliderWithInput(
      accelTargetSetting,
      50, 5000, 25,
      this.plugin.settings.accelerationTargetWpm,
      '',
      async (value) => {
        this.plugin.settings.accelerationTargetWpm = value;
        await this.plugin.saveSettings();
      }
    );

    // Section: Apparence
    new Setting(containerEl).setName("Appearance").setHeading();

    new Setting(containerEl)
      .setName('Highlight Color')
      .setDesc('Leave blank to use theme/CSS (This setting now maps to --dashreader-highlight-color.).')
      .addText(text => text
        .setPlaceholder('theme')
        .setValue(this.plugin.settings.highlightColor)
        .onChange(async (value) => {
          this.plugin.settings.highlightColor = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Font Color')
      .setDesc('Leave blank to use theme/CSS (Maps to --dashreader-font-color.).')
      .addText(text => text
        .setPlaceholder('theme')
        .setValue(this.plugin.settings.fontColor)
        .onChange(async (value) => {
          this.plugin.settings.fontColor = value.trim();
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Background Color')
      .setDesc('Leave blank to use theme/CSS (Maps to --dashreader-background-color.).')
      .addText(text => text
        .setPlaceholder('theme')
        .setValue(this.plugin.settings.backgroundColor)
        .onChange(async (value) => {
          this.plugin.settings.backgroundColor = value.trim();
          await this.plugin.saveSettings();
        }));

    // Section: Context
    new Setting(containerEl).setName("Context Display").setHeading();

    // Desktop context toggle (matches rsvp-view: showContext)
    new Setting(containerEl)
      .setName('Show Context (Desktop)')
      .setDesc('Display line-based context around the current phrase.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.showContext)
        .onChange(async (value) => {
          this.plugin.settings.showContext = value;
          await this.plugin.saveSettings();
        }));

    // Desktop: extra lines 0–10
    const contextLinesSetting = new Setting(containerEl)
      .setName('Context Lines (Desktop)')
      .setDesc('Extra full lines above and below the anchor line (0–10). 0 = anchor only.');
    this.createSliderWithInput(
      contextLinesSetting,
      0, 10, 1,
      this.plugin.settings.contextLines,
      '',
      async (value) => {
        this.plugin.settings.contextLines = value;
        await this.plugin.saveSettings();
      }
    );

    // Desktop: context font size
    const contextFontSizeSetting = new Setting(containerEl)
      .setName('Context Font Size (Desktop)')
      .setDesc('Font size for context panels (10–32px).');
    this.createSliderWithInput(
      contextFontSizeSetting,
      10, 32, 1,
      this.plugin.settings.contextFontSize,
      'px',
      async (value) => {
        this.plugin.settings.contextFontSize = value;
        await this.plugin.saveSettings();
      }
    );

    // Mobile context toggle (matches rsvp-view: mobileShowContext)
    new Setting(containerEl)
      .setName('Show Context (Mobile)')
      .setDesc('Display line-based context on mobile profile.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.mobileShowContext)
        .onChange(async (value) => {
          this.plugin.settings.mobileShowContext = value;
          await this.plugin.saveSettings();
        }));

    // Mobile: extra lines 0–10
    const mobileContextLinesSetting = new Setting(containerEl)
      .setName('Context Lines (Mobile)')
      .setDesc('Extra full lines above and below the anchor line on mobile (0–10).');
    this.createSliderWithInput(
      mobileContextLinesSetting,
      0, 10, 1,
      this.plugin.settings.mobileContextLines,
      '',
      async (value) => {
        this.plugin.settings.mobileContextLines = value;
        await this.plugin.saveSettings();
      }
    );

    // Mobile: context font size
    const mobileContextFontSizeSetting = new Setting(containerEl)
      .setName('Context Font Size (Mobile)')
      .setDesc('Font size for context panels on mobile (10–32px).');
    this.createSliderWithInput(
      mobileContextFontSizeSetting,
      10, 32, 1,
      this.plugin.settings.mobileContextFontSize,
      'px',
      async (value) => {
        this.plugin.settings.mobileContextFontSize = value;
        await this.plugin.saveSettings();
      }
    );

    // Section: Micropause
    new Setting(containerEl).setName("Micropause").setHeading();

    new Setting(containerEl)
      .setName('Enable Micropause')
      .setDesc('Automatic pauses based on punctuation and word length.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.enableMicropause)
        .onChange(async (value) => {
          this.plugin.settings.enableMicropause = value;
          await this.plugin.saveSettings();
        }));

    const punctuationSetting = new Setting(containerEl)
      .setName('Sentence-ending Punctuation Pause')
      .setDesc('Pause multiplier for .,!? (1.0-3.0).');
    this.createSliderWithInput(
      punctuationSetting,
      1.0, 3.0, 0.1,
      this.plugin.settings.micropausePunctuation,
      'x',
      async (value) => {
        this.plugin.settings.micropausePunctuation = value;
        await this.plugin.saveSettings();
      }
    );

    const otherPunctuationSetting = new Setting(containerEl)
      .setName('Other Punctuation Pause')
      .setDesc('Pause multiplier for ;:, (1.0-3.0).');
    this.createSliderWithInput(
      otherPunctuationSetting,
      1.0, 3.0, 0.1,
      this.plugin.settings.micropauseOtherPunctuation,
      'x',
      async (value) => {
        this.plugin.settings.micropauseOtherPunctuation = value;
        await this.plugin.saveSettings();
      }
    );

    const longWordsSetting = new Setting(containerEl)
      .setName('Long Words Pause')
      .setDesc('Pause multiplier for long words >8 chars (1.0-2.0).');
    this.createSliderWithInput(
      longWordsSetting,
      1.0, 2.0, 0.1,
      this.plugin.settings.micropauseLongWords,
      'x',
      async (value) => {
        this.plugin.settings.micropauseLongWords = value;
        await this.plugin.saveSettings();
      }
    );

    const paragraphSetting = new Setting(containerEl)
      .setName('Paragraph Pause')
      .setDesc('Pause multiplier for paragraph breaks (1.0-5.0).');
    this.createSliderWithInput(
      paragraphSetting,
      1.0, 5.0, 0.1,
      this.plugin.settings.micropauseParagraph,
      'x',
      async (value) => {
        this.plugin.settings.micropauseParagraph = value;
        await this.plugin.saveSettings();
      }
    );

    const numbersSetting = new Setting(containerEl)
      .setName('Numbers Pause')
      .setDesc('Pause multiplier for numbers and dates (1.0-3.0).');
    this.createSliderWithInput(
      numbersSetting,
      1.0, 3.0, 0.1,
      this.plugin.settings.micropauseNumbers,
      'x',
      async (value) => {
        this.plugin.settings.micropauseNumbers = value;
        await this.plugin.saveSettings();
      }
    );

    const sectionMarkersSetting = new Setting(containerEl)
      .setName('Section Markers Pause')
      .setDesc('Pause multiplier for 1., i., a., etc. (1.0-3.0).');
    this.createSliderWithInput(
      sectionMarkersSetting,
      1.0, 3.0, 0.1,
      this.plugin.settings.micropauseSectionMarkers,
      'x',
      async (value) => {
        this.plugin.settings.micropauseSectionMarkers = value;
        await this.plugin.saveSettings();
      }
    );

    const listBulletsSetting = new Setting(containerEl)
      .setName('List Bullets Pause')
      .setDesc('Pause multiplier for -, *, +, • (1.0-3.0).');
    this.createSliderWithInput(
      listBulletsSetting,
      1.0, 3.0, 0.1,
      this.plugin.settings.micropauseListBullets,
      'x',
      async (value) => {
        this.plugin.settings.micropauseListBullets = value;
        await this.plugin.saveSettings();
      }
    );

    const calloutsSetting = new Setting(containerEl)
      .setName('Callouts Pause')
      .setDesc('Pause multiplier for Obsidian callouts (1.0-3.0).');
    this.createSliderWithInput(
      calloutsSetting,
      1.0, 3.0, 0.1,
      this.plugin.settings.micropauseCallouts,
      'x',
      async (value) => {
        this.plugin.settings.micropauseCallouts = value;
        await this.plugin.saveSettings();
      }
    );

    // Section: Auto-start
    new Setting(containerEl).setName("Auto-start").setHeading();

    new Setting(containerEl)
      .setName('Auto-start Reading')
      .setDesc('Automatically start reading after text loads.')
      .addToggle(toggle => toggle
        .setValue(this.plugin.settings.autoStart)
        .onChange(async (value) => {
          this.plugin.settings.autoStart = value;
          await this.plugin.saveSettings();
        }));

    const autoStartDelaySetting = new Setting(containerEl)
      .setName('Auto-start Delay')
      .setDesc('Delay before auto-start (seconds).');
    this.createSliderWithInput(
      autoStartDelaySetting,
      1, 10, 1,
      this.plugin.settings.autoStartDelay,
      's',
      async (value) => {
        this.plugin.settings.autoStartDelay = value;
        await this.plugin.saveSettings();
      }
    );

    // Section: Hotkeys
    new Setting(containerEl).setName("Keyboard Shortcuts").setHeading();
    containerEl.createEl('p', {
      text: 'Note: hotkey customization is available in Obsidian\'s hotkeys settings.',
      cls: 'setting-item-description'
    });
  }
}
