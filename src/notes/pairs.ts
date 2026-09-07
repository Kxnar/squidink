import { SquidError } from '../errors';
import { lines, parseEmbeds } from '../ink/embeds';
import type { InkEmbed } from '../types';

const ID = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const markerPattern = new RegExp(`^ {0,3}<!-- squid:(source|transcript|end) (${ID}) -->[ \\t]*$`);
export const marker = (kind: 'source' | 'transcript' | 'end', id: string): string => `<!-- squid:${kind} ${id} -->`;
export interface Pair {
  id: string;
  source: InkEmbed;
  markerStart: number;
  body?: string;
  bodyStart?: number;
  bodyEnd?: number;
}
export interface NoteSnapshot { path: string; text: string }
export interface LocatedPair { note: NoteSnapshot; pair: Pair }
export interface Change { from: number; to: number; text: string }

export function sourceIdFor(note: string, embed: InkEmbed): string | undefined {
  const before = lines(note).filter(l => l.end < embed.start && l.text.trim());
  const prev = before.at(-1);
  if (!prev || prev.code) return;
  const m = markerPattern.exec(prev.text);
  return m?.[1] === 'source' ? m[2] : undefined;
}

export function findPair(note: string, id: string): Pair | undefined {
  const allLines = lines(note);
  const marks = allLines.filter(l => !l.code).map(l => ({ l, m: markerPattern.exec(l.text) }))
    .filter(v => v.m?.[2] === id);
  if (!marks.length) return;
  const sourceMarks = marks.filter(v => v.m![1] === 'source');
  if (sourceMarks.length !== 1) throw new SquidError('This pair has missing or duplicated source markers. Resolve the markers before transcribing.');
  const anchor = sourceMarks[0]!.l;
  const nextLine = allLines.find(l => l.start > anchor.end && l.text.trim());
  const source = parseEmbeds(note).find(e => e.start === nextLine?.start);
  if (!source) throw new SquidError('The source marker is no longer attached to a supported Ink embed.');
  const pair: Pair = { id, source, markerStart: anchor.start };
  if (marks.length === 1) return pair;
  const transcript = marks.filter(v => v.m![1] === 'transcript');
  const end = marks.filter(v => v.m![1] === 'end');
  if (marks.length !== 3 || transcript.length !== 1 || end.length !== 1) {
    throw new SquidError('Transcript markers are missing or duplicated. Squid cannot safely choose a replacement.');
  }
  const begin = transcript[0]!.l, finish = end[0]!.l;
  if (begin.start < source.end || finish.start <= begin.end || note.slice(source.end, begin.start).trim()) {
    throw new SquidError('The transcript is detached from its Ink embed. Move the complete pair together.');
  }
  pair.bodyStart = begin.end + (note.slice(begin.end, begin.end + 2) === '\r\n' ? 2 : 1);
  pair.bodyEnd = finish.start;
  const rawBody = note.slice(pair.bodyStart, pair.bodyEnd);
  pair.body = rawBody.replace(/\r?\n$/, '');
  if (/<!--\s*squid:/.test(pair.body)) throw new SquidError('Nested Squid markers make this pair ambiguous.');
  return pair;
}

export function locatePair(notes: NoteSnapshot[], id: string): LocatedPair {
  const found: LocatedPair[] = [];
  for (const note of notes) {
    const pair = findPair(note.text, id);
    if (pair) found.push({ note, pair });
  }
  if (found.length !== 1) throw new SquidError(found.length
    ? 'This pair ID appears in more than one note. Use “Give copied Ink pair a new ID” on the copy.'
    : 'The Ink pair was removed. Start again from the source section.');
  return found[0]!;
}

/** Explicitly selected local copy; permits repairing duplicate IDs in the same note. */
export function pairForEmbed(note: string, embed: InkEmbed): Pair {
  const id = sourceIdFor(note, embed);
  if (!id) throw new SquidError('This embed has no attached Squid source marker.');
  const allLines = lines(note);
  const sourceLine = allLines.filter(l => l.end < embed.start && l.text.trim()).at(-1)!;
  const nextSource = allLines.find(l => l.start > embed.end && !l.code && markerPattern.exec(l.text)?.[1] === 'source');
  const local = findPair(note.slice(sourceLine.start, nextSource?.start ?? note.length), id);
  if (!local) throw new SquidError('The selected copy has incomplete markers.');
  const offset = sourceLine.start;
  return { ...local, markerStart: local.markerStart + offset,
    source: { ...local.source, start: local.source.start + offset, end: local.source.end + offset, line: embed.line },
    bodyStart: local.bodyStart === undefined ? undefined : local.bodyStart + offset,
    bodyEnd: local.bodyEnd === undefined ? undefined : local.bodyEnd + offset };
}

export function anchorChange(note: string, embed: InkEmbed, id: string): Change {
  if (note.slice(embed.start, embed.end) !== embed.raw) throw new SquidError('The note changed. Select the section again.');
  const preceding = lines(note).filter(l => l.end < embed.start && l.text.trim()).at(-1);
  if (preceding?.text.includes('<!-- squid:')) throw new SquidError('Resolve the existing Squid marker above this embed first.');
  const eol = note.includes('\r\n') ? '\r\n' : '\n';
  return { from: embed.start, to: embed.start, text: marker('source', id) + eol };
}

export function applyChange(note: string, change: Change): string {
  return note.slice(0, change.from) + change.text + note.slice(change.to);
}

export function transcriptChange(note: string, id: string, reviewedBody: string | undefined,
  markdown: string, manuallyEdited: boolean, explicitReplace: boolean): Change {
  const pair = findPair(note, id);
  if (!pair) throw new SquidError('The source was deleted. Nothing was inserted.');
  if (pair.body !== reviewedBody) throw new SquidError('The transcript changed during review. Reopen review to see the latest corrections.');
  if (manuallyEdited && !explicitReplace) throw new SquidError('Use the explicit replacement action to replace manual corrections.');
  if (!markdown.trim() || /<!--\s*squid:/i.test(markdown)) throw new SquidError('The transcript is empty or contains reserved Squid markers.');
  if (/^ {0,3}(?:`{3,}|~{3,})/m.test(markdown) || /(?<!\\)!\[/.test(markdown)
    || /<(?:script|iframe|object|embed|img|video|audio|svg|link|style|meta)\b/i.test(markdown)) {
    throw new SquidError('Use ordinary prose and maths in the transcript. Escape code fences, image embeds and active HTML as literal text before inserting.');
  }
  // Reject an unclosed fence/comment: it could hide the closing pair marker from future scans.
  const probe = markdown + '\n' + marker('end', id);
  if (lines(probe).at(-1)?.code) throw new SquidError('Close Markdown code fences and HTML comments before inserting.');
  const eol = note.includes('\r\n') ? '\r\n' : '\n';
  const body = markdown.trim().replace(/\r?\n/g, eol);
  if (pair.bodyStart !== undefined && pair.bodyEnd !== undefined) {
    return { from: pair.bodyStart, to: pair.bodyEnd, text: body + eol };
  }
  return { from: pair.source.end, to: pair.source.end,
    text: `${eol}${eol}${marker('transcript', id)}${eol}${body}${eol}${marker('end', id)}${eol}` };
}

export function rekeyChange(note: string, pair: Pair, newId: string): Change {
  const end = pair.bodyEnd === undefined ? pair.source.end : note.indexOf('-->', pair.bodyEnd) + 3;
  const text = note.slice(pair.markerStart, end).replaceAll(` ${pair.id} -->`, ` ${newId} -->`);
  return { from: pair.markerStart, to: end, text };
}
