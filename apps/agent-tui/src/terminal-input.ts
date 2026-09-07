import { PassThrough } from "node:stream";
import { emitKeypressEvents } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import type { Key } from "./controller.js";

const pasteStart = "\x1b[200~", pasteEnd = "\x1b[201~";
const shifts = ["\x1b[13;2u", "\x1b[27;2;13~"];

/** Intercept bracketed paste before readline can turn pasted newlines into sends. */
export class TerminalInput {
  private stream = new PassThrough();
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private pasted: string | undefined;
  private timer?: ReturnType<typeof setTimeout>;
  constructor(private onKey: (text: string | undefined, key: Key) => void) {
    emitKeypressEvents(this.stream);
    this.stream.on("keypress", (text: string, key: Key) => onKey(text, key));
  }
  write(data: Buffer): void {
    clearTimeout(this.timer);
    this.buffer += this.decoder.write(data);
    while (this.buffer) {
      const markers = this.pasted === undefined ? [pasteStart, ...shifts] : [pasteEnd];
      const marker = markers.find(m => this.buffer.startsWith(m));
      if (marker) {
        this.buffer = this.buffer.slice(marker.length);
        if (marker === pasteStart) this.pasted = "";
        else if (marker === pasteEnd) { this.onKey(this.pasted?.replace(/\r\n?/g, "\n"), { paste: true }); this.pasted = undefined; }
        else this.onKey("\n", { name: "return", shift: true });
      } else if (markers.some(m => m.startsWith(this.buffer))) {
        // An isolated Escape must still reach readline. Paste framing may span chunks.
        if (this.pasted === undefined) this.timer = setTimeout(() => { this.stream.write(this.buffer); this.buffer = ""; }, 40);
        break;
      } else {
        const char = String.fromCodePoint(this.buffer.codePointAt(0)!); this.buffer = this.buffer.slice(char.length);
        if (this.pasted !== undefined) this.pasted += char;
        else if (char === "\n") this.onKey(char, { name: "j", ctrl: true });
        else this.stream.write(char);
      }
    }
  }
  close(): void { clearTimeout(this.timer); this.stream.destroy(); }
}
