/**
 * Convert a title into a URL-safe, human-readable slug.
 * "Sum an Array!" → "sum-an-array"
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'exercise';
}

/**
 * Make a slug unique by appending -2, -3, etc. if needed.
 * Takes a set of existing slugs (or a check function).
 */
export async function uniqueSlug(
  base: string,
  exists: (candidate: string) => Promise<boolean>
): Promise<string> {
  let candidate = base;
  let n = 2;
  while (await exists(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
    if (n > 100) {
      // Give up and use a random suffix
      candidate = `${base}-${Math.random().toString(36).slice(2, 6)}`;
      break;
    }
  }
  return candidate;
}
