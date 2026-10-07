import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { esc } from "../../src/log.ts";

describe("esc (rule 8: nothing from the jail logged unescaped)", () => {
  it("escapes controls, C1, bidi and line separators, and quotes", () => {
    const evil = "\x1b]0;PWNED\x07\x1b[2K\n[ide] forged\r\x9b31m‮\u2028⁦﻿\"\\";
    const out = esc(evil);
    assert.doesNotMatch(out, /[\x00-\x1f\x7f-\x9f\u2028\u2029‪-‮⁦-⁩﻿]/);
    assert.equal(out, '"\\u001b]0;PWNED\\u0007\\u001b[2K\\u000a[ide] forged\\u000d\\u009b31m\\u202e\\u2028\\u2066\\ufeff\\"\\\\"');
  });
  it("caps the length and prints non-strings as JSON", () => {
    assert.equal(esc("x".repeat(300), 10), '"' + "x".repeat(10) + '…"');
    assert.equal(esc({ a: 1 }), '"{\\"a\\":1}"');
    assert.equal(esc(undefined), '"undefined"');
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    assert.equal(esc(loop), '"<unprintable>"');
  });
});
