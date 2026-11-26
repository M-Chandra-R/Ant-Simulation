import * as THREE from 'three';
import { tileableFbm2D, tileableVoronoi2D, fbm2D } from '../math/Noise.js';

/**
 * Generates high-resolution, realistic organic PBR texture maps (Color, Normal, Roughness, Alpha)
 * and a rich forest-canopy sunbreak PMREM environment map.
 * All textures use smooth anisotropic mipmapping — zero pixelation or flat-poly look.
 */
export function generateAllTextures(renderer, onProgress = () => {}) {
  const maxAniso = Math.min(16, renderer.capabilities.getMaxAnisotropy());

  const configureTex = (tex, { srgb = false, repeat = 1, clamp = false } = {}) => {
    tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    tex.wrapS = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    tex.wrapT = clamp ? THREE.ClampToEdgeWrapping : THREE.RepeatWrapping;
    if (repeat !== 1) {
      tex.repeat.set(repeat, repeat);
    }
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = maxAniso;
    tex.needsUpdate = true;
    return tex;
  };

  // Convert floating-point height buffer [w * h] into tangent-space RGBA normal DataTexture
  const heightToNormalTexture = (heightBuf, w, h, strength = 3.0, clamp = false) => {
    const data = new Uint8Array(w * h * 4);
    const idx = (x, y) => {
      const wx = clamp ? Math.max(0, Math.min(w - 1, x)) : ((x % w) + w) % w;
      const wy = clamp ? Math.max(0, Math.min(h - 1, y)) : ((y % h) + h) % h;
      return wy * w + wx;
    };

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const hL = heightBuf[idx(x - 1, y)];
        const hR = heightBuf[idx(x + 1, y)];
        const hD = heightBuf[idx(x, y - 1)];
        const hU = heightBuf[idx(x, y + 1)];

        const dx = (hL - hR) * strength;
        const dy = (hD - hU) * strength;
        const dz = 1.0;
        const invLen = 1.0 / Math.hypot(dx, dy, dz);

        const o = (y * w + x) * 4;
        data[o] = Math.round((dx * invLen * 0.5 + 0.5) * 255);
        data[o + 1] = Math.round((dy * invLen * 0.5 + 0.5) * 255);
        data[o + 2] = Math.round((dz * invLen * 0.5 + 0.5) * 255);
        data[o + 3] = 255;
      }
    }
    return configureTex(new THREE.DataTexture(data, w, h, THREE.RGBAFormat), { clamp });
  };

  onProgress(0.15, 'Synthesizing wet soil, humus & moss PBR maps...');
  const soil = buildWetSoilPBR(configureTex, heightToNormalTexture);

  onProgress(0.35, 'Weaving vascular grass blade & wet cuticle textures...');
  const grass = buildGrassBladePBR(configureTex, heightToNormalTexture);

  onProgress(0.55, 'Sculpting broadleaf veins, clover & fern frond maps...');
  const clover = buildCloverLeafPBR(configureTex, heightToNormalTexture);
  const fern = buildFernFrondPBR(configureTex, heightToNormalTexture);

  onProgress(0.72, 'Generating ancient wet bark, mossy stone & mushroom gills...');
  const bark = buildWetBarkPBR(configureTex, heightToNormalTexture);
  const stone = buildMossyStonePBR(configureTex, heightToNormalTexture);
  const mushroom = buildMushroomCapPBR(configureTex, heightToNormalTexture);
  const bokeh = buildSoftBokehTexture(configureTex);

  onProgress(0.88, 'Baking sunlit forest canopy HDR-style environment reflections...');
  const envMap = buildCanopyEnvironmentMap(renderer);

  return {
    soil,
    grass,
    clover,
    fern,
    bark,
    stone,
    mushroom,
    bokeh,
    envMap
  };
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/**
 * 1. Wet Forest Soil & Mossy Humus PBR (512x512 seamless)
 */
function buildWetSoilPBR(configureTex, heightToNormalTexture) {
  const size = 512;
  const colorData = new Uint8Array(size * size * 4);
  const roughData = new Uint8Array(size * size * 4);
  const heightBuf = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;

      const macro = tileableFbm2D(u, v, 4, 5, 0.52); // [-0.6, 0.6]
      const fine = tileableFbm2D(u + 0.31, v + 0.17, 16, 4, 0.55);
      const granules = tileableVoronoi2D(u, v, 28);
      const pebbles = tileableVoronoi2D(u + 0.4, v + 0.2, 10);

      // Organic rootlets / pine-needle humus streaks
      const fiberWave = Math.abs(tileableFbm2D(u * 1.0, v * 1.0, 12, 3, 0.5));
      const rootMask = smoothstep(0.035, 0.0, fiberWave) * 0.45;

      // Mossy cushion patches thriving on damp soil
      const mossMask = smoothstep(0.08, 0.34, macro + fine * 0.25);

      const pebbleBump = smoothstep(0.24, 0.02, pebbles.f1) * 0.38;
      const crumbBump = (1.0 - clamp01(granules.f1 * 1.6)) * 0.28;
      const h = macro * 0.45 + fine * 0.22 + crumbBump + pebbleBump + rootMask * 0.25;
      heightBuf[i] = h;

      // Base damp soil colors (rich dark umber -> warm humus -> lush emerald moss)
      let r = 34 + crumbBump * 36 + pebbleBump * 42 + rootMask * 38;
      let g = 25 + crumbBump * 27 + pebbleBump * 38 + rootMask * 28;
      let b = 18 + crumbBump * 18 + pebbleBump * 34 + rootMask * 16;

      // Blend rich velvety forest moss
      const mossR = 36 + fine * 26 + granules.edge * 22;
      const mossG = 68 + fine * 34 + granules.edge * 30;
      const mossB = 26 + fine * 14;

      r = r * (1 - mossMask) + mossR * mossMask;
      g = g * (1 - mossMask) + mossG * mossMask;
      b = b * (1 - mossMask) + mossB * mossMask;

      // Wet micro-film in depressions (darker saturated color + low roughness)
      const wetness = smoothstep(0.18, -0.22, h);
      const wetDarken = 1.0 - wetness * 0.32;

      const o = i * 4;
      colorData[o] = clamp01((r * wetDarken) / 255) * 255;
      colorData[o + 1] = clamp01((g * wetDarken) / 255) * 255;
      colorData[o + 2] = clamp01((b * wetDarken) / 255) * 255;
      colorData[o + 3] = 255;

      // Roughness: wet soil pockets ~0.12, damp earth ~0.48, mossy tufts ~0.68
      const baseRough = 0.48 * (1 - mossMask) + 0.68 * mossMask - pebbleBump * 0.22;
      const finalRough = clamp01(baseRough * (1 - wetness * 0.76) + 0.07);
      const rv = Math.round(finalRough * 255);
      roughData[o] = rv;
      roughData[o + 1] = rv;
      roughData[o + 2] = rv;
      roughData[o + 3] = 255;
    }
  }

  const map = configureTex(new THREE.DataTexture(colorData, size, size, THREE.RGBAFormat), {
    srgb: true,
    repeat: 14
  });
  const roughnessMap = configureTex(new THREE.DataTexture(roughData, size, size, THREE.RGBAFormat), {
    repeat: 14
  });
  const normalMap = heightToNormalTexture(heightBuf, size, size, 4.2, false);
  normalMap.repeat.set(14, 14);

  return { map, normalMap, roughnessMap };
}

/**
 * 2. Vascular Grass Blade PBR (128x512 clamped)
 * Parallel longitudinal veins, central midrib, wet sheen streaks, natural chlorophyll gradient
 */
function buildGrassBladePBR(configureTex, heightToNormalTexture) {
  const w = 128;
  const h = 512;
  const colorData = new Uint8Array(w * h * 4);
  const roughData = new Uint8Array(w * h * 4);
  const heightBuf = new Float32Array(w * h);

  for (let y = 0; y < h; y++) {
    const v = y / (h - 1); // 0 = root base, 1 = blade tip
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1); // 0..1 across width
      const i = y * w + x;

      const centerDist = Math.abs(u - 0.5) * 2.0; // 0 at midrib, 1 at edge

      // Parallel vascular ridges (18 fine longitudinal veins + prominent central midrib)
      const veins = Math.sin(u * Math.PI * 22.0) * 0.5 + 0.5;
      const fineStriation = Math.sin(u * Math.PI * 58.0) * 0.5 + 0.5;
      const midrib = Math.exp(-Math.pow(centerDist * 7.5, 2.0));
      const organicVar = fbm2D(u * 4.5, v * 9.0, 4);

      const bladeRelief = midrib * 0.55 + veins * 0.28 + fineStriation * 0.08 + organicVar * 0.08;
      heightBuf[i] = bladeRelief;

      // Natural botanical gradient: pale chartreuse/olive stem -> deep lush emerald -> warm sunlit tip
      const rootBlend = smoothstep(0.22, 0.0, v);
      const tipBlend = smoothstep(0.68, 1.0, v);

      let r = 46 + veins * 14 + midrib * 22 + organicVar * 18;
      let g = 112 + veins * 22 + midrib * 24 + organicVar * 22;
      let b = 32 + veins * 8 + midrib * 10 + organicVar * 8;

      // Warmer pale sheath near soil
      r = r * (1 - rootBlend * 0.45) + 92 * (rootBlend * 0.45);
      g = g * (1 - rootBlend * 0.35) + 108 * (rootBlend * 0.35);
      b = b * (1 - rootBlend * 0.35) + 46 * (rootBlend * 0.35);

      // Sun-kissed golden-lime translucency near tip & margins
      const marginGlow = smoothstep(0.65, 1.0, centerDist) * 0.22;
      r += tipBlend * 38 + marginGlow * 28;
      g += tipBlend * 30 + marginGlow * 26;
      b += tipBlend * 6;

      // Wet rain film streaks along blade
      const wetStreak = smoothstep(0.05, 0.35, fbm2D(u * 8.0 + 3.1, v * 3.5, 3));
      const rough = clamp01(0.36 - wetStreak * 0.22 + veins * 0.06);

      const o = i * 4;
      colorData[o] = clamp01(r / 255) * 255;
      colorData[o + 1] = clamp01(g / 255) * 255;
      colorData[o + 2] = clamp01(b / 255) * 255;
      colorData[o + 3] = 255;

      const rv = Math.round(rough * 255);
      roughData[o] = rv;
      roughData[o + 1] = rv;
      roughData[o + 2] = rv;
      roughData[o + 3] = 255;
    }
  }

  const map = configureTex(new THREE.DataTexture(colorData, w, h, THREE.RGBAFormat), {
    srgb: true,
    clamp: true
  });
  const roughnessMap = configureTex(new THREE.DataTexture(roughData, w, h, THREE.RGBAFormat), {
    clamp: true
  });
  const normalMap = heightToNormalTexture(heightBuf, w, h, 2.8, true);

  return { map, normalMap, roughnessMap };
}

/**
 * 3. Clover / Heart-Shaped Forest Leaflet PBR with branching veins & crisp alpha
 */
function buildCloverLeafPBR(configureTex, heightToNormalTexture) {
  const size = 256;
  const colorData = new Uint8Array(size * size * 4);
  const roughData = new Uint8Array(size * size * 4);
  const heightBuf = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / (size - 1); // 0 = stem base, 1 = outer notch
    for (let x = 0; x < size; x++) {
      const u = (x / (size - 1)) * 2 - 1; // -1..1
      const i = y * size + x;

      // Smooth heart/obcordate leaflet silhouette
      const ny = v * 1.18 - 0.08;
      const halfWidth = Math.sin(clamp01(ny) * Math.PI * 0.92) * (0.42 + 0.48 * clamp01(ny));
      const topNotch = smoothstep(0.78, 1.02, ny) * Math.exp(-Math.pow(u * 5.2, 2.0)) * 0.16;
      const effectiveHalfWidth = Math.max(0.001, halfWidth - topNotch);
      const distRatio = Math.abs(u) / effectiveHalfWidth;

      const inside = ny > 0.0 && ny < 1.02 ? smoothstep(1.02, 0.94, distRatio) : 0.0;

      // Central midrib + chevron secondary veins + cellular network
      const midrib = Math.exp(-Math.pow(u * 18.0, 2.0));
      const veinCoord = (ny * 14.0 - Math.abs(u) * 9.5);
      const chevronVeins = Math.pow(Math.max(0, Math.cos(veinCoord * Math.PI)), 6.0) * (1 - distRatio * 0.4);
      const cells = tileableVoronoi2D((u + 1) * 0.5, v, 24);

      const h = (midrib * 0.5 + chevronVeins * 0.28 + (1 - clamp01(cells.f1 * 1.8)) * 0.14) * inside;
      heightBuf[i] = h;

      // Subtle pale V-shaped chevron variegation typical of wild white/wood clover
      const vMark = Math.exp(-Math.pow((ny - 0.42 - Math.abs(u) * 0.38) * 11.0, 2.0)) * smoothstep(0.85, 0.2, distRatio);

      let r = 42 + chevronVeins * 18 + midrib * 24 + vMark * 62;
      let g = 108 + chevronVeins * 26 + midrib * 28 + vMark * 68;
      let b = 36 + chevronVeins * 10 + vMark * 44;

      const wetGloss = 0.18 + cells.edge * 0.16;

      const o = i * 4;
      colorData[o] = clamp01(r / 255) * 255;
      colorData[o + 1] = clamp01(g / 255) * 255;
      colorData[o + 2] = clamp01(b / 255) * 255;
      colorData[o + 3] = Math.round(inside * 255);

      const rv = Math.round(clamp01(wetGloss) * 255);
      roughData[o] = rv;
      roughData[o + 1] = rv;
      roughData[o + 2] = rv;
      roughData[o + 3] = 255;
    }
  }

  const map = configureTex(new THREE.DataTexture(colorData, size, size, THREE.RGBAFormat), {
    srgb: true,
    clamp: true
  });
  const roughnessMap = configureTex(new THREE.DataTexture(roughData, size, size, THREE.RGBAFormat), {
    clamp: true
  });
  const normalMap = heightToNormalTexture(heightBuf, size, size, 3.0, true);

  return { map, normalMap, roughnessMap };
}

/**
 * 4. Pinnate Woodland Fern Frond PBR (256x512 with delicate pinnae alpha)
 */
function buildFernFrondPBR(configureTex, heightToNormalTexture) {
  const w = 256;
  const h = 512;
  const colorData = new Uint8Array(w * h * 4);
  const heightBuf = new Float32Array(w * h);

  for (let y = 0; y < h; y++) {
    const v = y / (h - 1); // 0 = stem base, 1 = frond apex
    for (let x = 0; x < w; x++) {
      const u = (x / (w - 1)) * 2 - 1; // -1..1
      const i = y * w + x;

      // Central rachis stem
      const stemHalfW = 0.028 * (1 - v * 0.72);
      const stemMask = smoothstep(stemHalfW * 1.4, stemHalfW * 0.6, Math.abs(u));

      // Tapered envelope of pinnae (leaflets) starting at v = 0.1
      let pinnaMask = 0;
      let pinnaVein = 0;
      if (v > 0.08 && v < 0.985) {
        const frondEnv = Math.sin(Math.pow((v - 0.08) / 0.905, 0.72) * Math.PI) * 0.92;
        const absU = Math.abs(u);
        if (absU <= frondEnv + 0.04) {
          // Alternating pairs of curved pinnae along rachis
          const sideOffset = u > 0 ? 0.0 : 0.25;
          const pinnaFreq = 18.0;
          const localV = v * pinnaFreq + sideOffset - absU * 1.45;
          const cell = localV - Math.floor(localV); // 0..1 across one pinna width
          const alongPinna = clamp01(absU / Math.max(0.04, frondEnv));

          // Smooth serrulate pinna profile
          const lobe = 1.0 + 0.12 * Math.sin(alongPinna * Math.PI * 6.0);
          const halfPinna = 0.37 * (1.0 - Math.pow(alongPinna, 1.65)) * lobe;
          const distFromPinnaCenter = Math.abs(cell - 0.5);

          pinnaMask = smoothstep(halfPinna + 0.06, halfPinna - 0.04, distFromPinnaCenter) *
                      smoothstep(1.02, 0.9, alongPinna);
          pinnaVein = Math.exp(-Math.pow(distFromPinnaCenter * 12.0, 2.0)) * pinnaMask;
        }
      }

      const alpha = Math.max(stemMask, pinnaMask);
      const relief = stemMask * 0.65 + pinnaVein * 0.35 + pinnaMask * 0.15;
      heightBuf[i] = relief;

      const tipWarm = smoothstep(0.6, 1.0, v);
      const r = 38 + stemMask * 26 + pinnaVein * 20 + tipWarm * 34;
      const g = 98 + stemMask * 16 + pinnaVein * 28 + tipWarm * 36;
      const b = 28 + stemMask * 10 + tipWarm * 8;

      const o = i * 4;
      colorData[o] = clamp01(r / 255) * 255;
      colorData[o + 1] = clamp01(g / 255) * 255;
      colorData[o + 2] = clamp01(b / 255) * 255;
      colorData[o + 3] = Math.round(alpha * 255);
    }
  }

  const map = configureTex(new THREE.DataTexture(colorData, w, h, THREE.RGBAFormat), {
    srgb: true,
    clamp: true
  });
  const normalMap = heightToNormalTexture(heightBuf, w, h, 3.2, true);
  return { map, normalMap };
}

/**
 * 5. Wet Ancient Tree Bark & Root PBR (512x512 seamless)
 */
function buildWetBarkPBR(configureTex, heightToNormalTexture) {
  const size = 512;
  const colorData = new Uint8Array(size * size * 4);
  const roughData = new Uint8Array(size * size * 4);
  const heightBuf = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;

      // Anisotropic vertical fissures stretched along v
      const warp = tileableFbm2D(u, v, 4, 4, 0.5) * 0.08;
      const ridgeRaw = tileableFbm2D(u + warp, v * 0.25, 10, 5, 0.55);
      const fissure = Math.pow(clamp01(ridgeRaw + 0.55), 1.6);
      const microGrain = tileableFbm2D(u, v, 24, 3, 0.5) * 0.15;

      // Damp moss nestled inside bark crevices & lower root pockets
      const mossNoise = tileableFbm2D(u + 0.2, v + 0.5, 6, 4, 0.55);
      const mossMask = smoothstep(0.12, 0.36, mossNoise - fissure * 0.28);

      const h = fissure * 0.75 + microGrain + mossMask * 0.18;
      heightBuf[i] = h;

      let r = 42 + fissure * 46 + microGrain * 24;
      let g = 31 + fissure * 34 + microGrain * 18;
      let b = 23 + fissure * 24 + microGrain * 12;

      r = r * (1 - mossMask) + (38 + microGrain * 30) * mossMask;
      g = g * (1 - mossMask) + (82 + microGrain * 42) * mossMask;
      b = b * (1 - mossMask) + (28 + microGrain * 16) * mossMask;

      // Rainwater darkens bark channels
      const wetChannel = smoothstep(0.55, 0.22, fissure);
      const darken = 1.0 - wetChannel * 0.34;

      const o = i * 4;
      colorData[o] = clamp01((r * darken) / 255) * 255;
      colorData[o + 1] = clamp01((g * darken) / 255) * 255;
      colorData[o + 2] = clamp01((b * darken) / 255) * 255;
      colorData[o + 3] = 255;

      const rough = clamp01((0.68 - wetChannel * 0.45) * (1 - mossMask) + 0.74 * mossMask);
      const rv = Math.round(rough * 255);
      roughData[o] = rv;
      roughData[o + 1] = rv;
      roughData[o + 2] = rv;
      roughData[o + 3] = 255;
    }
  }

  const map = configureTex(new THREE.DataTexture(colorData, size, size, THREE.RGBAFormat), {
    srgb: true,
    repeat: 3
  });
  const roughnessMap = configureTex(new THREE.DataTexture(roughData, size, size, THREE.RGBAFormat), {
    repeat: 3
  });
  const normalMap = heightToNormalTexture(heightBuf, size, size, 4.8, false);
  normalMap.repeat.set(3, 3);

  return { map, normalMap, roughnessMap };
}

/**
 * 6. Wet Mossy River Stone PBR (512x512 seamless)
 */
function buildMossyStonePBR(configureTex, heightToNormalTexture) {
  const size = 512;
  const colorData = new Uint8Array(size * size * 4);
  const roughData = new Uint8Array(size * size * 4);
  const heightBuf = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / size;
    for (let x = 0; x < size; x++) {
      const u = x / size;
      const i = y * size + x;

      const base = tileableFbm2D(u, v, 6, 5, 0.5);
      const mineral = tileableVoronoi2D(u, v, 32);
      const moss = smoothstep(0.16, 0.38, tileableFbm2D(u + 0.4, v + 0.2, 4, 4, 0.55));

      const h = base * 0.45 + mineral.edge * 0.18 + moss * 0.24;
      heightBuf[i] = h;

      const speckle = smoothstep(0.05, 0.25, mineral.f1);
      let r = 64 + base * 30 + speckle * 22;
      let g = 68 + base * 30 + speckle * 22;
      let b = 65 + base * 26 + speckle * 20;

      r = r * (1 - moss) + 42 * moss;
      g = g * (1 - moss) + 86 * moss;
      b = b * (1 - moss) + 32 * moss;

      // Rain-slicked stone surface
      const rough = clamp01(0.16 + Math.abs(base) * 0.22 + moss * 0.52);

      const o = i * 4;
      colorData[o] = clamp01(r / 255) * 255;
      colorData[o + 1] = clamp01(g / 255) * 255;
      colorData[o + 2] = clamp01(b / 255) * 255;
      colorData[o + 3] = 255;

      const rv = Math.round(rough * 255);
      roughData[o] = rv;
      roughData[o + 1] = rv;
      roughData[o + 2] = rv;
      roughData[o + 3] = 255;
    }
  }

  const map = configureTex(new THREE.DataTexture(colorData, size, size, THREE.RGBAFormat), {
    srgb: true,
    repeat: 2
  });
  const roughnessMap = configureTex(new THREE.DataTexture(roughData, size, size, THREE.RGBAFormat), {
    repeat: 2
  });
  const normalMap = heightToNormalTexture(heightBuf, size, size, 2.6, false);
  normalMap.repeat.set(2, 2);

  return { map, normalMap, roughnessMap };
}

/**
 * 7. Translucent Woodland Mushroom Cap & Gill Texture
 */
function buildMushroomCapPBR(configureTex, heightToNormalTexture) {
  const size = 256;
  const colorData = new Uint8Array(size * size * 4);
  const heightBuf = new Float32Array(size * size);

  for (let y = 0; y < size; y++) {
    const v = y / (size - 1); // 0 = cap apex, 1 = outer rim / gills
    for (let x = 0; x < size; x++) {
      const u = x / (size - 1);
      const i = y * size + x;

      const striations = Math.sin(u * Math.PI * 72.0) * 0.5 + 0.5;
      const organic = tileableFbm2D(u, v, 8, 3, 0.5);

      const h = striations * smoothstep(0.25, 0.95, v) * 0.35 + organic * 0.2;
      heightBuf[i] = h;

      // Warm honey-amber apex fading to translucent ivory-peach margin
      const apex = smoothstep(0.65, 0.0, v);
      const r = 205 - apex * 32 + organic * 20;
      const g = 166 - apex * 56 + striations * 14 + organic * 16;
      const b = 122 - apex * 64 + striations * 12;

      const o = i * 4;
      colorData[o] = clamp01(r / 255) * 255;
      colorData[o + 1] = clamp01(g / 255) * 255;
      colorData[o + 2] = clamp01(b / 255) * 255;
      colorData[o + 3] = 255;
    }
  }

  const map = configureTex(new THREE.DataTexture(colorData, size, size, THREE.RGBAFormat), {
    srgb: true
  });
  const normalMap = heightToNormalTexture(heightBuf, size, size, 2.2, false);
  return { map, normalMap };
}

/**
 * 8. Smooth Optical Bokeh Disc for floating sunlit mist & pollen motes
 */
function buildSoftBokehTexture(configureTex) {
  const size = 128;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const dy = (y / (size - 1)) * 2 - 1;
    for (let x = 0; x < size; x++) {
      const dx = (x / (size - 1)) * 2 - 1;
      const r = Math.hypot(dx, dy);
      // Soft optical aperture disc with delicate airy rim
      const core = smoothstep(1.0, 0.15, r);
      const rim = Math.exp(-Math.pow((r - 0.72) * 5.5, 2.0)) * 0.28 * smoothstep(1.02, 0.88, r);
      const alpha = clamp01(core * 0.85 + rim);
      const o = (y * size + x) * 4;
      data[o] = 255;
      data[o + 1] = 250;
      data[o + 2] = 235;
      data[o + 3] = Math.round(alpha * 255);
    }
  }
  return configureTex(new THREE.DataTexture(data, size, size, THREE.RGBAFormat), {
    srgb: true,
    clamp: true
  });
}

/**
 * 9. Equirectangular Forest Canopy + Golden Sunbreak Environment Map -> PMREM
 * Gives water droplets authentic refractive upside-down forest canopy & sun glints!
 */
function buildCanopyEnvironmentMap(renderer) {
  const w = 512;
  const h = 256;
  const halfFloatData = new Uint16Array(w * h * 4);

  const sunDir = new THREE.Vector3(0.52, 0.42, -0.74).normalize();
  const dir = new THREE.Vector3();

  for (let y = 0; y < h; y++) {
    const v = y / (h - 1); // 0 = bottom, 1 = zenith
    const theta = (1.0 - v) * Math.PI;
    const sinTheta = Math.sin(theta);
    const cosTheta = Math.cos(theta);

    for (let x = 0; x < w; x++) {
      const u = x / w;
      const phi = u * Math.PI * 2.0;

      dir.set(
        -sinTheta * Math.sin(phi),
        cosTheta,
        -sinTheta * Math.cos(phi)
      );

      let r, g, b;
      if (dir.y >= -0.05) {
        const up = clamp01((dir.y + 0.05) / 1.05);
        // Misty post-rain sky gradient (warm golden-cream horizon -> fresh celadon sky)
        const skyR = 0.58 * (1 - up) + 0.34 * up;
        const skyG = 0.68 * (1 - up) + 0.56 * up;
        const skyB = 0.54 * (1 - up) + 0.66 * up;

        // Overhead forest leaf canopy openings (dappled light!)
        const canopyNoise = tileableFbm2D(u, v, 8, 4, 0.55);
        const canopyDensity = smoothstep(-0.08, 0.24, canopyNoise + up * 0.14) * smoothstep(-0.02, 0.22, dir.y);

        const leafR = 0.06 + Math.max(0, canopyNoise) * 0.12;
        const leafG = 0.18 + Math.max(0, canopyNoise) * 0.24;
        const leafB = 0.05 + Math.max(0, canopyNoise) * 0.06;

        r = skyR * (1 - canopyDensity * 0.82) + leafR * (canopyDensity * 0.82);
        g = skyG * (1 - canopyDensity * 0.82) + leafG * (canopyDensity * 0.82);
        b = skyB * (1 - canopyDensity * 0.82) + leafB * (canopyDensity * 0.82);

        // Brilliant golden sunbreak piercing canopy gap
        const sunDot = Math.max(0, dir.dot(sunDir));
        const sunHalo = Math.pow(sunDot, 14.0) * 2.2;
        const sunCore = Math.pow(sunDot, 220.0) * 14.0;
        r += sunHalo * 1.1 + sunCore * 1.3;
        g += sunHalo * 0.88 + sunCore * 1.12;
        b += sunHalo * 0.52 + sunCore * 0.78;
      } else {
        // Damp mossy forest floor bounce light
        const down = clamp01(-dir.y);
        r = 0.05 * (1 - down * 0.6);
        g = 0.09 * (1 - down * 0.5);
        b = 0.04 * (1 - down * 0.6);
      }

      const o = (y * w + x) * 4;
      halfFloatData[o] = THREE.DataUtils.toHalfFloat(r);
      halfFloatData[o + 1] = THREE.DataUtils.toHalfFloat(g);
      halfFloatData[o + 2] = THREE.DataUtils.toHalfFloat(b);
      halfFloatData[o + 3] = THREE.DataUtils.toHalfFloat(1.0);
    }
  }

  const equirect = new THREE.DataTexture(halfFloatData, w, h, THREE.RGBAFormat, THREE.HalfFloatType);
  equirect.mapping = THREE.EquirectangularReflectionMapping;
  equirect.minFilter = THREE.LinearFilter;
  equirect.magFilter = THREE.LinearFilter;
  equirect.needsUpdate = true;

  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envRT = pmrem.fromEquirectangular(equirect);
  equirect.dispose();
  pmrem.dispose();

  return envRT.texture;
}
