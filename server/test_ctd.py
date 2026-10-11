# -*- coding: utf-8 -*-
"""
test_ctd.py — 手动验证 comic-text-detector 掩码 × RT-DETR 检测框 × erase 联动

用法：
  python test_ctd.py <漫画页图片> [输出图路径]
  python test_ctd.py                # 无参数时生成一张合成页做管线冒烟测试

流程与 /detect + /erase 完全一致：
  1. RT-DETR 检测文本框（ogkalu/comic-text-and-bubble-detector）
  2. comic-text-detector 整页文字掩码，逐框取交集（外扩 4px）；
     框内无掩码像素的按误检丢弃
  3. 对每个留下的框：裁 ROI（掩码同步裁剪对齐）跑 erase（掩码并集模式），
     擦除结果贴回整页

输出：
  - 可视化图：原图叠掩码（绿色半透明）+ 框（绿=保留，红=因无掩码被丢弃）
  - 擦除结果图：所有文本框擦除后的整页
  - 控制台打印各阶段耗时与每框掩码像素数
"""
import base64
import sys
import time
from pathlib import Path

import cv2
import numpy as np

import comic_text_seg
from erase import erase_bubble_roi, erase_free_roi_floodfill
from inference_rtdetr import ComicDetector

MASK_PAD = 4   # 与 app.attach_text_masks 保持一致


def make_synthetic_page():
    """合成一张粗糙的"漫画页"：白底 + 两个气泡 + 黑字，用于冒烟测试。"""
    page = np.full((900, 700, 3), 255, np.uint8)
    cv2.ellipse(page, (200, 200), (150, 95), 0, 0, 360, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.ellipse(page, (200, 200), (148, 93), 0, 0, 360, (255, 255, 255), -1)
    cv2.putText(page, 'HELLO WORLD', (110, 185), cv2.FONT_HERSHEY_SIMPLEX,
                0.7, (0, 0, 0), 2, cv2.LINE_AA)
    cv2.putText(page, '....', (140, 235), cv2.FONT_HERSHEY_SIMPLEX,
                0.9, (0, 0, 0), 2, cv2.LINE_AA)
    cv2.ellipse(page, (500, 550), (140, 85), 0, 0, 360, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.ellipse(page, (500, 550), (138, 83), 0, 0, 360, (255, 255, 255), -1)
    cv2.putText(page, 'TEST 123', (430, 565), cv2.FONT_HERSHEY_SIMPLEX,
                0.7, (0, 0, 0), 2, cv2.LINE_AA)
    return page


def encode_mask_png(mask):
    ok, buf = cv2.imencode('.png', mask.astype(np.uint8) * 255)
    return base64.b64encode(buf.tobytes()).decode('ascii')


def main():
    if len(sys.argv) > 1:
        img = cv2.imread(sys.argv[1], cv2.IMREAD_COLOR)
        if img is None:
            print(f'读不了图片: {sys.argv[1]}')
            sys.exit(1)
        out_path = sys.argv[2] if len(sys.argv) > 2 else \
            str(Path(sys.argv[1]).with_name('test_ctd_result'))
    else:
        print('未提供图片，用合成页做冒烟测试（真实效果请传漫画页路径）')
        img = make_synthetic_page()
        out_path = 'test_ctd_result'

    # 1. RT-DETR 检测
    detector = ComicDetector()
    t0 = time.time()
    detections = detector.detect(img)
    t_det = time.time() - t0
    print(f'\n[1] RT-DETR: {len(detections)} boxes in {t_det * 1000:.0f} ms')
    for d in detections:
        print(f'    {d.class_name:<12} conf={d.confidence:.2f} bbox={d.bbox}')

    # 2. CTD 整页掩码
    t0 = time.time()
    mask = comic_text_seg.detect_text_mask(img)
    t_seg = time.time() - t0
    print(f'[2] CTD mask: {int(mask.sum())} text px in {t_seg * 1000:.0f} ms')

    # 3. 框-掩码配对（与 app.attach_text_masks 同逻辑）
    h, w = img.shape[:2]
    kept, dropped = [], []
    for d in detections:
        if d.class_name not in ('text_bubble', 'text_free'):
            continue
        x1, y1, x2, y2 = d.bbox
        ex1, ey1 = max(0, x1 - MASK_PAD), max(0, y1 - MASK_PAD)
        ex2, ey2 = min(w, x2 + MASK_PAD), min(h, y2 + MASK_PAD)
        sub = mask[ey1:ey2, ex1:ex2]
        if not sub.any():
            dropped.append(d)
            continue
        d.crop = (ex1, ey1, ex2, ey2)
        d.mask_b64 = encode_mask_png(sub)
        kept.append(d)
    print(f'[3] 配对: {len(kept)} 保留 / {len(dropped)} 丢弃(框内无掩码)')
    for d in dropped:
        print(f'    DROPPED {d.class_name} conf={d.confidence:.2f} bbox={d.bbox}')

    # 4. 逐框擦除（掩码并集），贴回整页
    erased = img.copy()
    overlay = img.copy()
    overlay[mask] = (0, 255, 0)
    vis = cv2.addWeighted(overlay, 0.45, img, 0.55, 0)
    for i, d in enumerate(kept):
        ex1, ey1, ex2, ey2 = d.crop
        crop = img[ey1:ey2, ex1:ex2].copy()
        mbuf = np.frombuffer(base64.b64decode(d.mask_b64), np.uint8)
        m = cv2.imdecode(mbuf, cv2.IMREAD_GRAYSCALE)
        text_mask = (m > 127) if (m is not None and m.shape == crop.shape[:2]) else None
        t0 = time.time()
        if d.class_name == 'text_free':
            out, stats = erase_free_roi_floodfill(crop, 3, 6, text_mask=text_mask)
        else:
            out, stats = erase_bubble_roi(crop, 3, 6, text_mask=text_mask)
        t_er = (time.time() - t0) * 1000
        px = int(text_mask.sum()) if text_mask is not None else 0
        print(f'    erase #{i} {d.class_name:<12} mask_px={px:<6} '
              f'{t_er:.0f} ms stats={stats}')
        erased[ey1:ey2, ex1:ex2] = out
        cv2.rectangle(vis, (d.bbox[0], d.bbox[1]), (d.bbox[2], d.bbox[3]),
                      (0, 200, 0), 2)
    for d in dropped:
        cv2.rectangle(vis, (d.bbox[0], d.bbox[1]), (d.bbox[2], d.bbox[3]),
                      (0, 0, 255), 2)
        cv2.putText(vis, 'dropped', (d.bbox[0], max(12, d.bbox[1] - 4)),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 255), 1)

    print(f'\n[done] RT-DETR {t_det * 1000:.0f} ms + CTD {t_seg * 1000:.0f} ms')
    vis_path = out_path + '_vis.png'
    erased_path = out_path + '_erased.png'
    cv2.imwrite(vis_path, vis)
    cv2.imwrite(erased_path, erased)
    print(f'  可视化: {vis_path}  (绿=CTD掩码, 绿框=保留, 红框=误检丢弃)')
    print(f'  擦除结果: {erased_path}')


if __name__ == '__main__':
    main()
