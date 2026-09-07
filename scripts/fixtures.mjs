// Original synthetic strokes for integration QA; not examples of the user's handwriting.
const style = { size: 3.5, thinning: 0, smoothing: 0, streamline: 0, simulatePressure: false, color: '#000000' };
const paths = [
  // x squared over 2, including small superscript and a handwritten fraction bar.
  [[40, 50], [62, 78]], [[61, 50], [41, 78]],
  [[68, 35], [77, 31], [85, 36], [82, 42], [69, 50], [86, 50]],
  [[31, 88], [104, 88]],
  [[52, 109], [60, 103], [72, 109], [69, 118], [51, 133], [75, 133]],
  [[121, 74], [148, 74]], [[122, 86], [150, 86]],
  [[171, 51], [195, 77]], [[194, 50], [172, 78]],
  // Deliberately false 1 + 1 = 3 on the second line.
  [[40, 193], [48, 185], [48, 223]],
  [[70, 204], [96, 204]], [[83, 190], [83, 218]],
  [[115, 193], [123, 185], [123, 223]],
  [[148, 198], [173, 198]], [[148, 210], [173, 210]],
  [[192, 188], [210, 187], [217, 193], [207, 202], [217, 211], [213, 220], [194, 223]],
  // Another region, far enough away for two differently framed drawing embeds.
  [[640, 50], [663, 78]], [[662, 51], [641, 77]],
  [[685, 61], [710, 61]], [[685, 73], [710, 73]],
  [[737, 48], [724, 76], [748, 76]], [[742, 63], [742, 87]],
];
export function syntheticSvg({ legacy = false, empty = false, tall = false } = {}) {
  const strokes = (empty ? [] : paths).map((points, index) => ({
    id: `synthetic-${index}`, points: points.map(([x, y]) => [x, y, 0.5]), style, offset: { x: 0, y: 0 },
  }));
  const visual = strokes.map(stroke => `<path d="M${stroke.points.map(p => `${p[0]},${p[1]}`).join(' L')}" fill="none" stroke="#000000" stroke-width="3.5" stroke-linecap="round"/>`).join('\n');
  const metadata = legacy
    ? '<tldraw version="2.4.3">{"syntheticVisualOnly":true}</tldraw>'
    : `<ink-canvas version="0.5.0">${JSON.stringify({ version: 1, strokes, gridEnabled: false, writingLineHeight: 150 })}</ink-canvas>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 850 ${tall ? 7000 : 320}">
<metadata><ink plugin-version="0.5.6" file-type="inkWriting"/>${metadata}</metadata>
<line class="ink-type-writing-line" x1="20" y1="150" x2="830" y2="150" stroke="#888"/>
<line class="ink-type-writing-line" x1="20" y1="300" x2="830" y2="300" stroke="#888"/>
${visual}
</svg>`;
}
export const drawingEmbed = (x = 0) => ` ![InkDrawing](<Ink/Synthetic.svg>) [Edit Drawing](https://youtu.be/2arL1jh8ihA?type=inkDrawing&width=500&aspectRatio=1.5625&viewBoxX=${x}&viewBoxY=0&viewBoxW=500&viewBoxH=320)`;
export const writingEmbed = (file = 'Synthetic.svg') => ` ![InkWriting](<Ink/${file}>) [Edit Writing](https://youtu.be/2arL1jh8ihA?type=inkWriting)`;
