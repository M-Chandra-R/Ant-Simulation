import * as THREE from 'three';
import { getTerrainHeight, getTerrainNormal, PUDDLE_LEVEL } from '../world/Terrain.js';

/**
 * Hybrid Ant-POV & Macro Free-Fly Camera Controller:
 * - Grounded Ant Mode (Default): Miniature 0.85-unit eye height (~2 mm), climbs wet stones,
 *   wades shallow puddle rims, hops with Space, crouches with C/Ctrl, subtle multi-legged
 *   step cadence, and delicate curved chitin antennae framing the lower-outer periphery.
 * - Macro Free-Fly Mode (Toggle with [F]): Smooth 6-DOF gliding through grass & droplets.
 */
export class AntController {
  constructor(camera, domElement, stoneColliders = []) {
    this.camera = camera;
    this.domElement = domElement;
    this.stoneColliders = stoneColliders;

    this.isLocked = false;
    this.mode = 'ant'; // 'ant' | 'fly'

    this.position = new THREE.Vector3(0, getTerrainHeight(0, 6.0) + 1.45, 6.0);
    this.velocity = new THREE.Vector3();
    this.horizontalSpeed = 0;

    this.yaw = -0.44; // Face directly toward the sunlit puddle, arching wet grass & golden sunbreak!
    this.pitch = 0.07; // Slight upward gaze into towering wet grass canopy & sunbeams
    this.targetYaw = this.yaw;
    this.targetPitch = this.pitch;

    this.antEyeHeight = 1.45;
    this.crouchEyeHeight = 0.72;
    this.verticalVel = 0;
    this.isGrounded = true;
    this.stepPhase = 0;

    this.keys = {
      forward: false,
      backward: false,
      left: false,
      right: false,
      up: false,
      down: false,
      sprint: false
    };

    this.onModeChange = null;
    this._euler = new THREE.Euler(0, 0, 0, 'YXZ');
    this._forward = new THREE.Vector3();
    this._right = new THREE.Vector3();
    this._groundNormal = new THREE.Vector3(0, 1, 0);
    this._smoothedSlopeQuat = new THREE.Quaternion();

    this._buildAntennaeRig();
    this._bindEvents();
    this._syncCamera(0);
  }

  /**
   * Subtle, smooth-curved dark amber chitin antennae in peripheral view during Ant POV
   */
  _buildAntennaeRig() {
    this.antennaeGroup = new THREE.Group();
    const chitinMat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x2b170e),
      roughness: 0.24,
      metalness: 0.08
    });

    [-1, 1].forEach((side) => {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(side * 0.14, -0.11, -0.08),
        new THREE.Vector3(side * 0.20, -0.05, -0.24),
        new THREE.Vector3(side * 0.25, -0.02, -0.38),
        new THREE.Vector3(side * 0.23, -0.035, -0.46)
      ]);
      // Smooth tapered antenna feeler (gracefully narrows to 0.0005 tip)
      const segs = 20;
      const radSegs = 10;
      const geo = new THREE.TubeGeometry(curve, segs, 0.0024, radSegs, false);
      const pos = geo.attributes.position;
      const center = new THREE.Vector3();
      const v = new THREE.Vector3();
      for (let i = 0; i <= segs; i++) {
        const u = i / segs;
        curve.getPointAt(u, center);
        const taper = 1.0 - Math.pow(u, 1.35) * 0.78;
        for (let j = 0; j <= radSegs; j++) {
          const idx = i * (radSegs + 1) + j;
          v.fromBufferAttribute(pos, idx).sub(center).multiplyScalar(taper).add(center);
          pos.setXYZ(idx, v.x, v.y, v.z);
        }
      }
      geo.computeVertexNormals();

      const mesh = new THREE.Mesh(geo, chitinMat);
      mesh.userData.side = side;
      this.antennaeGroup.add(mesh);
    });

    this.camera.add(this.antennaeGroup);
  }

  _bindEvents() {
    document.addEventListener('pointerlockchange', () => {
      this.isLocked = document.pointerLockElement === this.domElement;
    });

    document.addEventListener('mousemove', (e) => {
      if (!this.isLocked && !this._mouseDragActive) return;
      const sensitivity = 0.0021;
      this.targetYaw -= e.movementX * sensitivity;
      this.targetPitch -= e.movementY * sensitivity;
      this.targetPitch = THREE.MathUtils.clamp(this.targetPitch, -Math.PI * 0.47, Math.PI * 0.48);
    });

    // Fallback mouse-drag & touch-drag look for mobile/tablet or non-PointerLock browsers
    this._mouseDragActive = false;
    this._lastTouchX = 0;
    this._lastTouchY = 0;
    this.domElement.addEventListener('mousedown', () => {
      if (!this.isLocked) this._mouseDragActive = true;
    });
    window.addEventListener('mouseup', () => {
      this._mouseDragActive = false;
    });
    this.domElement.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        this._lastTouchX = e.touches[0].clientX;
        this._lastTouchY = e.touches[0].clientY;
      } else if (e.touches.length >= 2) {
        // Two-finger hold moves forward on mobile/tablet
        this.keys.forward = true;
      }
    }, { passive: true });
    this.domElement.addEventListener('touchmove', (e) => {
      if (e.touches.length >= 1) {
        const dx = e.touches[0].clientX - this._lastTouchX;
        const dy = e.touches[0].clientY - this._lastTouchY;
        this._lastTouchX = e.touches[0].clientX;
        this._lastTouchY = e.touches[0].clientY;
        this.targetYaw -= dx * 0.0042;
        this.targetPitch = THREE.MathUtils.clamp(this.targetPitch - dy * 0.0042, -Math.PI * 0.47, Math.PI * 0.48);
      }
    }, { passive: true });
    window.addEventListener('touchend', (e) => {
      if (e.touches.length < 2) this.keys.forward = false;
    });

    window.addEventListener('keydown', (e) => {
      if (e.repeat && (e.code === 'KeyF' || e.code === 'Space')) return;
      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          this.keys.forward = true;
          break;
        case 'KeyS':
        case 'ArrowDown':
          this.keys.backward = true;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          this.keys.left = true;
          break;
        case 'KeyD':
        case 'ArrowRight':
          this.keys.right = true;
          break;
        case 'Space':
          this.keys.up = true;
          if (this.mode === 'ant' && this.isGrounded && this.isLocked) {
            this.verticalVel = 11.5; // Nimble ant hop onto pebbles/roots
            this.isGrounded = false;
          }
          break;
        case 'KeyC':
        case 'ControlLeft':
        case 'ControlRight':
          this.keys.down = true;
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          this.keys.sprint = true;
          break;
        case 'KeyF':
          this.toggleMode();
          break;
      }
    });

    window.addEventListener('keyup', (e) => {
      switch (e.code) {
        case 'KeyW':
        case 'ArrowUp':
          this.keys.forward = false;
          break;
        case 'KeyS':
        case 'ArrowDown':
          this.keys.backward = false;
          break;
        case 'KeyA':
        case 'ArrowLeft':
          this.keys.left = false;
          break;
        case 'KeyD':
        case 'ArrowRight':
          this.keys.right = false;
          break;
        case 'Space':
          this.keys.up = false;
          break;
        case 'KeyC':
        case 'ControlLeft':
        case 'ControlRight':
          this.keys.down = false;
          break;
        case 'ShiftLeft':
        case 'ShiftRight':
          this.keys.sprint = false;
          break;
      }
    });
  }

  lock() {
    this.domElement.requestPointerLock?.();
  }

  toggleMode() {
    this.mode = this.mode === 'ant' ? 'fly' : 'ant';
    this.antennaeGroup.visible = this.mode === 'ant';
    if (this.mode === 'fly') {
      this.verticalVel = 0;
      this.position.y = Math.max(this.position.y, this._sampleSurfaceHeight(this.position.x, this.position.z) + 1.4);
    }
    if (this.onModeChange) this.onModeChange(this.mode);
  }

  _sampleSurfaceHeight(x, z) {
    let h = getTerrainHeight(x, z);
    // Keep ant buoyant at shallow puddle surface rather than drowning under mud
    h = Math.max(h, PUDDLE_LEVEL - 0.15);

    // Allow climbing smoothly over mossy stones
    for (let i = 0; i < this.stoneColliders.length; i++) {
      const s = this.stoneColliders[i];
      const d = Math.hypot(x - s.x, z - s.z);
      if (d < s.radius) {
        const dome = Math.sqrt(Math.max(0, 1.0 - (d / s.radius) ** 2));
        const stoneTop = getTerrainHeight(s.x, s.z) + (s.topY - getTerrainHeight(s.x, s.z)) * dome;
        if (stoneTop > h) h = stoneTop;
      }
    }
    return h;
  }

  update(dt, elapsed) {
    // Smooth mouse look damping
    const lookSmooth = 1.0 - Math.exp(-dt * 24.0);
    this.yaw = THREE.MathUtils.lerp(this.yaw, this.targetYaw, lookSmooth);
    this.pitch = THREE.MathUtils.lerp(this.pitch, this.targetPitch, lookSmooth);

    const moveZ = (this.keys.forward ? 1 : 0) - (this.keys.backward ? 1 : 0);
    const moveX = (this.keys.right ? 1 : 0) - (this.keys.left ? 1 : 0);

    if (this.mode === 'ant') {
      this._updateAntMode(dt, elapsed, moveX, moveZ);
    } else {
      this._updateFlyMode(dt, moveX, moveZ);
    }

    // Keep player inside the lush 76-unit forested clearing radius
    const radialDist = Math.hypot(this.position.x, this.position.z);
    if (radialDist > 76.0) {
      const pull = 76.0 / radialDist;
      this.position.x *= pull;
      this.position.z *= pull;
    }

    this._syncCamera(elapsed, dt);
  }

  _updateAntMode(dt, elapsed, moveX, moveZ) {
    const baseSpeed = this.keys.sprint ? 12.8 : 6.4;
    this._forward.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw)).normalize();
    this._right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw)).normalize();

    const wishDir = new THREE.Vector3()
      .addScaledVector(this._forward, moveZ)
      .addScaledVector(this._right, moveX);
    if (wishDir.lengthSq() > 0) wishDir.normalize();

    const accel = 1.0 - Math.exp(-dt * 14.0);
    this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, wishDir.x * baseSpeed, accel);
    this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, wishDir.z * baseSpeed, accel);

    this.position.x += this.velocity.x * dt;
    this.position.z += this.velocity.z * dt;
    this.horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);

    const targetEye = this.keys.down ? this.crouchEyeHeight : this.antEyeHeight;
    const floorY = this._sampleSurfaceHeight(this.position.x, this.position.z) + targetEye;

    if (!this.isGrounded) {
      this.verticalVel -= 32.0 * dt;
      this.position.y += this.verticalVel * dt;
      if (this.position.y <= floorY) {
        this.position.y = floorY;
        this.verticalVel = 0;
        this.isGrounded = true;
      }
    } else {
      this.position.y = THREE.MathUtils.lerp(this.position.y, floorY, 1.0 - Math.exp(-dt * 18.0));
    }

    if (this.horizontalSpeed > 0.25 && this.isGrounded) {
      this.stepPhase += dt * this.horizontalSpeed * 2.3;
    }
  }

  _updateFlyMode(dt, moveX, moveZ) {
    const flySpeed = this.keys.sprint ? 26.0 : 12.0;
    this._euler.set(this.pitch, this.yaw, 0, 'YXZ');
    this._forward.set(0, 0, -1).applyEuler(this._euler).normalize();
    this._right.set(1, 0, 0).applyEuler(this._euler).normalize();

    const moveY = (this.keys.up ? 1 : 0) - (this.keys.down ? 1 : 0);
    const wish = new THREE.Vector3()
      .addScaledVector(this._forward, moveZ)
      .addScaledVector(this._right, moveX);
    wish.y += moveY * 0.85;
    if (wish.lengthSq() > 1.0) wish.normalize();

    const damping = 1.0 - Math.exp(-dt * 10.0);
    this.velocity.lerp(wish.multiplyScalar(flySpeed), damping);
    this.position.addScaledVector(this.velocity, dt);
    this.horizontalSpeed = this.velocity.length();

    // Soft terrain floor buffer so free-fly never clips underground
    const minFloor = this._sampleSurfaceHeight(this.position.x, this.position.z) + 0.42;
    if (this.position.y < minFloor) {
      this.position.y = minFloor;
      if (this.velocity.y < 0) this.velocity.y = 0;
    }
    this.position.y = Math.min(this.position.y, 68.0);
  }

  _syncCamera(elapsed, dt = 0.016) {
    this._euler.set(this.pitch, this.yaw, 0, 'YXZ');
    this.camera.position.copy(this.position);

    if (this.mode === 'ant') {
      // Subtle hexapod gait bobbing when walking
      const moveFactor = THREE.MathUtils.clamp(this.horizontalSpeed / 8.0, 0, 1.2);
      const bobY = Math.sin(this.stepPhase * 2.0) * 0.028 * moveFactor;
      const swayRoll = Math.cos(this.stepPhase) * 0.012 * moveFactor;
      this.camera.position.y += bobY;

      // Gentle terrain contour feel without disorienting horizon tilt
      getTerrainNormal(this.position.x, this.position.z, this._groundNormal);
      const gentleUp = this._groundNormal.lerp(new THREE.Vector3(0, 1, 0), 0.78).normalize();
      const targetSlope = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), gentleUp);
      this._smoothedSlopeQuat.slerp(targetSlope, 1.0 - Math.exp(-dt * 8.0));

      const lookQuat = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(this.pitch, this.yaw, swayRoll, 'YXZ')
      );
      this.camera.quaternion.copy(this._smoothedSlopeQuat).multiply(lookQuat);

      // Animate sensory antennae feelers
      this.antennaeGroup.children.forEach((ant, i) => {
        const side = ant.userData.side;
        ant.rotation.x = Math.sin(elapsed * 3.4 + i * 1.9 + this.stepPhase * 0.5) * 0.055;
        ant.rotation.z = side * Math.cos(elapsed * 2.7 + i) * 0.04;
      });
    } else {
      this.camera.quaternion.setFromEuler(this._euler);
    }
  }
}
