/**
 * main.js – MAP SCORE · 地图乐谱
 *
 * Orchestrates the MapLibre map, colour analysis, audio engine,
 * Three.js particle overlay, and scan-line visualisation.
 *
 * Visual pipeline (mirrors pepepepebrick's TouchDesigner → VCV Rack flow):
 *   Map canvas → pixel readback → HSL classification → EMA smoothing
 *     → audio synthesis (Tone.js) + particle field (Three.js) + scan overlay
 */

(function () {
  'use strict';

  /* ── City presets ────────────────────────────────────────────── */

  const CITIES = {
    chengdu: { center: [104.0668, 30.5728], zoom: 13, label: '成都 Chengdu' },
    taipei:  { center: [121.5654, 25.0330], zoom: 13, label: '台北 Taipei' },
    tokyo:   { center: [139.6917, 35.6895], zoom: 13, label: '東京 Tokyo' },
    paris:   { center: [2.3522,   48.8566], zoom: 13, label: 'Paris' },
    newyork: { center: [-73.9857, 40.7484], zoom: 13, label: 'New York' }
  };

  /* ── Instances ──────────────────────────────────────────────── */

  const colorAnalyzer  = new ColorAnalyzer();
  const audioEngine    = new AudioEngine();
  const particleSystem = new ParticleSystem();

  /* ── DOM refs ───────────────────────────────────────────────── */

  const mapEl           = document.getElementById('map');
  const startBtn        = document.getElementById('startBtn');
  const autopanBtn      = document.getElementById('autopanBtn');
  const greenBar        = document.getElementById('greenBar');
  const blueBar         = document.getElementById('blueBar');
  const grayBar         = document.getElementById('grayBar');
  const greenValue      = document.getElementById('greenValue');
  const blueValue       = document.getElementById('blueValue');
  const grayValue       = document.getElementById('grayValue');
  const waveformEl      = document.getElementById('waveform');
  const scanOverlay     = document.getElementById('scanOverlay');
  const coordLat        = document.getElementById('coordLat');
  const coordLng        = document.getElementById('coordLng');
  const coordZoom       = document.getElementById('coordZoom');
  const cityLabel       = document.getElementById('cityLabel');
  const introEl         = document.getElementById('intro');
  const introBtn        = document.getElementById('introBtn');
  const particleContainer = document.getElementById('particleContainer');

  /* ── Waveform canvas (retina-aware) ─────────────────────────── */

  const wfCtx = waveformEl.getContext('2d');
  let wfW, wfH;

  function resizeWaveform() {
    const dpr  = window.devicePixelRatio || 1;
    const rect = waveformEl.getBoundingClientRect();
    wfW = rect.width;
    wfH = rect.height;
    waveformEl.width  = wfW * dpr;
    waveformEl.height = wfH * dpr;
    wfCtx.scale(dpr, dpr);
  }

  /* ── Scan-line overlay canvas ───────────────────────────────── */

  const scanCtx = scanOverlay.getContext('2d');
  let scanW, scanH;
  let scanY = 0;  // normalised 0 → 1

  function resizeScanOverlay() {
    const dpr = window.devicePixelRatio || 1;
    scanW = window.innerWidth;
    scanH = window.innerHeight;
    scanOverlay.width  = scanW * dpr;
    scanOverlay.height = scanH * dpr;
    scanCtx.scale(dpr, dpr);
  }

  function handleResize() {
    resizeWaveform();
    resizeScanOverlay();
  }

  handleResize();
  window.addEventListener('resize', handleResize);

  /* ── State ──────────────────────────────────────────────────── */

  let map           = null;
  let isActive      = false;
  let isDrifting    = false;
  let lastAnalysis  = 0;
  let lastColorData = { green: 0, blue: 0, gray: 0 };
  let lastFFTData   = null;
  const ANALYSIS_MS = 200;

  // Waveform history (trail / ghost effect)
  const wfHistory     = [];
  const WF_HISTORY_LEN = 4;

  // Drift (auto-pan) state
  let driftAngle = Math.random() * Math.PI * 2;
  let driftSpeed = 0.0003;

  /* ── Map initialisation ─────────────────────────────────────── */

  function initMap() {
    map = new maplibregl.Map({
      container: 'map',
      style: {
        version: 8,
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            maxzoom: 19,
            attribution:
              '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          }
        },
        layers: [
          { id: 'osm-tiles', type: 'raster', source: 'osm' }
        ]
      },
      center: CITIES.chengdu.center,
      zoom:   CITIES.chengdu.zoom,
      preserveDrawingBuffer: true,
      maxZoom: 18,
      minZoom: 3
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-left');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    map.on('load', () => {
      // Initialise Three.js particle overlay
      particleSystem.init(particleContainer);
      startLoop();
    });

    map.on('move', updateCoords);
  }

  /* ── City switching ─────────────────────────────────────────── */

  function flyToCity(cityKey) {
    const city = CITIES[cityKey];
    if (!city || !map) return;

    cityLabel.textContent = city.label;
    document.title = 'MAP SCORE · 地图乐谱 · ' + city.label;

    document.querySelectorAll('.city-btn').forEach(function (btn) {
      btn.classList.toggle('active', btn.dataset.city === cityKey);
    });

    map.flyTo({
      center: city.center,
      zoom: city.zoom,
      duration: 3000,
      essential: true
    });
  }

  document.querySelectorAll('.city-btn').forEach(function (btn) {
    btn.addEventListener('click', function () { flyToCity(btn.dataset.city); });
  });

  /* ── Coordinate display ─────────────────────────────────────── */

  function updateCoords() {
    if (!map) return;
    const c = map.getCenter();
    const z = map.getZoom();
    coordLat.textContent  = c.lat.toFixed(4) + (c.lat >= 0 ? '°N' : '°S');
    coordLng.textContent  = c.lng.toFixed(4) + (c.lng >= 0 ? '°E' : '°W');
    coordZoom.textContent = 'Z' + z.toFixed(1);
  }

  /* ── Auto-pan (drift) ──────────────────────────────────────── */

  function toggleDrift() {
    isDrifting = !isDrifting;
    autopanBtn.classList.toggle('active', isDrifting);
    autopanBtn.textContent = isDrifting ? 'STOP' : 'DRIFT';
    if (isDrifting) driftAngle = Math.random() * Math.PI * 2;
  }

  function driftTick() {
    if (!isDrifting || !map) return;
    const c = map.getCenter();
    driftAngle += (Math.random() - 0.5) * 0.04;
    const activity = (lastColorData.green + lastColorData.blue + lastColorData.gray) / 100;
    const speed    = driftSpeed * (0.6 + activity * 1.2);
    map.setCenter([
      c.lng + Math.cos(driftAngle) * speed,
      c.lat + Math.sin(driftAngle) * speed
    ]);
  }

  autopanBtn.addEventListener('click', toggleDrift);

  /* ── Dominant-channel colour helper ─────────────────────────── */

  function getDominantRGB() {
    const gn  = lastColorData.green / 40;
    const bn  = lastColorData.blue  / 25;
    const grn = lastColorData.gray  / 35;

    if (gn > bn && gn > grn) return { r: 30,  g: 200, b: 120 };
    if (bn > gn && bn > grn) return { r: 60,  g: 150, b: 255 };
    if (grn > 0.1)           return { r: 255, g: 180, b: 70  };
    return { r: 120, g: 125, b: 150 };
  }

  /* ── Scan-line overlay ──────────────────────────────────────── */

  function drawScanOverlay() {
    scanCtx.clearRect(0, 0, scanW, scanH);
    if (!isActive) return;

    // 1. Subtle CRT scanlines
    scanCtx.strokeStyle = 'rgba(255,255,255,0.012)';
    scanCtx.lineWidth   = 0.5;
    for (let y = 0; y < scanH; y += 3) {
      scanCtx.beginPath();
      scanCtx.moveTo(0, y);
      scanCtx.lineTo(scanW, y);
      scanCtx.stroke();
    }

    // 2. Move main scan line
    scanY += 0.003;
    if (scanY > 1) scanY = 0;
    const y = scanY * scanH;

    const c = getDominantRGB();

    // 3. Glow field around scan line
    var glowGrad = scanCtx.createLinearGradient(0, y - 70, 0, y + 70);
    glowGrad.addColorStop(0,    'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0)');
    glowGrad.addColorStop(0.35, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0.04)');
    glowGrad.addColorStop(0.5,  'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0.14)');
    glowGrad.addColorStop(0.65, 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0.04)');
    glowGrad.addColorStop(1,    'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0)');
    scanCtx.fillStyle = glowGrad;
    scanCtx.fillRect(0, y - 70, scanW, 140);

    // 4. Waveform riding along the scan line
    var waveData = audioEngine.getWaveform();
    if (waveData && waveData.length > 0) {
      // Glow layer (wider, dimmer)
      scanCtx.beginPath();
      scanCtx.strokeStyle = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0.12)';
      scanCtx.lineWidth = 4;
      for (var i = 0; i < waveData.length; i++) {
        var x = (i / waveData.length) * scanW;
        var wy = y + waveData[i] * 18;
        if (i === 0) scanCtx.moveTo(x, wy);
        else         scanCtx.lineTo(x, wy);
      }
      scanCtx.stroke();

      // Core layer (thinner, brighter)
      scanCtx.beginPath();
      scanCtx.strokeStyle = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0.55)';
      scanCtx.lineWidth = 1.5;
      for (var j = 0; j < waveData.length; j++) {
        var xc = (j / waveData.length) * scanW;
        var wyc = y + waveData[j] * 18;
        if (j === 0) scanCtx.moveTo(xc, wyc);
        else         scanCtx.lineTo(xc, wyc);
      }
      scanCtx.stroke();
    } else {
      // Flat centre line when no waveform
      scanCtx.beginPath();
      scanCtx.strokeStyle = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',0.35)';
      scanCtx.lineWidth = 1;
      scanCtx.moveTo(0, y);
      scanCtx.lineTo(scanW, y);
      scanCtx.stroke();
    }

    // 5. Edge vignette
    var vig = scanCtx.createRadialGradient(
      scanW / 2, scanH / 2, scanH * 0.25,
      scanW / 2, scanH / 2, scanH * 0.85
    );
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.35)');
    scanCtx.fillStyle = vig;
    scanCtx.fillRect(0, 0, scanW, scanH);
  }

  /* ── Main render loop ───────────────────────────────────────── */

  function startLoop() {
    function tick(timestamp) {
      requestAnimationFrame(tick);

      driftTick();
      drawScanOverlay();

      // Update particle system every frame (it smooths internally)
      particleSystem.update(
        lastColorData,
        lastFFTData,
        scanY
      );

      // Colour analysis + audio at ~5 fps
      if (timestamp - lastAnalysis < ANALYSIS_MS) return;
      lastAnalysis = timestamp;

      var canvas    = map.getCanvas();
      var colorData = colorAnalyzer.analyze(canvas);
      lastColorData = colorData;

      updateBars(colorData);

      if (isActive) {
        audioEngine.update(colorData);
        lastFFTData = audioEngine.getFFT();
        drawWaveform();
      }
    }

    requestAnimationFrame(tick);
  }

  /* ── UI helpers ─────────────────────────────────────────────── */

  function updateBars(data) {
    greenBar.style.width = clamp(data.green, 0, 100) + '%';
    blueBar.style.width  = clamp(data.blue,  0, 100) + '%';
    grayBar.style.width  = clamp(data.gray,  0, 100) + '%';

    greenValue.textContent = Math.round(data.green) + '%';
    blueValue.textContent  = Math.round(data.blue)  + '%';
    grayValue.textContent  = Math.round(data.gray)  + '%';
  }

  function drawWaveform() {
    var data = audioEngine.getWaveform();
    if (!data) return;

    wfCtx.clearRect(0, 0, wfW, wfH);

    wfHistory.push(Array.from(data));
    while (wfHistory.length > WF_HISTORY_LEN) wfHistory.shift();

    var c = getDominantRGB();

    // Draw trailing waveforms
    for (var h = 0; h < wfHistory.length; h++) {
      var hist  = wfHistory[h];
      var age   = (h + 1) / wfHistory.length;
      var alpha = age * 0.4;

      wfCtx.beginPath();
      wfCtx.strokeStyle = 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + alpha + ')';
      wfCtx.lineWidth   = h === wfHistory.length - 1 ? 1.5 : 0.8;

      var step = wfW / hist.length;
      for (var i = 0; i < hist.length; i++) {
        var x = i * step;
        var y = ((1 - hist[i]) / 2) * wfH;
        if (i === 0) wfCtx.moveTo(x, y);
        else         wfCtx.lineTo(x, y);
      }
      wfCtx.stroke();
    }

    // Glow on latest waveform
    if (wfHistory.length > 0) {
      var latest = wfHistory[wfHistory.length - 1];
      wfCtx.beginPath();
      wfCtx.strokeStyle = 'rgba(255,255,255,0.06)';
      wfCtx.lineWidth = 3;
      var step2 = wfW / latest.length;
      for (var k = 0; k < latest.length; k++) {
        var xk = k * step2;
        var yk = ((1 - latest[k]) / 2) * wfH;
        if (k === 0) wfCtx.moveTo(xk, yk);
        else         wfCtx.lineTo(xk, yk);
      }
      wfCtx.stroke();
    }

    // Faint centre line
    wfCtx.beginPath();
    wfCtx.strokeStyle = 'rgba(255,255,255,0.025)';
    wfCtx.lineWidth   = 0.5;
    wfCtx.moveTo(0, wfH / 2);
    wfCtx.lineTo(wfW, wfH / 2);
    wfCtx.stroke();
  }

  function clearWaveform() {
    wfCtx.clearRect(0, 0, wfW, wfH);
    wfHistory.length = 0;
  }

  /* ── Start / Stop toggle ────────────────────────────────────── */

  async function toggleAudio() {
    if (!isActive) {
      startBtn.textContent = '· · ·';
      startBtn.disabled    = true;

      await audioEngine.init();
      audioEngine.start();

      isActive = true;
      startBtn.textContent = 'STOP';
      startBtn.classList.add('active');
      startBtn.disabled = false;

      // Activate visual layers
      scanOverlay.classList.add('active');
      particleSystem.setActive(true);
      mapEl.classList.add('audio-active');
    } else {
      audioEngine.stop();
      isActive    = false;
      lastFFTData = null;

      startBtn.textContent = 'START';
      startBtn.classList.remove('active');
      clearWaveform();

      // Deactivate visual layers
      scanOverlay.classList.remove('active');
      particleSystem.setActive(false);
      mapEl.classList.remove('audio-active');

      if (isDrifting) {
        isDrifting = false;
        autopanBtn.classList.remove('active');
        autopanBtn.textContent = 'DRIFT';
      }
    }
  }

  startBtn.addEventListener('click', toggleAudio);

  /* ── Keyboard shortcuts ─────────────────────────────────────── */

  document.addEventListener('keydown', function (e) {
    if (e.target !== document.body) return;
    if (e.code === 'Space') {
      e.preventDefault();
      toggleAudio();
    } else if (e.code === 'KeyD') {
      e.preventDefault();
      if (isActive) toggleDrift();
    }
  });

  /* ── Intro screen ───────────────────────────────────────────── */

  function dismissIntro() {
    introEl.classList.add('fade-out');
    setTimeout(function () {
      introEl.style.display = 'none';
    }, 1400);
  }

  introBtn.addEventListener('click', dismissIntro);

  /* ── Utils ──────────────────────────────────────────────────── */

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /* ── Boot ───────────────────────────────────────────────────── */

  initMap();

})();
