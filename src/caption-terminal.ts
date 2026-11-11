import type { Caption } from './types.js';

/** A small original-text-only live area. Final captions become ordinary terminal history. */
export class CaptionTerminal {
  private readonly active = new Map<number, string>();
  private readonly finalized = new Set<number>();
  private rows = 0;
  constructor(private readonly output: { write: (text: string) => unknown; isTTY?: boolean; columns?: number } = process.stdout,
    private readonly print: (text: string) => void = (text) => console.log(text)) {}

  render(caption: Caption): void {
    if (caption.status === undefined) { if (!caption.revision) this.print(caption.originalText); return; }
    if (this.finalized.has(caption.sequence)) return;
    if (!this.output.isTTY) {
      if (caption.status === 'final') { this.print(caption.originalText); this.finalized.add(caption.sequence); }
      return;
    }
    this.clearArea();
    if (caption.status === 'final') {
      this.active.delete(caption.sequence); this.finalized.add(caption.sequence);
      this.output.write(caption.originalText + '\n');
    } else this.active.set(caption.sequence, caption.originalText);
    const lines = [...this.active.values()].slice(-8).map((text) => this.line(text));
    if (lines.length) this.output.write(lines.join('\n') + '\n');
    this.rows = lines.length;
  }
  finish(): void { this.active.clear(); this.finalized.clear(); this.rows = 0; }
  private clearArea(): void {
    if (this.rows) this.output.write(`\x1b[${this.rows}A\r\x1b[J`);
    this.rows = 0;
  }
  private line(text: string): string {
    const maximum = Math.max(10, (this.output.columns ?? 100) - 2);
    let result = '', width = 0;
    const characters = Array.from(text.replace(/[\r\n\t]/gu, ' '));
    for (let index = characters.length - 1; index >= 0; index--) {
      const character = characters[index]!;
      const point = character.codePointAt(0)!;
      const size = point >= 0x1100 && (point <= 0x115f || point >= 0x2e80 && point <= 0xa4cf
        || point >= 0xac00 && point <= 0xd7a3 || point >= 0xf900 && point <= 0xfaff || point >= 0xff01 && point <= 0xff60 || point >= 0x1f000) ? 2 : 1;
      if (width + size > maximum) return '…' + result;
      if (point >= 32 && point !== 127) { result = character + result; width += size; }
    }
    return result;
  }
}
