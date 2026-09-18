"""
RT-DETR 漫画文本和气泡检测推理模块
使用 HuggingFace 模型: ogkalu/comic-text-and-bubble-detector
"""
import torch
import numpy as np
import cv2
from PIL import Image
from typing import List, Tuple, Optional, Dict, Any
from dataclasses import dataclass
from pathlib import Path

# 类别定义
CLASS_NAMES = {
    0: "bubble",        # 气泡
    1: "text_bubble",   # 气泡内的文本
    2: "text_free"      # 气泡外的文本
}


@dataclass
class DetectionResult:
    """单个检测结果"""
    bbox: List[int]           # [x1, y1, x2, y2]
    class_id: int             # 类别ID
    class_name: str           # 类别名称
    confidence: float         # 置信度

    def to_dict(self) -> Dict[str, Any]:
        return {
            'bbox': self.bbox,
            'class_id': self.class_id,
            'class_name': self.class_name,
            'confidence': round(self.confidence, 4),
            'x1': self.bbox[0],
            'y1': self.bbox[1],
            'x2': self.bbox[2],
            'y2': self.bbox[3],
            'width': self.bbox[2] - self.bbox[0],
            'height': self.bbox[3] - self.bbox[1]
        }


class ComicDetector:
    """
    漫画文本和气泡检测器
    使用 RT-DETR-v2 模型
    """

    def __init__(
        self,
        model_name: str = "ogkalu/comic-text-and-bubble-detector",
        device: str = None,
        conf_threshold: float = 0.5,
        use_onnx: bool = False
    ):
        """
        初始化检测器

        Args:
            model_name: HuggingFace 模型名称或本地路径
            device: 运行设备 ('cuda', 'cpu', 'mps')
            conf_threshold: 置信度阈值
            use_onnx: 是否使用ONNX推理
        """
        self.model_name = model_name
        self.conf_threshold = conf_threshold
        self.use_onnx = use_onnx

        # 自动检测设备
        if device is None:
            if torch.cuda.is_available():
                self.device = 'cuda'
            elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
                self.device = 'mps'
            else:
                self.device = 'cpu'
        else:
            self.device = device

        self.model = None
        self.processor = None
        self._load_model()

    def _load_model(self):
        """加载模型"""
        try:
            from transformers import RTDetrForObjectDetection, RTDetrImageProcessor
        except ImportError:
            raise ImportError(
                "请安装 transformers 库: pip install transformers>=4.38.0"
            )

        print(f"正在加载模型: {self.model_name}")
        print(f"使用设备: {self.device}")

        # 模型缓存目录
        cache_dir = Path(__file__).parent / "model"
        cache_dir.mkdir(parents=True, exist_ok=True)
        print(f"模型缓存目录: {cache_dir}")

        # 加载处理器和模型
        self.processor = RTDetrImageProcessor.from_pretrained(
            self.model_name,
            cache_dir=str(cache_dir)
        )

        if self.use_onnx and self.device == 'cpu':
            # ONNX 推理模式
            self.model = RTDetrForObjectDetection.from_pretrained(
                self.model_name,
                use_onnx=True,
                cache_dir=str(cache_dir)
            )
        else:
            # PyTorch 推理模式
            self.model = RTDetrForObjectDetection.from_pretrained(
                self.model_name,
                cache_dir=str(cache_dir)
            )
            self.model.to(self.device)
            self.model.eval()

        print("模型加载完成!")

    def preprocess(self, image: np.ndarray) -> Tuple[Any, Dict]:
        """
        预处理图像

        Args:
            image: BGR格式的numpy数组

        Returns:
            处理后的输入和原始尺寸信息
        """
        # BGR -> RGB
        image_rgb = cv2.cvtColor(image, cv2.COLOR_BGR2RGB)
        pil_image = Image.fromarray(image_rgb)

        # 使用处理器预处理
        inputs = self.processor(images=pil_image, return_tensors="pt")

        if self.device != 'cpu' and not self.use_onnx:
            inputs = {k: v.to(self.device) for k, v in inputs.items()}

        return inputs, {'height': image.shape[0], 'width': image.shape[1]}

    def postprocess(
        self,
        outputs: Any,
        original_size: Dict,
        conf_threshold: float = None
    ) -> List[DetectionResult]:
        """
        后处理模型输出

        Args:
            outputs: 模型输出
            original_size: 原始图像尺寸
            conf_threshold: 置信度阈值

        Returns:
            检测结果列表
        """
        if conf_threshold is None:
            conf_threshold = self.conf_threshold

        # 获取检测结果
        results = self.processor.post_process_object_detection(
            outputs,
            threshold=conf_threshold,
            target_sizes=[(original_size['height'], original_size['width'])]
        )[0]

        detections = []
        for score, label, box in zip(
            results['scores'].cpu().numpy(),
            results['labels'].cpu().numpy(),
            results['boxes'].cpu().numpy()
        ):
            class_id = int(label)
            detections.append(DetectionResult(
                bbox=[int(box[0]), int(box[1]), int(box[2]), int(box[3])],
                class_id=class_id,
                class_name=CLASS_NAMES.get(class_id, f"unknown_{class_id}"),
                confidence=float(score)
            ))

        return detections

    @torch.no_grad()
    def detect(
        self,
        image: np.ndarray,
        conf_threshold: float = None,
        filter_classes: List[str] = None
    ) -> List[DetectionResult]:
        """
        检测图像中的文本和气泡

        Args:
            image: BGR格式的numpy数组
            conf_threshold: 置信度阈值
            filter_classes: 只返回指定类别的检测结果

        Returns:
            检测结果列表
        """
        # 预处理
        inputs, original_size = self.preprocess(image)

        # 推理
        outputs = self.model(**inputs)

        # 后处理
        detections = self.postprocess(outputs, original_size, conf_threshold)

        # 过滤类别
        if filter_classes:
            detections = [d for d in detections if d.class_name in filter_classes]

        return detections

    def detect_by_class(
        self,
        image: np.ndarray,
        conf_threshold: float = None
    ) -> Dict[str, List[DetectionResult]]:
        """
        按类别分组检测结果

        Args:
            image: BGR格式的numpy数组
            conf_threshold: 置信度阈值

        Returns:
            按类别分组的检测结果字典
        """
        detections = self.detect(image, conf_threshold)

        result = {
            'bubble': [],
            'text_bubble': [],
            'text_free': []
        }

        for det in detections:
            if det.class_name in result:
                result[det.class_name].append(det)

        return result

    def visualize(
        self,
        image: np.ndarray,
        detections: List[DetectionResult] = None,
        conf_threshold: float = None,
        show_labels: bool = True,
        show_conf: bool = True
    ) -> np.ndarray:
        """
        可视化检测结果

        Args:
            image: BGR格式的numpy数组
            detections: 检测结果(可选,如果为None则自动检测)
            conf_threshold: 置信度阈值
            show_labels: 是否显示类别标签
            show_conf: 是否显示置信度

        Returns:
            可视化后的图像
        """
        if detections is None:
            detections = self.detect(image, conf_threshold)

        vis_image = image.copy()

        # 不同类别使用不同颜色
        colors = {
            'bubble': (0, 255, 0),      # 绿色
            'text_bubble': (0, 255, 255), # 黄色
            'text_free': (0, 0, 255)      # 红色
        }

        for det in detections:
            color = colors.get(det.class_name, (255, 255, 255))
            x1, y1, x2, y2 = det.bbox

            # 绘制边界框
            cv2.rectangle(vis_image, (x1, y1), (x2, y2), color, 2)

            # 绘制标签
            if show_labels or show_conf:
                label_parts = []
                if show_labels:
                    label_parts.append(det.class_name)
                if show_conf:
                    label_parts.append(f"{det.confidence:.2f}")
                label = " ".join(label_parts)

                # 计算文本大小
                (text_width, text_height), baseline = cv2.getTextSize(
                    label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 1
                )

                # 绘制文本背景
                cv2.rectangle(
                    vis_image,
                    (x1, y1 - text_height - 10),
                    (x1 + text_width + 5, y1),
                    color,
                    -1
                )

                # 绘制文本
                cv2.putText(
                    vis_image,
                    label,
                    (x1 + 2, y1 - 5),
                    cv2.FONT_HERSHEY_SIMPLEX,
                    0.6,
                    (0, 0, 0),
                    1
                )

        return vis_image

    def get_text_regions(
        self,
        image: np.ndarray,
        conf_threshold: float = None,
        include_free_text: bool = True
    ) -> List[Dict[str, Any]]:
        """
        获取文本区域(用于OCR等后续处理)

        Args:
            image: BGR格式的numpy数组
            conf_threshold: 置信度阈值
            include_free_text: 是否包含气泡外的文本

        Returns:
            文本区域列表
        """
        detections = self.detect_by_class(image, conf_threshold)

        text_regions = []

        # 气泡内的文本
        for det in detections['text_bubble']:
            text_regions.append({
                'bbox': det.bbox,
                'type': 'text_bubble',
                'confidence': det.confidence
            })

        # 气泡外的文本
        if include_free_text:
            for det in detections['text_free']:
                text_regions.append({
                    'bbox': det.bbox,
                    'type': 'text_free',
                    'confidence': det.confidence
                })

        return text_regions

    def get_bubble_regions(
        self,
        image: np.ndarray,
        conf_threshold: float = None
    ) -> List[Dict[str, Any]]:
        """
        获取气泡区域

        Args:
            image: BGR格式的numpy数组
            conf_threshold: 置信度阈值

        Returns:
            气泡区域列表
        """
        detections = self.detect_by_class(image, conf_threshold)

        bubble_regions = []
        for det in detections['bubble']:
            bubble_regions.append({
                'bbox': det.bbox,
                'confidence': det.confidence
            })

        return bubble_regions
