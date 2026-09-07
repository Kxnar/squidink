import { finishRenderMath, loadMathJax, renderMath } from 'obsidian';

export interface MathPart { text: string; math: boolean; display: boolean; unclosed?: boolean }

/** Small preview parser: prose is textContent, never HTML or a plugin postprocessor. */
export function mathParts(markdown: string): MathPart[] {
  const parts: MathPart[] = [];
  let start = 0, index = 0;
  const escaped = (at: number): boolean => {
    let count = 0;
    for (let i = at - 1; i >= 0 && markdown[i] === '\\'; i--) count++;
    return count % 2 === 1;
  };
  while (index < markdown.length) {
    if (markdown[index] !== '$' || escaped(index)) { index++; continue; }
    if (index > start) parts.push({ text: markdown.slice(start, index), math: false, display: false });
    const display = markdown[index + 1] === '$';
    const delimiter = display ? '$$' : '$';
    const contentStart = index + delimiter.length;
    let close = contentStart;
    while (close < markdown.length) {
      if (markdown.startsWith(delimiter, close) && !escaped(close)) break;
      close++;
    }
    if (close === markdown.length) {
      parts.push({ text: markdown.slice(index), math: false, display: false, unclosed: true });
      return parts;
    }
    parts.push({ text: markdown.slice(contentStart, close), math: true, display });
    index = close + delimiter.length; start = index;
  }
  if (start < markdown.length) parts.push({ text: markdown.slice(start), math: false, display: false });
  return parts;
}

export async function renderMathPreview(markdown: string, container: HTMLElement): Promise<string[]> {
  await loadMathJax();
  const warnings: string[] = [];
  container.replaceChildren();
  for (const part of mathParts(markdown)) {
    if (part.unclosed) warnings.push('There is an unclosed maths delimiter.');
    if (!part.math) {
      const span = document.createElement('span'); span.textContent = part.text; container.append(span); continue;
    }
    if (/\\(?:href|url|includegraphics|require|html\w*)\b/.test(part.text)) {
      const span = document.createElement('span'); span.textContent = part.text; container.append(span);
      warnings.push('An external-content LaTeX command was not rendered in the preview.'); continue;
    }
    try { container.append(renderMath(part.text, part.display)); }
    catch {
      const span = document.createElement('span'); span.textContent = part.text; container.append(span);
      warnings.push('A formula could not be rendered. Check its LaTeX.');
    }
  }
  await finishRenderMath();
  if (container.querySelector('merror, mjx-merror, [data-mjx-error]')) warnings.push('MathJax reported a syntax error.');
  container.querySelectorAll('a').forEach(a => a.removeAttribute('href'));
  return [...new Set(warnings)];
}
