import { SquidError } from '../errors';
import { hash } from '../hash';
import { validRect } from './embeds';
import type { PreparedImage, Rect } from '../types';

export interface CleanSvg { xml: string; viewport: Rect; legacy: boolean; guidesRemoved: number }
export const MAX_EDGE = 4096;
export const MAX_PIXELS = 4_194_304;
const MAX_SVG_BYTES = 12_000_000;

export function parseViewBox(value: string | null): Rect {
  const parts = value?.trim().split(/[\s,]+/).map(Number);
  if (!parts || parts.length !== 4) throw new SquidError('Ink SVG has no usable viewBox. Open and save it in Ink first.');
  const [x, y, width, height] = parts as [number, number, number, number];
  const rect = { x, y, width, height };
  if (!validRect(rect)) throw new SquidError('Ink SVG has an invalid viewBox.');
  return rect;
}

/** Work on a detached XML document. Never modify Ink's saved file or insert raw SVG into the note. */
export function cleanSvg(raw: string, viewport?: Rect): CleanSvg {
  if (raw.length > MAX_SVG_BYTES || /<!DOCTYPE|<!ENTITY/i.test(raw)) throw new SquidError('This SVG is too large or uses unsupported XML entities.');
  const doc = new DOMParser().parseFromString(raw, 'image/svg+xml');
  const svg = doc.documentElement;
  if (doc.querySelector('parsererror') || svg.localName !== 'svg') throw new SquidError('This attachment is not a valid SVG.');
  if (!doc.querySelector('metadata ink-canvas, metadata tldraw')) throw new SquidError('This SVG does not contain recognised Ink metadata.');
  const legacy = !!doc.querySelector('metadata tldraw');
  const frame = viewport ?? parseViewBox(svg.getAttribute('viewBox'));
  if (!validRect(frame)) throw new SquidError('The selected viewport is invalid.');
  const guides = [...svg.querySelectorAll('.ink-type-writing-line')];
  guides.forEach(el => el.remove());
  svg.querySelectorAll('metadata, title, desc').forEach(el => el.remove());
  if (svg.querySelectorAll('*').length > 50_000) throw new SquidError('This section is too complex to prepare safely. Split it in Ink.');
  const supported = new Set(['svg', 'g', 'path', 'line', 'polyline', 'polygon', 'rect', 'circle', 'ellipse',
    'defs', 'clipPath', 'mask', 'linearGradient', 'radialGradient', 'stop', 'pattern', 'text', 'tspan', 'textPath', 'use', 'style']);
  for (const el of [svg, ...svg.querySelectorAll('*')]) {
    if (!supported.has(el.localName)) throw new SquidError('This SVG contains unsupported artwork. Open and save it with current Ink before transcribing.');
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name) || /^(?:href|xlink:href)$/i.test(attr.name) && !attr.value.startsWith('#')
        || /(?:url\(\s*['"]?(?!#)|@import|javascript:|expression\()/i.test(attr.value)) {
        throw new SquidError('This SVG uses active content or external resources. Resave it with current Ink.');
      }
    }
    if (el.localName === 'style' && /@import|@font-face|url\(|expression\(|javascript:/i.test(el.textContent ?? '')) {
      throw new SquidError('This SVG requires external styling. Resave it with current Ink.');
    }
  }
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('viewBox', `${frame.x} ${frame.y} ${frame.width} ${frame.height}`);
  svg.setAttribute('width', String(frame.width));
  svg.setAttribute('height', String(frame.height));
  svg.setAttribute('color', '#000000');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.querySelectorAll('.ink-type-stroke').forEach(el => el.setAttribute('fill', '#000000'));
  return { xml: new XMLSerializer().serializeToString(svg), viewport: frame, legacy, guidesRemoved: guides.length };
}

export function needsCrop(frame: Rect): boolean {
  return frame.width > MAX_EDGE || frame.height > MAX_EDGE || Math.ceil(frame.width) * Math.ceil(frame.height) > MAX_PIXELS;
}

export function cropWithin(frame: Rect, crop: Rect): Rect {
  const epsilon = 0.001;
  if (!validRect(crop) || crop.x < frame.x - epsilon || crop.y < frame.y - epsilon
    || crop.x + crop.width > frame.x + frame.width + epsilon || crop.y + crop.height > frame.y + frame.height + epsilon) {
    throw new SquidError('The crop must stay inside the selected Ink viewport.');
  }
  return crop;
}

export async function rasterize(clean: CleanSvg, previewOnly = false): Promise<PreparedImage> {
  const frame = clean.viewport;
  if (!previewOnly && needsCrop(frame)) throw new SquidError('This section is too large. Choose a smaller crop; Squid will not shrink the recognition image.');
  const scale = previewOnly ? Math.min(1, 1200 / Math.max(frame.width, frame.height))
    : Math.min(2, MAX_EDGE / Math.max(frame.width, frame.height), Math.sqrt(MAX_PIXELS / (frame.width * frame.height)));
  const width = Math.max(1, Math.floor(frame.width * scale)), height = Math.max(1, Math.floor(frame.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new SquidError('Image preparation is unavailable in this window.');
  context.fillStyle = '#ffffff'; context.fillRect(0, 0, width, height);
  const url = URL.createObjectURL(new Blob([clean.xml], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { image.src = ''; reject(new SquidError('SVG preparation timed out.')); }, 15_000);
      image.onload = () => { clearTimeout(timer); resolve(); };
      image.onerror = () => { clearTimeout(timer); reject(new SquidError('Ink’s saved artwork could not be rendered.')); };
      image.src = url;
    });
    context.drawImage(image, 0, 0, width, height);
    if (!previewOnly) {
      const pixels = context.getImageData(0, 0, width, height).data;
      let visible = 0;
      for (let i = 0; i < pixels.length; i += 4) if (Math.min(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) < 240) visible++;
      if (visible < 8) throw new SquidError('This crop appears empty after guide removal. Choose a region containing handwriting.');
    }
    const dataUrl = canvas.toDataURL('image/png');
    return { dataUrl, hash: await hash(dataUrl), viewport: frame, width, height };
  } finally { URL.revokeObjectURL(url); canvas.width = 0; canvas.height = 0; }
}
