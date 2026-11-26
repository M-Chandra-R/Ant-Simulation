// Deterministic 2D/3D Gradient, FBM, Ridge, and Voronoi Noise utilities
// Used across procedural PBR textures, terrain heightfield, wind sync, and organic geometry

const PERM = new Uint8Array(512);
const GRAD3 = [
  [1, 1, 0], [-1, 1, 0], [1, -1, 0], [-1, -1, 0],
  [1, 0, 1], [-1, 0, 1], [1, 0, -1], [-1, 0, -1],
  [0, 1, 1], [0, -1, 1], [0, 1, -1], [0, -1, -1]
];

(function initSeed(seed = 133742) {
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  let s = seed >>> 0;
  for (let i = 255; i > 0; i--) {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    const j = s % (i + 1);
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  for (let i = 0; i < 512; i++) {
    PERM[i] = p[i & 255];
  }
})();

function fade(t) {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a, b, t) {
  return a + t * (b - a);
}

export function noise2D(x, y) {
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;
  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);

  const u = fade(xf);
  const v = fade(yf);

  const aa = PERM[PERM[X] + Y] % 12;
  const ab = PERM[PERM[X] + Y + 1] % 12;
  const ba = PERM[PERM[X + 1] + Y] % 12;
  const bb = PERM[PERM[X + 1] + Y + 1] % 12;

  const gAA = GRAD3[aa][0] * xf + GRAD3[aa][1] * yf;
  const gBA = GRAD3[ba][0] * (xf - 1) + GRAD3[ba][1] * yf;
  const gAB = GRAD3[ab][0] * xf + GRAD3[ab][1] * (yf - 1);
  const gBB = GRAD3[bb][0] * (xf - 1) + GRAD3[bb][1] * (yf - 1);

  return lerp(lerp(gAA, gBA, u), lerp(gAB, gBB, u), v);
}

export function noise3D(x, y, z) {
  const X = Math.floor(x) & 255;
  const Y = Math.floor(y) & 255;
  const Z = Math.floor(z) & 255;

  const xf = x - Math.floor(x);
  const yf = y - Math.floor(y);
  const zf = z - Math.floor(z);

  const u = fade(xf);
  const v = fade(yf);
  const w = fade(zf);

  const A = PERM[X] + Y;
  const AA = PERM[A] + Z;
  const AB = PERM[A + 1] + Z;
  const B = PERM[X + 1] + Y;
  const BA = PERM[B] + Z;
  const BB = PERM[B + 1] + Z;

  const g000 = GRAD3[PERM[AA] % 12];
  const g100 = GRAD3[PERM[BA] % 12];
  const g010 = GRAD3[PERM[AB] % 12];
  const g110 = GRAD3[PERM[BB] % 12];
  const g001 = GRAD3[PERM[AA + 1] % 12];
  const g101 = GRAD3[PERM[BA + 1] % 12];
  const g011 = GRAD3[PERM[AB + 1] % 12];
  const g111 = GRAD3[PERM[BB + 1] % 12];

  const n000 = g000[0] * xf + g000[1] * yf + g000[2] * zf;
  const n100 = g100[0] * (xf - 1) + g100[1] * yf + g100[2] * zf;
  const n010 = g010[0] * xf + g010[1] * (yf - 1) + g010[2] * zf;
  const n110 = g110[0] * (xf - 1) + g110[1] * (yf - 1) + g110[2] * zf;
  const n001 = g001[0] * xf + g001[1] * yf + g001[2] * (zf - 1);
  const n101 = g101[0] * (xf - 1) + g101[1] * yf + g101[2] * (zf - 1);
  const n011 = g011[0] * xf + g011[1] * (yf - 1) + g011[2] * (zf - 1);
  const n111 = g111[0] * (xf - 1) + g111[1] * (yf - 1) + g111[2] * (zf - 1);

  return lerp(
    lerp(lerp(n000, n100, u), lerp(n010, n110, u), v),
    lerp(lerp(n001, n101, u), lerp(n011, n111, u), v),
    w
  );
}

export function fbm2D(x, y, octaves = 5, lacunarity = 2.02, gain = 0.5) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1.0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise2D(x * freq, y * freq);
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum / norm;
}

export function fbm3D(x, y, z, octaves = 4, lacunarity = 2.05, gain = 0.5) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1.0;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * noise3D(x * freq, y * freq, z * freq);
    norm += amp;
    freq *= lacunarity;
    amp *= gain;
  }
  return sum / norm;
}

// Tileable 2D noise on period [0, period) so procedural textures wrap seamlessly
export function tileableNoise2D(u, v, period = 8) {
  const s = u * period;
  const t = v * period;
  const ix0 = Math.floor(s);
  const iy0 = Math.floor(t);
  const fx = s - ix0;
  const fy = t - iy0;
  const ux = fade(fx);
  const uy = fade(fy);

  const wrap = (n) => ((n % period) + period) % period;
  const x0 = wrap(ix0) & 255;
  const x1 = wrap(ix0 + 1) & 255;
  const y0 = wrap(iy0) & 255;
  const y1 = wrap(iy0 + 1) & 255;

  const aa = PERM[PERM[x0] + y0] % 12;
  const ab = PERM[PERM[x0] + y1] % 12;
  const ba = PERM[PERM[x1] + y0] % 12;
  const bb = PERM[PERM[x1] + y1] % 12;

  const gAA = GRAD3[aa][0] * fx + GRAD3[aa][1] * fy;
  const gBA = GRAD3[ba][0] * (fx - 1) + GRAD3[ba][1] * fy;
  const gAB = GRAD3[ab][0] * fx + GRAD3[ab][1] * (fy - 1);
  const gBB = GRAD3[bb][0] * (fx - 1) + GRAD3[bb][1] * (fy - 1);

  return lerp(lerp(gAA, gBA, ux), lerp(gAB, gBB, ux), uy);
}

export function tileableFbm2D(u, v, basePeriod = 6, octaves = 5, gain = 0.5) {
  let sum = 0;
  let amp = 0.5;
  let norm = 0;
  let p = basePeriod;
  for (let i = 0; i < octaves; i++) {
    sum += amp * tileableNoise2D(u, v, p);
    norm += amp;
    p *= 2;
    amp *= gain;
  }
  return sum / norm;
}

// Tileable cellular Voronoi for soil granules, moss clumps, and leaf cell micro-relief
export function tileableVoronoi2D(u, v, cells = 12) {
  const gx = u * cells;
  const gy = v * cells;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = gx - ix;
  const fy = gy - iy;

  let minDist1 = 8.0;
  let minDist2 = 8.0;

  const wrap = (n) => ((n % cells) + cells) % cells;

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const cx = wrap(ix + dx);
      const cy = wrap(iy + dy);
      const h1 = PERM[(PERM[cx & 255] + (cy & 255)) & 511] / 255;
      const h2 = PERM[(PERM[(cx + 37) & 255] + ((cy + 91) & 255)) & 511] / 255;
      const px = dx + 0.15 + 0.7 * h1 - fx;
      const py = dy + 0.15 + 0.7 * h2 - fy;
      const d = Math.hypot(px, py);
      if (d < minDist1) {
        minDist2 = minDist1;
        minDist1 = d;
      } else if (d < minDist2) {
        minDist2 = d;
      }
    }
  }
  return { f1: minDist1, edge: minDist2 - minDist1 };
}

export function seededRandom(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(1664525, s) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
