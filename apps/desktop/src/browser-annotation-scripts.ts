/** Fixed isolated-world scripts for web element annotation capture, owned by the main process. */

/**
 * Resolves the armed annotation session with an already validated plain object.
 * @param payload - plain JSON-safe object collected and sanitized by the main process.
 * @returns one fixed script whose only variable part is a single JSON literal, never page data.
 */
export function annotationResolveCode(payload: object): string {
  return `globalThis.__dshAnno.resolve(${JSON.stringify(payload)})`
}

/**
 * Arms element picking in the guest's isolated world (world 1001) and resolves with the
 * picked payload, or null on Escape, timeout, or cancel. Renderers never supply any part
 * of this source; the completion value of the script is the session promise.
 */
export const ANNOTATION_ARM_SCRIPT = `(() => {
  let settled = false;
  let overlay = null;
  let box = null;
  let timer = 0;
  let observer = null;
  let target = null;
  const cleanups = [];
  const picked = [];
  const MAX_PICKED = 8;
  let complete = (value) => {};
  const promise = new Promise((resolve) => { complete = resolve; });
  const teardown = () => {
    settled = true;
    if (timer) { clearTimeout(timer); timer = 0; }
    if (observer) { observer.disconnect(); observer = null; }
    for (const remove of cleanups.splice(0)) remove();
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
    overlay = null;
    box = null;
    delete globalThis.__dshAnno;
  };
  const settle = (value) => {
    if (settled) return;
    complete(value);
    teardown();
  };
  const remount = () => {
    if (settled || !overlay || overlay.isConnected) return;
    document.documentElement.appendChild(overlay);
  };
  observer = new MutationObserver(remount);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  overlay = document.createElement('div');
  overlay.setAttribute('style', 'position:fixed !important;inset:0 !important;z-index:2147483647 !important;'
    + 'cursor:crosshair !important;margin:0 !important;padding:0 !important;border:0 !important;'
    + 'background:transparent !important;box-shadow:none !important;outline:0 !important;');
  box = document.createElement('div');
  box.setAttribute('style', 'position:fixed !important;margin:0 !important;padding:0 !important;'
    + 'border:2px solid #2563eb !important;border-radius:2px !important;pointer-events:none !important;'
    + 'box-shadow:0 0 0 200000px rgba(37,99,235,0.12) !important;display:none !important;');
  overlay.appendChild(box);
  document.documentElement.appendChild(overlay);
  const frameFor = (element, index, strong) => {
    const ring = document.createElement('div');
    const color = strong ? '#16a34a' : '#2563eb';
    ring.setAttribute('style', 'position:absolute !important;margin:0 !important;padding:0 !important;'
      + 'border:2px solid ' + color + ' !important;border-radius:2px !important;pointer-events:none !important;'
      + 'font:600 11px/16px ui-sans-serif,sans-serif !important;color:#fff !important;');
    const rect = element.getBoundingClientRect();
    ring.style.left = rect.left + 'px';
    ring.style.top = rect.top + 'px';
    ring.style.width = rect.width + 'px';
    ring.style.height = rect.height + 'px';
    const badge = document.createElement('span');
    badge.textContent = String(index + 1);
    badge.setAttribute('style', 'position:absolute !important;left:-1px !important;top:-18px !important;'
      + 'min-width:16px !important;height:16px !important;padding:0 4px !important;border-radius:3px !important;'
      + 'background:' + color + ' !important;color:#fff !important;font:600 11px/16px ui-sans-serif,sans-serif !important;'
      + 'text-align:center !important;');
    ring.appendChild(badge);
    overlay.appendChild(ring);
    return ring;
  };
  const repaint = () => {
    if (!overlay) return;
    for (const node of Array.from(overlay.querySelectorAll('[data-dsh-pick]'))) node.remove();
    picked.forEach((item, index) => { if (item.element.isConnected) overlay.appendChild(frameFor(item.element, index, false)); });
  };
  const hover = (event) => {
    if (settled || !overlay || !box || event.clientX < 0 || event.clientY < 0) return;
    const hidden = overlay.style.display;
    overlay.style.display = 'none';
    const element = document.elementFromPoint(event.clientX, event.clientY);
    overlay.style.display = hidden;
    target = element instanceof Element ? element : null;
    if (!target) { box.style.display = 'none'; return; }
    const rect = target.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = rect.left + 'px';
    box.style.top = rect.top + 'px';
    box.style.width = rect.width + 'px';
    box.style.height = rect.height + 'px';
    box.style.borderColor = picked.some((item) => item.element === target) ? '#16a34a' : '#2563eb';
  };
  const buildAll = () => picked.map((item) => ({ locator: locate(item.element), snapshot: describe(item.element) }));
  const onKey = (event) => {
    if (settled) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      settle(null);
      return;
    }
    if (event.key === 'Enter' && picked.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      settle({ elements: buildAll() });
      return;
    }
    if ((event.key === 'Backspace' || event.key === 'Delete') && picked.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      picked.pop();
      repaint();
      if (picked.length === 0) box.style.borderColor = '#2563eb';
    }
  };
  const onMove = (event) => { hover(event); };
  const onClick = (event) => {
    if (settled) return;
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (!target) return;
    const additive = event.metaKey || event.ctrlKey || event.shiftKey;
    const existing = picked.findIndex((item) => item.element === target);
    if (existing >= 0) {
      picked.splice(existing, 1);
      repaint();
      if (picked.length === 0) box.style.borderColor = '#2563eb';
      return;
    }
    if (!additive) for (const item of picked.splice(0)) repaint();
    if (picked.length >= MAX_PICKED) picked.shift();
    picked.push({ element: target });
    repaint();
    // A plain click commits immediately, matching one-shot picking; additive clicks keep collecting.
    if (!additive) settle({ elements: buildAll() });
  };
  const track = (name, handler) => {
    document.addEventListener(name, handler, true);
    cleanups.push(() => document.removeEventListener(name, handler, true));
  };
  track('mousemove', onMove);
  track('click', onClick);
  track('keydown', onKey);
  timer = setTimeout(() => { settle(picked.length > 0 ? { elements: buildAll() } : null); }, 120000);
  globalThis.__dshAnno = {
    resolve: (value) => {
      settle(value !== null && typeof value === 'object' ? value : null);
    },
    cancel: () => {
      if (overlay) { const current = overlay; overlay = null; if (current.parentNode) current.parentNode.removeChild(current); }
      box = null;
      settle(null);
    },
  };
  const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]*$/;
  const ALLOWED_ATTRIBUTES = ['id', 'class', 'name', 'type', 'placeholder', 'alt', 'title', 'role', 'aria-label', 'data-testid', 'data-test'];
  const IMPLICIT_ROLES = { A: 'link', BUTTON: 'button', SELECT: 'combobox', TEXTAREA: 'textbox', IMG: 'img', MAIN: 'main', NAV: 'navigation', ASIDE: 'complementary', FORM: 'form', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading', H5: 'heading', H6: 'heading' };
  const pathSegments = (element) => {
    const segments = [];
    let node = element;
    for (let depth = 0; node && node.nodeType === 1 && depth < 24; depth++) {
      let segment = node.tagName.toLowerCase();
      if (node.id && IDENTIFIER.test(node.id)) {
        segment += '#' + node.id;
      } else {
        const parent = node.parentElement;
        if (parent) {
          const same = Array.from(parent.children).filter((child) => child.tagName === node.tagName);
          if (same.length > 1) segment += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
        }
      }
      segments.unshift(segment);
      node = node.parentElement;
    }
    return segments;
  };
  const locate = (element) => {
    if (!(element instanceof Element)) return null;
    const attributes = {};
    for (const key of ALLOWED_ATTRIBUTES) {
      const value = element.getAttribute(key);
      if (typeof value === 'string') attributes[key] = value;
    }
    const segments = pathSegments(element);
    const candidates = [];
    if (attributes.id && IDENTIFIER.test(attributes.id)) candidates.push('#' + attributes.id);
    if (attributes['data-testid']) candidates.push('[data-testid="' + attributes['data-testid'].replace(/"/g, '\\\\"') + '"]');
    if (attributes.name) candidates.push('[name="' + attributes.name.replace(/"/g, '\\\\"') + '"]');
    if (attributes['aria-label']) candidates.push('[aria-label="' + attributes['aria-label'].replace(/"/g, '\\\\"') + '"]');
    const role = attributes.role || IMPLICIT_ROLES[element.tagName] || '';
    const text = (element.textContent || '').replace(/\\s+/g, ' ').trim();
    return {
      cssPath: segments.join(' > '),
      candidates: candidates.slice(0, 5),
      testId: attributes['data-testid'],
      id: attributes.id,
      role: role,
      name: attributes['aria-label'] || attributes.alt || attributes.placeholder || attributes.title || text,
      text: text,
      tagName: element.tagName.toLowerCase(),
      ancestors: segments.slice(0, -1).reverse().slice(0, 6),
      fingerprint: element.tagName.toLowerCase() + '|' + (attributes.id || '') + '|' + (attributes['data-testid'] || '') + '|' + segments.join('>'),
    };
  };
  const describe = (element) => {
    if (!(element instanceof Element)) return null;
    const attributes = {};
    for (const key of ALLOWED_ATTRIBUTES) {
      const value = element.getAttribute(key);
      if (typeof value === 'string') attributes[key] = value;
    }
    let summary = '<' + element.tagName.toLowerCase();
    for (const key of Object.keys(attributes)) {
      summary += ' ' + key + '="' + attributes[key].replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '"';
    }
    summary += '>';
    const rect = element.getBoundingClientRect();
    return {
      text: (element.textContent || '').replace(/\\s+/g, ' ').trim(),
      role: attributes.role || IMPLICIT_ROLES[element.tagName] || '',
      name: attributes['aria-label'] || attributes.alt || attributes.placeholder || attributes.title || '',
      tagName: element.tagName.toLowerCase(),
      attributes: attributes,
      htmlSummary: summary,
      // React attaches this key to the DOM node it rendered; it survives component renames and
      // narrows a source search to the owning component instead of an anonymous selector.
      componentName: readComponentName(element),
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
        scrollX: window.scrollX,
        scrollY: window.scrollY,
      },
    };
  };
  const readComponentName = (element) => {
    try {
      for (const key of Object.keys(element)) {
        if (!key.startsWith('__reactFiber$') && !key.startsWith('__reactInternalInstance$')) continue;
        let fiber = element[key];
        for (let depth = 0; fiber && depth < 32; depth++) {
          const type = fiber.type;
          const name = typeof type === 'function' ? type.displayName || type.name : '';
          if (name && /^[A-Z]/.test(name)) return String(name).slice(0, 80);
          fiber = fiber.return;
        }
      }
    } catch (error) {
      // A page may shadow its own fiber fields; the selector alone still locates the element.
    }
    return '';
  };
  return promise;
})()`

/**
 * Tears down an armed annotation session in the guest's isolated world: removes the overlay
 * and settles the session promise with null. Safe to run when nothing is armed.
 */
export const ANNOTATION_CANCEL_SCRIPT = `(() => {
  if (globalThis.__dshAnno && typeof globalThis.__dshAnno.cancel === 'function') globalThis.__dshAnno.cancel();
})()`
