import type { InkEmbed, Rect } from '../types';

export interface Line { text: string; start: number; end: number; line: number; code: boolean }

/** Offsets retain CRLF and skip fenced examples, front matter and HTML comments. */
export function lines(text: string): Line[] {
  const result: Line[] = [];
  let start = 0, fence = '', fenceLength = 0, comment = false, frontMatter = false;
  text.split('\n').forEach((part, line) => {
    const value = part.replace(/\r$/, '');
    const trim = value.trim();
    if (line === 0 && trim === '---') frontMatter = true;
    const wasFrontMatter = frontMatter;
    if (line > 0 && frontMatter && /^(---|\.\.\.)$/.test(trim)) frontMatter = false;
    const f = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(value);
    let code = !!fence || wasFrontMatter || comment || /^( {4}|\t)/.test(value);
    if (!wasFrontMatter && !comment && f) {
      code = true;
      if (!fence) { fence = f[1]![0]!; fenceLength = f[1]!.length; }
      else if (f[1]![0] === fence && f[1]!.length >= fenceLength && !f[2]!.trim()) fence = '';
    }
    const isMarker = /^ {0,3}<!-- squid:(?:source|transcript|end) [a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12} -->[ \t]*$/.test(value);
    if (!fence && !wasFrontMatter && (comment || !code) && !(isMarker && !comment)) {
      const tokens: string[] = value.match(/<!--|-->/g) ?? [];
      if (comment || tokens.includes('<!--')) code = true;
      for (const token of tokens) {
        if (token === '<!--' && !comment) comment = true;
        else if (token === '-->' && comment) comment = false;
      }
    }
    result.push({ text: value, start, end: start + value.length, line, code });
    start += part.length + 1;
  });
  return result;
}

export function parseEmbeds(note: string): InkEmbed[] {
  const result: InkEmbed[] = [];
  for (const line of lines(note)) {
    if (line.code) continue;
    const match = /^ {0,3}!\[(InkWriting|InkDrawing)\]\((?:<([^>\n]+)>|([^\s]+))\)[ \t]*(?:\[Edit (?:Writing|Drawing)\]\(([^\s)]+)\))?[ \t]*$/.exec(line.text);
    if (!match) continue;
    const kind = match[1] === 'InkWriting' ? 'inkWriting' : 'inkDrawing';
    const embed: InkEmbed = {
      start: line.start, end: line.end, line: line.line, raw: line.text,
      link: match[2] ?? match[3]!, kind,
    };
    try {
      embed.link = decodeURIComponent(embed.link.replace(/\\([()])/g, '$1'));
      if (/^[a-z][a-z\d+.-]*:|^\/\//i.test(embed.link)) throw new Error();
      if (/\.(writing|drawing)$/i.test(embed.link)) {
        embed.error = 'This is a legacy Ink file. Use Ink’s migration options to convert it to SVG first.';
      } else if (!/\.svg$/i.test(embed.link)) throw new Error();
      if (match[4]) {
        const url = new URL(match[4].replace(/&amp;/g, '&'));
        if (url.searchParams.get('pendingPaste') === 'true') throw new Error();
        if (url.searchParams.get('type') !== kind) throw new Error();
        const names = ['viewBoxX', 'viewBoxY', 'viewBoxW', 'viewBoxH'];
        const present = names.map(n => url.searchParams.has(n));
        if (present.some(Boolean)) {
          if (!present.every(Boolean) || names.some(n => !url.searchParams.get(n)?.trim())) throw new Error();
          const values = names.map(n => Number(url.searchParams.get(n)));
          const [x, y, width, height] = values as [number, number, number, number];
          if (!values.every(Number.isFinite) || width <= 0 || height <= 0) throw new Error();
          embed.viewport = { x, y, width, height };
        }
      }
      if (kind === 'inkDrawing' && !embed.viewport && !embed.error) {
        embed.error = 'This drawing has no complete viewport. Open and save the embed in Ink first.';
      }
    } catch { embed.error = 'This Ink link or viewport is unsupported. Open and save the embed in Ink first.'; }
    result.push(embed);
  }
  return result;
}

export function hasLegacyEmbeds(note: string): boolean {
  return /^\s*(`{3,}|~{3,})(handwritten-ink|handdrawn-ink)\s*$/m.test(note);
}

export function embedIdentity(embed: InkEmbed): string {
  return JSON.stringify([embed.kind, embed.link, embed.viewport ?? null, embed.error ?? null]);
}

export function validRect(rect: Rect): boolean {
  return Object.values(rect).every(Number.isFinite) && rect.width > 0 && rect.height > 0;
}
