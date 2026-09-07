import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { imageInput, messageInput, pasteImage } from "./attachments.js";

test("image references resolve relative/absolute/quoted paths and preserve multiline text", async () => {
  const cwd = mkdtempSync("/tmp/tui-images-");
  try {
    for (const name of ["a.png", "b.JPG", "space name.webp", "a.gif", "a.jpeg"]) writeFileSync(join(cwd, name), "fixture");
    const input = await messageInput(`look\n@a.png @${cwd}/b.JPG @"space name.webp" @a.gif @a.jpeg\n@notes.md`, cwd);
    expect(input[0]).toEqual({ type: "text", text: "look\n    \n@notes.md" });
    expect(input.slice(1).map(p => p.type === "image" && p.mime)).toEqual(["image/png", "image/jpeg", "image/webp", "image/gif", "image/jpeg"]);
    expect(await messageInput("@a.png @a.png", cwd)).toEqual([await imageInput("a.png", cwd)]);
    expect(await messageInput("  line one\n\tline two\n", cwd)).toEqual([{ type: "text", text: "  line one\n\tline two\n" }]);
    await expect(messageInput("@absent.png", cwd)).rejects.toThrow();
    await expect(imageInput("notes.md", cwd)).rejects.toThrow("图片格式");
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("clipboard gives actionable platform/install errors without spawning engines", async () => {
  await expect(pasteImage("linux", null)).rejects.toThrow("仅支持 macOS");
  await expect(pasteImage("darwin", null)).rejects.toThrow("brew install pngpaste");
});
