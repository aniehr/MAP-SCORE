/**
 * main.js – MAP SCORE · 地图乐谱 · 成都
 *
 * Initialises the MapLibre map (centred on Chengdu), runs a colour-analysis
 * loop at ~5 fps, drives the audio engine, and draws a waveform visualisation.
 *
 * Pipeline (mirrors the original TouchDesigner → VCV Rack flow):
 *   Map canvas → pixel readback → HSL classification → EMA smoothing
 *     → audio parameter mapping → Tone.js synthesis
 */

(function () {
  'use strict';

  /* ── Instances ─────────────────────────────────────────────────── */

  const colorAnalyzer = new ColorAnalyzer();
  const audioEngine   = new AudioEngine();

  /* ── DOM refs ──────────────────────────────────────────────────── */

  const startBtn      = document.getElementById('startBtn');
  const greenBar      = document.getElementById('greenBar');
  const blueBar       = document.getElementById('blueBar');
  const grayBar       = document.getElementById('grayBar');
  const greenValue    = document.getElementById('greenValue');
  const blueValue     = document.getElementById('blueValue');
  const grayValue     = document.getElementById('grayValue');
  const waveformEl    = document.getElementById('waveform');

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
  resizeWaveform();
  window.addEventListener('resize', resizeWaveform);

  /* ── State ─────────────────────────────────────────────────────── */

  let map          = null;
  let isActive     = false;   // audio running?
  let lastAnalysis = 0;
  const ANALYSIS_MS = 200;    // analyse every 200 ms (~5 fps)

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
          {
            id: 'osm-tiles',
            type: 'raster',
            source: 'osm'
          }
        ]
      },
      center: [104.0668, 30.5728],   // 成都 Chengdu
      zoom: 13,
      preserveDrawingBuffer: true,    // required for pixel readback
      maxZoom: 18,
      minZoom: 3
    });

    map.addControl(new maplibregl.NavigationControl(), 'top-left');
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

    map.on('load', () => {
      startLoop();
    });
  }

  /* ── Main analysis + render loop ───────────────────────────────── */

  function startLoop() {
    function tick(timestamp) {
      requestAnimationFrame(tick);

      if (timestamp - lastAnalysis < ANALYSIS_MS) return;
      lastAnalysis = timestamp;

      // 1. Colour analysis
      const canvas    = map.getCanvas();
      const colorData = colorAnalyzer.analyze(canvas);

      // 2. Update UI bars
      updateBars(colorData);

      // 3. Drive audio
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

    // Gradient stroke
    const grad = wfCtx.createLinearGradient(0, 0, wfW, 0);
    grad.addColorStop(0,   'rgba(58,138,58,0.5)');   // green
    grad.addColorStop(0.5, 'rgba(40,116,166,0.5)');  // blue
    grad.addColorStop(1,   'rgba(136,136,136,0.4)'); // gray

    wfCtx.beginPath();
    wfCtx.strokeStyle = grad;
    wfCtx.lineWidth   = 1.5;

    const step = wfW / data.length;
    for (let i = 0; i < data.length; i++) {
      const x = i * step;
      const y = ((1 - data[i]) / 2) * wfH;
      if (i === 0) wfCtx.moveTo(x, y);
      else         wfCtx.lineTo(x, y);
    }
    wfCtx.stroke();

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
    } else {
      audioEngine.stop();
      isActive = false;

      startBtn.textContent = 'START';
      startBtn.classList.remove('active');
      clearWaveform();
    }
  }

  startBtn.addEventListener('click', toggleAudio);

  // Spacebar shortcut (only when no input is focused)
  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space' && e.target === document.body) {
      e.preventDefault();
      toggleAudio();
    }
  });

  /* ── Utils ─────────────────────────────────────────────────────── */

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  /* ── Boot ──────────────────────────────────────────────────────── */

  initMap();

})();
