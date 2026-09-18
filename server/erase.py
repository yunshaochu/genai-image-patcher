# -*- coding: utf-8 -*-
"""
erase.py
区域文字擦除（flood fill 洞检测 + inpaint），移植自
comic-text-translator-lite/scripts/whiten_regions.py 的选区去字算法，
只保留单个 ROI 裁剪图级别的处理（编辑器按区域裁剪后上传）：

  bubble 模式：中心平坦种子 flood fill 底色连通区 R（不预设气泡形状），
               文字 = R 的"洞"（边界不可达），inpaint 只修文字笔画，
               掩码膨胀被边界可达区 ext 挡住，不啃描边。
  free 模式：  中心+四边中点 5 个种子各自 flood fill，取面积最大者为背景，
               洞 = 文字。适合印在画面上的文字（text_free），对渐变背景稳。
"""
import math

import cv2
import numpy as np


def _flood_fill_region(gray, seeds, diff):
    """多种子 FIXED_RANGE flood fill 的并集（不修改 gray）"""
    h, w = gray.shape
    acc = np.zeros((h, w), bool)
    for seed in seeds:
        try:
            mask = np.zeros((h + 2, w + 2), np.uint8)
            flags = (cv2.FLOODFILL_MASK_ONLY | cv2.FLOODFILL_FIXED_RANGE
                     | 8 | (255 << 8))
            cv2.floodFill(gray.copy(), mask, (int(seed[0]), int(seed[1])), 0,
                          loDiff=diff, upDiff=diff, flags=flags)
            acc |= mask[1:-1, 1:-1] > 0
        except cv2.error:
            continue
    return acc


def _edge_reachable(inv):
    """在 ~R 上从 ROI 边界做 4 连通 flood fill → 外部可达区 ext。

    覆盖：气泡外背景、气泡描边、相邻气泡的一切（描边/底/字）。
    4 连通使得文字与描边的"对角粘连"不会让文字漏进 ext。
    """
    h, w = inv.shape
    mask = np.zeros((h + 2, w + 2), np.uint8)
    flags = cv2.FLOODFILL_MASK_ONLY | 4 | (255 << 8)
    work = (inv > 0).astype(np.uint8) * 255
    pts = []
    for x in range(0, w, max(1, w // 10)):
        pts += [(x, 0), (x, h - 1)]
    for y in range(0, h, max(1, h // 10)):
        pts += [(0, y), (w - 1, y)]
    for pt in pts:
        if 0 <= pt[1] < h and 0 <= pt[0] < w and work[pt[1], pt[0]] > 0:
            cv2.floodFill(work, mask, pt, 0, flags=flags)
    return mask[1:-1, 1:-1] > 0


def _flat_seeds_center(gray, max_seeds=5):
    """气泡中心区域找平坦底色种子点（避开文字笔画）"""
    h, w = gray.shape
    cy, cx = h // 2, w // 2
    bright = float(np.median(gray)) >= 128
    th = 190 if bright else 80
    seeds = []
    step = max(2, min(h, w) // 10)
    for r in range(0, min(h, w) // 2, step):
        n_ang = 1 if r == 0 else 8
        for k in range(n_ang):
            ang = math.radians(k * 360.0 / n_ang)
            y = int(cy + r * math.sin(ang))
            x = int(cx + r * math.cos(ang))
            if not (0 <= y < h and 0 <= x < w):
                continue
            patch = gray[max(0, y - 1):y + 2, max(0, x - 1):x + 2]
            if patch.size >= 4 and float(patch.std()) < 10 and float(patch.mean()) >= th:
                seeds.append((x, y))
                if len(seeds) >= max_seeds:
                    return seeds
    if not seeds:
        seeds.append((cx, cy))
    return seeds


def _inpaint_holes(bgr_roi, gray, R, dl, rad):
    """文字 = R 的洞 ∩ 与底色差异大；inpaint 两轮，掩码不越 ext（描边/外部）"""
    h, w = gray.shape
    if R is None or not R.any():
        return bgr_roi
    ext = _edge_reachable(~R)
    holes = (~R) & (~ext)
    if not holes.any():
        return bgr_roi

    med = float(np.median(gray[R]))
    dark_text = med >= 128
    if dark_text:
        text = holes & (gray < med - 50)
    else:
        text = holes & (gray > med + 50)
    if not text.any():
        return bgr_roi

    # 掩码膨胀抓抗锯齿边，但被 ext 挡住（不啃描边、不越界到邻气泡）
    m = cv2.dilate(text.astype(np.uint8),
                   np.ones((dl * 2 + 1, dl * 2 + 1), np.uint8))
    m = (m > 0) & (~ext)
    roi = cv2.inpaint(bgr_roi, (m.astype(np.uint8)) * 255, rad, cv2.INPAINT_TELEA)

    # 二轮：清文字附近的浅残留（同样不越 ext）
    g2 = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    near = cv2.dilate(text.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
    if dark_text:
        residue = near & (g2 < med - 35) & (~ext)
    else:
        residue = near & (g2 > med + 35) & (~ext)
    if residue.any():
        roi = cv2.inpaint(roi, (residue.astype(np.uint8)) * 255,
                          max(3, rad - 3), cv2.INPAINT_TELEA)
    return roi


def erase_bubble_roi(bgr_roi, dl=3, rad=6):
    """气泡区域擦除：中心平坦种子 flood fill 底色 → 洞 = 文字。

    flood fill 面积异常（描边破损泄漏/底色渐变断裂）时逐级收缩容差重试，
    全部失败才用接近全幅的椭圆兜底（保证覆盖，宁可保守）。
    """
    gray = cv2.cvtColor(bgr_roi, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    seeds = _flat_seeds_center(gray)
    R = None
    best = None
    for diff in (40, 22, 12):
        r = _flood_fill_region(gray, seeds, diff)
        frac = r.sum() / float(gray.size)
        if 0.08 <= frac <= 0.85:
            R = r
            break
        if best is None or r.sum() > best.sum():
            best = r
    if R is None:
        if best is not None and best.sum() / float(gray.size) <= 0.85:
            R = best
        else:
            yy, xx = np.ogrid[:h, :w]
            cx, cy = (w - 1) / 2, (h - 1) / 2
            rx, ry = max(1.0, w / 2 - 3), max(1.0, h / 2 - 3)
            R = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2 <= 1.0
    return _inpaint_holes(bgr_roi, gray, R, dl, rad)


def erase_free_roi_floodfill(bgr_roi, dl=3, rad=6):
    """text_free 擦除：中心+四边中点 5 个种子各自 flood fill，
    取面积最大者作为背景 R → 洞 = 文字。对渐变背景稳。"""
    gray = cv2.cvtColor(bgr_roi, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    cy, cx = h // 2, w // 2
    cand = [(cx, cy), (cx, 3), (cx, h - 4), (3, cy), (w - 4, cy)]
    best = None
    for s in cand:
        if not (0 <= s[1] < h and 0 <= s[0] < w):
            continue
        r = _flood_fill_region(gray, [s], 35)
        if best is None or r.sum() > best.sum():
            best = r
    return _inpaint_holes(bgr_roi, gray, best, dl, rad)
