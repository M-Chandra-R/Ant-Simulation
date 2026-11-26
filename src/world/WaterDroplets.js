import * as THREE from 'three';
import { getTerrainHeight, PUDDLE_LEVEL } from './Terrain.js';
import { seededRandom } from '../math/Noise.js';
import { WIND_GLSL_PARS } from './WindSystem.js';

/**
 * Post-Rain Refractive Water Droplets System:
 * 1. Clinging dew/rain beads on curved grass blades, clover leaves & fern fronds
 *    (GPU-synchronized with exact wind & ant-brush displacement + micro surface-tension tremble)
 * 2. Stationary glistening beads on wet mossy stones & mushroom caps
 * 3. Gravity-driven falling droplets shaken loose by wind gusts or ant brushing,
 *    bursting into splash micro-beads and triggering concentric puddle ripples!
 */
export class WaterDroplets {
  constructor(scene, textures, windSystem, grassField, forestFlora, terrain, onSplashAudio = null) {
    this.windSystem = windSystem;
    this.terrain = terrain;
    this.onSplashAudio = onSplashAudio;
    this.sheddingRate = 1.0;

    this.group = new THREE.Group();
    scene.add(this.group);

    this.dropletGeo = this._createMeniscusDropletGeometry(28, 20);
    this.fallingGeo = new THREE.SphereGeometry(1.0, 20, 16);

    this.waterMaterial = new THREE.MeshPhysicalMaterial({
      color: new THREE.Color(0xf6fff9),
      roughness: 0.018,
      metalness: 0.0,
      transmission: 0.96,
      ior: 1.333,
      thickness: 1.15,
      attenuationColor: new THREE.Color(0xdaf7df),
      attenuationDistance: 4.5,
      clearcoat: 1.0,
      clearcoatRoughness: 0.015,
      specularIntensity: 1.5,
      envMap: textures.envMap,
      envMapIntensity: 1.85
    });

    this.shedCandidates = [];
    this._buildAnimatedPlantDroplets(grassField.dewAnchorBlades, forestFlora.plantDewAnchors, textures.envMap);
    this._buildStaticDroplets(forestFlora.staticDewAnchors);
    this._initFallingAndSplashPools();

    this.dripTimer = 0;
    this.lastAntBrushTime = 0;
  }

  /**
   * Smooth surface-tension water bead with slightly flattened hydrophobic contact base
   * and plump spherical dome — zero low-poly faceting.
   */
  _createMeniscusDropletGeometry(wSegs = 28, hSegs = 20) {
    const geo = new THREE.SphereGeometry(1.0, wSegs, hSegs);
    const pos = geo.attributes.position;
    const v = new THREE.Vector3();

    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      // Flatten bottom contact patch (y < -0.25) and slightly plump equatorial waist
      if (v.y < -0.2) {
        const t = (-0.2 - v.y) / 0.8;
        v.y = -0.2 - (1.0 - Math.pow(t, 1.5) * 0.55) * (-0.2 - v.y);
      }
      const waist = 1.0 + Math.max(0, 1.0 - Math.abs(v.y + 0.12)) * 0.12;
      v.x *= waist;
      v.z *= waist;
      // Shift upward so y = 0 sits cleanly on leaf/blade surface
      v.y += 0.58;
      pos.setXYZ(i, v.x, v.y, v.z);
    }
    geo.computeVertexNormals();
    return geo;
  }

  _buildAnimatedPlantDroplets(grassBlades, floraAnchors, envMap) {
    const rng = seededRandom(202611);
    const matrices = [];
    const rootPos = [];
    const bladeMetas = []; // [plantHeight, phase, stiffness, tRatio]

    const dummy = new THREE.Object3D();
    const localPt = new THREE.Vector3();
    const localNormal = new THREE.Vector3();
    const normalMat = new THREE.Matrix3();
    const upVec = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion();

    // 1. Droplets clinging along curved grass blades (both ant-eye-level stems & arching tips!)
    for (let i = 0; i < grassBlades.length; i++) {
      const b = grassBlades[i];
      const beadsOnBlade = rng() < 0.65 ? 3 : 2;

      for (let k = 0; k < beadsOnBlade; k++) {
        // Distribute beads across eye-level lower stem (v = 0.10..0.34), mid-blade, and arching tip
        const v =
          k === 0
            ? 0.10 + rng() * 0.24
            : k === 1
              ? 0.36 + rng() * 0.26
              : 0.64 + rng() * 0.26;
        const sheath = 0.78 + 0.22 * Math.sin(Math.min(1, v * 3.0) * Math.PI * 0.5);
        const tipTaper = Math.cos(Math.pow(v, 1.55) * Math.PI * 0.492);
        const widthScale = Math.max(0.015, sheath * tipTaper);

        const across = (rng() - 0.5) * 0.85;
        const lx = across * 0.5 * widthScale;
        const ly = v;
        const archZ = Math.pow(v, 1.8) * 1.05;
        const cupZ = (1.0 - across * across * 4.0) * 0.012 * widthScale;
        const lz = archZ - cupZ;

        localPt.set(lx, ly, lz).applyMatrix4(b.matrix);

        const archSlope = 1.8 * Math.pow(v, 0.8) * 1.05;
        normalMat.getNormalMatrix(b.matrix);
        localNormal.set(across * 0.3, archSlope, -1.0).applyMatrix3(normalMat).normalize();
        // Offset slightly outward along blade normal so the plump droplet protrudes visibly on the stem!
        const dropScale = (0.075 + rng() * 0.135) * (1.12 - v * 0.25);
        localPt.addScaledVector(localNormal, dropScale * 0.18);
        quat.setFromUnitVectors(upVec, localNormal);

        dummy.position.copy(localPt);
        dummy.quaternion.copy(quat);
        dummy.scale.set(dropScale, dropScale * (0.85 + rng() * 0.22), dropScale);
        dummy.updateMatrix();

        matrices.push(dummy.matrix.clone());
        rootPos.push(b.rx, b.ry, b.rz);
        bladeMetas.push(b.height, b.phase, b.stiffness, v);

        // Register heavy tip droplets as candidates that can detach and fall!
        if (v > 0.62 && this.shedCandidates.length < 900) {
          this.shedCandidates.push({
            restPos: localPt.clone(),
            rx: b.rx,
            ry: b.ry,
            rz: b.rz,
            height: b.height,
            tRatio: v,
            phase: b.phase,
            stiffness: b.stiffness,
            radius: dropScale * 1.1
          });
        }
      }
    }

    // 2. Droplets nestled on clover leaflets & arching fern fronds
    for (let i = 0; i < floraAnchors.length; i++) {
      const a = floraAnchors[i];
      dummy.position.copy(a.worldRestPos);
      dummy.rotation.set((rng() - 0.5) * 0.2, rng() * Math.PI * 2, (rng() - 0.5) * 0.2);
      const s = a.dropRadius;
      dummy.scale.set(s, s * 0.86, s);
      dummy.updateMatrix();

      matrices.push(dummy.matrix.clone());
      rootPos.push(a.rx, a.ry, a.rz);
      bladeMetas.push(a.height, a.phase, a.stiffness, a.tRatio);

      if (this.shedCandidates.length < 1200) {
        this.shedCandidates.push({
          restPos: a.worldRestPos.clone(),
          rx: a.rx,
          ry: a.ry,
          rz: a.rz,
          height: a.height,
          tRatio: a.tRatio,
          phase: a.phase,
          stiffness: a.stiffness,
          radius: s
        });
      }
    }

    const instGeo = this.dropletGeo.clone();
    instGeo.setAttribute(
      'aRootPos',
      new THREE.InstancedBufferAttribute(new Float32Array(rootPos), 3)
    );
    instGeo.setAttribute(
      'aBladeMeta',
      new THREE.InstancedBufferAttribute(new Float32Array(bladeMetas), 4)
    );

    const animDropMat = this.waterMaterial.clone();
    animDropMat.envMap = envMap;
    const windUniforms = this.windSystem.uniforms;

    animDropMat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, windUniforms);

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          attribute vec3 aRootPos;
          attribute vec4 aBladeMeta;
          varying vec3 vDropWorldPos;
          ${WIND_GLSL_PARS}
          `
        )
        .replace(
          '#include <project_vertex>',
          /* glsl */ `
          // Subtle surface-tension wobble on the droplet meniscus
          vec3 wobTransformed = transformed;
          float tremor = sin(uTime * 10.5 + aBladeMeta.y * 6.0) * 0.045 * uWindStrength;
          wobTransformed.x *= (1.0 + tremor);
          wobTransformed.z *= (1.0 - tremor);

          vec4 mvPosition = vec4( wobTransformed, 1.0 );
          #ifdef USE_INSTANCING
            mvPosition = instanceMatrix * mvPosition;
          #endif
          vec4 worldPos = modelMatrix * mvPosition;

          // Displace by exact wind + ant-brush bend at tRatio (aBladeMeta.w)
          vec3 bend = computeBladeBend(aRootPos, aBladeMeta.x, aBladeMeta.w, aBladeMeta.y, aBladeMeta.z);
          worldPos.xyz += bend;
          vDropWorldPos = worldPos.xyz;

          mvPosition = viewMatrix * worldPos;
          gl_Position = projectionMatrix * mvPosition;
          `
        )
        .replace(
          '#include <worldpos_vertex>',
          /* glsl */ `
          vec4 worldPosition = vec4( vDropWorldPos, 1.0 );
          `
        );

      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          uniform vec3 uSunDir;
          uniform float uSunIntensity;
          varying vec3 vDropWorldPos;
          `
        )
        .replace(
          '#include <lights_fragment_end>',
          /* glsl */ `
          #include <lights_fragment_end>
          // Internal refractive focal caustic glint when sunlight passes through the water sphere!
          vec3 viewDirW = normalize(cameraPosition - vDropWorldPos);
          float forwardFocus = pow(max(0.0, dot(viewDirW, -uSunDir)), 18.0);
          float specSparkle = pow(max(0.0, dot(reflect(-uSunDir, normal), viewDirW)), 96.0);
          reflectedLight.directSpecular += vec3(1.0, 0.94, 0.78) * (forwardFocus * 0.85 + specSparkle * 2.4) * uSunIntensity;
          `
        );
    };

    const instMesh = new THREE.InstancedMesh(instGeo, animDropMat, matrices.length);
    instMesh.frustumCulled = false;
    matrices.forEach((m, i) => instMesh.setMatrixAt(i, m));
    instMesh.instanceMatrix.needsUpdate = true;

    this.animDropletsMesh = instMesh;
    this.group.add(instMesh);
  }

  _buildStaticDroplets(staticAnchors) {
    if (!staticAnchors.length) return;
    const inst = new THREE.InstancedMesh(this.dropletGeo, this.waterMaterial, staticAnchors.length);
    const dummy = new THREE.Object3D();
    const up = new THREE.Vector3(0, 1, 0);
    const quat = new THREE.Quaternion();

    staticAnchors.forEach((a, i) => {
      quat.setFromUnitVectors(up, a.normal);
      dummy.position.copy(a.pos);
      dummy.quaternion.copy(quat);
      dummy.scale.set(a.scale, a.scale * 0.82, a.scale);
      dummy.updateMatrix();
      inst.setMatrixAt(i, dummy.matrix);
    });
    inst.instanceMatrix.needsUpdate = true;
    this.group.add(inst);
  }

  _initFallingAndSplashPools() {
    this.maxFalling = 36;
    this.maxSplash = 120;

    this.fallingPool = Array.from({ length: this.maxFalling }, () => ({
      active: false,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      radius: 0.3
    }));

    this.splashPool = Array.from({ length: this.maxSplash }, () => ({
      active: false,
      pos: new THREE.Vector3(),
      vel: new THREE.Vector3(),
      radius: 0.1,
      life: 0,
      maxLife: 0.45
    }));

    this.fallingMesh = new THREE.InstancedMesh(this.fallingGeo, this.waterMaterial, this.maxFalling);
    this.fallingMesh.frustumCulled = false;
    this.splashMesh = new THREE.InstancedMesh(this.fallingGeo, this.waterMaterial, this.maxSplash);
    this.splashMesh.frustumCulled = false;

    const hideMat = new THREE.Matrix4().makeScale(0, 0, 0);
    for (let i = 0; i < this.maxFalling; i++) this.fallingMesh.setMatrixAt(i, hideMat);
    for (let i = 0; i < this.maxSplash; i++) this.splashMesh.setMatrixAt(i, hideMat);

    this.group.add(this.fallingMesh);
    this.group.add(this.splashMesh);
    this._dummy = new THREE.Object3D();
    this._zeroMat = hideMat;
  }

  spawnFallingDrop(x, y, z, radius = 0.32, initialVelX = 0, initialVelZ = 0) {
    const slot = this.fallingPool.find((d) => !d.active);
    if (!slot) return;
    slot.active = true;
    slot.pos.set(x, y, z);
    slot.vel.set(initialVelX, -0.5, initialVelZ);
    slot.radius = radius;
  }

  _spawnSplashBurst(x, y, z, baseRadius) {
    let spawned = 0;
    for (let i = 0; i < this.maxSplash && spawned < 6; i++) {
      const s = this.splashPool[i];
      if (s.active) continue;
      s.active = true;
      const ang = (spawned / 6) * Math.PI * 2 + Math.random() * 0.5;
      const spd = 2.8 + Math.random() * 3.8;
      s.pos.set(x, y + 0.08, z);
      s.vel.set(Math.cos(ang) * spd, 4.2 + Math.random() * 4.5, Math.sin(ang) * spd);
      s.radius = baseRadius * (0.28 + Math.random() * 0.22);
      s.life = 0;
      s.maxLife = 0.32 + Math.random() * 0.22;
      spawned++;
    }
  }

  update(dt, elapsed, antPos, antSpeed) {
    if (!this.shedCandidates.length) return;

    // 1. Ambient wind-gust shedding near camera so the player sees shimmering drops fall!
    const effectiveRate = this.sheddingRate * (0.55 + this.windSystem.uniforms.uWindStrength.value * 0.65);
    this.dripTimer += dt * effectiveRate;
    if (this.dripTimer > 0.26) {
      this.dripTimer = 0;
      // Pick a candidate reasonably close to the camera (within 36 units) so drops are visible
      for (let tries = 0; tries < 10; tries++) {
        const c = this.shedCandidates[(Math.random() * this.shedCandidates.length) | 0];
        const distSq = (c.rx - antPos.x) ** 2 + (c.rz - antPos.z) ** 2;
        if (distSq < 38 * 38) {
          const bend = this.windSystem.sampleBladeDisplacement(
            c.rx, c.ry, c.rz, c.height, c.tRatio, c.phase, c.stiffness
          );
          this.spawnFallingDrop(
            c.restPos.x + bend.dx,
            c.restPos.y + bend.dy,
            c.restPos.z + bend.dz,
            c.radius
          );
          break;
        }
      }
    }

    // 2. Interactive ant-brush shedding: moving through grass shakes loose overhead raindrops!
    if (antSpeed > 2.2 && elapsed - this.lastAntBrushTime > 0.14 && this.sheddingRate > 0.05) {
      for (let tries = 0; tries < 24; tries++) {
        const c = this.shedCandidates[(Math.random() * this.shedCandidates.length) | 0];
        const d = Math.hypot(c.rx - antPos.x, c.rz - antPos.z);
        if (d < 6.2) {
          this.lastAntBrushTime = elapsed;
          const bend = this.windSystem.sampleBladeDisplacement(
            c.rx, c.ry, c.rz, c.height, c.tRatio, c.phase, c.stiffness
          );
          this.spawnFallingDrop(
            c.restPos.x + bend.dx,
            c.restPos.y + bend.dy,
            c.restPos.z + bend.dz,
            c.radius * 1.15,
            (Math.random() - 0.5) * 1.5,
            (Math.random() - 0.5) * 1.5
          );
          break;
        }
      }
    }

    // 3. Simulate falling teardrops & puddle/soil impacts
    const gravity = 38.0;
    let fallingDirty = false;
    for (let i = 0; i < this.maxFalling; i++) {
      const d = this.fallingPool[i];
      if (!d.active) continue;
      fallingDirty = true;

      d.vel.y -= gravity * dt;
      d.pos.addScaledVector(d.vel, dt);

      const groundY = getTerrainHeight(d.pos.x, d.pos.z);
      const surfaceY = Math.max(groundY, PUDDLE_LEVEL);

      if (d.pos.y <= surfaceY + d.radius * 0.4) {
        d.active = false;
        this.fallingMesh.setMatrixAt(i, this._zeroMat);
        this._spawnSplashBurst(d.pos.x, surfaceY, d.pos.z, d.radius);

        const hitPuddle = groundY < PUDDLE_LEVEL;
        if (hitPuddle) {
          this.terrain.registerSplashImpact(d.pos.x, d.pos.z, elapsed, 1.0);
        }
        if (this.onSplashAudio) {
          const distToListener = d.pos.distanceTo(antPos);
          if (distToListener < 34) {
            this.onSplashAudio(distToListener, hitPuddle);
          }
        }
      } else {
        // Stretch slightly along velocity into a graceful falling teardrop
        const stretch = THREE.MathUtils.clamp(1.0 + Math.abs(d.vel.y) * 0.025, 1.0, 1.65);
        this._dummy.position.copy(d.pos);
        this._dummy.rotation.set(0, 0, 0);
        this._dummy.scale.set(d.radius / Math.sqrt(stretch), d.radius * stretch, d.radius / Math.sqrt(stretch));
        this._dummy.updateMatrix();
        this.fallingMesh.setMatrixAt(i, this._dummy.matrix);
      }
    }
    if (fallingDirty) this.fallingMesh.instanceMatrix.needsUpdate = true;

    // 4. Simulate splash crown micro-droplets
    let splashDirty = false;
    for (let i = 0; i < this.maxSplash; i++) {
      const s = this.splashPool[i];
      if (!s.active) continue;
      splashDirty = true;

      s.life += dt;
      if (s.life >= s.maxLife) {
        s.active = false;
        this.splashMesh.setMatrixAt(i, this._zeroMat);
        continue;
      }

      s.vel.y -= gravity * 0.85 * dt;
      s.pos.addScaledVector(s.vel, dt);
      const shrink = 1.0 - s.life / s.maxLife;
      this._dummy.position.copy(s.pos);
      this._dummy.rotation.set(0, 0, 0);
      this._dummy.scale.setScalar(Math.max(0.01, s.radius * shrink));
      this._dummy.updateMatrix();
      this.splashMesh.setMatrixAt(i, this._dummy.matrix);
    }
    if (splashDirty) this.splashMesh.instanceMatrix.needsUpdate = true;
  }
}
