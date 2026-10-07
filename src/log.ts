// Logging. Anything that came from the jail (method names, paths, pids) is passed through
// `esc` before it is logged, never raw (trust boundary rule 8): it could carry terminal
// escapes, bidi overrides or line breaks meant to forge log lines.

export interface Logger {
  info(message: string): void;
}

export const silentLogger: Logger = { info() {} };

// C0 and C1 controls, DEL, line/paragraph separators, bidi controls and the BOM
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** A value from the jail as a quoted, escaped string of at most `max` characters. */
export function esc(value: unknown, max = 200): string {
  let s: string;
  try {
    s = typeof value === "string" ? value : String(JSON.stringify(value));
  } catch {
    s = "<unprintable>";
  }
  if (s.length > max) s = s.slice(0, max) + "…";
  const body = s
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(UNSAFE, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  return `"${body}"`;
}
