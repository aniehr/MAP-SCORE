/**
 * main.js – MAP SCORE · 地图乐谱
 *
 * Initialises the MapLibre map, runs colour-analysis at ~5 fps,
 * drives the audio engine, draws waveform + scan-line overlay,
 * and handles city switching + auto-pan (drift) mode.
 *
 * Pipeline (mirrors the original TouchDesigner → VCV Rack flow):
 *   Map canvas → pixel readback → HSL classification → EMA smoothing
 *     → audio parameter mapping → Tone.js synthesis
 */

(function () {
  'use strict';

  /* ── City presets ────────────────────────────────────────────────── */

  const CITIES = {
    chengdu: { center: [104.0668, 30.5728], zoom: 13, label: '成都 Chengdu' },
    taipei:  { center: [121.5654, 25.0330], zoom: 13, label: '台北 Taipei' },
    tokyo:   { center: [139.6917, 35.6895], zoom: 13, label: '東京 Tokyo' },
    paris:   { center: [2.3522,   48.8566], zoom: 13, label: 'Paris' },
    newyork: { center: [-73.9857, 40.7484], zoom: 13, label: 'New York' }
  };

  /* ── Instances ─────────────────────────────────────────────────── */

  const colorAnalyzer = new ColorAnalyzer();
  const audioEngine   = new AudioEngine();

  /* ── DOM refs ──────────────────────────────────────────────────── */

  const startBtn      = document.getElementById('startBtn');
  const autopanBtn    = document.getElementById('autopanBtn');
  const greenBar      = document.getElementById('greenBar');
  const blueBar       = document.getElementById('blueBar');
  const grayBar       = document.getElementById('grayBar');
  const greenValue    = document.getElementById('greenValue');
  const blueValue     = document.getElementById('blueValue');
  const grayValue     = document.getElementById('grayValue');
  const waveformEl    = document.getElementById('waveform');
  const scanOverlay   = document.getElementById('scanOverlay');
  const coordLat      = document.getElementById('coordLat');
  const coordLng      = document.getElementById('coordLng');
  const coordZoom     = document.getElementById('coordZoom');
  const cityLabel     = document.getElementById('cityLabel');
  const introEl       = document.getElementById('intro');
  const introBtn      = document.getElementById('introBtn');

  /* ── Waveform canvas setup (retina-aware) ──────────────────────── */

  const wfCtx = waveformEl.getContext('2d');
  let wfW, wfH;

  function resizeWaveform() {
    const dpr = window.devicePixelRatio || 1;
    const rect = waveformEl.getBoundingClientRect();
    wfW = rect.width;
    wfH = rect.height;
    waveformEl.width  = wfW * dpr;
    waveformEl.height = wfH * dpr;
    wfCtx.scale(dpr, dpr);
  }

  /* ── Scan-line overlay canvas ──────────────────────────────────── */

  const scanCtx = scanOverlay.getContext('2d');
  let scanW, scanH;
  let scanY = 0; // current scan-line Y position (0–1 normalised)

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

  /* ── State ─────────────────────────────────────────────────────── */

  let map          = null;
  let isActive     = false;
  let isDrifting   = false;
  let lastAnalysis = 0;
  let lastColorData = { green: 0, blue: 0, gray: 0 };
  const ANALYSIS_MS = 200;

  // Waveform history for trail effect
  const wfHistory = [];
  const WF_HISTORY_LEN = 4;

  // Drift (auto-pan) state
  let driftAngle = Math.random() * Math.PI * 2;
  let driftSpeed = 0.0003;

  /* ── Map initialisation ────────────────────────────────────────── */

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
      startLoop();
    });

    // Update coordinates on every move
    map.on('move', updateCoords);
  }

  /* ── City switching ────────────────────────────────────────────── */

  function flyToCity(cityKey) {
    const city = CITIES[cityKey];
    if (!city || !map) return;

    cityLabel.textContent = city.label;
    document.title = 'MAP SCORE · 地图乐谱 · ' + city.label;

    // Update active button
    document.querySelectorAll('.city-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.city === cityKey);
    });

    map.flyTo({
      center: city.center,
      zoom: city.zoom,
      duration: 3000,
      essential: true
    });
  }

  document.querySelectorAll('.city-btn').forEach(btn => {
    btn.addEventListener('click', () => flyToCity(btn.dataset.city));
  });

  /* ── Coordinate display ────────────────────────────────────────── */

  function updateCoords() {
    if (!map) return;
    const c = map.getCenter();
    const z = map.getZoom();
    coordLat.textContent  = c.lat.toFixed(4) + (c.lat >= 0 ? '°N' : '°S');
    coordLng.textContent  = c.lng.toFixed(4) + (c.lng >= 0 ? '°E' : '°W');
    coordZoom.textContent = 'Z' + z.toFixed(1);
  }

  /* ── Auto-pan (drift) mode ─────────────────────────────────────── */

  function toggleDrift() {
    isDrifting = !isDrifting;
    autopanBtn.classList.toggle('active', isDrifting);
    autopanBtn.textContent = isDrifting ? 'STOP' : 'DRIFT';

    if (isDrifting) {
      driftAngle = Math.random() * Math.PI * 2;
    }
  }

  function driftTick() {
    if (!isDrifting || !map) return;

    const c = map.getCenter();
    // Slowly change direction for organic feel
    driftAngle += (Math.random() - 0.5) * 0.04;

    // Adjust speed based on current audio – more activity = slightly faster
    const activity = (lastColorData.green + lastColorData.blue + lastColorData.gray) / 100;
    const speed = driftSpeed * (0.6 + activity * 1.2);

    const newLng = c.lng + Math.cos(driftAngle) * speed;
    const newLat = c.lat + Math.sin(driftAngle) * speed;

    map.setCenter([newLng, newLat]);
  }

  autopanBtn.addEventListener('click', toggleDrift);

  /* ── Scan-line overlay drawing ─────────────────────────────────── */

  function drawScanOverlay() {
    scanCtx.clearRect(0, 0, scanW, scanH);
    if (!isActive) return;

    // Move scan line down
    scanY += 0.004;
    if (scanY > 1) scanY = 0;

    const y = scanY * scanH;

    // Main scan line – colour reflects dominant channel
    const gn = lastColorData.green / 40;
    const bn = lastColorData.blue  / 25;
    const grn = lastColorData.gray / 35;

    let r = 80, g = 80, b = 80;
    if (gn > bn && gn > grn) {
      r = 58; g = 138; b = 58;
    } else if (bn > gn && bn > grn) {
      r = 40; g = 116; b = 166;
    } else if (grn > 0.1) {
      r = 136; g = 136; b = 136;
    }

    // Glow above and below the line
    const glowGrad = scanCtx.createLinearGradient(0, y - 40, 0, y + 40);
    glowGrad.addColorStop(0,    'rgba(' + r + ',' + g + ',' + b + ',0)');
    glowGrad.addColorStop(0.45, 'rgba(' + r + ',' + g + ',' + b + ',0.08)');
    glowGrad.addColorStop(0.5,  'rgba(' + r + ',' + g + ',' + b + ',0.25)');
    glowGrad.addColorStop(0.55, 'rgba(' + r + ',' + g + ',' + b + ',0.08)');
    glowGrad.addColorStop(1,    'rgba(' + r + ',' + g + ',' + b + ',0)');

    scanCtx.fillStyle = glowGrad;
    scanCtx.fillRect(0, y - 40, scanW, 80);

    // Crisp centre line
    scanCtx.beginPath();
    scanCtx.strokeStyle = 'rgba(' + r + ',' + g + ',' + b + ',0.5)';
    scanCtx.lineWidth = 1;
    scanCtx.moveTo(0, y);
    scanCtx.lineTo(scanW, y);
    scanCtx.stroke();

    // Subtle edge vignette
    const vigGrad = scanCtx.createRadialGradient(
      scanW / 2, scanH / 2, scanH * 0.3,
      scanW / 2, scanH / 2, scanH * 0.8
    );
    vigGrad.addColorStop(0, 'rgba(0,0,0,0)');
    vigGrad.addColorStop(1, 'rgba(0,0,0,0.25)');
    scanCtx.fillStyle = vigGrad;
    scanCtx.fillRect(0, 0, scanW, scanH);
  }

  /* ── Main analysis + render loop ───────────────────────────────── */

  function startLoop() {
    function tick(timestamp) {
      requestAnimationFrame(tick);

      // Drift tick runs every frame for smooth motion
      driftTick();

      // Scan overlay runs every frame
      drawScanOverlay();

      if (timestamp - lastAnalysis < ANALYSIS_MS) return;
      lastAnalysis = timestamp;

      // 1. Colour analysis
      const canvas    = map.getCanvas();
      const colorData = colorAnalyzer.analyze(canvas);
      lastColorData   = colorData;

      // 2. Update UI bars
      updateBars(colorData);

      // 3. Drive audio + waveform
      if (isActive) {
        audioEngine.update(colorData);
        drawWaveform();
      }
    }

    requestAnimationFrame(tick);
  }

  /* ── UI helpers ────────────────────────────────────────────────── */

  function updateBars(data) {
    greenBar.style.width = clamp(data.green, 0, 100) + '%';
    blueBar.style.width  = clamp(data.blue,  0, 100) + '%';
    grayBar.style.width  = clamp(data.gray,  0, 100) + '%';

    greenValue.textContent = Math.round(data.green) + '%';
    blueValue.textContent  = Math.round(data.blue)  + '%';
    grayValue.textContent  = Math.round(data.gray)  + '%';
  }

  function drawWaveform() {
    const data = audioEngine.getWaveform();
    if (!data) return;

    wfCtx.clearRect(0, 0, wfW, wfH);

    // Push current waveform to history
    wfHistory.push(Array.from(data));
    while (wfHistory.length > WF_HISTORY_LEN) wfHistory.shift();

    // Draw trailing waveforms (ghosting effect)
    for (let h = 0; h < wfHistory.length; h++) {
      const hist = wfHistory[h];
      const age = (h + 1) / wfHistory.length;
      const alpha = age * 0.4;

      // Colour based on dominant channel
      const gn  = lastColorData.green / 40;
      const bn  = lastColorData.blue  / 25;
      const grn = lastColorData.gray  / 35;

      let color;
      if (gn > bn && gn > grn) {
        color = 'rgba(58,138,58,' + alpha + ')';
      } else if (bn > gn && bn > grn) {
        color = 'rgba(40,116,166,' + alpha + ')';
      } else {
        color = 'rgba(136,136,136,' + alpha + ')';
      }

      wfCtx.beginPath();
      wfCtx.strokeStyle = color;
      wfCtx.lineWidth = h === wfHistory.length - 1 ? 2 : 1;

      const step = wfW / hist.length;
      for (let i = 0; i < hist.length; i++) {
        const x = i * step;
        const y = ((1 - hist[i]) / 2) * wfH;
        if (i === 0) wfCtx.moveTo(x, y);
        else         wfCtx.lineTo(x, y);
      }
      wfCtx.stroke();
    }

    // Glow on the latest waveform
    if (wfHistory.length > 0) {
      const latest = wfHistory[wfHistory.length - 1];
      wfCtx.beginPath();
      wfCtx.strokeStyle = 'rgba(255,255,255,0.08)';
      wfCtx.lineWidth = 4;
      const step = wfW / latest.length;
      for (let i = 0; i < latest.length; i++) {
        const x = i * step;
        const y = ((1 - latest[i]) / 2) * wfH;
        if (i === 0) wfCtx.moveTo(x, y);
        else         wfCtx.lineTo(x, y);
      }
      wfCtx.stroke();
    }

    // Faint centre line
    wfCtx.beginPath();
    wfCtx.strokeStyle = 'rgba(255,255,255,0.04)';
    wfCtx.lineWidth   = 0.5;
    wfCtx.moveTo(0, wfH / 2);
    wfCtx.lineTo(wfW, wfH / 2);
    wfCtx.stroke();
  }

  function clearWaveform() {
    wfCtx.clearRect(0, 0, wfW, wfH);
    wfHistory.length = 0;
  }

  /* ── Start / Stop toggle ───────────────────────────────────────── */

  async function toggleAudio() {
    if (!isActive) {
      startBtn.textContent = '· · ·';
      startBtn.disabled = true;

      await audioEngine.init();
      audioEngine.start();

      isActive = true;
      startBtn.textContent = 'STOP';
      startBtn.classList.add('active');
      startBtn.disabled = false;

      // Show scan overlay
      scanOverlay.classList.add('active');
    } else {
      audioEngine.stop();
      isActive = false;

      startBtn.textContent = 'START';
      startBtn.classList.remove('active');
      clearWaveform();

      // Hide scan overlay
      scanOverlay.classList.remove('active');

      // Also stop drift
      if (isDrifting) {
        isDrifting = false;
        autopanBtn.classList.remove('active');
        autopanBtn.textContent = 'DRIFT';
      }
    }
  }

  startBtn.addEventListener('click', toggleAudio);

  /* ── Keyboard shortcuts ────────────────────────────────────────── */

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

  /* ── Intro screen ──────────────────────────────────────────────── */

  function dismissIntro() {
    introEl.classList.add('fade-out');
    setTimeout(() => {
      introEl.style.display = 'none';
    }, 1200);
  }

  introBtn.addEventListener('click', dismissIntro);

  /* ── Utils ─────────────────────────────────────────────────────── */

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /* ── Boot ──────────────────────────────────────────────────────── */

  initMap();

})();
