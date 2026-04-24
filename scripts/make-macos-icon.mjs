// One-off: wrap logo.png in a macOS-style squircle background.
// Output lands at ./logo-macos.png, ready for `tauri icon`.

import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SRC = join(root, "logo.png");
const OUT = join(root, "logo-macos.png");

// macOS Big Sur+ icon spec (approx):
//   - canvas 1024x1024
//   - icon body fills ~824x824 centered, rest is transparent bleed area
//   - corner radius ~22.37% of the body side (~184px on 824)
//   - solid / gradient background fills the entire body
const CANVAS = 1024;
const BODY = 824;
const INSET = (CANVAS - BODY) / 2; // 100
const RADIUS = Math.round(BODY * 0.2237); // 184
const BG = "#000000"; // keep the dark terminal aesthetic

// Scale the source art so it nicely fits inside the body with its own
// breathing room. 78% of the body looks about right for an iconographic
// element that already has its own visual weight.
const ART_SIZE = Math.round(BODY * 0.78);

const squircle = Buffer.from(
  `<svg width="${CANVAS}" height="${CANVAS}" xmlns="http://www.w3.org/2000/svg">
     <rect x="${INSET}" y="${INSET}" width="${BODY}" height="${BODY}"
           rx="${RADIUS}" ry="${RADIUS}" fill="${BG}"/>
   </svg>`,
);

const art = await sharp(SRC)
  .resize(ART_SIZE, ART_SIZE, {
    fit: "contain",
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  })
  .png()
  .toBuffer();

await sharp({
  create: {
    width: CANVAS,
    height: CANVAS,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
})
  .composite([
    { input: squircle, blend: "over" },
    { input: art, gravity: "center", blend: "over" },
  ])
  .png()
  .toFile(OUT);

console.log(`Wrote ${OUT}  (${CANVAS}x${CANVAS})`);
