import * as THREE from 'three';
import { getTerrainHeight, PUDDLE_LEVEL } from './Terrain.js';
import { fbm3D, seededRandom } from '../math/Noise.js';
import { WIND_GLSL_PARS } from './WindSystem.js';

/**
 * Populates the forest floor with non-grass botanical & geological life:
 * - Curved 3D wild clover patches (wind-animated + dew anchors)
 * - Arching woodland fern fronds (wind-animated + dew anchors)
 * - Smooth organic wet stones & mossy boulders (36x28 smooth FBM spheres + rock dew anchors)
 * - Translucent magical forest mushrooms with warm glowing gills
 * - Towering ancient perimeter tree trunks, snaking buttress roots & overhead canopy boughs
 */
export class ForestFlora {
  constructor(scene, textures, windSystem) {
    this.windSystem = windSystem;
    this.plantDewAnchors = []; // Animated leaf/frond anchors for clinging raindrops
    this.staticDewAnchors = []; // Stationary wet stone & mushroom cap anchors for raindrops

    this.group = new THREE.Group();
    scene.add(this.group);

    this._buildMossyStones(textures.stone, textures.envMap);
    this._buildCloverPatches(textures.clover, textures.grass, textures.envMap);
    this._buildWoodlandFerns(textures.fern, textures.envMap);
    this._buildMagicalMushrooms(textures.mushroom, textures.envMap);
    this._buildAncientTreesAndRoots(textures.bark, textures.fern, textures.envMap);
  }

  /**
   * High-segment organically sculpted wet pebbles & mossy forest stones (zero low-poly facets)
   */
  _buildMossyStones(stoneTex, envMap) {
    const rng = seededRandom(44119);
    // Create 3 distinct smooth organic boulder/pebble archetypes so rocks don't look identical
    const variants = [0, 1, 2].map((variantIdx) => {
      const geo = new THREE.SphereGeometry(1.0, 40, 30);
      const pos = geo.attributes.position;
      const v = new THREE.Vector3();
      const seedOff = variantIdx * 19.7;

      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        const n1 = fbm3D(v.x * 1.4 + seedOff, v.y * 1.4, v.z * 1.4 - seedOff, 4);
        const n2 = fbm3D(v.x * 3.2 - seedOff, v.y * 3.2 + seedOff, v.z * 3.2, 3) * 0.25;
        const disp = 1.0 + n1 * 0.34 + n2 * 0.12;
        v.multiplyScalar(disp);
        // Naturally river-worn flattened underside & smooth rounded crown
        v.y *= v.y < 0 ? 0.52 : 0.72;
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      geo.computeVertexNormals();
      return geo;
    });

    const mat = new THREE.MeshStandardMaterial({
      map: stoneTex.map,
      normalMap: stoneTex.normalMap,
      normalScale: new THREE.Vector2(1.2, 1.2),
      roughnessMap: stoneTex.roughnessMap,
      roughness: 0.32,
      metalness: 0.04,
      envMap,
      envMapIntensity: 1.15
    });

    const buckets = [[], [], []];
    const dummy = new THREE.Object3D();
    this.stoneColliders = [];

    for (let i = 0; i < 95; i++) {
      const r = 4.5 + Math.pow(rng(), 0.7) * 74.0;
      const ang = rng() * Math.PI * 2.0;
      const x = Math.cos(ang) * r;
      const z = Math.sin(ang) * r;
      const y = getTerrainHeight(x, z);

      const isBoulder = rng() < 0.22;
      const sx = isBoulder ? 2.8 + rng() * 4.2 : 0.65 + rng() * 1.65;
      const sy = sx * (0.58 + rng() * 0.36);
      const sz = sx * (0.78 + rng() * 0.44);

      dummy.position.set(x, y - sy * 0.22, z);
      dummy.rotation.set((rng() - 0.5) * 0.28, rng() * Math.PI * 2, (rng() - 0.5) * 0.28);
      dummy.scale.set(sx, sy, sz);
      dummy.updateMatrix();

      const bIdx = i % 3;
      buckets[bIdx].push(dummy.matrix.clone());

      if (sx > 1.2) {
        this.stoneColliders.push({ x, y: y + sy * 0.45, z, radius: Math.max(sx, sz) * 0.88, topY: y + sy * 0.52 });
      }

      // Scatter stationary post-rain water beads on the upper wet rock surface
      if (r < 62 && rng() < 0.65) {
        const dropCount = isBoulder ? 4 : 2;
        for (let d = 0; d < dropCount; d++) {
          const da = rng() * Math.PI * 2;
          const dr = rng() * 0.45;
          const localPt = new THREE.Vector3(
            Math.cos(da) * dr * sx,
            sy * (0.48 - dr * 0.18),
            Math.sin(da) * dr * sz
          );
          localPt.y += y - sy * 0.15;
          localPt.x += x;
          localPt.z += z;
          this.staticDewAnchors.push({
            pos: localPt,
            normal: new THREE.Vector3(Math.cos(da) * 0.25, 0.94, Math.sin(da) * 0.25).normalize(),
            scale: 0.22 + rng() * 0.32
          });
        }
      }
    }

    buckets.forEach((matrices, idx) => {
      if (!matrices.length) return;
      const inst = new THREE.InstancedMesh(variants[idx], mat, matrices.length);
      inst.castShadow = true;
      inst.receiveShadow = true;
      matrices.forEach((m, i) => inst.setMatrixAt(i, m));
      inst.instanceMatrix.needsUpdate = true;
      this.group.add(inst);
    });
  }

  /**
   * Curved 3-leaflet wild clover stems with wind animation & leaf water droplets
   */
  _buildCloverPatches(cloverTex, grassTex, envMap) {
    // Build a smooth curved 3-leaflet trifoliate crown geometry at y = 1.0 + slender curved petiole stem from y = 0..1
    const parts = [];

    // Slender smooth petiole stem (10 radial x 6 height segments)
    const stemCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0.02, 0.36, 0.03),
      new THREE.Vector3(0.04, 0.72, 0.08),
      new THREE.Vector3(0.03, 1.0, 0.12)
    ]);
    const stemGeo = new THREE.TubeGeometry(stemCurve, 8, 0.018, 8, false);
    // Map stem UVs to lower strip so it blends cleanly
    const stemUv = stemGeo.attributes.uv;
    for (let i = 0; i < stemUv.count; i++) {
      stemUv.setXY(i, 0.5, 0.08 + stemUv.getX(i) * 0.12);
    }

    // Build 3 cupped heart-shaped leaflets radiating from stem apex (0.03, 1.0, 0.12)
    const leafletGeos = [];
    for (let l = 0; l < 3; l++) {
      const g = new THREE.PlaneGeometry(0.46, 0.48, 6, 6);
      const pos = g.attributes.position;
      const uv = g.attributes.uv;
      for (let i = 0; i < pos.count; i++) {
        const u = uv.getX(i); // 0..1
        const v = uv.getY(i); // 0..1 (base to outer heart notch)
        const lx = (u - 0.5) * 0.46;
        const lz = v * 0.48;
        // Natural cupped leaflet fold along midrib + gentle downward droop toward margin
        const cup = Math.abs(u - 0.5) * 0.085 - Math.pow(v, 1.8) * 0.075;
        pos.setXYZ(i, lx, cup, lz);
      }
      g.computeVertexNormals();
      const rotY = (l / 3) * Math.PI * 2.0 + 0.25;
      g.rotateX(0.18);
      g.rotateY(rotY);
      g.translate(0.03, 1.0, 0.12);
      leafletGeos.push(g);
    }

    const mergedCloverGeo = mergeBufferGeometriesSimple([stemGeo, ...leafletGeos]);

    const rng = seededRandom(77321);
    const patchCenters = [];
    for (let p = 0; p < 28; p++) {
      const r = 3.5 + rng() * 58.0;
      const a = rng() * Math.PI * 2;
      patchCenters.push({ x: Math.cos(a) * r, z: Math.sin(a) * r, spread: 2.8 + rng() * 4.2 });
    }

    const matrices = [];
    const rootPos = [];
    const metas = [];
    const dummy = new THREE.Object3D();

    for (const patch of patchCenters) {
      const countInPatch = 18 + Math.floor(rng() * 20);
      for (let k = 0; k < countInPatch; k++) {
        const rr = Math.pow(rng(), 0.65) * patch.spread;
        const aa = rng() * Math.PI * 2;
        const x = patch.x + Math.cos(aa) * rr;
        const z = patch.z + Math.sin(aa) * rr;
        const y = getTerrainHeight(x, z);
        if (y < PUDDLE_LEVEL + 0.05) continue;

        const h = 4.2 + rng() * 4.8; // Ant eye is ~0.85, so clovers stand like waist-to-overhead umbrellas!
        const yaw = rng() * Math.PI * 2;
        const phase = rng() * Math.PI * 2;
        const stiffness = 0.65 + rng() * 0.35;

        dummy.position.set(x, y - 0.08, z);
        dummy.rotation.set((rng() - 0.5) * 0.16, yaw, (rng() - 0.5) * 0.16);
        dummy.scale.set(h, h, h);
        dummy.updateMatrix();

        matrices.push(dummy.matrix.clone());
        rootPos.push(x, y - 0.08, z);
        metas.push(h, phase, stiffness, 1.0);

        // Place glistening post-rain water beads right in the cupped clover leaflets!
        if (Math.hypot(x, z) < 58 && rng() < 0.55) {
          const leafAngle = (Math.floor(rng() * 3) / 3) * Math.PI * 2.0 + 0.25;
          const leafDist = (0.12 + rng() * 0.18) * h;
          const localWorld = new THREE.Vector3(
            0.03 * h + Math.sin(leafAngle) * leafDist,
            h * 0.99,
            0.12 * h + Math.cos(leafAngle) * leafDist
          ).applyMatrix4(dummy.matrix);

          this.plantDewAnchors.push({
            worldRestPos: localWorld,
            rx: x,
            ry: y - 0.08,
            rz: z,
            height: h,
            tRatio: 0.98,
            phase,
            stiffness,
            dropRadius: 0.24 + rng() * 0.34
          });
        }
      }
    }

    mergedCloverGeo.setAttribute(
      'aRootPos',
      new THREE.InstancedBufferAttribute(new Float32Array(rootPos), 3)
    );
    mergedCloverGeo.setAttribute(
      'aBladeMeta',
      new THREE.InstancedBufferAttribute(new Float32Array(metas), 4)
    );

    const mat = new THREE.MeshStandardMaterial({
      map: cloverTex.map,
      normalMap: cloverTex.normalMap,
      normalScale: new THREE.Vector2(1.1, 1.1),
      roughnessMap: cloverTex.roughnessMap,
      roughness: 0.26,
      alphaTest: 0.42,
      side: THREE.DoubleSide,
      envMap,
      envMapIntensity: 1.15
    });

    this._applyWindShader(mat, true);

    const inst = new THREE.InstancedMesh(mergedCloverGeo, mat, matrices.length);
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.frustumCulled = false;
    matrices.forEach((m, i) => inst.setMatrixAt(i, m));
    inst.instanceMatrix.needsUpdate = true;
    this.group.add(inst);
  }

  /**
   * Majestic arching woodland fern fronds with wind motion & clinging raindrops
   */
  _buildWoodlandFerns(fernTex, envMap) {
    // Smooth arched 3D frond strip (6 width cols x 14 height segs)
    const wSegs = 6;
    const hSegs = 14;
    const geo = new THREE.PlaneGeometry(0.46, 1.0, wSegs, hSegs);
    const pos = geo.attributes.position;
    const uv = geo.attributes.uv;

    for (let i = 0; i < pos.count; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i); // 0 = base, 1 = frond tip
      const across = (u - 0.5) * 2.0;

      // Graceful botanical arch outward (+Z) and gentle droop at frond tip
      const archOut = Math.pow(v, 1.35) * 0.62;
      const heightUp = v * (1.0 - Math.pow(v, 2.2) * 0.34);
      const vCup = Math.abs(across) * 0.045 * Math.sin(v * Math.PI);

      pos.setXYZ(i, across * 0.23, heightUp + vCup, archOut);
    }
    geo.computeVertexNormals();

    const rng = seededRandom(55193);
    const matrices = [];
    const rootPos = [];
    const metas = [];
    const dummy = new THREE.Object3D();

    // Place 42 lush multi-frond woodland fern rosettes
    for (let rosette = 0; rosette < 42; rosette++) {
      const rad = 9.0 + Math.pow(rng(), 0.75) * 68.0;
      const ang = rng() * Math.PI * 2;
      const cx = Math.cos(ang) * rad;
      const cz = Math.sin(ang) * rad;
      const cy = getTerrainHeight(cx, cz);
      if (cy < PUDDLE_LEVEL + 0.1) continue;

      const frondsInRosette = 7 + Math.floor(rng() * 5);
      const baseYaw = rng() * Math.PI * 2;
      const rosetteScale = 19.0 + rng() * 18.0; // Towering 19-37 units above the ant!

      for (let f = 0; f < frondsInRosette; f++) {
        const yaw = baseYaw + (f / frondsInRosette) * Math.PI * 2 + (rng() - 0.5) * 0.25;
        const h = rosetteScale * (0.82 + rng() * 0.34);
        const phase = rng() * Math.PI * 2;
        const stiffness = 0.55 + rng() * 0.3;

        dummy.position.set(cx, cy - 0.15, cz);
        dummy.rotation.set(0.12 + rng() * 0.22, yaw, (rng() - 0.5) * 0.1);
        dummy.scale.set(h, h, h);
        dummy.updateMatrix();

        matrices.push(dummy.matrix.clone());
        rootPos.push(cx, cy - 0.15, cz);
        metas.push(h, phase, stiffness, 1.0);

        // Attach heavy post-rain water droplets hanging from curved fern pinnae!
        if (rad < 62 && rng() < 0.7) {
          const dropCount = 2;
          for (let d = 0; d < dropCount; d++) {
            const tv = 0.42 + rng() * 0.46;
            const side = (rng() < 0.5 ? -1 : 1) * (0.06 + rng() * 0.08);
            const localPt = new THREE.Vector3(
              side,
              tv * (1.0 - Math.pow(tv, 2.2) * 0.34) - 0.012,
              Math.pow(tv, 1.35) * 0.62
            ).applyMatrix4(dummy.matrix);

            this.plantDewAnchors.push({
              worldRestPos: localPt,
              rx: cx,
              ry: cy - 0.15,
              rz: cz,
              height: h,
              tRatio: tv,
              phase,
              stiffness,
              dropRadius: 0.32 + rng() * 0.38
            });
          }
        }
      }
    }

    geo.setAttribute(
      'aRootPos',
      new THREE.InstancedBufferAttribute(new Float32Array(rootPos), 3)
    );
    geo.setAttribute(
      'aBladeMeta',
      new THREE.InstancedBufferAttribute(new Float32Array(metas), 4)
    );

    const mat = new THREE.MeshStandardMaterial({
      map: fernTex.map,
      normalMap: fernTex.normalMap,
      normalScale: new THREE.Vector2(1.2, 1.2),
      roughness: 0.28,
      metalness: 0.02,
      alphaTest: 0.38,
      side: THREE.DoubleSide,
      envMap,
      envMapIntensity: 1.1
    });

    this._applyWindShader(mat, true);

    const inst = new THREE.InstancedMesh(geo, mat, matrices.length);
    inst.castShadow = true;
    inst.receiveShadow = true;
    inst.frustumCulled = false;
    matrices.forEach((m, i) => inst.setMatrixAt(i, m));
    inst.instanceMatrix.needsUpdate = true;
    this.group.add(inst);
  }

  /**
   * Translucent magical woodland mushrooms with warm backlit / faintly glowing gills
   */
  _buildMagicalMushrooms(mushroomTex, envMap) {
    // Smooth organic bell/parasol cap via high-resolution LatheGeometry (44 segments)
    const capProfile = [];
    for (let i = 0; i <= 18; i++) {
      const t = i / 18; // 0 = apex, 1 = rim curl
      const r = Math.sin(t * Math.PI * 0.54) * 1.0;
      const y = Math.cos(t * Math.PI * 0.56) * 0.62;
      capProfile.push(new THREE.Vector2(r, y));
    }
    // Tuck inward slightly for delicate gill underside
    capProfile.push(new THREE.Vector2(0.92, -0.06));
    capProfile.push(new THREE.Vector2(0.14, 0.18));

    const capGeo = new THREE.LatheGeometry(capProfile, 44);
    capGeo.computeVertexNormals();

    const capMat = new THREE.MeshPhysicalMaterial({
      map: mushroomTex.map,
      normalMap: mushroomTex.normalMap,
      normalScale: new THREE.Vector2(0.9, 0.9),
      roughness: 0.18, // Wet slimy post-rain mushroom cuticle!
      transmission: 0.38,
      thickness: 0.9,
      ior: 1.42,
      emissive: new THREE.Color(0xffc978),
      emissiveIntensity: 0.16,
      envMap,
      envMapIntensity: 1.25
    });

    const stemMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0xefe4cf),
      roughness: 0.45,
      emissive: new THREE.Color(0xffe2a8),
      emissiveIntensity: 0.08,
      envMap,
      envMapIntensity: 0.8
    });

    const rng = seededRandom(88412);
    for (let c = 0; c < 18; c++) {
      const rad = 7.5 + rng() * 58.0;
      const ang = rng() * Math.PI * 2;
      const bx = Math.cos(ang) * rad;
      const bz = Math.sin(ang) * rad;
      const by = getTerrainHeight(bx, bz);
      if (by < PUDDLE_LEVEL + 0.15) continue;

      const count = 2 + Math.floor(rng() * 4);
      for (let m = 0; m < count; m++) {
        const mx = bx + (rng() - 0.5) * 2.8;
        const mz = bz + (rng() - 0.5) * 2.8;
        const my = getTerrainHeight(mx, mz);

        const height = 4.5 + rng() * 8.5;
        const capScale = height * (0.28 + rng() * 0.14);
        const leanX = (rng() - 0.5) * 0.55;
        const leanZ = (rng() - 0.5) * 0.55;

        const curve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(mx, my - 0.2, mz),
          new THREE.Vector3(mx + leanX * 0.4, my + height * 0.45, mz + leanZ * 0.4),
          new THREE.Vector3(mx + leanX, my + height, mz + leanZ)
        ]);
        const stemGeo = new THREE.TubeGeometry(curve, 14, capScale * 0.14, 14, false);
        const stemMesh = new THREE.Mesh(stemGeo, stemMat);
        stemMesh.castShadow = true;
        stemMesh.receiveShadow = true;
        this.group.add(stemMesh);

        const capMesh = new THREE.Mesh(capGeo, capMat);
        capMesh.position.set(mx + leanX, my + height - capScale * 0.12, mz + leanZ);
        capMesh.scale.setScalar(capScale);
        capMesh.rotation.set(leanZ * 0.18, rng() * Math.PI * 2, -leanX * 0.18);
        capMesh.castShadow = true;
        capMesh.receiveShadow = true;
        this.group.add(capMesh);

        // Dew beads glistening on wet mushroom caps!
        if (rad < 58) {
          for (let d = 0; d < 2; d++) {
            const da = rng() * Math.PI * 2;
            const dr = (0.25 + rng() * 0.45) * capScale;
            const dy = Math.cos((dr / capScale) * Math.PI * 0.52) * 0.62 * capScale;
            this.staticDewAnchors.push({
              pos: new THREE.Vector3(
                capMesh.position.x + Math.cos(da) * dr,
                capMesh.position.y + dy,
                capMesh.position.z + Math.sin(da) * dr
              ),
              normal: new THREE.Vector3(Math.cos(da) * 0.4, 0.9, Math.sin(da) * 0.4).normalize(),
              scale: 0.2 + rng() * 0.26
            });
          }
        }
      }
    }
  }

  /**
   * Towering ancient woodland tree trunks, snaking mossy buttress roots & high dappled canopy
   */
  _buildAncientTreesAndRoots(barkTex, fernTex, envMap) {
    const barkMat = new THREE.MeshStandardMaterial({
      map: barkTex.map,
      normalMap: barkTex.normalMap,
      normalScale: new THREE.Vector2(1.6, 1.6),
      roughnessMap: barkTex.roughnessMap,
      roughness: 0.72,
      envMap,
      envMapIntensity: 0.85
    });

    const rng = seededRandom(314159);
    const treeCount = 16;

    for (let t = 0; t < treeCount; t++) {
      // Leave a natural sunny gap in the sunbreak direction (0.52, 0.42, -0.74) so golden beams pour in!
      const baseAngle = (t / treeCount) * Math.PI * 2.0 + (rng() - 0.5) * 0.18;
      const dirX = Math.cos(baseAngle);
      const dirZ = Math.sin(baseAngle);
      const sunGapDot = dirX * 0.56 + dirZ * -0.82;
      const dist = sunGapDot > 0.65 ? 88 + rng() * 14 : 66 + rng() * 20;

      const tx = dirX * dist;
      const tz = dirZ * dist;
      const ty = getTerrainHeight(tx, tz);
      const trunkRadius = 6.5 + rng() * 4.5;
      const trunkHeight = 115 + rng() * 45;

      // High-segment organically fluted trunk cylinder
      const trunkGeo = new THREE.CylinderGeometry(trunkRadius * 0.68, trunkRadius * 1.28, trunkHeight, 32, 18, true);
      const pos = trunkGeo.attributes.position;
      const v = new THREE.Vector3();
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i);
        const hNorm = (v.y + trunkHeight * 0.5) / trunkHeight;
        const angle = Math.atan2(v.z, v.x);
        const flute = Math.sin(angle * 6.0 + hNorm * 3.0) * (1.0 - hNorm * 0.7) * 0.18;
        const gnarl = fbm3D(v.x * 0.08 + t, v.y * 0.05, v.z * 0.08, 3) * 0.16;
        const scaleR = 1.0 + flute + gnarl;
        v.x *= scaleR;
        v.z *= scaleR;
        pos.setXYZ(i, v.x, v.y, v.z);
      }
      trunkGeo.computeVertexNormals();

      const trunk = new THREE.Mesh(trunkGeo, barkMat);
      trunk.position.set(tx, ty + trunkHeight * 0.46, tz);
      trunk.castShadow = true;
      trunk.receiveShadow = true;
      this.group.add(trunk);

      // Snaking mossy buttress roots reaching inward toward the grass meadow!
      const rootCount = 3 + Math.floor(rng() * 2);
      for (let r = 0; r < rootCount; r++) {
        const rootAng = baseAngle + Math.PI + (rng() - 0.5) * 1.25;
        const reach = 16 + rng() * 20;
        const p0 = new THREE.Vector3(tx, ty + 8 + rng() * 5, tz);
        const p1 = new THREE.Vector3(
          tx + Math.cos(rootAng) * reach * 0.42,
          getTerrainHeight(tx + Math.cos(rootAng) * reach * 0.42, tz + Math.sin(rootAng) * reach * 0.42) + 2.4,
          tz + Math.sin(rootAng) * reach * 0.42
        );
        const p2 = new THREE.Vector3(
          tx + Math.cos(rootAng + 0.18) * reach * 0.78,
          getTerrainHeight(tx + Math.cos(rootAng + 0.18) * reach * 0.78, tz + Math.sin(rootAng + 0.18) * reach * 0.78) + 0.65,
          tz + Math.sin(rootAng + 0.18) * reach * 0.78
        );
        const p3 = new THREE.Vector3(
          tx + Math.cos(rootAng + 0.25) * reach,
          getTerrainHeight(tx + Math.cos(rootAng + 0.25) * reach, tz + Math.sin(rootAng + 0.25) * reach) - 0.9,
          tz + Math.sin(rootAng + 0.25) * reach
        );

        const rootCurve = new THREE.CatmullRomCurve3([p0, p1, p2, p3]);
        const rootGeo = createTaperedTubeGeometry(rootCurve, 22, trunkRadius * 0.34, 0.35, 14);
        const rootMesh = new THREE.Mesh(rootGeo, barkMat);
        rootMesh.castShadow = true;
        rootMesh.receiveShadow = true;
        this.group.add(rootMesh);
      }
    }
  }

  _applyWindShader(material, includeTranslucency = true) {
    const windUniforms = this.windSystem.uniforms;
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, windUniforms);

      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          /* glsl */ `
          #include <common>
          attribute vec3 aRootPos;
          attribute vec4 aBladeMeta;
          varying vec3 vWorldFloraPos;
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
          float tRatio = clamp((worldPos.y - aRootPos.y) / max(0.5, aBladeMeta.x), 0.0, 1.2);
          worldPos.xyz += computeBladeBend(aRootPos, aBladeMeta.x, tRatio, aBladeMeta.y, aBladeMeta.z);
          vWorldFloraPos = worldPos.xyz;
          mvPosition = viewMatrix * worldPos;
          gl_Position = projectionMatrix * mvPosition;
          `
        )
        .replace(
          '#include <worldpos_vertex>',
          /* glsl */ `
          vec4 worldPosition = vec4( vWorldFloraPos, 1.0 );
          `
        );

      if (includeTranslucency) {
        shader.fragmentShader = shader.fragmentShader
          .replace(
            '#include <common>',
            /* glsl */ `
            #include <common>
            uniform vec3 uSunDir;
            uniform float uSunIntensity;
            varying vec3 vWorldFloraPos;
            `
          )
          .replace(
            '#include <lights_fragment_end>',
            /* glsl */ `
            #include <lights_fragment_end>
            vec3 viewDirW = normalize(cameraPosition - vWorldFloraPos);
            float backSun = pow(max(0.0, dot(viewDirW, -uSunDir)), 2.4);
            reflectedLight.directDiffuse += diffuseColor.rgb * vec3(0.62, 0.95, 0.28) * backSun * 0.78 * uSunIntensity;
            `
          );
      }
    };
  }
}

/**
 * Lightweight BufferGeometry merger for matching position/normal/uv indexed geometries
 */
function mergeBufferGeometriesSimple(geos) {
  let totalVerts = 0;
  let totalIndices = 0;
  for (const g of geos) {
    totalVerts += g.attributes.position.count;
    totalIndices += g.index ? g.index.count : g.attributes.position.count;
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  const indices = new Uint32Array(totalIndices);

  let vOffset = 0;
  let iOffset = 0;

  for (const g of geos) {
    const pos = g.attributes.position;
    const norm = g.attributes.normal;
    const uv = g.attributes.uv;
    positions.set(pos.array, vOffset * 3);
    normals.set(norm.array, vOffset * 3);
    uvs.set(uv.array, vOffset * 2);

    if (g.index) {
      const idxArr = g.index.array;
      for (let i = 0; i < idxArr.length; i++) {
        indices[iOffset + i] = idxArr[i] + vOffset;
      }
      iOffset += idxArr.length;
    } else {
      for (let i = 0; i < pos.count; i++) {
        indices[iOffset + i] = vOffset + i;
      }
      iOffset += pos.count;
    }
    vOffset += pos.count;
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.setIndex(new THREE.BufferAttribute(indices, 1));
  return merged;
}

/**
 * Smooth tapered organic root geometry along a 3D CatmullRomCurve3
 */
function createTaperedTubeGeometry(curve, tubularSegments, startRadius, endRadius, radialSegments) {
  const frames = curve.computeFrenetFrames(tubularSegments, false);
  const vertCount = (tubularSegments + 1) * (radialSegments + 1);
  const positions = new Float32Array(vertCount * 3);
  const normals = new Float32Array(vertCount * 3);
  const uvs = new Float32Array(vertCount * 2);
  const indices = [];

  const P = new THREE.Vector3();
  const N = new THREE.Vector3();
  const B = new THREE.Vector3();
  const normal = new THREE.Vector3();

  for (let i = 0; i <= tubularSegments; i++) {
    const u = i / tubularSegments;
    curve.getPointAt(u, P);
    N.copy(frames.normals[i]);
    B.copy(frames.binormals[i]);
    const radius = THREE.MathUtils.lerp(startRadius, endRadius, Math.pow(u, 0.75));

    for (let j = 0; j <= radialSegments; j++) {
      const v = j / radialSegments;
      const theta = v * Math.PI * 2;
      const sin = Math.sin(theta);
      const cos = -Math.cos(theta);

      normal.x = cos * N.x + sin * B.x;
      normal.y = cos * N.y + sin * B.y;
      normal.z = cos * N.z + sin * B.z;
      normal.normalize();

      const idx = i * (radialSegments + 1) + j;
      positions[idx * 3] = P.x + radius * normal.x;
      positions[idx * 3 + 1] = P.y + radius * normal.y;
      positions[idx * 3 + 2] = P.z + radius * normal.z;

      normals[idx * 3] = normal.x;
      normals[idx * 3 + 1] = normal.y;
      normals[idx * 3 + 2] = normal.z;

      uvs[idx * 2] = v * 2.0;
      uvs[idx * 2 + 1] = u * 4.0;
    }
  }

  for (let i = 0; i < tubularSegments; i++) {
    for (let j = 0; j < radialSegments; j++) {
      const a = (radialSegments + 1) * i + j;
      const b = (radialSegments + 1) * (i + 1) + j;
      const c = (radialSegments + 1) * (i + 1) + (j + 1);
      const d = (radialSegments + 1) * i + (j + 1);
      indices.push(a, b, d);
      indices.push(b, c, d);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  return geo;
}
