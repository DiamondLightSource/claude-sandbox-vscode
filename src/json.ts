// Reading parsed JSON from the jail (trust boundary rule 8): only ever through `own()`, so a
// `__proto__` or `constructor` key is a plain key and nothing inherited from Object.prototype
// is ever read.

export type JsonObj = Record<string, unknown>;

export function isObj(v: unknown): v is JsonObj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** An own property of parsed JSON, never one inherited from Object.prototype. */
export function own(o: unknown, k: string): unknown {
  return isObj(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined;
}
