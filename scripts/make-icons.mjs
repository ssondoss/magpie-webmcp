import { mkdir, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';

/**
 * Generates the extension icons as PNGs with no image dependencies.
 *
 * The mark is a magpie in silhouette on the accent colour, matching the one the
 * website draws in SVG. Chrome also needs a real icon file for
 * `chrome.notifications`, not just for the toolbar, so this is a build
 * requirement rather than decoration.
 */

const ACCENT = [37, 99, 235];
const WHITE = [255, 255, 255];

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function png(size, pixel) {
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0; // filter: none
    for (let x = 0; x < size; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      const offset = y * (stride + 1) + 1 + x * 4;
      raw[offset] = r;
      raw[offset + 1] = g;
      raw[offset + 2] = b;
      raw[offset + 3] = a;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // truecolour with alpha
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** True when (px,py) is inside an ellipse rotated by `angle` radians. */
function inEllipse(px, py, cx, cy, rx, ry, angle = 0) {
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const dx = px - cx;
  const dy = py - cy;
  const u = (dx * cos - dy * sin) / rx;
  const v = (dx * sin + dy * cos) / ry;
  return u * u + v * v <= 1;
}

/** True when (px,py) is inside the triangle abc. */
function inTriangle(px, py, [ax, ay], [bx, by], [cx, cy]) {
  const sign = (x1, y1, x2, y2, x3, y3) => (x1 - x3) * (y2 - y3) - (x2 - x3) * (y1 - y3);
  const d1 = sign(px, py, ax, ay, bx, by);
  const d2 = sign(px, py, bx, by, cx, cy);
  const d3 = sign(px, py, cx, cy, ax, ay);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

/**
 * A magpie in silhouette, inset in a rounded square.
 *
 * Built from primitives rather than a traced path because these icons are
 * rasterised by hand, a pixel at a time — and because the shape has to stay
 * legible at 16px, where a detailed outline turns to mush. What survives that
 * size is the profile: round head, jutting beak, and the long tail a magpie is
 * recognised by.
 */
function draw(size) {
  const s = (n) => n * size; // fractions of the icon, so every size matches
  const corner = s(0.22);

  return (x, y) => {
    // Rounded-square mask.
    const mx = Math.max(corner - x, 0, x - (size - corner));
    const my = Math.max(corner - y, 0, y - (size - corner));
    if (Math.hypot(mx, my) > corner) return [0, 0, 0, 0];

    // Sample at pixel centres so small sizes stay symmetric.
    const px = x + 0.5;
    const py = y + 0.5;

    const bird =
      // tail: long and tapering, down to the right — the magpie's signature.
      // Its base sits well inside the body so the two read as one silhouette.
      inTriangle(px, py, [s(0.4), s(0.45)], [s(0.93), s(0.84)], [s(0.73), s(0.93)]) ||
      // body
      inEllipse(px, py, s(0.45), s(0.55), s(0.25), s(0.175), -0.55) ||
      // head
      inEllipse(px, py, s(0.33), s(0.32), s(0.15), s(0.14)) ||
      // beak
      inTriangle(px, py, [s(0.22), s(0.31)], [s(0.02), s(0.37)], [s(0.23), s(0.43)]);

    // The eye is punched back out, which is what stops the head reading as a ball.
    const eye = inEllipse(px, py, s(0.385), s(0.275), s(0.04), s(0.04));

    const [r, g, b] = bird && !eye ? WHITE : ACCENT;
    return [r, g, b, 255];
  };
}

await mkdir('public/icons', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  await writeFile(`public/icons/icon${size}.png`, png(size, draw(size)));
}
console.log('[icons] wrote public/icons/icon{16,32,48,128}.png');
