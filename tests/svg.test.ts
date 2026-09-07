// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { cleanSvg, cropWithin, needsCrop } from '../src/ink/svg';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 300">
  <metadata><ink file-type="inkWriting"/><ink-canvas version="0.5.0">{"private":"not sent"}</ink-canvas></metadata>
  <line class="ink-type-writing-line ink-color-writing-line" x1="10" y1="150" x2="490" y2="150"/>
  <line id="fraction" x1="25" y1="70" x2="100" y2="70" stroke="black"/>
  <g transform="translate(10,20)"><path d="M 10 10 L 50 70" stroke="black"/></g>
</svg>`;

describe('SVG extraction', () => {
  it('removes only labelled guides and metadata while retaining fraction bars and transforms', () => {
    const result = cleanSvg(svg);
    expect(result.guidesRemoved).toBe(1);
    expect(result.xml).not.toContain('private');
    expect(result.xml).not.toContain('ink-type-writing-line');
    expect(result.xml).toContain('id="fraction"');
    expect(result.xml).toContain('translate(10,20)');
    expect(svg).toContain('ink-type-writing-line');
  });
  it('uses the selected drawing viewport including negative offsets', () => {
    const viewport = { x: -500, y: 200, width: 600, height: 350 };
    expect(cleanSvg(svg, viewport).xml).toContain('viewBox="-500 200 600 350"');
  });
  it('accepts older SVG metadata without interpreting or modifying its stroke data', () => {
    const result = cleanSvg(svg.replaceAll('ink-canvas', 'tldraw'));
    expect(result.legacy).toBe(true);
    expect(result.xml).toContain('id="fraction"');
  });
  it.each([
    '<svg/>', '<svg><bad></svg>', svg.replace('<svg ', '<!DOCTYPE svg><svg '),
    svg.replace('</svg>', '<script>alert(1)</script></svg>'),
    svg.replace('</svg>', '<image href="https://example.com/private"/></svg>'),
    svg.replace('</svg>', '<use href="https://example.com/private"/></svg>'),
    svg.replace('</svg>', '<path onload="alert(1)"/></svg>'),
    svg.replace('</svg>', '<style>@import "https://example.com/a.css";</style></svg>'),
    svg.replace('</svg>', '<foreignObject><div>Proof</div></foreignObject></svg>'),
  ])('rejects unsupported, malformed, or externally sourced SVG', value => {
    expect(() => cleanSvg(value)).toThrow();
  });
  it('keeps safe internal use references', () => {
    expect(cleanSvg(svg.replace('</svg>', '<use href="#fraction"/></svg>')).xml).toContain('href="#fraction"');
  });
  it('keeps quoted local SVG paint references without allowing remote CSS references', () => {
    expect(cleanSvg(svg.replace('</svg>', `<style>.paint { fill: url('#local'); }</style><path fill="url('#local')"/></svg>`)).xml).toContain('url(');
    expect(() => cleanSvg(svg.replace('</svg>', `<style>.paint { fill: url('https://example.com/remote'); }</style></svg>`))).toThrow();
    expect(() => cleanSvg(svg.replace('</svg>', '<style>.paint { fill: u\\72l(https://example.com/remote); }</style></svg>'))).toThrow();
  });
  it('requires cropping before large sections can be sent', () => {
    expect(needsCrop({ x: 0, y: 0, width: 2000, height: 6000 })).toBe(true);
    expect(needsCrop({ x: 0, y: 0, width: 2500, height: 2500 })).toBe(true);
    expect(needsCrop({ x: 0, y: 0, width: 2000, height: 1500 })).toBe(false);
    expect(() => cropWithin({ x: 0, y: 0, width: 2000, height: 1500 }, { x: -1, y: 0, width: 40, height: 50 })).toThrow();
  });
});
