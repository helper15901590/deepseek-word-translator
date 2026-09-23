// 影子根穿透与跨边界 DOM 遍历（content script 使用）
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.DomUtils = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;
  const SHOW_ELEMENT = 1;

  // elementFromPoint 在影子边界会被重定向到宿主，故逐层下降收集指针处的开放影子根
  function collectShadowRootsAt(doc, x, y) {
    const roots = [];
    let el = doc.elementFromPoint(x, y);
    while (el && el.shadowRoot && roots.indexOf(el.shadowRoot) === -1) {
      roots.push(el.shadowRoot);
      const inner = el.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return roots;
  }

  function textPosition(node, offset) {
    if (!node || node.nodeType !== TEXT_NODE) return null;
    return { node: node, offset: offset };
  }

  // 返回指针处的 {node, offset}（仅文本节点）或 null。
  // 命中影子根内容时用 caretPositionFromPoint + shadowRoots（caretRangeFromPoint
  // 在影子根内只返回元素）；其余情况沿用 caretRangeFromPoint，保持既有命中宽容度。
  function caretAtPoint(doc, x, y) {
    const roots = collectShadowRootsAt(doc, x, y);
    if (roots.length > 0 && typeof doc.caretPositionFromPoint === "function") {
      const pos = doc.caretPositionFromPoint(x, y, { shadowRoots: roots });
      return textPosition(pos && pos.offsetNode, pos && pos.offset);
    }
    if (typeof doc.caretRangeFromPoint === "function") {
      const range = doc.caretRangeFromPoint(x, y);
      if (range) return textPosition(range.startContainer, range.startOffset);
    }
    if (typeof doc.caretPositionFromPoint === "function") {
      const pos = doc.caretPositionFromPoint(x, y);
      return textPosition(pos && pos.offsetNode, pos && pos.offset);
    }
    return null;
  }

  // 父元素；跨越影子边界时返回影子宿主
  function parentOrHost(el) {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode();
    return root && root.host ? root.host : null;
  }

  // closest 不跨越影子边界，故手动向上查找
  function closestAcrossBoundaries(el, selector) {
    let node = el;
    while (node && node.nodeType === ELEMENT_NODE) {
      if (node.matches(selector)) return node;
      node = parentOrHost(node);
    }
    return null;
  }

  // 取词所在文本块：优先块级祖先；整条链没有块级祖先时回退到最内层影子根，
  // 以保证返回节点与单词同树（Range 无法跨树，跨树取值只能得到错误的语境）
  function findContextBlock(node, blockTags, boundary) {
    let el = node && node.nodeType === TEXT_NODE ? node.parentElement : node;
    let shadowFallback = null;
    while (el && el !== boundary) {
      if (blockTags.has(el.tagName)) return el;
      if (!el.parentElement) {
        const root = el.getRootNode();
        if (root && root.host) shadowFallback = shadowFallback || root;
      }
      el = parentOrHost(el);
    }
    return shadowFallback || boundary || null;
  }

  // root 子树内的全部开放影子根（TreeWalker 不进入影子树，需逐层收集）
  function collectOpenShadowRoots(root) {
    const found = [];
    const doc = root.ownerDocument || root;
    const walker = doc.createTreeWalker(root, SHOW_ELEMENT);
    let el = walker.nextNode();
    while (el) {
      if (el.shadowRoot) found.push(el.shadowRoot);
      el = walker.nextNode();
    }
    return found;
  }

  return {
    collectShadowRootsAt,
    caretAtPoint,
    parentOrHost,
    closestAcrossBoundaries,
    findContextBlock,
    collectOpenShadowRoots,
  };
});
