import { mkdir, writeFile, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drawingEmbed, syntheticSvg, writingEmbed } from './fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vault = path.join(root, '.qa-vault');
await access(path.join(root, 'main.js'));
await mkdir(path.join(vault, '.obsidian', 'plugins', 'squid'), { recursive: true });
await mkdir(path.join(vault, 'Ink'), { recursive: true });
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  await copyFile(path.join(root, file), path.join(vault, '.obsidian', 'plugins', 'squid', file));
}
// Preserve existing QA notes and settings when updating the build.
async function create(relative, text) {
  try { await writeFile(path.join(vault, relative), text, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
await create('.obsidian/community-plugins.json', JSON.stringify(['squid']));
await create('.obsidian/app.json', JSON.stringify({ livePreview: false, showInlineTitle: true }));
await create('.obsidian/appearance.json', JSON.stringify({ baseFontSize: 17 }));
await create('Ink/Synthetic.svg', syntheticSvg());
await create('Ink/Older-visual.svg', syntheticSvg({ legacy: true }));
await create('Ink/Empty.svg', syntheticSvg({ empty: true }));
await create('Ink/Tall.svg', syntheticSvg({ tall: true }));
await create('01 - Start here.md', `# Squid disposable test vault

These are original **synthetic integration fixtures**, not a handwriting recognition benchmark.
No API key is preconfigured. Enabling Squid and previewing/cropping are free; sending an image is a paid action.

Open **02 - Two viewports** in editing mode and run **Squid: Transcribe Ink section**.
Check that the first viewport contains the fraction and deliberately false equality, and the second contains x = 4.

The older-format visual fixture only tests SVG extraction. It is not a complete editable tldraw document; do not use it to test Ink's migration. Use an actual older Ink file for that check.

For full handwritten acceptance, install Ink normally into this disposable vault, write your own notes, and follow the repository's acceptance checklist.
`);
await create('02 - Two viewports.md', `# Two views of one attachment

First region (fraction and deliberately wrong equality):

${drawingEmbed(0)}

Second region (x = 4):

${drawingEmbed(500)}

This paragraph must survive every transcription and regeneration.
`);
await create('03 - Writing.md', `# Writing extraction

${writingEmbed()}

The grey guides should disappear; the fraction bar should remain.
`);
await create('04 - Older visual SVG.md', `# Older metadata / vector rendering fixture

Synthetic visual-only test. Real tldraw migration requires real Ink-authored files.

${writingEmbed('Older-visual.svg')}
`);
await create('05 - Empty and oversized.md', `# Input limits

Empty (should not be submitted):

${writingEmbed('Empty.svg')}

Oversized (must crop before submitting):

${writingEmbed('Tall.svg')}
`);
await create('06 - Unsupported and broken.md', '# Legacy Ink\n\n```handwritten-ink\n{"filepath":"Ink/Old.writing"}\n```\n\n' + writingEmbed('Missing.svg'));
console.log(`Disposable vault ready: ${vault}`);
