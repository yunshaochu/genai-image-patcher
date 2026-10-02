import React from 'react';
import { Language } from '../../types';
import { LayerDirection } from '../../services/mangaEditor';
import { t } from '../../services/translations';

/**
 * 叠放次序（谁盖谁）调整按钮。
 *
 * 次序本身就是 `image.regions` 的数组下标：编辑画布按数组顺序叠 DOM、拼接
 * stitchImage 也按数组顺序 drawImage —— 下标越大越靠上。新建的框 append 在末尾，
 * 于是老框天然被新框盖住（看着像"按时间顺序"，其实是数组顺序）。
 *
 * 只有贴图互相重叠时看得出差别。↑ = 上移一层（盖到相邻贴图之上），↓ 反之；
 * 已经在最上层 / 最下层时按钮置灰。
 *
 * 编辑器面板（EditorDock）与工作流面板（WorkflowDock：AI 重绘 / 手动修补工坊）
 * 共用这一份，避免两处各画一套箭头。
 */
export const LayerOrderButtons: React.FC<{
  lang: Language;
  canUp: boolean;
  canDown: boolean;
  onChange: (dir: LayerDirection) => void;
  /** 额外的容器 class（面板顶部 / 行内等不同位置）。 */
  className?: string;
}> = ({ lang, canUp, canDown, onChange, className = '' }) => (
  <div className={`flex items-center gap-0.5 shrink-0 ${className}`}>
    <button
      onClick={() => onChange('up')}
      disabled={!canUp}
      className="p-1 rounded text-skin-muted hover:text-skin-primary hover:bg-skin-fill disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
      title={t(lang, 'editorLayerUp')}
    >
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 19V5M5 12l7-7 7 7" />
      </svg>
    </button>
    <button
      onClick={() => onChange('down')}
      disabled={!canDown}
      className="p-1 rounded text-skin-muted hover:text-skin-primary hover:bg-skin-fill disabled:opacity-30 disabled:hover:bg-transparent transition-colors"
      title={t(lang, 'editorLayerDown')}
    >
      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 5v14M19 12l-7 7-7-7" />
      </svg>
    </button>
  </div>
);
