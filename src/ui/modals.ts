import { App, ButtonComponent, FuzzySuggestModal, Modal, Setting } from 'obsidian';
import { messageFor } from '../errors';
import { cleanSvg, cropWithin, needsCrop, rasterize } from '../ink/svg';
import type { InkEmbed, Model, PreparedImage, Recognition, Rect } from '../types';
import { renderMathPreview } from './math-preview';

export class SectionPicker extends FuzzySuggestModal<InkEmbed> {
  constructor(app: App, private embeds: InkEmbed[], private pick: (embed: InkEmbed) => void) {
    super(app); this.setPlaceholder('Choose an Ink section in this note');
  }
  getItems(): InkEmbed[] { return this.embeds; }
  getItemText(item: InkEmbed): string {
    return `${item.kind === 'inkWriting' ? 'Writing' : 'Drawing'} · line ${item.line + 1} · ${item.link}${item.viewport ? ` · (${item.viewport.x}, ${item.viewport.y}) ${item.viewport.width}×${item.viewport.height}` : ''}`;
  }
  onChooseItem(item: InkEmbed): void { this.pick(item); }
}

export class PrepareModal extends Modal {
  private closed = false;
  private sent = false;
  private version = 0;
  private image?: PreparedImage;
  private model: Model;
  private crop: Rect;
  private frame: Rect;
  private imageEl!: HTMLImageElement;
  private statusEl!: HTMLElement;
  private submitButton!: ButtonComponent;
  private cropInputs: HTMLInputElement[] = [];
  constructor(app: App, private rawSvg: string, viewport: Rect | undefined, model: Model,
    private submit: (image: PreparedImage, model: Model) => void, private cancel: () => void,
    private exportImage: (image: PreparedImage) => Promise<string>) {
    super(app); this.model = model;
    this.frame = cleanSvg(rawSvg, viewport).viewport;
    this.crop = { ...this.frame };
  }
  onOpen(): void {
    this.modalEl.addClass('squid-modal');
    this.titleEl.setText('Choose the handwriting to transcribe');
    const content = this.contentEl;
    content.createEl('p', { text: 'Review the exact image before sending it to OpenAI. Only this image and Squid’s fixed transcription instructions are sent.' });
    const imgWrap = content.createDiv({ cls: 'squid-source' });
    this.imageEl = imgWrap.createEl('img', { attr: { alt: 'Prepared Ink section for recognition', draggable: 'false' } });
    this.statusEl = content.createDiv({ cls: 'squid-status', attr: { role: 'status', 'aria-live': 'polite' } });
    const controls = content.createDiv({ cls: 'squid-crop-controls' });
    controls.createEl('p', { text: 'Crop within this embed (percentages). Leave padding around superscripts and fraction bars.' });
    for (const [name, prop] of [['Left', 'x'], ['Top', 'y'], ['Width', 'width'], ['Height', 'height']] as const) {
      const label = controls.createEl('label', { text: `${name} %` });
      const input = label.createEl('input', { type: 'number', attr: { min: '0', max: '100', step: '0.1' } });
      this.cropInputs.push(input);
      input.value = prop === 'width' || prop === 'height' ? '100' : '0';
      input.addEventListener('input', () => { this.image = undefined; this.submitButton.setDisabled(true); this.version++; });
    }
    new Setting(content).addButton(b => b.setButtonText('Update crop preview').onClick(() => void this.updateCrop()))
      .addButton(b => b.setButtonText('Reset crop').onClick(() => {
        this.cropInputs.forEach((input, i) => { input.value = i < 2 ? '0' : '100'; });
        void this.updateCrop();
      }));
    new Setting(content).setName('Keep an evaluation image').setDesc('Save this exact prepared PNG inside your vault for the handwriting benchmark.')
      .addButton(b => b.setButtonText('Save prepared PNG').onClick(async () => {
        if (!this.image || this.closed) { this.statusEl.setText('Prepare a valid crop before exporting it.'); return; }
        b.setDisabled(true);
        try { const path = await this.exportImage(this.image); if (!this.closed) this.statusEl.setText(`Saved ${path}`); }
        catch (error) { if (!this.closed) this.statusEl.setText(messageFor(error)); }
        finally { b.setDisabled(false); }
      }));
    new Setting(content).setName('Recognition model').addDropdown(d => d
      .addOption('gpt-5.6-sol', 'GPT-5.6 Sol').addOption('gpt-5.6-luna', 'GPT-5.6 Luna')
      .setValue(this.model).onChange(value => { this.model = value as Model; }));
    const clean = cleanSvg(this.rawSvg, this.frame);
    if (clean.legacy) content.createEl('p', { cls: 'squid-warning', text: 'Older tldraw SVG: inspect the framing carefully. Unlabelled guides are retained to protect handwritten lines.' });
    content.createEl('p', { cls: 'squid-muted', text: 'You will review and edit the result before inserting it. A submitted request can incur API charges even if cancelled.' });
    new Setting(content).addButton(b => {
      this.submitButton = b;
      b.setButtonText('Send image to OpenAI').setCta().setDisabled(true).onClick(() => {
        if (!this.image || this.closed) return;
        this.sent = true; const image = this.image; this.close(); this.submit(image, this.model);
      });
    }).addButton(b => b.setButtonText('Cancel').onClick(() => this.close()));
    void this.updateCrop();
  }
  private async updateCrop(): Promise<void> {
    const version = ++this.version;
    this.image = undefined; this.submitButton.setDisabled(true);
    this.statusEl.setText('Preparing image…');
    try {
      const [x, y, w, h] = this.cropInputs.map(input => Number(input.value)) as [number, number, number, number];
      this.crop = cropWithin(this.frame, { x: this.frame.x + x * this.frame.width / 100,
        y: this.frame.y + y * this.frame.height / 100, width: w * this.frame.width / 100, height: h * this.frame.height / 100 });
      const oversized = needsCrop(this.crop);
      const image = await rasterize(cleanSvg(this.rawSvg, this.crop), oversized);
      if (version !== this.version || this.closed) return;
      this.imageEl.src = image.dataUrl;
      this.statusEl.setText(oversized
        ? 'Overview only — this section is too large to send at readable resolution. Choose a smaller crop and update the preview.'
        : `Exact recognition image · ${image.width} × ${image.height} pixels · white background · known Ink guides removed`);
      this.image = oversized ? undefined : image;
      this.submitButton.setDisabled(oversized);
    } catch (error) { if (version === this.version && !this.closed) this.statusEl.setText(messageFor(error)); }
  }
  onClose(): void { this.closed = true; this.version++; this.contentEl.empty(); if (!this.sent) this.cancel(); }
}

export class ProgressModal extends Modal {
  private completed = false;
  constructor(app: App, private cancel: () => void) { super(app); }
  onOpen(): void {
    this.titleEl.setText('Transcribing your Ink section');
    this.contentEl.createEl('p', { text: 'Waiting for OpenAI. You can keep editing other notes. Changes to this handwriting invalidate the result.' });
    this.contentEl.createEl('p', { text: 'Cancelling discards the result. A submitted request may still incur charges.' });
    new Setting(this.contentEl).addButton(b => b.setButtonText('Cancel transcription').onClick(() => this.close()));
  }
  finish(): void { this.completed = true; this.close(); }
  onClose(): void { if (!this.completed) this.cancel(); this.contentEl.empty(); }
}

export class ReviewModal extends Modal {
  private closed = false;
  private applied = false;
  private explicitReplace = false;
  private draft: string;
  private renderVersion = 0;
  private renderTimer?: ReturnType<typeof setTimeout>;
  private renderQueue: Promise<void> = Promise.resolve();
  private statusEl!: HTMLElement;
  constructor(app: App, private image: PreparedImage, private result: Recognition, private cached: boolean,
    private previousBody: string | undefined, private manuallyEdited: boolean,
    private apply: (text: string, explicitReplace: boolean) => Promise<void>, private cancel: () => void) {
    super(app); this.draft = result.markdown;
  }
  onOpen(): void {
    this.modalEl.addClass('squid-modal', 'squid-review');
    this.titleEl.setText('Review the transcription');
    const layout = this.contentEl.createDiv({ cls: 'squid-review-grid' });
    const source = layout.createDiv({ cls: 'squid-source' });
    source.createEl('h3', { text: 'Handwriting sent for recognition' });
    source.createEl('img', { attr: { src: this.image.dataUrl, alt: 'Exact source image submitted for this transcription' } });
    const edit = layout.createDiv();
    const label = edit.createEl('label', { text: 'Editable Markdown and LaTeX' });
    const textarea = label.createEl('textarea', { cls: 'squid-editor', attr: { spellcheck: 'false' } });
    textarea.value = this.draft;
    edit.createEl('h3', { text: 'Maths preview' });
    const preview = edit.createDiv({ cls: 'squid-math-preview' });
    const warnings = edit.createDiv({ cls: 'squid-warning', attr: { 'aria-live': 'polite' } });
    const refresh = () => {
      const version = ++this.renderVersion;
      const draft = this.draft;
      this.renderQueue = this.renderQueue.then(async () => {
        if (this.closed || version !== this.renderVersion) return;
        const messages = await renderMathPreview(draft, preview);
        if (!this.closed && version === this.renderVersion) warnings.setText(messages.join(' '));
      }).catch(() => { if (!this.closed) warnings.setText('The maths preview could not be rendered. Check the LaTeX before inserting.'); });
    };
    textarea.addEventListener('input', () => {
      this.draft = textarea.value; clearTimeout(this.renderTimer); this.renderTimer = setTimeout(refresh, 250);
    });
    refresh();
    this.contentEl.createEl('p', { cls: 'squid-muted', text: 'Rendering checks syntax only. Compare every symbol and line with the handwriting, including any mathematical mistakes.' });
    if (this.result.unresolved.length) {
      this.contentEl.createEl('h3', { text: 'Needs your attention' });
      const list = this.contentEl.createEl('ul');
      this.result.unresolved.forEach(text => list.createEl('li', { text }));
    }
    const usage = this.result.usage;
    this.contentEl.createEl('p', { cls: 'squid-muted', text: this.cached ? 'Reused a local cached result. No new API request.'
      : `${(this.result.latencyMs / 1000).toFixed(1)} seconds · ${usage ? `${usage.inputTokens} input / ${usage.outputTokens} output tokens reported` : 'Usage unavailable; request allowance retained'}` });
    if (this.previousBody !== undefined) {
      const details = this.contentEl.createEl('details');
      details.createEl('summary', { text: 'Current transcript — compare before replacing' });
      details.createEl('pre', { text: this.previousBody, cls: 'squid-previous' });
    }
    if (this.manuallyEdited) new Setting(this.contentEl)
      .setName('Replace my edited transcript')
      .setDesc('Your existing transcript contains manual changes or has no saved comparison. Enable this only after comparing both versions.')
      .addToggle(t => t.setValue(false).onChange(value => { this.explicitReplace = value; }));
    this.statusEl = this.contentEl.createDiv({ cls: 'squid-status', attr: { role: 'status', 'aria-live': 'polite' } });
    new Setting(this.contentEl).addButton(b => b
      .setButtonText(this.previousBody === undefined ? 'Insert below Ink section' : 'Replace with reviewed transcript')
      .setCta().onClick(async () => {
        b.setDisabled(true);
        try {
          await this.apply(this.draft, this.explicitReplace);
          if (!this.closed) { this.applied = true; this.close(); }
        } catch (error) { if (!this.closed) { this.statusEl.setText(messageFor(error)); b.setDisabled(false); } }
      })).addButton(b => b.setButtonText('Discard').onClick(() => this.close()));
  }
  onClose(): void {
    this.closed = true; this.renderVersion++; clearTimeout(this.renderTimer);
    this.contentEl.empty(); if (!this.applied) this.cancel();
  }
}
