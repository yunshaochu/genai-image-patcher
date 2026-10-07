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
    """气泡中心区域找平坦底色种子点（避开文字笔画）。

    底色基准取中心区域（文字所在面）的中位数，而不是整图 median——
    整图 median 会被框外画面带偏（黑底旁白框外是亮场景 / 灰底气泡），
    导致极性判反、种子落到白色笔画上（整个擦除反相）。接受与中心底色
    接近（±40）的平坦 3x3：黑底、白底、中间灰底都适用。
    """
    h, w = gray.shape
    cy, cx = h // 2, w // 2
    q_h, q_w = h // 4, w // 4
    base = float(np.median(gray[q_h:max(q_h + 1, h - q_h),
                                q_w:max(q_w + 1, w - q_w)]))
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
            if (patch.size >= 4 and float(patch.std()) < 10
                    and abs(float(patch.mean()) - base) <= 40):
                seeds.append((x, y))
                if len(seeds) >= max_seeds:
                    return seeds
    if not seeds:
        seeds.append((cx, cy))
    return seeds


# 描边判定的最小亮度差：描边色与底色至少差这么多才算「一圈描边」，
# 低于这个量级就当作底色自身的渐变/网点噪声，不做额外处理。
_OUTLINE_MIN_DELTA = 12


def _outline_mask(gray, allowed, text, med, dark_text, dl):
    """文字描边（黑边/白边）掩码：文字与底色之间那一圈过渡色的连通区。

    宽描边会被 flood fill 吞掉 —— 描边色和底色只差几十灰度时同一个容差能
    一口气爬过去（此时描边并进 R），容差差一点时描边反倒整块成了「洞」。
    两种情况下「洞」里都只剩笔画本身，inpaint 修笔画时采样边界正好落在描边
    上，就补出一团描边色（白字擦完成白团）。所以这里在 allowed（= ~ext）
    里找描边，不管它有没有被并进 R。

    描边是给文字加对比用的，必然落在底色的另一侧：底色亮、文字暗，描边就亮
    （黑字配白边）；底色暗、文字亮，描边就暗。所以只从文字出发，沿「与文字
    反向偏离底色」的像素连通扩张 —— 不会顺着底色自己的渐变漏满整个气泡，
    也不会啃到气泡描边/框外画面。
    """
    side = 1.0 if dark_text else -1.0
    delta = (gray.astype(np.float32) - float(med)) * side
    cand = allowed & (delta > _OUTLINE_MIN_DELTA)
    if not cand.any():
        return np.zeros_like(text)

    # 起点：文字外扩 dl 圈（跨过笔画边缘的抗锯齿过渡带，落到描边上）里的候选像素
    k = np.ones((max(3, dl * 2 + 1),) * 2, np.uint8)
    seed = cand & (cv2.dilate(text.astype(np.uint8), k) > 0)
    if not seed.any():
        return np.zeros_like(text)

    # 与文字相连的那几块候选区就是描边；远处各自连通的候选区（底色渐变而已）不动
    num, labels = cv2.connectedComponents(cand.astype(np.uint8), connectivity=8)
    hit = np.zeros(num, bool)
    hit[np.unique(labels[seed])] = True
    hit[0] = False
    return hit[labels]


def _bgr_to_hex(bgr):
    """BGR 三元组 → '#rrggbb'（前端 CSS 直接用）。"""
    b, g, r = (int(v) for v in bgr[:3])
    clamp = lambda v: max(0, min(255, v))
    return '#%02x%02x%02x' % (clamp(r), clamp(g), clamp(b))


def _measure_text_stats(bgr_roi, text, R, dark_text):
    """从文字掩码里量出墨色 / 底色（供编辑器「自动取色」）。

    取色之所以准，是因为 `text` 已经是「与底色差 ±50 灰度」硬阈值后的核心笔画，
    抗锯齿过渡带（墨色与底色的混合）本来就落在阈值之外；样本够多时再往里腐蚀
    一圈，进一步甩掉边缘像素。逐通道取中位数而不是均值，避免个别残留噪声像素
    （反锯齿、网点、JPEG 块效应）把墨色拉偏。

    样本太少（<8 px）时认为量不准，返回 None，调用方回落到默认字色。
    """
    total = int(text.sum())
    if total < 8:
        return None
    core = text
    if total >= 64:
        eroded = cv2.erode(text.astype(np.uint8), np.ones((3, 3), np.uint8))
        if int(eroded.sum()) >= 8:
            core = eroded > 0

    stats = {
        'text_color': _bgr_to_hex(np.median(bgr_roi[core], axis=0)),
        'text_pixels': total,
        'text_ratio': round(total / float(text.size), 4),
        'inverted': bool(dark_text),
    }
    if R is not None and R.any():
        stats['bg_color'] = _bgr_to_hex(np.median(bgr_roi[R], axis=0))
    return stats


def _inpaint_holes(bgr_roi, gray, R, dl, rad):
    """文字 = R 的洞 ∩ 与底色差异大，再并上文字描边（见 _outline_mask）；
    inpaint 两轮，掩码不越 ext（气泡描边/框外画面）。

    返回 `(擦除后的 ROI, stats)`；stats 是这次的取色量测（没找到文字时为 None），
    量测必须在 inpaint 之前做 —— inpaint 之后笔画像素就没了。
    """
    h, w = gray.shape
    if R is None or not R.any():
        return bgr_roi, None
    ext = _edge_reachable(~R)
    holes = (~R) & (~ext)
    if not holes.any():
        return bgr_roi, None

    med = float(np.median(gray[R]))
    # 文字比底色「暗还是亮」**不能**看底色自身的明暗（med >= 128 就当亮底暗字）：
    # 中灰底 + 更亮的字（典型如灰紫气泡 156 + 白字 255）会被判反 ——
    # text = holes & (gray < med - 50) 里只剩个位数像素，整条擦除静默空转。
    # 改成看洞里的证据：两侧都比一遍，哪一侧的像素多就认哪一侧。
    dark = holes & (gray < med - 50)
    light = holes & (gray > med + 50)
    dark_text = int(dark.sum()) >= int(light.sum())
    text = dark if dark_text else light
    if not text.any():
        return bgr_roi, None

    stats = _measure_text_stats(bgr_roi, text, R, dark_text)

    # 文字 + 描边一起擦：只擦笔画的话，inpaint 的采样边界正好落在宽描边上，
    # 补出来的是描边色（白团）；描边掩码只往"与文字反向偏离底色"的方向长。
    erase_src = text | _outline_mask(gray, ~ext, text, med, dark_text, dl)

    # 掩码膨胀抓抗锯齿边，但被 ext 挡住（不啃气泡描边、不越界到邻气泡）
    m = cv2.dilate(erase_src.astype(np.uint8),
                   np.ones((dl * 2 + 1, dl * 2 + 1), np.uint8))
    m = (m > 0) & (~ext)
    roi = cv2.inpaint(bgr_roi, (m.astype(np.uint8)) * 255, rad, cv2.INPAINT_TELEA)

    # 二轮：清文字附近的浅残留（同样不越 ext）
    g2 = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
    near = cv2.dilate(erase_src.astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
    if dark_text:
        residue = near & (g2 < med - 35) & (~ext)
    else:
        residue = near & (g2 > med + 35) & (~ext)
    if residue.any():
        roi = cv2.inpaint(roi, (residue.astype(np.uint8)) * 255,
                          max(3, rad - 3), cv2.INPAINT_TELEA)
    return roi, stats


def _border_seeds(gray):
    """ROI 四边中点当种子：框完全落在底色里时，边框像素就是底色。"""
    h, w = gray.shape
    cy, cx = h // 2, w // 2
    return [(cx, 3), (cx, h - 4), (3, cy), (w - 4, cy)]


def _pick_bubble_bg(gray, seeds):
    """从给定种子选出「底色区」R。

    flood fill 面积异常（描边破损泄漏/底色渐变断裂）时逐级收缩容差重试；
    三档都没落进「合理面积」窗口时，用面积最大的那次 fill 当底色 ——
    与前端本地兜底算法（services/textErase.ts）同一套做法。

    返回 `(R, windowed)`：`windowed=False` 表示三档容差都没落进「合理面积」
    窗口，R 是兜底挑出来的 —— 调用方据此判断这个种子策略是不是没找对底色。
    """
    best = None
    for diff in (40, 22, 12):
        r = _flood_fill_region(gray, seeds, diff)
        frac = r.sum() / float(gray.size)
        if 0.08 <= frac <= 0.85:
            return r, True
        if best is None or r.sum() > best.sum():
            best = r

    # 窗口没命中时不能退回「内接椭圆」兜底（历史实现）：R = 椭圆时，椭圆外的
    # 一切都能从 ROI 边界连通到，于是全部落进 ext，holes = ~R & ~ext 成了空集，
    # inpaint 无掩码可修 —— 实测白底黑字（底色占比 0.92+，最普通的一种情形）
    # 就是这样被一个像素都擦不掉的。
    #
    # 只有连最大那次 fill 都几乎吞掉整块 ROI（≥99.5%）时才退回椭圆：那说明填充
    # 顺着抗锯齿/渐变把文字一起爬过去了，拿它当底色本来也没有洞可修。
    best_frac = best.sum() / float(gray.size) if best is not None else 0.0
    if best is not None and best_frac < 0.995:
        return best, False

    h, w = gray.shape
    yy, xx = np.ogrid[:h, :w]
    cx, cy = (w - 1) / 2, (h - 1) / 2
    rx, ry = max(1.0, w / 2 - 3), max(1.0, h / 2 - 3)
    return ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2 <= 1.0, False


def erase_bubble_roi(bgr_roi, dl=3, rad=6):
    """气泡区域擦除：flood fill 底色 → 洞 = 文字。

    只用中心平坦种子在「框比文字大一圈」时最稳；框紧贴文字时会失效：框里大半
    是字，中心区中位数就成了文字色，平坦种子落在笔画上 → R 退化成文字本身（实测
    只覆盖 4.5%），其余像素全部「边界可达」→ 洞只剩十几个像素 → 擦掉一片垃圾、
    一个字都没动。所以中心种子没能找到「面积合理」的底色时，改用四边中点当种子
    再来一次（框在底色里时，边框就是底色），那次找到合理底色才采纳。

    返回 `(擦除后的 ROI, stats)`，stats 见 _measure_text_stats。
    """
    gray = cv2.cvtColor(bgr_roi, cv2.COLOR_BGR2GRAY)

    R, windowed = _pick_bubble_bg(gray, _flat_seeds_center(gray))
    roi, stats = _inpaint_holes(bgr_roi, gray, R, dl, rad)
    # 中心种子找对了底色就到此为止（找到的掩码太小也视为没找对：实测退化的那次
    # text_ratio 只有 0.002，正常情形都在 0.03 以上）。
    if windowed and stats is not None and stats.get('text_ratio', 0) >= 0.01:
        return roi, stats

    R2, windowed2 = _pick_bubble_bg(gray, _border_seeds(gray))
    if windowed2:
        return _inpaint_holes(bgr_roi, gray, R2, dl, rad)
    return roi, stats


def erase_free_roi_floodfill(bgr_roi, dl=3, rad=6):
    """text_free 擦除：中心+四边中点 5 个种子各自 flood fill 取并集作为背景 R
    → 洞 = 文字。对渐变背景稳。

    并集而不是"面积最大者"：印在画面上的字，背景常由几块色调不同的区域拼成
    （天空/地面/网点/描线），只留最大的那一块，其余区域就成了"边界可达"的
    外部 —— 文字一旦和它们相连（比如字压在某块底色差异大的画面元素上），整块
    文字会被划进 ext，一个像素都擦不掉。种子落在文字上时那一次 fill 很小，
    并集不会被带偏。

    返回 `(擦除后的 ROI, stats)`，stats 见 _measure_text_stats。
    """
    gray = cv2.cvtColor(bgr_roi, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    cy, cx = h // 2, w // 2
    cand = [(cx, cy), (cx, 3), (cx, h - 4), (3, cy), (w - 4, cy)]
    return _inpaint_holes(bgr_roi, gray, _flood_fill_region(gray, cand, 35), dl, rad)
