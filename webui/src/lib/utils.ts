import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Telegram displays — and copy-paste carries — usernames with a leading
 * `@`. Strip one (plus surrounding whitespace) so a pasted handle behaves
 * exactly like the typed bare name in validation and requests. Only one
 * `@` goes; a second still fails username validation. */
export function normalizeUsername(value: string): string {
  return value.trim().replace(/^@/, "");
}
