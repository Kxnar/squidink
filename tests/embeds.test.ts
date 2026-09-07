import { describe, expect, it } from 'vitest';
import { embedIdentity, hasLegacyEmbeds, parseEmbeds } from '../src/ink/embeds';

export const writing = ' ![InkWriting](<Ink/Proof notes.svg>) [Edit Writing](https://youtu.be/2arL1jh8ihA?type=inkWriting&aspectRatio=2.5)';
export const drawing = (x = 0) => ` ![InkDrawing](<Ink/Plane.svg>) [Edit Drawing](https://youtu.be/2arL1jh8ihA?type=inkDrawing&viewBoxX=${x}&viewBoxY=-20&viewBoxW=500&viewBoxH=281)`;

describe('Ink embed selection', () => {
  it('resolves an encoded path without losing CRLF offsets', () => {
    const text = '# Proof\r\n\r\n' + writing.replace('Proof notes', 'Proof%20notes') + '\r\n';
    const embed = parseEmbeds(text)[0]!;
    expect(embed.link).toBe('Ink/Proof notes.svg');
    expect(embed.line).toBe(2);
    expect(text.slice(embed.start, embed.end)).toBe(embed.raw);
    expect(embed.error).toBeUndefined();
  });
  it('gives two viewports of the same attachment distinct identities', () => {
    const [a, b] = parseEmbeds(drawing() + '\n\n' + drawing(600));
    expect(a!.link).toBe(b!.link);
    expect(embedIdentity(a!)).not.toBe(embedIdentity(b!));
    expect(b!.viewport).toEqual({ x: 600, y: -20, width: 500, height: 281 });
  });
  it('ignores code examples, YAML, comments, block quotes, and indented code', () => {
    const text = `---\n${writing}\n---\n\n\`\`\`md\n${writing}\n\`\`\`\n<!--\n${writing}\n-->\n> ${writing}\n    ${writing}\n${writing}`;
    expect(parseEmbeds(text)).toHaveLength(1);
  });
  it('does not close a four-backtick fence on three backticks', () => {
    expect(parseEmbeds('````md\n```\n' + writing + '\n````')).toHaveLength(0);
  });
  it('does not mistake malformed Squid comments or multiple comments for visible embeds', () => {
    expect(parseEmbeds('<!-- squid:unknown\n' + writing + '\n-->')).toHaveLength(0);
    expect(parseEmbeds('<!-- closed --> <!-- open\n' + writing + '\n-->')).toHaveLength(0);
  });
  it.each([
    drawing().replace('&viewBoxW=500', ''),
    drawing().replace('viewBoxH=281', 'viewBoxH=0'),
    drawing().replace('viewBoxX=0', 'viewBoxX=NaN'),
    drawing().replace('viewBoxX=0', 'viewBoxX='),
    drawing().replace('type=inkDrawing', 'type=inkWriting'),
    writing.replace('Ink/Proof notes.svg', 'https://example.com/a.svg'),
  ])('rejects unsafe or ambiguous frames: %s', text => {
    expect(parseEmbeds(text)[0]!.error).toBeTruthy();
  });
  it('detects legacy attachments and fenced formats without converting them', () => {
    expect(parseEmbeds(writing.replace('.svg', '.writing'))[0]!.error).toMatch(/migration/);
    expect(hasLegacyEmbeds('```handwritten-ink\n{}\n```')).toBe(true);
  });
});
