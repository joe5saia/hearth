import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";
import {
  brandSvg,
  cream,
  iconArtwork,
  smallIconArtwork,
  microIconArtwork,
  monochromeArtwork,
  wordmarkArtwork,
  logoSvg,
  faviconSvg,
} from "../src/brand.ts";

await mkdir("public/brand", { recursive: true });
await mkdir("public/icons", { recursive: true });

const masters = {
  logo: logoSvg,
  "logo-monochrome": brandSvg(monochromeArtwork + wordmarkArtwork.replace(/fill="#[a-f0-9]+"/g, 'fill="currentColor"'), "0 0 368 100"),
  "logo-reversed": logoSvg.replace(/#[a-f0-9]{6}/g, cream),
  icon: brandSvg(iconArtwork),
  "icon-small": brandSvg(smallIconArtwork),
  "icon-micro": brandSvg(microIconArtwork),
  "icon-monochrome": brandSvg(monochromeArtwork),
  "icon-reversed": brandSvg(monochromeArtwork).replace(/#[a-f0-9]{6}/g, cream),
};

function render(svg: string, width: number) {
  return new Resvg(svg, { fitTo: { mode: "width", value: width }, font: { loadSystemFonts: false } }).render().asPng();
}

for (const [name, svg] of Object.entries(masters)) {
  await writeFile(`public/brand/${name}.svg`, svg + "\n");
  await writeFile(`public/brand/${name}.png`, render(svg, name.startsWith("logo") ? 1840 : 1024));
}

await writeFile("public/favicon.svg", faviconSvg + "\n");
const frames: Buffer[] = [];
for (const size of [16, 32, 48]) {
  const png = render(faviconSvg, size);
  frames.push(png);
  await writeFile(`public/icons/favicon-${size}.png`, png);
}

// ICO directory followed by lossless PNG frames (supported by modern Windows and browsers).
const directory = Buffer.alloc(6 + frames.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(frames.length, 4);
let offset = directory.length;
for (const [index, frame] of frames.entries()) {
  const size = [16, 32, 48][index];
  const entry = 6 + index * 16;
  directory[entry] = size;
  directory[entry + 1] = size;
  directory.writeUInt16LE(1, entry + 4);
  directory.writeUInt16LE(32, entry + 6);
  directory.writeUInt32LE(frame.length, entry + 8);
  directory.writeUInt32LE(offset, entry + 12);
  offset += frame.length;
}
await writeFile("public/favicon.ico", Buffer.concat([directory, ...frames]));
await writeFile("public/icons/safari-pinned-tab.svg", brandSvg(monochromeArtwork).replace('color="#3f5136"', 'color="#000000"') + "\n");

const tile = brandSvg(`<rect width="100" height="100" fill="${cream}"/><g transform="translate(12 12) scale(.76)">${iconArtwork}</g>`);
for (const size of [120, 152, 167, 180]) {
  await writeFile(`public/icons/apple-touch-icon-${size}.png`, render(tile, size));
}
await writeFile("public/apple-touch-icon.png", render(tile, 180));
for (const size of [192, 512]) {
  await writeFile(`public/icons/icon-${size}.png`, render(tile, size));
  // The whole mark fits within the central radius-.4 safe circle, including its square corners.
  const maskable = brandSvg(`<rect width="100" height="100" fill="${cream}"/><g transform="translate(23 23) scale(.54)">${iconArtwork}</g>`);
  await writeFile(`public/icons/maskable-${size}.png`, render(maskable, size));
}

const sharing = brandSvg(`<rect width="1200" height="630" fill="${cream}"/><g transform="translate(160 195) scale(2.4)">${iconArtwork}${wordmarkArtwork}</g>`, "0 0 1200 630");
await writeFile("public/brand/social-card.png", render(sharing, 1200));
await copyFile("node_modules/@fontsource-variable/lora/LICENSE", "public/brand/FONT-LICENSE.txt");
console.log("Generated 33 vector/raster logo, favicon, home-screen, maskable, sharing, and license assets.");
