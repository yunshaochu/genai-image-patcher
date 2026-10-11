# -*- coding: utf-8 -*-
"""
comic_text_seg.py
dmMaze/comic-text-detector 文字像素掩码推理（ONNX，cv2.dnn 后端，零新依赖）。

模型文件 comictextdetector.pt.onnx（约 90MB）来自 manga-image-translator 的
beta-0.2.1 release（comic-text-detector README 指定的官方下载点）。首次使用
自动下载到 server/model/，也可以手动把文件放进去跳过下载。

推理管线对齐上游 inference.py 的 OpenCV 路径（TextDetBaseDNN）：
  RGB → letterbox 到 64 的倍数 → blobFromImage(1/255) → forward 出三个张量
  (blks, mask, lines_map)。mask 是已内置 sigmoid 的文字像素概率图，去掉
  letterbox padding、resize 回原图、阈值二值化即得掩码。
本模块只取 mask；文本块定位交给 RT-DETR（ogkalu），blks 输出不用。
"""
import os
import threading
import time
import urllib.request
from pathlib import Path

import cv2
import numpy as np

MODEL_FILENAME = 'comictextdetector.pt.onnx'
MODEL_URLS = [
    'https://github.com/zyddnys/manga-image-translator/releases/download/beta-0.2.1/comictextdetector.pt.onnx',
]
# 上游 TextDetector 的默认输入。注意：导出的 ONNX 里有固定尺寸的 Reshape 层，
# 只能跑 1024×1024（换尺寸 cv2.dnn 会报 outTotal == inpTotal 断言错误）
DEFAULT_INPUT_SIZE = 1024
# 掩码概率阈值：偏保守（低）以保住细笔画/小字，反正后面还要和洞检测取并集
DEFAULT_THRESH = 0.35

_lock = threading.Lock()
_net = None
_out_names = None


def model_path():
    return Path(__file__).parent / 'model' / MODEL_FILENAME


def status():
    """供 /health 汇报：模型文件是否已缓存、推理网络是否已加载。"""
    path = model_path()
    return {
        'model_file': str(path),
        'cached': path.exists() and path.stat().st_size > 1024 * 1024,
        'loaded': _net is not None,
    }


def _download():
    path = model_path()
    if path.exists() and path.stat().st_size > 1024 * 1024:
        return path
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = str(path) + '.part'
    last_err = None
    for url in MODEL_URLS:
        try:
            print(f'[text-seg] downloading comic-text-detector <- {url}')
            print('[text-seg] 约 90MB，首次会等一会儿；也可以手动下载后放到 '
                  f'{path}')
            t0 = time.time()
            req = urllib.request.Request(
                url, headers={'User-Agent': 'BananaChange/1.0 (+model cache)'})
            done = 0
            last_report = 0
            with urllib.request.urlopen(req, timeout=120) as resp, \
                    open(tmp, 'wb') as f:
                while True:
                    chunk = resp.read(1 << 20)
                    if not chunk:
                        break
                    f.write(chunk)
                    done += len(chunk)
                    if done - last_report >= 8 << 20:
                        last_report = done
                        print(f'[text-seg]   {done >> 20} MB ...')
            os.replace(tmp, str(path))
            print(f'[text-seg] downloaded {done >> 20} MB in '
                  f'{time.time() - t0:.1f}s -> {path}')
            return path
        except Exception as e:
            last_err = e
            print(f'[text-seg] download failed ({type(e).__name__}: {e}): {url}')
    raise RuntimeError(f'comic-text-detector 模型下载失败: {last_err}；'
                       f'请手动下载 {MODEL_URLS[0]} 并放到 {path}')


def _load():
    global _net, _out_names
    if _net is not None:
        return _net
    with _lock:
        if _net is None:
            path = _download()
            print(f'[text-seg] loading ONNX via cv2.dnn: {path}')
            t0 = time.time()
            net = cv2.dnn.readNetFromONNX(str(path))
            _net = net
            _out_names = net.getUnconnectedOutLayersNames()
            print(f'[text-seg] model loaded in {time.time() - t0:.1f}s')
    return _net


def ensure_model():
    """预加载入口（app 启动时后台线程调用）：缺模型就下载，然后加载进内存。"""
    _load()


def _letterbox(img, size):
    """等比缩放到 size 内（只缩小不放大）、右/下补灰边到 size×size。

    上游用 YOLOv5 letterbox（上下对称补边）再在还原时做近似裁切；这里改成
    只往右/下补边，掩码还原时 [:nh, :nw] 精确去掉 padding，无对齐误差。

    小图不放大：编辑器裁出来的小 ROI（比如 68×174）放大 ~6 倍后笔画粗了
    6 倍，远超模型在整页 1024 上见过的文字尺度，分割反而失效（实测 68px
    宽的气泡只 seg 出 69px 掩码）；原生尺度恰好等于整页缩到 1024 后文字的
    典型大小，直接 pad 即可。
    """
    h, w = img.shape[:2]
    scale = min(1.0, size / h, size / w)
    nh, nw = round(h * scale), round(w * scale)
    interp = cv2.INTER_AREA if scale < 1 else cv2.INTER_LINEAR
    resized = cv2.resize(img, (nw, nh), interpolation=interp) if scale != 1 else img
    out = np.full((size, size, 3), 114, np.uint8)
    out[:nh, :nw] = resized
    return out, nh, nw


def _pick_seg_outputs(outs, size):
    """从 forward 输出里认出 (mask, lines_map)。

    正常顺序是 (blks, mask, lines_map)：mask 单通道（文字 seg 概率图），
    lines_map 双通道（DBNet shrink+threshold）。某些 OpenCV 版本会把这两者
    顺序颠倒（上游就是靠 shape[1]==2 判断的），这里按通道数认，不依赖顺序。
    """
    four_d = [o for o in outs
              if o.ndim == 4 and o.shape[-1] == size and o.shape[-2] == size]
    if len(four_d) < 2:
        raise RuntimeError(
            f'unexpected comic-text-detector outputs: '
            f'{[np.asarray(o).shape for o in outs]}')
    m1, m2 = four_d[-2], four_d[-1]
    if m1.shape[1] == 2:        # 顺序颠倒的版本
        return m2, m1
    return m1, m2


def detect_text_mask(img_bgr, thresh=DEFAULT_THRESH,
                     input_size=DEFAULT_INPUT_SIZE):
    """整图文字像素掩码。

    Args:
        img_bgr: BGR 图（np.uint8）
        thresh: 概率二值化阈值
        input_size: letterbox 目标边长（64 的倍数）

    Returns:
        与原图同尺寸的 bool 掩码（True = 文字像素）。模型未就绪/推理失败时
        抛异常，由调用方决定是否回落到纯启发式。
    """
    net = _load()
    h, w = img_bgr.shape[:2]
    rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
    lb, nh, nw = _letterbox(rgb, input_size)
    blob = cv2.dnn.blobFromImage(
        lb, scalefactor=1 / 255.0, size=(input_size, input_size),
        mean=(0, 0, 0), swapRB=False, crop=False)
    net.setInput(blob)
    outs = net.forward(_out_names)
    mask, _lines = _pick_seg_outputs(outs, input_size)

    seg = np.asarray(mask)[0, 0]
    seg = seg[:nh, :nw]
    seg = cv2.resize(seg, (w, h), interpolation=cv2.INTER_LINEAR)
    return seg > thresh
