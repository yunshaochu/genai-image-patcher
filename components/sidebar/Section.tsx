
import React from 'react';

export const Section: React.FC<{ 
  title: string; 
  children: React.ReactNode; 
  isOpen?: boolean; 
  onToggle?: () => void 
}> = ({ title, children, isOpen, onToggle }) => {
  return (
    <div className="border border-skin-border rounded-xl bg-skin-surface shadow-sm transition-all hover:shadow-md mb-3">
      <button 
        onClick={onToggle}
        className={`w-full flex items-center justify-between px-4 py-3 bg-skin-fill/30 hover:bg-skin-fill transition-colors text-left ${isOpen ? 'rounded-t-xl' : 'rounded-xl'}`}
      >
        <span className="text-xs font-bold text-skin-muted uppercase tracking-wider">{title}</span>
        <svg 
          className={`w-4 h-4 text-skin-muted transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} 
          fill="none" 
          stroke="currentColor" 
          viewBox="0 0 24 24"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {isOpen && (
        <div className="p-4 border-t border-skin-border space-y-4 bg-skin-surface rounded-b-xl">
          {children}
        </div>
      )}
    </div>
  );
};
