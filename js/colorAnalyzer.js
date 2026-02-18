/**
 * ColorAnalyzer
 *
 * Reads pixels from the map canvas and classifies them into three channels:
 *   - green  (parks, forests, vegetation)
 *   - blue   (water bodies, rivers)
 *   - gray   (roads, buildings, urban)
 *
 * Uses HSL colour-space classification and exponential moving average (EMA)
 * smoothing to avoid extreme jumps – mirroring the original TouchDesigner
 * pipeline's ToptoChop + Analyze approach.
 */
class ColorAnalyzer {
  constructor() {
    // Off-screen canvas used for pixel readback
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });

    // Down-sample size – 200x200 is fast enough at 5 fps
    this.SAMPLE_SIZE = 200;
    this.canvas.width = this.SAMPLE_SIZE;
    this.canvas.height = this.SAMPLE_SIZE;

    // EMA-smoothed output values (percentages)
    this.smoothed = { green: 0, blue: 0, gray: 0 };

    // Smoothing factor (0 < alpha <= 1). Lower = smoother / slower reaction.
    this.alpha = 0.12;
  }

  /**
   * Analyse the current map canvas and return smoothed colour percentages.
   * @param {HTMLCanvasElement} sourceCanvas  – the MapLibre WebGL canvas
   * @returns {{ green: number, blue: number, gray: number }}
   */
  analyze(sourceCanvas) {
    try {
      // Draw the WebGL canvas scaled down to the sample size
      this.ctx.drawImage(
        sourceCanvas,
        0, 0,
        this.SAMPLE_SIZE, this.SAMPLE_SIZE
      );

      const imageData = this.ctx.getImageData(
        0, 0,
        this.SAMPLE_SIZE, this.SAMPLE_SIZE
      );
      const px = imageData.data;
      const total = this.SAMPLE_SIZE * this.SAMPLE_SIZE;

      let greenCount = 0;
      let blueCount  = 0;
      let grayCount  = 0;

      for (let i = 0; i < px.length; i += 4) {
        const r = px[i];
        const g = px[i + 1];
        const b = px[i + 2];

        const hsl = this._rgbToHsl(r, g, b);

        if (this._isGreen(hsl, r, g, b)) {
          greenCount++;
        } else if (this._isBlue(hsl, r, g, b)) {
          blueCount++;
        } else if (this._isGray(hsl)) {
          grayCount++;
        }
      }

      // Raw percentages
      let rawGreen = (greenCount / total) * 100;
      let rawBlue  = (blueCount  / total) * 100;
      let rawGray  = (grayCount  / total) * 100;

      // Cap total at 100 (as in the original TouchDesigner pipeline)
      const rawSum = rawGreen + rawBlue + rawGray;
      if (rawSum > 100) {
        const scale = 100 / rawSum;
        rawGreen *= scale;
        rawBlue  *= scale;
        rawGray  *= scale;
      }

      // EMA smoothing (减缓极端值)
      const a = this.alpha;
      this.smoothed.green = this.smoothed.green * (1 - a) + rawGreen * a;
      this.smoothed.blue  = this.smoothed.blue  * (1 - a) + rawBlue  * a;
      this.smoothed.gray  = this.smoothed.gray  * (1 - a) + rawGray  * a;

    } catch (_e) {
      // Canvas tainted or WebGL read-back failed – return last known values
    }

    return {
      green: this.smoothed.green,
      blue:  this.smoothed.blue,
      gray:  this.smoothed.gray
    };
  }

  /* ── Colour classification helpers ─────────────────────────────── */

  /**
   * Green – parks, forests, vegetation on OSM tiles.
   * Typical colours: #c8e6a0, #a0cf70, #8bc45a, #add19e
   */
  _isGreen(hsl, _r, g, _b) {
    return (
      hsl.h >= 55 && hsl.h <= 165 &&
      hsl.s >= 10 &&
      hsl.l >= 25 && hsl.l <= 88 &&
      g > 100 // sanity: green channel should be reasonably high
    );
  }

  /**
   * Blue – water bodies, rivers, lakes on OSM tiles.
   * Typical colours: #aad3df, #82c0d0, #5f9cb0
   */
  _isBlue(hsl, _r, _g, b) {
    return (
      hsl.h >= 170 && hsl.h <= 255 &&
      hsl.s >= 12 &&
      hsl.l >= 25 && hsl.l <= 88 &&
      b > 90
    );
  }

  /**
   * Gray – roads, urban areas, buildings.
   * Low saturation, lightness in the mid-to-high range (not pure white/black).
   */
  _isGray(hsl) {
    return (
      hsl.s <= 8 &&
      hsl.l >= 55 && hsl.l <= 93
    );
  }

  /* ── Colour conversion ─────────────────────────────────────────── */

  _rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;

    if (max === min) {
      return { h: 0, s: 0, l: l * 100 };
    }

    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

    let h;
    switch (max) {
      case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
      case g: h = ((b - r) / d + 2) / 6; break;
      case b: h = ((r - g) / d + 4) / 6; break;
    }

    return {
      h: h * 360,
      s: s * 100,
      l: l * 100
    };
  }
}
