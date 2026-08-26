import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');
const assetsDir = path.join(__dirname, '..', 'src', 'assets', 'brand');

const lightSrc = String.raw`C:\Users\Pratyush Mishra\Downloads\60803c98-c9ef-4116-85f4-e82912c67f41.png`;
const darkSrc = String.raw`C:\Users\Pratyush Mishra\Downloads\ChatGPT Image Aug 26, 2026, 11_33_16 PM.png`;

fs.mkdirSync(publicDir, { recursive: true });
fs.mkdirSync(assetsDir, { recursive: true });

async function prepareLogo(src, outBase, bgIsLight) {
  const meta = await sharp(src).metadata();
  console.log(outBase, meta.width, meta.height, meta.format);

  // Full logo for marketing / login (compressed, max 1200w)
  await sharp(src)
    .resize({ width: 1200, withoutEnlargement: true })
    .png({ compressionLevel: 9, palette: false })
    .toFile(path.join(publicDir, `${outBase}.png`));

  await sharp(src)
    .resize({ width: 1200, withoutEnlargement: true })
    .png({ compressionLevel: 9 })
    .toFile(path.join(assetsDir, `${outBase}.png`));

  // Icon-only crop: top ~52% of the image (graphic sits above wordmark)
  const iconH = Math.round(meta.height * 0.52);
  const iconW = meta.width;
  // Center square crop around the hexagon graphic
  const side = Math.min(iconW, iconH);
  const left = Math.round((iconW - side) / 2);
  const top = Math.round((iconH - side) / 2);

  const iconBuf = await sharp(src)
    .extract({ left, top, width: side, height: side })
    .resize(512, 512)
    .png()
    .toBuffer();

  await sharp(iconBuf).toFile(path.join(publicDir, `${outBase}-icon.png`));
  await sharp(iconBuf).toFile(path.join(assetsDir, `${outBase}-icon.png`));

  // Favicon PNGs
  const sizes = [16, 32, 48, 64, 180, 192, 512];
  const pngBuffers = [];
  for (const size of sizes) {
    const buf = await sharp(iconBuf).resize(size, size).png().toBuffer();
    await sharp(buf).toFile(path.join(publicDir, `favicon-${outBase.replace('logo-', '')}-${size}.png`));
    if ([16, 32, 48].includes(size)) pngBuffers.push(buf);
  }

  const ico = await pngToIco(pngBuffers);
  fs.writeFileSync(path.join(publicDir, `favicon-${outBase.replace('logo-', '')}.ico`), ico);
  console.log('wrote', outBase, 'and favicon');
}

await prepareLogo(lightSrc, 'logo-light', true);
await prepareLogo(darkSrc, 'logo-dark', false);

// Default favicon: dark-mode icon (portal is dark by default)
fs.copyFileSync(
  path.join(publicDir, 'favicon-dark.ico'),
  path.join(publicDir, 'favicon.ico')
);

// Apple touch + generic PNG favicon aliases
fs.copyFileSync(
  path.join(publicDir, 'favicon-dark-180.png'),
  path.join(publicDir, 'apple-touch-icon.png')
);
fs.copyFileSync(
  path.join(publicDir, 'favicon-dark-32.png'),
  path.join(publicDir, 'favicon-32x32.png')
);
fs.copyFileSync(
  path.join(publicDir, 'favicon-light-32.png'),
  path.join(publicDir, 'favicon-light-32x32.png')
);

console.log('done');
