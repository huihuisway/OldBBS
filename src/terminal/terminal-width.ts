const combining = /\p{Mark}/u;

export function characterWidth(character: string): number {
  const code = character.codePointAt(0) ?? 0;
  if (code === 0 || code < 32 || (code >= 0x7f && code < 0xa0) || combining.test(character) || code === 0x200d || (code >= 0xfe00 && code <= 0xfe0f)) return 0;
  if (
    (code >= 0x1100 && code <= 0x11ff) || (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7af) || (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) || (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  ) return 2;
  return 1;
}

export function stringWidth(value: string): number {
  return Array.from(value).reduce((width, character) => width + characterWidth(character), 0);
}

export function centerColumns(value: string, columns: number): string {
  const visible = truncateColumns(value, columns);
  const left = Math.max(0, Math.floor((columns - stringWidth(visible)) / 2));
  return `${' '.repeat(left)}${visible}${' '.repeat(Math.max(0, columns - left - stringWidth(visible)))}`;
}

export function truncateColumns(value: string, columns: number): string {
  let width = 0;
  let result = '';
  for (const character of Array.from(value)) {
    const next = characterWidth(character);
    if (width + next > columns) break;
    result += character;
    width += next;
  }
  return result;
}

export function wrapColumns(value: string, columns: number): string[] {
  const lines: string[] = [];
  for (const sourceLine of value.split('\n')) {
    let line = '';
    let width = 0;
    for (const character of Array.from(sourceLine)) {
      const next = characterWidth(character);
      if (width + next > columns && line) {
        lines.push(line);
        line = '';
        width = 0;
      }
      line += character;
      width += next;
    }
    lines.push(line);
  }
  return lines;
}
