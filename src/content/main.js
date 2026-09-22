/**
 * 控制器：把 ChatGPTAdapter（读 DOM）和 Rail（画 UI）接起来。
 *   测量：滚动容器几何 + 每次提问的相对坐标 → 轨道坐标
 *   跟随：滚动时只更新“当前轮次”，不重排
 *   跳转：与滚动方向无关的定位（兼容 ChatGPT 的 flex-col-reverse 滚动容器）
 */
(() => {
  const NS = globalThis.__ChatRail;
  const { adapter } = NS;

  const DEFAULTS = { enabled: true, side: 'auto', offset: 8, tipSide: 'left', debug: false };
  const MIN_TURNS = 1; // 一次问答也值得导航（可以直接跳到最开始）
  const RAIL_W = NS.RAIL_WIDTH;
  const RAIL_PAD = 16; // 轨道上下留白
  const END_KEY = '__end__'; // 底部「跳到末尾」横线的标记 key
  const END_LABEL = '跳到对话末尾';
  const END_RESERVE = 26; // 给这条橙色横线预留的高度
  const MEASURE_MS = 180;
  const WATCHDOG_MS = 1000;
  const MARK_PITCH = 24; // 相邻提问的固定行距
  const MARK_HIT = 22; // 横线的悬停命中高度（轮次多时会自动缩小到行距）
  const FALLBACK_INSET = 24; // 读不到 --thread-content-top-inset 时的兜底
  const SETTLE_MS = 140; // 无滚动事件这么久 = 滚动停了
  const SETTLE_TIMEOUT_MS = 700; // 平滑滚动期间没有事件时的兜底
  const MAX_SETTLE_TRIES = 3; // 落点校准最多几轮
  const SMOOTH_MAX_SCREENS = 6; // 超过这么多屏就直接跳，不做平滑滚动
  const USER_SCROLL_EVENTS = ['wheel', 'touchstart', 'pointerdown'];

  const log = (...a) => NS.debug && console.log('[ChatRail]', ...a);

  let opts = { ...DEFAULTS };
  let rail = null;
  let scroller = null;
  let baseEl = null; // 第一条提问的元素，用于探测内容是否发生位移
  let measured = []; // [{ key, text, index, top, promptEl }]，已按视觉顺序
  let baseTopAtMeasure = 0; // baseEl 上次测量时的视口坐标，用来探测位置漂移
  let readingLine = FALLBACK_INSET;
  let jumpInset = FALLBACK_INSET;
  let padBottom = 0; // ChatGPT 在滚动容器底部留出的 composer 空间
  let activeKey = null;
  let measureTimer = null;
  let lastMeasureAt = 0;
  let watchdogTimer = null;
  let settleTimer = null;
  let pendingJump = null; // { seq, el, sc, k, offset }
  let jumpSeq = 0;
  let lastHref = location.href;
  let theme = null;
  let boundScrollTarget = null;
  let roTarget = null;
  let lastSig = '';
  let ro = null;
  const factorCache = new WeakMap();

  // ---------------------------------------------------------------- 选项
  function loadOptions() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(DEFAULTS, (v) => resolve({ ...DEFAULTS, ...v }));
      } catch {
        resolve({ ...DEFAULTS });
      }
    });
  }

  function watchOptions() {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'sync') return;
        for (const [k, { newValue }] of Object.entries(changes)) {
          if (k in DEFAULTS) opts[k] = newValue;
        }
        NS.debug = !!opts.debug; // 排查 ChatGPT 改版用：chrome.storage.sync.set({debug:true})
        log('options', opts);
        scheduleMeasure(true);
      });
    } catch {
      /* 无扩展环境（本地调试）时忽略 */
    }
  }

  // ---------------------------------------------------------------- 主题
  function currentTheme() {
    const de = document.documentElement;
    const t = de.getAttribute('data-theme');
    if (t === 'dark' || t === 'light') return t;
    return de.classList.contains('dark') ? 'dark' : 'light';
  }

  function syncTheme() {
    const t = currentTheme();
    if (t === theme) return;
    theme = t;
    rail && rail.setTheme(t);
  }

  // ---------------------------------------------------------------- 测量
  function readInsets(sc) {
    const cs = getComputedStyle(sc);
    // 顶部内边距可能是 calc() 表达式，读解析后的 padding-top 而不是原始变量值
    const padTop = parseFloat(cs.paddingTop);
    const varTop = parseFloat(cs.getPropertyValue('--thread-content-top-inset'));
    const bottom = parseFloat(cs.getPropertyValue('--thread-scroll-padding-bottom'));
    const topInset = [padTop, varTop, FALLBACK_INSET].find((v) => Number.isFinite(v) && v > 0) ?? FALLBACK_INSET;
    const bottomInset = Number.isFinite(bottom) ? bottom : 0;
    padBottom = bottomInset;
    const anchor = Math.min(Math.max(topInset, 8), 160) + 8; // 留 8px 让提问不被顶部粘性栏压住
    readingLine = anchor; // 「正在读这一轮」的判定线
    jumpInset = anchor; // 跳转落点与判定线一致，跳过去就是当前轮
  }

  function clearViews() {
    measured = [];
    baseEl = null;
    activeKey = null;
    rail && rail.hide();
  }

  function measure() {
    lastMeasureAt = performance.now();
    if (!rail) return;
    syncTheme();
    if (!opts.enabled) return clearViews();

    const sc = adapter.getScrollContainer();
    if (!sc) return clearViews();
    if (sc !== scroller) {
      scroller = sc;
      bindScroll();
    }

    const turns = adapter.getTurns(sc);
    if (turns.length < MIN_TURNS) return clearViews();

    const sRect = sc.getBoundingClientRect();
    const raw = turns.map((t) => {
      const r = t.promptEl.getBoundingClientRect();
      return { key: t.key, text: t.text, top: r.top, promptEl: t.promptEl, turnEl: t.turnEl };
    });
    raw.sort((a, b) => a.top - b.top);
    raw.forEach((r, i) => {
      r.index = i + 1;
    });

    measured = raw;
    baseEl = raw[0].promptEl;
    baseTopAtMeasure = raw[0].top;

    readInsets(sc);
    const top = sRect.top + RAIL_PAD;
    const bottom = sRect.bottom - Math.max(RAIL_PAD, padBottom);
    const height = bottom - top;
    if (height < 80) {
      rail.hide();
      return;
    }

    const col = adapter.getColumnEdges(sc, turns);
    let side = opts.side;
    if (side !== 'left' && side !== 'right') {
      side = col.left - opts.offset - RAIL_W >= sRect.left + 4 ? 'left' : 'right';
    }
    const x = side === 'left' ? col.left - opts.offset - RAIL_W : col.right + opts.offset;

    // 提问按固定行距紧凑排列、整组居中；底部留一格给「跳到末尾」的橙色横线
    const count = raw.length;
    const pad = 4;
    const usable = Math.max(20, height - pad * 2 - END_RESERVE);
    // 轮次多到放不下时行距自动变小，保证整列永远在轨道内
    const pitch = Math.min(MARK_PITCH, usable / Math.max(1, count - 1));
    const stackH = pitch * (count - 1);
    const y0 = (usable - stackH) / 2;
    const ys = raw.map((_, i) => Math.round(pad + y0 + i * pitch));

    rail.tipSide = opts.tipSide;
    rail.applyLayout({
      side,
      x: Math.round(x),
      top: Math.round(top),
      height: Math.round(height),
      hit: Math.max(6, Math.min(MARK_HIT, Math.floor(pitch))),
      markers: [
        ...raw.map((r, i) => ({
          key: r.key,
          index: r.index,
          count,
          text: r.text,
          y: ys[i],
          active: false,
        })),
        { key: END_KEY, kind: 'end', index: null, count, text: END_LABEL, y: Math.round(height - pad) },
      ],
    });
    updateActive(true);
    log('layout', { count, side, x, top, height, pitch, stackH });
  }

  function scheduleMeasure(now) {
    if (now) {
      clearTimeout(measureTimer);
      measureTimer = null;
      measure();
      return;
    }
    if (measureTimer) return;
    const wait = Math.max(0, MEASURE_MS - (performance.now() - lastMeasureAt));
    measureTimer = setTimeout(() => {
      measureTimer = null;
      measure();
    }, wait);
  }

  // ---------------------------------------------------------------- 跟随滚动
  /** 当前轮次用「实时 rect 二分」判定：内容懒加载会让缓存坐标过期，实测才可靠 */
  function updateActive(force) {
    if (!rail || !measured.length || !scroller) return;
    const sRect = scroller.getBoundingClientRect();
    const line = readingLine + 1;
    const rel = (i) => {
      const el = measured[i].promptEl;
      if (!el || !el.isConnected) return null;
      return el.getBoundingClientRect().top - sRect.top;
    };
    const first = rel(0);
    if (first === null) return scheduleMeasure();
    let idx = 0;
    if (first <= line) {
      let lo = 0;
      let hi = measured.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        const r = rel(mid);
        if (r === null) return scheduleMeasure();
        if (r <= line) lo = mid;
        else hi = mid - 1;
      }
      idx = lo;
    }
    const key = measured[idx].key;
    if (key === activeKey && !force) return;
    activeKey = key;
    rail.setActive(key);
  }

  function throttleRaf(fn) {
    let pending = false;
    return () => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        fn();
      });
    };
  }

  // 滚动回调：合并到一帧内，避免流式输出时每个 scroll 事件都读一次布局
  const updateActiveThrottled = throttleRaf(() => updateActive());

  function onScroll() {
    updateActiveThrottled();
    if (pendingJump) armSettle(SETTLE_MS);
  }

  function bindScroll() {
    const target = scroller || window;
    if (boundScrollTarget === target) return;
    if (boundScrollTarget) {
      boundScrollTarget.removeEventListener('scroll', onScroll);
      for (const ev of USER_SCROLL_EVENTS) boundScrollTarget.removeEventListener(ev, cancelJump, true);
    }
    target.addEventListener('scroll', onScroll, { passive: true });
    // 用户自己动手滚了就不要再抢方向盘
    for (const ev of USER_SCROLL_EVENTS) target.addEventListener(ev, cancelJump, { capture: true, passive: true });
    boundScrollTarget = target;
  }

  // ---------------------------------------------------------------- 跳转
  /** 每单位 scrollTop 变化对应的内容位移（兼容 column-reverse 的负 scrollTop） */
  function scrollFactor(sc) {
    const cached = factorCache.get(sc);
    if (cached) return cached;
    const probe = (measured[0] && measured[0].promptEl) || sc.firstElementChild;
    if (!probe || sc.scrollHeight - sc.clientHeight < 20) return -1;
    const before = sc.scrollTop;
    const y0 = probe.getBoundingClientRect().top;
    sc.scrollTop = before + 4;
    const moved = sc.scrollTop - before; // 到边界会被 clamp，用实际位移算系数
    const y1 = probe.getBoundingClientRect().top;
    sc.scrollTop = before;
    const k = Math.abs(moved) > 0.5 ? (y1 - y0) / moved : -1;
    const safe = Math.abs(k) > 0.1 ? k : -1;
    factorCache.set(sc, safe);
    return safe;
  }

  function resolvePrompt(key) {
    const known = measured.find((m) => m.key === key);
    if (known && known.promptEl && known.promptEl.isConnected) return known.promptEl;
    let turnEl = null;
    try {
      turnEl = document.querySelector(`[data-turn-key="${CSS.escape(key)}"]`);
    } catch {
      turnEl = null;
    }
    return turnEl ? adapter.findPrompt(turnEl) : null;
  }

  function jump(key) {
    const sc = scroller || adapter.getScrollContainer();
    if (!sc) return;
    if (key === END_KEY) return jumpToEnd(sc);
    const el = resolvePrompt(key);
    if (!el) return log('jump target missing', key);
    scroller = sc;
    bindScroll();
    cancelJump();

    const k = scrollFactor(sc);
    const offset = () => el.getBoundingClientRect().top - (sc.getBoundingClientRect().top + jumpInset);
    const delta = offset();
    pendingJump = { seq: ++jumpSeq, el, sc, k, offset, tries: 0, flash: true };
    // 近处平滑滚动；跨几千像素的“平滑”只会变成几秒的模糊滚动，直接跳更舒服
    const smooth = Math.abs(delta) <= SMOOTH_MAX_SCREENS * (sc.clientHeight || window.innerHeight);
    sc.scrollTo({ top: sc.scrollTop - delta / k, behavior: smooth ? 'smooth' : 'auto' });
    armSettle(smooth ? SETTLE_TIMEOUT_MS : SETTLE_MS);
    scheduleMeasure();
  }

  /** 跳到「最后一条回答的结尾」：把最后一轮的底部对齐到 composer 上方 */
  function jumpToEnd(sc) {
    const last = measured.length ? measured[measured.length - 1] : null;
    const el = last && last.turnEl && last.turnEl.isConnected ? last.turnEl : sc.lastElementChild;
    if (!el) return;
    scroller = sc;
    bindScroll();
    cancelJump();

    const k = scrollFactor(sc);
    const offset = () => el.getBoundingClientRect().bottom - (sc.getBoundingClientRect().bottom - padBottom);
    const delta = offset();
    pendingJump = { seq: ++jumpSeq, el, sc, k, offset, tries: 0, flash: false };
    const smooth = Math.abs(delta) <= SMOOTH_MAX_SCREENS * (sc.clientHeight || window.innerHeight);
    sc.scrollTo({ top: sc.scrollTop - delta / k, behavior: smooth ? 'smooth' : 'auto' });
    armSettle(smooth ? SETTLE_TIMEOUT_MS : SETTLE_MS);
  }

  function armSettle(ms) {
    clearTimeout(settleTimer);
    settleTimer = setTimeout(settleJump, ms);
  }

  /** 落点校准：内容懒加载会让滚动过程中目标位置漂移，停下后按测量结果收敛几次 */
  function settleJump() {
    const p = pendingJump;
    if (!p) return;
    if (p.seq !== jumpSeq || !p.el.isConnected) return cancelJump();
    const d = p.offset();
    if (Math.abs(d) > 2 && p.tries < MAX_SETTLE_TRIES) {
      p.tries++;
      p.sc.scrollTo({ top: p.sc.scrollTop - d / p.k, behavior: 'auto' });
      armSettle(SETTLE_MS);
      return;
    }
    const el = p.el;
    const flash = p.flash;
    cancelJump();
    if (flash) rail.flash(el.getBoundingClientRect());
  }

  function cancelJump() {
    clearTimeout(settleTimer);
    settleTimer = null;
    pendingJump = null;
  }

  // ---------------------------------------------------------------- 生命周期
  function attachObservers() {
    new MutationObserver(() => scheduleMeasure()).observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    new MutationObserver(() => syncTheme()).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'class'],
    });

    ro = new ResizeObserver(() => scheduleMeasure(true));
    watchdogTimer = setInterval(onWatchdog, WATCHDOG_MS);
    window.addEventListener('popstate', afterNavigation);

    const wrap = (fn) => function wrapped(...args) {
      const r = fn.apply(this, args);
      queueMicrotask(afterNavigation);
      return r;
    };
    try {
      history.pushState = wrap(history.pushState);
      history.replaceState = wrap(history.replaceState);
    } catch {
      /* ignore */
    }
    document.addEventListener('visibilitychange', () => scheduleMeasure(true));
  }

  function onWatchdog() {
    if (location.href !== lastHref) return afterNavigation();
    if (document.visibilityState !== 'visible') return;
    const sc = adapter.getScrollContainer();
    if (!sc) return;
    if (ro && roTarget !== sc) {
      if (roTarget) ro.unobserve(roTarget);
      ro.observe(sc);
      roTarget = sc;
    }
    const sig = [sc.scrollHeight, sc.clientWidth, sc.clientHeight, measured.length, baseEl && baseEl.isConnected ? 1 : 0].join('|');
    if (sig !== lastSig) {
      lastSig = sig;
      scheduleMeasure(true);
      return;
    }
    // 高度没变但内部节点位置漂移（懒加载/展开折叠）时也要重排
    const mid = measured[Math.floor(measured.length / 2)];
    if (mid && mid.promptEl && mid.promptEl.isConnected && baseEl && baseEl.isConnected) {
      const shifted = Math.abs(mid.promptEl.getBoundingClientRect().top - mid.top - (baseEl.getBoundingClientRect().top - baseTopAtMeasure));
      if (shifted > 4) {
        scheduleMeasure(true);
        return;
      }
    }
    updateActive();
  }

  function afterNavigation() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    log('navigation', lastHref);
    clearViews();
    scheduleMeasure(true);
  }

  // ---------------------------------------------------------------- 启动
  async function start() {
    opts = await loadOptions();
    NS.debug = !!opts.debug;
    rail = new NS.Rail({ onJump: jump }).mount();
    rail.setTheme(currentTheme());
    watchOptions();
    attachObservers();
    scheduleMeasure(true);
    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === 'toggle') {
          opts.enabled = !opts.enabled;
          chrome.storage.sync.set({ enabled: opts.enabled });
          scheduleMeasure(true);
        }
      });
    } catch {
      /* ignore */
    }
    log('started');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();
