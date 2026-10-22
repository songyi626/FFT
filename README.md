# HRTEM FFT Analyzer

HRTEM 影像 2D FFT（diffractogram）分析工具：空間校正、正方形 ROI 選取、在 FFT 上點選亮點量測 d-spacing 與晶面夾角。

**線上版（免安裝）：https://songyi626.github.io/FFT/**　影像只在瀏覽器裡處理，不會上傳。

*Compute 2D FFT diffractograms of HRTEM images with nm/pixel calibration, square ROI selection, and click-to-measure d-spacings and interplanar angles — in the browser, or as a Python desktop app.*

## 兩種版本

| | 線上版（`docs/`） | 桌面版（`hrtem_fft_analyzer.py`） |
|---|---|---|
| 安裝 | 不需要，打開網址即可 | Python + numpy / OpenCV / matplotlib |
| ROI 邊長 | 2 的冪次，最大 2048 | 2 的冪次或最大正方形 |
| 背景扣除 | 三次 box blur 近似高斯（差異僅在 DC 附近） | OpenCV 高斯模糊 |
| 其他 | 示範影像、ImageJ TIFF 自動讀取 nm/pixel、含標記 FFT 圖與 ROI 圖下載 | — |

兩者的處理流程、座標慣例與 CSV 格式相同。

## 功能

- **空間校正**：直接輸入 nm/pixel，或在實空間影像上點擊比例尺兩端後輸入實際長度
- **正方形 ROI**：選擇邊長（2ⁿ 或最大正方形），點擊影像移動 ROI，FFT 即時更新
- **d-spacing 量測**：左鍵點擊亮點，自動吸附至亮點中心並做次像素內插；右鍵刪除；同時標示 Friedel 對稱點
- **夾角與 d 比值**：表格中選取兩點即顯示夾角、補角與 d 比值，方便 indexing
- **影像前處理**：高斯背景扣除、Hanning / Hamming 窗函數
- **顯示**：FFT 軸以 nm⁻¹ 標示，滑鼠所在位置即時顯示 |k| 與 d；可調色盤與色階
- **匯出**：量測結果 CSV（含檔名、校正值、ROI、窗函數），以及純 FFT 圖（1 FFT 像素 = 1 圖檔像素）
- 支援 8-bit、16-bit、32-bit TIFF 與一般影像格式，支援中文路徑

## 安裝

需要 Python 3.8 以上（含 Tkinter，Windows / macOS 官方安裝程式已內建；Linux 可能需另外安裝 `python3-tk`）。

```bash
git clone https://github.com/songyi626/FFT.git
cd FFT
pip install -r requirements.txt
python hrtem_fft_analyzer.py
```

不使用 git 的話，也可以在 [repo 頁面](https://github.com/songyi626/FFT) 按 **Code → Download ZIP**，解壓縮後執行上面最後兩行。

## 使用流程

1. **📁 選擇圖片檔案** 載入 HRTEM 影像
2. **校正**：在「nm / pixel」輸入數值後按 Enter；或按「📏 由比例尺校正」，在左圖點比例尺兩端，再輸入長度 (nm)
3. **選 ROI**：選擇邊長，在左圖點擊要分析的區域（例如只框薄膜、或只框基板）
4. **量測**：在右側 FFT 圖左鍵點擊亮點；用 Ctrl + 點擊在表格中選取兩點以計算夾角
5. **匯出**：「📄 匯出量測 CSV」與「💾 下載純 FFT 圖檔」

> 工具列的放大 / 平移模式開啟時，點擊不會被當作量測或 ROI 移動；放大後請再按一次該按鈕關閉模式。

## 慣例與定義

- k 為空間頻率（cycles / nm，不含 2π），**d = 1 / |k|**
- 頻域解析度 Δk = 1 / (N · nm_per_px)，N 為 ROI 邊長；Nyquist 極限 d_min = 2 · nm_per_px
- FFT 顯示中 kᵧ 向上為正，方位角由 +kₓ 逆時針計算

## 驗證

`examples/make_synthetic_lattice.py` 會產生已知晶格的合成影像：

```bash
python examples/make_synthetic_lattice.py
```

預設輸出 `examples/synthetic_lattice.tif`（0.0125 nm/px，d = 0.583 nm，旋轉 17°）。載入後輸入 nm/pixel = 0.0125，點選亮點應得到 d ≈ 0.583 nm、方位角 ≈ 17° / 107°、兩點夾角 ≈ 90°。

## ⚠️ FFT 與 SAED 的差異

HRTEM 影像的 FFT 是**影像強度**的傅立葉轉換，不是電子繞射圖（SAED）：

- **可信**：亮點位置 → 晶面間距、晶面夾角、對稱性、帶軸判斷
- **不可信**：亮點強度（受物鏡 CTF、defocus、厚度調制），以及可能由影像非線性產生的交叉項（看起來像禁制反射）
- 可見的最高頻受顯微鏡 information limit 限制
- FFT 反映的是 ROI 內的局部結構，SAED 通常涵蓋大得多的區域

在報告或論文中建議稱為「FFT pattern」或「diffractogram」，而非 SAED。

## 授權

[MIT License](LICENSE) © 2026 Song-Yi Chan
