import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Standard `cn` helper — merge Tailwind classes deduping conflicts. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
