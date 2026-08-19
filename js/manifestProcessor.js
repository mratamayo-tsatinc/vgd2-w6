/* ============================================================
   ManifestProcessor — Client-side manifest parser (Phase 5)
   ============================================================ */

const ManifestProcessor = (() => {
  'use strict';

  function parseLine(line, lineNum) {
    const out = {
      fileName: '', baseName: '', declaredExt: '', detectedExt: '',
      width: null, height: null, sizeKb: null, aspectRatio: '', orientation: '',
      perceptualHash: null, valid: false, error: null, lineNum: lineNum
    };
    if (!line || !String(line).trim()) {
      out.error = 'Empty line';
      return out;
    }
    const parts = line.split(',').map(p => p.trim());
    if (parts.length !== 7) {
      out.error = 'Expected 7 comma-separated fields';
      return out;
    }
    const [base, ext, sizeStr, widthStr, heightStr, ar, orient] = parts;
    if (!base) { out.error = 'Missing filename base'; return out; }
    out.baseName = base;
    out.declaredExt = ext ? String(ext).toUpperCase() : '';
    out.detectedExt = out.declaredExt || 'UNKNOWN';

    const sizeN = parseFloat(sizeStr);
    out.sizeKb = isNaN(sizeN) ? null : sizeN;

    const w = parseInt(widthStr, 10);
    out.width = isNaN(w) ? null : w;
    const h = parseInt(heightStr, 10);
    out.height = isNaN(h) ? null : h;

    out.aspectRatio = ar || '';
    out.orientation = (orient || '').toUpperCase();

    // Manifest records are self-reported — perceptualHash never present.
    out.perceptualHash = null;

    // Valid if base and ext present and numeric fields parse (size optional)
    out.valid = !!out.baseName && !!out.declaredExt && (out.width !== null && out.height !== null);
    if (!out.valid && !out.error) out.error = 'Malformed fields (size/width/height must be numbers)';
    return out;
  }

  function parseManifest(content) {
    const lines = String(content || '').split(/\r?\n/).map(l => l.trim());
    const records = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue; // skip blank lines
      records.push(parseLine(line, i + 1));
    }
    return records;
  }

  return { parseLine, parseManifest };
})();
