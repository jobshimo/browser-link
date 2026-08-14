import { Resvg } from '@resvg/resvg-js';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const iconsDir = join(here, '..', 'icons');
const sizes = [16, 32, 48, 128];

const svg = await readFile(join(iconsDir, 'icon.svg'));

for (const size of sizes) {
  const resvg = new Resvg(svg, { fitTo: { mode: 'width', value: size } });
  const png = resvg.render().asPng();
  await writeFile(join(iconsDir, `icon-${size}.png`), png);
  console.log(`[browser-link/extension] generated icon-${size}.png`);
}
