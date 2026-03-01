/**
 * ParticleSystem – Three.js GPU particle overlay for MAP SCORE
 *
 * Renders a field of noise-driven particles over the map that react
 * to audio FFT data and geographic colour analysis.
 *
 * Inspired by pepepepebrick's TouchDesigner ParticleGPU + Instance
 * pipeline: noise-based arrays with displacement, scaling, rotation,
 * and audio-reactive dynamics.
 */
class ParticleSystem {
  constructor() {
    this.scene     = null;
    this.camera    = null;
    this.renderer  = null;
    this.particles = null;
    this.lines     = null;
    this.uniforms  = null;
    this.clock     = new THREE.Clock();
    this.isActive  = false;
    this.initialized = false;
  }

  /* ── Bootstrap ──────────────────────────────────────────────── */

  init(container) {
    const w   = window.innerWidth;
    const h   = window.innerHeight;
    const dpr = Math.min(window.devicePixelRatio, 2);

    // Renderer (transparent background – overlays the map)
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: false });
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(0x000000, 0);

    const canvas = this.renderer.domElement;
    canvas.id = 'particleCanvas';
    container.appendChild(canvas);

    // Scene
    this.scene = new THREE.Scene();

    // Orthographic camera (pixel-space mapping)
    this.camera = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.1, 2000);
    this.camera.position.z = 1000;

    this._createParticles(w, h);

    this.initialized = true;
    window.addEventListener('resize', () => this._onResize());
  }

  /* ── Particle geometry + material ───────────────────────────── */

  _createParticles(w, h) {
    const COLS  = 80;
    const ROWS  = 80;
    const count = COLS * ROWS;

    const positions = new Float32Array(count * 3);
    const randoms   = new Float32Array(count);
    const indices   = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      const col = i % COLS;
      const row = Math.floor(i / COLS);

      const x = ((col / (COLS - 1)) - 0.5) * w * 1.4;
      const y = ((row / (ROWS - 1)) - 0.5) * h * 1.4;

      // Slight jitter to break the perfect grid
      positions[i * 3]     = x + (Math.random() - 0.5) * (w / COLS) * 0.5;
      positions[i * 3 + 1] = y + (Math.random() - 0.5) * (h / ROWS) * 0.5;
      positions[i * 3 + 2] = 0;

      randoms[i] = Math.random();
      indices[i] = i / count;
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('aRandom',  new THREE.BufferAttribute(randoms, 1));
    geometry.setAttribute('aIndex',   new THREE.BufferAttribute(indices, 1));

    this.uniforms = {
      uTime:       { value: 0 },
      uGreen:      { value: 0 },
      uBlue:       { value: 0 },
      uGray:       { value: 0 },
      uAudioLevel: { value: 0 },
      uBass:       { value: 0 },
      uMid:        { value: 0 },
      uHigh:       { value: 0 },
      uScanY:      { value: 0 },
      uActive:     { value: 0 },
      uDpr:        { value: Math.min(window.devicePixelRatio, 2) },
      uResolution: { value: new THREE.Vector2(w, h) }
    };

    const material = new THREE.ShaderMaterial({
      uniforms:       this.uniforms,
      vertexShader:   this._vertexShader(),
      fragmentShader: this._fragmentShader(),
      transparent:    true,
      depthTest:      false,
      blending:       THREE.AdditiveBlending
    });

    this.particles = new THREE.Points(geometry, material);
    this.scene.add(this.particles);
  }

  /* ── GLSL: vertex shader ────────────────────────────────────── */

  _vertexShader() {
    return /* glsl */ `
      // ─── 3D Simplex Noise (Ashima Arts / Stefan Gustavson) ───
      vec3 mod289(vec3 x){ return x - floor(x*(1.0/289.0))*289.0; }
      vec4 mod289(vec4 x){ return x - floor(x*(1.0/289.0))*289.0; }
      vec4 permute(vec4 x){ return mod289(((x*34.0)+1.0)*x); }
      vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314*r; }

      float snoise(vec3 v){
        const vec2 C = vec2(1.0/6.0, 1.0/3.0);
        const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
        vec3 i  = floor(v + dot(v, C.yyy));
        vec3 x0 = v - i + dot(i, C.xxx);
        vec3 g  = step(x0.yzx, x0.xyz);
        vec3 l  = 1.0 - g;
        vec3 i1 = min(g.xyz, l.zxy);
        vec3 i2 = max(g.xyz, l.zxy);
        vec3 x1 = x0 - i1 + C.xxx;
        vec3 x2 = x0 - i2 + C.yyy;
        vec3 x3 = x0 - D.yyy;
        i = mod289(i);
        vec4 p = permute(permute(permute(
          i.z + vec4(0.0, i1.z, i2.z, 1.0))
          + i.y + vec4(0.0, i1.y, i2.y, 1.0))
          + i.x + vec4(0.0, i1.x, i2.x, 1.0));
        float n_ = 0.142857142857;
        vec3 ns = n_ * D.wyz - D.xzx;
        vec4 j  = p - 49.0 * floor(p * ns.z * ns.z);
        vec4 xj = floor(j * ns.z);
        vec4 yj = floor(j - 7.0 * xj);
        vec4 xv = xj * ns.x + ns.yyyy;
        vec4 yv = yj * ns.x + ns.yyyy;
        vec4 h  = 1.0 - abs(xv) - abs(yv);
        vec4 b0 = vec4(xv.xy, yv.xy);
        vec4 b1 = vec4(xv.zw, yv.zw);
        vec4 s0 = floor(b0)*2.0 + 1.0;
        vec4 s1 = floor(b1)*2.0 + 1.0;
        vec4 sh = -step(h, vec4(0.0));
        vec4 a0 = b0.xzyw + s0.xzyw*sh.xxyy;
        vec4 a1 = b1.xzyw + s1.xzyw*sh.zzww;
        vec3 p0 = vec3(a0.xy, h.x);
        vec3 p1 = vec3(a0.zw, h.y);
        vec3 p2 = vec3(a1.xy, h.z);
        vec3 p3 = vec3(a1.zw, h.w);
        vec4 norm = taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
        p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
        vec4 m = max(0.6 - vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)), 0.0);
        m = m * m;
        return 42.0 * dot(m*m, vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
      }

      // ─── Uniforms & attributes ───
      uniform float uTime;
      uniform float uGreen;
      uniform float uBlue;
      uniform float uGray;
      uniform float uAudioLevel;
      uniform float uBass;
      uniform float uMid;
      uniform float uHigh;
      uniform float uScanY;
      uniform float uActive;
      uniform float uDpr;
      uniform vec2  uResolution;

      attribute float aRandom;
      attribute float aIndex;

      varying float vAlpha;
      varying vec3  vColor;

      void main(){
        vec3 pos = position;
        float t  = uTime;

        // ── Layer 1 : slow, large-scale drift ──
        float ns = 0.0022;
        float ts = 0.12;
        float n1 = snoise(vec3(pos.xy * ns,          t * ts));
        float n2 = snoise(vec3(pos.xy * ns + 100.0,  t * ts + 50.0));
        float n3 = snoise(vec3(pos.xy * ns * 2.8,    t * ts * 1.8 + 200.0));
        float n4 = snoise(vec3(pos.xy * ns * 2.8 + 300.0, t * ts * 1.8 + 250.0));

        float baseAmp = 20.0 + uActive * 15.0;
        pos.x += (n1 * baseAmp + n3 * baseAmp * 0.35);
        pos.y += (n2 * baseAmp + n4 * baseAmp * 0.35);

        // ── Channel-specific displacement ──

        // Green (nature) : gentle organic sway
        float gAmp = uGreen * 50.0;
        pos.x += snoise(vec3(pos.xy * 0.0008, t * 0.06))          * gAmp;
        pos.y += snoise(vec3(pos.xy * 0.0008 + 500.0, t * 0.05)) * gAmp * 0.7;

        // Blue (water) : flowing directional current
        float bAmp = uBlue * 45.0;
        pos.x += sin(pos.y * 0.004 + t * 0.35) * bAmp;
        pos.y += cos(pos.x * 0.003 + t * 0.20) * bAmp * 0.45;

        // Gray (urban) : geometric, quantised pulse
        float grAmp = uGray * 30.0;
        float gridN = snoise(vec3(floor(pos.xy * 0.008) * 125.0, t * 0.55));
        pos.x += gridN * grAmp * step(0.25, uGray);
        pos.y += gridN * grAmp * 0.6 * step(0.25, uGray);

        // ── Audio displacement ──
        float aBass = uBass * 35.0;
        float aMid  = uMid  * 15.0;
        pos.x += n1 * (aBass + aMid);
        pos.y += n2 * (aBass + aMid);

        // ── Scan-line proximity boost ──
        float screenY   = 1.0 - (pos.y / uResolution.y + 0.5);
        float scanDist  = abs(screenY - uScanY);
        float scanBoost = smoothstep(0.07, 0.0, scanDist) * uActive;

        gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);

        // ── Point size ──
        float sBase  = 2.0 + uActive * 1.0;
        float sNoise = abs(n1) * 2.0;
        float sAudio = uMid * 3.5 + uBass * 2.5;
        float sScan  = scanBoost * 5.0;
        gl_PointSize = (sBase + sNoise + sAudio + sScan) * uDpr;
        gl_PointSize = max(gl_PointSize, 0.5);

        // ── Colour ──
        vec3 cGreen = vec3(0.12, 0.88, 0.52);
        vec3 cBlue  = vec3(0.25, 0.60, 1.00);
        vec3 cGray  = vec3(1.00, 0.72, 0.30);
        vec3 cBase  = vec3(0.50, 0.55, 0.72);

        float tw = uGreen + uBlue + uGray + 0.001;
        vec3 channelCol = (cGreen * uGreen + cBlue * uBlue + cGray * uGray) / tw;
        float strength  = clamp(tw * 0.85, 0.0, 1.0);
        vColor = mix(cBase, channelCol, strength);

        // Per-particle hue variation
        vColor += (aRandom - 0.5) * 0.08;

        // Scan-line whitens particles
        vColor = mix(vColor, vec3(1.0), scanBoost * 0.55);

        // ── Alpha ──
        float aBase  = 0.04 + uActive * 0.10;
        float aNoise = abs(n1) * 0.12;
        float aAudio = uAudioLevel * 0.40;
        float aScan  = scanBoost * 0.55;
        vAlpha = clamp(aBase + aNoise + aAudio + aScan, 0.0, 0.92);
      }
    `;
  }

  /* ── GLSL: fragment shader ──────────────────────────────────── */

  _fragmentShader() {
    return /* glsl */ `
      varying float vAlpha;
      varying vec3  vColor;

      void main(){
        vec2  uv   = gl_PointCoord - vec2(0.5);
        float dist = length(uv);

        // Soft circular glow with bright core
        float core = exp(-dist * dist * 28.0);
        float glow = exp(-dist * dist * 6.0) * 0.35;
        float a    = (core + glow) * vAlpha;

        if(a < 0.002) discard;
        gl_FragColor = vec4(vColor, a);
      }
    `;
  }

  /* ── Per-frame update ───────────────────────────────────────── */

  update(colorData, audioData, scanY) {
    if (!this.initialized) return;

    const dt = this.clock.getDelta();
    this.uniforms.uTime.value += dt;

    // Smooth interpolation toward target values
    const sl = 0.07;   // slow lerp for colour data
    const fl = 0.13;   // faster lerp for audio data

    this.uniforms.uGreen.value += (Math.min(colorData.green / 40, 1) - this.uniforms.uGreen.value) * sl;
    this.uniforms.uBlue.value  += (Math.min(colorData.blue  / 25, 1) - this.uniforms.uBlue.value)  * sl;
    this.uniforms.uGray.value  += (Math.min(colorData.gray  / 35, 1) - this.uniforms.uGray.value)  * sl;

    this.uniforms.uScanY.value = scanY;

    if (audioData) {
      this.uniforms.uAudioLevel.value += (audioData.level - this.uniforms.uAudioLevel.value) * fl;
      this.uniforms.uBass.value       += (audioData.bass  - this.uniforms.uBass.value)       * 0.16;
      this.uniforms.uMid.value        += (audioData.mid   - this.uniforms.uMid.value)        * fl;
      this.uniforms.uHigh.value       += (audioData.high  - this.uniforms.uHigh.value)       * 0.10;
    }

    // Animate active flag (smooth fade in/out)
    const target = this.isActive ? 1 : 0;
    this.uniforms.uActive.value += (target - this.uniforms.uActive.value) * 0.035;

    this.renderer.render(this.scene, this.camera);
  }

  /* ── Active state ───────────────────────────────────────────── */

  setActive(active) {
    this.isActive = active;
  }

  /* ── Resize handler ─────────────────────────────────────────── */

  _onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;

    this.camera.left   = -w / 2;
    this.camera.right  =  w / 2;
    this.camera.top    =  h / 2;
    this.camera.bottom = -h / 2;
    this.camera.updateProjectionMatrix();

    this.renderer.setSize(w, h);
    this.uniforms.uResolution.value.set(w, h);
  }
}
