import React from 'react';
import { Plus, X } from 'lucide-react';

interface WorkspaceToggleButtonProps {
  inWorkspace: boolean;
  onAdd: () => void;
  onRemove: () => void;
  size?: number;
  className?: string;
  inClassName?: string;
  outClassName?: string;
}

/** The +/× toggle for adding/removing a project from the workspace. Every call site shares the
 *  same active/inactive tints (a teal-accent remove on hover-to-red, a dim add on hover-to-teal)
 *  — only the padding/size/layout classes differ, so those come via `className` while the color
 *  classes default to the shared values. */
const DEFAULT_IN_CLASS = 'text-accent-blue hover:text-accent-red transition-colors';
const DEFAULT_OUT_CLASS = 'text-fg-faint hover:text-accent-blue transition-colors';

export function WorkspaceToggleButton({
  inWorkspace,
  onAdd,
  onRemove,
  size = 14,
  className = '',
  inClassName = DEFAULT_IN_CLASS,
  outClassName = DEFAULT_OUT_CLASS,
}: WorkspaceToggleButtonProps) {
  const onClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    if (inWorkspace) onRemove();
    else onAdd();
  };
  return (
    <button
      onClick={onClick}
      className={`${className} ${inWorkspace ? inClassName : outClassName}`}
      title={inWorkspace ? 'Remove from workspace' : 'Add to workspace'}
    >
      {inWorkspace ? <X size={size} /> : <Plus size={size} />}
    </button>
  );
}
