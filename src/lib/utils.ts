import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

// `tailwind-merge` was already a dependency but unused — without it, conflicting Tailwind
// classes (e.g. two different `bg-*` utilities passed via `className` overrides) don't resolve
// predictably; the shadcn convention is always `twMerge(clsx(...))`, not just `clsx(...)`.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
