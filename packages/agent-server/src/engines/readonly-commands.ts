// Default allowlist for the readonly-auto-allow gate: pure inspection commands only.
// git and find carry extra per-command checks below because some of their flags mutate state.
export const DEFAULT_READONLY_COMMANDS: readonly string[] = [
  "ls", "cat", "head", "tail", "wc", "find", "grep", "rg", "pwd", "echo", "stat", "file", "which", "env", "git",
];
const GIT_READONLY_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "rev-parse", "branch"]);
const FIND_WRITE_FLAGS = new Set(["-delete", "-exec", "-execdir", "-fprint", "-fprint0", "-fprintf", "-ok", "-okdir"]);

interface Segments { segments: string[]; unsafe: boolean }

/** Quote-aware split on top-level &&, ||, |, ; ; flags any redirection, subshell or command substitution as unsafe. */
function splitSegments(command: string): Segments {
  const segments: string[] = [];
  let current = "", quote: '"' | "'" | null = null, unsafe = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!, next = command[i + 1];
    if (quote) { current += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === "\\") { current += ch + (next ?? ""); i++; continue; }
    if (ch === "`" || ch === "(" || ch === ")" || ch === ">" || ch === "<") { unsafe = true; current += ch; continue; }
    if (ch === "&" && next === "&") { segments.push(current); current = ""; i++; continue; }
    if (ch === "|" && next === "|") { segments.push(current); current = ""; i++; continue; }
    if (ch === "|" || ch === ";") { segments.push(current); current = ""; continue; }
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
 * Classifies a Bash command as readonly-auto-allowable. Every top-level pipe/&&/||/; segment
 * must resolve to an allowlisted leaf command; any redirection, subshell or command
 * substitution anywhere in the command disqualifies the whole thing.
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
    const name = head.split("/").pop() || head;
    if (!allow.has(name)) return deny;
    if (name === "git") {
      const sub = args.find(a => !a.startsWith("-"));
      if (!sub || !GIT_READONLY_SUBCOMMANDS.has(sub)) return deny;
      rules.push(`git ${sub}`); continue;
    }
    if (name === "find") {
      if (args.some(a => FIND_WRITE_FLAGS.has(a))) return deny;
      rules.push("find"); continue;
    }
    if (name === "env") {
      if (args.some(a => !a.startsWith("-"))) return deny;
      rules.push("env"); continue;
    }
    rules.push(name);
  }
  return rules.length ? { readonly: true, matchedRules: rules } : deny;
}
