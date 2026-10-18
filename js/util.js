/*
 * util.js
 * -------
 * Small shared helpers: creating elements, loading images, canvases,
 * downloads, dialogs, menus and toast messages.
 */
(function () {
  'use strict';
  const SL = (window.SL = window.SL || {});
  const U = {};

  /** Short random id, e.g. "k3f9x2ab". */
  U.uid = function () {
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  };

  U.clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  /** Run `fn` at most once per animation frame. */
  U.rafThrottle = function (fn) {
    let queued = false;
    let lastArgs = null;
    return function (...args) {
      lastArgs = args;
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        fn.apply(null, lastArgs);
      });
    };
  };

  U.debounce = function (fn, ms) {
    let t = null;
    const wrapped = function (...args) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(null, args), ms);
    };
    wrapped.flush = function () {
      clearTimeout(t);
      fn();
    };
    return wrapped;
  };

  /**
   * Create an element. Example:
   *   U.el('button', { class: 'btn', onclick: fn }, 'Save')
   */
  U.el = function (tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  };

  /** An inline SVG icon from the sprite in index.html. */
  U.icon = function (name) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '#i-' + name);
    svg.appendChild(use);
    return svg;
  };

  /** Make a canvas of the given size. */
  U.canvas = function (w, h) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w));
    c.height = Math.max(1, Math.round(h));
    return c;
  };

  /** Load a File/Blob into an <img> (respects phone photo rotation). */
  U.loadImage = function (blob) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('This file could not be opened as an image.'));
      };
      img.src = url;
    });
  };

  /** Draw any image source into a canvas no bigger than maxSide pixels. */
  U.imageToCanvas = function (source, maxSide) {
    const sw = source.naturalWidth || source.videoWidth || source.width;
    const sh = source.naturalHeight || source.videoHeight || source.height;
    const scale = Math.min(1, maxSide / Math.max(sw, sh));
    const c = U.canvas(sw * scale, sh * scale);
    const ctx = c.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, c.width, c.height);
    return c;
  };

  /** Canvas -> Blob (PNG by default). */
  U.canvasToBlob = function (canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode image'))), type || 'image/png', quality);
    });
  };

  U.blobToDataURL = function (blob) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
  };

  U.dataURLToBlob = async function (dataURL) {
    const res = await fetch(dataURL);
    return res.blob();
  };

  /** Save a Blob as a downloaded file. */
  U.download = function (blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = U.el('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  /** Make a safe-ish file name from free text. */
  U.slug = function (text) {
    return (text || 'layout').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'layout';
  };

  /** Format millimetres as centimetres, e.g. 72 -> "7.2". */
  U.cm = function (mm) {
    const v = mm / 10;
    return v >= 10 ? v.toFixed(1).replace(/\.0$/, '') : v.toFixed(1);
  };

  /** A reusable checkerboard pattern for showing transparency. */
  U.checkerPattern = function (ctx, size, a, b) {
    const s = size || 10;
    const c = U.canvas(s * 2, s * 2);
    const g = c.getContext('2d');
    g.fillStyle = a || '#ffffff';
    g.fillRect(0, 0, s * 2, s * 2);
    g.fillStyle = b || '#e3e7ec';
    g.fillRect(0, 0, s, s);
    g.fillRect(s, s, s, s);
    return ctx.createPattern(c, 'repeat');
  };

  /* ---------------- Toast messages ---------------- */

  U.toast = function (message, opts) {
    opts = opts || {};
    const host = document.getElementById('toasts');
    const node = U.el('div', { class: 'toast' + (opts.error ? ' toast--error' : ''), role: 'status' }, message);
    if (opts.action) {
      node.append(U.el('button', {
        class: 'toast__action',
        onclick: () => {
          opts.action.run();
          node.remove();
        }
      }, opts.action.label));
    }
    host.append(node);
    setTimeout(() => node.classList.add('is-leaving'), opts.duration || 3200);
    setTimeout(() => node.remove(), (opts.duration || 3200) + 400);
  };

  /* ---------------- Small dialogs ---------------- */

  /**
   * Show a dialog with custom content. `build(close)` returns the form body;
   * `actions` is a list of { label, value, primary, danger }.
   * Resolves with the chosen action value (or null when cancelled).
   */
  U.dialog = function ({ title, body, actions, onSubmit }) {
    return new Promise((resolve) => {
      const dlg = U.el('dialog', { class: 'dialog' });
      const form = U.el('form', { method: 'dialog', class: 'dialog__form' });
      form.append(U.el('h2', { class: 'dialog__title' }, title));
      if (body) form.append(body);
      const row = U.el('div', { class: 'dialog__actions' });
      for (const a of actions) {
        row.append(U.el('button', {
          type: a.value === null ? 'button' : 'submit',
          value: a.value == null ? '' : a.value,
          class: 'btn' + (a.primary ? ' btn--primary' : '') + (a.danger ? ' btn--danger' : ''),
          onclick: a.value === null ? () => dlg.close('') : null
        }, a.label));
      }
      form.append(row);
      dlg.append(form);
      form.addEventListener('submit', (e) => {
        const value = e.submitter ? e.submitter.value : '';
        if (onSubmit && value) {
          const ok = onSubmit(value, form);
          if (ok === false) {
            e.preventDefault();
            return;
          }
        }
      });
      dlg.addEventListener('close', () => {
        resolve(dlg.returnValue || null);
        dlg.remove();
      });
      document.body.append(dlg);
      dlg.showModal();
      const first = form.querySelector('input, select, textarea');
      if (first) {
        first.focus();
        if (first.select) first.select();
      }
    });
  };

  U.confirm = async function (title, message, okLabel, danger) {
    const v = await U.dialog({
      title,
      body: U.el('p', { class: 'dialog__text' }, message),
      actions: [
        { label: 'Cancel', value: null },
        { label: okLabel || 'OK', value: 'ok', primary: !danger, danger: !!danger }
      ]
    });
    return v === 'ok';
  };

  U.prompt = async function (title, label, value, okLabel) {
    const input = U.el('input', { class: 'field__input', type: 'text', value: value || '', required: true, maxlength: 60 });
    const v = await U.dialog({
      title,
      body: U.el('label', { class: 'field' }, U.el('span', { class: 'field__label' }, label), input),
      actions: [{ label: 'Cancel', value: null }, { label: okLabel || 'Save', value: 'ok', primary: true }]
    });
    return v === 'ok' ? input.value.trim() : null;
  };

  /* ---------------- Pop-up menus ---------------- */

  let openMenu = null;
  function closeMenu() {
    if (openMenu) {
      openMenu.node.remove();
      openMenu.anchor.setAttribute('aria-expanded', 'false');
      openMenu = null;
    }
  }
  document.addEventListener('pointerdown', (e) => {
    if (openMenu && !openMenu.node.contains(e.target) && !openMenu.anchor.contains(e.target)) closeMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openMenu) {
      const a = openMenu.anchor;
      closeMenu();
      a.focus();
    }
  });
  window.addEventListener('resize', closeMenu);

  /**
   * Open a small menu under `anchor`.
   * items: [{ label, onSelect, danger, disabled }] or 'separator'
   */
  U.menu = function (anchor, items) {
    if (openMenu && openMenu.anchor === anchor) {
      closeMenu();
      return;
    }
    closeMenu();
    const node = U.el('div', { class: 'menu', role: 'menu' });
    for (const it of items) {
      if (it === 'separator') {
        node.append(U.el('div', { class: 'menu__sep', role: 'separator' }));
        continue;
      }
      node.append(U.el('button', {
        class: 'menu__item' + (it.danger ? ' menu__item--danger' : ''),
        role: 'menuitem',
        disabled: !!it.disabled,
        onclick: () => {
          closeMenu();
          it.onSelect();
        }
      }, it.label));
    }
    document.body.append(node);
    const r = anchor.getBoundingClientRect();
    const mw = node.offsetWidth;
    let left = r.right - mw;
    if (left < 8) left = Math.min(r.left, window.innerWidth - mw - 8);
    node.style.left = Math.max(8, left) + 'px';
    const below = r.bottom + 6;
    node.style.top = (below + node.offsetHeight > window.innerHeight - 8 ? r.top - node.offsetHeight - 6 : below) + 'px';
    anchor.setAttribute('aria-expanded', 'true');
    openMenu = { node, anchor };
    const first = node.querySelector('button:not([disabled])');
    if (first) first.focus();
    node.addEventListener('keydown', (e) => {
      const btns = [...node.querySelectorAll('button:not([disabled])')];
      const i = btns.indexOf(document.activeElement);
      if (e.key === 'ArrowDown') { e.preventDefault(); btns[(i + 1) % btns.length].focus(); }
      if (e.key === 'ArrowUp') { e.preventDefault(); btns[(i - 1 + btns.length) % btns.length].focus(); }
    });
  };
  U.closeMenu = closeMenu;

  /** True when the keyboard focus is in a text field (so shortcuts should not fire). */
  U.isTyping = function () {
    const a = document.activeElement;
    if (!a) return false;
    const tag = a.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable;
  };

  SL.U = U;
})();
