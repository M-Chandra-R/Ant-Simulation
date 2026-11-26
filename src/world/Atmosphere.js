import * as THREE from 'three';
import { seededRandom } from '../math/Noise.js';

/**
 * Sunbreak-After-Rain Lighting, Misty Forest Sky Dome, Volumetric God-Ray Shafts,
 * and Drifting Sunlit Pollen / Spore Bokeh Motes.
 */
export class Atmosphere {
  constructor(scene, textures, windSystem) {
    this.scene = scene;
    this.windSystem = windSystem;
    this.sunDir = windSystem.uniforms.uSunDir.value;

    this.baseFogDensity = 0.0105;
    scene.fog = new THREE.FogExp2(new THREE.Color(0x9fbca2), this.baseFogDensity);

    this._buildLights();
    this._buildSkyDome();
    this._buildGodRayShafts();
    this._buildFloatingMotes(textures.bokeh);
  }

  _buildLights() {
    // Cool misty sky zenith + rich emerald-earth bounce
    this.hemiLight = new THREE.HemisphereLight(0xbce0d8, 0x2a3b21, 0.95);
    this.scene.add(this.hemiLight);

    // Warm golden post-rain sunbreak piercing canopy
    this.sunLight = new THREE.DirectionalLight(0xffe6b3, 3.1);
    this.sunLight.position.copy(this.sunDir).multiplyScalar(75);
    this.sunLight.castShadow = true;

    this.sunLight.shadow.mapSize.set(2048, 2048);
    this.sunLight.shadow.camera.near = 5;
    this.sunLight.shadow.camera.far = 175;
    const frustum = 46;
    this.sunLight.shadow.camera.left = -frustum;
    this.sunLight.shadow.camera.right = frustum;
    this.sunLight.shadow.camera.top = frustum;
    this.sunLight.shadow.camera.bottom = -frustum;
    this.sunLight.shadow.bias = -0.0004;
    this.sunLight.shadow.normalBias = 0.035;

    this.scene.add(this.sunLight);
    this.scene.add(this.sunLight.target);
  }

  _buildSkyDome() {
    const skyGeo = new THREE.SphereGeometry(260, 48, 32);
    this.skyUniforms = {
      uSunDir: { value: this.sunDir },
      uSunWarmth: { value: 1.25 },
      uTime: this.windSystem.uniforms.uTime
    };

    const skyMat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      uniforms: this.skyUniforms,
      vertexShader: /* glsl */ `
        varying vec3 vDir;
        void main() {
          vDir = normalize(position);
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uSunDir;
        uniform float uSunWarmth;
        uniform float uTime;
        varying vec3 vDir;

        // Smooth procedural canopy silhouette noise
        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }
        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(
            mix(hash(i + vec2(0.0, 0.0)), hash(i + vec2(1.0, 0.0)), u.x),
            mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
            u.y
          );
        }
        float fbm(vec2 p) {
          float s = 0.0;
          float a = 0.5;
          for (int i = 0; i < 4; i++) {
            s += a * noise(p);
            p *= 2.04;
            a *= 0.5;
          }
          return s;
        }

        void main() {
          vec3 d = normalize(vDir);
          float elev = clamp(d.y, 0.0, 1.0);

          // Post-rain misty woodland horizon -> fresh celadon sky dome
          vec3 horizonCol = vec3(0.66, 0.78, 0.67);
          vec3 zenithCol  = vec3(0.32, 0.54, 0.62);
          vec3 col = mix(horizonCol, zenithCol, pow(elev, 0.65));

          // Soft overhead forest leaf canopy filtering the sky (leaving sunbreak clearing)
          vec2 canopyUV = d.xz / (d.y + 0.38) * 2.2 + vec2(uTime * 0.012, uTime * 0.008);
          float foliage = fbm(canopyUV);
          float sunDot = max(0.0, dot(d, normalize(uSunDir)));
          float sunClearing = smoothstep(0.95, 0.72, sunDot);
          float canopyMask = smoothstep(0.42, 0.72, foliage) * smoothstep(0.02, 0.35, d.y) * sunClearing;

          vec3 canopyTint = vec3(0.09, 0.22, 0.09) + vec3(0.18, 0.24, 0.06) * pow(sunDot, 3.0);
          col = mix(col, canopyTint, canopyMask * 0.72);

          // Golden sunbreak bloom & atmospheric Mie scattering halo
          float mieHalo = pow(sunDot, 7.0) * 0.52 * uSunWarmth;
          float sunDisc = pow(sunDot, 260.0) * 4.5 * uSunWarmth;
          col += vec3(1.0, 0.86, 0.56) * mieHalo + vec3(1.0, 0.95, 0.82) * sunDisc;

          // Blend lower rim smoothly into ground mist
          float mistHorizon = smoothstep(0.16, -0.05, d.y);
          col = mix(col, vec3(0.62, 0.74, 0.64), mistHorizon);

          gl_FragColor = vec4(col, 1.0);
        }
      `
    });

    const skyMesh = new THREE.Mesh(skyGeo, skyMat);
    this.scene.add(skyMesh);
  }

  _buildGodRayShafts() {
    // Soft volumetric sunbeams slanting parallel to uSunDir across the meadow
    const shaftGeo = new THREE.CylinderGeometry(3.2, 9.5, 95, 24, 1, true);
    this.shaftUniforms = {
      uTime: this.windSystem.uniforms.uTime,
      uWarmth: { value: 1.0 }
    };

    const shaftMat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
      uniforms: this.shaftUniforms,
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vWorldPos;
        void main() {
          vUv = uv;
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          vNormalW = normalize(mat3(modelMatrix) * normal);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uTime;
        uniform float uWarmth;
        varying vec2 vUv;
        varying vec3 vNormalW;
        varying vec3 vWorldPos;

        void main() {
          vec3 viewDir = normalize(cameraPosition - vWorldPos);
          // Smooth grazing edge fade so cylindrical bounds are completely invisible
          float edgeSoft = pow(abs(dot(normalize(vNormalW), viewDir)), 2.2);
          // Vertical fade at canopy top and near ground mist
          float vertFade = sin(vUv.y * 3.14159265) * smoothstep(0.0, 0.25, vUv.y);
          // Fade out gracefully when camera walks directly inside a light shaft
          float camDistFade = smoothstep(4.0, 18.0, length(cameraPosition - vWorldPos));
          float shimmer = 0.82 + 0.18 * sin(uTime * 0.7 + vUv.x * 6.2831);

          float alpha = edgeSoft * vertFade * camDistFade * shimmer * 0.055 * uWarmth;
          vec3 beamColor = vec3(1.0, 0.88, 0.58);
          gl_FragColor = vec4(beamColor * alpha, alpha);
        }
      `
    });

    const rng = seededRandom(61803);
    const up = new THREE.Vector3(0, 1, 0);
    const alignQuat = new THREE.Quaternion().setFromUnitVectors(up, this.sunDir);

    this.shaftGroup = new THREE.Group();
    for (let i = 0; i < 11; i++) {
      const mesh = new THREE.Mesh(shaftGeo, shaftMat);
      const x = (rng() - 0.5) * 85;
      const z = (rng() - 0.5) * 85;
      mesh.position.set(x, 28 + rng() * 12, z).addScaledVector(this.sunDir, 12);
      mesh.quaternion.copy(alignQuat);
      const s = 0.75 + rng() * 0.85;
      mesh.scale.set(s, 1.0, s);
      this.shaftGroup.add(mesh);
    }
    this.scene.add(this.shaftGroup);
  }

  _buildFloatingMotes(bokehTex) {
    // Magical sunlit pollen, water-vapor mist motes & tiny glowing forest spores
    const count = 420;
    const rng = seededRandom(271828);
    const positions = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    const scales = new Float32Array(count);
    const colors = new Float32Array(count * 3);

    const cGold = new THREE.Color(0xffe9a6);
    const cMint = new THREE.Color(0xcaf7c4);
    const tmp = new THREE.Color();

    for (let i = 0; i < count; i++) {
      positions[i * 3] = (rng() - 0.5) * 110;
      positions[i * 3 + 1] = 0.6 + Math.pow(rng(), 1.3) * 26.0;
      positions[i * 3 + 2] = (rng() - 0.5) * 110;
      phases[i] = rng() * Math.PI * 2;
      scales[i] = 0.35 + rng() * 1.05;

      tmp.copy(rng() < 0.7 ? cGold : cMint);
      colors[i * 3] = tmp.r;
      colors[i * 3 + 1] = tmp.g;
      colors[i * 3 + 2] = tmp.b;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('aPhase', new THREE.BufferAttribute(phases, 1));
    geo.setAttribute('aScale', new THREE.BufferAttribute(scales, 1));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {
        uTime: this.windSystem.uniforms.uTime,
        uWindStrength: this.windSystem.uniforms.uWindStrength,
        uTex: { value: bokehTex },
        uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) }
      },
      vertexShader: /* glsl */ `
        attribute float aPhase;
        attribute float aScale;
        attribute vec3 aColor;
        uniform float uTime;
        uniform float uWindStrength;
        uniform float uPixelRatio;
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          vColor = aColor;
          vec3 p = position;
          // Gentle lazy drift in post-rain breeze
          p.x += sin(uTime * 0.35 + aPhase) * 2.2 + uTime * 0.45 * uWindStrength;
          p.y += sin(uTime * 0.6 + aPhase * 1.7) * 0.85;
          p.z += cos(uTime * 0.31 + aPhase * 1.3) * 2.2;

          // Wrap smoothly inside [-55, 55] box around meadow
          p.x = mod(p.x + 55.0, 110.0) - 55.0;
          p.z = mod(p.z + 55.0, 110.0) - 55.0;

          vec4 mvPos = modelViewMatrix * vec4(p, 1.0);
          float dist = -mvPos.z;
          // Twinkle softly as motes turn in sunbeams
          vAlpha = (0.35 + 0.45 * sin(uTime * 1.8 + aPhase * 3.0)) * smoothstep(1.2, 5.0, dist) * smoothstep(85.0, 25.0, dist);

          gl_PointSize = clamp((aScale * 85.0 * uPixelRatio) / max(1.0, dist), 2.0, 34.0);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uTex;
        varying vec3 vColor;
        varying float vAlpha;

        void main() {
          vec4 texCol = texture2D(uTex, gl_PointCoord);
          gl_FragColor = vec4(vColor * texCol.rgb, texCol.a * vAlpha * 0.55);
        }
      `
    });

    this.motes = new THREE.Points(geo, mat);
    this.motes.frustumCulled = false;
    this.scene.add(this.motes);
  }

  setSunWarmth(val) {
    this.sunLight.intensity = 2.5 * val;
    this.skyUniforms.uSunWarmth.value = val;
    this.shaftUniforms.uWarmth.value = val;
    this.windSystem.uniforms.uSunIntensity.value = val;
  }

  setFogMultiplier(mult) {
    this.scene.fog.density = this.baseFogDensity * mult;
  }

  update(antPos) {
    // Keep crisp shadow frustum centered near the ant's neighborhood
    this.sunLight.target.position.set(antPos.x, 0, antPos.z);
    this.sunLight.position.copy(this.sunLight.target.position).addScaledVector(this.sunDir, 75);
  }
}
