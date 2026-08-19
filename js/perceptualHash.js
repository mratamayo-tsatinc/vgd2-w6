/* ============================================================
   IMAGE QUIZ GRADER — JavaScript.html
   PerceptualHash — Shared Average-Hash (aHash) Engine   (pHash-feature Phase 2)
   ============================================================

   ⚠ GUIDING PRINCIPLE — READ BEFORE EDITING THIS MODULE ⚠
   There is exactly ONE implementation of the perceptual-hashing algorithm
   in this entire app: computeAHash(), below. It is called by BOTH:
     • the student submission path (ImageProcessor.processFile(), in the
       next <script> block), and
     • the teacher answer-key upload path (saveAnswerKeyFromUpload's
       client-side caller, added in a later phase).
   Both callers MUST route through this exact function — never a
   re-implementation, never a "close enough" variant. A value recorded as
   "the answer" and a value extracted "to compare against the answer" are
   only meaningfully comparable if they were produced by identical code.
   If you are tempted to compute a hash anywhere else in this codebase,
   that is drift — stop, and call this function instead.

   This module has no dependency on the App module, ImageProcessor, or the
   DOM beyond the <canvas>/<img> APIs it needs to decode pixels. It knows
   nothing about students, sections, or submissions — it only turns an
   image File into a 64-bit hash string, or null when one isn't meaningful
   (PDF, or an unsupported/undecodable format).
   ============================================================ */

const PerceptualHash = (() => {
  'use strict';

  // 8×8 grid = 64 bits = 16 hex characters. Locked by design decision — do
  // not change without updating every stored/compared hash's assumed length.
  const GRID_SIZE = 8;

  // Formats the browser can decode natively via <img>. Mirrors
  // ImageProcessor.RASTER_FORMATS exactly (duplicated as a literal, not
  // imported, since this module intentionally has zero dependency on
  // ImageProcessor — see the module header above).
  const RASTER_FORMATS = ['JPEG', 'PNG', 'GIF', 'BMP'];

  // ── Format-specific decoders — each produces a full-size <canvas> ──────
  // Every decoder below has exactly one job: get real pixels onto a
  // <canvas>. The actual hashing math lives in ONE place further down
  // (canvasToAHash_) and never varies by format.

  /** JPEG / PNG / GIF / BMP — decoded via the browser's native <img>. */
  function rasterFileToCanvas_(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement('canvas');
          canvas.width  = img.naturalWidth;
          canvas.height = img.naturalHeight;
          canvas.getContext('2d').drawImage(img, 0, 0);
          resolve(canvas);
        } catch (e) {
          reject(e);
        } finally {
          URL.revokeObjectURL(url);
        }
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Browser could not decode this image data'));
      };
      img.src = url;
    });
  }

  /**
   * TIFF — browsers cannot render TIFF via <img>, so this does a FULL pixel
   * decode via UTIF.js (UTIF.decodeImage + UTIF.toRGBA8). This is distinct
   * from ImageProcessor's getTiffDimensions(), which only reads
   * header/IFD tags and never touches pixel data — hashing needs the real
   * pixels, dimension-reading doesn't. Requires UTIF.js (see Index.html);
   * throws if unavailable, so the caller can report "hash unavailable"
   * without pretending a hash was computed.
   */
  async function tiffFileToCanvas_(file) {
    if (typeof UTIF === 'undefined') {
      throw new Error('TIFF support library did not load — pHash unavailable for this file');
    }
    const buf = await file.arrayBuffer();
    const ifds = UTIF.decode(buf);
    if (!ifds || !ifds.length) throw new Error('TIFF file has no readable image directory');
    const ifd = ifds[0];
    UTIF.decodeImage(buf, ifd);
    const rgba = UTIF.toRGBA8(ifd);
    const width  = ifd.width  || (ifd.t256 && ifd.t256[0]);
    const height = ifd.height || (ifd.t257 && ifd.t257[0]);
    if (!width || !height) throw new Error('TIFF header is missing width/height tags');

    const canvas = document.createElement('canvas');
    canvas.width  = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    const imageData = ctx.createImageData(width, height);
    imageData.data.set(new Uint8ClampedArray(rgba.buffer ? rgba.buffer : rgba));
    ctx.putImageData(imageData, 0, 0);
    return canvas;
  }

  // ── The one true hashing algorithm ──────────────────────────────────
  /**
   * Internal — the ENTIRE aHash algorithm lives here, and only here:
   *   1. Downscale the source canvas to GRID_SIZE × GRID_SIZE (the
   *      browser's default bilinear resampling on drawImage() — identical
   *      behavior for every caller, since it's the same call site).
   *   2. Convert each of the 64 pixels to grayscale via the standard
   *      luminosity formula (0.299R + 0.587G + 0.114B).
   *   3. Compute the mean of the 64 grayscale values.
   *   4. For each pixel, row-major, top-left to bottom-right: bit = 1 if
   *      its grayscale value >= the mean, else 0.
   *   5. Pack the 64 bits into a 16-character lowercase hex string.
   */
  function canvasToAHash_(sourceCanvas) {
    const small = document.createElement('canvas');
    small.width  = GRID_SIZE;
    small.height = GRID_SIZE;
    const ctx = small.getContext('2d');
    ctx.drawImage(sourceCanvas, 0, 0, GRID_SIZE, GRID_SIZE);

    const pixels = ctx.getImageData(0, 0, GRID_SIZE, GRID_SIZE).data;
    const pixelCount = GRID_SIZE * GRID_SIZE;
    const gray = new Array(pixelCount);
    let sum = 0;
    for (let i = 0; i < pixelCount; i++) {
      const o = i * 4;
      const g = 0.299 * pixels[o] + 0.587 * pixels[o + 1] + 0.114 * pixels[o + 2];
      gray[i] = g;
      sum += g;
    }
    const mean = sum / pixelCount;

    let hex = '';
    for (let nibbleStart = 0; nibbleStart < pixelCount; nibbleStart += 4) {
      let nibble = 0;
      for (let b = 0; b < 4; b++) {
        nibble = (nibble << 1) | (gray[nibbleStart + b] >= mean ? 1 : 0);
      }
      hex += nibble.toString(16);
    }
    return hex;
  }

  /**
   * THE shared entry point — see the module-level Guiding Principle notice
   * above. Never throws; a failure to hash is reported as `null` so the
   * caller can still report every other attribute for the file.
   *
   * @param {File} file
   * @param {string} detectedFormat  One of ImageProcessor.SUPPORTED_FORMATS,
   *   as already determined by ImageProcessor.detectImageFormat(). This
   *   function deliberately never re-detects format itself — format
   *   detection stays a single-owner concern in ImageProcessor — it only
   *   decides HOW to decode pixels once the format is already known.
   * @returns {Promise<string|null>} 16-char lowercase hex string, or null
   *   for PDF, UNKNOWN, or any file whose pixels could not be decoded.
   */
  async function computeAHash(file, detectedFormat) {
    if (!file || !detectedFormat) return null;

    // PDF is ALWAYS exempt — mirrors the existing width/height/aspect-ratio
    // exemption elsewhere in the app (see ImageProcessor's PDF note): a
    // PDF's rendered pixels depend on export DPI/renderer, not just its
    // bytes, so a byte-derived hash would not be meaningfully comparable
    // across submissions or against a teacher's answer key.
    if (detectedFormat === 'PDF') return null;

    try {
      let sourceCanvas;
      if (RASTER_FORMATS.indexOf(detectedFormat) !== -1) {
        sourceCanvas = await rasterFileToCanvas_(file);
      } else if (detectedFormat === 'TIFF') {
        sourceCanvas = await tiffFileToCanvas_(file);
      } else {
        return null; // UNKNOWN or any future format this module doesn't handle yet
      }
      return canvasToAHash_(sourceCanvas);
    } catch (e) {
      console.warn('PerceptualHash.computeAHash: could not compute hash — ' + e.message);
      return null;
    }
  }

  return {
    GRID_SIZE,
    computeAHash
  };
})();
