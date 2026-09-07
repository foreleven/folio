import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merges conditional classes and resolves Tailwind conflicts for shared components. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
