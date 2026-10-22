"""HRTEM 2D FFT 分析工具

功能：
  * nm/pixel 校正：直接輸入，或在實空間圖上點擊比例尺兩端後輸入長度
  * 正方形 ROI：選擇邊長，在左圖點擊以移動 ROI 中心
  * d-spacing 量測：在 FFT 圖上左鍵點擊亮點（自動吸附至亮點中心，含次像素內插），
    右鍵刪除最近的點；表格中選取兩列可計算夾角與 d 比值
  * 匯出量測結果 CSV、匯出純 FFT 圖檔（1 FFT 像素 = 1 圖檔像素）

慣例：k 為空間頻率（cycles / nm，不含 2π），d = 1 / |k|。
FFT 圖中 ky 向上為正，方位角自 +kx 逆時針計算。

Copyright (c) 2026 Song-Yi Chan — MIT License
"""

import csv
import math
import os
import tkinter as tk
from tkinter import filedialog, messagebox, simpledialog, ttk

import cv2
import matplotlib

matplotlib.use("TkAgg")
import matplotlib.image as mpimg
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
from matplotlib.backends.backend_tkagg import NavigationToolbar2Tk
from matplotlib.figure import Figure
from matplotlib.patches import Rectangle
import numpy as np


def read_gray_image(path):
  """以 float64 灰階讀取影像；保留 16-bit / 32-bit TIFF 的原始動態範圍。"""
  data = np.fromfile(path, dtype=np.uint8)  # 支援中文路徑
  img = cv2.imdecode(data, cv2.IMREAD_UNCHANGED)
  if img is None:
    raise ValueError("無法解碼影像檔")
  if img.ndim == 3:
    code = cv2.COLOR_BGRA2GRAY if img.shape[2] == 4 else cv2.COLOR_BGR2GRAY
    img = cv2.cvtColor(img, code)
  return img.astype(np.float64)


class FFTApp:

  def __init__(self, root):
    self.root = root
    self.root.title("HRTEM 2D FFT 分析工具（校正 / ROI / d-spacing）")
    self.root.geometry("1450x900")

    # ---- 資料狀態 ----
    self.image_path = None
    self.img = None              # 全圖灰階 (float64)
    self.nm_per_px = None        # None = 未校正
    self.roi_size = None
    self.roi_center = None       # (x, y) 影像像素座標
    self.roi_bounds = None       # (x0, y0, n)
    self.N = None                # FFT 邊長
    self.df = None               # 每個 FFT 像素對應的 k (nm^-1 或 px^-1)
    self.mag_lin = None
    self.mag_db = None
    self.spots = []              # [{"col", "row", "artists"}]，以 FFT 像素索引儲存
    self.cal_mode = False
    self.scale_pts = []
    self.scale_artists = []

    # ---- 繪圖物件 ----
    self.im_real = None
    self.im_fft = None
    self.roi_rect = None
    self.cbar = None

    self._build_controls()
    self._build_plot_area()

  # ======================================================================
  # 介面
  # ======================================================================
  def _build_controls(self):
    root = self.root

    # ---------- 面板 1：檔案與演算法 ----------
    p1 = ttk.Frame(root, padding=6)
    p1.pack(side=tk.TOP, fill=tk.X)

    ttk.Button(p1, text="📁 選擇圖片檔案", command=self.load_image).pack(
        side=tk.LEFT, padx=5)
    self.lbl_file = ttk.Label(p1, text="尚未選取檔案", foreground="gray")
    self.lbl_file.pack(side=tk.LEFT, padx=10)

    ttk.Label(p1, text="窗函數:").pack(side=tk.LEFT, padx=(15, 2))
    self.var_window = tk.StringVar(value="Hanning")
    cb = ttk.Combobox(p1, textvariable=self.var_window,
                      values=["Hanning", "Hamming", "None"], width=9,
                      state="readonly")
    cb.pack(side=tk.LEFT, padx=2)
    cb.bind("<<ComboboxSelected>>",
            lambda e: self.compute_fft(clear_spots=False))

    ttk.Label(p1, text="色盤:").pack(side=tk.LEFT, padx=(15, 2))
    self.var_cmap = tk.StringVar(value="inferno")
    cb = ttk.Combobox(p1, textvariable=self.var_cmap,
                      values=["inferno", "magma", "plasma", "viridis", "gray"],
                      width=9, state="readonly")
    cb.pack(side=tk.LEFT, padx=2)
    cb.bind("<<ComboboxSelected>>", lambda e: self.on_cmap_changed())

    self.btn_csv = ttk.Button(p1, text="📄 匯出量測 CSV",
                              command=self.export_csv, state=tk.DISABLED)
    self.btn_csv.pack(side=tk.RIGHT, padx=5)
    self.btn_save = ttk.Button(p1, text="💾 下載純 FFT 圖檔 (無標題/軸線)",
                               command=self.save_result, state=tk.DISABLED)
    self.btn_save.pack(side=tk.RIGHT, padx=5)

    # ---------- 面板 2：校正與 ROI ----------
    p2 = ttk.LabelFrame(root, text="📐 空間校正與 ROI", padding=6)
    p2.pack(side=tk.TOP, fill=tk.X, padx=10, pady=3)

    ttk.Label(p2, text="nm / pixel:").grid(row=0, column=0, sticky=tk.W, padx=4)
    self.var_nmpx = tk.StringVar(value="")
    ent = ttk.Entry(p2, textvariable=self.var_nmpx, width=12)
    ent.grid(row=0, column=1, padx=4)
    ent.bind("<Return>", lambda e: self.apply_calibration())
    ttk.Button(p2, text="套用", command=self.apply_calibration).grid(
        row=0, column=2, padx=4)
    ttk.Button(p2, text="📏 由比例尺校正",
               command=self.start_scale_calibration).grid(row=0, column=3,
                                                          padx=4)
    self.lbl_cal = ttk.Label(p2, text="未校正（單位：pixel）", foreground="gray")
    self.lbl_cal.grid(row=0, column=4, sticky=tk.W, padx=10)

    ttk.Label(p2, text="ROI 邊長 (px):").grid(row=1, column=0, sticky=tk.W,
                                            padx=4, pady=(4, 0))
    self.var_roi = tk.StringVar(value="")
    self.cb_roi = ttk.Combobox(p2, textvariable=self.var_roi, width=12,
                               state="readonly")
    self.cb_roi.grid(row=1, column=1, padx=4, pady=(4, 0))
    self.cb_roi.bind("<<ComboboxSelected>>", lambda e: self.on_roi_size_changed())
    ttk.Button(p2, text="ROI 置中", command=self.center_roi).grid(
        row=1, column=2, padx=4, pady=(4, 0))

    ttk.Label(p2, text="吸附半徑 (FFT px):").grid(row=1, column=3, sticky=tk.E,
                                              padx=4, pady=(4, 0))
    self.var_snap_r = tk.IntVar(value=6)
    ttk.Spinbox(p2, from_=1, to=30, textvariable=self.var_snap_r,
                width=5).grid(row=1, column=4, sticky=tk.W, padx=4, pady=(4, 0))
    self.var_snap = tk.BooleanVar(value=True)
    ttk.Checkbutton(p2, text="自動吸附亮點中心", variable=self.var_snap).grid(
        row=1, column=4, sticky=tk.W, padx=(70, 4), pady=(4, 0))

    p2.columnconfigure(4, weight=1)

    # ---------- 面板 3：色階 ----------
    p3 = ttk.LabelFrame(root, text="🎚️ 色階調整 (可拖曳滑桿或直接輸入數值後按 Enter)",
                        padding=6)
    p3.pack(side=tk.TOP, fill=tk.X, padx=10, pady=3)

    # 先建立 StringVar，避免 Scale.set() 觸發 callback 時變數尚未存在
    self.var_entry_min = tk.StringVar(value="2.00")
    self.var_entry_max = tk.StringVar(value="99.80")

    ttk.Label(p3, text="色階下限 (%):").grid(row=0, column=0, sticky=tk.W, padx=5)
    self.scale_min = ttk.Scale(p3, from_=0, to=100, orient=tk.HORIZONTAL,
                               command=self.on_slider_min_drag)
    self.scale_min.set(2.0)
    self.scale_min.grid(row=0, column=1, sticky=tk.EW, padx=5)
    e = ttk.Entry(p3, textvariable=self.var_entry_min, width=8)
    e.grid(row=0, column=2, padx=5)
    e.bind("<Return>", lambda ev: self.on_entry_changed())

    ttk.Label(p3, text="色階上限 (%):").grid(row=1, column=0, sticky=tk.W, padx=5)
    self.scale_max = ttk.Scale(p3, from_=0, to=100, orient=tk.HORIZONTAL,
                               command=self.on_slider_max_drag)
    self.scale_max.set(99.8)
    self.scale_max.grid(row=1, column=1, sticky=tk.EW, padx=5)
    e = ttk.Entry(p3, textvariable=self.var_entry_max, width=8)
    e.grid(row=1, column=2, padx=5)
    e.bind("<Return>", lambda ev: self.on_entry_changed())
    p3.columnconfigure(1, weight=1)

    # ---------- 狀態列 ----------
    self.lbl_status = ttk.Label(
        root, padding=(10, 3), foreground="#444",
        text="左圖：點擊移動 ROI｜右圖：左鍵量測亮點、右鍵刪除最近的點｜"
             "可用工具列放大後，再關閉放大模式點選")
    self.lbl_status.pack(side=tk.BOTTOM, fill=tk.X)

  def _build_plot_area(self):
    body = ttk.Frame(self.root)
    body.pack(side=tk.TOP, fill=tk.BOTH, expand=True, padx=6, pady=4)

    # ---------- 右側：量測表 ----------
    side = ttk.LabelFrame(body, text="🔍 d-spacing 量測", padding=6)
    side.pack(side=tk.RIGHT, fill=tk.Y)

    cols = ("no", "k", "d", "dA", "ang")
    self.tree = ttk.Treeview(side, columns=cols, show="headings", height=18,
                             selectmode="extended")
    widths = (35, 85, 80, 70, 80)
    for c, w in zip(cols, widths):
      self.tree.column(c, width=w, anchor=tk.CENTER)
    self._set_tree_headings()
    self.tree.pack(side=tk.TOP, fill=tk.Y, expand=True)
    self.tree.bind("<<TreeviewSelect>>", lambda e: self.update_angle_label())

    self.lbl_angle = ttk.Label(side, text="選取兩列以計算夾角", justify=tk.LEFT,
                               wraplength=340)
    self.lbl_angle.pack(side=tk.TOP, fill=tk.X, pady=6)

    bf = ttk.Frame(side)
    bf.pack(side=tk.TOP, fill=tk.X)
    ttk.Button(bf, text="刪除選取", command=self.delete_selected).pack(
        side=tk.LEFT, padx=3)
    ttk.Button(bf, text="全部清除", command=self.clear_spots).pack(
        side=tk.LEFT, padx=3)

    # ---------- 左側：畫布 ----------
    plot_frame = ttk.Frame(body)
    plot_frame.pack(side=tk.LEFT, fill=tk.BOTH, expand=True)

    self.fig = Figure(figsize=(10, 5.2), dpi=100)
    self.ax_real = self.fig.add_axes([0.01, 0.10, 0.44, 0.82])
    self.ax_fft = self.fig.add_axes([0.53, 0.10, 0.37, 0.82])
    self.cax = self.fig.add_axes([0.92, 0.10, 0.015, 0.82])
    self.cax.set_visible(False)
    for ax, txt in ((self.ax_real, "Real space"), (self.ax_fft, "2D FFT")):
      ax.set_axis_off()
      ax.text(0.5, 0.5, f"{txt}\n(load an image)", ha="center", va="center",
              color="gray", transform=ax.transAxes)

    self.canvas = FigureCanvasTkAgg(self.fig, master=plot_frame)
    self.toolbar = NavigationToolbar2Tk(self.canvas, plot_frame,
                                        pack_toolbar=False)
    self.toolbar.pack(side=tk.BOTTOM, fill=tk.X)
    self.canvas.get_tk_widget().pack(side=tk.TOP, fill=tk.BOTH, expand=True)
    self.canvas.mpl_connect("button_press_event", self.on_click)
    self.canvas.draw()

  def _set_tree_headings(self):
    cal = self.nm_per_px is not None
    ku = "nm⁻¹" if cal else "px⁻¹"
    du = "nm" if cal else "px"
    for c, t in (("no", "#"), ("k", f"|k| ({ku})"), ("d", f"d ({du})"),
                 ("dA", "d (Å)"), ("ang", "方位角 (°)")):
      self.tree.heading(c, text=t)

  # ======================================================================
  # 檔案載入
  # ======================================================================
  def load_image(self):
    path = filedialog.askopenfilename(
        title="選取 HRTEM / 薄膜表面圖片",
        filetypes=[("Image files", "*.jpg *.jpeg *.png *.tif *.tiff *.bmp")],
    )
    if not path:
      return
    try:
      img = read_gray_image(path)
    except Exception as exc:
      messagebox.showerror("錯誤", f"讀取失敗：{exc}")
      return

    self.image_path = path
    self.img = img
    self.lbl_file.config(text=os.path.basename(path), foreground="black")
    h, w = img.shape

    # ROI 邊長選項：2^n 與最大正方形
    m = min(h, w)
    sizes = [2 ** p for p in range(6, 15) if 2 ** p < m]
    values = [str(s) for s in sizes] + [f"{m} (最大)"]
    self.cb_roi.config(values=values)
    self.var_roi.set(values[-1])
    self.roi_size = m
    self.roi_center = (w / 2, h / 2)

    # 清除舊的佔位文字與狀態
    for ax in (self.ax_real, self.ax_fft):
      for t in list(ax.texts):
        t.remove()
    self.clear_spots(redraw=False)
    self.cancel_scale_calibration()
    self.N = None

    # 實空間影像
    lo, hi = np.percentile(img, [0.5, 99.5])
    if self.im_real is None:
      self.im_real = self.ax_real.imshow(img, cmap="gray", vmin=lo, vmax=hi,
                                         interpolation="nearest")
    else:
      self.im_real.set_data(img)
      self.im_real.set_extent((-0.5, w - 0.5, h - 0.5, -0.5))
      self.im_real.set_clim(lo, hi)
    self.ax_real.set_xlim(-0.5, w - 0.5)
    self.ax_real.set_ylim(h - 0.5, -0.5)
    self.ax_real.set_autoscale_on(False)
    self.ax_real.set_axis_off()

    self.update_roi(clear_spots=True)
    self.btn_save.config(state=tk.NORMAL)
    self.btn_csv.config(state=tk.NORMAL)
    self.toolbar.update()  # 重設 Home 視角

  # ======================================================================
  # 校正
  # ======================================================================
  def apply_calibration(self):
    s = self.var_nmpx.get().strip()
    if s == "":
      self.nm_per_px = None
    else:
      try:
        v = float(s)
        if not v > 0:
          raise ValueError
      except ValueError:
        messagebox.showerror("錯誤", "nm/pixel 必須是正數（留空表示不校正）")
        return
      self.nm_per_px = v
    self._set_tree_headings()
    if self.mag_db is not None:
      self.update_fft_display()
    self.update_cal_label()

  def update_cal_label(self):
    if self.nm_per_px is None:
      self.lbl_cal.config(text="未校正（單位：pixel）", foreground="gray")
      return
    txt = f"已校正：{self.nm_per_px:.6g} nm/px"
    if self.N:
      df = 1.0 / (self.N * self.nm_per_px)
      kmax = 1.0 / (2 * self.nm_per_px)
      txt += (f"｜Δk = {df:.4g} nm⁻¹｜Nyquist d_min = {1 / kmax:.4g} nm")
    self.lbl_cal.config(text=txt, foreground="#0a6")

  def start_scale_calibration(self):
    if self.img is None:
      return
    self.cancel_scale_calibration()
    self.cal_mode = True
    self.lbl_status.config(
        text="📏 比例尺校正：請在左圖依序點擊比例尺的兩端（可先用工具列放大）",
        foreground="#c60")

  def cancel_scale_calibration(self):
    self.cal_mode = False
    self.scale_pts = []
    for a in self.scale_artists:
      a.remove()
    self.scale_artists = []

  def finish_scale_calibration(self, dist):
    length = simpledialog.askfloat(
        "比例尺校正",
        f"兩點距離 = {dist:.2f} px\n請輸入比例尺實際長度 (nm)：",
        minvalue=1e-9, parent=self.root)
    self.cancel_scale_calibration()
    self.lbl_status.config(
        text="左圖：點擊移動 ROI｜右圖：左鍵量測亮點、右鍵刪除最近的點",
        foreground="#444")
    if length and dist > 0:
      self.var_nmpx.set(f"{length / dist:.6g}")
      self.apply_calibration()
    self.canvas.draw_idle()

  # ======================================================================
  # ROI
  # ======================================================================
  def on_roi_size_changed(self):
    if self.img is None:
      return
    self.roi_size = int(self.var_roi.get().split()[0])
    self.update_roi(clear_spots=True)

  def center_roi(self):
    if self.img is None:
      return
    h, w = self.img.shape
    self.roi_center = (w / 2, h / 2)
    self.update_roi(clear_spots=True)

  def update_roi(self, clear_spots=True):
    h, w = self.img.shape
    n = min(self.roi_size, h, w)
    cx, cy = self.roi_center
    x0 = int(round(cx - n / 2))
    y0 = int(round(cy - n / 2))
    x0 = min(max(x0, 0), w - n)
    y0 = min(max(y0, 0), h - n)
    self.roi_bounds = (x0, y0, n)

    if self.roi_rect is None:
      self.roi_rect = Rectangle((x0 - 0.5, y0 - 0.5), n, n, fill=False,
                                edgecolor="cyan", linewidth=1.5)
      self.ax_real.add_patch(self.roi_rect)
    else:
      self.roi_rect.set_xy((x0 - 0.5, y0 - 0.5))
      self.roi_rect.set_width(n)
      self.roi_rect.set_height(n)
    self.ax_real.set_title(f"Real space  |  ROI {n}×{n} px @ ({x0}, {y0})",
                           fontsize=10, fontweight="bold")
    self.compute_fft(clear_spots=clear_spots)

  # ======================================================================
  # FFT
  # ======================================================================
  def compute_fft(self, clear_spots=True):
    if self.img is None or self.roi_bounds is None:
      return
    x0, y0, n = self.roi_bounds
    roi = self.img[y0:y0 + n, x0:x0 + n]

    # 1. 背景（低頻光照 / 厚度變化）扣除，核大小隨 ROI 調整
    k = min(101, max(3, (n // 4) | 1))
    bg = cv2.GaussianBlur(roi, (k, k), 0)
    proc = roi - bg

    # 2. 窗函數（降低邊界截斷造成的十字條紋）
    win_type = self.var_window.get()
    if win_type == "Hanning":
      proc = proc * np.outer(np.hanning(n), np.hanning(n))
    elif win_type == "Hamming":
      proc = proc * np.outer(np.hamming(n), np.hamming(n))

    # 3. 2D FFT
    F = np.fft.fftshift(np.fft.fft2(proc))
    self.mag_lin = np.abs(F)
    self.mag_db = 20 * np.log10(self.mag_lin + 1e-6)

    if clear_spots or self.N != n:
      self.clear_spots(redraw=False)
    self.N = n
    self.update_fft_display()
    self.update_cal_label()

  def update_fft_display(self):
    n = self.N
    c = n // 2
    px = self.nm_per_px if self.nm_per_px else 1.0
    self.df = df = 1.0 / (n * px)
    # origin='upper'：第 0 列在上方；設定 extent 使 ky 向上為正
    extent = ((-c - 0.5) * df, (n - 1 - c + 0.5) * df,
              -(n - 1 - c + 0.5) * df, (c + 0.5) * df)
    vmin, vmax = self.current_clim()

    if self.im_fft is None:
      self.im_fft = self.ax_fft.imshow(self.mag_db, cmap=self.var_cmap.get(),
                                       vmin=vmin, vmax=vmax, extent=extent,
                                       interpolation="nearest")
      self.cax.set_visible(True)
      self.cbar = self.fig.colorbar(self.im_fft, cax=self.cax)
      self.cbar.set_label("dB", fontsize=9)
      self.cbar.ax.tick_params(labelsize=8)
      self.ax_fft.format_coord = self._fft_format_coord
    else:
      self.im_fft.set_data(self.mag_db)
      self.im_fft.set_extent(extent)
      self.im_fft.set_clim(vmin, vmax)

    self.ax_fft.set_xlim(extent[0], extent[1])
    self.ax_fft.set_ylim(extent[2], extent[3])
    self.ax_fft.set_autoscale_on(False)
    self.ax_fft.set_axis_on()
    unit = "nm$^{-1}$" if self.nm_per_px else "px$^{-1}$"
    self.ax_fft.set_xlabel(f"$k_x$ ({unit})", fontsize=9)
    self.ax_fft.set_ylabel(f"$k_y$ ({unit})", fontsize=9)
    self.ax_fft.tick_params(labelsize=8)
    self.ax_fft.set_title("2D FFT (diffractogram)", fontsize=10,
                          fontweight="bold")

    self.redraw_spots()
    self.refresh_table()
    self.toolbar.update()
    self.canvas.draw_idle()

  def _fft_format_coord(self, x, y):
    k = math.hypot(x, y)
    u = "nm" if self.nm_per_px else "px"
    d = f"{1 / k:.4f} {u}" if k > 0 else "∞"
    return f"kx={x:.4f}  ky={y:.4f}  |k|={k:.4f} {u}⁻¹  d={d}"

  # ---- 座標轉換 ----
  def data_to_index(self, kx, ky):
    c = self.N // 2
    return kx / self.df + c, c - ky / self.df

  def index_to_k(self, col, row):
    c = self.N // 2
    return (col - c) * self.df, (c - row) * self.df

  def refine_peak(self, col, row):
    """在吸附半徑內找最大值，再以 log 強度三點拋物線做次像素內插。"""
    n = self.N
    r = max(1, int(self.var_snap_r.get()))
    c0, r0 = int(round(col)), int(round(row))
    xa, xb = max(c0 - r, 1), min(c0 + r, n - 2)
    ya, yb = max(r0 - r, 1), min(r0 + r, n - 2)
    if xa > xb or ya > yb:
      return col, row
    win = self.mag_lin[ya:yb + 1, xa:xb + 1]
    iy, ix = np.unravel_index(np.argmax(win), win.shape)
    py, px = ya + iy, xa + ix

    L = np.log(self.mag_lin[py - 1:py + 2, px - 1:px + 2] + 1e-12)

    def parabola(a, b, c):
      den = a - 2 * b + c
      return 0.0 if den == 0 else float(np.clip(0.5 * (a - c) / den, -0.5, 0.5))

    dx = parabola(L[1, 0], L[1, 1], L[1, 2])
    dy = parabola(L[0, 1], L[1, 1], L[2, 1])
    return px + dx, py + dy

  # ======================================================================
  # 滑鼠事件
  # ======================================================================
  def on_click(self, event):
    if self.img is None or event.inaxes is None or event.xdata is None:
      return
    if self.toolbar.mode != "":  # 放大/平移模式時不處理
      return
    if event.inaxes is self.ax_real:
      self.on_click_real(event)
    elif event.inaxes is self.ax_fft and self.mag_lin is not None:
      self.on_click_fft(event)

  def on_click_real(self, event):
    x, y = event.xdata, event.ydata
    if self.cal_mode:
      if event.button != 1:
        return
      self.scale_pts.append((x, y))
      self.scale_artists.append(
          self.ax_real.plot([x], [y], "+", color="lime", ms=14, mew=2)[0])
      if len(self.scale_pts) == 2:
        (x1, y1), (x2, y2) = self.scale_pts
        self.scale_artists.append(
            self.ax_real.plot([x1, x2], [y1, y2], "-", color="lime", lw=1.5)[0])
        self.canvas.draw()
        self.finish_scale_calibration(math.hypot(x2 - x1, y2 - y1))
      else:
        self.canvas.draw_idle()
      return
    if event.button == 1:
      self.roi_center = (x, y)
      self.update_roi(clear_spots=True)

  def on_click_fft(self, event):
    if event.button == 3:
      self.delete_nearest_spot(event)
      return
    if event.button != 1:
      return
    col, row = self.data_to_index(event.xdata, event.ydata)
    if self.var_snap.get():
      col, row = self.refine_peak(col, row)
    c = self.N // 2
    if math.hypot(col - c, row - c) < 1.5:
      messagebox.showwarning("提示", "位置太靠近中心 (DC)，請點擊繞射亮點。")
      return
    self.spots.append({"col": col, "row": row, "artists": []})
    self.draw_spot(len(self.spots) - 1)
    self.refresh_table()
    self.canvas.draw_idle()

  # ======================================================================
  # 量測點管理
  # ======================================================================
  def draw_spot(self, i):
    s = self.spots[i]
    kx, ky = self.index_to_k(s["col"], s["row"])
    a1 = self.ax_fft.plot([kx], [ky], "o", mfc="none", mec="cyan", ms=12,
                          mew=1.6)[0]
    # Friedel 對稱點 (-k)
    a2 = self.ax_fft.plot([-kx], [-ky], "o", mfc="none", mec="cyan", ms=12,
                          mew=1.0, alpha=0.45)[0]
    a3 = self.ax_fft.annotate(str(i + 1), (kx, ky), xytext=(7, 7),
                              textcoords="offset points", color="cyan",
                              fontsize=9, fontweight="bold")
    s["artists"] = [a1, a2, a3]

  def redraw_spots(self):
    for s in self.spots:
      for a in s["artists"]:
        a.remove()
      s["artists"] = []
    for i in range(len(self.spots)):
      self.draw_spot(i)

  def clear_spots(self, redraw=True):
    for s in self.spots:
      for a in s["artists"]:
        a.remove()
    self.spots = []
    self.refresh_table()
    if redraw:
      self.canvas.draw_idle()

  def delete_nearest_spot(self, event):
    if not self.spots:
      return
    best, best_d = None, 15.0  # 螢幕像素
    for i, s in enumerate(self.spots):
      sx, sy = self.ax_fft.transData.transform(
          self.index_to_k(s["col"], s["row"]))
      d = math.hypot(sx - event.x, sy - event.y)
      if d < best_d:
        best, best_d = i, d
    if best is not None:
      self._remove_spots([best])

  def delete_selected(self):
    idx = [int(i) for i in self.tree.selection()]
    if idx:
      self._remove_spots(idx)

  def _remove_spots(self, indices):
    for i in sorted(set(indices), reverse=True):
      for a in self.spots[i]["artists"]:
        a.remove()
      del self.spots[i]
    self.redraw_spots()  # 重新編號
    self.refresh_table()
    self.canvas.draw_idle()

  def spot_values(self, s):
    kx, ky = self.index_to_k(s["col"], s["row"])
    k = math.hypot(kx, ky)
    d = 1.0 / k
    ang = math.degrees(math.atan2(ky, kx))
    return kx, ky, k, d, ang

  def refresh_table(self):
    self.tree.delete(*self.tree.get_children())
    if self.N is None:
      self.update_angle_label()
      return
    cal = self.nm_per_px is not None
    for i, s in enumerate(self.spots):
      _, _, k, d, ang = self.spot_values(s)
      self.tree.insert("", "end", iid=str(i), values=(
          i + 1, f"{k:.4f}", f"{d:.4f}",
          f"{d * 10:.3f}" if cal else "—", f"{ang:.1f}"))
    self.update_angle_label()

  def update_angle_label(self):
    sel = self.tree.selection()
    if len(sel) != 2:
      self.lbl_angle.config(text="選取兩列（Ctrl+點擊）以計算夾角與 d 比值")
      return
    i, j = int(sel[0]), int(sel[1])
    kx1, ky1, k1, d1, _ = self.spot_values(self.spots[i])
    kx2, ky2, k2, d2, _ = self.spot_values(self.spots[j])
    cosv = (kx1 * kx2 + ky1 * ky2) / (k1 * k2)
    ang = math.degrees(math.acos(max(-1.0, min(1.0, cosv))))
    self.lbl_angle.config(
        text=f"#{i + 1} 與 #{j + 1}\n"
             f"夾角 = {ang:.2f}°（補角 {180 - ang:.2f}°）\n"
             f"d{i + 1} / d{j + 1} = {d1 / d2:.4f}")

  # ======================================================================
  # 色階 / 色盤
  # ======================================================================
  def current_clim(self):
    try:
      p_min = float(self.var_entry_min.get())
      p_max = float(self.var_entry_max.get())
    except ValueError:
      p_min, p_max = 2.0, 99.8
    vmin, vmax = np.percentile(self.mag_db, [p_min, p_max])
    if vmin >= vmax:
      vmax = vmin + 1e-6
    return vmin, vmax

  def on_cmap_changed(self):
    if self.im_fft is not None:
      self.im_fft.set_cmap(self.var_cmap.get())
      self.canvas.draw_idle()

  def on_slider_min_drag(self, val):
    self.var_entry_min.set(f"{float(val):.2f}")
    self.apply_clim()

  def on_slider_max_drag(self, val):
    self.var_entry_max.set(f"{float(val):.2f}")
    self.apply_clim()

  def on_entry_changed(self):
    try:
      v_min = float(self.var_entry_min.get())
      v_max = float(self.var_entry_max.get())
    except ValueError:
      return
    v_min = max(0.0, min(v_min, 99.9))
    v_max = max(0.1, min(v_max, 100.0))
    if v_min >= v_max:
      v_min = v_max - 0.1
    self.scale_min.set(v_min)
    self.scale_max.set(v_max)
    self.var_entry_min.set(f"{v_min:.2f}")
    self.var_entry_max.set(f"{v_max:.2f}")
    self.apply_clim()

  def apply_clim(self):
    if self.mag_db is None or self.im_fft is None:
      return
    self.im_fft.set_clim(*self.current_clim())
    self.canvas.draw_idle()

  # ======================================================================
  # 匯出
  # ======================================================================
  def save_result(self):
    """儲存套用當前色盤與色階的純 FFT 圖（1 FFT 像素 = 1 圖檔像素）。"""
    if self.mag_db is None:
      return
    save_path = filedialog.asksaveasfilename(
        defaultextension=".png",
        filetypes=[("PNG Image", "*.png"), ("TIF Image", "*.tif")],
        initialfile="FFT_Only.png",
    )
    if not save_path:
      return
    vmin, vmax = self.current_clim()
    mpimg.imsave(save_path, self.mag_db, cmap=self.var_cmap.get(),
                 vmin=vmin, vmax=vmax)
    messagebox.showinfo("成功", f"純 FFT 圖檔已儲存至：\n{save_path}\n"
                              f"（{self.N}×{self.N} px）")

  def export_csv(self):
    if not self.spots:
      messagebox.showinfo("提示", "尚無量測點。")
      return
    path = filedialog.asksaveasfilename(
        defaultextension=".csv", filetypes=[("CSV", "*.csv")],
        initialfile="d_spacing.csv")
    if not path:
      return
    cal = self.nm_per_px is not None
    ku, du = ("nm^-1", "nm") if cal else ("px^-1", "px")
    x0, y0, n = self.roi_bounds
    with open(path, "w", newline="", encoding="utf-8-sig") as f:
      w = csv.writer(f)
      w.writerow(["# file", os.path.basename(self.image_path or "")])
      w.writerow(["# nm_per_px", self.nm_per_px if cal else "uncalibrated"])
      w.writerow(["# ROI x0, y0, size", x0, y0, n])
      w.writerow(["# window", self.var_window.get()])
      w.writerow(["#", "fft_col", "fft_row", f"kx ({ku})", f"ky ({ku})",
                  f"|k| ({ku})", f"d ({du})", "d (A)", "azimuth (deg)"])
      for i, s in enumerate(self.spots):
        kx, ky, k, d, ang = self.spot_values(s)
        w.writerow([i + 1, f"{s['col']:.3f}", f"{s['row']:.3f}",
                    f"{kx:.6f}", f"{ky:.6f}", f"{k:.6f}", f"{d:.6f}",
                    f"{d * 10:.5f}" if cal else "", f"{ang:.2f}"])
    messagebox.showinfo("成功", f"量測結果已匯出：\n{path}")


if __name__ == "__main__":
  root = tk.Tk()
  app = FFTApp(root)
  root.mainloop()
