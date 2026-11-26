import * as THREE from 'three';
import { fbm2D } from '../math/Noise.js';

export const WORLD_SIZE = 180;
export const WORLD_HALF = WORLD_SIZE * 0.5;
export const PUDDLE_LEVEL = -0.95;

// Pre-defined natural rainwater depression centers so the ant encounters scenic puddles
const PUDDLE_BASINS = [
  { x: 11.5, z: -9.0, radius: 11.0, depth: 1.55 },
  { x: -16.0, z: 12.5, radius: 13.5, depth: 1.7 },
  { x: 24.0, z: 21.0, radius: 9.5, depth: 1.45 },
  { x: -28.0, z: -22.0, radius: 12.0, depth: 1.6 }
];

export function getTerrainHeight(x, z) {
  // Smooth organic forest floor undulations (mounds, root swells, micro-hollows)
  const broad = fbm2D(x * 0.022, z * 0.022, 4, 2.0, 0.5) * 3.1;
  const medium = fbm2D(x * 0.075 + 5.2, z * 0.075 - 3.1, 3, 2.05, 0.5) * 0.95;
  const micro = fbm2D(x * 0.26 - 1.7, z * 0.26 + 4.4, 2, 2.0, 0.5) * 0.22;

  let h = broad + medium + micro;

  // Carve smooth rainwater puddle basins
  for (let i = 0; i < PUDDLE_BASINS.length; i++) {
    const b = PUDDLE_BASINS[i];
    const d = Math.hypot(x - b.x, z - b.z) / b.radius;
    if (d < 1.0) {
      const falloff = Math.pow(1.0 - d * d, 2.0);
      h -= falloff * b.depth;
    }
  }

  // Gentle natural rise near outer perimeter where ancient tree roots & trunks ring the clearing
  const distFromOrigin = Math.hypot(x, z);
  if (distFromOrigin > 54) {
    const rim = Math.min(1.0, (distFromOrigin - 54) / 38);
    h += rim * rim * 6.5;
  }

  // Keep spawn clearing near (0, 0) comfortable and dry
  const spawnDist = Math.hypot(x, z) / 7.5;
  if (spawnDist < 1.0) {
    const flat = 1.0 - spawnDist * spawnDist * (3 - 2 * spawnDist);
    h = h * (1.0 - flat * 0.7) + 0.15 * (flat * 0.7);
  }

  return h;
}

export function getTerrainNormal(x, z, target = new THREE.Vector3()) {
  const eps = 0.25;
  const hL = getTerrainHeight(x - eps, z);
  const hR = getTerrainHeight(x + eps, z);
  const hD = getTerrainHeight(x, z - eps);
  const hU = getTerrainHeight(x, z + eps);
  target.set(hL - hR, 2.0 * eps, hD - hU).normalize();
  return target;
}

export function isPuddleAt(x, z) {
  return getTerrainHeight(x, z) < PUDDLE_LEVEL - 0.04;
}

export class Terrain {
  constructor(scene, textures, windSystem) {
    this.group = new THREE.Group();
    this.rippleUniforms = {
      uTime: windSystem.uniforms.uTime,
      // Up to 8 active droplet impact rings: vec4(x, z, startTime, strength)
      uImpacts: {
        value: Array.from({ length: 8 }, () => new THREE.Vector4(9999, 9999, -99, 0))
      }
    };
    this.nextImpactSlot = 0;

    this._buildGroundMesh(textures.soil, textures.envMap);
    this._buildPuddleWater(textures.envMap);

    scene.add(this.group);
  }

  _buildGroundMesh(soilTex, envMap) {
    const segs = 256;
    const geo = new THREE.PlaneGeometry(WORLD_SIZE, WORLD_SIZE, segs, segs);
    geo.rotateX(-Math.PI * 0.5);

    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const cDryMoss = new THREE.Color(0x95b87c);
    const cRichSoil = new THREE.Color(0x8c7b6b);
    const cWetShore = new THREE.Color(0x3a3228);
    const tmpColor = new THREE.Color();

    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const z = pos.getZ(i);
      const y = getTerrainHeight(x, z);
      pos.setY(i, y);

      // Vertex color modulation: dark wet mud near/under puddles, lush mossy tint on mounds
      const mossPatch = THREE.MathUtils.clamp(fbm2D(x * 0.09 + 2.1, z * 0.09 - 1.3, 3) + 0.5, 0, 1);
      tmpColor.copy(cRichSoil).lerp(cDryMoss, mossPatch * 0.72);

      const shoreWetness = 1.0 - THREE.MathUtils.smoothstep(y, PUDDLE_LEVEL - 0.15, PUDDLE_LEVEL + 0.55);
      tmpColor.lerp(cWetShore, shoreWetness * 0.78);

      colors[i * 3] = tmpColor.r;
      colors[i * 3 + 1] = tmpColor.g;
      colors[i * 3 + 2] = tmpColor.b;
    }

    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({
      map: soilTex.map,
      normalMap: soilTex.normalMap,
      normalScale: new THREE.Vector2(1.35, 1.35),
      roughnessMap: soilTex.roughnessMap,
      roughness: 0.88,
      metalness: 0.02,
      vertexColors: true,
      envMap,
      envMapIntensity: 0.85
    });

    const mesh = new THREE.Mesh(geo, mat);
    mesh.receiveShadow = true;
    this.groundMesh = mesh;
    this.group.add(mesh);
  }

  _buildPuddleWater(envMap) {
    const geo = new THREE.PlaneGeometry(WORLD_SIZE * 0.85, WORLD_SIZE * 0.85, 128, 128);
    geo.rotateX(-Math.PI * 0.5);

    const mat = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(0xe6f7ed),
      roughness: 0.03,
      metalness: 0.0,
      transmission: 0.9,
      ior: 1.333,
      thickness: 0.85,
      attenuationColor: new THREE.Color(0x45694d),
      attenuationDistance: 1.6,
      clearcoat: 1.0,
      clearcoatRoughness: 0.02,
      envMap,
      envMapIntensity: 1.65
    });

    const rippleUniforms = this.rippleUniforms;
    mat.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = rippleUniforms.uTime;
      shader.uniforms.uImpacts = rippleUniforms.uImpacts;

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          varying vec3 vWorldPosPuddle;
          `
        )
        .replace(
          '#include <worldpos_vertex>',
          /* glsl */ `
          #include <worldpos_vertex>
          vWorldPosPuddle = (modelMatrix * vec4(transformed, 1.0)).xyz;
          `
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          uniform float uTime;
          uniform vec4 uImpacts[8];
          varying vec3 vWorldPosPuddle;
          `
        )
        .replace(
          '#include <normal_fragment_maps>',
          /* glsl */ `
          #include <normal_fragment_maps>
          // Subtle breeze micro-capillary waves + concentric droplet impact rings
          vec2 wp = vWorldPosPuddle.xz;
          float breezeWave = sin(wp.x * 3.1 + uTime * 2.2) * cos(wp.y * 2.7 - uTime * 1.8) * 0.012;
          vec2 grad = vec2(
            cos(wp.x * 3.1 + uTime * 2.2) * 0.018,
            -sin(wp.y * 2.7 - uTime * 1.8) * 0.018
          );

          for (int i = 0; i < 8; i++) {
            vec4 imp = uImpacts[i];
            float age = uTime - imp.z;
            if (age > 0.0 && age < 2.8 && imp.w > 0.0) {
              vec2 delta = wp - imp.xy;
              float dist = length(delta);
              float radius = age * 3.4;
              float ringEnv = exp(-abs(dist - radius) * 2.4) * exp(-age * 1.35) * imp.w;
              float phase = (dist - radius) * 14.0;
              vec2 dir = delta / max(0.001, dist);
              grad += dir * cos(phase) * ringEnv * 0.22;
            }
          }

          normal = normalize(normal + vec3(grad.x, 0.0, grad.y));
          `
        );
    };

    const waterMesh = new THREE.Mesh(geo, mat);
    waterMesh.position.y = PUDDLE_LEVEL;
    waterMesh.renderOrder = 1;
    this.waterMesh = waterMesh;
    this.group.add(waterMesh);
  }

  registerSplashImpact(x, z, currentTime, strength = 1.0) {
    const slot = this.rippleUniforms.uImpacts.value[this.nextImpactSlot];
    slot.set(x, z, currentTime, strength);
    this.nextImpactSlot = (this.nextImpactSlot + 1) % 8;
  }
}
