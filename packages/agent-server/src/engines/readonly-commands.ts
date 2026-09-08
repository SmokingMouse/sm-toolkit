// Default allowlist for the readonly-auto-allow gate: pure inspection commands only.
// git and find carry extra per-command checks below because some of their flags mutate state.
export const DEFAULT_READONLY_COMMANDS: readonly string[] = [
  "ls", "cat", "head", "tail", "wc", "find", "grep", "rg", "pwd", "echo", "stat", "file", "which", "env", "git",
];
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

interface Segments { segments: string[]; unsafe: boolean }

/**
 * Quote-aware split on top-level command separators: &&, ||, |, ;, a single & (background),
 * and newlines (\n, \r) which are just as much a top-level separator to a shell as ;.
 * Flags any redirection, subshell or command substitution as unsafe.
 */
function splitSegments(command: string): Segments {
  const segments: string[] = [];
  let current = "", quote: '"' | "'" | null = null, unsafe = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!, next = command[i + 1];
    if (quote) { current += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === "\\") { current += ch + (next ?? ""); i++; continue; }
    if (ch === "`" || ch === "(" || ch === ")" || ch === ">" || ch === "<") { unsafe = true; current += ch; continue; }
    if (ch === "\n" || ch === "\r") { segments.push(current); current = ""; continue; }
    if (ch === "&" && next === "&") { segments.push(current); current = ""; i++; continue; }
    if (ch === "|" && next === "|") { segments.push(current); current = ""; i++; continue; }
    if (ch === "|" || ch === ";" || ch === "&") { segments.push(current); current = ""; continue; }
    current += ch;
  }
  segments.push(current);
  if (quote) unsafe = true;
  return { segments, unsafe };
}

/** Quote-aware whitespace tokenizer; quotes are stripped, backslash escapes the next char. */
function tokenize(segment: string): string[] {
  const tokens: string[] = [];
  let current = "", quote: '"' | "'" | null = null, has = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]!;
    if (quote) { if (ch === quote) quote = null; else current += ch; has = true; continue; }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (ch === "\\" && i + 1 < segment.length) { current += segment[++i]; has = true; continue; }
    if (/\s/.test(ch)) { if (has) { tokens.push(current); current = ""; has = false; } continue; }
    current += ch; has = true;
  }
  if (has) tokens.push(current);
  return tokens;
}

export interface ReadonlyClassification { readonly: boolean; matchedRules: string[] }

/**
 * Classifies a Bash command as readonly-auto-allowable. Every top-level pipe/&&/||/;/&/newline
 * segment must resolve to an allowlisted leaf command invoked by bare name (a path — relative or
 * absolute — is always denied, since it could resolve to an attacker-planted same-named binary);
 * any redirection, subshell or command substitution anywhere in the command disqualifies the whole thing.
 */
export function classifyReadonlyCommand(command: string, allow: ReadonlySet<string> = new Set(DEFAULT_READONLY_COMMANDS)): ReadonlyClassification {
  const deny: ReadonlyClassification = { readonly: false, matchedRules: [] };
  const trimmed = command.trim();
  if (!trimmed) return deny;
  const { segments, unsafe } = splitSegments(trimmed);
  if (unsafe) return deny;
  const rules: string[] = [];
  for (const raw of segments) {
    const tokens = tokenize(raw);
    if (!tokens.length) continue;
    const [head, ...args] = tokens as [string, ...string[]];
    // A path (relative or absolute) can resolve to an attacker-planted same-named binary
    // (e.g. ./ls, /tmp/evil/ls); only a bare command name looked up on PATH is trusted.
    if (head.includes("/")) return deny;
    const name = head;
    if (!allow.has(name)) return deny;
    if (name === "git") {
      const sub = args.find(a => !a.startsWith("-"));
      if (!sub || !GIT_READONLY_SUBCOMMANDS.has(sub)) return deny;
      if (GIT_OUTPUT_SUBCOMMANDS.has(sub) && args.some(isGitWriteToFile)) return deny;
      if (sub === "branch" && args.filter(a => a !== sub).some(a => !BRANCH_READONLY_FLAGS.has(a))) return deny;
      rules.push(`git ${sub}`); continue;
    }
    if (name === "find") {
      if (args.some(isFindWriteFlag)) return deny;
      rules.push("find"); continue;
    }
    if (name === "env") {
      if (args.some(a => !a.startsWith("-"))) return deny;
      rules.push("env"); continue;
    }
    if (name === "file") {
      // `-C` compiles a magic file to <path>.mgc; `-m` selects the (writable-if-compiled) magic path.
      if (args.some(a => a === "-C" || a === "-m")) return deny;
      rules.push("file"); continue;
    }
    rules.push(name);
  }
  return rules.length ? { readonly: true, matchedRules: rules } : deny;
}
