import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PASTE_END, PASTE_START, pasteText } from "../../src/paste.ts";

describe("rule 6: terminal input is one bracketed paste without control characters", () => {
  it("cannot end the paste early or send keystrokes", () => {
    const out = pasteText("hi\x1b[201~\rrm -rf ~\r\n\x03\x04\x7f\x9b\tok");
    assert.equal(out, PASTE_START + "hi[201~\nrm -rf ~\n\tok" + PASTE_END);
    const inner = out.slice(PASTE_START.length, -PASTE_END.length);
    assert.doesNotMatch(inner, /[\x00-\x08\x0b-\x1f\x7f-\x9f]/);
  });
});
