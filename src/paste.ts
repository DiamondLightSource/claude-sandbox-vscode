// Terminal input (trust boundary rule 6). The terminal launcher is a later stage; this is the
// one primitive it will use to type an ask into Claude Code: the text as ONE bracketed paste,
// CRs as LFs, with every other control character (ESC included) removed, so the text can
// neither end the paste early (ESC[201~) nor act as keystrokes.
//
// TODO(stage 2): the launcher (the claude shadow as the terminal's own process, never a command
// typed into a shell) and the ❯-prompt detection that gates when a paste may be sent.

// C0 except LF and TAB, DEL, C1
const DROP = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export const PASTE_START = "\u001b[200~";
export const PASTE_END = "\u001b[201~";

export function pasteText(text: string): string {
  const clean = text.replace(/\r\n?/g, "\n").replace(DROP, "");
  return PASTE_START + clean + PASTE_END;
}
