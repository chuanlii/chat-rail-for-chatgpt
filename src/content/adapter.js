/**
 * ChatGPTAdapter —— 只负责回答三个问题：
 *   1. 哪个元素是真正的滚动容器？
 *   2. 哪些节点是「一次用户提问」？
 *   3. 这条提问的文本是什么？
 *
 * ChatGPT 前端随时会改 class，所以这里全部走「语义属性 → 结构兜底」的多层 fallback，
 * 并且优先使用当前 build 里实际存在的属性（data-turn-key / bg-user-message /
 * data-app-action-timeline-scroll），不依赖 hash 过的 CSS Module 类名。
 */
(() => {
  const NS = (globalThis.__ChatRail = globalThis.__ChatRail || {});

  /** 滚动容器候选：语义属性优先，class 次之 */
  const SCROLL_SELECTORS = [
    '[data-app-action-timeline-scroll]',
    '.thread-scroll-container',
    '[data-scroll-root]',
  ];

  /** 轮次容器候选：从新到旧 */
  const TURN_SELECTORS = [
    '[data-turn-key]',
    '[data-content-search-turn-key]',
    'article[data-testid^="conversation-turn-"]',
    'section[data-testid^="conversation-turn-"]',
  ];

  /** 用户提问节点候选：从新到旧 */
  const PROMPT_SELECTORS = [
    '[data-message-author-role="user"]',
    '[class*="bg-user-message"]',
    '[class*="user-message-bubble-color"]',
  ];

  /** 滚动内容顶部的粘性元素会污染「以某个节点为原点」的测量，排除掉 */
  function isSticky(el) {
    try {
      return getComputedStyle(el).position === 'sticky';
    } catch {
      return false;
    }
  }

  function isScrollable(el) {
    if (!el || el.nodeType !== 1) return false;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') return false;
    return el.scrollHeight - el.clientHeight > 8;
  }

  /** 滚动容器：优先语义属性；否则从提问节点向上找最近的可滚动祖先 */
  function getScrollContainer() {
    for (const sel of SCROLL_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        if (isScrollable(el)) return el;
      }
    }
    const seed = document.querySelector(TURN_SELECTORS.join(',')) || document.querySelector(PROMPT_SELECTORS.join(','));
    let el = seed ? seed.parentElement : null;
    while (el && el !== document.documentElement) {
      if (isScrollable(el)) return el;
      el = el.parentElement;
    }
    const de = document.scrollingElement;
    return de && de.scrollHeight - de.clientHeight > 8 ? de : null;
  }

  /** 一轮里找出「用户提问」的节点 */
  function findPrompt(turnEl) {
    for (const sel of PROMPT_SELECTORS) {
      const el = turnEl.querySelector(sel);
      if (el) return el;
    }
    // 结构兜底：右对齐容器里的第一个文本块
    const wraps = turnEl.querySelectorAll('[class*="items-end"], [class*="justify-end"]');
    for (const wrap of wraps) {
      const text = wrap.querySelector('[class*="whitespace-pre-wrap"]');
      if (text) return text.closest('[class*="gap-1"]') || text;
    }
    return null;
  }

  /** 提问文本：剥掉按钮/图标，压平空白 */
  function extractText(promptEl) {
    const holder = promptEl.querySelector('[class*="whitespace-pre-wrap"]') || promptEl;
    const clone = holder.cloneNode(true);
    clone
      .querySelectorAll('button, svg, script, style, noscript, [aria-hidden="true"], [class*="sr-only"]')
      .forEach((n) => n.remove());
    return (clone.textContent || '')
      .replace(/[ \t\u00a0]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim();
  }

  function keyOf(turnEl, fallbackIndex) {
    return (
      turnEl.getAttribute('data-turn-key') ||
      turnEl.getAttribute('data-content-search-turn-key') ||
      turnEl.getAttribute('data-message-id') ||
      turnEl.getAttribute('data-testid') ||
      `idx:${fallbackIndex}`
    );
  }

  /**
   * 收集当前 DOM 里的全部提问轮次。
   * 返回 [{ key, turnEl, promptEl, text, hasAttachment }]
   */
  function getTurns(scroller) {
    let turnEls = [];
    for (const sel of TURN_SELECTORS) {
      const found = Array.from(document.querySelectorAll(sel)).filter((el) => !scroller || scroller.contains(el));
      if (found.length) {
        turnEls = found;
        break;
      }
    }

    const out = [];
    const seen = new Set();
    turnEls.forEach((turnEl, i) => {
      const promptEl = findPrompt(turnEl);
      if (!promptEl) return; // 只有助手消息的容器，跳过
      const key = keyOf(turnEl, i);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        key,
        turnEl,
        promptEl,
        text: extractText(promptEl),
        hasAttachment: !!promptEl.querySelector('img, [class*="attachment"]'),
      });
    });
    return out;
  }

  /** 内容列的左右边缘：从轮次节点向外找第一层「被限宽」的祖先 */
  function getColumnEdges(scroller, turns) {
    const sRect = scroller.getBoundingClientRect();
    const seed = turns[0] && (turns[0].turnEl || turns[0].promptEl);
    let el = seed;
    while (el && el !== scroller && el.nodeType === 1) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.width < sRect.width - 16) {
        let node = el;
        while (node && node !== scroller && isSticky(node)) node = node.parentElement;
        const col = (node || el).getBoundingClientRect();
        return { left: col.left, right: col.right, width: col.width };
      }
      el = el.parentElement;
    }
    const inner = turns[0] && turns[0].promptEl ? turns[0].promptEl.getBoundingClientRect() : null;
    if (inner) return { left: inner.left, right: inner.right, width: inner.width };
    return { left: sRect.left, right: sRect.right, width: sRect.width };
  }

  NS.adapter = { getScrollContainer, getTurns, getColumnEdges, findPrompt };
})();
