import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { drawingEmbed, writingEmbed } from './fixtures.mjs';

const root = process.cwd();
const profile = path.join(root, '.qa-profile');
const vault = path.join(root, '.qa-vault');
const artifacts = path.join(root, '.qa-artifacts');
await mkdir(profile, { recursive: true });
await mkdir(artifacts, { recursive: true });
await writeFile(path.join(profile, 'obsidian.json'), JSON.stringify({
  vaults: { '1234567890abcdef': { path: vault, ts: Date.now(), open: true } },
}));

const probe = createServer();
await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const child = spawn(process.env.OBSIDIAN_EXE ?? 'C:\\Program Files\\Obsidian\\Obsidian.exe',
  [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--no-sandbox'], { windowsHide: true, stdio: 'ignore' });
let browser;
let page;
try {
  const deadline = Date.now() + 30_000;
  while (!browser && Date.now() < deadline) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); }
    catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (!browser) throw new Error('Could not connect to the isolated Obsidian test instance.');
  const context = browser.contexts()[0];
  page = context.pages()[0] ?? await context.waitForEvent('page');
  page.setDefaultTimeout(15_000);
  await page.setViewportSize({ width: 1360, height: 1050 });
  page.on('pageerror', error => console.log('QA page error:', error.message));
  page.on('console', message => { if (message.type() === 'error') console.log('QA console error:', message.text()); });
  await page.waitForFunction(() => !!window.app?.vault && window.app.workspace?.layoutReady, null, { timeout: 30_000 });
  const actualVault = await page.evaluate(() => window.app.vault.adapter.basePath);
  if (path.resolve(actualVault).toLowerCase() !== vault.toLowerCase()) throw new Error('Refusing to test outside the disposable vault.');
  const trust = page.getByRole('button', { name: 'Trust author and enable plugins', exact: true });
  if (await trust.isVisible()) await trust.click();
  await page.evaluate(async () => {
    await window.app.plugins.setEnable(true);
    await window.app.plugins.loadManifests();
    await window.app.plugins.enablePluginAndSave('squid');
    const plugin = window.app.plugins.getPlugin('squid');
    if (!plugin?.service) throw new Error('Squid did not load in the test vault.');
    window.__squidTest = { calls: 0, delay: 60 };
    window.app.secretStorage.setSecret('squid-test', 'synthetic-test-key-never-sent');
    plugin.data.settings.secretName = 'squid-test';
    plugin.data.cache = {}; plugin.data.pairs = {}; plugin.data.spend = [];
    plugin.service.provider = { transcribe: async (_image, _model, _key, signal, report) => {
      window.__squidTest.calls++;
      await new Promise(resolve => setTimeout(resolve, window.__squidTest.delay));
      const usage = { inputTokens: 30, cachedInputTokens: 0, outputTokens: 20 };
      await report(usage);
      if (signal.aborted) throw new Error('Mock request cancelled');
      return { markdown: '$$\\frac{x^2}{2} = x$$\n\n$$1+1=3$$',
        unresolved: ['Synthetic provider response for integration testing; no live OCR was used.'], usage, latencyMs: 60 };
    } };
  });
  let example = 0;
  const runId = Date.now();
  async function openNote(text) {
    const notePath = `QA ${runId} case ${++example}.md`;
    await page.evaluate(async ({ text, notePath }) => {
      const app = window.app;
      await app.vault.create(notePath, text);
      const leaf = app.workspace.getLeaf(false);
      await leaf.openFile(app.vault.getAbstractFileByPath(notePath), { state: { mode: 'source' } });
      window.__squidTest.view = leaf.view;
    }, { text, notePath });
  }
  async function commandAtFirst() {
    await page.evaluate(() => {
      const view = window.__squidTest.view;
      const line = view.editor.getValue().split('\n').findIndex(text => text.includes('![Ink'));
      view.editor.setCursor({ line, ch: 1 });
      window.app.commands.executeCommandById('squid:transcribe-ink-section');
    });
    await page.getByText('Choose the handwriting to transcribe', { exact: true }).waitFor();
  }
  const original = '# Automated smoke test\n\n' + drawingEmbed(0) + '\n\nUnrelated text must survive.\n';
  await openNote(original);
  await commandAtFirst();
  await page.getByText(/Exact recognition image ·/).waitFor();
  const input = await page.locator('.squid-source img').getAttribute('src');
  assert.ok(input.startsWith('data:image/png;base64,'));
  await page.screenshot({ path: path.join(artifacts, '01-prepared.png') });
  await page.getByRole('button', { name: 'Send image to OpenAI', exact: true }).click();
  await page.getByText('Review the transcription', { exact: true }).waitFor();
  assert.equal(await page.locator('.squid-source img').getAttribute('src'), input);
  await page.locator('.squid-editor').fill('Reviewed synthetic fixture.\n\n$$\\frac{x^2}{2}=x$$\n\n$$1+1=3$$');
  await page.locator('.squid-math-preview').getByText('Reviewed synthetic fixture.', { exact: true }).waitFor();
  await page.locator('.squid-math-preview mjx-container').first().waitFor();
  await page.screenshot({ path: path.join(artifacts, '02-review.png') });
  await page.getByRole('button', { name: 'Insert below Ink section', exact: true }).click();
  await page.locator('.squid-review').waitFor({ state: 'hidden' });
  const applied = await page.evaluate(() => window.__squidTest.view.editor.getValue());
  assert.match(applied, /Reviewed synthetic fixture/); assert.match(applied, /1\+1=3/); assert.match(applied, /Unrelated text must survive/);
  await page.screenshot({ path: path.join(artifacts, '03-inserted.png') });
  await page.evaluate(() => {
    const editor = window.__squidTest.view.editor;
    const before = editor.getValue();
    editor.undo();
    // Obsidian's Windows file watcher can record an identical-content reload as an
    // extra "set" history entry. Skip that host-generated no-op, not any user edit.
    if (editor.getValue() === before) editor.undo();
  });
  await page.waitForFunction(() => !window.__squidTest.view.editor.getValue().includes('squid:transcript'), null, { timeout: 3000 });
  const undone = await page.evaluate(() => window.__squidTest.view.editor.getValue());
  assert.ok(!undone.includes('squid:transcript')); assert.match(undone, /Unrelated text must survive/);
  console.log('PASS actual Obsidian: prepare, exact-image review, insertion, original preservation, Undo.');

  // Input errors are checked before any provider call.
  await openNote('# Empty\n\n' + writingEmbed('Empty.svg'));
  await commandAtFirst();
  await page.getByText(/This crop appears empty/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send image to OpenAI', exact: true }).isEnabled(), false);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await openNote('# Oversized\n\n' + writingEmbed('Tall.svg'));
  await commandAtFirst();
  await page.getByText(/Overview only/).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Send image to OpenAI', exact: true }).isEnabled(), false);
  await page.getByLabel('Height %', { exact: true }).fill('4');
  await page.getByRole('button', { name: 'Update crop preview', exact: true }).click();
  await page.getByText(/Exact recognition image ·/).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.evaluate(() => window.__squidTest.calls), 1);
  console.log('PASS actual Obsidian: empty-input rejection and oversized crop gating without network calls.');

  await openNote('# Second viewport\n\n' + drawingEmbed(500));
  await commandAtFirst();
  await page.getByText(/Exact recognition image ·/).waitFor();
  const secondImage = await page.locator('.squid-source img').getAttribute('src');
  assert.notEqual(secondImage, input);
  await page.screenshot({ path: path.join(artifacts, '04-second-viewport.png') });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  console.log('PASS actual Obsidian: two viewports over the same saved SVG yield distinct inputs.');

  async function sendAndReview() {
    await commandAtFirst();
    await page.getByText(/Exact recognition image ·/).waitFor();
    await page.getByRole('button', { name: 'Send image to OpenAI', exact: true }).click();
    await page.getByText('Review the transcription', { exact: true }).waitFor();
  }
  await openNote(original);
  await sendAndReview();
  await page.getByRole('button', { name: 'Insert below Ink section', exact: true }).click();
  await page.locator('.squid-review').waitFor({ state: 'hidden' });
  await page.evaluate(() => {
    const editor = window.__squidTest.view.editor;
    const text = editor.getValue();
    const index = text.indexOf('1+1=3');
    editor.replaceRange('1+1=3 \\quad \\text{my correction}', editor.offsetToPos(index), editor.offsetToPos(index + 5));
  });
  await sendAndReview();
  await page.getByText('Replace my edited transcript', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Replace with reviewed transcript', exact: true }).click();
  await page.getByText(/Use the explicit replacement action/).waitFor();
  assert.match(await page.evaluate(() => window.__squidTest.view.editor.getValue()), /my correction/);
  // The toggle does not grant permission to overwrite edits made AFTER the review snapshot.
  await page.locator('.squid-review .checkbox-container').click();
  await page.evaluate(() => {
    const editor = window.__squidTest.view.editor;
    const at = editor.getValue().indexOf('my correction');
    editor.replaceRange('newer correction', editor.offsetToPos(at), editor.offsetToPos(at + 13));
  });
  await page.getByRole('button', { name: 'Replace with reviewed transcript', exact: true }).click();
  await page.getByText(/The transcript changed during review/).waitFor();
  assert.match(await page.evaluate(() => window.__squidTest.view.editor.getValue()), /newer correction/);
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await sendAndReview();
  await page.locator('.squid-review .checkbox-container').click();
  await page.getByRole('button', { name: 'Replace with reviewed transcript', exact: true }).click();
  await page.locator('.squid-review').waitFor({ state: 'hidden' });
  assert.ok(!(await page.evaluate(() => window.__squidTest.view.editor.getValue())).includes('newer correction'));
  console.log('PASS actual Obsidian: correction protection, explicit replacement, and rejection of edits made during review.');

  await openNote(original);
  await page.evaluate(() => { const plugin = window.app.plugins.getPlugin('squid'); plugin.data.cache = {}; window.__squidTest.delay = 1200; });
  await commandAtFirst(); await page.getByText(/Exact recognition image ·/).waitFor();
  const anchored = await page.evaluate(() => window.__squidTest.view.editor.getValue());
  await page.getByRole('button', { name: 'Send image to OpenAI', exact: true }).click();
  await page.getByText('Transcribing your Ink section', { exact: true }).waitFor();
  await page.evaluate(async () => {
    const file = window.app.vault.getAbstractFileByPath('Ink/Synthetic.svg');
    window.__squidTest.originalSvg = await window.app.vault.read(file);
    await window.app.vault.modify(file, window.__squidTest.originalSvg + '\n');
  });
  await page.waitForFunction(() => !window.app.plugins.getPlugin('squid').session);
  assert.equal(await page.evaluate(() => window.__squidTest.view.editor.getValue()), anchored);
  await page.evaluate(async () => { await window.app.vault.modify(window.app.vault.getAbstractFileByPath('Ink/Synthetic.svg'), window.__squidTest.originalSvg); });
  console.log('PASS actual Obsidian: source mutation cancels a running request and discards the late result.');

  await openNote(original);
  await commandAtFirst(); await page.getByText(/Exact recognition image ·/).waitFor();
  await page.getByRole('button', { name: 'Send image to OpenAI', exact: true }).click();
  await page.getByText('Transcribing your Ink section', { exact: true }).waitFor();
  await page.evaluate(() => window.__squidTest.view.editor.replaceRange('Unrelated new heading\n\n', { line: 0, ch: 0 }));
  await page.getByText('Review the transcription', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Insert below Ink section', exact: true }).click();
  await page.locator('.squid-review').waitFor({ state: 'hidden' });
  assert.match(await page.evaluate(() => window.__squidTest.view.editor.getValue()), /^Unrelated new heading/);
  console.log('PASS actual Obsidian: unrelated note edits during recognition survive insertion.');

  await page.evaluate(async () => {
    const view = window.__squidTest.view;
    await window.app.fileManager.renameFile(view.file, `Renamed ${view.file.name}`);
  });
  const renamedStatuses = await page.evaluate(() => window.app.plugins.getPlugin('squid').statuses(window.__squidTest.view));
  assert.ok(renamedStatuses.some(status => status.includes('source unchanged')));
  console.log('PASS actual Obsidian: renaming a note preserves its source/transcript association.');

  const savedPairs = await page.evaluate(() => Object.keys(window.app.plugins.getPlugin('squid').data.pairs).length);
  await page.evaluate(async () => {
    const plugin = window.app.plugins.getPlugin('squid');
    plugin.data.settings.secretName = ''; plugin.data.spend = []; plugin.data.cache = {};
    await plugin.persist();
    await window.app.plugins.disablePlugin('squid');
    await window.app.plugins.enablePlugin('squid');
  });
  assert.equal(await page.evaluate(() => Object.keys(window.app.plugins.getPlugin('squid').data.pairs).length), savedPairs);
  console.log('PASS actual Obsidian: pair comparison records survive plugin unload/reload.');
} catch (error) {
  await page?.screenshot({ path: path.join(artifacts, 'failure.png') }).catch(() => undefined);
  console.log('Visible notices:', await page?.locator('.notice').allTextContents().catch(() => []));
  throw error;
} finally { await browser?.close(); child.kill(); }
