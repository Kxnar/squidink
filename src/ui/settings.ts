import { App, Notice, PluginSettingTab, SecretComponent, Setting } from 'obsidian';
import type SquidPlugin from '../main';
import { messageFor } from '../errors';
import { PRICE_DATE, usedGBP } from '../recognition/budget';
import type { Model, Settings } from '../types';

export class SquidSettingsTab extends PluginSettingTab {
  constructor(app: App, private plugin: SquidPlugin) { super(app, plugin); }
  private save(): void { void this.plugin.persist().catch(error => new Notice(messageFor(error))); }
  display(): void {
    const { containerEl: el } = this;
    el.empty();
    const { settings, spend } = this.plugin.data;
    el.createEl('h2', { text: 'Squid' });
    el.createEl('p', { text: 'Manual handwriting transcription for Ink. Open a note in editing mode and run “Transcribe Ink section”.' });
    new Setting(el).setName('OpenAI API key').setDesc('Choose or create an Obsidian secret. Squid stores only its name in plugin settings.')
      .addComponent(container => new SecretComponent(this.app, container).setValue(settings.secretName)
        .onChange(value => { settings.secretName = value; this.save(); }));
    new Setting(el).setName('Default model').addDropdown(d => d
      .addOption('gpt-5.6-sol', 'GPT-5.6 Sol').addOption('gpt-5.6-luna', 'GPT-5.6 Luna')
      .setValue(settings.model).onChange(value => { settings.model = value as Model; this.save(); }));
    new Setting(el).setName('Cache recent results locally')
      .setDesc('Keeps up to 20 transcripts in plugin data. Images and API keys are never saved there. Cached text may be included in your vault backups or sync.')
      .addToggle(t => t.setValue(settings.cacheEnabled).onChange(value => { settings.cacheEnabled = value; if (!value) this.plugin.data.cache = {}; this.save(); }))
      .addButton(b => b.setButtonText('Clear cache').onClick(() => { this.plugin.data.cache = {}; this.save(); new Notice('Squid’s transcription cache was cleared.'); }));
    el.createEl('h3', { text: 'Evaluation budget' });
    el.createEl('p', { text: `Accounted usage and reserved allowances: £${usedGBP(this.plugin.data).toFixed(3)} / £${settings.budgetGBP.toFixed(2)}. Token price reference: ${PRICE_DATE}.` });
    el.createEl('p', { cls: 'squid-warning', text: 'This is a local spending guard, not a provider billing cap. Set your effective GBP/USD conversion including taxes and fees, account for funding charges, and reconcile unknown requests against OpenAI billing. No automatic retries.' });
    this.numberSetting('budgetGBP', 'Total allowance (£)', 'Starts at the agreed £10 evaluation budget.', 0.01);
    this.numberSetting('otherSpendGBP', 'Other evaluation spending (£)', 'Include activation fees, funding fees and evaluation costs outside this plugin. Do not double-count prepaid credit that pays for the API usage already recorded below.', 0);
    this.numberSetting('gbpPerUsd', 'GBP per billed US dollar', 'Planning default: 1.00. Set an effective rate from your billing including applicable tax/fees; this is not a live exchange rate.', 0.01);
    this.numberSetting('requestAllowanceGBP', 'Reserve per submitted request (£)', 'Unknown or cancelled requests retain this allowance until checked. Minimum: US $0.50 at your chosen conversion.', 0.01);
    el.createEl('p', { text: `Requests: ${spend.length} · Provider-reported input tokens: ${spend.reduce((n, e) => n + (e.usage?.inputTokens ?? 0), 0)} · Output tokens: ${spend.reduce((n, e) => n + (e.usage?.outputTokens ?? 0), 0)}` });
    for (const entry of spend.filter(e => e.state === 'unknown')) {
      let amount = '';
      new Setting(el).setName(`Unconfirmed charge · ${entry.startedAt.slice(0, 16).replace('T', ' ')}`)
        .setDesc(`${entry.model} · £${entry.reservedGBP.toFixed(2)} reserved. Enter the actual GBP charge only after checking provider billing.`)
        .addText(t => t.setPlaceholder('Actual £').onChange(value => { amount = value; }))
        .addButton(b => b.setButtonText('Record checked charge').onClick(() => {
          const value = Number(amount);
          if (!amount.trim() || !Number.isFinite(value) || value < 0) { new Notice('Enter a non-negative checked charge.'); return; }
          entry.estimatedGBP = value; entry.state = 'reconciled'; this.save(); this.display();
        }));
    }
    el.createEl('h3', { text: 'Privacy and compatibility' });
    el.createEl('p', { text: 'Desktop beta; Windows first. Requires Obsidian 1.11.4+. Uses saved Ink SVG artwork and public vault/editor APIs. Only the reviewed crop goes to OpenAI with store:false. Standard provider retention may still apply. Squid never edits Ink SVG metadata.' });
  }
  private numberSetting(key: 'budgetGBP' | 'otherSpendGBP' | 'gbpPerUsd' | 'requestAllowanceGBP', name: string, description: string, min: number): void {
    const settings: Settings = this.plugin.data.settings;
    new Setting(this.containerEl).setName(name).setDesc(description).addText(t => {
      t.setValue(String(settings[key]));
      t.inputEl.type = 'number'; t.inputEl.min = String(min); t.inputEl.step = '0.01';
      t.inputEl.addEventListener('change', () => {
        const value = Number(t.getValue());
        if (!t.getValue().trim() || !Number.isFinite(value) || value < min) { new Notice('Enter a valid budget value.'); t.setValue(String(settings[key])); return; }
        settings[key] = value; this.save();
      });
    });
  }
}
