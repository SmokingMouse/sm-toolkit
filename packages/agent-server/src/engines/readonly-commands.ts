import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

// Default allowlist for the readonly-auto-allow gate: pure inspection commands only.
// `env` is deliberately absent: it is a program launcher (see HARD_BANNED_HEADS) and can never be
// auto-allowed no matter what a caller configures.
export const DEFAULT_READONLY_COMMANDS: readonly string[] = [
  "ls", "cat", "head", "tail", "wc", "find", "grep", "rg", "pwd", "echo", "stat", "file", "which", "git",
];

// argv[0] must resolve, via a real PATH lookup, to a file inside one of these directories. This
// closes the PATH-hijack case: an attacker who can prepend a directory to PATH (e.g. via a prior
// tool call, a repo-local .envrc, etc.) cannot get a bare `ls` to resolve to a planted binary,
// because the resolved directory would not be in this list.
export const DEFAULT_SYSTEM_BIN_DIRS: readonly string[] = [
  "/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/local/sbin", "/opt/homebrew/bin", "/opt/homebrew/sbin",
];

// Names that are never auto-allowed as argv[0], regardless of what `allow` (even a caller-supplied
// custom set) contains. Every one of these launches or delegates to another program under
// attacker-controlled input, which is exactly the escape hatch this gate exists to close: `env -S`
// (P0-B), `xargs`, `sh -c`, `eval`, etc. are all the same class of risk as the readonly command
// itself being a decoy for a wrapped write.
const HARD_BANNED_HEADS = new Set([
  "env", "command", "exec", "xargs", "source", ".", "eval",
  "sudo", "doas", "time", "nice", "nohup", "sh", "bash", "zsh", "script", "expect",
]);

const GIT_READONLY_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "rev-parse", "branch"]);
// git-diff-options(1) --output=<file> writes to disk instead of stdout, and it is inherited by log/diff/show.
const GIT_OUTPUT_SUBCOMMANDS = new Set(["log", "diff", "show"]);
function isGitWriteToFile(arg: string): boolean { return arg === "--output" || arg.startsWith("--output="); }
// `git branch` is only readonly when it is a pure listing invocation: no positional args (branch
// names) and only flags that list/inspect. Anything else (create/delete/rename/move/set-upstream) mutates refs.
const BRANCH_READONLY_FLAGS = new Set(["-a", "-l", "-r", "--list", "--show-current", "-v"]);

function isFindWriteFlag(arg: string): boolean {
  // Prefix families so unlisted GNU/BSD variants (e.g. a future -fprintNN) still get caught.
  return arg === "-delete" || /^-f(ls|print0?|printf)$/.test(arg) || /^-(exec|execdir|ok|okdir)/.test(arg);
}

// ripgrep's --pre/--pre-glob and --hostname-bin all exec an attacker-influenceable command per
// matched file; grep has no such flags today but is checked identically for defense in depth.
function isSearchExecFlag(arg: string): boolean {
  return arg === "--pre" || arg.startsWith("--pre=") || arg === "--pre-glob" || arg.startsWith("--pre-glob=") ||
    arg === "--hostname-bin" || arg.startsWith("--hostname-bin=");
}

interface ParsedScript { commands: string[][] }

/**
 * Fail-closed shell tokenizer for the readonly-auto-allow gate. See out/result.md for the BNF and
 * the rationale for hand-writing this instead of pulling in a general bash parser.
 *
 * Design: parsing FAILS (returns null, which the caller treats as "deny") the instant the input
 * contains anything outside a deliberately small allowed shape, rather than trying to faithfully
 * parse full shell grammar. `$` and a backtick are rejected unconditionally, everywhere in the
 * string, including inside single quotes -- real shells treat single quotes as inert, but this
 * gate does not rely on that distinction being bug-free, so it denies regardless of quoting.
 * Unquoted `<`, `>`, `(`, `)` are rejected as operators (redirection, heredoc, subshell, process
 * substitution all start with one of these); the same characters *inside* a quote are ordinary
 * literal text, matching real shell semantics, and are accepted.
 */
function parseScript(command: string): ParsedScript | null {
  // Command substitution ($( ), `...`), parameter expansion (${...}), and arithmetic expansion
  // ($(( ))) all start with one of these two characters; ban them unconditionally, in any quoting
  // context, rather than trying to prove a specific occurrence is inert.
  if (/[`$]/.test(command)) return null;

  const commands: string[][] = [];
  let words: string[] = [];
  let word = "";
  let hasWord = false;
  let quote: '"' | "'" | null = null;

  const pushWord = () => { if (hasWord) { words.push(word); word = ""; hasWord = false; } };
  const pushCommand = () => { pushWord(); if (words.length) commands.push(words); words = []; };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote === "'") {
      if (ch === "'") { quote = null; continue; }
      word += ch; hasWord = true; continue;
    }
    if (quote === '"') {
      if (ch === '"') { quote = null; continue; }
      if (ch === "\\") {
        const nxt = command[i + 1];
        // POSIX: inside double quotes, backslash is only special before ", \, or a line
        // continuation ($ and ` are already banned above, so those escape forms cannot occur).
        if (nxt === '"' || nxt === "\\") { word += nxt; hasWord = true; i++; continue; }
        if (nxt === "\n") { i++; continue; }
        word += ch; hasWord = true; continue;
      }
      word += ch; hasWord = true; continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; hasWord = true; continue; }
    if (ch === "\\") {
      if (i + 1 >= command.length) return null; // dangling escape
      word += command[i + 1]; hasWord = true; i++; continue;
    }
    // Redirection, heredoc (a doubled '<'), subshell grouping, and process substitution (`<(`/`>(`)
    // all start with an unquoted '<', '>', '(' or ')' -- reject the operator outright.
    if (ch === "<" || ch === ">" || ch === "(" || ch === ")") return null;
    if (ch === "\n" || ch === "\r") { pushCommand(); continue; }
    if (/\s/.test(ch)) { pushWord(); continue; }
    if (ch === "&") {
      if (command[i + 1] === "&") { pushCommand(); i++; continue; }
      return null; // bare `&` (background) is not an allowed connector
    }
    if (ch === "|") {
      if (command[i + 1] === "|") { pushCommand(); i++; continue; }
      if (command[i + 1] === "&") return null; // `|&` is not an allowed connector
      pushCommand(); continue;
    }
    if (ch === ";") { pushCommand(); continue; }
    word += ch; hasWord = true;
  }
  if (quote) return null; // unterminated quote
  pushCommand();
  return { commands };
}

function realpathOrSelf(dir: string): string {
  try { return realpathSync(dir); } catch { return dir; }
}

function pathSearchDirs(options: ReadonlyClassificationOptions): readonly string[] {
  if (options.pathDirs) return options.pathDirs;
  return (process.env.PATH ?? "").split(":").filter(Boolean);
}

/**
 * Resolves `name` via a real PATH lookup (first matching directory wins, same as a shell) and
 * returns that directory (realpath-normalized), or null if no directory has an executable file by
 * that name. Deliberately attributes the result to the PATH entry the name was found under rather
 * than following the target through to its final destination: package managers commonly place a
 * stable symlink in a system bin dir (e.g. Homebrew's /opt/homebrew/bin/git -> .../Cellar/git/
 * 2.x/bin/git) and fully resolving through that would put the deep, version-specific Cellar path
 * outside `systemDirs` and deny every such command. The directory an attacker could actually
 * plant a same-named binary in -- by prepending it to PATH -- is exactly this first-match
 * directory, so checking it (rather than the symlink target) still closes the PATH-hijack case.
 */
function resolveExecutableDir(name: string, dirs: readonly string[]): string | null {
  for (const dir of dirs) {
    const candidate = join(dir, name);
    try {
      const info = statSync(candidate); // follows symlinks to confirm a real file exists
      if (!info.isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return realpathOrSelf(dir);
    } catch {
      continue;
    }
  }
  return null;
}

export interface ReadonlyClassificationOptions {
  /** Directories a resolved executable must live in. Defaults to DEFAULT_SYSTEM_BIN_DIRS. */
  systemDirs?: readonly string[];
  /** Overrides the directories searched to resolve argv[0]. Defaults to process.env.PATH. Exists
   *  primarily so tests do not depend on the host's installed binary layout. */
  pathDirs?: readonly string[];
}

export interface ReadonlyClassification { readonly: boolean; matchedRules: string[] }

/**
 * Classifies a Bash command as readonly-auto-allowable. The command must parse under the strict
 * grammar in parseScript (see out/result.md for the BNF); every resulting simple command must
 * invoke a bare (path-free) name that is (a) never in HARD_BANNED_HEADS, (b) present in `allow`,
 * (c) resolvable via a real PATH lookup to a file inside `options.systemDirs`, and (d) pass that
 * command's own argument validator. Any failure at any stage denies the *entire* command -- this
 * function has no partial-allow mode.
 */
export function classifyReadonlyCommand(
  command: string,
  allow: ReadonlySet<string> = new Set(DEFAULT_READONLY_COMMANDS),
  options: ReadonlyClassificationOptions = {},
): ReadonlyClassification {
  const deny: ReadonlyClassification = { readonly: false, matchedRules: [] };
  const trimmed = command.trim();
  if (!trimmed) return deny;

  const parsed = parseScript(trimmed);
  if (!parsed) return deny;

  // Normalize through realpath so a symlinked system dir (e.g. macOS's /tmp -> /private/tmp, used
  // by tests, or a distro symlinking /bin -> /usr/bin) still matches the realpath'd resolution
  // result below instead of failing closed on a spurious string mismatch.
  const systemDirs = (options.systemDirs ?? DEFAULT_SYSTEM_BIN_DIRS).map(realpathOrSelf);
  const searchDirs = pathSearchDirs(options);

  const rules: string[] = [];
  for (const tokens of parsed.commands) {
    if (!tokens.length) continue;
    const [head, ...args] = tokens as [string, ...string[]];
    // A path (relative or absolute) can resolve to an attacker-planted same-named binary
    // (e.g. ./ls, /tmp/evil/ls); only a bare command name looked up on PATH is trusted.
    if (head.includes("/")) return deny;
    const name = head;
    if (HARD_BANNED_HEADS.has(name)) return deny;
    if (!allow.has(name)) return deny;
    const resolvedDir = resolveExecutableDir(name, searchDirs);
    if (!resolvedDir || !systemDirs.includes(resolvedDir)) return deny;

    if (name === "git") {
      // No global flags at all: this alone closes --exec-path, --config-env, --git-dir,
      // --work-tree, -C, -c, etc. -- none of them can appear before the subcommand token.
      const sub = args[0];
      if (!sub || sub.startsWith("-") || !GIT_READONLY_SUBCOMMANDS.has(sub)) return deny;
      const subArgs = args.slice(1);
      if (GIT_OUTPUT_SUBCOMMANDS.has(sub) && subArgs.some(isGitWriteToFile)) return deny;
      if (sub === "branch" && subArgs.some(a => !BRANCH_READONLY_FLAGS.has(a))) return deny;
      rules.push(`git ${sub}`); continue;
    }
    if (name === "find") {
      if (args.some(isFindWriteFlag)) return deny;
      rules.push("find"); continue;
    }
    if (name === "grep" || name === "rg") {
      if (args.some(isSearchExecFlag)) return deny;
      rules.push(name); continue;
    }
    if (name === "file") {
      // `-C` compiles a magic file to <path>.mgc; `-m` selects the (writable-if-compiled) magic path.
      if (args.some(a => a === "-C" || a === "-m")) return deny;
      rules.push("file"); continue;
    }
    // ls/cat/head/tail/wc/pwd/echo/stat/which: no flags of theirs write or execute anything, and
    // the grammar above already rejects every form of redirection, so no further arg validation
    // is needed -- see out/result.md for the explicit scope call on this.
    rules.push(name);
  }
  return rules.length ? { readonly: true, matchedRules: rules } : deny;
}
