import * as THREE from 'three';

/**
 * Shared wind & player-interaction state + matching CPU / GLSL displacement logic.
 * Ensures water droplets clinging to grass blades and fern fronds move in exact
 * lockstep with the curved vegetation surfaces.
 */
export class WindSystem {
  constructor() {
    this.uniforms = {
      uTime: { value: 0 },
      uWindStrength: { value: 1.0 },
      uWindDir: { value: new THREE.Vector2(0.84, 0.54).normalize() },
      uAntPos: { value: new THREE.Vector3(0, 0, 0) },
      uAntVelocity: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.52, 0.42, -0.74).normalize() },
      uSunIntensity: { value: 1.25 }
    };
  }

  update(dt, elapsed, antPos, antSpeed) {
    this.uniforms.uTime.value = elapsed;
    this.uniforms.uAntPos.value.copy(antPos);
    this.uniforms.uAntVelocity.value = THREE.MathUtils.lerp(
      this.uniforms.uAntVelocity.value,
      antSpeed,
      Math.min(1, dt * 8)
    );
  }

  /**
   * CPU mirror of the primary wind + ant-brush displacement at a blade root (rx, ry, rz)
   * Used for spawning detached falling droplets from exact moving blade tips.
   */
  sampleBladeDisplacement(rx, ry, rz, bladeHeight, tRatio, phase, stiffness = 1.0) {
    const t = this.uniforms.uTime.value;
    const strength = this.uniforms.uWindStrength.value;
    const wx = this.uniforms.uWindDir.value.x;
    const wz = this.uniforms.uWindDir.value.y;

    // Traveling forest gust wave + local turbulence + micro-flutter
    const waveCoord = (rx * wx + rz * wz) * 0.045 - t * 1.45;
    const macroGust = Math.sin(waveCoord) * 0.55 + Math.sin(waveCoord * 0.47 + 1.3) * 0.45;
    const crossSwirl = Math.cos((rx * -wz + rz * wx) * 0.07 - t * 1.05 + phase) * 0.3;
    const flutter = Math.sin(t * 5.2 + phase * 3.7 + tRatio * 2.5) * 0.08 * strength;

    const bendFactor = Math.pow(tRatio, 1.85) * bladeHeight * 0.24 * stiffness;
    const gustMag = (0.42 + 0.58 * macroGust) * strength + flutter;

    let dx = (wx * gustMag - wz * crossSwirl * strength) * bendFactor;
    let dz = (wz * gustMag + wx * crossSwirl * strength) * bendFactor;

    // Ant / camera proximity brush-apart
    const ax = rx - this.uniforms.uAntPos.value.x;
    const az = rz - this.uniforms.uAntPos.value.z;
    const ay = (ry + bladeHeight * 0.4) - this.uniforms.uAntPos.value.y;
    const horizDist = Math.hypot(ax, az);
    const pushRadius = 6.5;
    if (horizDist < pushRadius && Math.abs(ay) < bladeHeight * 0.95) {
      const push = Math.pow(1 - horizDist / pushRadius, 2.0) * Math.pow(tRatio, 1.35) * bladeHeight * 0.42;
      const inv = 1 / Math.max(0.001, horizDist);
      dx += ax * inv * push;
      dz += az * inv * push;
    }

    // Arc length conservation: as a blade bends sideways, its tip dips downward slightly
    const horizShift = Math.hypot(dx, dz);
    const dy = -Math.min(bladeHeight * 0.38, (horizShift * horizShift) / Math.max(1.5, 2.0 * bladeHeight));

    return { dx, dy, dz };
  }
}

export const WIND_GLSL_PARS = /* glsl */ `
  uniform float uTime;
  uniform float uWindStrength;
  uniform vec2 uWindDir;
  uniform vec3 uAntPos;
  uniform float uAntVelocity;

  vec3 computeBladeBend(vec3 rootPos, float bladeHeight, float tRatio, float phase, float stiffness) {
    float waveCoord = dot(rootPos.xz, uWindDir) * 0.045 - uTime * 1.45;
    float macroGust = sin(waveCoord) * 0.55 + sin(waveCoord * 0.47 + 1.3) * 0.45;
    vec2 perpDir = vec2(-uWindDir.y, uWindDir.x);
    float crossSwirl = cos(dot(rootPos.xz, perpDir) * 0.07 - uTime * 1.05 + phase) * 0.30;
    float flutter = sin(uTime * 5.2 + phase * 3.7 + tRatio * 2.5) * 0.08 * uWindStrength;

    float bendFactor = pow(tRatio, 1.85) * bladeHeight * 0.24 * stiffness;
    float gustMag = (0.42 + 0.58 * macroGust) * uWindStrength + flutter;

    vec2 offsetXZ = (uWindDir * gustMag + perpDir * (crossSwirl * uWindStrength)) * bendFactor;

    // Ant / camera body brushing through blades
    vec2 toBlade = rootPos.xz - uAntPos.xz;
    float horizDist = length(toBlade);
    float vertDist = abs((rootPos.y + bladeHeight * 0.4) - uAntPos.y);
    float pushRadius = 6.5;
    if (horizDist < pushRadius && vertDist < bladeHeight * 0.95) {
      float push = pow(1.0 - horizDist / pushRadius, 2.0) * pow(tRatio, 1.35) * bladeHeight * 0.42;
      vec2 pushDir = toBlade / max(0.001, horizDist);
      offsetXZ += pushDir * push;
    }

    float shiftLen = length(offsetXZ);
    float dy = -min(bladeHeight * 0.38, (shiftLen * shiftLen) / max(1.5, 2.0 * bladeHeight));
    return vec3(offsetXZ.x, dy, offsetXZ.y);
  }
`;
