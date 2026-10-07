// Terminal input (trust boundary rule 6): the one primitive that types an ask into Claude Code
// (src/session.ts decides when): the text as ONE bracketed paste, CRs as LFs, with every other
// control character (ESC included) removed, so the text can neither end the paste early
// (ESC[201~) nor act as keystrokes.

// C0 except LF and TAB, DEL, C1
const DROP = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export const PASTE_START = "\u001b[200~";
export const PASTE_END = "\u001b[201~";

export function pasteText(text: string): string {
  const clean = text.replace(/\r\n?/g, "\n").replace(DROP, "");
  return PASTE_START + clean + PASTE_END;
}
