// The terminal relay (trust boundary rule 9). VS Code's API shows an extension nothing of what a
// normal terminal prints, and the launcher must see Claude Code's output to know when its `❯`
// input box is up (rule 6). So the session is a Pseudoterminal that relays to a child process
// with a real pty. Node has no pty without a native module (node-pty), so the pty is made by
// this small Python program, run by claude-sandbox's own root-owned interpreter (the one its
// `claude` shim execs) with -I, and passed as `-c`: there is no helper file anywhere that the
// jail, or anything else, could change. The interpreter path, the program text and the program
// it runs (the claude shadow) are constants; only Claude's arguments vary.
//
// Protocol: argv is `cols rows program args...`. fd 0 is typed into the pty, the pty's output
// goes to fd 1, and fd 3 carries resizes, one `cols rows` line each (TIOCSWINSZ on the pty,
// so the kernel sends the program SIGWINCH). The child gets the pty as its controlling
// terminal in a session of its own. The helper exits with the program's exit status (128 + n
// for signal n) once the pty is drained; when fd 0 closes (the extension went) it closes the
// pty, so the session gets SIGHUP.

/** claude-sandbox's root-owned interpreter, by absolute path (its shim runs this one). */
export const PYTHON = "/usr/libexec/claude-sandbox/venv/bin/python";
/** The sandbox's claude shadow: runs Claude Code inside the jail. */
export const CLAUDE = "/usr/local/bin/claude";

export const DIM_MAX = 10000;

export const PTY_HELPER = String.raw`
import errno, fcntl, os, select, signal, struct, sys, termios, time

def size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))

def dims(a, b):
    c, r = int(a), int(b)
    if not (0 < c <= ${DIM_MAX} and 0 < r <= ${DIM_MAX}):
        raise ValueError("bad size")
    return c, r

def main():
    cols, rows = dims(sys.argv[1], sys.argv[2])
    argv = sys.argv[3:]
    master, slave = os.openpty()
    size(slave, cols, rows)
    pid = os.fork()
    if pid == 0:
        try:
            os.setsid()
            fcntl.ioctl(slave, termios.TIOCSCTTY, 0)
            for fd in (0, 1, 2):
                os.dup2(slave, fd)
            os.closerange(3, 256)
            signal.signal(signal.SIGPIPE, signal.SIG_DFL)
            os.execv(argv[0], argv)
        except BaseException as e:
            os.write(2, ("cannot run %r: %s\r\n" % (argv[0], e)).encode())
        os._exit(127)
    os.close(slave)
    os.set_blocking(master, False)
    os.set_blocking(0, False)
    pending = b""
    ctl, ctlbuf = 3, b""
    status = None
    quiet = None
    while True:
        if status is None:
            done, st = os.waitpid(pid, os.WNOHANG)
            if done:
                status = st
        r = [master]
        if not pending:
            r.append(0)
        if ctl >= 0:
            r.append(ctl)
        w = [master] if pending else []
        rr, ww, _ = select.select(r, w, [], 0.25)
        if master in rr:
            try:
                data = os.read(master, 65536)
            except BlockingIOError:
                data = None
            except OSError:
                data = b""
            if data == b"":
                break
            if data:
                quiet = None
                view = memoryview(data)
                while view:
                    try:
                        n = os.write(1, view)
                    except BrokenPipeError:
                        return finish(master, pid, status, kill=True)
                    view = view[n:]
        elif status is not None:
            # exited, and the pty quiet: a second of that ends it (a straggler may hold the pty)
            now = time.monotonic()
            if quiet is None:
                quiet = now
            elif now - quiet > 1:
                break
        if master in ww and pending:
            try:
                n = os.write(master, pending)
                pending = pending[n:]
            except BlockingIOError:
                pass
            except OSError:
                pending = b""
        if 0 in rr:
            try:
                data = os.read(0, 65536)
            except BlockingIOError:
                data = None
            if data == b"":
                return finish(master, pid, status, kill=True)
            if data:
                pending += data
        if ctl >= 0 and ctl in rr:
            data = os.read(ctl, 4096)
            if not data:
                os.close(ctl)
                ctl = -1
            else:
                ctlbuf += data
                while b"\n" in ctlbuf:
                    line, ctlbuf = ctlbuf.split(b"\n", 1)
                    try:
                        size(master, *dims(*line.split()))
                    except (ValueError, TypeError, OSError):
                        pass
                ctlbuf = ctlbuf[-64:]
    return finish(master, pid, status, kill=False)

def finish(master, pid, status, kill):
    try:
        os.close(master)
    except OSError:
        pass
    if status is None and kill:
        # the extension went: SIGHUP (closing the pty sent one too), then SIGKILL after 3 s
        for sig, wait in ((signal.SIGHUP, 3), (signal.SIGKILL, 0)):
            try:
                os.killpg(pid, sig)
            except OSError:
                pass
            end = time.monotonic() + wait
            while status is None and time.monotonic() < end:
                done, st = os.waitpid(pid, os.WNOHANG)
                if done:
                    status = st
                else:
                    time.sleep(0.05)
            if status is not None:
                break
    if status is None:
        _, status = os.waitpid(pid, 0)
    return os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status)

try:
    sys.exit(main())
except KeyboardInterrupt:
    sys.exit(130)
`;

/** The helper's argv (after the interpreter): `-I -c <helper> cols rows program args...`. */
export function helperArgs(cols: number, rows: number, program: string, args: readonly string[]): string[] {
  const [c, r] = [clampDim(cols), clampDim(rows)];
  return ["-I", "-c", PTY_HELPER, String(c), String(r), program, ...args];
}

export function clampDim(n: number): number {
  if (!Number.isFinite(n)) return 1;
  return Math.min(DIM_MAX, Math.max(1, Math.floor(n)));
}

/** One resize message for fd 3. */
export function resizeLine(cols: number, rows: number): string {
  return `${clampDim(cols)} ${clampDim(rows)}\n`;
}
