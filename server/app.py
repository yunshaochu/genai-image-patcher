# -*- coding: utf-8 -*-
"""
BananaChange 统一后端服务
========================

一个端口整合漫画处理所需的 Python 能力：

  GET  /health   健康检查（检测模型状态）
  POST /detect   RT-DETR 文本/气泡检测（与 comic-detector 服务契约一致）
  POST /erase    区域文字擦除（flood fill 洞检测 + OpenCV inpaint）
  GET  /fonts    编辑器可用字体列表（含是否已缓存到本地）
  GET  /fonts/<id>  字体文件：首次请求时从上游下载并缓存到 server/fonts/

后续扩展：自动翻译、嵌字排版也加在本服务内。

启动：python app.py   （默认监听 0.0.0.0:5001）
"""
import base64
import io
import json
import os
import threading
import urllib.request

import cv2
import numpy as np
from flask import Flask, Response, jsonify, request, send_file
from flask_cors import CORS

from erase import erase_bubble_roi, erase_free_roi_floodfill
from inference_rtdetr import CLASS_NAMES, ComicDetector


class NumpyEncoder(json.JSONEncoder):
    """Numpy 类型 JSON 编码器"""
    def default(self, obj):
        if isinstance(obj, np.integer):
            return int(obj)
        elif isinstance(obj, np.floating):
            return float(obj)
        elif isinstance(obj, np.ndarray):
            return obj.tolist()
        return super().default(obj)


app = Flask(__name__)
# expose_headers：/erase 把实测取色的结果放在响应头里（body 必须保持
# image/png 二进制），跨域时浏览器默认读不到非简单响应头，必须在 CORS 里显式
# 暴露，否则前端 resp.headers.get('X-Text-Color') 永远是 null。
CORS(app, resources={r"/*": {"origins": "*"}}, expose_headers=[
    'X-Text-Color', 'X-Bg-Color', 'X-Text-Ratio',
])
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB

ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'}

# 全局模型实例（懒加载，首次 /detect 时载入）
detector = None
# 模型加载锁：防止并发请求同时进入加载流程，导致重复加载
_model_lock = threading.Lock()

import torch
model_config = {
    'model_name': 'ogkalu/comic-text-and-bubble-detector',
    'device': 'cuda' if torch.cuda.is_available() else 'cpu',
    'conf_threshold': 0.5,
    'classes': CLASS_NAMES,
}


def init_model():
    """
    初始化检测模型（线程安全，保证只加载一次）。

    双重检查 + 锁：并发请求不会重复加载模型；加载失败时不缓存实例，
    后续请求会自动重试。
    """
    global detector
    if detector is not None:
        return detector
    with _model_lock:
        # 拿到锁后再检查一次：可能已被其他线程加载完成
        if detector is None:
            print(f"Loading RT-DETR model: {model_config['model_name']}")
            print(f"Device: {model_config['device']}")
            detector = ComicDetector(
                model_name=model_config['model_name'],
                device=model_config['device'],
                conf_threshold=model_config['conf_threshold']
            )
            print("Model loaded successfully!")
    return detector


def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS


def decode_base64_image(image_data):
    """解码base64图像"""
    if image_data.startswith('data:image'):
        image_data = image_data.split(',')[1]
    img_data = base64.b64decode(image_data)
    nparr = np.frombuffer(img_data, np.uint8)
    return cv2.imdecode(nparr, cv2.IMREAD_COLOR)


def read_request_image():
    """从请求中读取图片：multipart 文件 或 JSON base64。失败返回 None。"""
    if 'image' in request.files:
        file = request.files['image']
        if file.filename == '' or not allowed_file(file.filename):
            return None
        nparr = np.frombuffer(file.read(), np.uint8)
        return cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    if request.is_json:
        data = request.get_json()
        if 'image' in data:
            return decode_base64_image(data['image'])
    return None


def json_error(msg, status=400):
    return Response(json.dumps({'success': False, 'error': msg}, ensure_ascii=False),
                    status=status, mimetype='application/json')


# ── 编辑器字体（下载 → 本地缓存 → 前端按需取用） ──────────────
#
# 前端每换一次字体就自己去国外 CDN 下载很麻烦（慢且容易失败），所以这里做一层
# “字体代理”：第一次请求时从上游下载并落盘到 server/fonts/，之后所有请求直接
# 由本服务返回；前端浏览器还会再缓存一层（Cache-Control），所以正常使用下来只
# 有第一次会真的产生网络下载。

FONT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fonts')

# 每个字体给出多个上游镜像，按顺序尝试（jsDelivr 走 Cloudflare，国内外基本可达；
# GitHub raw 作为备份）。
FONT_LIBRARY = {
    'zcool-kuaile': {
        'name': '站酷快乐体',
        'name_en': 'ZCOOL KuaiLe',
        'family': 'ZCOOL KuaiLe',
        'filename': 'ZCOOLKuaiLe-Regular.ttf',
        'urls': [
            'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/zcoolkuaile/ZCOOLKuaiLe-Regular.ttf',
            'https://fastly.jsdelivr.net/gh/google/fonts@main/ofl/zcoolkuaile/ZCOOLKuaiLe-Regular.ttf',
            'https://raw.githubusercontent.com/google/fonts/main/ofl/zcoolkuaile/ZCOOLKuaiLe-Regular.ttf',
        ],
    },
    'mashanzheng': {
        'name': '马善政毛笔楷书',
        'name_en': 'Ma Shan Zheng',
        'family': 'Ma Shan Zheng',
        'filename': 'MaShanZheng-Regular.ttf',
        'urls': [
            'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/mashanzheng/MaShanZheng-Regular.ttf',
            'https://fastly.jsdelivr.net/gh/google/fonts@main/ofl/mashanzheng/MaShanZheng-Regular.ttf',
            'https://raw.githubusercontent.com/google/fonts/main/ofl/mashanzheng/MaShanZheng-Regular.ttf',
        ],
    },
}

# TTF / OTF / TTC / WOFF 的文件头，用来识别下载到的是不是真字体（镜像偶尔会回
# 一个 HTML 错误页，长度检查挡不住）。
_FONT_MAGIC = (b'\x00\x01\x00\x00', b'OTTO', b'true', b'ttcf', b'wOFF')

_font_locks = {}
_font_locks_guard = threading.Lock()


def _font_lock(font_id):
    with _font_locks_guard:
        if font_id not in _font_locks:
            _font_locks[font_id] = threading.Lock()
        return _font_locks[font_id]


def _font_path(font_id):
    return os.path.join(FONT_DIR, FONT_LIBRARY[font_id]['filename'])


def ensure_font_file(font_id):
    """
    保证字体已缓存到本地，返回文件路径；失败抛异常。

    双重检查 + 每字体一把锁：并发请求不会重复下载同一个字体。
    """
    path = _font_path(font_id)
    if os.path.exists(path) and os.path.getsize(path) > 4096:
        return path

    with _font_lock(font_id):
        if os.path.exists(path) and os.path.getsize(path) > 4096:
            return path

        os.makedirs(FONT_DIR, exist_ok=True)
        last_err = None
        for url in FONT_LIBRARY[font_id]['urls']:
            try:
                print(f"[font] downloading {font_id} <- {url}")
                req = urllib.request.Request(
                    url, headers={'User-Agent': 'BananaChange/1.0 (+font cache)'})
                with urllib.request.urlopen(req, timeout=60) as resp:
                    data = resp.read()
                if len(data) < 4096 or data[:4] not in _FONT_MAGIC:
                    raise ValueError(f'not a font file ({len(data)} bytes)')
                tmp = path + '.part'
                with open(tmp, 'wb') as f:
                    f.write(data)
                os.replace(tmp, path)
                print(f"[font] cached {font_id} -> {path} ({len(data)} bytes)")
                return path
            except Exception as e:
                last_err = e
                print(f"[font] mirror failed ({type(e).__name__}: {e}): {url}")
        raise RuntimeError(f'font download failed for {font_id}: {last_err}')


# ── /health ─────────────────────────────────────────────────

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'device': model_config['device'],
        'model': model_config['model_name'],
        'model_loaded': detector is not None,
        'endpoints': ['/detect', '/erase', '/fonts', '/fonts/<id>'],
    })


# ── /fonts ──────────────────────────────────────────────────

@app.route('/fonts', methods=['GET'])
def list_fonts():
    """
    编辑器可用字体列表。

    返回：{success, fonts:[{id, name, name_en, family, cached, size, url}]}
    `cached=false` 表示该字体还没下过，前端第一次取用时后端会去下载。
    """
    fonts = []
    for font_id, meta in FONT_LIBRARY.items():
        path = _font_path(font_id)
        cached = os.path.exists(path) and os.path.getsize(path) > 4096
        fonts.append({
            'id': font_id,
            'name': meta['name'],
            'name_en': meta['name_en'],
            'family': meta['family'],
            'cached': cached,
            'size': os.path.getsize(path) if cached else None,
            'url': f'/fonts/{font_id}',
        })
    return jsonify({'success': True, 'fonts': fonts})


@app.route('/fonts/<font_id>', methods=['GET'])
def get_font(font_id):
    """
    返回字体文件本体（ttf）。首次请求时从上游下载并缓存，之后直接读本地文件。

    响应带 Cache-Control: public, max-age=604800，浏览器端也会缓存一份，
    所以正常情况下只有第一次会真正等待下载。
    """
    if font_id not in FONT_LIBRARY:
        return json_error(f'unknown font: {font_id}', 404)
    try:
        path = ensure_font_file(font_id)
    except Exception as e:
        import traceback
        traceback.print_exc()
        return json_error(f'{type(e).__name__}: {e}', 502)

    resp = send_file(path, mimetype='font/ttf', conditional=True)
    resp.headers['Cache-Control'] = 'public, max-age=604800'
    return resp


# ── /detect ─────────────────────────────────────────────────

@app.route('/detect', methods=['POST'])
def detect():
    """
    检测图片中的文本和气泡。

    输入：multipart/form-data 上传图片文件，或 JSON base64。
    参数：conf_threshold (默认0.5)、filter_classes（逗号分隔，可选）。
    返回：{success, image_size, detections:[{bbox,class_id,class_name,confidence,...}]}
    """
    try:
        det = init_model()

        conf_threshold = model_config['conf_threshold']
        filter_classes = None

        if request.is_json:
            data = request.get_json()
            conf_threshold = data.get('conf_threshold', conf_threshold)
            filter_classes = data.get('filter_classes')
        elif request.form:
            conf_threshold = float(request.form.get('conf_threshold', conf_threshold))
            filter_classes_str = request.form.get('filter_classes')
            if filter_classes_str:
                filter_classes = [c.strip() for c in filter_classes_str.split(',')]

        img = read_request_image()
        if img is None:
            return json_error('Failed to decode image (or no image provided)')

        detections = det.detect(img, conf_threshold=conf_threshold,
                                filter_classes=filter_classes)

        class_counts = {'bubble': 0, 'text_bubble': 0, 'text_free': 0}
        for d in detections:
            if d.class_name in class_counts:
                class_counts[d.class_name] += 1

        result = {
            'success': True,
            'image_size': {'height': int(img.shape[0]), 'width': int(img.shape[1])},
            'conf_threshold': conf_threshold,
            'filter_classes': filter_classes,
            'total_detections': len(detections),
            'class_counts': class_counts,
            'detections': [d.to_dict() for d in detections],
        }
        return Response(json.dumps(result, ensure_ascii=False, cls=NumpyEncoder),
                        mimetype='application/json')

    except Exception as e:
        import traceback
        traceback.print_exc()
        return json_error(f'{type(e).__name__}: {e}', 500)


# ── /erase ──────────────────────────────────────────────────

@app.route('/erase', methods=['POST'])
def erase():
    """
    擦除单个区域裁剪图中的文字（编辑器按区域裁剪后上传）。

    输入（multipart/form-data）：
      - image: 区域裁剪图（必填）
      - kind:  bubble(默认，气泡内文字) | free(印在画面上的文字 text_free)
      - dilate: 文字掩码膨胀核半径，默认 3
      - inpaint_radius: inpaint 修复半径，默认 6

    返回：image/png 二进制（与原图同尺寸）；失败返回 JSON {success:false,error}

    顺带取色（不额外花时间：文字掩码本来就要算）——擦除时量到的原文墨色 / 底色
    放在响应头里（没有文字时这些头不出现）：
      - X-Text-Color: '#rrggbb' 原文墨色（嵌字可直接沿用）
      - X-Bg-Color:   '#rrggbb' 文字所在底色
      - X-Text-Ratio: 0~1 文字像素占 ROI 的比例（过低说明样本不可靠）
    """
    try:
        kind = request.form.get('kind', 'bubble')
        dilate = int(request.form.get('dilate', 3))
        inpaint_radius = int(request.form.get('inpaint_radius', 6))

        img = read_request_image()
        if img is None:
            return json_error('Failed to decode image (or no image provided)')
        if img.shape[0] < 4 or img.shape[1] < 4:
            return json_error('Image too small')

        if kind == 'free':
            out, stats = erase_free_roi_floodfill(img.copy(), dilate, inpaint_radius)
        else:
            out, stats = erase_bubble_roi(img.copy(), dilate, inpaint_radius)

        ok, buf = cv2.imencode('.png', out)
        if not ok:
            return json_error('Failed to encode result', 500)
        resp = send_file(io.BytesIO(buf.tobytes()), mimetype='image/png')
        # 取色结果走响应头：body 必须保持 image/png 二进制（见 processing.md 的
        # base64 → Object URL 迁移），塞进 JSON 会让体积 +33%、又要退回那次治理。
        # 头是 ASCII，没有编码问题；旧客户端不认识这些头会直接忽略。
        if stats:
            resp.headers['X-Text-Color'] = stats.get('text_color', '')
            if stats.get('bg_color'):
                resp.headers['X-Bg-Color'] = stats['bg_color']
            resp.headers['X-Text-Ratio'] = str(stats.get('text_ratio', ''))
        return resp

    except Exception as e:
        import traceback
        traceback.print_exc()
        return json_error(f'{type(e).__name__}: {e}', 500)


if __name__ == '__main__':
    print("=" * 60)
    print("BananaChange 统一后端服务")
    print("=" * 60)
    print(f"Detection Model: {model_config['model_name']}")
    print(f"Device: {model_config['device']}")
    print("Listening on http://0.0.0.0:5001")
    print("\nAvailable endpoints:")
    print("  GET  /health  - 健康检查")
    print("  POST /detect  - 文本/气泡检测 (RT-DETR)")
    print("  POST /erase   - 区域文字擦除 (flood fill + inpaint)")
    print("  GET  /fonts   - 编辑器字体列表")
    print("  GET  /fonts/<id> - 字体文件（首次自动下载并缓存）")
    print("=" * 60)

    # 启动时预加载模型：避免首个 /detect 请求等待过久、并发导入竞争
    try:
        init_model()
    except Exception as e:
        import traceback
        traceback.print_exc()
        print(f"[WARN] 模型预加载失败，将在首次 /detect 时重试: "
              f"{type(e).__name__}: {e}")

    app.run(host='0.0.0.0', port=5001, debug=False, threaded=True)
