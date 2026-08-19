/* ============================================================
   IMAGE QUIZ GRADER — js/metadataInspector.js
   MetadataInspector — Client-Side Generic Image Metadata Reader
   (Teacher-only "Inspect Image" tool)
   ============================================================

   Extracts whatever embedded metadata a submitted image actually
   contains — EXIF, IPTC, XMP, ICC, GPS, JFIF, thumbnail (IFD1), etc —
   WITHOUT assuming in advance which tags will be present. This is a
   forensic/inspection aid for teachers, not a scoring input: nothing
   here is compared against an answer key, and nothing computed here is
   sent to the server.

   ⚠ GUIDING PRINCIPLE — this module must stay tag-agnostic. Every field
   a camera, phone, or editing tool chooses to embed should show up
   automatically; nothing about a specific property name or value is
   ever hardcoded here. Formatting logic below branches on VALUE TYPE
   (number/string/date/array/binary), never on tag NAME — do not add
   per-tag special cases.

   Powered by exifr (https://github.com/MikeKovarik/exifr), loaded from
   CDN in Index.html, which does the actual generic parsing and returns
   tags grouped by the segment they came from (ifd0/exif/gps/iptc/xmp/
   icc/jfif/...). This module's job is just to shape that output for the
   UI and to fold in a couple of derived, non-metadata facts (detected
   true format, pixel dimensions, a perceptual hash) using the SAME
   shared engines the rest of the app already uses — see the "Derived
   (computed)" section below, which is clearly separated from anything
   actually embedded in the file.
   ============================================================ */

const MetadataInspector = (() => {
  'use strict';

  // Every segment group exifr can extract independently. mergeOutput:false
  // keeps each group distinct in the UI, so a teacher can tell "this came
  // from XMP" apart from "this came from EXIF" instead of one flattened
  // bag of same-named keys silently overwriting each other.
  const SEGMENT_OPTIONS = {
    tiff: true, ifd0: true, ifd1: true, exif: true, gps: true,
    interop: true, iptc: true, xmp: true, icc: true, jfif: true,
    mergeOutput: false, sanitize: true, reviveValues: true,
    translateKeys: true, translateValues: true, translateValues_XMP: true
  };

  // Display-only label + short description per segment group. This is
  // presentation metadata about the GROUPS exifr defines (a fixed, small
  // set of container names) — not about which tags/values appear inside
  // them, so it doesn't violate the no-hardcoded-tags principle above.
  const GROUP_INFO = {
    ifd0:    { label: 'Image (IFD0)',        icon: 'bi-card-image',      hint: 'Core TIFF-style image tags — make/model, orientation, resolution, software, timestamps.' },
    ifd1:    { label: 'Thumbnail (IFD1)',    icon: 'bi-image',           hint: 'Metadata describing an embedded preview thumbnail, if the file carries one.' },
    exif:    { label: 'EXIF',                icon: 'bi-camera-fill',     hint: 'Camera/capture details — exposure, lens, flash, ISO, capture timestamp, and more.' },
    gps:     { label: 'GPS',                 icon: 'bi-geo-alt-fill',    hint: 'Location the photo claims to have been captured at, if recorded by the device.' },
    interop: { label: 'Interoperability',    icon: 'bi-diagram-3',      hint: 'Interoperability tags used to signal compatible viewers/printers.' },
    iptc:    { label: 'IPTC',                icon: 'bi-file-earmark-text', hint: 'Captioning, credit, and editorial fields — common in press/stock workflows.' },
    xmp:     { label: 'XMP',                 icon: 'bi-braces',         hint: 'Extensible metadata written by editing software (Photoshop, Lightroom, etc.).' },
    icc:     { label: 'ICC Color Profile',   icon: 'bi-palette-fill',   hint: 'Embedded color-management profile describing how color should be rendered.' },
    jfif:    { label: 'JFIF',                icon: 'bi-file-earmark-binary', hint: 'Baseline JPEG file-interchange header fields.' }
  };

  /** "captureDate" -> "Capture Date". Purely cosmetic; never changes the key used to look values up. */
  function humanizeKey(key) {
    return String(key)
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_\-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^./, c => c.toUpperCase());
  }

  /**
   * Renders ANY value generically by its JS type — this is the one place
   * that keeps the whole module tag-agnostic. No branch here ever checks
   * a tag's NAME, only what shape/type its value happens to be.
   */
  function formatValue(v) {
    if (v === null || v === undefined || v === '') return { text: '—', kind: 'empty' };
    if (v instanceof Uint8Array || (typeof ArrayBuffer !== 'undefined' && v instanceof ArrayBuffer)) {
      const len = v.byteLength !== undefined ? v.byteLength : v.length;
      return { text: 'Binary data (' + len + ' bytes)', kind: 'binary' };
    }
    if (v instanceof Date) {
      return isNaN(v.getTime()) ? { text: 'Invalid date', kind: 'empty' } : { text: v.toLocaleString(), kind: 'date' };
    }
    if (Array.isArray(v)) {
      if (!v.length) return { text: '[]', kind: 'empty' };
      if (v.every(x => typeof x === 'number')) return { text: '[' + v.join(', ') + ']', kind: 'array' };
      return { text: v.map(x => (x && typeof x === 'object') ? safeJson_(x) : String(x)).join(', '), kind: 'array' };
    }
    if (typeof v === 'object') return { text: safeJson_(v), kind: 'object' };
    if (typeof v === 'number') return { text: (Math.round(v * 1000) / 1000).toString(), kind: 'number' };
    if (typeof v === 'boolean') return { text: v ? 'Yes' : 'No', kind: 'boolean' };
    return { text: String(v), kind: 'string' };
  }

  function safeJson_(obj) {
    try { return JSON.stringify(obj); } catch (e) { return '[object]'; }
  }

  /** Pulls a plain {lat, lon} out of the gps group, whatever else it contains. */
  function extractGps(groups) {
    const gps = groups.gps;
    if (!gps) return null;
    const lat = typeof gps.latitude === 'number' ? gps.latitude : null;
    const lon = typeof gps.longitude === 'number' ? gps.longitude : null;
    if (lat === null || lon === null) return null;
    return { lat, lon };
  }

  /**
   * Processes one File into a display-ready record: file-level facts,
   * a couple of derived (computed, non-embedded) facts reusing the app's
   * existing shared engines, and every embedded metadata group exifr
   * found — with nothing assumed about which groups or tags will exist.
   */
  async function inspectFile(file) {
    const record = {
      fileName: (file && file.name) || '',
      sizeKb: file ? Math.round((file.size / 1024) * 100) / 100 : 0,
      lastModified: (file && file.lastModified) ? new Date(file.lastModified) : null,
      detectedFormat: null,
      width: null,
      height: null,
      perceptualHash: null,
      gps: null,
      groups: {},     // { groupKey: { tagKey: rawValue, ... }, ... } — populated dynamically
      groupCount: 0,
      tagCount: 0,
      parseError: null
    };
    if (!file) { record.parseError = 'No file provided.'; return record; }

    // Derived facts — reuse the SAME shared engines the rest of the app
    // already uses for these, so an "Inspect" result is never a second,
    // possibly-drifted implementation of format/dimension/hash detection
    // (mirrors the Guiding Principle in perceptualHash.js).
    try {
      if (typeof ImageProcessor !== 'undefined') {
        record.detectedFormat = await ImageProcessor.detectImageFormat(file);
      }
    } catch (e) { /* leave null — still show whatever else is available */ }

    try {
      if (record.detectedFormat && typeof ImageProcessor !== 'undefined') {
        const rec = await ImageProcessor.processFile(file);
        record.width = rec.width;
        record.height = rec.height;
        record.perceptualHash = rec.perceptualHash;
      }
    } catch (e) { /* dimensions/hash stay null — non-fatal */ }

    // Embedded metadata — the actual generic extraction.
    if (typeof exifr === 'undefined') {
      record.parseError = 'Metadata parsing library did not load — try refreshing the page.';
      return record;
    }
    try {
      const parsed = await exifr.parse(file, SEGMENT_OPTIONS);
      if (parsed && typeof parsed === 'object') {
        Object.keys(parsed).forEach(groupKey => {
          const groupVal = parsed[groupKey];
          if (groupVal && typeof groupVal === 'object' && !Array.isArray(groupVal) && Object.keys(groupVal).length) {
            record.groups[groupKey] = groupVal;
            record.groupCount += 1;
            record.tagCount += Object.keys(groupVal).length;
          }
        });
        record.gps = extractGps(record.groups);
      }
    } catch (e) {
      // exifr throws when a file has no parseable metadata segments at all
      // (a plain re-saved PNG/BMP/GIF, most screenshots, etc.) — that is a
      // normal, expected, and often INTERESTING outcome for this tool
      // (e.g. "no EXIF at all" can itself be a signal), not an error to
      // alarm a teacher over. Only surface it if nothing else came back.
      if (!record.detectedFormat) record.parseError = 'Could not read this file at all: ' + e.message;
    }

    return record;
  }

  async function inspectFiles(files, onProgress) {
    const arr = Array.from(files || []);
    const out = [];
    for (let i = 0; i < arr.length; i++) {
      out.push(await inspectFile(arr[i]));
      if (typeof onProgress === 'function') onProgress(i + 1, arr.length, out[i]);
    }
    return out;
  }

  /** Plain-object export (for "Download JSON") — dates/binary already
   *  reduced to readable strings via formatValue() by the caller. */
  function toPlainObject(record) {
    const groups = {};
    Object.keys(record.groups).forEach(g => {
      groups[g] = {};
      Object.keys(record.groups[g]).forEach(k => {
        groups[g][k] = formatValue(record.groups[g][k]).text;
      });
    });
    return {
      fileName: record.fileName,
      sizeKb: record.sizeKb,
      lastModified: record.lastModified ? record.lastModified.toISOString() : null,
      detectedFormat: record.detectedFormat,
      width: record.width,
      height: record.height,
      perceptualHash: record.perceptualHash,
      gps: record.gps,
      metadata: groups
    };
  }

  return {
    GROUP_INFO,
    humanizeKey,
    formatValue,
    inspectFile,
    inspectFiles,
    toPlainObject
  };
})();
