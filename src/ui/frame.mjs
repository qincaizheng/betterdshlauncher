// src/ui/frame.mjs — 零依赖全屏 TUI 渲染层：header / 左侧导航 / body 面板 / footer
// 仅使用 ANSI 转义序列；CJK 宽字符对齐、SGR 鼠标（点击 + 滚轮）、NO_COLOR、SIGWINCH 重绘。

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
 *   footerLeft, footerRight,
 * }
 * 返回 { text, layout }；layout 记录可点击区域的绝对终端坐标：
 *   { leftW, navY, navOffset, bodyItemY, bodyOffset }
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
  // 内容行布局：r0 空 / r1 标题 / r2 空 / 信息行… / 空 / 条目（窗口滚动）
  const info = o.bodyInfo || [];
  const items = o.bodyItems || [];
  const itemStart = 3 + info.length + 1;
  const itemAvail = Math.max(1, contentRows - itemStart);
  const bodyOffset = centerWindow(o.bodySel ?? 0, items.length, itemAvail);

  const body = ['', '  ' + c.bold(c.cyan(o.bodyTitle || '')), ''];
  for (const line of info) body.push('  ' + line);
  body.push('');
  for (let j = 0; j < itemAvail; j++) {
    const i = bodyOffset + j;
    if (i >= items.length) break;
    const item = items[i];
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
      // SGR 鼠标：\x1b[<btn;x;yM（按下）/ m（松开）
      if (s[i + 1] === '[' && s[i + 2] === '<') {
        const m = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(s.slice(i));
        if (m) {
          const btn = Number(m[1]);
          if (m[4] === 'M') {
            if ((btn & 64) !== 0) out.push({ name: (btn & 1) ? 'wheelDown' : 'wheelUp' });
            else if ((btn & 3) === 0) out.push({ name: 'mouse', x: Number(m[2]), y: Number(m[3]) });
          }
          i += m[0].length;
          continue;
        }
      }
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
    else if (ch === 'h') { out.push({ name: 'left' }); i += 1; }
    else if (ch === 'l') { out.push({ name: 'right' }); i += 1; }
    else if (ch >= '1' && ch <= '9') { out.push({ name: 'num', n: Number(ch) }); i += 1; }
    else { i += 1; }
  }
  return out;
}
