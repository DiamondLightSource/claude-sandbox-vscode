// A minimal virtual terminal screen (no vscode import): enough of a VT/xterm parser to know
// what Claude Code's terminal shows now, so the prompt state (src/prompt.ts, trust boundary
// rule 6) is read from the screen, not from whatever text was drawn last.
//
// It keeps the characters in each cell and the cursor; colours and attributes are dropped.
// Handled: printable text (wide characters as two cells, combining marks on the previous cell,
// as best effort), CR, LF, BS, HT, cursor movement (CUU/CUD/CUF/CUB/CNL/CPL/CHA/HPA/HPR/VPA/VPR/
// CUP), erasing (ED, EL, ECH), inserting and deleting (ICH, DCH, IL, DL), scrolling (SU, SD, IND,
// RI, NEL) within the scroll region (DECSTBM), save and restore of the cursor (DECSC/DECRC,
// SCOSC/SCORC), cursor visibility (DECTCEM), autowrap (DECAWM) and the alternate screen
// (1049/1047/47), which Claude Code 2.1.292 runs in. Everything else (colours, OSC titles and
// links, DCS, queries, mouse and keyboard modes, charsets) is parsed and ignored. Lengths are
// capped, so no input makes it buffer or loop without bound.

export const MAX_COLS = 1000;
export const MAX_ROWS = 500;
/** The most UTF-16 units one cell holds: a character and its marks (a flood of marks is dropped). */
export const MAX_CELL = 32;
const MAX_PARAMS = 32;
const MAX_CSI = 128;

export interface Cursor {
  row: number;
  col: number;
  visible: boolean;
}

type Grid = string[][];

// parser states
const S = { Ground: 0, Esc: 1, EscInter: 2, Csi: 3, Osc: 4, Str: 5, StrEsc: 6 } as const;
type ParseState = (typeof S)[keyof typeof S];

/** Two cells wide: East Asian Wide/Fullwidth and emoji presentation (best effort). */
export function isWide(cp: number): boolean {
  if (cp < 0x1100) return false;
  return (
    (cp >= 0x1100 && cp <= 0x115f) ||
    cp === 0x231a ||
    cp === 0x231b ||
    cp === 0x2329 ||
    cp === 0x232a ||
    (cp >= 0x23e9 && cp <= 0x23ec) ||
    cp === 0x23f0 ||
    cp === 0x23f3 ||
    (cp >= 0x25fd && cp <= 0x25fe) ||
    (cp >= 0x2614 && cp <= 0x2615) ||
    (cp >= 0x2648 && cp <= 0x2653) ||
    cp === 0x267f ||
    cp === 0x2693 ||
    cp === 0x26a1 ||
    (cp >= 0x26aa && cp <= 0x26ab) ||
    (cp >= 0x26bd && cp <= 0x26be) ||
    (cp >= 0x26c4 && cp <= 0x26c5) ||
    cp === 0x26ce ||
    cp === 0x26d4 ||
    cp === 0x26ea ||
    (cp >= 0x26f2 && cp <= 0x26f3) ||
    cp === 0x26f5 ||
    cp === 0x26fa ||
    cp === 0x26fd ||
    cp === 0x2705 ||
    (cp >= 0x270a && cp <= 0x270b) ||
    cp === 0x2728 ||
    cp === 0x274c ||
    cp === 0x274e ||
    (cp >= 0x2753 && cp <= 0x2755) ||
    cp === 0x2757 ||
    (cp >= 0x2795 && cp <= 0x2797) ||
    cp === 0x27b0 ||
    cp === 0x27bf ||
    (cp >= 0x2b1b && cp <= 0x2b1c) ||
    cp === 0x2b50 ||
    cp === 0x2b55 ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    cp === 0x1f004 ||
    cp === 0x1f0cf ||
    cp === 0x1f18e ||
    (cp >= 0x1f191 && cp <= 0x1f19a) ||
    (cp >= 0x1f200 && cp <= 0x1f251) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f680 && cp <= 0x1f6ff) ||
    (cp >= 0x1f7e0 && cp <= 0x1f7eb) ||
    (cp >= 0x1f90c && cp <= 0x1f9ff) ||
    (cp >= 0x1fa70 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  );
}

/** No cell of its own: combining marks, variation selectors, zero-width joiners. */
export function isZeroWidth(cp: number): boolean {
  return (
    (cp >= 0x300 && cp <= 0x36f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x200b && cp <= 0x200f) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe00 && cp <= 0xfe0f) ||
    (cp >= 0xfe20 && cp <= 0xfe2f) ||
    (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}

const clampDim = (n: number, max: number): number => Math.max(1, Math.min(max, Math.floor(n) || 1));

export class Screen {
  cols: number;
  rows: number;
  private main: Grid;
  private altGrid: Grid | null = null;
  private row = 0;
  private col = 0;
  private wrapNext = false;
  private visible = true;
  private autowrap = true;
  private top = 0;
  private bottom: number;
  private saved: { row: number; col: number } | null = null;
  private savedMain: { row: number; col: number } | null = null;
  // parser
  private state: ParseState = S.Ground;
  private seq = "";

  constructor(cols: number, rows: number) {
    this.cols = clampDim(cols, MAX_COLS);
    this.rows = clampDim(rows, MAX_ROWS);
    this.main = this.blank(this.rows);
    this.bottom = this.rows - 1;
  }

  /** Whether the alternate screen is showing. */
  get alt(): boolean {
    return this.altGrid !== null;
  }

  get cursor(): Cursor {
    return { row: this.row, col: this.col, visible: this.visible };
  }

  private get grid(): Grid {
    return this.altGrid ?? this.main;
  }

  private blankRow(): string[] {
    return new Array<string>(this.cols).fill(" ");
  }

  private blank(n: number): Grid {
    return Array.from({ length: n }, () => this.blankRow());
  }

  /** Row r's text (a wide character once, then nothing for its second cell). */
  line(r: number): string {
    return (this.grid[r] ?? []).join("");
  }

  lines(): string[] {
    return this.grid.map((r) => r.join(""));
  }

  resize(cols: number, rows: number): void {
    const c = clampDim(cols, MAX_COLS);
    const r = clampDim(rows, MAX_ROWS);
    const fit = (g: Grid): Grid =>
      Array.from({ length: r }, (_, i) => {
        const old = g[i] ?? [];
        return Array.from({ length: c }, (_, j) => old[j] ?? " ");
      });
    this.main = fit(this.main);
    if (this.altGrid) this.altGrid = fit(this.altGrid);
    this.cols = c;
    this.rows = r;
    this.top = 0;
    this.bottom = r - 1;
    this.row = Math.min(this.row, r - 1);
    this.col = Math.min(this.col, c - 1);
    this.wrapNext = false;
  }

  feed(text: string): void {
    for (const ch of text) this.step(ch);
  }

  private step(ch: string): void {
    const cp = ch.codePointAt(0)!;
    switch (this.state) {
      case S.Ground:
        if (cp === 0x1b) this.state = S.Esc;
        else if (cp < 0x20 || cp === 0x7f) this.control(cp);
        else if (cp >= 0x80 && cp < 0xa0) this.c1(cp);
        else this.print(ch, cp);
        return;
      case S.Esc:
        this.esc(ch, cp);
        return;
      case S.EscInter:
        // ESC ( B and the like: one more byte (a charset), ignored
        if (cp >= 0x20 && cp <= 0x2f) return;
        this.state = S.Ground;
        return;
      case S.Csi:
        if (cp >= 0x40 && cp <= 0x7e) {
          this.state = S.Ground;
          if (this.seq.length <= MAX_CSI) this.csi(this.seq, ch);
          this.seq = "";
        } else if (cp === 0x1b) {
          this.seq = "";
          this.state = S.Esc;
        } else if (cp < 0x20) {
          this.control(cp); // C0 inside a CSI are executed
        } else if (this.seq.length <= MAX_CSI) {
          this.seq += ch;
        }
        return;
      case S.Osc:
        if (cp === 0x07) this.state = S.Ground;
        else if (cp === 0x1b) this.state = S.StrEsc;
        else if (cp === 0x9c) this.state = S.Ground;
        return;
      case S.Str:
        if (cp === 0x1b) this.state = S.StrEsc;
        else if (cp === 0x9c) this.state = S.Ground;
        return;
      case S.StrEsc:
        // ST is ESC \; any other ESC ends the string and starts a sequence
        if (ch === "\\") this.state = S.Ground;
        else {
          this.state = S.Esc;
          this.esc(ch, cp);
        }
        return;
    }
  }

  private c1(cp: number): void {
    if (cp === 0x9b) {
      this.seq = "";
      this.state = S.Csi;
    } else if (cp === 0x9d) this.state = S.Osc;
    else if (cp === 0x90 || cp === 0x98 || cp === 0x9e || cp === 0x9f) this.state = S.Str;
    else if (cp === 0x84) this.index();
    else if (cp === 0x85) {
      this.col = 0;
      this.index();
    } else if (cp === 0x8d) this.reverseIndex();
  }

  private esc(ch: string, cp: number): void {
    this.state = S.Ground;
    switch (ch) {
      case "[":
        this.seq = "";
        this.state = S.Csi;
        return;
      case "]":
        this.state = S.Osc;
        return;
      case "P":
      case "X":
      case "^":
      case "_":
        this.state = S.Str;
        return;
      case "7":
        this.saveCursor();
        return;
      case "8":
        this.restoreCursor();
        return;
      case "D":
        this.index();
        return;
      case "E":
        this.col = 0;
        this.index();
        return;
      case "M":
        this.reverseIndex();
        return;
      case "c":
        this.reset();
        return;
    }
    if (cp >= 0x20 && cp <= 0x2f) this.state = S.EscInter;
    else if (cp === 0x1b) this.state = S.Esc;
  }

  private reset(): void {
    this.altGrid = null;
    this.main = this.blank(this.rows);
    this.row = this.col = 0;
    this.top = 0;
    this.bottom = this.rows - 1;
    this.visible = this.autowrap = true;
    this.wrapNext = false;
    this.saved = this.savedMain = null;
  }

  private saveCursor(): void {
    this.saved = { row: this.row, col: this.col };
  }

  private restoreCursor(): void {
    const s = this.saved ?? { row: 0, col: 0 };
    this.row = Math.min(s.row, this.rows - 1);
    this.col = Math.min(s.col, this.cols - 1);
    this.wrapNext = false;
  }

  private control(cp: number): void {
    switch (cp) {
      case 0x08: // BS
        if (this.col > 0) this.col--;
        this.wrapNext = false;
        return;
      case 0x09: // HT
        this.col = Math.min(this.cols - 1, (Math.floor(this.col / 8) + 1) * 8);
        return;
      case 0x0a:
      case 0x0b:
      case 0x0c:
        this.index();
        return;
      case 0x0d:
        this.col = 0;
        this.wrapNext = false;
        return;
    }
  }

  /** LF/IND: down a row, scrolling the region at its bottom. */
  private index(): void {
    this.wrapNext = false;
    if (this.row === this.bottom) this.scrollUp(1);
    else if (this.row < this.rows - 1) this.row++;
  }

  private reverseIndex(): void {
    this.wrapNext = false;
    if (this.row === this.top) this.scrollDown(1);
    else if (this.row > 0) this.row--;
  }

  private scrollUp(n: number, from = this.top): void {
    const g = this.grid;
    n = Math.min(n, this.bottom - from + 1);
    g.splice(from, n);
    g.splice(this.bottom - n + 1, 0, ...this.blank(n));
  }

  private scrollDown(n: number, from = this.top): void {
    const g = this.grid;
    n = Math.min(n, this.bottom - from + 1);
    g.splice(this.bottom - n + 1, n);
    g.splice(from, 0, ...this.blank(n));
  }

  private print(ch: string, cp: number): void {
    const g = this.grid;
    if (isZeroWidth(cp)) {
      // on the cell before the cursor (or the last one, when the next character wraps)
      const row = g[this.row]!;
      let c = this.wrapNext ? this.col : this.col - 1;
      if (c > 0 && row[c] === "") c--;
      if (c >= 0 && row[c]!.length + ch.length <= MAX_CELL) row[c] += ch;
      return;
    }
    const w = isWide(cp) ? 2 : 1;
    if (this.wrapNext || (w === 2 && this.col === this.cols - 1)) {
      if (this.autowrap) {
        this.col = 0;
        this.index();
      } else if (w === 2) return;
    }
    this.wrapNext = false;
    if (w > this.cols) return;
    const row = g[this.row]!;
    this.clearWide(row, this.col);
    if (w === 2) this.clearWide(row, this.col + 1);
    row[this.col] = ch;
    if (w === 2) row[this.col + 1] = "";
    if (this.col + w >= this.cols) {
      this.col = this.cols - 1;
      this.wrapNext = true;
    } else this.col += w;
  }

  /** Overwriting half of a wide character blanks the other half. */
  private clearWide(row: string[], c: number): void {
    if (row[c] === "" && c > 0) row[c - 1] = " ";
    else if (c + 1 < row.length && row[c + 1] === "") row[c + 1] = " ";
  }

  private erase(r: number, from: number, to: number): void {
    const row = this.grid[r];
    if (!row) return;
    if (from > 0 && row[from] === "") row[from - 1] = " ";
    if (to < this.cols && row[to] === "") row[to] = " ";
    for (let c = from; c < to; c++) row[c] = " ";
  }

  private csi(body: string, final: string): void {
    let prefix = "";
    if (body.length > 0 && "<=>?".includes(body[0]!)) {
      prefix = body[0]!;
      body = body.slice(1);
    }
    // intermediates (a space in CSI SP q) mean another command: ignored
    if (/[ -/]/.test(body)) return;
    const ps = body.split(";", MAX_PARAMS).map((p) => {
      const n = parseInt(p.split(":")[0]!, 10);
      return Number.isFinite(n) ? Math.min(n, 100_000) : 0;
    });
    const p0 = ps[0] ?? 0;
    const n = Math.max(1, p0);
    if (prefix === "?") {
      if (final === "h" || final === "l") for (const p of ps) this.mode(p, final === "h");
      return;
    }
    if (prefix !== "") return; // queries and keyboard protocols
    this.wrapNext = false;
    const inRegion = this.row >= this.top && this.row <= this.bottom;
    switch (final) {
      case "A":
      case "F":
        this.row = Math.max(inRegion ? this.top : 0, this.row - n);
        if (final === "F") this.col = 0;
        return;
      case "B":
      case "e":
      case "E":
        this.row = Math.min(inRegion ? this.bottom : this.rows - 1, this.row + n);
        if (final === "E") this.col = 0;
        return;
      case "C":
      case "a":
        this.col = Math.min(this.cols - 1, this.col + n);
        return;
      case "D":
        this.col = Math.max(0, this.col - n);
        return;
      case "G":
      case "`":
        this.col = Math.min(this.cols - 1, n - 1);
        return;
      case "d":
        this.row = Math.min(this.rows - 1, n - 1);
        return;
      case "H":
      case "f":
        this.row = Math.min(this.rows - 1, n - 1);
        this.col = Math.min(this.cols - 1, Math.max(1, ps[1] ?? 1) - 1);
        return;
      case "J":
        if (p0 === 0) {
          this.erase(this.row, this.col, this.cols);
          for (let r = this.row + 1; r < this.rows; r++) this.erase(r, 0, this.cols);
        } else if (p0 === 1) {
          for (let r = 0; r < this.row; r++) this.erase(r, 0, this.cols);
          this.erase(this.row, 0, this.col + 1);
        } else if (p0 === 2) {
          for (let r = 0; r < this.rows; r++) this.erase(r, 0, this.cols);
        } // 3: the scrollback only, which is not kept here
        return;
      case "K":
        if (p0 === 0) this.erase(this.row, this.col, this.cols);
        else if (p0 === 1) this.erase(this.row, 0, this.col + 1);
        else if (p0 === 2) this.erase(this.row, 0, this.cols);
        return;
      case "X":
        this.erase(this.row, this.col, Math.min(this.cols, this.col + n));
        return;
      case "@": {
        const row = this.grid[this.row]!;
        const k = Math.min(n, this.cols - this.col);
        row.splice(this.col, 0, ...new Array<string>(k).fill(" "));
        row.length = this.cols;
        if (isWideCell(row[this.cols - 1]!)) row[this.cols - 1] = " "; // its second half went
        return;
      }
      case "P": {
        const row = this.grid[this.row]!;
        row.splice(this.col, Math.min(n, this.cols - this.col));
        while (row.length < this.cols) row.push(" ");
        if (row[this.col] === "") row[this.col] = " ";
        return;
      }
      case "L":
        if (inRegion) {
          this.scrollDown(n, this.row);
          this.col = 0;
        }
        return;
      case "M":
        if (inRegion) {
          this.scrollUp(n, this.row);
          this.col = 0;
        }
        return;
      case "S":
        this.scrollUp(n);
        return;
      case "T":
        this.scrollDown(n);
        return;
      case "r": {
        const t = Math.max(1, p0) - 1;
        const b = Math.min(this.rows, ps[1] && ps[1] > 0 ? ps[1] : this.rows) - 1;
        if (t < b) {
          this.top = t;
          this.bottom = b;
          this.row = 0;
          this.col = 0;
        }
        return;
      }
      case "s":
        this.saveCursor();
        return;
      case "u":
        this.restoreCursor();
        return;
    }
  }

  private mode(p: number, on: boolean): void {
    switch (p) {
      case 7:
        this.autowrap = on;
        return;
      case 25:
        this.visible = on;
        return;
      case 47:
      case 1047:
      case 1049:
        if (on && this.altGrid === null) {
          if (p === 1049) this.savedMain = { row: this.row, col: this.col };
          this.altGrid = this.blank(this.rows);
        } else if (!on && this.altGrid !== null) {
          this.altGrid = null;
          if (p === 1049 && this.savedMain) {
            this.row = Math.min(this.savedMain.row, this.rows - 1);
            this.col = Math.min(this.savedMain.col, this.cols - 1);
          }
        }
        this.wrapNext = false;
        return;
    }
  }
}

function isWideCell(cell: string): boolean {
  const cp = cell.codePointAt(0);
  return cp !== undefined && isWide(cp);
}
