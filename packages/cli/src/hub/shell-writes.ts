import os from "node:os";
import path from "node:path";

/**
 * Files a shell command clearly writes, best effort (docs/SPEC.md §23): the targets of `>`/`>>` redirections, `tee`,
 * `rm`, `mv`, `cp` (the destination), `touch`, `truncate`, `ln` (the link), `dd of=`, `sed -i`/`perl -i`, and
 * `git rm|mv|restore` / `git checkout -- <paths>`. `cd` earlier in the command moves the base for relative paths.
 * Anything it can't read plainly (variables, command substitution, a script's own writes) is not a target: a lease
 * check on shell commands only ever refuses a command that names a leased file.
 *
 * Returns absolute, normalized paths. A target may keep a glob (`rm src/*.ts`); callers match those as globs.
 */

type Token = { t: "word"; v: string; quoted: boolean } | { t: "op"; v: string } | { t: "redir"; v: string };

const SEPARATORS = new Set(["&&", "||", ";", "|", "|&", "&", "\n", "(", ")"]);
/** Wrappers that run the next word as the command. */
const WRAPPERS = new Set(["sudo", "command", "env", "time", "nohup", "nice", "exec", "builtin", "xargs"]);

/** A rough POSIX-shell lexer: quotes, escapes, operators, redirections, heredoc bodies skipped. */
function lex(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let pendingHeredocs: string[] = [];
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (c === "\n") {
      out.push({ t: "op", v: "\n" });
      i++;
      // Skip heredoc bodies: lines up to each delimiter.
      for (const delim of pendingHeredocs) {
        while (i < n) {
          const end = src.indexOf("\n", i);
          const line = src.slice(i, end === -1 ? n : end);
          i = end === -1 ? n : end + 1;
          if (line.trim() === delim) break;
        }
      }
      pendingHeredocs = [];
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    if (c === "#" && (out.length === 0 || src[i - 1] === " " || src[i - 1] === "\t" || src[i - 1] === "\n")) {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    // Operators.
    const two = src.slice(i, i + 2);
    const three = src.slice(i, i + 3);
    if (three === "<<<") {
      out.push({ t: "redir", v: "<<<" });
      i += 3;
      continue;
    }
    if (two === "<<") {
      i += src[i + 2] === "-" ? 3 : 2;
      // The delimiter word.
      while (src[i] === " " || src[i] === "\t") i++;
      const { word } = readWord(src, i);
      const delim = word.v.replace(/^['"]|['"]$/g, "");
      i = word.end;
      if (delim) pendingHeredocs.push(delim);
      continue;
    }
    if (two === "&&" || two === "||" || two === "|&") {
      out.push({ t: "op", v: two });
      i += 2;
      continue;
    }
    if (two === "&>") {
      const append = src[i + 2] === ">";
      out.push({ t: "redir", v: append ? "&>>" : "&>" });
      i += append ? 3 : 2;
      continue;
    }
    if (c === ">" || c === "<") {
      let v = c;
      i++;
      if (src[i] === ">" && c === ">") {
        v = ">>";
        i++;
      } else if (src[i] === "|" && c === ">") {
        i++;
      }
      if (src[i] === "&") {
        // `>&2`, `2>&1`: a duplication, not a file.
        i++;
        while (i < n && /[\d-]/.test(src[i]!)) i++;
        continue;
      }
      out.push({ t: "redir", v });
      continue;
    }
    if (c === ";" || c === "|" || c === "&" || c === "(" || c === ")") {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    const { word } = readWord(src, i);
    i = word.end;
    // `2>file`, `1>>file`: a word of digits glued to a redirection is its fd, not an argument.
    if (/^\d+$/.test(word.v) && !word.quoted && (src[i] === ">" || src[i] === "<")) continue;
    out.push({ t: "word", v: word.v, quoted: word.quoted });
  }
  return out;
}

/** Reads one shell word from `i`: quotes and escapes resolved, `$(…)` and backticks kept as opaque text. */
function readWord(src: string, start: number): { word: { v: string; end: number; quoted: boolean } } {
  let i = start;
  let v = "";
  let quoted = false;
  const n = src.length;
  while (i < n) {
    const c = src[i]!;
    if (" \t\r\n;&|<>()".includes(c)) break;
    if (c === "\\") {
      if (i + 1 < n && src[i + 1] !== "\n") v += src[i + 1];
      i += 2;
      continue;
    }
    if (c === "'") {
      quoted = true;
      const end = src.indexOf("'", i + 1);
      v += src.slice(i + 1, end === -1 ? n : end);
      i = end === -1 ? n : end + 1;
      continue;
    }
    if (c === '"') {
      quoted = true;
      let j = i + 1;
      while (j < n && src[j] !== '"') {
        if (src[j] === "\\" && j + 1 < n) {
          v += src[j + 1];
          j += 2;
          continue;
        }
        v += src[j];
        j++;
      }
      i = j + 1;
      continue;
    }
    if (c === "$" && src[i + 1] === "(") {
      // Command substitution: opaque (and never a plain path).
      let depth = 0;
      let j = i + 1;
      for (; j < n; j++) {
        if (src[j] === "(") depth++;
        else if (src[j] === ")" && --depth === 0) break;
      }
      v += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      v += src.slice(i, end === -1 ? n : end + 1);
      i = end === -1 ? n : end + 1;
      continue;
    }
    v += c;
    i++;
  }
  return { word: { v, end: i, quoted } };
}

/** A word that is plainly a path (no variables, substitutions or brace expansion). */
function plainPath(w: string): boolean {
  return w.length > 0 && w.length <= 1024 && !/[$`{}\n]/.test(w) && w !== "-";
}

function resolve(w: string, cwd: string | undefined, home: string): string | undefined {
  if (!plainPath(w)) return undefined;
  let p = w;
  if (p === "~" || p.startsWith("~/")) p = path.join(home, p.slice(1));
  else if (p.startsWith("~")) return undefined; // ~user
  if (!path.isAbsolute(p)) {
    if (!cwd || !path.isAbsolute(cwd)) return undefined;
    p = path.join(cwd, p);
  }
  p = path.normalize(p);
  if (p.length > 1) p = p.replace(/\/+$/, "");
  if (p.startsWith("/dev/") || p === "/dev" || p.startsWith("/proc/")) return undefined;
  return p;
}

function nonFlags(args: readonly string[]): string[] {
  const out: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === "--") {
      ended = true;
      continue;
    }
    if (!ended && a.startsWith("-") && a !== "-") continue;
    out.push(a);
  }
  return out;
}

/** The files one simple command (program + args) writes, as words. */
function commandWrites(argv: readonly string[]): string[] {
  let k = 0;
  // Leading env assignments and wrappers.
  for (;;) {
    const w = argv[k];
    if (w === undefined) return [];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      k++;
      continue;
    }
    if (WRAPPERS.has(path.basename(w))) {
      k++;
      while (argv[k]?.startsWith("-")) k++;
      continue;
    }
    break;
  }
  const prog = path.basename(argv[k] ?? "");
  const args = argv.slice(k + 1);
  switch (prog) {
    case "tee":
    case "rm":
    case "touch":
    case "unlink":
    case "shred":
      return nonFlags(args);
    case "truncate": {
      const out: string[] = [];
      for (let j = 0; j < args.length; j++) {
        const a = args[j]!;
        if (a === "-s" || a === "--size" || a === "-r" || a === "--reference") j++;
        else if (!a.startsWith("-")) out.push(a);
      }
      return out;
    }
    case "mv":
      return nonFlags(args);
    case "cp":
    case "install":
    case "rsync": {
      const files = nonFlags(args);
      if (files.length < 2) return [];
      const dest = files.at(-1)!;
      // A directory destination receives each source under its own name.
      return [dest, ...files.slice(0, -1).map((s) => `${dest.replace(/\/+$/, "")}/${path.basename(s)}`)];
    }
    case "ln": {
      const files = nonFlags(args);
      return files.length >= 2 ? [files.at(-1)!] : [];
    }
    case "dd":
      return args.filter((a) => a.startsWith("of=")).map((a) => a.slice(3));
    case "sed":
    case "gsed":
    case "perl": {
      const inPlace = args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith("--in-place"));
      if (!inPlace) return [];
      const out: string[] = [];
      let scriptSeen = args.some((a) => a === "-e" || a === "--expression" || /^-[a-zA-Z]*e$/.test(a));
      for (let j = 0; j < args.length; j++) {
        const a = args[j]!;
        if (a === "-e" || a === "--expression" || a === "-f" || /^-[a-zA-Z]*e$/.test(a)) {
          j++; // its script
          continue;
        }
        if (a.startsWith("-")) {
          // BSD `sed -i ''` / `-i .bak`: the suffix is its own word.
          if (/^-i$/.test(a) && prog !== "perl" && (args[j + 1] === "" || /^\.\w+$/.test(args[j + 1] ?? ""))) j++;
          continue;
        }
        if (!scriptSeen) {
          scriptSeen = true;
          continue;
        }
        out.push(a);
      }
      return out;
    }
    case "git": {
      const sub = args.find((a) => !a.startsWith("-"));
      const rest = sub ? args.slice(args.indexOf(sub) + 1) : [];
      if (sub === "rm" || sub === "mv" || sub === "restore") return nonFlags(rest);
      if (sub === "checkout") {
        const dd = rest.indexOf("--");
        return dd === -1 ? [] : rest.slice(dd + 1);
      }
      return [];
    }
    default:
      return [];
  }
}

/**
 * The simple commands in `command` (run in `cwd`), each with the directory it runs in (`cd` earlier in the command
 * moves it). Words are as the shell would see them after quoting; heredoc bodies are skipped. Used by the v2 gate
 * matcher (daemon/gates.ts).
 */
export function shellCommands(command: string, cwd: string | undefined, home = os.homedir()): Array<{ argv: string[]; cwd?: string }> {
  if (!command || command.length > 64 * 1024) return [];
  let tokens: Token[];
  try {
    tokens = lex(command);
  } catch {
    return [];
  }
  const out: Array<{ argv: string[]; cwd?: string }> = [];
  let base = cwd;
  let argv: string[] = [];
  const flush = (): void => {
    if (argv.length === 0) return;
    if (argv[0] === "cd" || argv[0] === "pushd") {
      const dir = argv[1];
      if (dir && dir !== "-") base = resolve(dir, base, home) ?? base;
    } else {
      out.push({ argv, ...(base ? { cwd: base } : {}) });
    }
    argv = [];
  };
  for (let j = 0; j < tokens.length; j++) {
    const tok = tokens[j]!;
    if (tok.t === "redir") {
      if (tokens[j + 1]?.t === "word") j++;
      continue;
    }
    if (tok.t === "op") {
      if (SEPARATORS.has(tok.v)) flush();
      continue;
    }
    argv.push(tok.v);
  }
  flush();
  return out.slice(0, 200);
}

/** Absolute paths `command` (run in `cwd`) clearly writes. */
export function shellWriteTargets(command: string, cwd: string | undefined, home = os.homedir()): string[] {
  if (!command || command.length > 64 * 1024) return [];
  let tokens: Token[];
  try {
    tokens = lex(command);
  } catch {
    return [];
  }
  const out = new Set<string>();
  let base = cwd;
  let argv: string[] = [];
  const flush = (): void => {
    if (argv.length === 0) return;
    if (argv[0] === "cd" || argv[0] === "pushd") {
      const dir = argv[1];
      if (dir && dir !== "-") base = resolve(dir, base, home) ?? base;
    } else {
      for (const w of commandWrites(argv)) {
        const p = resolve(w, base, home);
        if (p) out.add(p);
      }
    }
    argv = [];
  };
  for (let j = 0; j < tokens.length; j++) {
    const tok = tokens[j]!;
    if (tok.t === "redir") {
      const target = tokens[j + 1];
      if (target?.t === "word") {
        j++;
        if (tok.v === ">" || tok.v === ">>" || tok.v === "&>" || tok.v === "&>>") {
          const p = resolve(target.v, base, home);
          if (p) out.add(p);
        }
      }
      continue;
    }
    if (tok.t === "op") {
      if (SEPARATORS.has(tok.v)) flush();
      continue;
    }
    argv.push(tok.v);
  }
  flush();
  return [...out].slice(0, 50);
}
