import { Editor, MarkdownView, Modal, Notice, Plugin, TFile } from 'obsidian';
import { SquidError, messageFor } from './errors';
import { hash } from './hash';
import { embedIdentity, hasLegacyEmbeds, parseEmbeds } from './ink/embeds';
import { anchorChange, applyChange, findPair, locatePair, pairForEmbed, rekeyChange, sourceIdFor, transcriptChange,
  type Change, type LocatedPair, type NoteSnapshot } from './notes/pairs';
import { OpenAIProvider } from './recognition/openai';
import { PROMPT_VERSION } from './recognition/prompt';
import { RecognitionService } from './recognition/service';
import { openAITransport } from './recognition/transport';
import { freshData, type InkEmbed, type Model, type PluginData, type PreparedImage, type Recognition } from './types';
import { PrepareModal, ProgressModal, ReviewModal, SectionPicker } from './ui/modals';
import { SquidSettingsTab } from './ui/settings';

interface Session {
  id: string;
  identity: string;
  sourceRevision: string;
  attachmentPath: string;
  originPath: string;
  invalidReason?: string;
  modal?: Modal;
  reviewedBody?: string;
  manuallyEdited: boolean;
}

export default class SquidPlugin extends Plugin {
  data: PluginData = freshData();
  service!: RecognitionService;
  private session?: Session;
  private stopped = false;
  private opening = false;
  private revision = 0;
  private saving: Promise<void> = Promise.resolve();
  private statusEl!: HTMLElement;
  private statusTimer?: ReturnType<typeof setTimeout>;
  private statusVersion = 0;

  async onload(): Promise<void> {
    if (!this.app.secretStorage) {
      new Notice('Squid requires Obsidian 1.11.4 or later for SecretStorage.'); return;
    }
    const saved = await this.loadData() as PluginData | null;
    if (saved) {
      if (saved.version !== 1 || !saved.settings || !saved.pairs || !saved.cache || !Array.isArray(saved.spend)) {
        new Notice('Squid’s saved data is unsupported. Restore a valid data.json before transcribing.'); return;
      }
      this.data = saved;
      // A crash/disable can leave an already submitted request without usage.
      for (const entry of this.data.spend) if (entry.state === 'pending') entry.state = 'unknown';
    }
    this.service = new RecognitionService(this.data, new OpenAIProvider(openAITransport), () => this.persist());
    this.addSettingTab(new SquidSettingsTab(this.app, this));
    this.addCommand({ id: 'transcribe-ink-section', name: 'Transcribe Ink section', callback: () => void this.chooseSection(false) });
    this.addCommand({ id: 'rekey-ink-pair', name: 'Give copied Ink pair a new ID', callback: () => void this.chooseSection(true) });
    this.addCommand({ id: 'check-transcripts', name: 'Check Ink transcript status', callback: () => void this.showStatus() });
    this.addCommand({ id: 'cancel-transcription', name: 'Cancel transcription', callback: () => {
      if (!this.session) { new Notice('No Squid transcription is active.'); return; }
      const session = this.session; this.cancelSession(session); session.modal?.close();
      new Notice('Transcription cancelled. A submitted API request may still be charged.');
    } });
    this.statusEl = this.addStatusBarItem();
    this.statusEl.setText('Squid'); this.statusEl.addClass('squid-status-bar');
    this.registerDomEvent(this.statusEl, 'click', () => void this.showStatus());
    this.registerEvent(this.app.workspace.on('editor-change', (editor, info) => {
      this.revision++;
      const session = this.session;
      if (session && info.file?.path === session.originPath) {
        try {
          const pair = findPair(editor.getValue(), session.id);
          if (!pair || embedIdentity(pair.source) !== session.identity) this.invalidate(session, 'The source embed changed or moved during transcription. Start again from its new location.');
        } catch { this.invalidate(session, 'The source pairing became ambiguous during transcription.'); }
      }
      this.scheduleStatus();
    }));
    const fileChanged = (file: { path: string }, oldPath?: string) => {
      this.revision++;
      if (this.session && (file.path === this.session.attachmentPath || oldPath === this.session.attachmentPath)) {
        this.invalidate(this.session, 'The handwriting changed, moved or was deleted. Start again so the preview matches the source.');
      }
      this.scheduleStatus();
    };
    this.registerEvent(this.app.vault.on('modify', fileChanged));
    this.registerEvent(this.app.vault.on('delete', fileChanged));
    this.registerEvent(this.app.vault.on('create', fileChanged));
    this.registerEvent(this.app.vault.on('rename', fileChanged));
    this.registerEvent(this.app.workspace.on('active-leaf-change', () => this.scheduleStatus()));
    this.scheduleStatus();
  }

  async persist(): Promise<void> {
    const snapshot: PluginData = JSON.parse(JSON.stringify(this.data)) as PluginData;
    this.saving = this.saving.catch(() => undefined).then(() => this.saveData(snapshot));
    try { await this.saving; }
    catch { throw new SquidError('Squid could not save its usage or comparison data. Resolve the vault storage problem before continuing.', 'storage'); }
  }

  private currentView(): MarkdownView {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view?.file || view.getMode() !== 'source') throw new SquidError('Open a Markdown note in editing mode, then run the command.');
    return view;
  }

  private async chooseSection(rekey: boolean): Promise<void> {
    try {
      if (this.stopped) return;
      if (this.session || this.opening || this.service.busy) throw new SquidError('Finish or discard the current Squid review first.');
      const view = this.currentView();
      const note = view.editor.getValue();
      const embeds = parseEmbeds(note);
      if (!embeds.length) throw new SquidError(hasLegacyEmbeds(note)
        ? 'This note uses legacy Ink code blocks. Open Ink settings → migration options and convert them to SVG embeds first.'
        : 'No supported Ink sections found. Squid expects a standalone InkWriting or InkDrawing SVG embed line.');
      const cursor = view.editor.getCursor().line;
      const atCursor = embeds.find(embed => embed.line === cursor || sourceIdFor(note, embed) && embed.line === cursor + 1);
      const pick = (embed: InkEmbed) => { void this.startFrom(view, embed, rekey); };
      if (atCursor) pick(atCursor); else new SectionPicker(this.app, embeds, pick).open();
    } catch (error) { new Notice(messageFor(error)); }
  }

  private transaction(editor: Editor, change: Change): void {
    editor.transaction({ changes: [{ from: editor.offsetToPos(change.from), to: editor.offsetToPos(change.to), text: change.text }] }, 'squid');
  }

  private async startFrom(view: MarkdownView, selected: InkEmbed, rekey: boolean): Promise<void> {
    if (this.opening || this.session || this.stopped) return;
    this.opening = true;
    let started: Session | undefined;
    try {
      if (!view.file || view.getMode() !== 'source') throw new SquidError('Open the source note in editing mode again.');
      let note = view.editor.getValue();
      if (note.slice(selected.start, selected.end) !== selected.raw) throw new SquidError('The note changed while the picker was open. Select the section again.');
      if (selected.error) throw new SquidError(selected.error);
      let id = sourceIdFor(note, selected);
      if (rekey) {
        if (!id) throw new SquidError('This embed does not have a Squid pair ID yet. Transcribe it first.');
        const pair = pairForEmbed(note, selected);
        this.transaction(view.editor, rekeyChange(note, pair, crypto.randomUUID()));
        new Notice('The copied pair now has its own ID. Its existing transcript will be treated as manually edited.');
        return;
      }
      if (!id) {
        id = crypto.randomUUID();
        this.transaction(view.editor, anchorChange(note, selected, id));
        note = view.editor.getValue();
      }
      const found = locatePair(await this.notes(), id);
      const pair = found.pair;
      if (this.stopped) return;
      const file = this.resolve(pair.source, found.note.path);
      const raw = await this.app.vault.read(file);
      const sourceRevision = await this.sourceRevision(raw, pair.source);
      if (this.stopped) return;
      started = { id, identity: embedIdentity(pair.source), sourceRevision, attachmentPath: file.path,
        originPath: found.note.path, manuallyEdited: false };
      this.session = started;
      const session = started;
      await this.validate(session);
      session.modal = new PrepareModal(this.app, raw, pair.source.viewport, this.data.settings.model,
        (image, model) => void this.recognize(session, image, model), () => this.cancelSession(session), async image => {
          await this.validate(session);
          const folder = 'Squid evaluation';
          if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
          const path = `${folder}/${crypto.randomUUID()}.png`;
          const bytes = Uint8Array.from(atob(image.dataUrl.split(',')[1]!), c => c.charCodeAt(0));
          this.assertSession(session);
          await this.app.vault.createBinary(path, bytes.buffer);
          return path;
        });
      session.modal.open();
    } catch (error) { if (started) this.cancelSession(started); new Notice(messageFor(error)); }
    finally { this.opening = false; }
  }

  private resolve(embed: InkEmbed, path: string): TFile {
    if (embed.error) throw new SquidError(embed.error);
    const file = this.app.metadataCache.getFirstLinkpathDest(embed.link, path);
    if (!(file instanceof TFile) || file.extension.toLowerCase() !== 'svg') throw new SquidError('The Ink attachment link is broken or no longer points to an SVG.');
    return file;
  }

  private sourceRevision(raw: string, embed: InkEmbed): Promise<string> {
    // Link spelling may change on rename; the artwork and viewport define the source revision.
    return hash(JSON.stringify([raw, embed.kind, embed.viewport ?? null]));
  }

  private async notes(): Promise<NoteSnapshot[]> {
    const open = new Map<string, string>();
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file && view.getMode() === 'source') {
        const value = view.editor.getValue();
        if (open.has(view.file.path) && open.get(view.file.path) !== value) throw new SquidError('Two open editors disagree about the same note. Save or close the duplicate view before continuing.');
        open.set(view.file.path, value);
      }
    }
    const notes: NoteSnapshot[] = [];
    const files = this.app.vault.getMarkdownFiles();
    for (let i = 0; i < files.length; i += 16) {
      notes.push(...await Promise.all(files.slice(i, i + 16).map(async file => ({
        path: file.path, text: open.get(file.path) ?? await this.app.vault.cachedRead(file),
      }))));
    }
    return notes;
  }

  private assertSession(session: Session): void {
    if (this.stopped || this.session !== session) throw new SquidError('This transcription was cancelled or Squid was disabled.');
    if (session.invalidReason) throw new SquidError(session.invalidReason, 'stale');
  }

  private invalidate(session: Session, reason: string): void {
    if (session.invalidReason) return;
    session.invalidReason = reason; this.service.cancel();
    new Notice(reason);
  }

  private cancelSession(session: Session): void {
    if (this.session !== session) return;
    session.invalidReason ??= 'This transcription was cancelled.';
    this.service.cancel(); this.session = undefined;
  }

  private async validate(session: Session): Promise<LocatedPair> {
    this.assertSession(session);
    const revision = this.revision;
    const found = locatePair(await this.notes(), session.id);
    if (embedIdentity(found.pair.source) !== session.identity) throw new SquidError('The source embed changed. Start transcription again.', 'stale');
    const file = this.resolve(found.pair.source, found.note.path);
    const raw = await this.app.vault.read(file);
    if (file.path !== session.attachmentPath || await this.sourceRevision(raw, found.pair.source) !== session.sourceRevision) {
      throw new SquidError('The saved handwriting changed. Start again with an updated preview.', 'stale');
    }
    this.assertSession(session);
    if (revision !== this.revision) throw new SquidError('A note changed while Squid checked the destination. Try the action again.');
    return found;
  }

  private async recognize(session: Session, image: PreparedImage, model: Model): Promise<void> {
    const progress = new ProgressModal(this.app, () => this.cancelSession(session));
    session.modal = progress;
    try {
      await this.validate(session);
      progress.open();
      const key = this.data.settings.secretName ? this.app.secretStorage.getSecret(this.data.settings.secretName) ?? '' : '';
      const { result, cached } = await this.service.run(image, model, key);
      const found = await this.validate(session);
      session.reviewedBody = found.pair.body;
      const record = this.data.pairs[session.id];
      session.manuallyEdited = found.pair.body !== undefined && (!record || await hash(found.pair.body) !== record.appliedHash);
      this.assertSession(session);
      progress.finish();
      session.modal = new ReviewModal(this.app, image, result, cached, session.reviewedBody, session.manuallyEdited,
        (text, explicit) => this.applyReviewed(session, image, model, result, text, explicit), () => this.cancelSession(session));
      session.modal.open();
    } catch (error) {
      progress.finish(); this.cancelSession(session); new Notice(messageFor(error));
    }
  }

  private async editorFor(path: string): Promise<Editor> {
    const active = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (active?.file?.path === path && active.getMode() === 'source') return active.editor;
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file?.path === path && view.getMode() === 'source') {
        this.app.workspace.setActiveLeaf(leaf, { focus: true });
        return view.editor;
      }
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new SquidError('The destination note no longer exists.');
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.openFile(file, { state: { mode: 'source' } });
    if (!(leaf.view instanceof MarkdownView) || leaf.view.getMode() !== 'source') throw new SquidError('Open the destination note in editing mode and try again.');
    return leaf.view.editor;
  }

  private async applyReviewed(session: Session, image: PreparedImage, model: Model, result: Recognition,
    text: string, explicitReplace: boolean): Promise<void> {
    const first = await this.validate(session);
    const editor = await this.editorFor(first.note.path);
    const generatedHash = await hash(result.markdown);
    const second = await this.validate(session);
    const revision = this.revision;
    if (second.note.path !== first.note.path) throw new SquidError('The pair moved while review was applying. Try again.');
    const before = editor.getValue();
    if (before !== second.note.text) throw new SquidError('The destination note changed. Try applying again.');
    const change = transcriptChange(before, session.id, session.reviewedBody, text, session.manuallyEdited, explicitReplace);
    const appliedBody = findPair(applyChange(before, change), session.id)?.body;
    if (appliedBody === undefined) throw new SquidError('The reviewed Markdown would break the source pairing. Check its syntax.');
    const appliedHash = await hash(appliedBody);
    // Final synchronous checks directly precede the single Undo-able editor transaction.
    this.assertSession(session);
    if (revision !== this.revision) throw new SquidError('A note changed during the final checks. Try applying again.');
    if (editor.getValue() !== before) throw new SquidError('The note changed during insertion checks. Try again.');
    this.transaction(editor, change);
    this.data.pairs[session.id] = { sourceRevision: session.sourceRevision, generatedHash, appliedHash,
      model, promptVersion: PROMPT_VERSION, viewport: image.viewport, appliedAt: new Date().toISOString() };
    this.session = undefined;
    try { await this.persist(); }
    catch { new Notice('The transcript was inserted, but its comparison metadata could not be saved. Future replacement will require checking your edits.'); }
    new Notice('Reviewed transcript inserted. Use Undo to revert the note change.');
    this.scheduleStatus();
  }

  private async statuses(view: MarkdownView): Promise<string[]> {
    if (!view.file) return [];
    const note = view.getMode() === 'source' ? view.editor.getValue() : await this.app.vault.cachedRead(view.file);
    const statuses: string[] = [];
    for (const embed of parseEmbeds(note)) {
      const label = `Line ${embed.line + 1}`;
      try {
        if (embed.error) throw new SquidError(embed.error);
        const id = sourceIdFor(note, embed);
        if (!id) { statuses.push(`${label}: not transcribed`); continue; }
        const pair = findPair(note, id);
        if (!pair?.body) { statuses.push(`${label}: no transcript`); continue; }
        const record = this.data.pairs[id];
        if (!record) { statuses.push(`${label}: comparison unavailable — existing text is protected`); continue; }
        const file = this.resolve(embed, view.file.path);
        const raw = await this.app.vault.cachedRead(file);
        const outdated = await this.sourceRevision(raw, embed) !== record.sourceRevision;
        const edited = await hash(pair.body) !== record.appliedHash;
        statuses.push(`${label}: ${outdated ? 'outdated handwriting' : 'source unchanged'}${edited ? ' · manually edited transcript' : ''}`);
      } catch (error) { statuses.push(`${label}: unresolved · ${messageFor(error)}`); }
    }
    return statuses;
  }

  private scheduleStatus(): void {
    clearTimeout(this.statusTimer);
    const version = ++this.statusVersion;
    this.statusTimer = setTimeout(() => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view || this.stopped) return;
      void this.statuses(view).then(statuses => {
        if (this.stopped || version !== this.statusVersion) return;
        const outdated = statuses.filter(s => s.includes('outdated handwriting')).length;
        this.statusEl.setText(outdated ? `Squid · ${outdated} outdated` : 'Squid');
        this.statusEl.setAttribute('aria-label', 'Check Ink transcript status');
      }).catch(() => { if (!this.stopped) this.statusEl.setText('Squid · check status'); });
    }, 700);
  }

  private async showStatus(): Promise<void> {
    try {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) throw new SquidError('Open a Markdown note first.');
      const statuses = await this.statuses(view);
      const notes = await this.notes();
      if (view.file) {
        const note = notes.find(n => n.path === view.file!.path)?.text ?? '';
        for (const embed of parseEmbeds(note)) {
          const id = sourceIdFor(note, embed);
          if (id) try { locatePair(notes, id); } catch (error) { statuses.push(messageFor(error)); }
        }
      }
      const modal = new Modal(this.app); modal.titleEl.setText('Ink transcript status');
      const list = modal.contentEl.createEl('ul');
      (statuses.length ? [...new Set(statuses)] : ['No Ink sections in this note.']).forEach(text => list.createEl('li', { text }));
      modal.contentEl.createEl('p', { text: 'To refresh an outdated transcript, run “Transcribe Ink section” on its source. Replacement always goes through review.' });
      modal.open();
    } catch (error) { new Notice(messageFor(error)); }
  }

  onunload(): void {
    this.stopped = true; clearTimeout(this.statusTimer); this.statusVersion++;
    const session = this.session;
    if (session) { this.cancelSession(session); session.modal?.close(); }
    this.service?.dispose();
  }
}
