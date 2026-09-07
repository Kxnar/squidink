export interface FormulaScore { referenceCount: number; predictedCount: number; exactMatches: number; recall: number | null; precision: number | null }

export function formulas(markdown: string): string[] {
  const found: string[] = [];
  const pattern = /(?<!\\)\$\$([\s\S]*?)(?<!\\)\$\$|(?<![\\$])\$([^\n$]*?)(?<!\\)\$/g;
  for (const match of markdown.matchAll(pattern)) found.push(match[1] ?? match[2]!);
  return found;
}

/** Formatting only: preserve commands, symbols, prose within \text{}, and equation order. */
export function normalizeFormula(formula: string): string {
  const parts = formula.split(/(\\(?:text|mathrm|operatorname)\{[^{}]*\}|\\ )/g);
  return parts.map(part => /^\\(?:text|mathrm|operatorname)\{|^\\ $/.test(part) ? part
    : part.replace(/\\(?:left|right)\b/g, '').replace(/\\[,;!]/g, '').replace(/\s+/g, '')).join('');
}

export function formulaScore(reference: string, prediction: string): FormulaScore {
  const expected = formulas(reference).map(normalizeFormula), actual = formulas(prediction).map(normalizeFormula);
  // An order-preserving match counts omitted and extra formulae without shifting every subsequent match.
  let row = new Array<number>(actual.length + 1).fill(0);
  for (const formula of expected) {
    const next = [0];
    actual.forEach((candidate, i) => { next.push(formula === candidate ? row[i]! + 1 : Math.max(row[i + 1]!, next[i]!)); });
    row = next;
  }
  const exactMatches = row.at(-1)!;
  return { referenceCount: expected.length, predictedCount: actual.length, exactMatches,
    recall: expected.length ? exactMatches / expected.length : null,
    precision: actual.length ? exactMatches / actual.length : null };
}

export interface DatasetSection {
  id: string;
  sourceSectionId: string;
  split: 'development' | 'held-out';
  kind: 'section' | 'equation-crop';
  image: string;
  reference: string;
  tags: string[];
}
export interface Dataset { version: 1; sections: DatasetSection[] }
export function validateDataset(value: unknown): Dataset {
  const data = value as Dataset | null;
  if (data?.version !== 1 || !Array.isArray(data.sections)) throw new Error('Dataset must have version 1 and a sections array.');
  const ids = new Set<string>();
  const groups = new Map<string, string>();
  for (const row of data.sections) {
    if (!row || !/^[a-z\d][a-z\d_-]*$/i.test(row.id) || ids.has(row.id) || typeof row.sourceSectionId !== 'string' || !row.sourceSectionId
      || !['development', 'held-out'].includes(row.split) || !['section', 'equation-crop'].includes(row.kind)
      || typeof row.image !== 'string' || !row.image.endsWith('.png') || typeof row.reference !== 'string'
      || !row.reference.endsWith('.md') || !Array.isArray(row.tags) || !row.tags.every(t => typeof t === 'string')) {
      throw new Error('Dataset contains invalid fields or duplicate example IDs.');
    }
    ids.add(row.id);
    if (groups.has(row.sourceSectionId) && groups.get(row.sourceSectionId) !== row.split) throw new Error('A source section appears in both development and held-out splits. Split before cropping.');
    groups.set(row.sourceSectionId, row.split);
  }
  const whole = data.sections.filter(row => row.kind === 'section');
  if (whole.length !== 60 || whole.filter(row => row.split === 'development').length !== 40
    || whole.filter(row => row.split === 'held-out').length !== 20 || new Set(whole.map(row => row.sourceSectionId)).size !== 60) {
    throw new Error('Provide exactly 60 distinct whole source sections: 40 development and 20 held-out.');
  }
  for (const crop of data.sections.filter(row => row.kind === 'equation-crop')) {
    if (!whole.some(section => section.sourceSectionId === crop.sourceSectionId)) throw new Error('Every equation crop must refer to one of the 60 whole source sections.');
  }
  return data;
}
