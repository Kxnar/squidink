import { describe, expect, it } from 'vitest';
import { formulaScore, normalizeFormula, validateDataset, type Dataset } from '../src/evaluation/metrics';
const dataset = (): Dataset => ({ version: 1, sections: Array.from({ length: 60 }, (_, i) => ({
  id: `s${i}`, sourceSectionId: `s${i}`, kind: 'section', split: i < 40 ? 'development' : 'held-out',
  image: `s${i}.png`, reference: `s${i}.md`, tags: [],
})) });
describe('benchmark integrity', () => {
  it('normalises formatting without correcting incorrect mathematics', () => {
    expect(normalizeFormula(' \\left( x + 1 \\right) ')).toBe('(x+1)');
    expect(formulaScore('$1+1=3$', '$1+1=2$').recall).toBe(0);
    expect(normalizeFormula('\\text{a b}')).not.toBe(normalizeFormula('\\text{ab}'));
  });
  it('tracks omitted and extra formulae separately', () => {
    const score = formulaScore('$a$ then $b$ then $c$', '$a$ then $c$ then $d$');
    expect(score.exactMatches).toBe(2);
    expect(score.recall).toBeCloseTo(2 / 3);
    expect(score.precision).toBeCloseTo(2 / 3);
  });
  it('uses null for an unmeasurable formula rate', () => {
    expect(formulaScore('Prose only', 'Prose only').recall).toBeNull();
  });
  it('requires 40/20 complete source sections', () => {
    expect(validateDataset(dataset()).sections).toHaveLength(60);
    const incomplete = dataset(); incomplete.sections.pop();
    expect(() => validateDataset(incomplete)).toThrow(/exactly 60/);
  });
  it('prevents leakage when equation crops share a source section', () => {
    const data = dataset(); data.sections.push({ ...data.sections[0]!, id: 'crop', kind: 'equation-crop', split: 'held-out' });
    expect(() => validateDataset(data)).toThrow(/both development and held-out/);
  });
  it('requires crops to refer to an existing whole section', () => {
    const data = dataset(); data.sections.push({ ...data.sections[0]!, id: 'crop', kind: 'equation-crop', sourceSectionId: 'missing' });
    expect(() => validateDataset(data)).toThrow(/one of the 60/);
  });
});
