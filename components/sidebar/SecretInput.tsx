import React, { useState } from 'react';
import { Language } from '../../types';
import { t } from '../../services/translations';

interface SecretInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Used for the show/hide tooltip. */
  language: Language;
  placeholder?: string;
  /** The input's own classes (border / padding / focus ring…) — the component
   *  only appends the right padding that makes room for the eye button. */
  className?: string;
}

/**
 * Password-style input with an inline 显示 / 隐藏 toggle, for API keys.
 *
 * Replaces the bare `<input type="password">` used by every credential field so
 * a pasted key can be eyeballed for typos (truncated keys and stray spaces are
 * the usual suspects when a request 401s) without opening devtools.
 *
 * The revealed state is component-local and starts hidden: collapsing the dock
 * or closing the settings modal unmounts it, so keys never stay on screen.
 * `onMouseDown` is prevented on the button so toggling does not steal focus
 * from the field mid-edit.
 */
export const SecretInput: React.FC<SecretInputProps> = ({
  value,
  onChange,
  language,
  placeholder,
  className = '',
}) => {
  const [visible, setVisible] = useState(false);
  const label = t(language, visible ? 'hideKey' : 'showKey');

  return (
    <div className="relative">
      <input
        type={visible ? 'text' : 'password'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        className={`${className} pr-7`}
      />
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setVisible(v => !v)}
        title={label}
        aria-label={label}
        className="absolute right-1 top-1/2 -translate-y-1/2 w-5 h-5 rounded flex items-center justify-center text-skin-muted hover:text-skin-primary hover:bg-skin-fill transition-colors"
      >
        {visible ? (
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
          </svg>
        ) : (
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
        )}
      </button>
    </div>
  );
};

export default SecretInput;
