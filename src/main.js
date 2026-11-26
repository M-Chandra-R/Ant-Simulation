import * as THREE from 'three';
import { generateAllTextures } from './textures/ProceduralTextures.js';
import { WindSystem } from './world/WindSystem.js';
import { Terrain, getTerrainHeight } from './world/Terrain.js';
import { GrassField } from './world/GrassField.js';
import { ForestFlora } from './world/ForestFlora.js';
import { WaterDroplets } from './world/WaterDroplets.js';
import { Atmosphere } from './world/Atmosphere.js';
import { AntController } from './controls/AntController.js';
import { PostEffects } from './postprocessing/PostEffects.js';
import { AmbientAudio } from './audio/AmbientAudio.js';

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(resolve));

async function bootstrap() {
  const container = document.getElementById('canvas-container');
  const loadingScreen = document.getElementById('loading-screen');
  const loadingStatus = document.getElementById('loading-status');
  const progressFill = document.getElementById('progress-fill');
  const introOverlay = document.getElementById('intro-overlay');
  const enterBtn = document.getElementById('enter-btn');
  const hud = document.getElementById('hud');
  const envPanel = document.getElementById('env-panel');
  const modeLabel = document.getElementById('mode-label');
  const telemetryText = document.getElementById('telemetry-text');

  const setProgress = (pct, text) => {
    progressFill.style.width = `${Math.round(pct * 100)}%`;
    if (text) loadingStatus.textContent = text;
  };

  // 1. WebGL Renderer with ACES Filmic Tone Mapping & Soft Shadows
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance'
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.06;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  // Macro-scale perspective camera (near = 0.04 so droplets 1mm away never clip!)
  const camera = new THREE.PerspectiveCamera(
    64,
    window.innerWidth / window.innerHeight,
    0.04,
    360
  );
  scene.add(camera);

  await nextFrame();

  // 2. Synthesize High-Resolution Organic PBR Textures & Canopy PMREM
  const textures = generateAllTextures(renderer, setProgress);
  scene.environment = textures.envMap;
  await nextFrame();

  // 3. Shared Wind & Sunbreak State
  const windSystem = new WindSystem();

  setProgress(0.91, 'Sculpting damp forest humus, moss & rainwater puddles...');
  await nextFrame();
  const terrain = new Terrain(scene, textures, windSystem);

  setProgress(0.94, 'Growing curved meadow grass, woodland ferns & mushrooms...');
  await nextFrame();
  const grassField = new GrassField(scene, textures, windSystem);
  const forestFlora = new ForestFlora(scene, textures, windSystem);

  setProgress(0.97, 'Condensing refractive raindrops across leaves & stems...');
  await nextFrame();
  const ambientAudio = new AmbientAudio();
  const waterDroplets = new WaterDroplets(
    scene,
    textures,
    windSystem,
    grassField,
    forestFlora,
    terrain,
    (dist, hitPuddle) => ambientAudio.playDropletSplash(dist, hitPuddle)
  );

  const atmosphere = new Atmosphere(scene, textures, windSystem);
  const antController = new AntController(camera, renderer.domElement, forestFlora.stoneColliders);
  const postEffects = new PostEffects(renderer, scene, camera);

  // Warm up shaders on GPU before revealing
  setProgress(1.0, 'Entering sunlit forest floor...');
  await nextFrame();
  renderer.compile(scene, camera);
  postEffects.render();

  // Hide loader, reveal splash screen (or enter directly if ?preview=1)
  loadingScreen.classList.add('hidden');
  const autoPreview = new URLSearchParams(window.location.search).has('preview');
  let hasEnteredOnce = autoPreview;
  if (autoPreview) {
    hud.classList.remove('hidden');
  } else {
    introOverlay.classList.remove('hidden');
  }

  // --- UI & Controls Wiring ---

  const updateModeBadge = (mode) => {
    modeLabel.textContent = mode === 'ant' ? 'Ant Grounded POV' : 'Macro Free-Fly Camera';
  };
  antController.onModeChange = updateModeBadge;

  enterBtn.addEventListener('click', () => {
    hasEnteredOnce = true;
    introOverlay.classList.add('hidden');
    hud.classList.remove('hidden');
    ambientAudio.init();
    antController.lock();
  });

  document.addEventListener('pointerlockchange', () => {
    const locked = document.pointerLockElement === renderer.domElement;
    if (!locked && hasEnteredOnce) {
      // Keep HUD visible so user can tweak sliders, or click canvas to re-lock
      introOverlay.classList.add('hidden');
    }
  });

  renderer.domElement.addEventListener('click', () => {
    if (hasEnteredOnce && document.pointerLockElement !== renderer.domElement) {
      ambientAudio.init();
      antController.lock();
    }
  });

  // Environment Sliders
  document.getElementById('ctrl-wind').addEventListener('input', (e) => {
    windSystem.uniforms.uWindStrength.value = parseFloat(e.target.value);
  });

  document.getElementById('ctrl-sun').addEventListener('input', (e) => {
    atmosphere.setSunWarmth(parseFloat(e.target.value));
  });

  document.getElementById('ctrl-fog').addEventListener('input', (e) => {
    atmosphere.setFogMultiplier(parseFloat(e.target.value));
  });

  document.getElementById('ctrl-dof').addEventListener('input', (e) => {
    postEffects.setDofIntensity(parseFloat(e.target.value));
  });

  document.getElementById('ctrl-drip').addEventListener('input', (e) => {
    waterDroplets.sheddingRate = parseFloat(e.target.value);
  });

  document.getElementById('btn-toggle-mode').addEventListener('click', () => {
    antController.toggleMode();
  });

  const btnAudio = document.getElementById('btn-toggle-audio');
  const syncAudioBtn = (on) => {
    btnAudio.textContent = `Sound: ${on ? 'On' : 'Muted'} [M]`;
  };
  btnAudio.addEventListener('click', () => {
    syncAudioBtn(ambientAudio.toggle());
  });

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (e.code === 'KeyH') {
      envPanel.classList.toggle('collapsed');
    } else if (e.code === 'KeyM') {
      syncAudioBtn(ambientAudio.toggle());
    }
  });

  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    postEffects.setSize(w, h);
  });

  // --- Main Realtime Simulation Loop ---
  const clock = new THREE.Clock();
  let telemetryTimer = 0;

  function animate() {
    requestAnimationFrame(animate);

    const dt = Math.min(clock.getDelta(), 0.05);
    const elapsed = clock.elapsedTime;

    if (hasEnteredOnce) {
      antController.update(dt, elapsed);
    } else {
      // Gentle cinematic idle breathing preview behind glass intro overlay
      camera.position.set(
        Math.sin(elapsed * 0.22) * 0.5,
        getTerrainHeight(0, 6.0) + 1.55 + Math.sin(elapsed * 0.55) * 0.06,
        6.0 + Math.cos(elapsed * 0.18) * 0.4
      );
      camera.lookAt(6.2, getTerrainHeight(0, 6.0) + 3.2, -7.5);
    }

    windSystem.update(dt, elapsed, antController.position, antController.horizontalSpeed);
    waterDroplets.update(dt, elapsed, antController.position, antController.horizontalSpeed);
    atmosphere.update(antController.position);
    postEffects.updateFocus(antController.mode);
    ambientAudio.update(
      elapsed,
      windSystem.uniforms.uWindStrength.value,
      antController.horizontalSpeed,
      antController.mode === 'ant' && antController.isGrounded
    );

    telemetryTimer += dt;
    if (telemetryTimer > 0.2) {
      telemetryTimer = 0;
      const groundH = getTerrainHeight(antController.position.x, antController.position.z);
      const altitudeMm = Math.max(0.5, (antController.position.y - groundH) * 2.5).toFixed(1);
      const wVal = windSystem.uniforms.uWindStrength.value;
      const windDesc = wVal < 0.35 ? 'Calm' : wVal < 1.3 ? 'Gentle Breeze' : 'Gusty';
      telemetryText.textContent = `Eye Height: ${altitudeMm} mm • Wind: ${windDesc}`;
    }

    postEffects.render();
  }

  animate();
}

bootstrap().catch((err) => {
  console.error('Simulation startup error:', err);
  const statusEl = document.getElementById('loading-status');
  if (statusEl) statusEl.textContent = `Error: ${err.message}`;
});
