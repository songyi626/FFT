/*
 * HRTEM FFT Analyzer — 數值核心（瀏覽器與 Node 共用）
 *
 * 處理流程與桌面版 hrtem_fft_analyzer.py 相同：
 *   ROI → 高斯背景扣除 → 窗函數 → 2D FFT → fftshift → |F|、20·log10|F|
 * 差異：背景扣除以三次 box blur 近似 OpenCV 的高斯模糊（只影響 DC 附近的極低頻），
 *       ROI 邊長限制為 2 的冪次（radix-2 FFT）。
 *
 * 座標慣例：FFT 像素索引 (col, row)，中心 c = n/2 對應 k = 0；
 *   kx = (col − c)·Δk，ky = (c − row)·Δk（ky 向上為正），Δk = 1 / (n · nm_per_px)，d = 1/|k|。
 *
 * Copyright (c) 2026 Song-Yi Chan — MIT License
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FFTCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const isPow2 = (n) => n > 0 && (n & (n - 1)) === 0;

  // ---------------- radix-2 FFT ----------------
  const tables = new Map();
  function fftTables(n) {
    let t = tables.get(n);
    if (t) return t;
    const half = n >> 1;
    const cos = new Float64Array(half), sin = new Float64Array(half);
    for (let k = 0; k < half; k++) {
      const a = (-2 * Math.PI * k) / n;
      cos[k] = Math.cos(a);
      sin[k] = Math.sin(a);
    }
    const bits = Math.round(Math.log2(n));
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let x = i, r = 0;
      for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[i] = r;
    }
    t = { cos, sin, rev };
    tables.set(n, t);
    return t;
  }

  function fft1d(re, im, t) {
    const n = re.length, rev = t.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (i < j) {
        let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
        tmp = im[i]; im[i] = im[j]; im[j] = tmp;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1, step = n / len;
      for (let i = 0; i < n; i += len) {
        for (let k = 0, tw = 0; k < half; k++, tw += step) {
          const wr = t.cos[tw], wi = t.sin[tw];
          const a = i + k, b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  /** 實數 n×n 影像的 2D FFT（未 shift）。 */
  function fft2dReal(data, n) {
    if (!isPow2(n)) throw new Error("FFT 邊長必須是 2 的冪次");
    const t = fftTables(n);
    const re = new Float64Array(n * n), im = new Float64Array(n * n);
    const lr = new Float64Array(n), li = new Float64Array(n);
    for (let y = 0; y < n; y++) {
      const o = y * n;
      for (let x = 0; x < n; x++) { lr[x] = data[o + x]; li[x] = 0; }
      fft1d(lr, li, t);
      for (let x = 0; x < n; x++) { re[o + x] = lr[x]; im[o + x] = li[x]; }
    }
    for (let x = 0; x < n; x++) {
      for (let y = 0; y < n; y++) { lr[y] = re[y * n + x]; li[y] = im[y * n + x]; }
      fft1d(lr, li, t);
      for (let y = 0; y < n; y++) { re[y * n + x] = lr[y]; im[y * n + x] = li[y]; }
    }
    return { re, im };
  }

  // ---------------- 背景扣除 ----------------
  /** 與桌面版相同的核大小：min(101, max(3, (n//4)|1)) */
  const bgKernelSize = (n) => Math.min(101, Math.max(3, Math.floor(n / 4) | 1));
  /** OpenCV 在 sigma=0 時由核大小推算的 sigma */
  const cvSigma = (k) => 0.3 * ((k - 1) * 0.5 - 1) + 0.8;

  function reflect101(i, n) {
    if (n === 1) return 0;
    while (i < 0 || i >= n) {
      if (i < 0) i = -i;
      if (i >= n) i = 2 * n - 2 - i;
    }
    return i;
  }

  function boxSizesForGauss(sigma, nb) {
    const wIdeal = Math.sqrt((12 * sigma * sigma) / nb + 1);
    let wl = Math.floor(wIdeal);
    if (wl % 2 === 0) wl--;
    const wu = wl + 2;
    const mIdeal = (12 * sigma * sigma - nb * wl * wl - 4 * nb * wl - 3 * nb) / (-4 * wl - 4);
    const m = Math.round(mIdeal);
    return Array.from({ length: nb }, (_, i) => (i < m ? wl : wu));
  }

  function boxBlur1D(src, dst, n, r, horizontal) {
    const inv = 1 / (2 * r + 1);
    for (let line = 0; line < n; line++) {
      const base = horizontal ? line * n : line;
      const st = horizontal ? 1 : n;
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[base + reflect101(k, n) * st];
      for (let i = 0; i < n; i++) {
        dst[base + i * st] = sum * inv;
        sum += src[base + reflect101(i + r + 1, n) * st] - src[base + reflect101(i - r, n) * st];
      }
    }
  }

  /** 三次 box blur 近似高斯模糊（邊界 reflect-101，同 OpenCV 預設）。 */
  function gaussianBlurApprox(src, n, sigma) {
    let a = Float64Array.from(src), b = new Float64Array(n * n);
    for (const s of boxSizesForGauss(sigma, 3)) {
      const r = (s - 1) >> 1;
      if (r <= 0) continue;
      boxBlur1D(a, b, n, r, true);
      boxBlur1D(b, a, n, r, false);
    }
    return a;
  }

  // ---------------- 窗函數 ----------------
  function windowVec(type, n) {
    if (type === "None") return null;
    const a0 = type === "Hamming" ? 0.54 : 0.5, a1 = 1 - a0;
    const w = new Float64Array(n);
    if (n === 1) { w[0] = 1; return w; }
    for (let i = 0; i < n; i++) w[i] = a0 - a1 * Math.cos((2 * Math.PI * i) / (n - 1));
    return w;
  }

  /**
   * 計算 diffractogram。
   * @param {Float64Array} roi n×n 灰階（row-major）
   * @param {{window?: string, background?: boolean}} opts
   * @returns {{n, magLin: Float32Array, magDb: Float32Array, sorted: Float32Array}}
   */
  function computeDiffractogram(roi, n, opts) {
    opts = opts || {};
    let proc;
    if (opts.background !== false) {
      const bg = gaussianBlurApprox(roi, n, cvSigma(bgKernelSize(n)));
      proc = new Float64Array(n * n);
      for (let i = 0; i < n * n; i++) proc[i] = roi[i] - bg[i];
    } else {
      proc = Float64Array.from(roi);
    }
    const w = windowVec(opts.window || "Hanning", n);
    if (w) {
      for (let y = 0; y < n; y++) {
        const o = y * n, wy = w[y];
        for (let x = 0; x < n; x++) proc[o + x] *= wy * w[x];
      }
    }
    const { re, im } = fft2dReal(proc, n);
    const c = n >> 1;
    const magLin = new Float32Array(n * n), magDb = new Float32Array(n * n);
    for (let y = 0; y < n; y++) {
      const o = y * n, dy = ((y + c) % n) * n;
      for (let x = 0; x < n; x++) {
        const a = re[o + x], b = im[o + x];
        const v = Math.sqrt(a * a + b * b);
        const d = dy + ((x + c) % n);
        magLin[d] = v;
        magDb[d] = 20 * Math.log10(v + 1e-6);
      }
    }
    const sorted = Float32Array.from(magDb).sort();
    return { n, magLin, magDb, sorted };
  }

  /** 與 numpy.percentile（linear）相同的定義；sorted 須已遞增排序。 */
  function percentile(sorted, p) {
    const N = sorted.length;
    if (N === 0) return NaN;
    const pos = (Math.min(100, Math.max(0, p)) / 100) * (N - 1);
    const lo = Math.floor(pos), hi = Math.min(N - 1, lo + 1);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  /** 在半徑 r 內找最大值，再以 log 強度三點拋物線做次像素內插。 */
  function refinePeak(magLin, n, col, row, r) {
    const c0 = Math.round(col), r0 = Math.round(row);
    const xa = Math.max(c0 - r, 1), xb = Math.min(c0 + r, n - 2);
    const ya = Math.max(r0 - r, 1), yb = Math.min(r0 + r, n - 2);
    if (xa > xb || ya > yb) return [col, row];
    let best = -Infinity, px = xa, py = ya;
    for (let y = ya; y <= yb; y++) {
      for (let x = xa; x <= xb; x++) {
        const v = magLin[y * n + x];
        if (v > best) { best = v; px = x; py = y; }
      }
    }
    const L = (x, y) => Math.log(magLin[y * n + x] + 1e-12);
    const para = (a, b, c) => {
      const den = a - 2 * b + c;
      return den === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den));
    };
    const dx = para(L(px - 1, py), L(px, py), L(px + 1, py));
    const dy = para(L(px, py - 1), L(px, py), L(px, py + 1));
    return [px + dx, py + dy];
  }

  /** 由 FFT 像素索引計算 kx, ky, |k|, d, 方位角(°) */
  function spotValues(col, row, n, df) {
    const c = n >> 1;
    const kx = (col - c) * df, ky = (c - row) * df;
    const k = Math.hypot(kx, ky);
    return { kx, ky, k, d: 1 / k, ang: (Math.atan2(ky, kx) * 180) / Math.PI };
  }

  /** 兩個 k 向量的夾角（°） */
  function angleBetween(a, b) {
    const cos = (a.kx * b.kx + a.ky * b.ky) / (a.k * b.k);
    return (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
  }

  /** dB 值套用色盤寫入 RGBA（與 matplotlib 256 色離散化相同） */
  function applyColormap(magDb, vmin, vmax, lut, out) {
    const span = vmax - vmin || 1e-12, s = 256 / span;
    for (let i = 0, j = 0; i < magDb.length; i++, j += 4) {
      let idx = Math.floor((magDb[i] - vmin) * s);
      idx = idx < 0 ? 0 : idx > 255 ? 255 : idx;
      const l = idx * 3;
      out[j] = lut[l]; out[j + 1] = lut[l + 1]; out[j + 2] = lut[l + 2]; out[j + 3] = 255;
    }
    return out;
  }

  return {
    isPow2, fft2dReal, computeDiffractogram, gaussianBlurApprox, bgKernelSize, cvSigma,
    windowVec, percentile, refinePeak, spotValues, angleBetween, applyColormap,
  };
});
