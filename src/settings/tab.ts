/* The settings tab.
 *
 * The only half of settings that imports `obsidian`; the rules it renders are
 * in `settings.ts`. Nothing here ever holds the key, and the field that takes
 * one never shows it back.
 */
import { Plugin, PluginSettingTab, Setting, type App } from 'obsidian';

import { EFFORTS, MODELS, type Effort } from '../checker/protocol';
import { CheckerError, verifyKey } from '../checker';
import type { KeyFile } from '../key/keyfile';
import type { RecallSettings } from './settings';

/** What the plugin has to be able to do for this tab to work. Narrow on
 *  purpose, so the tab does not reach into the plugin for anything else. */
export interface SettingsHost {
  settings: RecallSettings;
  keyFile: KeyFile;
  saveSettings(): Promise<void>;
}

export class RecallSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly host: Plugin & SettingsHost) {
    super(app, host);
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    this.renderKey(containerEl);
    this.renderModel(containerEl);
    this.renderDemo(containerEl);
  }

  private renderKey(parent: HTMLElement): void {
    const keyFile = this.host.keyFile;

    new Setting(parent).setName('Claude').setHeading();

    if (!keyFile.available) {
      // A phone. Saying it plainly beats a paste box that silently fails.
      parent.createEl('p', {
        cls: 'recall-settings-note',
        text:
          'Recall keeps your API key in a file outside the vault, so that it never syncs. ' +
          'There is nowhere to put one on this device, so checks are unavailable here — ' +
          'notes you have already checked still open and read normally.',
      });
      return;
    }

    const stored = keyFile.read();

    const setting = new Setting(parent)
      .setName('API key')
      .setDesc(
        stored
          ? `A key is stored in ${keyFile.location}. Paste a new one to replace it.`
          : `Paste an Anthropic API key. It is written to ${keyFile.location}, outside your vault, and never syncs.`,
      );

    let typed = '';
    setting.addText((text) => {
      text.setPlaceholder(stored ? 'sk-ant-… (stored)' : 'sk-ant-…');
      // The key is never read back into the UI, so there is nothing on screen
      // to shoulder-surf and nothing to leak into a screenshot of settings.
      text.inputEl.type = 'password';
      text.onChange((value) => (typed = value));
    });

    setting.addButton((button) =>
      button
        .setButtonText('Save')
        .setCta()
        .onClick(async () => {
          if (!typed.trim()) {
            this.status(parent, 'Paste a key first.', 'is-warning');
            return;
          }
          button.setDisabled(true).setButtonText('Checking…');
          try {
            // Confirms the key both authenticates and can reach the chosen
            // model, before it is stored. Costs no tokens.
            await verifyKey(typed, this.host.settings.model);
            this.host.keyFile.write(typed);
            this.host.settings.demoMode = false;
            await this.host.saveSettings();
            this.display();
          } catch (error) {
            button.setDisabled(false).setButtonText('Save');
            this.status(
              parent,
              error instanceof CheckerError ? error.message : String(error),
              'is-warning',
            );
          }
        }),
    );

    if (stored) {
      setting.addExtraButton((button) =>
        button
          .setIcon('trash')
          .setTooltip('Remove the stored key')
          .onClick(() => {
            this.host.keyFile.clear();
            this.display();
          }),
      );
    }
  }

  private status(parent: HTMLElement, message: string, cls: string): void {
    parent.querySelector('.recall-settings-status')?.remove();
    parent.createDiv({ cls: `recall-settings-status ${cls}`, text: message });
  }

  private renderModel(parent: HTMLElement): void {
    new Setting(parent).setName('Checking').setHeading();

    new Setting(parent)
      .setName('Model')
      .setDesc(
        'Recall judges whether an explanation written from memory is subtly wrong, which is ' +
          'where smaller models fail — and a confidently wrong correction is worse than none, ' +
          'because you calibrate against it. Change this to spend less, knowing that trade.',
      )
      .addDropdown((drop) => {
        for (const model of MODELS) drop.addOption(model.id, model.label);
        drop.setValue(this.host.settings.model).onChange(async (value) => {
          this.host.settings.model = value;
          await this.host.saveSettings();
        });
      });

    new Setting(parent)
      .setName('Effort')
      .setDesc(
        'How much thinking to spend on a check or a question. Lowering this is the first thing ' +
          'to reach for if they cost more than you want — it keeps the model that is good at this.',
      )
      .addDropdown((drop) => {
        drop.addOption('', 'Default');
        for (const effort of EFFORTS) drop.addOption(effort, effort[0]!.toUpperCase() + effort.slice(1));
        drop.setValue(this.host.settings.effort ?? '').onChange(async (value) => {
          this.host.settings.effort = value === '' ? null : (value as Effort);
          await this.host.saveSettings();
        });
      });
  }

  private renderDemo(parent: HTMLElement): void {
    new Setting(parent)
      .setName('Demo mode')
      .setDesc(
        'Record highlights and cards without calling the API. Nothing is assessed and nothing ' +
          'is spent, so cards carry placeholder text and no verdict.',
      )
      .addToggle((toggle) =>
        toggle.setValue(this.host.settings.demoMode).onChange(async (value) => {
          this.host.settings.demoMode = value;
          await this.host.saveSettings();
        }),
      );
  }
}
