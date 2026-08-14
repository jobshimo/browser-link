import { cp, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');

await mkdir(dist, { recursive: true });
await cp(join(here, 'manifest.json'), join(dist, 'manifest.json'));
await cp(join(here, 'popup.html'), join(dist, 'popup.html'));
await cp(join(here, 'icons'), join(dist, 'icons'), { recursive: true });

console.log('[browser-link/extension] manifest.json, popup.html and icons/ copied to dist/');
