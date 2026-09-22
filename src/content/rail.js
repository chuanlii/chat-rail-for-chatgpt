/**
 * Rail —— 纯视图层：Shadow DOM 里的轨道 + 横线 + 悬停浮层 + 跳转高亮。
 * 不碰 ChatGPT 的 DOM 结构，只按控制器算好的坐标画东西。
 */
(() => {
  const NS = (globalThis.__ChatRail = globalThis.__ChatRail || {});

  const RAIL_WIDTH = 22; // 与 CSS 里 .rail 的宽度保持一致
  const TIP_GAP = 12; // 浮层与轨道之间的间距
  const CLICK_SUPPRESS_MS = 700; // 点击跳转后短暂不弹浮层

  const CSS = `
:host { all: initial; }
*, *::before, *::after { box-sizing: border-box; }

.layer {
  position: fixed; inset: 0; pointer-events: none; z-index: 2147483600;
  font-family: ui-sans-serif, -apple-system, "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;

  --bar: rgba(13, 13, 13, .28);
  --bar-hover: rgba(13, 13, 13, .72);
  --bar-active: rgba(13, 13, 13, .95);
  --tip-bg: #ffffff;
  --tip-fg: #0d0d0d;
  --tip-dim: #8d8d8d;
  --tip-border: rgba(0, 0, 0, .08);
  --tip-shadow: 0 6px 24px rgba(0, 0, 0, .16);
  --flash: rgba(13, 13, 13, .07);
  --bar-end: #f59e0b;
}
:host([data-theme="dark"]) .layer {
  --bar: rgba(255, 255, 255, .32);
  --bar-hover: rgba(255, 255, 255, .74);
  --bar-active: rgba(255, 255, 255, .94);
  --tip-bg: #2f2f2f;
  --tip-fg: #ececec;
  --tip-dim: #9b9b9b;
  --tip-border: rgba(255, 255, 255, .07);
  --tip-shadow: 0 8px 28px rgba(0, 0, 0, .5);
  --flash: rgba(255, 255, 255, .09);
  --bar-end: #f59e0b;
}

.rail { position: fixed; width: ${RAIL_WIDTH}px; }
.rail[hidden] { display: none; }

.mark {
  position: absolute; top: 0; right: 0; width: ${RAIL_WIDTH}px; height: 22px; margin-top: -11px;
  display: flex; align-items: center; justify-content: flex-end;
  padding: 0; border: 0; background: none; -webkit-appearance: none; appearance: none;
  pointer-events: auto; cursor: pointer;
}
.rail[data-side="right"] .mark { right: auto; left: 0; justify-content: flex-start; }

.bar {
  display: block; width: 10px; height: 2px; border-radius: 2px; background: var(--bar);
  transition: width 120ms ease, background-color 120ms ease, opacity 120ms ease;
}
.mark:hover .bar, .mark:focus-visible .bar { width: 15px; background: var(--bar-hover); }
.mark[data-active="1"] .bar { width: 18px; background: var(--bar-active); }
.mark:focus { outline: none; }
.mark:focus-visible .bar { box-shadow: 0 0 0 2px var(--bar-hover); }

/* 底部「跳到对话末尾」的橙色横线 */
.mark[data-kind="end"] .bar { width: 16px; background: var(--bar-end); opacity: .85; }
.mark[data-kind="end"]:hover .bar, .mark[data-kind="end"]:focus-visible .bar { width: 20px; background: var(--bar-end); opacity: 1; }

.tip {
  position: fixed; top: 0; left: 0; width: 300px; max-width: calc(100vw - 32px);
  padding: 9px 12px 10px;
  border-radius: 14px; background: var(--tip-bg); color: var(--tip-fg);
  border: 1px solid var(--tip-border); box-shadow: var(--tip-shadow);
  font-size: 13px; line-height: 1.45; opacity: 0; pointer-events: none;
  transition: opacity 90ms ease;
}
.tip[data-show="1"] { opacity: 1; }
.tip-idx { font-size: 11px; color: var(--tip-dim); margin-bottom: 3px; font-variant-numeric: tabular-nums; }
.tip-text {
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical;
  overflow: hidden; white-space: pre-wrap; word-break: break-word;
}

.flash { position: fixed; border-radius: 14px; background: var(--flash); pointer-events: none; }
.flash[data-run="1"] { animation: pr-flash 900ms ease-out forwards; }
@keyframes pr-flash { from { opacity: 1; } to { opacity: 0; } }

@media (prefers-reduced-motion: reduce) {
  .bar, .tip { transition: none; }
  .flash[data-run="1"] { animation-duration: 1ms; }
}
`;

  class Rail {
    constructor({ onJump } = {}) {
      this.onJump = onJump || (() => {});
      this.meta = new Map(); // key -> { index, count, text }
      this.markers = new Map(); // key -> button element
      this.activeKey = null;
      this.tipSide = 'auto';
      this.tipFor = null; // 当前浮层对应的 key
      this.tipRect = null; // 当前浮层对应的横线位置（横线不动，缓存即可）
    }

    mount() {
      const host = document.createElement('div');
      host.id = 'chatrail-root';
      // host 自身必须是定位元素，否则 Shadow DOM 里再高的 z-index 也压不住 ChatGPT 正文
      host.style.cssText =
        'all: initial; position: fixed; inset: 0; z-index: 2147483600; pointer-events: none; display: block;';
      const root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CSS;

      const layer = document.createElement('div');
      layer.className = 'layer';

      const rail = document.createElement('div');
      rail.className = 'rail';
      rail.hidden = true;

      const tip = document.createElement('div');
      tip.className = 'tip';
      tip.setAttribute('role', 'tooltip');
      const tipIdx = document.createElement('div');
      tipIdx.className = 'tip-idx';
      const tipText = document.createElement('div');
      tipText.className = 'tip-text';
      tip.append(tipIdx, tipText);

      layer.append(rail, tip);
      root.append(style, layer);
      (document.documentElement || document.body).appendChild(host);

      this.host = host;
      this.layer = layer;
      this.rail = rail;
      this.tip = tip;
      this.tipIdx = tipIdx;
      this.tipText = tipText;

      rail.addEventListener('mouseover', (e) => {
        const m = e.target.closest && e.target.closest('.mark');
        if (!m) return;
        clearTimeout(this.hideTimer);
        this.showTip(m);
      });
      rail.addEventListener('mouseout', (e) => {
        const to = e.relatedTarget;
        if (to && to.closest && to.closest('.mark')) return; // 仍在同一条横线内
        // 布局抖动会让浏览器在指针没动时补发 mouseout/mouseover；延迟确认后再收
        clearTimeout(this.hideTimer);
        this.hideTimer = setTimeout(() => {
          if (!this.rail.querySelector('.mark:hover')) this.hideTip();
        }, 140);
      });
      rail.addEventListener('click', (e) => {
        const m = e.target.closest && e.target.closest('.mark');
        if (!m) return;
        this.hideTip();
        // 点击后指针仍停在横线上，浏览器会因命中元素变化重发 mouseover；压掉这次回弹
        this.tipSuppressUntil = performance.now() + CLICK_SUPPRESS_MS;
        this.onJump(m.dataset.key);
      });
      rail.addEventListener('focusin', (e) => {
        // 鼠标点击也会聚焦按钮；只有键盘聚焦才弹浮层
        const m = e.target.closest && e.target.closest('.mark');
        if (m && m.matches(':focus-visible')) this.showTip(m);
      });
      rail.addEventListener('focusout', () => this.hideTip());
      window.addEventListener('resize', () => this.hideTip(), { passive: true });
      return this;
    }

    setTheme(theme) {
      if (this.host) this.host.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
    }

    /** layout: { x, top, height, side, markers: [{key, index, count, text, y, active}] } */
    applyLayout(layout) {
      if (!this.rail) return;
      this.rail.hidden = false;
      this.rail.dataset.side = layout.side;
      this.rail.style.left = `${layout.x}px`;
      this.rail.style.top = `${layout.top}px`;
      this.rail.style.height = `${layout.height}px`;

      const alive = new Set();
      let activeKey = null;
      const hit = layout.hit || 22;
      const hitStyle = `${hit}px`;
      const hitMargin = `${-hit / 2}px`;
      for (const m of layout.markers) {
        alive.add(m.key);
        let el = this.markers.get(m.key);
        if (!el) {
          el = document.createElement('button');
          el.type = 'button';
          el.className = 'mark';
          el.dataset.key = m.key;
          el.tabIndex = 0;
          const bar = document.createElement('span');
          bar.className = 'bar';
          el.appendChild(bar);
          this.rail.appendChild(el);
          this.markers.set(m.key, el);
        }
        el.style.top = `${m.y}px`;
        if (el.style.height !== hitStyle) {
          el.style.height = hitStyle;
          el.style.marginTop = hitMargin;
        }
        el.dataset.kind = m.kind || 'turn';
        el.setAttribute('aria-label', m.index === null ? m.text : `${m.index} / ${m.count}`);
        this.meta.set(m.key, { index: m.index, count: m.count, text: m.text });
        if (m.active) activeKey = m.key;
      }

      for (const [key, el] of this.markers) {
        if (alive.has(key)) continue;
        el.remove();
        this.markers.delete(key);
        this.meta.delete(key);
      }

      this.setActive(activeKey);
      if (this.tipFor && !alive.has(this.tipFor)) this.hideTip();
    }

    setActive(key) {
      if (key === this.activeKey) return;
      this.activeKey = key;
      for (const [k, el] of this.markers) {
        const on = k === key;
        if (el.dataset.active === String(on ? 1 : 0)) continue;
        el.dataset.active = on ? '1' : '0';
      }
    }

    showTip(markerEl) {
      if (performance.now() < (this.tipSuppressUntil || 0)) return;
      const key = markerEl.dataset.key;
      const meta = this.meta.get(key);
      if (!meta) return;
      this.tipFor = key;
      this.tipIdx.hidden = meta.index === null; // 末尾横线没有序号
      if (meta.index !== null) this.tipIdx.textContent = `${meta.index} / ${meta.count}`;
      this.tipText.textContent = meta.text || '（无文本内容）';
      this.tipRect = markerEl.getBoundingClientRect();
      this.tip.dataset.show = '1';
      this.placeTip();
    }

    placeTip() {
      if (!this.tipFor || !this.tipRect) return;
      const w = this.tip.offsetWidth;
      const h = this.tip.offsetHeight;
      const railRect = this.rail.getBoundingClientRect();

      // 指定了方向就一直用那个方向；auto 才按剩余空间翻转
      let side = this.tipSide;
      if (side !== 'left' && side !== 'right') side = railRect.left - TIP_GAP - w >= 8 ? 'left' : 'right';

      let x = side === 'left' ? railRect.left - TIP_GAP - w : railRect.right + TIP_GAP;
      x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
      let y = this.tipRect.top + this.tipRect.height / 2 - h / 2;
      y = Math.max(8, Math.min(y, window.innerHeight - h - 8));

      this.tip.style.left = `${Math.round(x)}px`;
      this.tip.style.top = `${Math.round(y)}px`;
    }

    hideTip() {
      if (!this.tip) return;
      this.tipFor = null;
      this.tip.dataset.show = '0';
    }

    /** 跳转后给目标提问一个短促的高亮，确认「跳到了这里」 */
    flash(rect) {
      if (!this.layer || !rect) return;
      const old = this.layer.querySelector('.flash');
      if (old) old.remove();
      const el = document.createElement('div');
      el.className = 'flash';
      el.style.cssText = `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;`;
      this.layer.appendChild(el);
      void el.offsetWidth;
      el.dataset.run = '1';
      setTimeout(() => el.remove(), 1000);
    }

    hide() {
      if (!this.rail) return;
      this.rail.hidden = true;
      this.hideTip();
    }
  }

  NS.Rail = Rail;
  NS.RAIL_WIDTH = RAIL_WIDTH;
})();
