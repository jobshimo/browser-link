import { stdin, stdout } from 'node:process';

/* ANSI helpers — no dependencies. Modern terminals (macOS Terminal, iTerm,
 * Windows Terminal, PowerShell 7+, every Linux TTY) understand these.
 * Old cmd.exe may render the box characters poorly but the flow still works. */

const ESC = '\x1b';

export const ansi = {
  reset: `${ESC}[0m`,
  bold: `${ESC}[1m`,
  dim: `${ESC}[2m`,
  italic: `${ESC}[3m`,
  underline: `${ESC}[4m`,

  black: `${ESC}[30m`,
  red: `${ESC}[31m`,
  green: `${ESC}[32m`,
  yellow: `${ESC}[33m`,
  blue: `${ESC}[34m`,
  magenta: `${ESC}[35m`,
  cyan: `${ESC}[36m`,
  white: `${ESC}[37m`,
  gray: `${ESC}[90m`,

  bgYellow: `${ESC}[43m`,
  bgRed: `${ESC}[41m`,

  clearScreen: `${ESC}[2J${ESC}[H`,
  hideCursor: `${ESC}[?25l`,
  showCursor: `${ESC}[?25h`,
};

export const KEY = {
  CTRL_C: '\x03',
  ESC: '\x1b',
  ENTER_CR: '\r',
  ENTER_LF: '\n',
  UP: '\x1b[A',
  DOWN: '\x1b[B',
  RIGHT: '\x1b[C',
  LEFT: '\x1b[D',
};

/** Visible width of a string (ignores ANSI escape sequences). Treats every
 * other code point as 1 column — fine for ASCII + the Latin range we use. */
export function visibleWidth(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').length;
}

export function padRight(s: string, width: number): string {
  const diff = width - visibleWidth(s);
  return diff > 0 ? s + ' '.repeat(diff) : s;
}

/** Wrap a line at the given width, preserving simple ANSI runs. */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const lines: string[] = [];
  for (const paragraph of text.split('\n')) {
    if (visibleWidth(paragraph) <= width) {
      lines.push(paragraph);
      continue;
    }
    const words = paragraph.split(/\s+/);
    let cur = '';
    for (const w of words) {
      if (cur.length === 0) {
        cur = w;
      } else if (visibleWidth(cur) + 1 + visibleWidth(w) > width) {
        lines.push(cur);
        cur = w;
      } else {
        cur += ' ' + w;
      }
    }
    if (cur.length > 0) lines.push(cur);
  }
  return lines;
}

export interface BoxOptions {
  width?: number;
  borderColor?: string;
}

const B = {
  tl: '╭', tr: '╮', bl: '╰', br: '╯',
  h: '─', v: '│',
};

/** Render an array of lines inside a rounded Unicode box. */
export function renderBox(lines: string[], opts: BoxOptions = {}): string {
  const termWidth = stdout.columns ?? 80;
  // 86 cols comfortably fits the longest pre-formatted line in About
  // (tool name + padded description). Smaller terminals still get the cap.
  const width = Math.min(opts.width ?? 86, Math.max(40, termWidth - 2));
  const inner = width - 2; // 2 columns for the vertical borders
  const wrapped = lines.flatMap((l) => wrap(l, inner - 2)); // padding 1 each side

  const color = opts.borderColor ?? '';
  const reset = color ? ansi.reset : '';
  const top = `${color}${B.tl}${B.h.repeat(inner)}${B.tr}${reset}`;
  const bottom = `${color}${B.bl}${B.h.repeat(inner)}${B.br}${reset}`;
  const body = wrapped.map((l) => `${color}${B.v}${reset} ${padRight(l, inner - 2)} ${color}${B.v}${reset}`);

  return [top, ...body, bottom].join('\n');
}

/** Read a single keypress from stdin without echoing. Returns the raw key
 * (a control sequence for arrows, '\r' for enter, etc.). */
export function readKey(): Promise<string> {
  return new Promise((resolve) => {
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const onData = (data: string | Buffer) => {
      const key = data.toString();
      stdin.off('data', onData);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
      resolve(key);
    };
    stdin.on('data', onData);
  });
}

/** Classify a raw key into a logical name. */
export function classifyKey(raw: string): string {
  if (raw === KEY.CTRL_C) return 'ctrl-c';
  if (raw === KEY.ESC) return 'esc';
  if (raw === KEY.ENTER_CR || raw === KEY.ENTER_LF) return 'enter';
  if (raw === KEY.UP) return 'up';
  if (raw === KEY.DOWN) return 'down';
  if (raw === KEY.LEFT) return 'left';
  if (raw === KEY.RIGHT) return 'right';
  if (raw.length === 1) return raw.toLowerCase();
  return raw;
}

export function clearScreen(): void {
  stdout.write(ansi.clearScreen);
}

export function hideCursor(): void {
  stdout.write(ansi.hideCursor);
}

export function showCursor(): void {
  stdout.write(ansi.showCursor);
}
