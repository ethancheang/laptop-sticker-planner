/*
 * app.js
 * ------
 * Connects everything: the sticker library on the left, the lid editor,
 * layouts, laptop settings, saving to the browser, and keyboard shortcuts.
 */
(function () {
  'use strict';
  const SL = window.SL;
  const U = SL.U;
  const DB = SL.DB;
  const el = U.el;
  const $ = (id) => document.getElementById(id);

  /* ------------------------------------------------------------------ *
   * State
   * ------------------------------------------------------------------ */

  const LAPTOP_PRESETS = [
    { id: '13', label: '13-inch (30.4 × 21.5 cm)', w: 304, h: 215, r: 10 },
    { id: '14', label: '14-inch (31.3 × 22.1 cm)', w: 313, h: 221, r: 10 },
    { id: '15', label: '15-inch (34.0 × 23.8 cm)', w: 340, h: 238, r: 11 },
    { id: '16', label: '16-inch (35.6 × 24.8 cm)', w: 356, h: 248, r: 11 }
  ];
  const LID_COLORS = [
    { name: 'Silver', value: '#c9ccd1' },
    { name: 'Space grey', value: '#7c8088' },
    { name: 'Midnight', value: '#2b3240' },
    { name: 'Black', value: '#202225' },
    { name: 'White', value: '#eceeef' },
    { name: 'Sage', value: '#a9b8a4' },
    { name: 'Blue', value: '#6f8fb3' },
    { name: 'Pink', value: '#e7b9be' }
  ];
  const DEFAULT_LAPTOP = {
    preset: '14', widthMm: 313, heightMm: 221, radiusMm: 10, color: '#c9ccd1',
    logo: { show: true, diameterMm: 24, x: 50, y: 50 }
  };

  const state = {
    stickers: new Map(),   // id -> sticker record (+ rt: runtime images)
    layouts: [],           // [{ id, name, items, updated }]
    activeId: null,
    laptop: null,
    laptopPhoto: null,     // Blob
    laptopPhotoImg: null,  // drawable
    prefs: { shadows: true, lockSize: true }
  };

  let editor = null;

  const activeLayout = () => state.layouts.find((l) => l.id === state.activeId);
  const sortedStickers = () => [...state.stickers.values()].sort((a, b) => a.created - b.created);

  /* ------------------------------------------------------------------ *
   * Saving (debounced so dragging doesn't write constantly)
   * ------------------------------------------------------------------ */

  const dirtyLayouts = new Set();
  let savesPaused = false; // set while restoring a backup or deleting everything
  const flushSaves = U.debounce(async () => {
    if (savesPaused) return;
    const ids = [...dirtyLayouts];
    dirtyLayouts.clear();
    try {
      for (const id of ids) {
        const l = state.layouts.find((x) => x.id === id);
        if (l) await DB.put('layouts', l);
      }
      await DB.setKV('activeLayout', state.activeId);
      await DB.setKV('prefs', state.prefs);
    } catch (err) {
      console.error(err);
      U.toast('Changes couldn’t be saved: ' + err.message, { error: true });
    }
  }, 400);

  function markLayoutDirty(layout) {
    layout = layout || activeLayout();
    if (!layout) return;
    layout.updated = Date.now();
    dirtyLayouts.add(layout.id);
    flushSaves();
  }

  window.addEventListener('beforeunload', () => flushSaves.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushSaves.flush();
  });

  /* ------------------------------------------------------------------ *
   * Sticker images
   * ------------------------------------------------------------------ */

  /** Prepare the images the editor needs for a saved sticker. */
  async function hydrate(rec) {
    const img = await U.loadImage(rec.image);
    const small = U.imageToCanvas(img, 480);
    // Low-resolution alpha map for click detection.
    const hitCanvas = U.imageToCanvas(img, 96);
    const a = hitCanvas.getContext('2d').getImageData(0, 0, hitCanvas.width, hitCanvas.height).data;
    const hit = { w: hitCanvas.width, h: hitCanvas.height, data: new Uint8Array(hitCanvas.width * hitCanvas.height) };
    for (let i = 0; i < hit.data.length; i++) hit.data[i] = a[i * 4 + 3];
    if (rec.rt && rec.rt.url) URL.revokeObjectURL(rec.rt.url);
    rec.rt = { full: img, small, hit, url: URL.createObjectURL(rec.image), pxW: img.naturalWidth };
    return rec;
  }

  function storable(rec) {
    const { rt, ...rest } = rec;
    return rest;
  }

  /* ------------------------------------------------------------------ *
   * Library (left panel)
   * ------------------------------------------------------------------ */

  function usageCounts() {
    const counts = new Map();
    const layout = activeLayout();
    if (layout) for (const it of layout.items) counts.set(it.stickerId, (counts.get(it.stickerId) || 0) + 1);
    return counts;
  }

  function renderLibrary() {
    const list = sortedStickers();
    const counts = usageCounts();
    $('libraryCount').textContent = list.length ? String(list.length) : '';
    $('libraryEmpty').hidden = list.length > 0;
    $('tiles').replaceChildren(...list.map((st) => {
      const add = el('button', {
        class: 'tile__main',
        type: 'button',
        draggable: 'true',
        'aria-label': `Put ${st.name} on the laptop`,
        title: 'Click to add, or drag onto the lid',
        onclick: () => addToLid(st.id),
        ondragstart: (e) => {
          e.dataTransfer.setData('text/x-sticker-id', st.id);
          e.dataTransfer.effectAllowed = 'copy';
          const img = add.querySelector('img');
          if (img) e.dataTransfer.setDragImage(img, img.width / 2, img.height / 2);
        }
      }, el('img', { src: st.rt.url, alt: '', draggable: 'false' }));
      const more = el('button', {
        class: 'icon-btn tile__more',
        type: 'button',
        'aria-label': `Options for ${st.name}`,
        'aria-haspopup': 'menu',
        'aria-expanded': 'false',
        onclick: () => U.menu(more, [
          { label: 'Edit name and size', onSelect: () => editSticker(st.id) },
          { label: 'Fix the cut-out', onSelect: () => recutSticker(st.id), disabled: !!st.sample },
          'separator',
          { label: 'Delete from library', onSelect: () => deleteSticker(st.id), danger: true }
        ])
      }, U.icon('more'));
      const n = counts.get(st.id) || 0;
      return el('li', { class: 'tile' },
        add,
        more,
        n ? el('span', { class: 'tile__count', title: `${n} on this layout` }, '×' + n) : null,
        el('div', { class: 'tile__meta' },
          el('span', { class: 'tile__name' }, st.name),
          el('span', { class: 'tile__size' }, `${U.cm(st.widthMm)} × ${U.cm(st.heightMm)} cm`)));
    }));
  }

  function addToLid(stickerId) {
    editor.addSticker(stickerId);
    $('mat').focus({ preventScroll: true });
  }

  /** Put several new stickers on the lid in free spots (one undo step). */
  function placeMany(ids) {
    if (ids.length) editor.addMany(ids);
  }

  async function saveNewStickers(records, place) {
    const ids = [];
    let i = 0;
    for (const r of records) {
      const rec = Object.assign({ id: U.uid(), created: Date.now() + i++ }, r);
      await DB.put('stickers', storable(rec));
      await hydrate(rec);
      state.stickers.set(rec.id, rec);
      ids.push(rec.id);
    }
    if (place) placeMany(ids);
    renderLibrary();
    const n = records.length;
    U.toast(`Saved ${n} sticker${n === 1 ? '' : 's'}${place ? ' and put ' + (n === 1 ? 'it' : 'them') + ' on the laptop' : ''}`);
  }

  function openScanner(files) {
    return SL.Scanner.open({
      mode: 'sticker',
      files,
      hooks: {
        saveStickers: saveNewStickers,
        suggestName: (i) => `Sticker ${state.stickers.size + i + 1}`
      }
    });
  }

  async function recutSticker(id) {
    const st = state.stickers.get(id);
    if (!st) return;
    await SL.Scanner.open({
      mode: 'recut',
      sticker: st,
      hooks: {
        mmPerPxOf: (s, pxW) => s.widthMm / pxW,
        saveRecut: async (stickerId, r) => {
          const rec = state.stickers.get(stickerId);
          Object.assign(rec, { image: r.image, source: r.source, srcOffset: r.srcOffset, widthMm: r.widthMm, heightMm: r.heightMm, name: r.name });
          await DB.put('stickers', storable(rec));
          await hydrate(rec);
          renderLibrary();
          editor.requestRender();
          updateStats();
          U.toast('Cut-out updated');
        }
      }
    });
  }

  async function editSticker(id) {
    const st = state.stickers.get(id);
    if (!st) return;
    const aspect = st.heightMm / st.widthMm;
    const name = el('input', { class: 'field__input', type: 'text', value: st.name, maxlength: 60, required: true });
    const w = el('input', { class: 'field__input field__input--num', type: 'number', min: 0.3, max: 100, step: 0.1, value: (st.widthMm / 10).toFixed(1), required: true });
    const h = el('input', { class: 'field__input field__input--num', type: 'number', min: 0.3, max: 100, step: 0.1, value: (st.heightMm / 10).toFixed(1), required: true });
    w.addEventListener('input', () => { if (+w.value > 0) h.value = (w.value * aspect).toFixed(1); });
    h.addEventListener('input', () => { if (+h.value > 0) w.value = (h.value / aspect).toFixed(1); });
    const body = el('div', { class: 'dialog__body' },
      el('label', { class: 'field' }, el('span', { class: 'field__label' }, 'Name'), name),
      el('div', { class: 'size-row' },
        el('label', { class: 'field field--inline' }, el('span', { class: 'field__label' }, 'Width'), w, el('span', { class: 'field__unit' }, 'cm')),
        el('span', { class: 'size-row__x' }, '×'),
        el('label', { class: 'field field--inline' }, el('span', { class: 'field__label' }, 'Height'), h, el('span', { class: 'field__unit' }, 'cm'))),
      el('p', { class: 'dialog__text dialog__text--muted' }, 'Measure the sticker with a ruler. Width and height stay in proportion.'));
    const res = await U.dialog({
      title: 'Edit sticker',
      body,
      actions: [{ label: 'Cancel', value: null }, { label: 'Save', value: 'ok', primary: true }]
    });
    if (res !== 'ok') return;
    st.name = name.value.trim() || st.name;
    const mm = parseFloat(w.value) * 10;
    if (mm > 0) {
      st.widthMm = mm;
      st.heightMm = mm * aspect;
    }
    await DB.put('stickers', storable(st));
    renderLibrary();
    editor.requestRender();
    editor.select(editor.selected);
    updateStats();
  }

  async function deleteSticker(id) {
    const st = state.stickers.get(id);
    if (!st) return;
    let uses = 0, inLayouts = 0;
    for (const l of state.layouts) {
      const n = l.items.filter((it) => it.stickerId === id).length;
      uses += n;
      if (n) inLayouts++;
    }
    const msg = uses
      ? `It’s placed ${uses} time${uses === 1 ? '' : 's'} in ${inLayouts} layout${inLayouts === 1 ? '' : 's'}. Those copies are removed too.`
      : 'It isn’t on any layout.';
    const ok = await U.confirm(`Delete “${st.name}”?`, msg, 'Delete', true);
    if (!ok) return;
    for (const l of state.layouts) {
      const before = l.items.length;
      const kept = l.items.filter((it) => it.stickerId !== id);
      if (kept.length !== before) {
        l.items.length = 0;
        l.items.push(...kept);
        markLayoutDirty(l);
      }
    }
    if (st.rt && st.rt.url) URL.revokeObjectURL(st.rt.url);
    state.stickers.delete(id);
    await DB.remove('stickers', id);
    editor.past = [];
    editor.future = [];
    editor.select(null);
    renderLibrary();
    updateStats();
    updateUndo();
  }

  async function addSamples() {
    const btn = $('btnSamples');
    btn.disabled = true;
    try {
      try { await Promise.race([document.fonts.load('800 40px "Archivo"'), new Promise((r) => setTimeout(r, 1500))]); } catch (_) { /* offline */ }
      const samples = SL.Samples.generate();
      const records = [];
      for (const s of samples) {
        const blob = await U.canvasToBlob(s.canvas, 'image/png');
        records.push({
          name: s.name,
          widthMm: s.widthMm,
          heightMm: s.widthMm * (s.canvas.height / s.canvas.width),
          image: blob,
          source: blob,
          srcOffset: { x: 0, y: 0, w: s.canvas.width, h: s.canvas.height },
          sample: true
        });
      }
      await saveNewStickers(records, false);
    } finally {
      btn.disabled = false;
    }
  }

  /* ------------------------------------------------------------------ *
   * Layouts
   * ------------------------------------------------------------------ */

  function renderLayoutSelect() {
    const sel = $('layoutSelect');
    sel.replaceChildren(...state.layouts.map((l) => el('option', { value: l.id }, l.name)));
    sel.value = state.activeId;
  }

  function switchLayout(id) {
    flushSaves.flush();
    state.activeId = id;
    editor.setItems(activeLayout().items);
    renderLayoutSelect();
    renderLibrary();
    updateStats();
    updateUndo();
    DB.setKV('activeLayout', id);
  }

  function nextLayoutName() {
    let n = state.layouts.length + 1;
    while (state.layouts.some((l) => l.name === `Layout ${n}`)) n++;
    return `Layout ${n}`;
  }

  async function createLayout(name, items) {
    const layout = { id: U.uid(), name, items: items || [], created: Date.now(), updated: Date.now() };
    state.layouts.push(layout);
    await DB.put('layouts', layout);
    switchLayout(layout.id);
    return layout;
  }

  async function newLayout() {
    const name = await U.prompt('New layout', 'Name', nextLayoutName(), 'Create');
    if (name) await createLayout(name, []);
  }

  async function duplicateLayout() {
    const cur = activeLayout();
    const name = await U.prompt('Duplicate layout', 'Name', cur.name + ' copy', 'Duplicate');
    if (!name) return;
    const items = cur.items.map((it) => Object.assign({}, it, { uid: U.uid() }));
    await createLayout(name, items);
  }

  async function renameLayout() {
    const cur = activeLayout();
    const name = await U.prompt('Rename layout', 'Name', cur.name, 'Rename');
    if (!name) return;
    cur.name = name;
    markLayoutDirty(cur);
    renderLayoutSelect();
  }

  async function deleteLayout() {
    const cur = activeLayout();
    const ok = await U.confirm(`Delete “${cur.name}”?`, 'The stickers stay in your library. Only this arrangement is removed.', 'Delete layout', true);
    if (!ok) return;
    state.layouts = state.layouts.filter((l) => l.id !== cur.id);
    dirtyLayouts.delete(cur.id);
    await DB.remove('layouts', cur.id);
    if (!state.layouts.length) await createLayout('Layout 1', []);
    else switchLayout(state.layouts[0].id);
  }

  async function clearLayout() {
    const cur = activeLayout();
    if (!cur.items.length) return;
    editor.mutate(() => editor.items.splice(0));
    editor.select(null);
    U.toast('Lid cleared', { action: { label: 'Undo', run: () => editor.undo() } });
  }

  /* ------------------------------------------------------------------ *
   * Laptop settings
   * ------------------------------------------------------------------ */

  async function applyLaptopPhoto(blob) {
    state.laptopPhoto = blob || null;
    state.laptopPhotoImg = blob ? await U.loadImage(blob) : null;
  }

  function openLaptopSettings() {
    const saved = JSON.parse(JSON.stringify(state.laptop));
    const savedPhoto = state.laptopPhoto;
    const L = state.laptop;
    const apply = () => {
      editor.setLaptop(state.laptop, state.laptopPhotoImg);
      updateStats();
    };

    const preset = el('select', { class: 'field__input' },
      ...LAPTOP_PRESETS.map((p) => el('option', { value: p.id }, p.label)),
      el('option', { value: 'custom' }, 'Custom size'));
    preset.value = L.preset || 'custom';
    const w = el('input', { class: 'field__input field__input--num', type: 'number', min: 15, max: 60, step: 0.1, value: (L.widthMm / 10).toFixed(1) });
    const h = el('input', { class: 'field__input field__input--num', type: 'number', min: 10, max: 45, step: 0.1, value: (L.heightMm / 10).toFixed(1) });
    const radius = el('input', { class: 'range', type: 'range', min: 0, max: 30, step: 1, value: L.radiusMm });
    const radiusOut = el('output', { class: 'field__value' }, L.radiusMm + ' mm');

    preset.addEventListener('change', () => {
      const p = LAPTOP_PRESETS.find((x) => x.id === preset.value);
      L.preset = preset.value;
      if (p) {
        L.widthMm = p.w; L.heightMm = p.h; L.radiusMm = p.r;
        w.value = (p.w / 10).toFixed(1); h.value = (p.h / 10).toFixed(1);
        radius.value = p.r; radiusOut.textContent = p.r + ' mm';
      }
      apply();
    });
    const onSize = () => {
      const ww = parseFloat(w.value) * 10, hh = parseFloat(h.value) * 10;
      if (ww >= 100 && hh >= 80) {
        L.widthMm = ww; L.heightMm = hh;
        L.preset = 'custom';
        preset.value = 'custom';
        apply();
      }
    };
    w.addEventListener('input', onSize);
    h.addEventListener('input', onSize);
    radius.addEventListener('input', () => {
      L.radiusMm = +radius.value;
      radiusOut.textContent = L.radiusMm + ' mm';
      apply();
    });

    const custom = el('input', { type: 'color', class: 'swatch-input', value: L.color, 'aria-label': 'Custom colour' });
    const swatches = el('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Lid colour' },
      ...LID_COLORS.map((c) => el('button', {
        type: 'button', class: 'swatch', role: 'radio', title: c.name, 'aria-label': c.name,
        'aria-checked': String(c.value === L.color),
        style: { background: c.value },
        onclick: () => {
          L.color = c.value;
          custom.value = c.value;
          syncSwatches();
          apply();
        }
      })),
      custom);
    const syncSwatches = () => {
      for (const b of swatches.querySelectorAll('.swatch')) b.setAttribute('aria-checked', String(b.title && LID_COLORS.find((c) => c.name === b.title).value === L.color));
    };
    custom.addEventListener('input', () => { L.color = custom.value; syncSwatches(); apply(); });

    const logoShow = el('input', { type: 'checkbox', checked: L.logo.show });
    const logoSize = el('input', { class: 'range', type: 'range', min: 8, max: 70, step: 1, value: L.logo.diameterMm });
    const logoSizeOut = el('output', { class: 'field__value' }, L.logo.diameterMm + ' mm');
    const logoX = el('input', { class: 'range', type: 'range', min: 5, max: 95, step: 0.5, value: L.logo.x });
    const logoY = el('input', { class: 'range', type: 'range', min: 5, max: 95, step: 0.5, value: L.logo.y });
    const logoFields = el('div', { class: 'logo-fields' },
      el('label', { class: 'field' }, el('span', { class: 'field__label' }, 'Size', logoSizeOut), logoSize),
      el('label', { class: 'field' }, el('span', { class: 'field__label' }, 'Left to right'), logoX),
      el('label', { class: 'field' }, el('span', { class: 'field__label' }, 'Top to bottom'), logoY));
    logoFields.hidden = !L.logo.show;
    logoShow.addEventListener('change', () => { L.logo.show = logoShow.checked; logoFields.hidden = !logoShow.checked; apply(); });
    logoSize.addEventListener('input', () => { L.logo.diameterMm = +logoSize.value; logoSizeOut.textContent = logoSize.value + ' mm'; apply(); });
    logoX.addEventListener('input', () => { L.logo.x = +logoX.value; apply(); });
    logoY.addEventListener('input', () => { L.logo.y = +logoY.value; apply(); });

    const photoStatus = el('p', { class: 'dialog__text dialog__text--muted' });
    const removePhoto = el('button', { type: 'button', class: 'btn btn--small' }, 'Remove photo');
    const usePhoto = el('button', { type: 'button', class: 'btn btn--small' }, U.icon('camera'), 'Use a photo of my laptop');
    const syncPhoto = () => {
      removePhoto.hidden = !state.laptopPhoto;
      usePhoto.lastChild.textContent = state.laptopPhoto ? 'Replace photo' : 'Use a photo of my laptop';
      photoStatus.textContent = state.laptopPhoto
        ? 'The photo is used instead of the colour. Width and height still set the real size.'
        : 'A straightened photo of your closed lid makes the preview look like your actual laptop.';
    };
    usePhoto.addEventListener('click', async () => {
      const canvas = await SL.Scanner.open({ mode: 'laptop', lidAspect: L.widthMm / L.heightMm });
      if (!canvas) return;
      const blob = await U.canvasToBlob(canvas, 'image/jpeg', 0.9);
      await applyLaptopPhoto(blob);
      syncPhoto();
      apply();
    });
    removePhoto.addEventListener('click', async () => {
      await applyLaptopPhoto(null);
      syncPhoto();
      apply();
    });
    syncPhoto();

    const body = el('div', { class: 'dialog__body laptop-form' },
      el('section', { class: 'form-section' },
        el('h3', { class: 'form-section__title' }, 'Size'),
        el('label', { class: 'field' }, el('span', { class: 'field__label' }, 'Laptop'), preset),
        el('div', { class: 'size-row' },
          el('label', { class: 'field field--inline' }, el('span', { class: 'field__label' }, 'Width'), w, el('span', { class: 'field__unit' }, 'cm')),
          el('span', { class: 'size-row__x' }, '×'),
          el('label', { class: 'field field--inline' }, el('span', { class: 'field__label' }, 'Height'), h, el('span', { class: 'field__unit' }, 'cm'))),
        el('label', { class: 'field' }, el('span', { class: 'field__label' }, 'Corner roundness', radiusOut), radius),
        el('p', { class: 'dialog__text dialog__text--muted' }, 'Sizes are a starting point. For an exact match, measure your lid with a ruler. The bottom edge is the hinge, so you see the lid the way people across the table do.')),
      el('section', { class: 'form-section' },
        el('h3', { class: 'form-section__title' }, 'Look'),
        el('div', { class: 'field' }, el('span', { class: 'field__label' }, 'Colour'), swatches),
        el('label', { class: 'check' }, logoShow, el('span', {}, 'Mark the logo spot')),
        logoFields,
        el('div', { class: 'btn-row' }, usePhoto, removePhoto),
        photoStatus));

    U.dialog({
      title: 'Laptop',
      body,
      actions: [{ label: 'Cancel', value: null }, { label: 'Done', value: 'ok', primary: true }]
    }).then(async (res) => {
      if (res === 'ok') {
        await DB.setKV('laptop', state.laptop);
        if (state.laptopPhoto !== savedPhoto) await DB.setKV('laptopPhoto', state.laptopPhoto || null);
      } else {
        state.laptop = saved;
        if (state.laptopPhoto !== savedPhoto) await applyLaptopPhoto(savedPhoto);
        apply();
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Selection bar (bottom of the mat)
   * ------------------------------------------------------------------ */

  function buildSelectionBar() {
    const bar = $('selectionBar');
    const thumb = el('img', { class: 'selection__thumb', alt: '' });
    const name = el('span', { class: 'selection__name' });
    const size = el('span', { class: 'selection__size' });
    const rot = el('input', { class: 'field__input field__input--num selection__rot', type: 'number', step: 1, min: -180, max: 180, 'aria-label': 'Rotation in degrees' });
    rot.addEventListener('change', () => {
      const v = parseFloat(rot.value);
      if (!isNaN(v)) editor.setRotation(v);
    });
    const realSize = el('button', { class: 'btn btn--small', type: 'button', onclick: () => editor.resetScale() }, 'Real size');
    const btn = (icon, label, fn, cls) => el('button', { class: 'icon-btn' + (cls ? ' ' + cls : ''), type: 'button', 'aria-label': label, title: label, onclick: fn }, U.icon(icon));

    bar.append(
      el('div', { class: 'selection__info' }, thumb, el('div', { class: 'selection__text' }, name, size)),
      realSize,
      el('div', { class: 'selection__group', role: 'group', 'aria-label': 'Rotation' },
        btn('rotate-ccw', 'Rotate left 15° (Shift+R)', () => editor.rotateSelected(-15)),
        el('label', { class: 'selection__rotwrap' }, rot, el('span', { class: 'field__unit' }, '°')),
        btn('rotate-cw', 'Rotate right 15° (R)', () => editor.rotateSelected(15))),
      el('div', { class: 'selection__group', role: 'group', 'aria-label': 'Stacking' },
        btn('backward', 'Send backward ([)', () => editor.restack(-1)),
        btn('forward', 'Bring forward (])', () => editor.restack(1))),
      el('div', { class: 'selection__group', role: 'group', 'aria-label': 'Sticker' },
        btn('copy', 'Duplicate (Ctrl+D)', () => editor.duplicateSelected()),
        btn('trash', 'Remove from lid (Delete)', () => editor.removeSelected(), 'icon-btn--danger')));

    return (item) => {
      if (!item) {
        bar.hidden = true;
        return;
      }
      const st = state.stickers.get(item.stickerId);
      if (!st) {
        bar.hidden = true;
        return;
      }
      bar.hidden = false;
      if (thumb.getAttribute('src') !== st.rt.url) thumb.src = st.rt.url;
      name.textContent = st.name;
      const scaled = Math.abs(item.scale - 1) > 0.005;
      size.textContent = `${U.cm(st.widthMm * item.scale)} × ${U.cm(st.heightMm * item.scale)} cm` + (scaled ? ` (${Math.round(item.scale * 100)}% of real size)` : '');
      realSize.hidden = !scaled;
      if (document.activeElement !== rot) rot.value = String(Math.round(item.rot));
    };
  }

  /* ------------------------------------------------------------------ *
   * Stage bar: stats, undo, toggles, zoom
   * ------------------------------------------------------------------ */

  const updateStats = U.debounce(() => {
    const layout = activeLayout();
    if (!layout) return;
    const n = layout.items.filter((it) => state.stickers.has(it.stickerId)).length;
    if (!n) {
      $('stats').textContent = 'Nothing on the lid yet';
      return;
    }
    const pct = Math.round(editor.coverage() * 100);
    $('stats').textContent = `${n} sticker${n === 1 ? '' : 's'} on the lid, ${pct}% covered`;
  }, 150);

  function updateUndo() {
    $('btnUndo').disabled = !editor.past.length;
    $('btnRedo').disabled = !editor.future.length;
  }

  function updateZoom(z) {
    $('btnZoomFit').textContent = Math.round(z * 100) + '%';
  }

  /* ------------------------------------------------------------------ *
   * Image export and backups
   * ------------------------------------------------------------------ */

  async function exportImage() {
    const layout = activeLayout();
    const canvas = editor.exportCanvas(8);
    const blob = await U.canvasToBlob(canvas, 'image/png');
    U.download(blob, `stickers-${U.slug(layout.name)}.png`);
    U.toast('Image saved to your downloads');
  }

  async function exportBackup() {
    const stickers = [];
    for (const st of sortedStickers()) {
      const rec = storable(st);
      rec.image = await U.blobToDataURL(st.image);
      rec.source = st.source === st.image ? 'same' : await U.blobToDataURL(st.source);
      stickers.push(rec);
    }
    const data = {
      app: 'laptop-sticker-planner',
      version: 1,
      exported: new Date().toISOString(),
      laptop: state.laptop,
      laptopPhoto: state.laptopPhoto ? await U.blobToDataURL(state.laptopPhoto) : null,
      stickers,
      layouts: state.layouts,
      activeLayout: state.activeId
    };
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    U.download(blob, `sticker-planner-backup-${new Date().toISOString().slice(0, 10)}.json`);
    U.toast('Backup saved to your downloads');
  }

  function importBackup() {
    const input = el('input', { type: 'file', accept: 'application/json,.json' });
    input.addEventListener('change', async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (data.app !== 'laptop-sticker-planner') throw new Error('This file isn’t a Sticker Planner backup.');
        const ok = await U.confirm('Restore this backup?',
          `It has ${data.stickers.length} stickers and ${data.layouts.length} layouts. They are added to what you have; anything with the same ID is replaced.`,
          'Restore');
        if (!ok) return;
        savesPaused = true;
        for (const s of data.stickers) {
          const image = await U.dataURLToBlob(s.image);
          const source = s.source === 'same' ? image : await U.dataURLToBlob(s.source);
          await DB.put('stickers', Object.assign({}, s, { image, source }));
        }
        for (const l of data.layouts) await DB.put('layouts', l);
        // Open the layout that was showing when the backup was made.
        const open = data.layouts.find((l) => l.id === data.activeLayout) || data.layouts[0];
        if (open) await DB.setKV('activeLayout', open.id);
        if (data.laptop) await DB.setKV('laptop', data.laptop);
        if (data.laptopPhoto) await DB.setKV('laptopPhoto', await U.dataURLToBlob(data.laptopPhoto));
        location.reload();
      } catch (err) {
        savesPaused = false;
        U.toast(err.message || 'That backup couldn’t be read.', { error: true });
      }
    });
    input.click();
  }

  async function startOver() {
    const ok = await U.confirm('Delete everything?', 'All stickers, layouts and laptop settings are removed from this browser. Save a backup first if you might want them back.', 'Delete everything', true);
    if (!ok) return;
    savesPaused = true;
    await DB.clearAll();
    location.reload();
  }

  function showShortcuts() {
    const rows = [
      ['Click a library sticker', 'Put it on the lid'],
      ['Drag', 'Move a sticker (snaps to the centre lines, hold Alt to stop)'],
      ['Yellow handle', 'Rotate (hold Shift for 15° steps)'],
      ['Arrow keys', 'Nudge 1 mm (Shift: 1 cm)'],
      ['R / Shift+R', 'Rotate 15° right / left'],
      ['] / [', 'Bring forward / send backward'],
      ['Ctrl+D', 'Duplicate'],
      ['Delete', 'Remove from the lid'],
      ['Ctrl+Z / Ctrl+Shift+Z', 'Undo / redo'],
      ['P', 'Preview on or off'],
      ['Ctrl + scroll, or pinch', 'Zoom'],
      ['Drag empty mat, or scroll', 'Pan'],
      ['Double-click empty mat', 'Fit the lid to the window'],
      ['Ctrl+V', 'Scan a copied image']
    ];
    const table = el('dl', { class: 'shortcuts' }, ...rows.flatMap(([k, v]) => [el('dt', {}, k), el('dd', {}, v)]));
    U.dialog({ title: 'Keyboard and mouse', body: table, actions: [{ label: 'Close', value: 'ok', primary: true }] });
  }

  /* ------------------------------------------------------------------ *
   * Keyboard, paste and drop
   * ------------------------------------------------------------------ */

  function dialogOpen() {
    return !!document.querySelector('dialog[open]');
  }

  function onKeyDown(e) {
    if (dialogOpen() || U.isTyping()) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key;
    if (mod && k.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) editor.redo(); else editor.undo();
      return;
    }
    if (mod && k.toLowerCase() === 'y') { e.preventDefault(); editor.redo(); return; }
    if (mod && k.toLowerCase() === 'd') { e.preventDefault(); editor.duplicateSelected(); return; }
    if (mod) return;
    const sel = editor.selectedItem;
    const step = e.shiftKey ? 10 : 1;
    switch (k) {
      case 'Delete':
      case 'Backspace':
        if (sel) { e.preventDefault(); editor.removeSelected(); }
        break;
      case 'ArrowLeft': if (sel) { e.preventDefault(); editor.nudge(-step, 0); } break;
      case 'ArrowRight': if (sel) { e.preventDefault(); editor.nudge(step, 0); } break;
      case 'ArrowUp': if (sel) { e.preventDefault(); editor.nudge(0, -step); } break;
      case 'ArrowDown': if (sel) { e.preventDefault(); editor.nudge(0, step); } break;
      case 'r': case 'R': if (sel) editor.rotateSelected(e.shiftKey ? -15 : 15); break;
      case ']': editor.restack(1); break;
      case '[': editor.restack(-1); break;
      case 'Escape': editor.select(null); break;
      case 'p': case 'P':
        $('optPreview').checked = !$('optPreview').checked;
        $('optPreview').dispatchEvent(new Event('change'));
        break;
      case '+': case '=': editor.zoomBy(1.25); break;
      case '-': editor.zoomBy(0.8); break;
      case '0': editor.resetView(); break;
      default: break;
    }
  }

  function imageFiles(list) {
    return [...(list || [])].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
  }

  function wireGlobalDrop() {
    let depth = 0;
    const overlay = el('div', { class: 'drop-overlay', hidden: true }, el('p', {}, 'Drop photos to scan them'));
    document.body.append(overlay);
    const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e) || dialogOpen()) return;
      depth++;
      overlay.hidden = false;
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) overlay.hidden = true;
    });
    window.addEventListener('dragover', (e) => {
      if (hasFiles(e) && !dialogOpen()) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      depth = 0;
      overlay.hidden = true;
      if (!hasFiles(e) || dialogOpen()) return;
      e.preventDefault();
      const files = imageFiles(e.dataTransfer.files);
      if (files.length) openScanner(files);
      else U.toast('Only image files can be scanned.', { error: true });
    });
    window.addEventListener('paste', (e) => {
      if (dialogOpen() || U.isTyping()) return;
      const files = imageFiles([...e.clipboardData.items].filter((i) => i.kind === 'file').map((i) => i.getAsFile()));
      if (files.length) {
        e.preventDefault();
        openScanner(files);
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * Start-up
   * ------------------------------------------------------------------ */

  async function init() {
    await DB.open();
    $('storageBanner').hidden = DB.persistent;

    state.laptop = Object.assign({}, DEFAULT_LAPTOP, (await DB.getKV('laptop')) || {});
    state.laptop.logo = Object.assign({}, DEFAULT_LAPTOP.logo, state.laptop.logo || {});
    state.prefs = Object.assign(state.prefs, (await DB.getKV('prefs')) || {});
    const photo = await DB.getKV('laptopPhoto');
    if (photo) {
      try { await applyLaptopPhoto(photo); } catch (_) { state.laptopPhoto = null; }
    }

    const records = await DB.getAll('stickers');
    for (const rec of records) {
      try {
        await hydrate(rec);
        state.stickers.set(rec.id, rec);
      } catch (err) {
        console.warn('Skipping a sticker that could not be loaded', err);
      }
    }

    state.layouts = (await DB.getAll('layouts')).sort((a, b) => (a.created || 0) - (b.created || 0) || a.name.localeCompare(b.name, undefined, { numeric: true }));
    if (!state.layouts.length) {
      const first = { id: U.uid(), name: 'Layout 1', items: [], created: Date.now(), updated: Date.now() };
      state.layouts.push(first);
      await DB.put('layouts', first);
    }
    const savedActive = await DB.getKV('activeLayout');
    state.activeId = state.layouts.some((l) => l.id === savedActive) ? savedActive : state.layouts[0].id;

    const showSelection = buildSelectionBar();
    editor = new SL.Editor($('mat'), {
      getSticker: (id) => {
        const st = state.stickers.get(id);
        return st ? { widthMm: st.widthMm, heightMm: st.heightMm, small: st.rt.small, full: st.rt.full, hit: st.rt.hit } : null;
      },
      onSelect: (item) => showSelection(item),
      onChange: () => {
        markLayoutDirty();
        renderLibrary();
        updateStats();
        updateUndo();
      },
      onViewChange: updateZoom
    });
    editor.flags.shadows = state.prefs.shadows;
    editor.flags.lockSize = state.prefs.lockSize;
    editor.setLaptop(state.laptop, state.laptopPhotoImg);
    editor.setItems(activeLayout().items);
    // Make sure stickers drawn with the web font look right once it loads.
    if (document.fonts) document.fonts.ready.then(() => editor.requestRender());

    // Toolbar
    $('optShadows').checked = state.prefs.shadows;
    $('optLock').checked = state.prefs.lockSize;
    $('optShadows').addEventListener('change', (e) => { state.prefs.shadows = e.target.checked; editor.setFlag('shadows', e.target.checked); flushSaves(); });
    $('optLock').addEventListener('change', (e) => { state.prefs.lockSize = e.target.checked; editor.setFlag('lockSize', e.target.checked); flushSaves(); });
    $('optPreview').addEventListener('change', (e) => editor.setFlag('preview', e.target.checked));
    $('btnUndo').addEventListener('click', () => editor.undo());
    $('btnRedo').addEventListener('click', () => editor.redo());
    $('btnZoomIn').addEventListener('click', () => editor.zoomBy(1.25));
    $('btnZoomOut').addEventListener('click', () => editor.zoomBy(0.8));
    $('btnZoomFit').addEventListener('click', () => editor.resetView());

    // Header
    $('layoutSelect').addEventListener('change', (e) => switchLayout(e.target.value));
    $('btnNewLayout').addEventListener('click', newLayout);
    $('btnLayoutMenu').addEventListener('click', (e) => U.menu(e.currentTarget, [
      { label: 'Rename layout', onSelect: renameLayout },
      { label: 'Duplicate layout', onSelect: duplicateLayout },
      { label: 'Clear the lid', onSelect: clearLayout },
      'separator',
      { label: 'Delete layout', onSelect: deleteLayout, danger: true }
    ]));
    $('btnLaptop').addEventListener('click', openLaptopSettings);
    $('btnExport').addEventListener('click', exportImage);
    $('btnAppMenu').addEventListener('click', (e) => U.menu(e.currentTarget, [
      { label: 'Keyboard and mouse', onSelect: showShortcuts },
      'separator',
      { label: 'Save a backup file', onSelect: exportBackup },
      { label: 'Restore from a backup file', onSelect: importBackup },
      'separator',
      { label: 'Delete everything', onSelect: startOver, danger: true }
    ]));

    // Library
    $('btnScan').addEventListener('click', () => openScanner([]));
    $('btnSamples').addEventListener('click', addSamples);

    document.addEventListener('keydown', onKeyDown);
    wireGlobalDrop();

    renderLayoutSelect();
    renderLibrary();
    updateStats();
    updateUndo();
    document.body.classList.add('is-ready');

    // Handy for poking around in the browser console.
    window.SL.state = state;
    window.SL.editor = editor;
  }

  init().catch((err) => {
    console.error(err);
    document.body.prepend(el('div', { class: 'banner banner--error' }, 'Something went wrong while starting: ' + err.message));
  });
})();
