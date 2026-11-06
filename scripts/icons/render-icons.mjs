/**
 * Draws MGM's app icon, a white lightning bolt on the brand primary, and
 * writes every size the app serves into public/:
 *
 *   public/icon.svg                     tab icon for browsers that take SVG
 *   public/favicon.ico                  16, 32 and 48 px, for the rest
 *   public/apple-touch-icon.png         180 px, square (iOS rounds it)
 *   public/icons/icon-192.png           home screen and install, "any"
 *   public/icons/icon-512.png           home screen and install, "any"
 *   public/icons/icon-maskable-512.png  "maskable": the launcher crops it
 *
 *   node scripts/icons/render-icons.mjs [--color '#rrggbb'] [--out <dir>]
 *
 * --out writes the same files under another directory instead of public/.
 *
 * Only Node.js built-ins: the script draws every pixel itself with plain
 * arithmetic, so a run gives the same pixels on any machine. The compressed
 * bytes can differ between zlib builds, so the test compares pixels, not
 * bytes. The files are committed; nothing runs this during a build.
 *
 * --color defaults to PALETTE.light.primary in
 * src/lib/public-html/palette.ts. src/lib/__tests__/app-icons.test.ts runs
 * this script and fails when the committed files differ from what it draws,
 * or when they are not in that colour. After a change to the artwork or the
 * brand colour, re-run it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { crc32, deflateSync } from "node:zlib";

const DEFAULT_COLOR = "#3263c3";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PUBLIC = join(ROOT, "public");

/** The bolt, drawn for MGM, as a polygon in a 100 x 100 box. */
const BOLT = [
  [39, 0],
  [71, 0],
  [55, 38],
  [79, 38],
  [33, 100],
  [45, 54],
  [21, 54],
];

/**
 * `corner` is the background's corner radius and `glyph` the bolt's height,
 * both as a fraction of the icon's side. The maskable bolt reaches about 30%
 * of the side from the centre, inside the 40% circle a launcher keeps.
 */
const ROUNDED = { corner: 0.22, glyph: 0.64 };
const APPLE = { corner: 0, glyph: 0.6 };
const MASKABLE = { corner: 0, glyph: 0.56 };

/** Samples per pixel along each axis, for anti-aliased edges. */
const SAMPLES = 8;

function parseOptions(argv) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        color: { type: "string", default: DEFAULT_COLOR },
        out: { type: "string", default: PUBLIC },
      },
    }));
  } catch (error) {
    console.error(`render-icons: ${error.message}`);
    process.exit(2);
  }
  if (!/^#[0-9a-f]{6}$/i.test(values.color)) {
    console.error("render-icons: --color takes a hex colour like #3263c3");
    process.exit(2);
  }
  return {
    color: [1, 3, 5].map((i) => parseInt(values.color.slice(i, i + 2), 16)),
    out: resolve(values.out),
  };
}

function boltIn(shape) {
  return BOLT.map(([x, y]) => [50 + (x - 50) * shape.glyph, 50 + (y - 50) * shape.glyph]);
}

function inRoundedSquare(x, y, radius) {
  const cx = Math.min(Math.max(x, radius), 100 - radius);
  const cy = Math.min(Math.max(y, radius), 100 - radius);
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
}

function inPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [xi, yi] = points[i];
    const [xj, yj] = points[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** RGBA pixels, straight (not premultiplied) alpha. */
function draw(size, shape, color) {
  const bolt = boltIn(shape);
  const radius = shape.corner * 100;
  const pixels = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let background = 0;
      let glyph = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = ((px + (sx + 0.5) / SAMPLES) * 100) / size;
          const y = ((py + (sy + 0.5) / SAMPLES) * 100) / size;
          if (!inRoundedSquare(x, y, radius)) continue;
          if (inPolygon(x, y, bolt)) glyph++;
          else background++;
        }
      }
      const covered = background + glyph;
      if (covered === 0) continue;
      const at = (py * size + px) * 4;
      for (let c = 0; c < 3; c++) {
        pixels[at + c] = Math.round((color[c] * background + 255 * glyph) / covered);
      }
      pixels[at + 3] = Math.round((255 * covered) / SAMPLES ** 2);
    }
  }
  return pixels;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * A PNG with no metadata chunks. `indexed` stores a palette (the shapes are
 * flat fills, so their edges give well under 256 colours); otherwise RGBA,
 * which is what Windows expects inside an .ico.
 */
function png(size, pixels, { indexed }) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = indexed ? 3 : 6; // palette or RGBA
  const rowBytes = indexed ? size : size * 4;
  const rows = Buffer.alloc((rowBytes + 1) * size); // filter byte 0 (none) per row
  const extra = [];
  if (indexed) {
    const index = new Map();
    const colours = [];
    for (let i = 0; i < size * size; i++) {
      const key = pixels.readUInt32BE(i * 4);
      let entry = index.get(key);
      if (entry === undefined) {
        entry = colours.length;
        if (entry === 256) throw new Error("render-icons: more than 256 colours; cannot index");
        index.set(key, entry);
        colours.push(key);
      }
      rows[Math.floor(i / size) * (rowBytes + 1) + 1 + (i % size)] = entry;
    }
    const palette = Buffer.alloc(colours.length * 3);
    const alpha = Buffer.alloc(colours.length);
    colours.forEach((key, i) => {
      palette.writeUIntBE(key >>> 8, i * 3, 3);
      alpha[i] = key & 0xff;
    });
    extra.push(chunk("PLTE", palette));
    if (alpha.some((a) => a !== 255)) extra.push(chunk("tRNS", alpha));
  } else {
    for (let y = 0; y < size; y++) {
      pixels.copy(rows, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    ...extra,
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** An .ico holding one PNG per size (supported since Windows Vista). */
function ico(images) {
  const directory = Buffer.alloc(6 + 16 * images.length);
  directory.writeUInt16LE(1, 2); // type: icon
  directory.writeUInt16LE(images.length, 4);
  let offset = directory.length;
  images.forEach(({ size, data }, i) => {
    const entry = 6 + 16 * i;
    directory[entry] = size; // width (all sizes here are under 256)
    directory[entry + 1] = size; // height
    directory.writeUInt16LE(1, entry + 4); // colour planes
    directory.writeUInt16LE(32, entry + 6); // bits per pixel
    directory.writeUInt32LE(data.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += data.length;
  });
  return Buffer.concat([directory, ...images.map((image) => image.data)]);
}

function svg(color) {
  const hex = `#${color.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
  const points = boltIn(ROUNDED)
    .map(([x, y]) => `${Number(x.toFixed(2))},${Number(y.toFixed(2))}`)
    .join(" ");
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">` +
    `<rect width="100" height="100" rx="${ROUNDED.corner * 100}" fill="${hex}"/>` +
    `<polygon points="${points}" fill="#fff"/></svg>\n`
  );
}

const { color, out } = parseOptions(process.argv.slice(2));
const files = {
  "icon.svg": Buffer.from(svg(color)),
  "favicon.ico": ico(
    [16, 32, 48].map((size) => ({
      size,
      data: png(size, draw(size, ROUNDED, color), { indexed: false }),
    })),
  ),
  "apple-touch-icon.png": png(180, draw(180, APPLE, color), { indexed: true }),
  "icons/icon-192.png": png(192, draw(192, ROUNDED, color), { indexed: true }),
  "icons/icon-512.png": png(512, draw(512, ROUNDED, color), { indexed: true }),
  "icons/icon-maskable-512.png": png(512, draw(512, MASKABLE, color), { indexed: true }),
};

for (const [name, data] of Object.entries(files)) {
  const file = join(out, name);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
  const shown = relative(ROOT, file);
  console.log(`${shown.startsWith("..") ? file : shown}  ${data.length} bytes`);
}
