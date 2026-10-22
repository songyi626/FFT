"""產生一張已知晶格常數的合成 HRTEM 影像，用來驗證校正與 d-spacing 量測。

預設：0.0125 nm/px，兩組正交晶面 d = 0.583 nm，晶格旋轉 17°，
加上高斯雜訊與低頻背景。載入後輸入 nm/pixel = 0.0125，
點選亮點應得到 d ≈ 0.583 nm、方位角 ≈ 17° / 107°、夾角 ≈ 90°。

用法：
  python examples/make_synthetic_lattice.py            # 輸出 examples/synthetic_lattice.tif
  python examples/make_synthetic_lattice.py --d 0.29 --angle 0 --nmpx 0.01
"""

import argparse
import math
from pathlib import Path

import cv2
import numpy as np


def make_lattice(h, w, nm_per_px, d_nm, angle_deg, noise, seed=0):
  yy, xx = np.mgrid[0:h, 0:w] * nm_per_px
  th = math.radians(angle_deg)
  # 影像 y 軸向下，因此 y 分量取負號，使 FFT 顯示中 ky 向上為正
  g1 = np.array([math.cos(th), math.sin(th)]) / d_nm
  g2 = np.array([-math.sin(th), math.cos(th)]) / d_nm
  img = (np.cos(2 * np.pi * (g1[0] * xx - g1[1] * yy))
         + np.cos(2 * np.pi * (g2[0] * xx - g2[1] * yy)))
  img += 0.6 * np.exp(-((xx - xx.mean()) ** 2 + (yy - yy.mean()) ** 2)
                      / (2 * (0.4 * xx.max()) ** 2))  # 低頻背景
  img += np.random.default_rng(seed).normal(0, noise, img.shape)
  img = (img - img.min()) / (img.max() - img.min())
  return (img * 65535).astype(np.uint16)


def main():
  ap = argparse.ArgumentParser(description=__doc__,
                               formatter_class=argparse.RawDescriptionHelpFormatter)
  ap.add_argument("--nmpx", type=float, default=0.0125, help="nm / pixel")
  ap.add_argument("--d", type=float, default=0.583, help="晶面間距 (nm)")
  ap.add_argument("--angle", type=float, default=17.0, help="晶格旋轉角 (deg)")
  ap.add_argument("--size", type=int, nargs=2, default=(1200, 1600),
                  metavar=("H", "W"))
  ap.add_argument("--noise", type=float, default=0.75)
  ap.add_argument("-o", "--out", default=str(Path(__file__).with_name(
      "synthetic_lattice.tif")))
  a = ap.parse_args()

  img = make_lattice(a.size[0], a.size[1], a.nmpx, a.d, a.angle, a.noise)
  ok, buf = cv2.imencode(Path(a.out).suffix or ".tif", img)
  if not ok:
    raise SystemExit("影像編碼失敗")
  buf.tofile(a.out)  # 支援中文路徑
  print(f"已輸出 {a.out}  ({a.size[1]}x{a.size[0]}, {a.nmpx} nm/px, "
        f"d = {a.d} nm, {a.angle}°)")


if __name__ == "__main__":
  main()
