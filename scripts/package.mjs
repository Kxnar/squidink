import { mkdir, copyFile, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
const destination = path.resolve('dist/squid');
await mkdir(destination, { recursive: true });
const checksums = [];
for (const file of ['main.js', 'manifest.json', 'styles.css']) {
  await copyFile(file, path.join(destination, file));
  checksums.push(`${createHash('sha256').update(await readFile(file)).digest('hex')}  ${file}`);
}
await writeFile('dist/SHA256SUMS.txt', checksums.join('\n') + '\n');
console.log(`Installable plugin files: ${destination}`);
