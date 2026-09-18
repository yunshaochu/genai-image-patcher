# -*- coding: utf-8 -*-
"""
BananaChange 统一后端服务
========================

一个端口整合漫画处理所需的 Python 能力：

  GET  /health   健康检查（检测模型状态）
  POST /detect   RT-DETR 文本/气泡检测（与 comic-detector 服务契约一致）
  POST /erase    区域文字擦除（flood fill 洞检测 + OpenCV inpaint）

后续扩展：自动翻译、嵌字排版也加在本服务内。

启动：python app.py   （默认监听 0.0.0.0:5001）
"""
import base64
import io
import json

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
CORS(app, resources={r"/*": {"origins": "*"}})
app.config['MAX_CONTENT_LENGTH'] = 16 * 1024 * 1024  # 16MB

ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'}

# 全局模型实例（懒加载，首次 /detect 时载入）
detector = None

import torch
model_config = {
    'model_name': 'ogkalu/comic-text-and-bubble-detector',
    'device': 'cuda' if torch.cuda.is_available() else 'cpu',
    'conf_threshold': 0.5,
    'classes': CLASS_NAMES,
}


def init_model():
    """初始化检测模型"""
    global detector
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


# ── /health ─────────────────────────────────────────────────

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'device': model_config['device'],
        'model': model_config['model_name'],
        'model_loaded': detector is not None,
        'endpoints': ['/detect', '/erase'],
    })


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
            out = erase_free_roi_floodfill(img.copy(), dilate, inpaint_radius)
        else:
            out = erase_bubble_roi(img.copy(), dilate, inpaint_radius)

        ok, buf = cv2.imencode('.png', out)
        if not ok:
            return json_error('Failed to encode result', 500)
        return send_file(io.BytesIO(buf.tobytes()), mimetype='image/png')

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
    print("=" * 60)

    app.run(host='0.0.0.0', port=5001, debug=False, threaded=True)
