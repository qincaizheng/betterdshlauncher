// src/ui/frame.mjs — 零依赖全屏 TUI 渲染层：header / 左侧导航 / body 面板 / footer
// 仅使用 ANSI 转义序列；CJK 宽字符对齐、SGR 鼠标（点击 + 滚轮）、屏内文本输入、NO_COLOR、SIGWINCH 重绘。
import { StringDecoder } from 'node:string_decoder';

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
  red: wrap(31),
  gray: wrap(90),
};

/** 选中行：整行反色；无颜色环境下保持原样（靠 ▸ 前缀区分） */
export function highlight(s) {
  return noColor ? s : ESC + '7m' + s + ESC + '0m';
}

// ---- 宽度计算（CJK 全角按 2 列） ------------------------------------------

const ANSI_RE = /\x1b\[[0-9;]*m/g;
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

/** 让 sel 保持在高度 avail 的窗口中部，返回窗口起始偏移 */
function centerWindow(sel, len, avail) {
  if (len <= avail) return 0;
  return clamp(sel - Math.floor(avail / 2), 0, len - avail);
}

// ---- 整帧渲染 --------------------------------------------------------------

/**
 * 渲染一帧完整屏幕。
 * opts: {
 *   cols, rows,
 *   headerLeft, headerRight,
 *   navCaption, menu: [{ label }], selected, navFocused,
 *   bodyTitle, bodyInfo: [string],
 *   bodyItems: [{ label, hint? }], bodySel, bodyFocused,
 *   bodyInput,                          // 屏内输入：{ kind:'text'|'confirm', label, hint?, cps?, cursor?, initial? }（激活时隐藏条目）
 *   bodyBack,                           // 子面板：渲染可点击的「‹ 返回」行
 *   footerLeft, footerRight,
 * }
 * 返回 { text, layout }；layout 记录可点击区域的绝对终端坐标：
 *   { leftW, navY, navOffset, bodyItemY, bodyOffset, backY }
 */
export function renderFrame(o) {
  const cols = o.cols;
  const rows = o.rows;

  const bar = (left, right) => {
    const l = truncate(' ' + (left || ''), cols);
    const lw = stringWidth(l);
    const r = right ? truncate(right + ' ', Math.max(0, cols - lw - 1)) : '';
    const gap = Math.max(0, cols - lw - stringWidth(r));
    return c.inverse(l + ' '.repeat(gap) + r);
  };

  // 左栏宽度：最宽菜单项 + 留白，夹在 [16, 28] 且不超过半屏
  const maxMenu = Math.max(...o.menu.map((m) => stringWidth(m.label)), 4);
  const leftW = clamp(maxMenu + 6, 16, Math.min(28, Math.floor(cols / 2) - 2));
  const bodyW = Math.max(8, cols - leftW - 1); // 1 列给竖线分隔符

  const contentRows = Math.max(1, rows - 2);

  // ---- 左栏（导航） ----
  // 内容行布局：r0 空 / r1 标题 / r2 空 / r3.. 菜单项（窗口滚动）
  const navAvail = Math.max(1, contentRows - 3);
  const navOffset = centerWindow(o.selected, o.menu.length, navAvail);
  const left = ['', c.gray('  ' + (o.navCaption || '导航')), ''];
  for (let j = 0; j < navAvail; j++) {
    const i = navOffset + j;
    if (i >= o.menu.length) break;
    const item = o.menu[i];
    if (i === o.selected) {
      const plain = padEnd(truncate(' ▸ ' + item.label, leftW - 1), leftW - 1) + ' ';
      left.push(o.navFocused ? highlight(plain) : c.cyan(plain));
    } else {
      left.push('   ' + c.dim(truncate(item.label, leftW - 4)));
    }
  }
  while (left.length < contentRows) left.push('');

  // ---- 右栏（body 面板） ----
  // 内容行布局：r0 空 / r1 标题 / r2 空 / [返回行] / 信息行… / 空 / 条目（窗口滚动）
  const info = o.bodyInfo || [];
  const bi = o.bodyInput || null;
  const items = bi ? [] : (o.bodyItems || []); // 输入激活时隐藏条目
  const backRows = o.bodyBack ? 1 : 0;
  const inputRows = bi ? 2 + (bi.hint ? 1 : 0) : 0;
  const itemStart = 3 + backRows + inputRows + info.length + 1;
  const itemAvail = Math.max(1, contentRows - itemStart);
  const bodyOffset = centerWindow(o.bodySel ?? 0, items.length, itemAvail);

  const body = ['', '  ' + c.bold(c.cyan((o.bodyBack ? '‹ ' : '') + (o.bodyTitle || ''))), ''];
  if (o.bodyBack) body.push('  ' + c.cyan('‹ 返回') + c.gray('（Esc / ← / 右键）'));
  if (bi) {
    let disp;
    if (bi.kind === 'confirm') {
      disp = c.yellow('? ') + bi.label + ' ' + c.bold(bi.initial ? '(Y/n)' : '(y/N)');
    } else {
      const cps = bi.cps || [];
      const before = cps.slice(0, bi.cursor).join('');
      const at = cps[bi.cursor] || ' ';
      const after = cps.slice(bi.cursor + 1).join('');
      disp = c.yellow('? ') + bi.label + ' ' + before + highlight(at) + after;
    }
    body.push('  ' + disp);
    if (bi.hint) body.push('    ' + c.gray(bi.hint));
    body.push('');
  }
  for (const line of info) body.push('  ' + line);
  body.push('');
  for (let j = 0; j < itemAvail; j++) {
    const i = bodyOffset + j;
    if (i >= items.length) break;
    const item = items[i];
    if (item.section) { // 分节标题：不可选中的灰色小标题
      body.push('  ' + c.gray('─ ' + item.label + ' ' + '─'.repeat(Math.max(0, bodyW - stringWidth(item.label) - 8))));
      continue;
    }
    const label = (i === o.bodySel ? ' ▸ ' : '   ') + item.label;
    const hint = item.hint ? String(item.hint) : '';
    const lw = stringWidth(label);
    const hw = stringWidth(hint);
    if (i === o.bodySel) {
      let plain = hint && lw + hw + 2 <= bodyW ? label + ' '.repeat(bodyW - lw - hw) + hint : label;
      plain = padEnd(truncate(plain, bodyW), bodyW);
      body.push(o.bodyFocused ? highlight(plain) : c.cyan(plain));
    } else if (hint && lw + hw + 2 <= bodyW) {
      body.push(padEnd(truncate(label, bodyW - hw - 1), bodyW - hw) + c.gray(hint));
    } else {
      body.push(truncate(label, bodyW));
    }
  }
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

  return {
    text: lines.join('\n'),
    layout: {
      leftW,
      navY: 2 + 3,          // 第一个导航项的绝对行（1 起）
      navOffset,
      bodyItemY: 2 + itemStart, // 第一个条目的绝对行（1 起）
      bodyOffset,
      backY: o.bodyBack ? 2 + 3 : 0,  // 「‹ 返回」行的绝对行（0 = 无）
    },
  };
}

// ---- 全屏会话（备用屏幕 + 原始按键 + SGR 鼠标） ------------------------------

/**
 * Screen 管理备用屏幕缓冲区与原始输入。
 * key() 返回：
 *   { name: 'up'|'down'|'left'|'right'|'enter'|'esc'|'quit'|'ctrl-c'|'num', n? }
 *   { name: 'mouse', x, y }        左键按下（1 起坐标）
 *   { name: 'wheelUp'|'wheelDown' }
 */
export class Screen {
  constructor(stdout = process.stdout, stdin = process.stdin) {
    this.stdout = stdout;
    this.stdin = stdin;
    this.onResize = null;
    this.inputMode = false; // true 时普通字符解析为文本输入（q/j/k/数字等不再是快捷键）
    this._waiters = [];
    this._raw = ''; // 未消费的原始输入（解析按提取时的 inputMode 逐个进行）
    this._entered = false;
    this._decoder = new StringDecoder('utf8'); // 防止多字节字符被 data 分片切断
    this._onData = (buf) => this._handle(buf);
    this._onSigwinch = () => { if (this.onResize) this.onResize(); };
  }

  get cols() { return this.stdout.columns || 80; }
  get rows() { return this.stdout.rows || 24; }

  enter() {
    if (this._entered) return;
    this._entered = true;
    // 备用屏幕 + 隐藏光标 + SGR 鼠标（1000 点击/滚轮 + 1006 SGR 坐标格式）
    this.stdout.write(ESC + '?1049h' + ESC + '?25l' + ESC + '?1000h' + ESC + '?1006h');
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
    this.stdout.write(ESC + '?1006l' + ESC + '?1000l' + ESC + '?25h' + ESC + '?1049l');
  }

  /** 整帧重绘（光标归位 + 清空残影） */
  render(frame) {
    this.stdout.write(ESC + 'H' + frame + ESC + '0J');
  }

  key() {
    for (;;) {
      const one = parseOne(this._raw, this.inputMode);
      if (!one) break;
      this._raw = this._raw.slice(one.consumed);
      if (one.key) return Promise.resolve(one.key); // null key（鼠标松开/未识别）继续提取
    }
    return new Promise((resolve) => this._waiters.push(resolve));
  }

  _handle(buf) {
    this._raw += this._decoder.write(buf);
    this._drain();
  }

  _drain() {
    // 逐个提取按键：inputMode 在每次提取时读取，输入模态切换不影响同一数据块内后续的键
    for (;;) {
      if (!this._waiters.length || !this._raw) break;
      const one = parseOne(this._raw, this.inputMode);
      if (!one) break; // 不完整的转义序列，等更多数据
      this._raw = this._raw.slice(one.consumed);
      if (one.key) this._waiters.shift()(one.key); // null key（鼠标松开/未识别）：消费后继续
    }
  }
}

/**
 * 从输入串头部提取一个按键/鼠标事件。input = true 为文本输入模式：
 * 方向键/Enter/Esc/退格/Ctrl-C 仍是命令，其余可打印字符（含 CJK、数字、q/j/k）解析为 { name:'text', text }。
 * 返回 { key, consumed }；输入为空或转义序列不完整时返回 null（等更多数据）。
 */
export function parseOne(s, input) {
  if (!s) return null;
  const ch = s[0];
  const key = (k, consumed) => ({ key: k, consumed });
  if (ch === '\x1b') {
    // SGR 鼠标：\x1b[<btn;x;yM（按下）/ m（松开）
    if (s[1] === '[' && s[2] === '<') {
      const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s);
      if (!m) return /^\x1b\[<[\d;]*$/.test(s) ? null : key({ name: 'esc' }, 1); // 不完整则等更多数据
      const btn = Number(m[1]);
      if (m[4] !== 'M') return key(null, m[0].length); // 松开事件：消费但不产生按键
      if ((btn & 64) !== 0) return key({ name: (btn & 1) ? 'wheelDown' : 'wheelUp' }, m[0].length);
      if ((btn & 3) === 0) return key({ name: 'mouse', x: Number(m[2]), y: Number(m[3]) }, m[0].length);
      if ((btn & 3) === 2) return key({ name: 'rmb' }, m[0].length); // 右键 = 返回
      return key(null, m[0].length);
    }
    if (s.length === 1) return key({ name: 'esc' }, 1); // 裸 Esc（不与方向键消歧，实践中方向键整块到达）
    if (s === '\x1b[') return null; // 可能是被分片的方向键
    const two = s.slice(0, 3);
    if (two === '\x1b[A') return key({ name: 'up' }, 3);
    if (two === '\x1b[B') return key({ name: 'down' }, 3);
    if (two === '\x1b[C') return key({ name: 'right' }, 3);
    if (two === '\x1b[D') return key({ name: 'left' }, 3);
    return key({ name: 'esc' }, 1);
  }
  if (ch === '\r' || ch === '\n') return key({ name: 'enter' }, 1);
  if (ch === '\x7f') return key({ name: 'back' }, 1); // 退格键 = 返回 / 删字
  if (ch === '\x03') return key({ name: 'ctrl-c' }, 1);
  if (input) {
    if (ch >= ' ' || ch > '\x7f') return key({ name: 'text', text: ch }, 1); // 可打印字符（含 CJK）
    return key(null, 1); // 其余控制字符：丢弃
  }
  if (ch === 'q' || ch === 'Q') return key({ name: 'quit' }, 1);
  if (ch === 'k') return key({ name: 'up' }, 1);
  if (ch === 'j') return key({ name: 'down' }, 1);
  if (ch === 'h') return key({ name: 'left' }, 1);
  if (ch === 'l') return key({ name: 'right' }, 1);
  if (ch >= '1' && ch <= '9') return key({ name: 'num', n: Number(ch) }, 1);
  return key(null, 1); // 未识别：丢弃
}

/** 批量解析（测试与调试用）；inputMode 固定为 opts.input */
export function parseKeys(s, opts) {
  const input = !!(opts && opts.input);
  const out = [];
  let rest = s;
  for (;;) {
    const one = parseOne(rest, input);
    if (!one) break;
    rest = rest.slice(one.consumed);
    if (one.key) out.push(one.key);
  }
  return out;
}
