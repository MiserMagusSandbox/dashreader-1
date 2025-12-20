import { Plugin, Notice, MarkdownView, Menu, Editor } from 'obsidian';
import { DashReaderModal } from './src/rsvp-view';
import { DashReaderSettingTab } from './src/settings';
import { DashReaderSettings } from './src/types';
import { validateSettings } from './src/services/settings-validator';

export default class DashReaderPlugin extends Plugin {
  private currentModal: DashReaderModal | null = null;
  private skipInitialAutoLoad = false;
  settings: DashReaderSettings;

  async onload() {
    await this.loadSettings();

    // Ajouter l'icône dans la ribbon
    this.addRibbonIcon('zap', 'Launch speed-reader from curser', () => {
      void this.openModal();
    });

    // Command: Open DashReader
    this.addCommand({
      id: 'open',
      name: 'Launch from curser',
      callback: () => {
        void this.openModal();
      }
    });

    // Command: Read selected text
    this.addCommand({
      id: 'read-selection',
      name: 'Read selected text',
      editorCallback: (editor: Editor) => {
        const selection = editor.getSelection();
        if (selection) {
          const modal = this.openModal({ skipInitialAutoLoad: true });
          const fileName = this.app.workspace.getActiveFile()?.name;
          const lineNumber = editor.getCursor().line + 1;
          modal.loadText(selection, { fileName, lineNumber });
        } else {
          new Notice('Please select some text first');
        }
      }
    });

    // Command: Read entire note
    this.addCommand({
      id: 'read-note',
      name: 'Read entire note',
      callback: () => {
        const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (activeView) {
          const content = activeView.editor.getValue();
          const fileName = activeView.file?.name ?? this.app.workspace.getActiveFile()?.name;
          const modal = this.openModal({ skipInitialAutoLoad: true });
          modal.loadText(content, { fileName, lineNumber: 1 }); // no cursorPosition
        } else {
          new Notice('No active note found');
        }
      }
    });

    // Context menu
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu: Menu, editor: Editor) => {
        const selection = editor.getSelection();
        if (selection) {
          menu.addItem((item) => {
            item
              .setTitle('Read with speed reader')
              .setIcon('zap')
              .onClick(() => {
                const modal = this.openModal({ skipInitialAutoLoad: true });
                modal.loadText(selection);
              });
          });
        }
      })
    );

    // Onglet de paramètres
    this.addSettingTab(new DashReaderSettingTab(this.app, this));

    // Mettre à jour la vue quand les paramètres changent
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
    const rawSettings = await this.loadData() as Partial<DashReaderSettings> | null;
    this.settings = validateSettings(rawSettings);

    // Create data.json immediately on first run so it exists on disk
    if (!rawSettings) {
      await this.saveData(this.settings);
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Mettre à jour la vue si elle existe
    if (this.currentModal && this.currentModal.isOpen) {
      this.currentModal.updateSettings(this.settings);
    }
  }

  private openModal(options?: { skipInitialAutoLoad?: boolean }): DashReaderModal {
    if (this.currentModal && this.currentModal.isOpen) return this.currentModal;
    if (this.currentModal) this.currentModal.close();

    this.currentModal = new DashReaderModal(
      this.app,
      this.settings,
      () => { this.currentModal = null; },
      () => void this.saveSettings()
    );

    if (options?.skipInitialAutoLoad) {
      this.currentModal.requestSkipInitialAutoLoadOnce();
    }

    this.currentModal.open();
    return this.currentModal;
  }
}
