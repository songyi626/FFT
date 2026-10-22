/*
 * HRTEM FFT Analyzer — 網頁介面
 * Copyright (c) 2026 Song-Yi Chan — MIT License
 */
(() => {
  "use strict";

  const Core = window.FFTCore;
  const CMAPS = window.FFTColormaps;
  const $ = (id) => document.getElementById(id);
  const MAX_FFT = 2048;
  const MIN_FFT = 64;

  const state = {
    img: null,          // {w, h, data: Float64Array, name, info}
    nmpx: null,         // nm / pixel，null = 未校正
    roiSize: 0,
    roiCenter: null,    // 影像連續座標（像素邊界為整數）
    roi: null,          // {x0, y0, n}
    fft: null,          // {n, magLin, magDb, sorted}
    df: 1,
    spots: [],          // [{col, row}]：FFT 像素索引
    selected: [],       // 勾選比較的 spot 索引（最多 2）
    scaleMode: false,
    scalePts: [],
    hoverFFT: null,
  };

  // ======================================================================
  // 可縮放、平移的影像視窗
  // ======================================================================
  class Viewer {
    constructor(canvas, opts) {
      this.cv = canvas;
      this.ctx = canvas.getContext("2d");
      this.opts = opts;
      this.src = null;
      this.scale = 1; this.ox = 0; this.oy = 0;
      this.fitted = true;
      this.down = null;
      new ResizeObserver(() => this.resize()).observe(canvas);
      canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
      canvas.addEventListener("pointerdown", (e) => this.onDown(e));
      canvas.addEventListener("pointermove", (e) => this.onMove(e));
      canvas.addEventListener("pointerup", (e) => this.onUp(e));
      canvas.addEventListener("pointercancel", () => { this.down = null; });
      canvas.addEventListener("pointerleave", () => { if (!this.down && opts.onLeave) opts.onLeave(); });
      canvas.addEventListener("contextmenu", (e) => e.preventDefault());
      canvas.addEventListener("dblclick", () => this.fit());
      canvas.addEventListener("keydown", (e) => this.onKey(e));
      this.resize();
    }

    resize() {
      const r = this.cv.getBoundingClientRect();
      this.cw = Math.max(1, r.width);
      this.ch = Math.max(1, r.height);
      this.dpr = window.devicePixelRatio || 1;
      this.cv.width = Math.round(this.cw * this.dpr);
      this.cv.height = Math.round(this.ch * this.dpr);
      if (this.src && this.fitted) this.fit(); else this.draw();
    }

    setImage(src, keepView) {
      const same = this.src && src && this.src.width === src.width && this.src.height === src.height;
      this.src = src;
      if (keepView && same) this.draw(); else this.fit();
    }

    fitScale() { return this.src ? Math.min(this.cw / this.src.width, this.ch / this.src.height) : 1; }

    fit() {
      if (this.src) {
        this.scale = this.fitScale();
        this.ox = (this.src.width - this.cw / this.scale) / 2;
        this.oy = (this.src.height - this.ch / this.scale) / 2;
      }
      this.fitted = true;
      this.draw();
    }

    zoomAt(sx, sy, factor) {
      if (!this.src) return;
      const fs = this.fitScale();
      const ns = Math.min(Math.max(fs * 0.5, this.scale * factor), Math.max(fs, 48));
      const u = this.ox + sx / this.scale, v = this.oy + sy / this.scale;
      this.scale = ns;
      this.ox = u - sx / ns; this.oy = v - sy / ns;
      this.fitted = false;
      this.draw();
    }

    toImg(e) {
      const r = this.cv.getBoundingClientRect();
      const sx = e.clientX - r.left, sy = e.clientY - r.top;
      return { u: this.ox + sx / this.scale, v: this.oy + sy / this.scale, sx, sy };
    }

    toScr(u, v) { return [(u - this.ox) * this.scale, (v - this.oy) * this.scale]; }

    onWheel(e) {
      if (!this.src) return;
      e.preventDefault();
      const p = this.toImg(e);
      this.zoomAt(p.sx, p.sy, Math.exp(-e.deltaY * 0.0015));
    }

    onKey(e) {
      if (!this.src) return;
      const step = 40 / this.scale;
      const keys = {
        "+": () => this.zoomAt(this.cw / 2, this.ch / 2, 1.25),
        "=": () => this.zoomAt(this.cw / 2, this.ch / 2, 1.25),
        "-": () => this.zoomAt(this.cw / 2, this.ch / 2, 0.8),
        "0": () => this.fit(),
        ArrowLeft: () => { this.ox -= step; },
        ArrowRight: () => { this.ox += step; },
        ArrowUp: () => { this.oy -= step; },
        ArrowDown: () => { this.oy += step; },
      };
      if (keys[e.key]) {
        e.preventDefault();
        keys[e.key]();
        if (e.key.startsWith("Arrow")) { this.fitted = false; this.draw(); }
      }
    }

    onDown(e) {
      if (!this.src) return;
      this.cv.setPointerCapture(e.pointerId);
      this.down = { x: e.clientX, y: e.clientY, ox: this.ox, oy: this.oy, button: e.button, panned: false };
    }

    onMove(e) {
      const d = this.down;
      if (d) {
        const dx = e.clientX - d.x, dy = e.clientY - d.y;
        if (!d.panned && Math.hypot(dx, dy) > 4) { d.panned = true; this.cv.style.cursor = "grabbing"; }
        if (d.panned) {
          this.ox = d.ox - dx / this.scale;
          this.oy = d.oy - dy / this.scale;
          this.fitted = false;
          this.draw();
        }
      }
      if (this.src && this.opts.onHover) this.opts.onHover(this.toImg(e));
    }

    onUp(e) {
      const d = this.down;
      this.down = null;
      this.cv.style.cursor = "";
      if (d && !d.panned && this.opts.onClick) this.opts.onClick(this.toImg(e), d.button);
    }

    draw() {
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.cv.width, this.cv.height);
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      if (!this.src) {
        if (this.opts.drawEmpty) this.opts.drawEmpty(ctx, this.cw, this.ch);
        return;
      }
      const w = this.src.width, h = this.src.height;
      const u0 = Math.max(0, this.ox), v0 = Math.max(0, this.oy);
      const u1 = Math.min(w, this.ox + this.cw / this.scale), v1 = Math.min(h, this.oy + this.ch / this.scale);
      ctx.imageSmoothingEnabled = this.opts.smooth !== false && this.scale < 1;
      ctx.imageSmoothingQuality = "high";
      if (u1 > u0 && v1 > v0) {
        ctx.drawImage(this.src, u0, v0, u1 - u0, v1 - v0,
          (u0 - this.ox) * this.scale, (v0 - this.oy) * this.scale,
          (u1 - u0) * this.scale, (v1 - v0) * this.scale);
      }
      if (this.opts.drawOverlay) this.opts.drawOverlay(ctx, this);
    }
  }

  const drawEmpty = (text) => (ctx, w, h) => {
    ctx.fillStyle = "#6f808d";
    ctx.font = '500 15px "Noto Sans TC", system-ui, sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, w / 2, h / 2);
  };

  const realSrc = document.createElement("canvas");
  const fftSrc = document.createElement("canvas");

  const realView = new Viewer($("cvReal"), {
    drawEmpty: drawEmpty("選擇影像，或載入示範影像"),
    drawOverlay: drawRealOverlay,
    onClick: onClickReal,
    onHover: onHoverReal,
    onLeave: () => { $("roReal").innerHTML = "&nbsp;"; },
  });
  const fftView = new Viewer($("cvFFT"), {
    drawEmpty: drawEmpty("FFT 會顯示在這裡"),
    smooth: false, // 縮小顯示時不平均，避免單像素亮點被抹掉
    drawOverlay: drawFFTOverlay,
    onClick: onClickFFT,
    onHover: onHoverFFT,
    onLeave: () => { state.hoverFFT = null; $("roFFT").innerHTML = "&nbsp;"; },
  });
  const viewers = { real: realView, fft: fftView };

  // ======================================================================
  // 狀態顯示
  // ======================================================================
  let busyCount = 0;
  function busy(on, text) {
    busyCount += on ? 1 : -1;
    if (text) $("busyText").textContent = text;
    $("busy").hidden = busyCount <= 0;
  }
  const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

  function fmt(v, d) { return Number.isFinite(v) ? v.toFixed(d) : "—"; }

  // ======================================================================
  // 載入影像
  // ======================================================================
  function toGray(bands, n) {
    if (bands.length === 1) return Float64Array.from(bands[0]);
    const g = new Float64Array(n), r = bands[0], gg = bands[1], b = bands[2];
    for (let i = 0; i < n; i++) g[i] = 0.299 * r[i] + 0.587 * gg[i] + 0.114 * b[i];
    return g;
  }

  function rational(v) {
    if (v == null) return null;
    if (typeof v === "number") return v;
    if (v.length >= 2 && v[1]) return v[0] / v[1];
    if (v.length === 1) return v[0];
    return null;
  }

  /** ImageJ / Fiji 匯出的 TIFF：ImageDescription 含 unit=，XResolution = 每單位像素數 */
  function imagejCalibration(fd) {
    const desc = fd.ImageDescription;
    const xres = rational(fd.XResolution);
    if (!desc || !xres || !/ImageJ=/.test(desc)) return null;
    const m = /unit=([^\n\r]+)/.exec(desc);
    if (!m) return null;
    const unit = m[1].trim().replace(/\\u00B5/g, "µ").toLowerCase();
    const factor = { nm: 1, nanometer: 1, "µm": 1000, um: 1000, micron: 1000, microns: 1000, "å": 0.1, a: 0.1, angstrom: 0.1, pm: 0.001 }[unit];
    return factor ? factor / xres : null;
  }

  async function readTiff(buf) {
    if (!window.GeoTIFF) throw new Error("TIFF 解碼程式庫沒有載入，請確認網路連線後重新整理頁面");
    const tiff = await GeoTIFF.fromArrayBuffer(buf);
    const image = await tiff.getImage();
    const w = image.getWidth(), h = image.getHeight();
    const rasters = await image.readRasters();
    const bands = Array.from({ length: Math.min(rasters.length, 3) }, (_, i) => rasters[i]);
    const bps = image.getBitsPerSample ? image.getBitsPerSample() : (image.fileDirectory.BitsPerSample || [8])[0];
    let cal = null;
    try { cal = imagejCalibration(image.fileDirectory); } catch (_) { /* 沒有可用的校正資訊 */ }
    return { w, h, data: toGray(bands, w * h), info: `${w}×${h}，${bps}-bit TIFF`, cal };
  }

  async function readBitmap(file) {
    const bmp = await createImageBitmap(file);
    const c = document.createElement("canvas");
    c.width = bmp.width; c.height = bmp.height;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    const n = c.width * c.height, g = new Float64Array(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) g[i] = 0.299 * px[j] + 0.587 * px[j + 1] + 0.114 * px[j + 2];
    return { w: c.width, h: c.height, data: g, info: `${c.width}×${c.height}，8-bit`, cal: null };
  }

  async function loadFile(file) {
    busy(true, "讀取影像中…");
    await nextFrame();
    try {
      const isTiff = /\.tiff?$/i.test(file.name) || file.type === "image/tiff";
      const img = isTiff ? await readTiff(await file.arrayBuffer()) : await readBitmap(file);
      img.name = file.name;
      await setImage(img);
    } catch (err) {
      console.error(err);
      setFileInfo(`無法讀取「${file.name}」：${err.message || err}`, "warn");
    } finally {
      busy(false);
    }
  }

  const DEMO = { nm: 0.02, d0: 0.583, deg: 17 };

  function makeDemo() {
    // 已知的立方晶格投影：角落與體心兩種原子柱，a = 0.583 nm，旋轉 17°，0.02 nm/px。
    // 以傅立葉級數合成（含 (100)、(110)、(200)… 反射），再加雜訊與低頻背景。
    const W = 1280, H = 1024, { nm, d0, deg } = DEMO, th = (deg * Math.PI) / 180;
    const a1 = [Math.cos(th) / d0, Math.sin(th) / d0];
    const a2 = [-Math.sin(th) / d0, Math.cos(th) / d0];
    const terms = [];
    for (let h = 0; h <= 3; h++) {
      for (let k = -3; k <= 3; k++) {
        if (h === 0 && k <= 0) continue; // 只取半平面，cos 已含 ±g
        const gx = h * a1[0] + k * a2[0], gy = h * a1[1] + k * a2[1];
        const g2 = gx * gx + gy * gy;
        const F = 1 + 0.55 * ((h + k) % 2 === 0 ? 1 : -1);   // 兩種原子柱的結構因子
        const A = F * Math.exp(-0.9 * g2 * d0 * d0 / 4);      // 原子柱寬度造成的衰減
        if (A > 0.02) terms.push([gx, gy, A]);
      }
    }
    const data = new Float64Array(W * H);
    let seed = 20261022;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
    for (let y = 0; y < H; y++) {
      const Y = y * nm;
      for (let x = 0; x < W; x++) {
        const X = x * nm;
        let v = 0;
        for (const [gx, gy, A] of terms) v += A * Math.cos(2 * Math.PI * (gx * X - gy * Y));
        const bg = 1.2 * Math.exp(-((X - 10) ** 2 + (Y - 8) ** 2) / 120);
        data[y * W + x] = v + bg + 0.45 * gauss();
      }
    }
    return {
      w: W, h: H, data, name: "示範影像（合成晶格）", cal: nm, isDemo: true,
      info: `${W}×${H}，a = ${d0} nm、旋轉 ${deg}°，nm/pixel 已設為 ${nm}`,
    };
  }

  function setFileInfo(text, cls) {
    const el = $("fileInfo");
    el.textContent = text;
    el.className = "note" + (cls ? " " + cls : "");
  }

  async function setImage(img) {
    state.img = img;
    state.spots = []; state.selected = [];
    cancelScaleMode();

    // 實空間顯示（0.5–99.5 百分位拉伸）
    const sorted = Float32Array.from(img.data).sort();
    const lo = Core.percentile(sorted, 0.5), hi = Core.percentile(sorted, 99.5);
    const span = hi - lo || 1;
    realSrc.width = img.w; realSrc.height = img.h;
    const rctx = realSrc.getContext("2d");
    const id = rctx.createImageData(img.w, img.h);
    for (let i = 0, j = 0; i < img.data.length; i++, j += 4) {
      const v = Math.max(0, Math.min(255, ((img.data[i] - lo) / span) * 255));
      id.data[j] = id.data[j + 1] = id.data[j + 2] = v; id.data[j + 3] = 255;
    }
    rctx.putImageData(id, 0, 0);
    realView.setImage(realSrc, false);

    // ROI 選項
    const m = Math.min(img.w, img.h);
    const sizes = [];
    for (let s = MIN_FFT; s <= Math.min(m, MAX_FFT); s *= 2) sizes.push(s);
    const sel = $("roiSize");
    sel.innerHTML = "";
    if (!sizes.length) {
      setFileInfo(`影像太小（${img.w}×${img.h}），至少需要 ${MIN_FFT}×${MIN_FFT} 像素。`, "warn");
      return;
    }
    for (const s of sizes) sel.add(new Option(`${s} × ${s}`, s));
    state.roiSize = sizes[sizes.length - 1];
    sel.value = String(state.roiSize);
    state.roiCenter = { x: img.w / 2, y: img.h / 2 };

    let info = `${img.name}：${img.info}`;
    let cls = "";
    if (img.cal) {
      $("nmpx").value = +img.cal.toPrecision(6);
      state.nmpx = img.cal;
      if (!img.isDemo) info += `。已從 TIFF 讀到 ${+img.cal.toPrecision(6)} nm/pixel，請確認。`;
      cls = "ok";
    } else if (state.nmpx) {
      info += `。沿用前一張的 ${+state.nmpx.toPrecision(6)} nm/pixel，請確認是否相同。`;
      cls = "warn";
    }
    setFileInfo(info, cls);
    for (const id2 of ["roiSize", "btnCenter", "btnScale"]) $(id2).disabled = false;
    updateCalInfo();
    await updateROI();
  }

  // ======================================================================
  // ROI 與 FFT
  // ======================================================================
  async function updateROI() {
    const { w, h } = state.img;
    const n = Math.min(state.roiSize, w, h);
    let x0 = Math.round(state.roiCenter.x - n / 2);
    let y0 = Math.round(state.roiCenter.y - n / 2);
    x0 = Math.min(Math.max(x0, 0), w - n);
    y0 = Math.min(Math.max(y0, 0), h - n);
    state.roi = { x0, y0, n };
    $("roiInfo").textContent = `ROI ${n}×${n}，位置 (${x0}, ${y0})`;
    state.spots = []; state.selected = [];
    realView.draw();
    await computeFFT(false);
  }

  let fftJob = 0;
  async function computeFFT(keepSpots) {
    if (!state.roi) return;
    const job = ++fftJob;
    const { x0, y0, n } = state.roi;
    busy(true, `計算 ${n}×${n} FFT…`);
    await nextFrame();
    try {
      const { w, data } = state.img;
      const roi = new Float64Array(n * n);
      for (let y = 0; y < n; y++) roi.set(data.subarray((y0 + y) * w + x0, (y0 + y) * w + x0 + n), y * n);
      const res = Core.computeDiffractogram(roi, n, { window: $("window").value });
      if (job !== fftJob) return;
      const sameSize = state.fft && state.fft.n === n;
      state.fft = res;
      if (!keepSpots || !sameSize) { state.spots = []; state.selected = []; }
      updateDf();
      renderFFT(keepSpots && sameSize);
      for (const id of ["btnPNG", "btnPNGm", "btnROI"]) $(id).disabled = false;
    } finally {
      busy(false);
    }
  }

  function updateDf() {
    if (!state.fft) return;
    state.df = 1 / (state.fft.n * (state.nmpx || 1));
    const u = state.nmpx ? "nm⁻¹" : "px⁻¹";
    $("fftInfo").textContent = `Δk = ${+state.df.toPrecision(4)} ${u}`;
  }

  function clim() {
    let pmin = parseFloat($("pmin").value), pmax = parseFloat($("pmax").value);
    if (!Number.isFinite(pmin)) pmin = 2;
    if (!Number.isFinite(pmax)) pmax = 99.8;
    let vmin = Core.percentile(state.fft.sorted, pmin), vmax = Core.percentile(state.fft.sorted, pmax);
    if (!(vmax > vmin)) vmax = vmin + 1e-6;
    return [vmin, vmax];
  }

  let fftImageData = null;
  function renderFFT(keepView) {
    const f = state.fft;
    if (!f) return;
    if (fftSrc.width !== f.n) { fftSrc.width = f.n; fftSrc.height = f.n; fftImageData = null; }
    const ctx = fftSrc.getContext("2d");
    if (!fftImageData) fftImageData = ctx.createImageData(f.n, f.n);
    const [vmin, vmax] = clim();
    Core.applyColormap(f.magDb, vmin, vmax, CMAPS[$("cmap").value], fftImageData.data);
    ctx.putImageData(fftImageData, 0, 0);
    fftView.setImage(fftSrc, keepView);
    renderTable();
  }

  let rafPending = false;
  function scheduleRender() {
    if (rafPending || !state.fft) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; renderFFT(true); });
  }

  // ======================================================================
  // 疊圖
  // ======================================================================
  function drawRealOverlay(ctx, v) {
    if (state.roi) {
      const { x0, y0, n } = state.roi;
      const [sx, sy] = v.toScr(x0, y0);
      ctx.strokeStyle = "#4ee3f2"; ctx.lineWidth = 1.5;
      ctx.strokeRect(sx, sy, n * v.scale, n * v.scale);
    }
    if (state.scalePts.length) {
      ctx.strokeStyle = "#b8ff6a"; ctx.lineWidth = 2;
      const pts = state.scalePts.map((p) => v.toScr(p.u, p.v));
      for (const [x, y] of pts) {
        ctx.beginPath(); ctx.moveTo(x - 8, y); ctx.lineTo(x + 8, y); ctx.moveTo(x, y - 8); ctx.lineTo(x, y + 8); ctx.stroke();
      }
      if (pts.length === 2) {
        ctx.beginPath(); ctx.moveTo(pts[0][0], pts[0][1]); ctx.lineTo(pts[1][0], pts[1][1]); ctx.stroke();
      }
    }
  }

  function niceNumber(x) {
    const e = Math.floor(Math.log10(x)), f = x / 10 ** e;
    const nf = f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10;
    return nf * 10 ** e;
  }

  function drawFFTOverlay(ctx, v) {
    if (!state.fft) return;
    const n = state.fft.n, c = n / 2;
    ctx.font = '700 13px "Noto Sans TC", system-ui, sans-serif';
    ctx.textBaseline = "bottom";
    state.spots.forEach((s, i) => {
      const [x, y] = v.toScr(s.col + 0.5, s.row + 0.5);
      const [mx, my] = v.toScr(2 * c - s.col + 0.5, 2 * c - s.row + 0.5);
      const sel = state.selected.includes(i);
      ctx.lineWidth = sel ? 2.5 : 1.6;
      ctx.strokeStyle = sel ? "#ffffff" : "#4ee3f2";
      ctx.beginPath(); ctx.arc(x, y, 8, 0, 2 * Math.PI); ctx.stroke();
      ctx.globalAlpha = 0.45; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(mx, my, 8, 0, 2 * Math.PI); ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = sel ? "#ffffff" : "#4ee3f2";
      ctx.fillText(String(i + 1), x + 9, y - 6);
    });

    // 比例尺（以 k 表示）
    const visK = (v.cw / v.scale) * state.df;
    const len = niceNumber(visK / 5), px = (len / state.df) * v.scale;
    const unit = state.nmpx ? "nm⁻¹" : "px⁻¹";
    const x0 = 14, y0 = v.ch - 16;
    ctx.fillStyle = "rgba(12,17,21,0.6)";
    ctx.fillRect(x0 - 8, y0 - 30, px + 16, 40);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(x0, y0 - 3, px, 4);
    ctx.font = '500 12px "Noto Sans TC", system-ui, sans-serif';
    ctx.fillText(`${+len.toPrecision(3)} ${unit}`, x0, y0 - 8);
  }

  // ======================================================================
  // 滑鼠
  // ======================================================================
  function onHoverReal(p) {
    if (!state.img) return;
    const x = p.u - 0.5, y = p.v - 0.5;
    if (x < -0.5 || y < -0.5 || x > state.img.w - 0.5 || y > state.img.h - 0.5) { $("roReal").innerHTML = "&nbsp;"; return; }
    let t = `x = ${fmt(x, 1)} px，y = ${fmt(y, 1)} px`;
    if (state.nmpx) t += `（${fmt(x * state.nmpx, 2)} nm，${fmt(y * state.nmpx, 2)} nm）`;
    if (state.scaleMode) t = (state.scalePts.length ? "點擊比例尺的另一端。" : "點擊比例尺的一端。") + "　" + t;
    $("roReal").textContent = t;
  }

  function onClickReal(p, button) {
    if (!state.img || button !== 0) return;
    if (state.scaleMode) {
      state.scalePts.push({ u: p.u, v: p.v });
      realView.draw();
      if (state.scalePts.length === 2) {
        const [a, b] = state.scalePts;
        const dist = Math.hypot(b.u - a.u, b.v - a.v);
        setTimeout(() => finishScale(dist), 30);
      }
      return;
    }
    state.roiCenter = { x: p.u, y: p.v };
    updateROI();
  }

  function onHoverFFT(p) {
    if (!state.fft) return;
    const n = state.fft.n;
    const col = p.u - 0.5, row = p.v - 0.5;
    if (col < -0.5 || row < -0.5 || col > n - 0.5 || row > n - 0.5) { $("roFFT").innerHTML = "&nbsp;"; return; }
    const s = Core.spotValues(col, row, n, state.df);
    const u = state.nmpx ? "nm" : "px";
    $("roFFT").textContent = `kₓ = ${fmt(s.kx, 3)}，kᵧ = ${fmt(s.ky, 3)}，|k| = ${fmt(s.k, 3)} ${u}⁻¹，d = ${s.k > 0 ? fmt(s.d, 4) + " " + u : "∞"}`;
  }

  function onClickFFT(p, button) {
    if (!state.fft) return;
    const n = state.fft.n, c = n / 2;
    if (button === 2) {
      let best = -1, bestD = 14;
      state.spots.forEach((s, i) => {
        const [x, y] = fftView.toScr(s.col + 0.5, s.row + 0.5);
        const d = Math.hypot(x - p.sx, y - p.sy);
        if (d < bestD) { best = i; bestD = d; }
      });
      if (best >= 0) removeSpot(best);
      return;
    }
    if (button !== 0) return;
    let col = p.u - 0.5, row = p.v - 0.5;
    if (col < 0 || row < 0 || col > n - 1 || row > n - 1) return;
    if ($("snap").checked) {
      const r = Math.max(1, Math.min(30, parseInt($("snapR").value, 10) || 6));
      [col, row] = Core.refinePeak(state.fft.magLin, n, col, row, r);
    }
    if (Math.hypot(col - c, row - c) < 1.5) {
      $("roFFT").textContent = "這裡是中心 (k = 0)，請點擊繞射亮點。";
      return;
    }
    state.spots.push({ col, row });
    fftView.draw();
    renderTable();
  }

  function removeSpot(i) {
    state.spots.splice(i, 1);
    state.selected = state.selected.filter((j) => j !== i).map((j) => (j > i ? j - 1 : j));
    fftView.draw();
    renderTable();
  }

  // ======================================================================
  // 校正
  // ======================================================================
  function updateCalInfo() {
    const el = $("calInfo");
    if (!state.nmpx) {
      el.textContent = "未校正時，k 與 d 以 pixel 為單位。";
      el.className = "note";
    } else {
      const dmin = 2 * state.nmpx;
      el.textContent = `已校正 ${+state.nmpx.toPrecision(6)} nm/pixel，最小可解析 d = ${+dmin.toPrecision(4)} nm。`;
      el.className = "note ok";
    }
    const cal = !!state.nmpx;
    $("thK").textContent = `|k| (${cal ? "nm⁻¹" : "px⁻¹"})`;
    $("thD").textContent = `d (${cal ? "nm" : "px"})`;
  }

  function applyCalibration() {
    const s = $("nmpx").value.trim();
    if (s === "") state.nmpx = null;
    else {
      const v = parseFloat(s);
      if (!(v > 0)) { $("calInfo").textContent = "nm/pixel 需要是正數；清空欄位代表不校正。"; $("calInfo").className = "note warn"; return; }
      state.nmpx = v;
    }
    updateCalInfo();
    updateDf();
    fftView.draw();
    renderTable();
  }

  function cancelScaleMode() {
    state.scaleMode = false;
    state.scalePts = [];
    $("btnScale").classList.remove("active");
    $("btnScale").textContent = "在影像上量比例尺";
  }

  function finishScale(dist) {
    const ans = window.prompt(`兩點距離為 ${dist.toFixed(2)} px。\n請輸入比例尺的實際長度（nm）：`);
    cancelScaleMode();
    realView.draw();
    const L = ans == null ? NaN : parseFloat(ans);
    if (L > 0 && dist > 0) {
      $("nmpx").value = +(L / dist).toPrecision(6);
      applyCalibration();
    }
  }

  // ======================================================================
  // 量測表
  // ======================================================================
  function renderTable() {
    const tb = document.querySelector("#tbl tbody");
    tb.innerHTML = "";
    const has = state.spots.length > 0;
    $("empty").hidden = has;
    $("btnCSV").disabled = !has;
    $("btnClear").disabled = !has;
    if (!state.fft) { updateAngle(); return; }
    const n = state.fft.n, cal = !!state.nmpx;
    state.spots.forEach((s, i) => {
      const v = Core.spotValues(s.col, s.row, n, state.df);
      const tr = document.createElement("tr");
      if (state.selected.includes(i)) tr.className = "sel";
      tr.innerHTML =
        `<td><input type="checkbox" aria-label="比較第 ${i + 1} 點" ${state.selected.includes(i) ? "checked" : ""}></td>` +
        `<td>${i + 1}</td><td>${fmt(v.k, 4)}</td><td>${fmt(v.d, 4)}</td>` +
        `<td>${cal ? fmt(v.d * 10, 3) : "—"}</td><td>${fmt(v.ang, 1)}</td>` +
        `<td><button type="button" class="del" aria-label="刪除第 ${i + 1} 點">×</button></td>`;
      tr.querySelector("input").addEventListener("change", (e) => toggleSelect(i, e.target.checked));
      tr.querySelector(".del").addEventListener("click", () => removeSpot(i));
      tb.appendChild(tr);
    });
    updateAngle();
  }

  function toggleSelect(i, on) {
    state.selected = state.selected.filter((j) => j !== i);
    if (on) {
      state.selected.push(i);
      if (state.selected.length > 2) state.selected.shift();
    }
    fftView.draw();
    renderTable();
  }

  function updateAngle() {
    const el = $("angleBox");
    if (state.selected.length !== 2 || !state.fft) {
      el.textContent = "勾選兩個點，比較夾角與 d 比值。";
      el.className = "angle";
      return;
    }
    const [i, j] = state.selected, n = state.fft.n;
    const a = Core.spotValues(state.spots[i].col, state.spots[i].row, n, state.df);
    const b = Core.spotValues(state.spots[j].col, state.spots[j].row, n, state.df);
    const ang = Core.angleBetween(a, b);
    el.innerHTML = `#${i + 1} 與 #${j + 1}：夾角 <b>${ang.toFixed(2)}°</b>（補角 ${(180 - ang).toFixed(2)}°），` +
      `d${i + 1} / d${j + 1} = <b>${(a.d / b.d).toFixed(4)}</b>`;
    el.className = "angle has";
  }

  // ======================================================================
  // 匯出
  // ======================================================================
  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  const baseName = () => (state.img ? state.img.name.replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|\s]+/g, "_") : "image");

  function exportCSV() {
    const cal = !!state.nmpx, n = state.fft.n;
    const ku = cal ? "nm^-1" : "px^-1", du = cal ? "nm" : "px";
    const { x0, y0 } = state.roi;
    const rows = [
      ["# file", state.img.name],
      ["# nm_per_px", cal ? state.nmpx : "uncalibrated"],
      ["# ROI x0, y0, size", x0, y0, n],
      ["# window", $("window").value],
      ["#", "fft_col", "fft_row", `kx (${ku})`, `ky (${ku})`, `|k| (${ku})`, `d (${du})`, "d (A)", "azimuth (deg)"],
    ];
    state.spots.forEach((s, i) => {
      const v = Core.spotValues(s.col, s.row, n, state.df);
      rows.push([i + 1, s.col.toFixed(3), s.row.toFixed(3), v.kx.toFixed(6), v.ky.toFixed(6),
        v.k.toFixed(6), v.d.toFixed(6), cal ? (v.d * 10).toFixed(5) : "", v.ang.toFixed(2)]);
    });
    const esc = (x) => { const s = String(x); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    const csv = "﻿" + rows.map((r) => r.map(esc).join(",")).join("\r\n") + "\r\n";
    download(new Blob([csv], { type: "text/csv;charset=utf-8" }), `${baseName()}_d_spacing.csv`);
  }

  function exportPNG(withMarkers) {
    const n = state.fft.n;
    const s = withMarkers ? Math.max(1, Math.round(1024 / n)) : 1;
    const c = document.createElement("canvas");
    c.width = c.height = n * s;
    const ctx = c.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(fftSrc, 0, 0, n * s, n * s);
    if (withMarkers) {
      const size = n * s, R = size * 0.011, half = n / 2;
      ctx.font = `700 ${Math.round(size * 0.02)}px "Noto Sans TC", system-ui, sans-serif`;
      ctx.textBaseline = "bottom";
      state.spots.forEach((p, i) => {
        const x = (p.col + 0.5) * s, y = (p.row + 0.5) * s;
        const mx = (2 * half - p.col + 0.5) * s, my = (2 * half - p.row + 0.5) * s;
        ctx.strokeStyle = "#4ee3f2"; ctx.lineWidth = Math.max(1.5, size * 0.002);
        ctx.beginPath(); ctx.arc(x, y, R, 0, 2 * Math.PI); ctx.stroke();
        ctx.globalAlpha = 0.45;
        ctx.beginPath(); ctx.arc(mx, my, R, 0, 2 * Math.PI); ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = "#4ee3f2";
        ctx.fillText(String(i + 1), x + R * 1.1, y - R * 0.6);
      });
    }
    c.toBlob((b) => download(b, `${baseName()}_FFT${withMarkers ? "_marked" : ""}.png`), "image/png");
  }

  function exportROI() {
    const { x0, y0, n } = state.roi;
    const c = document.createElement("canvas");
    c.width = c.height = n;
    c.getContext("2d").drawImage(realSrc, x0, y0, n, n, 0, 0, n, n);
    c.toBlob((b) => download(b, `${baseName()}_ROI_${x0}_${y0}_${n}.png`), "image/png");
  }

  // ======================================================================
  // 控制項
  // ======================================================================
  $("file").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ""; });
  $("btnDemo").addEventListener("click", async () => {
    busy(true, "產生示範影像…");
    await nextFrame();
    try {
      await setImage(makeDemo());
      // 示範影像：把 FFT 放大到 ±3.5 個 (100) 反射的範圍
      const kHalf = 3.5 / DEMO.d0, v = fftView;
      v.zoomAt(v.cw / 2, v.ch / 2, v.cw / ((2 * kHalf) / state.df) / v.scale);
    } finally { busy(false); }
  });

  $("nmpx").addEventListener("change", applyCalibration);
  $("nmpx").addEventListener("keydown", (e) => { if (e.key === "Enter") applyCalibration(); });
  $("btnScale").addEventListener("click", () => {
    if (!state.img) return;
    if (state.scaleMode) { cancelScaleMode(); realView.draw(); return; }
    state.scaleMode = true;
    state.scalePts = [];
    $("btnScale").classList.add("active");
    $("btnScale").textContent = "取消量比例尺";
    $("roReal").textContent = "點擊比例尺的一端（可先放大影像以便對準）。";
  });

  $("roiSize").addEventListener("change", () => { state.roiSize = parseInt($("roiSize").value, 10); updateROI(); });
  $("btnCenter").addEventListener("click", () => {
    if (!state.img) return;
    state.roiCenter = { x: state.img.w / 2, y: state.img.h / 2 };
    updateROI();
  });
  $("window").addEventListener("change", () => computeFFT(true));
  $("cmap").addEventListener("change", scheduleRender);

  function bindLevel(rangeId, numId, isMin) {
    const r = $(rangeId), n = $(numId);
    r.addEventListener("input", () => {
      let v = parseFloat(r.value);
      const other = parseFloat((isMin ? $("pmax") : $("pmin")).value);
      if (isMin && v >= other) v = Math.max(0, other - 0.1);
      if (!isMin && v <= other) v = Math.min(100, other + 0.1);
      r.value = v; n.value = +v.toFixed(2);
      scheduleRender();
    });
    n.addEventListener("change", () => {
      let v = parseFloat(n.value);
      if (!Number.isFinite(v)) v = isMin ? 2 : 99.8;
      v = isMin ? Math.max(0, Math.min(v, 99.9)) : Math.max(0.1, Math.min(v, 100));
      const other = parseFloat((isMin ? $("pmax") : $("pmin")).value);
      if (isMin && v >= other) v = other - 0.1;
      if (!isMin && v <= other) v = other + 0.1;
      n.value = +v.toFixed(2); r.value = v;
      scheduleRender();
    });
  }
  bindLevel("pminR", "pmin", true);
  bindLevel("pmaxR", "pmax", false);

  document.querySelectorAll(".zoom").forEach((g) => {
    const v = viewers[g.dataset.viewer];
    g.addEventListener("click", (e) => {
      const z = e.target.dataset && e.target.dataset.z;
      if (!z) return;
      if (z === "fit") v.fit();
      else v.zoomAt(v.cw / 2, v.ch / 2, z === "in" ? 1.4 : 1 / 1.4);
    });
  });

  $("btnCSV").addEventListener("click", exportCSV);
  $("btnClear").addEventListener("click", () => { state.spots = []; state.selected = []; fftView.draw(); renderTable(); });
  $("btnPNG").addEventListener("click", () => exportPNG(false));
  $("btnPNGm").addEventListener("click", () => exportPNG(true));
  $("btnROI").addEventListener("click", exportROI);

  // 拖曳載入
  let dragDepth = 0;
  window.addEventListener("dragenter", (e) => { if ([...e.dataTransfer.types].includes("Files")) { dragDepth++; $("drop").hidden = false; } });
  window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) $("drop").hidden = true; });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragDepth = 0; $("drop").hidden = true;
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) loadFile(f);
  });

  renderTable();

  // 供除錯與自動化測試使用
  window.FFTApp = { state, viewers, setImage, makeDemo, loadFile };
})();
