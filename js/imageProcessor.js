/* ============================================================
   IMAGE QUIZ GRADER — JavaScript.html
   ImageProcessor — Client-Side Image Inspection Engine  (NEW — Phase 3)
   ============================================================

   Runs entirely in the student's browser. Given a real image File object
   (never text typed by the student), this module determines:
     • the file's TRUE format, from its byte signature — NOT from the
       filename extension. This is the anti-cheat core: a file renamed
       "photo.jpg" → "photo.png" without actually being re-saved will still
       report as JPEG here, because the bytes don't lie.
     • the file's pixel width/height, so Save-As-shouldn't-resize can be
       verified server-side against the original.
     • (pHash-feature Phase 2) the file's perceptual hash (aHash), via the
       shared PerceptualHash.computeAHash() — never computed locally in
       this module. See PerceptualHash's module header, above, for why
       that separation matters.

   Raw image bytes are NEVER sent anywhere — only the small derived record
   below is meant to be transmitted to the server (wiring happens in a later
   phase). This module has no dependency on the App module or the DOM.
   ============================================================ */

const ImageProcessor = (() => {
  'use strict';

  // Formats this app recognizes at all. Anything else → 'UNKNOWN'.
  const RASTER_FORMATS   = ['JPEG', 'PNG', 'GIF', 'BMP']; // browser can decode via <img>
  const SUPPORTED_FORMATS = ['JPEG', 'PNG', 'GIF', 'BMP', 'TIFF', 'PDF'];

  // ── Format Detection (magic bytes) ─────────────────────────
  /**
   * Reads the first few bytes of a File and matches them against known
   * image/PDF signatures. Returns one of SUPPORTED_FORMATS, or 'UNKNOWN'.
   * This is deliberately based ONLY on file content, never on file.name.
   */
  async function detectImageFormat(file) {
    let buf;
    try {
      buf = await file.slice(0, 16).arrayBuffer();
    } catch (e) {
      throw new Error('Could not read file bytes: ' + e.message);
    }
    const bytes = new Uint8Array(buf);
    const hex = Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');

    if (hex.startsWith('ffd8ff'))                                          return 'JPEG';
    if (hex.startsWith('89504e470d0a1a0a'))                                return 'PNG';
    if (hex.startsWith('474946383761') || hex.startsWith('474946383961'))  return 'GIF'; // GIF87a / GIF89a
    if (hex.startsWith('424d'))                                            return 'BMP';
    if (hex.startsWith('49492a00') || hex.startsWith('4d4d002a'))          return 'TIFF'; // little/big-endian
    if (hex.startsWith('25504446'))                                        return 'PDF';  // %PDF
    return 'UNKNOWN';
  }

  // ── Dimension Extraction ────────────────────────────────────
  /** JPEG / PNG / GIF / BMP — all natively decodable by the browser. */
  function getRasterDimensions(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        resolve({ width: img.naturalWidth, height: img.naturalHeight });
        URL.revokeObjectURL(url);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Browser could not decode this image data'));
      };
      img.src = url;
    });
  }

  /**
   * TIFF — browsers cannot render TIFF via <img>, so we parse just the
   * header/IFD tags (256 = ImageWidth, 257 = ImageLength) via UTIF.js
   * rather than doing a full pixel decode. Requires UTIF.js to be loaded
   * (see Index.html); if it isn't available, dimensions are reported as
   * unavailable rather than throwing, so the student still gets a verdict
   * on format correctness even if the dimension check is degraded.
   */
  async function getTiffDimensions(file) {
    if (typeof UTIF === 'undefined') {
      throw new Error('TIFF support library did not load — dimension check unavailable');
    }
    const buf = await file.arrayBuffer();
    let ifds;
    try {
      ifds = UTIF.decode(buf);
    } catch (e) {
      throw new Error('Could not parse TIFF header: ' + e.message);
    }
    if (!ifds || !ifds.length) throw new Error('TIFF file has no readable image directory');
    const ifd = ifds[0];
    const width  = ifd.width  || (ifd.t256 && ifd.t256[0]);
    const height = ifd.height || (ifd.t257 && ifd.t257[0]);
    if (!width || !height) throw new Error('TIFF header is missing width/height tags');
    return { width, height };
  }

  // PDF dimensions are intentionally NOT extracted. A Photoshop "Save As" PDF
  // page size is reported in points, tied to the export DPI setting, and does
  // not map 1:1 onto the original raster's pixel width/height. Rather than
  // build a check that penalizes correct conversions over a DPI setting, PDF
  // targets are verified by signature + base name + slot-lock only. See the
  // implementation plan (§11, Q1) for the reasoning and how to revisit this.

  // ── Per-file processing pipeline ────────────────────────────
  /**
   * Processes a single File into a plain-object record describing what it
   * actually is. Never throws — all failure modes are captured in
   * record.error / record.dimensionNote so the caller can render a verdict
   * for every file, including unreadable/unsupported ones.
   *
   * Returned shape:
   *   {
   *     fileName, baseName, declaredExt,      // from the filename (untrusted)
   *     detectedExt,                          // from file bytes (trusted)
   *     width, height,                        // decoded pixel dimensions, or null
   *     sizeKb,
   *     dimensionNote,                        // set when dims couldn't be verified
   *     perceptualHash,                       // 16-char hex aHash, or null (pHash-feature Phase 2)
   *     valid,                                // true iff a supported format was detected
   *     error                                 // set when the file is unusable
   *   }
   */
  async function processFile(file) {
    const rawName = (file && file.name) || '';
    const dot         = rawName.lastIndexOf('.');
    const baseName    = dot >= 0 ? rawName.substring(0, dot) : rawName;
    const declaredExt = dot >= 0 ? rawName.substring(dot + 1).toUpperCase() : '';

    const record = {
      fileName:       rawName,
      baseName:       baseName,
      declaredExt:    declaredExt,
      detectedExt:    'UNKNOWN',
      width:          null,
      height:         null,
      sizeKb:         file ? Math.round((file.size / 1024) * 100) / 100 : 0,
      dimensionNote:  '',
      perceptualHash: null,
      valid:          false,
      error:          '',
      // NEW — Software Provenance Gate, Phase 3: kept only for the
      // submit-time re-scan (see App.attachSoftwareCheck_). NEVER sent to
      // the server directly — File objects cannot cross the
      // google.script.run bridge — stripped from every payload before any
      // call() to a server function.
      file: file || null
    };

    if (!file) {
      record.error = 'No file provided.';
      return record;
    }
    if (!baseName) {
      record.error = 'File has no name.';
      return record;
    }

    try {
      record.detectedExt = await detectImageFormat(file);
    } catch (e) {
      record.error = e.message;
      return record;
    }

    if (record.detectedExt === 'UNKNOWN') {
      record.error = 'Unrecognized file — not a JPEG, PNG, GIF, BMP, TIFF, or PDF (checked by file content, not name).';
      return record;
    }

    try {
      if (RASTER_FORMATS.indexOf(record.detectedExt) !== -1) {
        const dims = await getRasterDimensions(file);
        record.width  = dims.width;
        record.height = dims.height;
      } else if (record.detectedExt === 'TIFF') {
        const dims = await getTiffDimensions(file);
        record.width  = dims.width;
        record.height = dims.height;
      } else if (record.detectedExt === 'PDF') {
        record.dimensionNote = 'Dimension check is skipped for PDF files — only the file format is verified.';
      }
    } catch (e) {
      // A recognized format whose dimensions couldn't be read is still a
      // useful result (format-only verification can proceed); don't discard it.
      record.dimensionNote = 'Could not read dimensions: ' + e.message;
    }

    // pHash-feature Phase 2: always routed through the single shared
    // PerceptualHash.computeAHash() — see that module's header for why
    // this must never be re-implemented locally. Never throws (it has its
    // own internal try/catch and resolves to null on failure), so no
    // try/catch is needed here — but a failure here must never discard an
    // otherwise-good record, same philosophy as the dimension block above.
    record.perceptualHash = await PerceptualHash.computeAHash(file, record.detectedExt);

    // A "renamed, not converted" file — the whole anti-cheat point — is
    // still marked valid here (it WAS successfully identified); it's the
    // server-side scoring step that compares detectedExt against what was
    // actually required and rejects the mismatch. This module only reports
    // ground truth, it doesn't grade.
    record.valid = true;
    return record;
  }

  /**
   * Processes many files with bounded concurrency (raster decoding many
   * large images at once can spike browser memory on big bulk uploads).
   * Order of the returned array matches the input order. onProgress, if
   * given, is called after each file finishes: onProgress(done, total, record).
   */
  async function processFiles(files, onProgress) {
    const fileArr = Array.from(files || []);
    const results = new Array(fileArr.length);
    const CONCURRENCY = 6;
    let nextIndex = 0;
    let doneCount = 0;

    async function worker() {
      while (nextIndex < fileArr.length) {
        const idx = nextIndex++;
        results[idx] = await processFile(fileArr[idx]);
        doneCount++;
        if (typeof onProgress === 'function') {
          onProgress(doneCount, fileArr.length, results[idx]);
        }
      }
    }

    const workerCount = Math.min(CONCURRENCY, fileArr.length) || 0;
    const workers = [];
    for (let i = 0; i < workerCount; i++) workers.push(worker());
    await Promise.all(workers);
    return results;
  }

  // ── Software Provenance Gate (Phase 3) ──────────────────────
  /**
   * Scans a file's raw bytes for a case-insensitive substring match of the
   * teacher-configured program name (Sections.RequiredSoftwareName). This
   * is a completely separate concern from computeAHash() above — it reads
   * raw file text, not decoded pixel data — so there's no shared-pipeline
   * risk with PerceptualHash.
   *
   * Deliberately loose (not a structured EXIF/XMP/PDF parser): decodes the
   * whole file as windows-1252 text (a byte-preserving decode that never
   * throws) and does a case-insensitive substring search. This works
   * uniformly across JPEG EXIF Software tags, embedded XMP CreatorTool/
   * Software fields, PNG text chunks, and PDF /Producer//Creator
   * dictionary entries — all of these embed the tool name as plain
   * ASCII/UTF-8 somewhere in the byte stream. False negatives are more
   * acceptable than the fragility of per-format parsing.
   *
   * @param {File} file
   * @param {string} targetSoftware
   * @returns {Promise<{passed: boolean, detail: string}>}
   */
  async function inspectMetadataProvenance(file, targetSoftware) {
    const needle = String(targetSoftware || '').trim();
    if (!needle) return { passed: false, detail: 'No required software name is configured for this section.' };
    if (!file)   return { passed: false, detail: 'No file available to inspect.' };

    let buf;
    try { buf = await file.arrayBuffer(); }
    catch (e) { return { passed: false, detail: 'Could not read the file for metadata inspection.' }; }

    let text;
    try {
      text = new TextDecoder('windows-1252').decode(buf);
    } catch (e) {
      const bytes = new Uint8Array(buf);
      const CHUNK = 0x8000;
      const parts = [];
      for (let i = 0; i < bytes.length; i += CHUNK) {
        parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK)));
      }
      text = parts.join('');
    }

    const idx = text.toLowerCase().indexOf(needle.toLowerCase());
    if (idx === -1) return { passed: false, detail: 'No "' + needle + '" signature found in the file\'s metadata.' };

    const start = Math.max(0, idx - 10);
    const end   = Math.min(text.length, idx + needle.length + 20);
    const snippet = text.substring(start, end).replace(/[^\x20-\x7e]/g, '·').trim();
    return { passed: true, detail: 'Matched near: "' + snippet + '"' };
  }

  return {
    SUPPORTED_FORMATS,
    RASTER_FORMATS,
    detectImageFormat,
    processFile,
    processFiles,
    inspectMetadataProvenance
  };
})();
