import * as THREE from 'three';
import { getTerrainHeight, PUDDLE_LEVEL } from './Terrain.js';
import { fbm2D, seededRandom } from '../math/Noise.js';
import { WIND_GLSL_PARS } from './WindSystem.js';

/**
 * Builds a dense, macro-detailed meadow of curved vascular grass blades.
 * Every blade has smooth cross-sectional cup curvature, botanical longitudinal arch,
 * real-time wind waves, ant-body parting, wet cuticle sheen, and chlorophyll translucency.
 */
export class GrassField {
  constructor(scene, textures, windSystem) {
    this.windSystem = windSystem;
    this.dewAnchorBlades = []; // Sampled blades that carry clinging post-rain water droplets

    const bladeGeo = this._createCurvedBladeGeometry(4, 9);
    this._populateInstances(scene, bladeGeo, textures.grass, textures.envMap);
  }

  /**
   * Smooth 3D grass blade in normalized coordinates:
   * - width normalized to [-0.5, +0.5] (scaled per-instance by bladeWidth)
   * - height normalized to [0, 1] (scaled per-instance by bladeHeight)
   * - z curved both across width (cupped vascular cross-section) and along height (natural arch)
   */
  _createCurvedBladeGeometry(widthSegs = 4, heightSegs = 9) {
    const cols = widthSegs + 1;
    const rows = heightSegs + 1;
    const vertCount = cols * rows;

    const positions = new Float32Array(vertCount * 3);
    const normals = new Float32Array(vertCount * 3);
    const uvs = new Float32Array(vertCount * 2);
    const indices = [];

    for (let r = 0; r < rows; r++) {
      const v = r / heightSegs; // 0 at base, 1 at tip
      // Smooth botanical taper: slightly narrower sheath at root, widest at 30%, graceful ogive tip
      const sheath = 0.78 + 0.22 * Math.sin(Math.min(1, v * 3.0) * Math.PI * 0.5);
      const tipTaper = Math.cos(Math.pow(v, 1.55) * Math.PI * 0.492);
      const widthScale = Math.max(0.015, sheath * tipTaper);

      // Natural longitudinal droop along local +Z (arches gracefully under post-rain weight)
      const archZ = Math.pow(v, 1.8) * 1.05;
      const archSlope = 1.8 * Math.pow(Math.max(0.001, v), 0.8) * 1.05;

      for (let c = 0; c < cols; c++) {
        const u = c / widthSegs; // 0..1
        const across = (u - 0.5) * 2.0; // -1..1

        const x = across * 0.5 * widthScale;
        const y = v;
        // Gentle cupped botanical cross-section
        const cupZ = (1.0 - across * across) * 0.012 * widthScale;
        const z = archZ - cupZ;

        const idx = r * cols + c;
        positions[idx * 3] = x;
        positions[idx * 3 + 1] = y;
        positions[idx * 3 + 2] = z;

        // Smooth analytical normal combining cross-sectional cup & longitudinal arch
        const nx = across * 0.36;
        const ny = archSlope;
        const nz = -1.0;
        const inv = 1.0 / Math.hypot(nx, ny, nz);
        normals[idx * 3] = nx * inv;
        normals[idx * 3 + 1] = ny * inv;
        normals[idx * 3 + 2] = nz * inv;

        uvs[idx * 2] = u;
        uvs[idx * 2 + 1] = v;
      }
    }

    for (let r = 0; r < heightSegs; r++) {
      for (let c = 0; c < widthSegs; c++) {
        const a = r * cols + c;
        const b = a + 1;
        const d = (r + 1) * cols + c;
        const e = d + 1;
        indices.push(a, d, b);
        indices.push(b, d, e);
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setIndex(indices);
    return geo;
  }

  _populateInstances(scene, baseGeo, grassTex, envMap) {
    const maxCandidates = 44000;
    const rng = seededRandom(902107);

    const validTransforms = [];
    const rootPositions = [];
    const bladeMetas = []; // [height, phase, stiffness, tintVar]
    const bladeTints = [];

    const dummy = new THREE.Object3D();
    const cFresh = new THREE.Color(0x9be37b);
    const cDeep = new THREE.Color(0x66b052);
    const cWarm = new THREE.Color(0xc4e874);
    const tmpColor = new THREE.Color();

    for (let i = 0; i < maxCandidates; i++) {
      // Concentrate higher density within 68-unit radius where ant roams most, tapering smoothly outward
      const u1 = rng();
      const u2 = rng();
      const radius = Math.pow(u1, 0.62) * 82.0;
      const angle = u2 * Math.PI * 2.0;
      const x = Math.cos(angle) * radius;
      const z = Math.sin(angle) * radius;

      const y = getTerrainHeight(x, z);
      // Skip deeper puddle interiors, keep lush reeds/grass right up to wet puddle edges
      if (y < PUDDLE_LEVEL - 0.08) continue;

      // Natural clumping into lush meadow tufts with winding ant-scale mossy glades & trails!
      const clump = fbm2D(x * 0.11, z * 0.11, 3);
      const glade = fbm2D(x * 0.048 + 7.3, z * 0.048 - 4.1, 2);
      if (glade < -0.16 && rng() > 0.12) continue;
      if (clump < -0.18 && rng() > 0.25) continue;

      // Scenic spawn glade & sightline corridor from (0, 6) toward sunlit puddle at (8, -9)
      const spawnDist = Math.hypot(x - 0.0, z - 6.0);
      if (spawnDist < 3.8) continue;
      // Gentle sightline corridor so towering grass frames the view rather than blocking 10cm from lens
      const corridorT = THREE.MathUtils.clamp(((x * 0.48 + (6.0 - z) * 0.88)) / 14.0, 0, 1);
      const corridorX = corridorT * 6.8;
      const corridorZ = 6.0 - corridorT * 12.5;
      if (corridorT > 0 && corridorT < 1 && Math.hypot(x - corridorX, z - corridorZ) < 2.4 && rng() > 0.18) {
        continue;
      }

      // Towering ant-scale grass height: 6.5 to 19.5 units (ant eye is ~1.45 units!)
      const lushFactor = THREE.MathUtils.clamp(clump + 0.72, 0.42, 1.25);
      const isTallHero = rng() < 0.25;
      const height = (isTallHero ? 12.5 + rng() * 7.5 : 5.5 + rng() * 7.5) * lushFactor;
      const width = (0.28 + rng() * 0.24) * (height / 11.0);

      const yaw = rng() * Math.PI * 2.0;
      const lean = 0.08 + rng() * 0.24; // Natural outward tuft tilt
      const phase = rng() * Math.PI * 2.0;
      const stiffness = 0.72 + rng() * 0.55;

      dummy.position.set(x, y - 0.12, z);
      dummy.rotation.set(lean, yaw, (rng() - 0.5) * 0.14);
      dummy.scale.set(width, height, height * 0.38);
      dummy.updateMatrix();

      validTransforms.push(dummy.matrix.clone());
      rootPositions.push(x, y - 0.12, z);
      bladeMetas.push(height, phase, stiffness, lean);

      // Subtle botanical hue variation per blade
      const mixA = rng();
      tmpColor.copy(cDeep).lerp(cFresh, mixA);
      if (rng() < 0.3) tmpColor.lerp(cWarm, rng() * 0.45);
      bladeTints.push(tmpColor.r, tmpColor.g, tmpColor.b);

      // Register plenty of blades within 62 units for clinging water droplets
      if (radius < 62.0 && height > 6.0 && this.dewAnchorBlades.length < 8500 && rng() < 0.68) {
        this.dewAnchorBlades.push({
          matrix: dummy.matrix.clone(),
          rx: x,
          ry: y - 0.12,
          rz: z,
          height,
          width,
          yaw,
          lean,
          phase,
          stiffness
        });
      }
    }

    const count = validTransforms.length;
    const instGeo = baseGeo.clone();
    instGeo.setAttribute(
      'aRootPos',
      new THREE.InstancedBufferAttribute(new Float32Array(rootPositions), 3)
    );
    instGeo.setAttribute(
      'aBladeMeta',
      new THREE.InstancedBufferAttribute(new Float32Array(bladeMetas), 4)
    );

    const windUniforms = this.windSystem.uniforms;

    const mat = new THREE.MeshStandardMaterial({
      map: grassTex.map,
      normalMap: grassTex.normalMap,
      normalScale: new THREE.Vector2(1.15, 1.15),
      roughnessMap: grassTex.roughnessMap,
      roughness: 0.34,
      metalness: 0.02,
      side: THREE.DoubleSide,
      envMap,
      envMapIntensity: 1.05
    });

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, windUniforms);

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          attribute vec3 aRootPos;
          attribute vec4 aBladeMeta;
          varying float vHeightRatio;
          varying vec3 vWorldPosGrass;
          ${WIND_GLSL_PARS}
          `
        )
        .replace(
          '#include <project_vertex>',
          /* glsl */ `
          vHeightRatio = position.y;
          vec4 mvPosition = vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
            mvPosition = instanceMatrix * mvPosition;
          #endif
          vec4 worldPos = modelMatrix * mvPosition;

          vec3 bend = computeBladeBend(aRootPos, aBladeMeta.x, position.y, aBladeMeta.y, aBladeMeta.z);
          worldPos.xyz += bend;
          vWorldPosGrass = worldPos.xyz;

          mvPosition = viewMatrix * worldPos;
          gl_Position = projectionMatrix * mvPosition;
          `
        )
        .replace(
          '#include <worldpos_vertex>',
          /* glsl */ `
          vec4 worldPosition = vec4( vWorldPosGrass, 1.0 );
          `
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          uniform vec3 uSunDir;
          uniform float uSunIntensity;
          varying float vHeightRatio;
          varying vec3 vWorldPosGrass;
          `
        )
        .replace(
          '#include <color_fragment>',
          /* glsl */ `
          #include <color_fragment>
          // Rich root ambient occlusion near wet earth, brighter fresh chlorophyll aloft
          float rootAO = mix(0.32, 1.0, smoothstep(0.0, 0.38, vHeightRatio));
          diffuseColor.rgb *= rootAO;
          `
        )
        .replace(
          '#include <lights_fragment_end>',
          /* glsl */ `
          #include <lights_fragment_end>
          // Subsurface chlorophyll translucency when backlit by golden forest sunbreak
          vec3 viewDirW = normalize(cameraPosition - vWorldPosGrass);
          float backLight = pow(max(0.0, dot(viewDirW, -uSunDir)), 2.6);
          float thinTip = mix(0.35, 1.0, vHeightRatio);
          float rimSun = max(0.0, 1.0 - abs(dot(normal, viewDirW)));
          vec3 sssColor = vec3(0.58, 0.92, 0.24) * diffuseColor.rgb;
          reflectedLight.directDiffuse += sssColor * (backLight * 0.95 + rimSun * 0.28) * thinTip * uSunIntensity;
          `
        );
    };

    // Custom shadow depth material so swaying grass casts animated dappled shadows!
    const depthMat = new THREE.MeshDepthMaterial({
      depthPacking: THREE.RGBADepthPacking,
      side: THREE.DoubleSide
    });
    depthMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, windUniforms);
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          attribute vec3 aRootPos;
          attribute vec4 aBladeMeta;
          ${WIND_GLSL_PARS}
          `
        )
        .replace(
          '#include <project_vertex>',
          /* glsl */ `
          vec4 mvPosition = vec4( transformed, 1.0 );
          #ifdef USE_INSTANCING
            mvPosition = instanceMatrix * mvPosition;
          #endif
          vec4 worldPos = modelMatrix * mvPosition;
          worldPos.xyz += computeBladeBend(aRootPos, aBladeMeta.x, position.y, aBladeMeta.y, aBladeMeta.z);
          mvPosition = viewMatrix * worldPos;
          gl_Position = projectionMatrix * mvPosition;
          `
        );
    };

    const instMesh = new THREE.InstancedMesh(instGeo, mat, count);
    instMesh.customDepthMaterial = depthMat;
    instMesh.castShadow = true;
    instMesh.receiveShadow = true;
    instMesh.frustumCulled = false;

    for (let i = 0; i < count; i++) {
      instMesh.setMatrixAt(i, validTransforms[i]);
      tmpColor.setRGB(bladeTints[i * 3], bladeTints[i * 3 + 1], bladeTints[i * 3 + 2]);
      instMesh.setColorAt(i, tmpColor);
    }
    instMesh.instanceMatrix.needsUpdate = true;
    if (instMesh.instanceColor) instMesh.instanceColor.needsUpdate = true;

    this.mesh = instMesh;
    scene.add(instMesh);
  }
}
