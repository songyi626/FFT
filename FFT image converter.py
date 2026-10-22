import os
import tkinter as tk
from tkinter import filedialog, messagebox, ttk
import cv2
import matplotlib.pyplot as plt
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
import numpy as np


class FFTApp:

  def __init__(self, root):
    self.root = root
    self.root.title("薄膜表面 2D FFT 分析工具")
    self.root.geometry("1150x780")

    # 內部資料快取
    self.image_path = None
    self.img_rgb = None
    self.mag_spectrum = None
    self.fig = None
    self.axes = None
    self.canvas = None
    self.im_fft = None
    self.cbar = None

    # ==================== 控制面板 1: 檔案與演算法 ====================
    panel_top = ttk.Frame(root, padding=8)
    panel_top.pack(side=tk.TOP, fill=tk.X)

    self.btn_load = ttk.Button(
        panel_top, text="📁 選擇圖片檔案", command=self.load_image
    )
    self.btn_load.pack(side=tk.LEFT, padx=5)

    self.lbl_file = ttk.Label(
        panel_top, text="尚未選取檔案", foreground="gray"
    )
    self.lbl_file.pack(side=tk.LEFT, padx=10)

    # 窗函數
    ttk.Label(panel_top, text="窗函數:").pack(side=tk.LEFT, padx=(15, 2))
    self.var_window = tk.StringVar(value="Hanning")
    self.cb_window = ttk.Combobox(
        panel_top,
        textvariable=self.var_window,
        values=["Hanning", "Hamming", "None"],
        width=9,
        state="readonly",
    )
    self.cb_window.pack(side=tk.LEFT, padx=2)
    self.cb_window.bind(
        "<<ComboboxSelected>>", lambda e: self.on_window_changed()
    )

    # 色盤
    ttk.Label(panel_top, text="色盤:").pack(side=tk.LEFT, padx=(15, 2))
    self.var_cmap = tk.StringVar(value="inferno")
    self.cb_cmap = ttk.Combobox(
        panel_top,
        textvariable=self.var_cmap,
        values=["inferno", "magma", "plasma", "viridis", "gray"],
        width=9,
        state="readonly",
    )
    self.cb_cmap.pack(side=tk.LEFT, padx=2)
    self.cb_cmap.bind("<<ComboboxSelected>>", lambda e: self.on_cmap_changed())

    # 下載按鈕 (純 FFT 影像)
    self.btn_save = ttk.Button(
        panel_top,
        text="💾 下載純 FFT 圖檔 (無標題/軸線)",
        command=self.save_result,
        state=tk.DISABLED,
    )
    self.btn_save.pack(side=tk.RIGHT, padx=5)

    # ==================== 控制面板 2: 色階輸入與滑桿 ====================
    panel_levels = ttk.LabelFrame(
        root, text="🎚️ 色階調整 (可拖曳滑桿或直接輸入數值後按 Enter)", padding=8
    )
    panel_levels.pack(side=tk.TOP, fill=tk.X, padx=10, pady=4)

    # 下限 (From / 背景暗度)
    ttk.Label(panel_levels, text="色階下限 (%):").grid(
        row=0, column=0, sticky=tk.W, padx=5
    )
    self.scale_min = ttk.Scale(
        panel_levels,
        from_=0,
        to=100,
        orient=tk.HORIZONTAL,
        command=self.on_slider_min_drag,
    )
    self.scale_min.set(2.0)
    self.scale_min.grid(row=0, column=1, sticky=tk.EW, padx=5)

    self.var_entry_min = tk.StringVar(value="2.0")
    self.entry_min = ttk.Entry(
        panel_levels, textvariable=self.var_entry_min, width=8
    )
    self.entry_min.grid(row=0, column=2, padx=5)
    self.entry_min.bind("<Return>", lambda e: self.on_entry_changed())

    # 上限 (To / 線條亮斑飽和度)
    ttk.Label(panel_levels, text="色階上限 (%):").grid(
        row=1, column=0, sticky=tk.W, padx=5
    )
    self.scale_max = ttk.Scale(
        panel_levels,
        from_=0,
        to=100,
        orient=tk.HORIZONTAL,
        command=self.on_slider_max_drag,
    )
    self.scale_max.set(99.8)
    self.scale_max.grid(row=1, column=1, sticky=tk.EW, padx=5)

    self.var_entry_max = tk.StringVar(value="99.8")
    self.entry_max = ttk.Entry(
        panel_levels, textvariable=self.var_entry_max, width=8
    )
    self.entry_max.grid(row=1, column=2, padx=5)
    self.entry_max.bind("<Return>", lambda e: self.on_entry_changed())

    panel_levels.columnconfigure(1, weight=1)

    # ==================== 畫布展示區 ====================
    self.plot_frame = ttk.Frame(root)
    self.plot_frame.pack(side=tk.BOTTOM, fill=tk.BOTH, expand=True)

  def load_image(self):
    path = filedialog.askopenfilename(
        title="選取薄膜表面圖片",
        filetypes=[("Image files", "*.jpg *.jpeg *.png *.tif *.tiff *.bmp")],
    )
    if path:
      self.image_path = path
      self.lbl_file.config(text=os.path.basename(path), foreground="black")

      img_array = np.fromfile(path, dtype=np.uint8)
      img_bgr = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
      self.img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
      self.img_gray = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY).astype(
          np.float32
      )

      self.compute_fft()
      self.btn_save.config(state=tk.NORMAL)

  def on_window_changed(self):
    self.compute_fft()

  def on_cmap_changed(self):
    if self.im_fft is not None:
      self.im_fft.set_cmap(self.var_cmap.get())
      self.canvas.draw_idle()

  def compute_fft(self):
    if self.img_gray is None:
      return

    h, w = self.img_gray.shape

    # 1. 背景光照校正
    bg = cv2.GaussianBlur(self.img_gray, (101, 101), 0)
    img_detrended = self.img_gray - bg

    # 2. 窗函數
    win_type = self.var_window.get()
    if win_type == "Hanning":
      win = np.outer(np.hanning(h), np.hanning(w))
      img_proc = img_detrended * win
    elif win_type == "Hamming":
      win = np.outer(np.hamming(h), np.hamming(w))
      img_proc = img_detrended * win
    else:
      img_proc = img_detrended

    # 3. 2D FFT
    f = np.fft.fftshift(np.fft.fft2(img_proc))
    self.mag_spectrum = 20 * np.log10(np.abs(f) + 1e-6)

    self.create_full_plot()

  def on_slider_min_drag(self, val):
    v_min = float(val)
    self.var_entry_min.set(f"{v_min:.2f}")
    self.apply_clim()

  def on_slider_max_drag(self, val):
    v_max = float(val)
    self.var_entry_max.set(f"{v_max:.2f}")
    self.apply_clim()

  def on_entry_changed(self):
    try:
      v_min = float(self.var_entry_min.get())
      v_max = float(self.var_entry_max.get())

      # 防呆邊界保護
      v_min = max(0.0, min(v_min, 99.9))
      v_max = max(0.1, min(v_max, 100.0))
      if v_min >= v_max:
        v_min = v_max - 0.1

      self.scale_min.set(v_min)
      self.scale_max.set(v_max)
      self.var_entry_min.set(f"{v_min:.2f}")
      self.var_entry_max.set(f"{v_max:.2f}")
      self.apply_clim()
    except ValueError:
      pass

  def apply_clim(self):
    if self.mag_spectrum is None or self.im_fft is None:
      return
    try:
      p_min = float(self.var_entry_min.get())
      p_max = float(self.var_entry_max.get())
      vmin = np.percentile(self.mag_spectrum, p_min)
      vmax = np.percentile(self.mag_spectrum, p_max)
      self.im_fft.set_clim(vmin=vmin, vmax=vmax)
      self.canvas.draw_idle()
    except Exception:
      pass

  def create_full_plot(self):
    if self.mag_spectrum is None or self.img_rgb is None:
      return

    try:
      p_min = float(self.var_entry_min.get())
      p_max = float(self.var_entry_max.get())
    except ValueError:
      p_min, p_max = 2.0, 99.8

    vmin = np.percentile(self.mag_spectrum, p_min)
    vmax = np.percentile(self.mag_spectrum, p_max)

    if self.canvas is not None:
      self.canvas.get_tk_widget().destroy()
      plt.close(self.fig)

    self.fig, self.axes = plt.subplots(1, 2, figsize=(10, 4.8), dpi=100)

    # 實空間
    self.axes[0].imshow(self.img_rgb)
    self.axes[0].set_title("Real Space", fontsize=11, fontweight="bold")
    self.axes[0].axis("off")

    # 頻域空間
    self.im_fft = self.axes[1].imshow(
        self.mag_spectrum, cmap=self.var_cmap.get(), vmin=vmin, vmax=vmax
    )
    self.axes[1].set_title("2D FFT Spectrum", fontsize=11, fontweight="bold")
    self.axes[1].axis("off")

    self.cbar = self.fig.colorbar(
        self.im_fft, ax=self.axes[1], fraction=0.046, pad=0.04
    )
    self.cbar.set_label("dB", fontsize=9)

    self.fig.tight_layout()

    self.canvas = FigureCanvasTkAgg(self.fig, master=self.plot_frame)
    self.canvas.draw()
    self.canvas.get_tk_widget().pack(fill=tk.BOTH, expand=True)

  def save_result(self):
    """只儲存轉換後且套用當前色盤與色階的純粹 FFT 正方形圖檔"""
    if self.mag_spectrum is None:
      return

    save_path = filedialog.asksaveasfilename(
        defaultextension=".png",
        filetypes=[("PNG Image", "*.png"), ("TIF Image", "*.tif")],
        initialfile="FFT_Only.png",
    )
    if save_path:
      # 讀取當前設定之動態範圍
      p_min = float(self.var_entry_min.get())
      p_max = float(self.var_entry_max.get())
      vmin = np.percentile(self.mag_spectrum, p_min)
      vmax = np.percentile(self.mag_spectrum, p_max)

      # 建立一個完全無邊框、無標題、無座標的純淨畫布
      h, w = self.mag_spectrum.shape
      fig_pure = plt.figure(figsize=(w / 100, h / 100), dpi=100, frameon=False)
      ax_pure = plt.Axes(fig_pure, [0.0, 0.0, 1.0, 1.0])
      ax_pure.set_axis_off()
      fig_pure.add_axes(ax_pure)

      # 繪製純頻譜並儲存
      ax_pure.imshow(
          self.mag_spectrum, cmap=self.var_cmap.get(), vmin=vmin, vmax=vmax
      )
      fig_pure.savefig(
          save_path, dpi=300, pad_inches=0.0, bbox_inches="tight", transparent=False
      )
      plt.close(fig_pure)

      messagebox.showinfo("成功", f"純 FFT 圖檔已儲存至：\n{save_path}")


if __name__ == "__main__":
  root = tk.Tk()
  app = FFTApp(root)
  root.mainloop()