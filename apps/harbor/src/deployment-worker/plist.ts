interface XmlNode {
  name: string;
  text: string;
  children: XmlNode[];
}

type Token =
  | { kind: "start"; name: string; selfClosing: boolean }
  | { kind: "end"; name: string }
  | { kind: "text"; value: string };

/**
 * Security boundary for launchd plists.  This is intentionally a strict XML
 * property-list parser, not a regexp: comments and character references have
 * XML semantics, and only the immediate root dictionary may define Label.
 */
export function exactPlistRootLabel(value: string): string {
  const root = parseXmlPlist(value);
  if (root.name !== "plist" || root.children.length !== 1 || root.children[0]?.name !== "dict") {
    throw new Error("launchd plist root 必须是仅含一个 dict 的 plist");
  }
  const entries = root.children[0].children;
  if (entries.length % 2 !== 0) throw new Error("launchd plist root dict key/value 不完整");
  const labels: XmlNode[] = [];
  for (let index = 0; index < entries.length; index += 2) {
    const key = entries[index]!;
    const candidate = entries[index + 1]!;
    if (key.name !== "key" || key.children.length > 0) throw new Error("launchd plist root dict key 无效");
    if (key.text === "Label") labels.push(candidate);
  }
  if (labels.length !== 1) throw new Error("launchd plist root Label 必须恰好一个");
  const label = labels[0]!;
  if (label.name !== "string" || label.children.length > 0) throw new Error("launchd plist root Label 必须是 string");
  if (!label.text) throw new Error("launchd plist root Label 不能为空");
  return label.text;
}

function parseXmlPlist(value: string): XmlNode {
  if (Buffer.byteLength(value, "utf8") > 1_048_576) throw new Error("launchd plist 超过 1MiB 安全上限");
  const tokens = tokenize(value.replace(/^\uFEFF/, ""));
  let index = 0;
  while (true) {
    const token = tokens[index];
    if (!token || token.kind !== "text" || token.value.trim()) break;
    index++;
  }
  const parseNode = (depth: number): XmlNode => {
    if (depth > 64) throw new Error("launchd plist XML 嵌套过深");
    const token = tokens[index++];
    if (!token || token.kind !== "start") throw new Error("launchd plist XML 缺少 element");
    const node: XmlNode = { name: token.name, text: "", children: [] };
    if (token.selfClosing) return node;
    while (true) {
      const next = tokens[index];
      if (!next) throw new Error(`launchd plist XML 缺少 </${node.name}>`);
      if (next.kind === "end") {
        index++;
        if (next.name !== node.name) throw new Error(`launchd plist XML end tag ${next.name} 不匹配 ${node.name}`);
        return node;
      }
      if (next.kind === "text") {
        index++;
        node.text += decodeXmlText(next.value);
      } else {
        node.children.push(parseNode(depth + 1));
      }
    }
  };
  const root = parseNode(0);
  if (tokens.slice(index).some((token) => token.kind !== "text" || token.value.trim())) {
    throw new Error("launchd plist XML 包含多个 document root");
  }
  validatePlistNode(root);
  return root;
}

function tokenize(value: string): Token[] {
  const tokens: Token[] = [];
  let offset = 0;
  while (offset < value.length) {
    if (value.startsWith("<!--", offset)) {
      const end = value.indexOf("-->", offset + 4);
      if (end < 0) throw new Error("launchd plist XML comment 未闭合");
      offset = end + 3;
      continue;
    }
    if (value.startsWith("<?", offset)) {
      const end = value.indexOf("?>", offset + 2);
      if (end < 0) throw new Error("launchd plist XML declaration 未闭合");
      offset = end + 2;
      continue;
    }
    if (value.startsWith("<!DOCTYPE", offset)) {
      const end = value.indexOf(">", offset + 9);
      if (end < 0) throw new Error("launchd plist DOCTYPE 未闭合");
      const declaration = value.slice(offset, end + 1);
      if (!/^<!DOCTYPE\s+plist\s+PUBLIC\s+"-\/\/Apple\/\/DTD PLIST 1\.0\/\/EN"\s+"https?:\/\/www\.apple\.com\/DTDs\/PropertyList-1\.0\.dtd"\s*>$/i.test(declaration)) {
        throw new Error("launchd plist 只允许标准 Apple DOCTYPE，禁止自定义 entity");
      }
      offset = end + 1;
      continue;
    }
    if (value[offset] === "<") {
      const end = value.indexOf(">", offset + 1);
      if (end < 0) throw new Error("launchd plist XML tag 未闭合");
      const raw = value.slice(offset + 1, end);
      if (raw.startsWith("!") || raw.startsWith("?")) throw new Error("launchd plist XML directive 不受支持");
      const closing = raw.startsWith("/");
      const selfClosing = !closing && /\/\s*$/.test(raw);
      const body = raw.replace(/^\//, "").replace(/\/\s*$/, "").trim();
      const match = body.match(/^([A-Za-z][A-Za-z0-9_-]*)([\s\S]*)$/);
      if (!match) throw new Error("launchd plist XML tag name 无效");
      const name = match[1]!;
      const attributes = match[2]!.trim();
      if (attributes && !(name === "plist" && /^version\s*=\s*(["'])1\.0\1$/.test(attributes))) {
        throw new Error(`launchd plist ${name} 含不允许的 attribute`);
      }
      tokens.push(closing ? { kind: "end", name } : { kind: "start", name, selfClosing });
      offset = end + 1;
      continue;
    }
    const end = value.indexOf("<", offset);
    tokens.push({ kind: "text", value: value.slice(offset, end < 0 ? value.length : end) });
    offset = end < 0 ? value.length : end;
  }
  return tokens.filter((token) => token.kind !== "text" || token.value.length > 0);
}

function decodeXmlText(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_whole, entity: string) => {
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    if (entity[0] !== "#") return named[entity.toLowerCase()]!;
    const codePoint = entity[1]?.toLowerCase() === "x"
      ? Number.parseInt(entity.slice(2), 16)
      : Number.parseInt(entity.slice(1), 10);
    if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
      throw new Error("launchd plist XML character reference 无效");
    }
    return String.fromCodePoint(codePoint);
  }).replace(/&[^;\s]*;/g, () => { throw new Error("launchd plist XML entity 不受支持"); });
}

function validatePlistNode(node: XmlNode): void {
  const containers = new Set(["plist", "dict", "array"]);
  const scalars = new Set(["key", "string", "integer", "real", "date", "data", "true", "false"]);
  if (!containers.has(node.name) && !scalars.has(node.name)) throw new Error(`launchd plist XML element ${node.name} 不受支持`);
  if (containers.has(node.name) && node.text.trim()) throw new Error(`launchd plist ${node.name} 不能包含非空白 text`);
  if (scalars.has(node.name) && node.children.length) throw new Error(`launchd plist ${node.name} 不能包含 child element`);
  if ((node.name === "true" || node.name === "false") && node.text.trim()) throw new Error(`launchd plist ${node.name} 必须为空`);
  for (const child of node.children) validatePlistNode(child);
}
