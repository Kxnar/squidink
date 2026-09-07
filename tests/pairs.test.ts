import { describe, expect, it } from 'vitest';
import { parseEmbeds } from '../src/ink/embeds';
import { anchorChange, applyChange, findPair, locatePair, marker, pairForEmbed, rekeyChange, transcriptChange } from '../src/notes/pairs';

const id = '12345678-1234-4321-8321-123456789abc';
const secondId = '87654321-4321-4321-8321-123456789abc';
const writing = ' ![InkWriting](<Ink/Proof.svg>) [Edit Writing](https://youtu.be/2arL1jh8ihA?type=inkWriting)';
const original = `# My proof\n\n${writing}\n\nUnrelated text that must survive.\n`;
function anchored(note = original): string { return applyChange(note, anchorChange(note, parseEmbeds(note)[0]!, id)); }
function withTranscript(note = anchored(), body = '$1 + 1 = 3$'): string {
  return applyChange(note, transcriptChange(note, id, undefined, body, false, false));
}

describe('source/transcript pairs', () => {
  it('inserts below the correct embed and preserves all surrounding text', () => {
    const note = anchored();
    const result = withTranscript(note);
    expect(result).toContain(`${writing}\n\n${marker('transcript', id)}\n$1 + 1 = 3$`);
    expect(result).toContain('Unrelated text that must survive.');
    expect(findPair(result, id)?.body).toBe('$1 + 1 = 3$');
  });
  it('keeps CRLF and supports undo by reversing the single change', () => {
    const note = anchored(original.replaceAll('\n', '\r\n'));
    const change = transcriptChange(note, id, undefined, 'Step 1\n\n$$x^2$$', false, false);
    const result = applyChange(note, change);
    expect(result.replaceAll('\r\n', '')).not.toContain('\n');
    expect(result.slice(0, change.from) + result.slice(change.from + change.text.length)).toBe(note);
  });
  it('re-finds a complete pair after movement and a note rename', () => {
    const pairText = withTranscript();
    const found = locatePair([{ path: 'old.md', text: 'Other notes' }, { path: 'new/folder.md', text: '\nNew heading\n' + pairText }], id);
    expect(found.note.path).toBe('new/folder.md');
    const edited = applyChange(found.note.text, transcriptChange(found.note.text, id, '$1 + 1 = 3$', '$2 + 2 = 5$', false, false));
    expect(findPair(edited, id)?.body).toBe('$2 + 2 = 5$');
  });
  it('protects manual corrections and requires an explicit action to replace them', () => {
    const note = withTranscript(anchored(), '$x_i$ manually corrected');
    expect(() => transcriptChange(note, id, '$x_i$ manually corrected', '$x_1$', true, false)).toThrow(/explicit/);
    const replaced = applyChange(note, transcriptChange(note, id, '$x_i$ manually corrected', '$x_1$', true, true));
    expect(findPair(replaced, id)?.body).toBe('$x_1$');
  });
  it('never overwrites new edits made after review opened, even with explicit replacement', () => {
    const note = withTranscript(anchored(), 'Correction added after review');
    expect(() => transcriptChange(note, id, 'Old review snapshot', 'Generated', true, true)).toThrow(/changed during review/);
  });
  it('allows unrelated edits before the source without relying on saved line numbers', () => {
    const note = 'New preface\n\n' + withTranscript();
    const result = applyChange(note, transcriptChange(note, id, '$1 + 1 = 3$', 'Reviewed', false, false));
    expect(result.startsWith('New preface\n\n')).toBe(true);
    expect(findPair(result, id)?.body).toBe('Reviewed');
  });
  it('rejects duplicate IDs across notes and in one note', () => {
    const text = withTranscript();
    expect(() => locatePair([{ path: 'a', text }, { path: 'b', text }], id)).toThrow(/more than one/);
    expect(() => findPair(text + '\n' + text, id)).toThrow(/duplicated/);
  });
  it('can give an explicitly selected same-note copy a fresh ID', () => {
    const text = withTranscript() + '\nCopied section\n' + withTranscript();
    const second = parseEmbeds(text)[1]!;
    const copied = pairForEmbed(text, second);
    const changed = applyChange(text, rekeyChange(text, copied, secondId));
    expect(findPair(changed, id)?.body).toBe('$1 + 1 = 3$');
    expect(findPair(changed, secondId)?.body).toBe('$1 + 1 = 3$');
  });
  it('treats source deletion, detached output, and missing end markers as unresolved', () => {
    const text = withTranscript();
    expect(() => findPair(text.replace(writing, ''), id)).toThrow(/source marker/);
    expect(() => findPair(text.replace(writing, writing + '\nA different paragraph'), id)).toThrow(/detached/);
    expect(() => findPair(text.replace(marker('end', id), ''), id)).toThrow(/missing/);
    expect(() => locatePair([{ path: 'a', text: '' }], id)).toThrow(/removed/);
  });
  it('does not recognise example pair IDs in code fences', () => {
    const text = '```md\n' + withTranscript() + '\n```';
    expect(findPair(text, id)).toBeUndefined();
  });
  it.each(['```latex\nnot closed', '<!-- unclosed', `Hello\n${marker('source', id)}`, '   ',
    '```dataviewjs\napp.vault.delete(file)\n```', '![[private-note]]', '<img src="https://example.com">'])('rejects output that breaks pairing or invokes embeds: %s', body => {
    expect(() => transcriptChange(anchored(), id, undefined, body, false, false)).toThrow();
  });
  it('preserves false equations verbatim', () => {
    const body = '$$\n\\begin{aligned}1+1 &= 3 \\\\\n2+2 &= 5\\end{aligned}\n$$';
    expect(findPair(withTranscript(anchored(), body), id)?.body).toBe(body);
  });
});
