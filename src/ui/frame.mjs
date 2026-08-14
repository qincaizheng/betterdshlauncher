// src/ui/frame.mjs — 零依赖全屏 TUI 渲染层：header / 左侧导航 / body / footer
// 仅使用 ANSI 转义序列；支持 CJK 宽字符对齐、NO_COLOR、终端缩放重绘。

const ESC = '\x1b[';

// ---- 颜色 ----------------------------------------------------------------

const noColor = !!process.env.NO_COLOR || process.env.TERM === 'dumb';

function wrap(code) {
  return (s) => (noColor ? String(s) : ESC + code + 'm' + s + ESC + '0m');
}

export const c = {
  bold: wrap(1),
  dim: wrap(2),
  inverse: wrap(7),
  cyan: wrap(36),
  green: wrap(32),
  yellow: wrap(33),
  magenta: wrap(35),
  gray: wrap(90),
  red: wrap(31),
};

/** 选中行：整行反色；无颜色环境下保持原样（靠 ▸ 前缀区分） */
export function highlight(s) {
  return noColor ? s : ESC + '7m' + s + ESC + '0m';
}

// ---- 宽度计算（CJK 全角按 2 列） ------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*m/g;
// 常见全角/宽字符区间（CJK、全角标点、Hangul、宽假名等）
const WIDE_RE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]/u;
const COMBINING_RE = /[\u0300-\u036F\uFE00-\uFE0F\u200D]/;

export function stripAnsi(s) {
  return String(s).replace(ANSI_RE, '');
}

export function stringWidth(s) {
  let w = 0;
  for (const ch of stripAnsi(s)) {
    if (COMBINING_RE.test(ch)) continue;
    w += WIDE_RE.test(ch) ? 2 : 1;
  }
  return w;
}

/** 按可见宽度补空格到 width（含 ANSI 的字符串按可见宽度计） */
export function padEnd(s, width) {
  const w = stringWidth(s);
  return w >= width ? s : s + ' '.repeat(width - w);
}

/** 按可见宽度截断（保留 ANSI 序列；截断后补 reset 防串色） */
export function truncate(s, width) {
  const str = String(s);
  let w = 0;
  let out = '';
  let opened = false;
  let i = 0;
  while (i < str.length) {
    const m = /\x1b\[[0-9;]*m/.exec(str.slice(i));
    if (m && m.index === 0) {
      out += m[0];
      opened = m[0] !== ESC + '0m';
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(str.codePointAt(i));
    const cw = COMBINING_RE.test(ch) ? 0 : WIDE_RE.test(ch) ? 2 : 1;
    if (w + cw > width) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return opened ? out + ESC + '0m' : out;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

// ---- 整帧渲染 --------------------------------------------------------------

/**
 * 渲染一帧完整屏幕。
 * opts: {
 *   cols, rows,
 *   headerLeft, headerRight,          // 顶栏左右文本
 *   menu: [{ label }], selected,      // 左侧导航
 *   navCaption,                       // 左栏标题（如「导航」）
 *   bodyTitle, bodyLines: [string],   // 右侧内容
 *   footerLeft, footerRight,          // 底栏左右文本
 * }
 * 返回字符串（rows 行，每行可见宽度恰好 cols）。
 */
export function renderFrame(o) {
  const cols = o.cols;
  const rows = o.rows;

  const bar = (left, right) => {
    const l = ' ' + (left || '');
    const r = right ? right + ' ' : '';
    const gap = Math.max(1, cols - stringWidth(l) - stringWidth(r));
    return c.inverse(padEnd(truncate(l, cols), stringWidth(l)) + ' '.repeat(gap) + truncate(r, Math.max(0, cols - stringWidth(l) - gap)));
  };

  // 左栏宽度：最宽菜单项 + 留白，夹在 [16, 28] 且不超过半屏
  const maxMenu = Math.max(...o.menu.map((m) => stringWidth(m.label)), 4);
  const leftW = clamp(maxMenu + 6, 16, Math.min(28, Math.floor(cols / 2) - 2));
  const bodyW = cols - leftW - 1; // 1 列给竖线分隔符

  const contentRows = Math.max(1, rows - 2);

  // 左栏
  const left = [''];
  left.push(c.gray('  ' + (o.navCaption || '导航')));
  left.push('');
  for (let i = 0; i < o.menu.length; i++) {
    const item = o.menu[i];
    if (i === o.selected) {
      left.push(highlight(padEnd(truncate(' ▸ ' + item.label, leftW - 1), leftW - 1) + ' '));
    } else {
      left.push('   ' + c.dim(truncate(item.label, leftW - 4)));
    }
  }
  while (left.length < contentRows) left.push('');

  // 右栏
  const body = [''];
  body.push('  ' + c.bold(c.cyan(o.bodyTitle || '')));
  body.push('');
  for (const line of o.bodyLines || []) body.push('  ' + line);
  while (body.length < contentRows) body.push('');

  const lines = [bar(o.headerLeft, o.headerRight)];
  for (let r = 0; r < contentRows; r++) {
    lines.push(
      padEnd(truncate(left[r] || '', leftW), leftW) +
      c.gray('│') +
      padEnd(truncate(body[r] || '', bodyW), bodyW)
    );
  }
  lines.push(bar(o.footerLeft, o.footerRight));
  return lines.join('\n');
}

// ---- 全屏会话（备用屏幕 + 原始按键） ----------------------------------------

/**
 * Screen 管理备用屏幕缓冲区与原始键盘输入。
 * key() 返回 { name: 'up'|'down'|'left'|'right'|'enter'|'esc'|'quit'|'ctrl-c'|'num', n? }
 */
export class Screen {
  constructor(stdout = process.stdout, stdin = process.stdin) {
    this.stdout = stdout;
    this.stdin = stdin;
    this.onResize = null;
    this._waiters = [];
    this._queue = [];
    this._entered = false;
    this._onData = (buf) => this._handle(buf);
    this._onSigwinch = () => { if (this.onResize) this.onResize(); };
  }

  get cols() { return this.stdout.columns || 80; }
  get rows() { return this.stdout.rows || 24; }

  enter() {
    if (this._entered) return;
    this._entered = true;
    this.stdout.write(ESC + '?1049h' + ESC + '?25l'); // 备用屏幕 + 隐藏光标
    if (this.stdin.isTTY) this.stdin.setRawMode(true);
    this.stdin.on('data', this._onData);
    this.stdin.resume();
    process.on('SIGWINCH', this._onSigwinch);
  }

  exit() {
    if (!this._entered) return;
    this._entered = false;
    this.stdin.off('data', this._onData);
    process.off('SIGWINCH', this._onSigwinch);
    if (this.stdin.isTTY) this.stdin.setRawMode(false);
    this.stdin.pause();
    this.stdout.write(ESC + '?25h' + ESC + '?1049l'); // 恢复光标 + 主屏幕
  }

  /** 整帧重绘（光标归位 + 清空残影） */
  render(frame) {
    this.stdout.write(ESC + 'H' + frame + ESC + '0J');
  }

  key() {
    const k = this._queue.shift();
    if (k) return Promise.resolve(k);
    return new Promise((resolve) => this._waiters.push(resolve));
  }

  _handle(buf) {
    const keys = parseKeys(buf.toString('utf8'));
    for (const k of keys) {
      const w = this._waiters.shift();
      if (w) w(k);
      else this._queue.push(k); // 没有等待者时排队，避免连发按键丢失
    }
  }
}

export function parseKeys(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\x1b') {
      const two = s.slice(i, i + 3);
      if (two === '\x1b[A') { out.push({ name: 'up' }); i += 3; }
      else if (two === '\x1b[B') { out.push({ name: 'down' }); i += 3; }
      else if (two === '\x1b[C') { out.push({ name: 'right' }); i += 3; }
      else if (two === '\x1b[D') { out.push({ name: 'left' }); i += 3; }
      else { out.push({ name: 'esc' }); i += 1; }
    } else if (ch === '\r' || ch === '\n') { out.push({ name: 'enter' }); i += 1; }
    else if (ch === '\x03') { out.push({ name: 'ctrl-c' }); i += 1; }
    else if (ch === 'q' || ch === 'Q') { out.push({ name: 'quit' }); i += 1; }
    else if (ch === 'k') { out.push({ name: 'up' }); i += 1; }
    else if (ch === 'j') { out.push({ name: 'down' }); i += 1; }
    else if (ch >= '1' && ch <= '9') { out.push({ name: 'num', n: Number(ch) }); i += 1; }
    else { i += 1; }
  }
  return out;
}
