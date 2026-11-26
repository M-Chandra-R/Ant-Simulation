import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { FXAAShader } from 'three/addons/shaders/FXAAShader.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/**
 * Hardware-Depth Macro Photography Post-Processing Pipeline:
 * 1. Renders (scene, camera) into a dedicated offscreen `sceneRT` with its own `DepthTexture`
 *    (completely isolated from EffectComposer's ping-pong buffers so WebGL2 never hits an FBO feedback loop!)
 * 2. Feeds `sceneRT.texture` + `sceneRT.depthTexture` into a 16-tap Vogel-spiral Macro Bokeh ShaderPass
 * 3. Applies UnrealBloomPass for sunlit water-droplet caustics & canopy sunbreak
 * 4. Applies OutputPass (ACES Filmic tone mapping + sRGB) & crisp FXAA anti-aliasing
 */
export class PostEffects {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;

    const pr = Math.min(window.devicePixelRatio, 2);
    const rw = Math.max(1, Math.floor(window.innerWidth * pr));
    const rh = Math.max(1, Math.floor(window.innerHeight * pr));

    // Choose HalfFloatType when color-buffer float rendering is supported, else UnsignedByteType
    const supportsHalfFloatRT =
      renderer.capabilities.isWebGL2 &&
      (renderer.extensions.has('EXT_color_buffer_float') ||
        renderer.extensions.has('EXT_color_buffer_half_float'));
    const rtType = supportsHalfFloatRT ? THREE.HalfFloatType : THREE.UnsignedByteType;

    // Dedicated scene target with hardware depth (never shared with EffectComposer writeBuffer)
    this.depthTexture = new THREE.DepthTexture(rw, rh);
    this.sceneRT = new THREE.WebGLRenderTarget(rw, rh, {
      type: rtType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthTexture: this.depthTexture,
      depthBuffer: true
    });

    // Standard EffectComposer (uses its own clean ping-pong targets without depthTexture)
    const composerRT = new THREE.WebGLRenderTarget(rw, rh, {
      type: rtType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter
    });
    this.composer = new EffectComposer(renderer, composerRT);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(window.innerWidth, window.innerHeight);

    // Pass 1: Seed composer pipeline from sceneRT + apply 16-tap Optical Macro Depth-of-Field
    // Use ShaderMaterial directly so ShaderPass does NOT clone/disconnect render-target textures!
    const dofMaterial = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.sceneRT.texture },
        tDepth: { value: this.depthTexture },
        uNear: { value: camera.near },
        uFar: { value: camera.far },
        uFocusDist: { value: 13.5 },
        uFocalRange: { value: 11.0 },
        uMaxBlur: { value: 0.004 },
        uAspect: { value: window.innerWidth / Math.max(1, window.innerHeight) }
      },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D tScene;
        uniform sampler2D tDepth;
        uniform float uNear;
        uniform float uFar;
        uniform float uFocusDist;
        uniform float uFocalRange;
        uniform float uMaxBlur;
        uniform float uAspect;
        varying vec2 vUv;

        float linearizeDepth(float d) {
          float z = d * 2.0 - 1.0;
          return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
        }

        void main() {
          vec4 centerCol = texture2D(tScene, vUv);
          if (uMaxBlur <= 0.0001) {
            gl_FragColor = centerCol;
            return;
          }

          float rawDepth = texture2D(tDepth, vUv).x;
          float viewDist = linearizeDepth(rawDepth);

          float distDelta = abs(viewDist - uFocusDist);
          float coc = clamp((distDelta - uFocalRange * 0.45) / (uFocalRange * 3.2), 0.0, 1.0);
          if (viewDist > 0.58 && viewDist < 1.6) {
            coc = max(coc, (1.6 - viewDist) * 0.55);
          }

          float radius = coc * uMaxBlur;
          if (radius < 0.00025) {
            gl_FragColor = centerCol;
            return;
          }

          vec3 acc = centerCol.rgb;
          float totalW = 1.0;
          const float GOLDEN_ANGLE = 2.39996323;

          for (int i = 1; i <= 16; i++) {
            float fi = float(i);
            float r = sqrt(fi / 16.0) * radius;
            float theta = fi * GOLDEN_ANGLE;
            vec2 offset = vec2(cos(theta) / uAspect, sin(theta)) * r;

            vec2 sampleUv = clamp(vUv + offset, 0.001, 0.999);
            float sDepth = linearizeDepth(texture2D(tDepth, sampleUv).x);
            float weight = sDepth < viewDist - 2.0 ? 0.35 : 1.0;

            acc += texture2D(tScene, sampleUv).rgb * weight;
            totalW += weight;
          }

          gl_FragColor = vec4(acc / totalW, 1.0);
        }
      `
    });
    this.macroDofPass = new ShaderPass(dofMaterial);
    this.composer.addPass(this.macroDofPass);

    // Pass 2: Subtle Sunbreak & Droplet Sparkle Bloom
    this.bloomPass = new UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.26,
      0.58,
      0.88
    );
    this.composer.addPass(this.bloomPass);

    // Pass 3: ACES Filmic Tone Mapping + sRGB Conversion
    const outputPass = new OutputPass();
    this.composer.addPass(outputPass);

    // Pass 4: Fast Subpixel Anti-Aliasing (works universally on desktop & mobile WebGL)
    this.fxaaPass = new ShaderPass(FXAAShader);
    this.fxaaPass.material.uniforms.resolution.value.set(1 / rw, 1 / rh);
    this.composer.addPass(this.fxaaPass);

    this.setDofIntensity(0.55);
  }

  setDofIntensity(amount) {
    // Keep macroDofPass always enabled so it copies sceneRT into composer even when blur = 0!
    this.macroDofPass.uniforms.uMaxBlur.value = amount > 0.02 ? 0.0072 * amount : 0.0;
  }

  updateFocus(antMode) {
    const targetFocus = antMode === 'ant' ? 12.5 : 22.0;
    const targetRange = antMode === 'ant' ? 10.5 : 18.0;
    this.macroDofPass.uniforms.uFocusDist.value = THREE.MathUtils.lerp(
      this.macroDofPass.uniforms.uFocusDist.value,
      targetFocus,
      0.08
    );
    this.macroDofPass.uniforms.uFocalRange.value = THREE.MathUtils.lerp(
      this.macroDofPass.uniforms.uFocalRange.value,
      targetRange,
      0.08
    );
  }

  setSize(w, h) {
    const pr = Math.min(window.devicePixelRatio, 2);
    const rw = Math.max(1, Math.floor(w * pr));
    const rh = Math.max(1, Math.floor(h * pr));

    this.sceneRT.setSize(rw, rh);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    this.bloomPass.resolution.set(w, h);
    this.macroDofPass.uniforms.uAspect.value = w / Math.max(1, h);
    this.fxaaPass.material.uniforms.resolution.value.set(1 / rw, 1 / rh);
  }

  render() {
    // 1. Render 3D scene into isolated sceneRT + hardware depthTexture
    this.renderer.setRenderTarget(this.sceneRT);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);

    // 2. Run post-processing chain to screen
    this.composer.render();
  }
}
