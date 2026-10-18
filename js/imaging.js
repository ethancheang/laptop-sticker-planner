/*
 * imaging.js
 * ----------
 * Pure image-processing helpers used by the sticker scanner.
 * Nothing in here touches the page (no DOM), so it can also be tested in Node.
 *
 * Images are passed around as flat RGBA arrays (the same layout as
 * canvas ImageData.data): for pixel i, R = data[i*4], G = data[i*4+1], ...
 *
 * Masks are flat Uint8Arrays with one entry per pixel:
 *   1 = keep (part of a sticker), 0 = remove (background).
 * An "alpha" array is the same but with values 0..255 for soft edges.
 */
(function (root) {
  'use strict';

  const Img = {};

  /* ------------------------------------------------------------------ *
   * 1. Straightening a photo (perspective correction / homography)
   * ------------------------------------------------------------------ */

  // Solve the linear system A·x = b (A is n×n) with Gaussian elimination.
  function solveLinear(A, b) {
    const n = b.length;
    const M = A.map((row, i) => row.concat([b[i]]));
    for (let col = 0; col < n; col++) {
      // Partial pivoting: pick the row with the largest value in this column.
      let pivot = col;
      for (let r = col + 1; r < n; r++) {
        if (Math.abs(M[r][col]) > Math.abs(M[pivot][col])) pivot = r;
      }
      if (Math.abs(M[pivot][col]) < 1e-12) return null; // degenerate (points on a line)
      [M[col], M[pivot]] = [M[pivot], M[col]];
      for (let r = 0; r < n; r++) {
        if (r === col) continue;
        const f = M[r][col] / M[col][col];
        for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
      }
    }
    return M.map((row, i) => row[n] / row[i]);
  }

  /**
   * Compute the 3×3 homography H that maps each `from[i]` point onto `to[i]`.
   * from/to: arrays of four [x, y] points.
   * Returns an array of 9 numbers (row-major, H[8] = 1), or null.
   */
  Img.computeHomography = function (from, to) {
    const A = [];
    const b = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = from[i];
      const [u, v] = to[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
      b.push(u);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
      b.push(v);
    }
    const h = solveLinear(A, b);
    return h ? h.concat([1]) : null;
  };

  /** Apply homography H to a point. */
  Img.applyHomography = function (H, x, y) {
    const d = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / d, (H[3] * x + H[4] * y + H[5]) / d];
  };

  /**
   * Natural output size for a quad (top-left, top-right, bottom-right,
   * bottom-left): the longer of each pair of opposite sides.
   */
  Img.quadSize = function (quad) {
    const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const w = Math.max(dist(quad[0], quad[1]), dist(quad[3], quad[2]));
    const h = Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2]));
    return { w, h };
  };

  /**
   * Warp the area inside `quad` (in the source image) onto a straight
   * outW × outH rectangle. Uses bilinear sampling.
   * Returns a new Uint8ClampedArray of RGBA pixels.
   */
  Img.warpPerspective = function (src, sw, sh, quad, outW, outH) {
    const out = new Uint8ClampedArray(outW * outH * 4);
    const rect = [[0, 0], [outW, 0], [outW, outH], [0, outH]];
    // Map from the output rectangle back into the source photo.
    const H = Img.computeHomography(rect, quad);
    if (!H) return out;
    const maxX = sw - 1;
    const maxY = sh - 1;
    let o = 0;
    for (let y = 0; y < outH; y++) {
      const py = y + 0.5;
      for (let x = 0; x < outW; x++) {
        const px = x + 0.5;
        const d = H[6] * px + H[7] * py + H[8];
        let sx = (H[0] * px + H[1] * py + H[2]) / d - 0.5;
        let sy = (H[3] * px + H[4] * py + H[5]) / d - 0.5;
        if (sx < 0) sx = 0; else if (sx > maxX) sx = maxX;
        if (sy < 0) sy = 0; else if (sy > maxY) sy = maxY;
        const x0 = sx | 0;
        const y0 = sy | 0;
        const x1 = x0 < maxX ? x0 + 1 : x0;
        const y1 = y0 < maxY ? y0 + 1 : y0;
        const fx = sx - x0;
        const fy = sy - y0;
        const i00 = (y0 * sw + x0) * 4;
        const i10 = (y0 * sw + x1) * 4;
        const i01 = (y1 * sw + x0) * 4;
        const i11 = (y1 * sw + x1) * 4;
        for (let c = 0; c < 4; c++) {
          const top = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * fx;
          const bot = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * fx;
          out[o + c] = top + (bot - top) * fy;
        }
        o += 4;
      }
    }
    return out;
  };

  /* ------------------------------------------------------------------ *
   * 2. Colour maths
   * ------------------------------------------------------------------ */

  // sRGB value (0..255) -> linear light, precomputed for speed.
  const SRGB_TO_LINEAR = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }

  function labF(t) {
    return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  }

  /**
   * Convert RGBA pixels to CIE Lab (3 floats per pixel).
   * Lab is used because distances in Lab roughly match how different
   * two colours look to a person, which makes the tolerance slider
   * behave more predictably than raw RGB.
   */
  Img.toLab = function (rgba, n) {
    const lab = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const r = SRGB_TO_LINEAR[rgba[i * 4]];
      const g = SRGB_TO_LINEAR[rgba[i * 4 + 1]];
      const b = SRGB_TO_LINEAR[rgba[i * 4 + 2]];
      const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
      const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
      const fx = labF(X);
      const fy = labF(Y);
      const fz = labF(Z);
      lab[i * 3] = 116 * fy - 16;
      lab[i * 3 + 1] = 500 * (fx - fy);
      lab[i * 3 + 2] = 200 * (fy - fz);
    }
    return lab;
  };

  function dist2(lab, i, L, a, b) {
    const dL = lab[i * 3] - L;
    const da = lab[i * 3 + 1] - a;
    const db = lab[i * 3 + 2] - b;
    return dL * dL + da * da + db * db;
  }

  /* ------------------------------------------------------------------ *
   * 3. Automatic background removal
   * ------------------------------------------------------------------ */

  /**
   * Look at the pixels around the edge of the photo (which are almost
   * always background) and group them into up to `k` typical colours
   * using k-means. Rare colours (e.g. a sticker touching the edge) are dropped.
   */
  Img.borderColors = function (lab, w, h, k) {
    k = k || 3;
    const band = Math.max(2, Math.round(Math.min(w, h) * 0.01));
    const idx = [];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x < band || y < band || x >= w - band || y >= h - band) idx.push(y * w + x);
      }
    }
    // Keep at most ~3000 samples so this stays fast.
    const step = Math.max(1, Math.floor(idx.length / 3000));
    const samples = [];
    for (let i = 0; i < idx.length; i += step) {
      const p = idx[i];
      samples.push([lab[p * 3], lab[p * 3 + 1], lab[p * 3 + 2]]);
    }
    if (samples.length === 0) return [[100, 0, 0]];

    // Farthest-point initialisation, then a few k-means rounds.
    const centers = [samples[Math.floor(samples.length / 2)].slice()];
    while (centers.length < k) {
      let best = -1;
      let bestD = -1;
      for (let s = 0; s < samples.length; s++) {
        let dMin = Infinity;
        for (const c of centers) {
          const d = (samples[s][0] - c[0]) ** 2 + (samples[s][1] - c[1]) ** 2 + (samples[s][2] - c[2]) ** 2;
          if (d < dMin) dMin = d;
        }
        if (dMin > bestD) { bestD = dMin; best = s; }
      }
      if (bestD < 4) break; // border is basically one colour
      centers.push(samples[best].slice());
    }
    let counts = new Array(centers.length).fill(0);
    for (let iter = 0; iter < 10; iter++) {
      const sums = centers.map(() => [0, 0, 0]);
      counts = new Array(centers.length).fill(0);
      for (const s of samples) {
        let best = 0;
        let bestD = Infinity;
        for (let c = 0; c < centers.length; c++) {
          const d = (s[0] - centers[c][0]) ** 2 + (s[1] - centers[c][1]) ** 2 + (s[2] - centers[c][2]) ** 2;
          if (d < bestD) { bestD = d; best = c; }
        }
        sums[best][0] += s[0]; sums[best][1] += s[1]; sums[best][2] += s[2];
        counts[best]++;
      }
      for (let c = 0; c < centers.length; c++) {
        if (counts[c] > 0) centers[c] = [sums[c][0] / counts[c], sums[c][1] / counts[c], sums[c][2] / counts[c]];
      }
    }
    const total = samples.length;
    let kept = centers.filter((c, i) => counts[i] >= total * 0.08);
    if (kept.length === 0) {
      const biggest = counts.indexOf(Math.max(...counts));
      kept = [centers[biggest]];
    }
    return kept;
  };

  /**
   * For every pixel, the squared colour distance to the closest
   * background colour. Computed once per photo and reused while the
   * tolerance slider moves.
   */
  Img.bgDistance = function (lab, n, colors) {
    const nearBg = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      for (const c of colors) {
        const d = dist2(lab, i, c[0], c[1], c[2]);
        if (d < best) best = d;
      }
      nearBg[i] = best;
    }
    return nearBg;
  };

  /**
   * Flood-fill the background inwards from the photo's edges.
   * A pixel counts as background if its colour is within `tol` of one of
   * the background colours. To follow soft shadows and uneven lighting,
   * a pixel may also join if it is very close to the neighbour it was
   * reached from and still within 1.8×tol of a background colour.
   *
   * nearBg: result of Img.bgDistance().
   * Returns a mask: 1 = sticker (keep), 0 = background.
   */
  Img.autoForeground = function (lab, w, h, nearBg, tol) {
    const n = w * h;
    const t2 = tol * tol;
    const loose2 = (tol * 1.8) * (tol * 1.8);
    const local2 = (tol * 0.35) * (tol * 0.35);

    const bg = new Uint8Array(n);
    const queue = new Int32Array(n);
    let head = 0;
    let tail = 0;
    const seed = (i) => {
      if (!bg[i] && nearBg[i] < t2) { bg[i] = 1; queue[tail++] = i; }
    };
    for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }

    const tryJoin = (p, q) => {
      if (bg[q]) return;
      const d = nearBg[q];
      if (d < t2) { bg[q] = 1; queue[tail++] = q; return; }
      if (d < loose2) {
        const dL = lab[p * 3] - lab[q * 3];
        const da = lab[p * 3 + 1] - lab[q * 3 + 1];
        const db = lab[p * 3 + 2] - lab[q * 3 + 2];
        if (dL * dL + da * da + db * db < local2) { bg[q] = 1; queue[tail++] = q; }
      }
    };
    while (head < tail) {
      const p = queue[head++];
      const x = p % w;
      if (x > 0) tryJoin(p, p - 1);
      if (x < w - 1) tryJoin(p, p + 1);
      if (p >= w) tryJoin(p, p - w);
      if (p < n - w) tryJoin(p, p + w);
    }
    const fg = new Uint8Array(n);
    for (let i = 0; i < n; i++) fg[i] = bg[i] ? 0 : 1;
    return fg;
  };

  /**
   * Magic wand: starting at (sx, sy), collect the connected area whose
   * colour is within `tol` of the clicked colour.
   * Returns an Int32Array of pixel indexes.
   */
  Img.floodRegion = function (lab, w, h, sx, sy, tol) {
    sx = Math.max(0, Math.min(w - 1, Math.round(sx)));
    sy = Math.max(0, Math.min(h - 1, Math.round(sy)));
    // Average a 3×3 patch so a single noisy pixel doesn't decide the colour.
    let L = 0, A = 0, B = 0, cnt = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const x = sx + dx, y = sy + dy;
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        const i = y * w + x;
        L += lab[i * 3]; A += lab[i * 3 + 1]; B += lab[i * 3 + 2]; cnt++;
      }
    }
    L /= cnt; A /= cnt; B /= cnt;
    const t2 = tol * tol;
    const n = w * h;
    const seen = new Uint8Array(n);
    const queue = new Int32Array(n);
    let head = 0, tail = 0;
    const start = sy * w + sx;
    seen[start] = 1;
    queue[tail++] = start;
    while (head < tail) {
      const p = queue[head++];
      const x = p % w;
      const nbrs = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < n - w ? p + w : -1];
      for (const q of nbrs) {
        if (q < 0 || seen[q]) continue;
        if (dist2(lab, q, L, A, B) < t2) { seen[q] = 1; queue[tail++] = q; }
      }
    }
    return queue.slice(0, tail);
  };

  /* ------------------------------------------------------------------ *
   * 4. Mask clean-up
   * ------------------------------------------------------------------ */

  /**
   * Label connected groups of "keep" pixels (8-connected).
   * Returns { labels: Int32Array (0 = background, 1..count), count, areas, boxes }.
   * areas[k] and boxes[k] describe label k (index 0 unused).
   */
  Img.labelComponents = function (mask, w, h) {
    const n = w * h;
    const labels = new Int32Array(n);
    const queue = new Int32Array(n);
    const areas = [0];
    const boxes = [null];
    let count = 0;
    for (let s = 0; s < n; s++) {
      if (!mask[s] || labels[s]) continue;
      count++;
      let head = 0, tail = 0;
      labels[s] = count;
      queue[tail++] = s;
      let minX = w, minY = h, maxX = 0, maxY = 0;
      while (head < tail) {
        const p = queue[head++];
        const x = p % w;
        const y = (p - x) / w;
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const q = yy * w + xx;
            if (mask[q] && !labels[q]) { labels[q] = count; queue[tail++] = q; }
          }
        }
      }
      areas.push(tail);
      boxes.push({ x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
    }
    return { labels, count, areas, boxes };
  };

  /**
   * Remove kept areas smaller than minArea pixels (dust, noise, specks).
   * Areas that contain a pixel in `protect` (non-zero) are never removed.
   * Returns { mask, comps } where comps is the labelling of the result.
   */
  Img.removeSpecks = function (mask, w, h, minArea, protect) {
    const comps = Img.labelComponents(mask, w, h);
    const keep = new Uint8Array(comps.count + 1);
    for (let k = 1; k <= comps.count; k++) keep[k] = comps.areas[k] >= minArea ? 1 : 0;
    if (protect) {
      for (let i = 0; i < mask.length; i++) {
        if (protect[i] > 0 && comps.labels[i]) keep[comps.labels[i]] = 1;
      }
    }
    const out = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) out[i] = keep[comps.labels[i]];
    return out;
  };

  /** Shrink the kept area by r pixels (removes the thin halo of background colour). */
  Img.erode = function (mask, w, h, r) {
    let cur = mask;
    for (let pass = 0; pass < r; pass++) {
      const next = new Uint8Array(cur.length);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (!cur[i]) continue;
          // Alternate cross / square neighbourhoods so repeated passes
          // shrink in a roughly round way.
          let ok = (x > 0 && cur[i - 1]) && (x < w - 1 && cur[i + 1]) &&
                   (y > 0 && cur[i - w]) && (y < h - 1 && cur[i + w]);
          if (ok && pass % 2 === 1) {
            ok = cur[i - w - 1] && cur[i - w + 1] && cur[i + w - 1] && cur[i + w + 1];
          }
          next[i] = ok ? 1 : 0;
        }
      }
      cur = next;
    }
    return cur;
  };

  /**
   * Turn a hard 0/1 mask into soft 0..255 alpha with a box blur of radius r.
   * r = 0 gives hard edges.
   */
  Img.feather = function (mask, w, h, r) {
    const n = w * h;
    const alpha = new Uint8ClampedArray(n);
    if (r <= 0) {
      for (let i = 0; i < n; i++) alpha[i] = mask[i] ? 255 : 0;
      return alpha;
    }
    const tmp = new Float32Array(n);
    const size = 2 * r + 1;
    // Horizontal pass
    for (let y = 0; y < h; y++) {
      let sum = 0;
      const row = y * w;
      for (let x = -r; x <= r; x++) sum += mask[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[row + x] = sum / size;
        const add = Math.min(w - 1, x + r + 1);
        const rem = Math.max(0, x - r);
        sum += mask[row + add] - mask[row + rem];
      }
    }
    // Vertical pass
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        alpha[y * w + x] = Math.round((sum / size) * 255);
        const add = Math.min(h - 1, y + r + 1);
        const rem = Math.max(0, y - r);
        sum += tmp[add * w + x] - tmp[rem * w + x];
      }
    }
    return alpha;
  };

  /**
   * Grow component labels outwards by r pixels into unlabelled pixels.
   * Used so each separated sticker keeps its own soft (feathered) edge.
   */
  Img.dilateLabels = function (labels, w, h, r) {
    let cur = labels;
    for (let pass = 0; pass < r; pass++) {
      const next = cur.slice();
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (cur[i]) continue;
          let l = 0;
          if (x > 0 && cur[i - 1]) l = cur[i - 1];
          else if (x < w - 1 && cur[i + 1]) l = cur[i + 1];
          else if (y > 0 && cur[i - w]) l = cur[i - w];
          else if (y < h - 1 && cur[i + w]) l = cur[i + w];
          next[i] = l;
        }
      }
      cur = next;
    }
    return cur;
  };

  /** Bounding box of pixels whose alpha is above `threshold`, or null if none. */
  Img.alphaBounds = function (alpha, w, h, threshold) {
    threshold = threshold == null ? 8 : threshold;
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (alpha[y * w + x] > threshold) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
  };

  /** Copy a rectangle out of an RGBA image. */
  Img.cropRGBA = function (rgba, w, box) {
    const out = new Uint8ClampedArray(box.w * box.h * 4);
    for (let y = 0; y < box.h; y++) {
      const srcStart = ((box.y + y) * w + box.x) * 4;
      out.set(rgba.subarray(srcStart, srcStart + box.w * 4), y * box.w * 4);
    }
    return out;
  };

  /** Grow a box by `pad` pixels on each side, clamped to the image. */
  Img.padBox = function (box, pad, w, h) {
    const x = Math.max(0, box.x - pad);
    const y = Math.max(0, box.y - pad);
    const x2 = Math.min(w, box.x + box.w + pad);
    const y2 = Math.min(h, box.y + box.h + pad);
    return { x, y, w: x2 - x, h: y2 - y };
  };

  // Export for the browser (window.SL.Img) and for Node tests.
  root.SL = root.SL || {};
  root.SL.Img = Img;
  if (typeof module !== 'undefined' && module.exports) module.exports = Img;
})(typeof window !== 'undefined' ? window : globalThis);
