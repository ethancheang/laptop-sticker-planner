/*
 * scanner.js
 * ----------
 * The "Scan stickers" window. Four steps:
 *   1. Photo       – choose a photo or take one with the camera
 *   2. Straighten  – drag four corners around the sticker(s); this also
 *                    fixes photos taken at an angle
 *   3. Cut out     – remove the background automatically, then touch up
 *   4. Name & size – give each sticker a name and its real size
 *
 * The same window is reused for:
 *   - "laptop" mode: straighten a photo of your laptop lid (steps 1–2)
 *   - "recut" mode:  fix the cut-out of a sticker you already saved (steps 3–4)
 */
(function () {
  'use strict';
  const SL = (window.SL = window.SL || {});
  const U = SL.U;
  const Img = SL.Img;
  const el = U.el;

  const PHOTO_MAX = 2000;   // longest side we keep from a photo (pixels)
  const CUT_MAX = 1400;     // longest side used while cutting out
  const LAPTOP_MAX = 1800;  // longest side of a straightened laptop photo

  const PAPER = {
    a4: { w: 210, h: 297, label: 'A4 paper (21 × 29.7 cm)' },
    letter: { w: 215.9, h: 279.4, label: 'US Letter paper (21.6 × 27.9 cm)' },
    a5: { w: 148, h: 210, label: 'A5 paper (14.8 × 21 cm)' }
  };

  const DEFAULTS = { tol: 18, specks: 2, shrink: 1, feather: 1, brush: 26 };

  /* ------------------------------------------------------------------ *
   * A canvas that always fills its parent element.
   * ------------------------------------------------------------------ */
  class FitCanvas {
    constructor(host, onResize) {
      this.canvas = el('canvas', { class: 'fit-canvas' });
      host.append(this.canvas);
      this.ctx = this.canvas.getContext('2d');
      this.onResize = onResize;
      this.w = 0;
      this.h = 0;
      this.dpr = 1;
      this.ro = new ResizeObserver(() => this.resize());
      this.ro.observe(host);
    }
    resize() {
      const r = this.canvas.parentElement.getBoundingClientRect();
      this.dpr = window.devicePixelRatio || 1;
      this.w = Math.max(10, r.width);
      this.h = Math.max(10, r.height);
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      if (this.onResize) this.onResize();
    }
    /** Fit an image of iw × ih inside, with padding. */
    fit(iw, ih, pad) {
      pad = pad == null ? 24 : pad;
      const s = Math.min((this.w - pad * 2) / iw, (this.h - pad * 2) / ih);
      return { s, ox: (this.w - iw * s) / 2, oy: (this.h - ih * s) / 2 };
    }
    point(e) {
      const r = this.canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    destroy() {
      this.ro.disconnect();
    }
  }

  /* ------------------------------------------------------------------ *
   * The scanner window
   * ------------------------------------------------------------------ */
  class Scanner {
    /**
     * opts.mode:   'sticker' | 'laptop' | 'recut'
     * opts.files:  File[] to start with (optional)
     * opts.sticker: the saved sticker to re-cut (recut mode)
     * opts.lidAspect: width / height of the lid (laptop mode)
     * opts.hooks:  { saveStickers(records, place), saveRecut(id, record), suggestName(i), mmPerPxOf(sticker) }
     */
    constructor(opts) {
      this.opts = opts;
      this.mode = opts.mode;
      this.hooks = opts.hooks || {};
      this.queue = (opts.files || []).slice();
      this.queueTotal = this.queue.length;
      this.queueIndex = 0;
      this.step = this.mode === 'recut' ? 2 : 0;
      this.photo = null;      // canvas with the current photo
      this.quad = null;       // 4 corners in photo pixels
      this.measure = 'free';  // 'free' | paper key | 'custom'
      this.custom = { w: 10, h: 10 }; // cm
      this.straight = null;   // canvas after straightening
      this.mmPerPx = null;    // known scale (from paper size), if any
      this.cut = null;        // cut-out state
      this.pieces = null;     // results for step 4
      this.stream = null;     // camera stream
      this.views = {};
      this.done = null;
      this.build();
    }

    /** Show the window. Resolves when it closes (laptop mode: with a canvas). */
    open() {
      SL.activeScanner = this; // handy for poking around in the console
      document.body.append(this.dlg);
      this.dlg.showModal();
      this.render();
      if (this.mode === 'recut') this.startRecut();
      else if (this.queue.length) this.loadNextFromQueue();
      return new Promise((resolve) => { this.done = resolve; });
    }

    close(result) {
      if (SL.activeScanner === this) SL.activeScanner = null;
      this.stopCamera();
      for (const v of Object.values(this.views)) if (v && v.fc) v.fc.destroy();
      if (this.dlg.open) this.dlg.close();
      this.dlg.remove();
      if (this.done) this.done(result || null);
      this.done = null;
    }

    async requestClose() {
      const busy = (this.step >= 2 && this.mode !== 'laptop') || (this.step === 1 && this.photo);
      if (busy) {
        const ok = await U.confirm('Close the scanner?', 'The photo you are working on will not be saved.', 'Close', true);
        if (!ok) return;
      }
      this.close(null);
    }

    /* ---------------- Layout ---------------- */

    get stepNames() {
      if (this.mode === 'laptop') return ['Photo', 'Straighten'];
      return ['Photo', 'Straighten', 'Cut out', 'Name and size'];
    }

    build() {
      const title = this.mode === 'laptop' ? 'Photo of your laptop lid'
        : this.mode === 'recut' ? 'Fix the cut-out' : 'Scan stickers';
      this.dlg = el('dialog', { class: 'scanner', 'aria-label': title });
      this.dlg.addEventListener('cancel', (e) => {
        e.preventDefault();
        this.requestClose();
      });

      this.stepList = el('ol', { class: 'steps' });
      this.closeBtn = el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => this.requestClose() }, U.icon('close'));
      const head = el('header', { class: 'scanner__head' },
        el('h2', { class: 'scanner__title' }, title),
        this.stepList,
        this.closeBtn);

      this.body = el('div', { class: 'scanner__body' });
      this.queueNote = el('span', { class: 'scanner__note' });
      this.backBtn = el('button', { class: 'btn', onclick: () => this.back() }, 'Back');
      this.nextBtn = el('button', { class: 'btn btn--primary', onclick: () => this.next() }, 'Next');
      const foot = el('footer', { class: 'scanner__foot' }, this.queueNote, el('div', { class: 'spacer' }), this.backBtn, this.nextBtn);
      this.dlg.append(head, this.body, foot);

      // Files can be dropped onto the window on any step.
      this.dlg.addEventListener('dragover', (e) => {
        if ([...e.dataTransfer.types].includes('Files')) e.preventDefault();
      });
      this.dlg.addEventListener('drop', (e) => {
        const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
        if (!files.length) return;
        e.preventDefault();
        if (this.step <= 1) {
          this.queue = files.slice();
          this.queueTotal = files.length;
          this.queueIndex = 0;
          this.loadNextFromQueue();
        }
      });
    }

    render() {
      // Step indicator
      this.stepList.replaceChildren(...this.stepNames.map((name, i) => {
        const disabled = this.mode === 'recut' && i < 2;
        return el('li', {
          class: 'steps__item' + (i === this.step ? ' is-current' : '') + (i < this.step ? ' is-done' : '') + (disabled ? ' is-skipped' : ''),
          'aria-current': i === this.step ? 'step' : null
        }, el('span', { class: 'steps__num' }, String(i + 1)), el('span', { class: 'steps__name' }, name));
      }));

      // Body
      const view = this.viewFor(this.step);
      this.body.replaceChildren(view.root);
      if (view.fc) view.fc.resize();
      if (view.onShow) view.onShow();

      // Footer
      this.queueNote.textContent = this.queueTotal > 1 ? `Photo ${Math.min(this.queueIndex, this.queueTotal)} of ${this.queueTotal}` : '';
      this.backBtn.hidden = this.step === 0 || (this.mode === 'recut' && this.step === 2);
      this.nextBtn.hidden = this.step === 0;
      this.updateNext();
    }

    updateNext() {
      let label = 'Next';
      let enabled = true;
      if (this.step === 1) {
        label = this.mode === 'laptop' ? 'Use this photo' : 'Next';
      } else if (this.step === 2) {
        enabled = !!(this.cut && this.cut.pieceCount > 0);
      } else if (this.step === 3) {
        const n = this.pieces ? this.pieces.length : 0;
        label = this.mode === 'recut' ? 'Save changes' : n > 1 ? `Save ${n} stickers` : 'Save sticker';
      }
      this.nextBtn.textContent = label;
      this.nextBtn.disabled = !enabled;
    }

    viewFor(step) {
      if (!this.views[step]) {
        this.views[step] = [() => this.buildPhotoView(), () => this.buildCropView(), () => this.buildCutView(), () => this.buildDetailsView()][step]();
      }
      return this.views[step];
    }

    async back() {
      if (this.step === 1) {
        this.photo = null;
        this.step = 0;
      } else if (this.step === 2) {
        this.step = 1;
      } else if (this.step === 3) {
        this.step = 2;
      }
      this.render();
    }

    async next() {
      this.nextBtn.disabled = true;
      try {
        if (this.step === 1) {
          if (this.mode === 'laptop') {
            const canvas = this.straightenLaptop();
            this.close(canvas);
            return;
          }
          await this.busy('Finding the background…', () => {
            this.straighten();
            this.startCut();
          });
          this.step = 2;
        } else if (this.step === 2) {
          this.makePieces();
          this.step = 3;
        } else if (this.step === 3) {
          await this.save();
          return;
        }
        this.render();
      } catch (err) {
        console.error(err);
        U.toast(err.message || String(err), { error: true });
        this.updateNext();
      }
    }

    /** Show a short "working" overlay while something slow runs. */
    async busy(message, fn) {
      const overlay = el('div', { class: 'scanner__busy' }, el('span', { class: 'spinner' }), message);
      this.body.append(overlay);
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 20)));
      try {
        return await fn();
      } finally {
        overlay.remove();
      }
    }

    /* ================================================================ *
     * Step 1: Photo
     * ================================================================ */

    buildPhotoView() {
      const fileInput = el('input', {
        type: 'file', accept: 'image/*', multiple: this.mode !== 'laptop', hidden: true,
        onchange: () => {
          const files = [...fileInput.files];
          fileInput.value = '';
          if (!files.length) return;
          this.queue = files;
          this.queueTotal = files.length;
          this.queueIndex = 0;
          this.loadNextFromQueue();
        }
      });

      const video = el('video', { class: 'camera__video', playsinline: true, muted: true, autoplay: true });
      const camera = el('div', { class: 'camera', hidden: true },
        video,
        el('div', { class: 'camera__bar' },
          el('button', { class: 'btn', onclick: () => { this.stopCamera(); camera.hidden = true; drop.hidden = false; } }, 'Cancel'),
          el('button', { class: 'btn btn--primary', onclick: () => this.capture(video) }, 'Take photo')));

      const isLaptop = this.mode === 'laptop';
      const drop = el('div', { class: 'dropzone' },
        el('div', { class: 'dropzone__art', 'aria-hidden': 'true' }, U.icon(isLaptop ? 'laptop' : 'scan')),
        el('p', { class: 'dropzone__title' }, isLaptop ? 'Add a photo of your closed laptop' : 'Add photos of your stickers'),
        el('p', { class: 'dropzone__sub' }, isLaptop ? 'Drop it here, or' : 'Drop photos here (several at once is fine), or'),
        el('div', { class: 'dropzone__actions' },
          el('button', { class: 'btn btn--primary', onclick: () => fileInput.click() }, isLaptop ? 'Choose a photo' : 'Choose photos'),
          el('button', { class: 'btn', onclick: () => this.startCamera(video, camera, drop) }, U.icon('camera'), 'Use camera')),
        fileInput);

      const tips = isLaptop
        ? el('ul', { class: 'tips' },
          el('li', {}, 'Close the laptop and shoot the lid from straight above.'),
          el('li', {}, 'Get all four corners in the picture. You will line them up in the next step.'))
        : el('ul', { class: 'tips' },
          el('li', {}, 'Lay stickers flat on a plain surface that contrasts with them. White-bordered stickers show up best on a dark desk.'),
          el('li', {}, 'Shoot from straight above in even light, without flash glare.'),
          el('li', {}, 'Several stickers in one photo is fine. They are split up automatically.'),
          el('li', {}, 'For automatic sizes, put them on a sheet of A4 paper and include the whole sheet.'));

      const root = el('div', { class: 'step-photo' }, drop, camera, tips);
      return { root, onShow: () => { camera.hidden = true; drop.hidden = false; } };
    }

    async startCamera(video, camera, drop) {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        U.toast('This browser can’t use the camera here. Choose a photo instead.', { error: true });
        return;
      }
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false
        });
        video.srcObject = this.stream;
        drop.hidden = true;
        camera.hidden = false;
        await video.play().catch(() => {});
      } catch (err) {
        console.warn(err);
        const msg = err && err.name === 'NotAllowedError'
          ? 'Camera access was blocked. Allow it in the browser’s address bar, or choose a photo instead.'
          : 'No camera was found. Choose a photo instead.';
        U.toast(msg, { error: true });
      }
    }

    stopCamera() {
      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
      }
    }

    capture(video) {
      if (!video.videoWidth) return;
      const c = U.imageToCanvas(video, PHOTO_MAX);
      this.stopCamera();
      this.queue = [];
      this.queueTotal = 0;
      this.setPhoto(c);
    }

    async loadNextFromQueue() {
      const file = this.queue.shift();
      if (!file) return;
      this.queueIndex++;
      try {
        const img = await U.loadImage(file);
        this.setPhoto(U.imageToCanvas(img, PHOTO_MAX));
      } catch (err) {
        const heic = /\.(heic|heif)$/i.test(file.name) || /heic|heif/i.test(file.type);
        U.toast(heic
          ? `${file.name} is a HEIC photo, which this browser can’t open. Export it as JPEG, or set iPhone Settings › Camera › Formats to Most Compatible.`
          : `${file.name} couldn’t be opened as an image.`, { error: true, duration: 6000 });
        if (this.queue.length) this.loadNextFromQueue();
        else {
          this.step = 0;
          this.render();
        }
      }
    }

    setPhoto(canvas) {
      this.photo = canvas;
      this.photoData = null;
      const w = canvas.width, h = canvas.height;
      if (this.mode === 'laptop') {
        const m = Math.min(w, h) * 0.08;
        this.quad = [[m, m], [w - m, m], [w - m, h - m], [m, h - m]];
      } else {
        this.quad = [[0, 0], [w, 0], [w, h], [0, h]];
      }
      this.step = 1;
      this.render();
    }

    /* ================================================================ *
     * Step 2: Straighten (four corners)
     * ================================================================ */

    buildCropView() {
      const wrap = el('div', { class: 'canvas-wrap canvas-wrap--dark' });
      const view = { root: null, fc: null };
      view.fc = new FitCanvas(wrap, () => this.drawCrop());
      this.cropFC = view.fc;
      const c = view.fc.canvas;
      c.addEventListener('pointerdown', (e) => this.cropDown(e));
      c.addEventListener('pointermove', (e) => this.cropMove(e));
      c.addEventListener('pointerup', () => this.cropUp());
      c.addEventListener('pointercancel', () => this.cropUp());

      const isLaptop = this.mode === 'laptop';
      const hint = el('p', { class: 'side__text' }, isLaptop
        ? 'Drag the four yellow corners onto the corners of your laptop lid. The photo is straightened to match the lid size in your laptop settings.'
        : 'Drag the yellow corners around the sticker or stickers you want. If the photo was taken at an angle, put the corners on the corners of the paper or card underneath to straighten it.');

      const side = el('aside', { class: 'side' }, hint);

      if (!isLaptop) {
        const customW = el('input', { class: 'field__input field__input--num', type: 'number', min: 1, max: 200, step: 0.1, value: this.custom.w });
        const customH = el('input', { class: 'field__input field__input--num', type: 'number', min: 1, max: 200, step: 0.1, value: this.custom.h });
        const customRow = el('div', { class: 'size-row', hidden: true },
          el('label', { class: 'field field--inline' }, el('span', { class: 'field__label' }, 'Width'), customW, el('span', { class: 'field__unit' }, 'cm')),
          el('span', { class: 'size-row__x' }, '×'),
          el('label', { class: 'field field--inline' }, el('span', { class: 'field__label' }, 'Height'), customH, el('span', { class: 'field__unit' }, 'cm')));
        const sel = el('select', { class: 'field__input' },
          el('option', { value: 'free' }, 'Just the area I want'),
          ...Object.entries(PAPER).map(([k, p]) => el('option', { value: k }, p.label)),
          el('option', { value: 'custom' }, 'Something else I measured'));
        sel.value = this.measure;
        sel.addEventListener('change', () => {
          this.measure = sel.value;
          customRow.hidden = sel.value !== 'custom';
        });
        const syncCustom = () => {
          this.custom.w = parseFloat(customW.value) || this.custom.w;
          this.custom.h = parseFloat(customH.value) || this.custom.h;
        };
        customW.addEventListener('input', syncCustom);
        customH.addEventListener('input', syncCustom);
        side.append(
          el('label', { class: 'field' }, el('span', { class: 'field__label' }, 'The corners are on'), sel),
          customRow,
          el('p', { class: 'side__text side__text--muted' }, 'Pick a paper size when the corners sit on a sheet. Sticker sizes are then measured for you.'));
      }

      side.append(el('div', { class: 'btn-row' },
        el('button', { class: 'btn btn--small', onclick: () => this.rotatePhoto(-1) }, U.icon('rotate-ccw'), 'Rotate left'),
        el('button', { class: 'btn btn--small', onclick: () => this.rotatePhoto(1) }, U.icon('rotate-cw'), 'Rotate right'),
        isLaptop ? null : el('button', { class: 'btn btn--small', onclick: () => this.resetQuad() }, 'Whole photo')));

      view.root = el('div', { class: 'step-split' }, wrap, side);
      view.onShow = () => this.drawCrop();
      return view;
    }

    resetQuad() {
      const w = this.photo.width, h = this.photo.height;
      this.quad = [[0, 0], [w, 0], [w, h], [0, h]];
      this.drawCrop();
    }

    rotatePhoto(dir) {
      const src = this.photo;
      const c = U.canvas(src.height, src.width);
      const g = c.getContext('2d');
      g.translate(c.width / 2, c.height / 2);
      g.rotate((dir * Math.PI) / 2);
      g.drawImage(src, -src.width / 2, -src.height / 2);
      // Rotate the corner points along with the photo.
      const W = src.width, H = src.height;
      this.quad = this.quad.map(([x, y]) => (dir > 0 ? [H - y, x] : [y, W - x]));
      this.photo = c;
      this.photoData = null;
      this.drawCrop();
    }

    cropView() {
      return this.cropFC.fit(this.photo.width, this.photo.height, 28);
    }

    drawCrop() {
      const fc = this.cropFC;
      if (!fc || !this.photo || !fc.w) return;
      const ctx = fc.ctx;
      ctx.clearRect(0, 0, fc.w, fc.h);
      const v = this.cropView();
      const pw = this.photo.width * v.s, ph = this.photo.height * v.s;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(this.photo, v.ox, v.oy, pw, ph);
      const pts = this.quad.map(([x, y]) => [v.ox + x * v.s, v.oy + y * v.s]);

      // Darken everything outside the selection.
      ctx.save();
      ctx.beginPath();
      ctx.rect(v.ox, v.oy, pw, ph);
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
      ctx.fillStyle = 'rgba(12, 18, 22, 0.55)';
      ctx.fill('evenodd');
      ctx.restore();

      ctx.beginPath();
      pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
      ctx.closePath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffc93c';
      ctx.stroke();

      pts.forEach((p, i) => {
        ctx.beginPath();
        ctx.arc(p[0], p[1], this.cropDrag && this.cropDrag.corner === i ? 11 : 9, 0, Math.PI * 2);
        ctx.fillStyle = '#ffc93c';
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#1a2026';
        ctx.stroke();
      });

      // Magnifier while dragging a corner, so you can place it precisely.
      const d = this.cropDrag;
      if (d && d.corner != null) {
        const [qx, qy] = this.quad[d.corner];
        const p = pts[d.corner];
        const R = 64, Z = 3;
        let lx = p[0] - 90, ly = p[1] - 90;
        if (lx < R + 6) lx = p[0] + 90;
        if (ly < R + 6) ly = p[1] + 90;
        ctx.save();
        ctx.beginPath();
        ctx.arc(lx, ly, R, 0, Math.PI * 2);
        ctx.fillStyle = '#000';
        ctx.fill();
        ctx.clip();
        const src = R / (v.s * Z);
        ctx.drawImage(this.photo, qx - src, qy - src, src * 2, src * 2, lx - R, ly - R, R * 2, R * 2);
        ctx.strokeStyle = '#ffc93c';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(lx - 12, ly); ctx.lineTo(lx + 12, ly);
        ctx.moveTo(lx, ly - 12); ctx.lineTo(lx, ly + 12);
        ctx.stroke();
        ctx.restore();
        ctx.beginPath();
        ctx.arc(lx, ly, R, 0, Math.PI * 2);
        ctx.lineWidth = 3;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
      }
    }

    cropDown(e) {
      const p = this.cropFC.point(e);
      const v = this.cropView();
      const pts = this.quad.map(([x, y]) => [v.ox + x * v.s, v.oy + y * v.s]);
      const reach = e.pointerType === 'touch' ? 30 : 20;
      let best = -1, bestD = Infinity;
      pts.forEach((q, i) => {
        const d = Math.hypot(q[0] - p.x, q[1] - p.y);
        if (d < bestD) { bestD = d; best = i; }
      });
      this.cropFC.canvas.setPointerCapture(e.pointerId);
      if (bestD <= reach) {
        this.cropDrag = { corner: best, dx: pts[best][0] - p.x, dy: pts[best][1] - p.y };
      } else if (pointInPolygon([p.x, p.y], pts)) {
        this.cropDrag = { move: true, start: [p.x, p.y], quad: this.quad.map((q) => q.slice()) };
      }
      this.drawCrop();
    }

    cropMove(e) {
      const p = this.cropFC.point(e);
      const v = this.cropView();
      const d = this.cropDrag;
      const W = this.photo.width, H = this.photo.height;
      if (!d) {
        const pts = this.quad.map(([x, y]) => [v.ox + x * v.s, v.oy + y * v.s]);
        const near = pts.some((q) => Math.hypot(q[0] - p.x, q[1] - p.y) <= 20);
        this.cropFC.canvas.style.cursor = near ? 'crosshair' : pointInPolygon([p.x, p.y], pts) ? 'move' : 'default';
        return;
      }
      if (d.corner != null) {
        const x = U.clamp((p.x + d.dx - v.ox) / v.s, 0, W);
        const y = U.clamp((p.y + d.dy - v.oy) / v.s, 0, H);
        this.quad[d.corner] = [x, y];
      } else if (d.move) {
        let dx = (p.x - d.start[0]) / v.s;
        let dy = (p.y - d.start[1]) / v.s;
        const xs = d.quad.map((q) => q[0]);
        const ys = d.quad.map((q) => q[1]);
        dx = U.clamp(dx, -Math.min(...xs), W - Math.max(...xs));
        dy = U.clamp(dy, -Math.min(...ys), H - Math.max(...ys));
        this.quad = d.quad.map(([x, y]) => [x + dx, y + dy]);
      }
      this.drawCrop();
    }

    cropUp() {
      this.cropDrag = null;
      this.drawCrop();
    }

    /** Put the corners in order: top-left, top-right, bottom-right, bottom-left. */
    orderedQuad() {
      const q = this.quad.map((p) => p.slice());
      const cx = q.reduce((s, p) => s + p[0], 0) / 4;
      const cy = q.reduce((s, p) => s + p[1], 0) / 4;
      q.sort((a, b) => Math.atan2(a[1] - cy, a[0] - cx) - Math.atan2(b[1] - cy, b[0] - cx));
      let start = 0;
      for (let i = 1; i < 4; i++) if (q[i][0] + q[i][1] < q[start][0] + q[start][1]) start = i;
      return [0, 1, 2, 3].map((i) => q[(start + i) % 4]);
    }

    getPhotoData() {
      if (!this.photoData) {
        this.photoData = this.photo.getContext('2d').getImageData(0, 0, this.photo.width, this.photo.height);
      }
      return this.photoData;
    }

    isWholePhoto(quad) {
      const W = this.photo.width, H = this.photo.height;
      const target = [[0, 0], [W, 0], [W, H], [0, H]];
      return quad.every((p, i) => Math.abs(p[0] - target[i][0]) < 1 && Math.abs(p[1] - target[i][1]) < 1);
    }

    warpTo(quad, outW, outH) {
      outW = Math.max(8, Math.round(outW));
      outH = Math.max(8, Math.round(outH));
      const c = U.canvas(outW, outH);
      if (this.isWholePhoto(quad)) {
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(this.photo, 0, 0, outW, outH);
        return c;
      }
      const src = this.getPhotoData();
      const px = Img.warpPerspective(src.data, src.width, src.height, quad, outW, outH);
      c.getContext('2d').putImageData(new ImageData(px, outW, outH), 0, 0);
      return c;
    }

    straighten() {
      const quad = this.orderedQuad();
      const size = Img.quadSize(quad);
      let w = size.w, h = size.h;
      this.mmPerPx = null;
      if (this.measure !== 'free') {
        const paper = this.measure === 'custom'
          ? { w: this.custom.w * 10, h: this.custom.h * 10 }
          : PAPER[this.measure];
        // Match the paper's orientation to how it lies in the photo.
        const landscape = w > h;
        const pw = landscape ? Math.max(paper.w, paper.h) : Math.min(paper.w, paper.h);
        const ph = landscape ? Math.min(paper.w, paper.h) : Math.max(paper.w, paper.h);
        const longest = Math.max(w, h);
        if (pw >= ph) { w = longest; h = longest * (ph / pw); } else { h = longest; w = longest * (pw / ph); }
        this.mmPerPx = { w: pw, h: ph };
      }
      const scale = Math.min(1, CUT_MAX / Math.max(w, h));
      w *= scale;
      h *= scale;
      this.straight = this.warpTo(quad, w, h);
      if (this.mmPerPx) this.mmPerPx = this.mmPerPx.w / this.straight.width;
    }

    straightenLaptop() {
      const quad = this.orderedQuad();
      const aspect = this.opts.lidAspect || 1.4;
      const w = aspect >= 1 ? LAPTOP_MAX : LAPTOP_MAX * aspect;
      const h = aspect >= 1 ? LAPTOP_MAX / aspect : LAPTOP_MAX;
      return this.warpTo(quad, w, h);
    }

    /* ================================================================ *
     * Step 3: Cut out
     * ================================================================ */

    /** Prepare the cut-out state for this.straight. `baseMask` is optional. */
    initCut(baseMask) {
      const w = this.straight.width, h = this.straight.height, n = w * h;
      const rgba = this.straight.getContext('2d').getImageData(0, 0, w, h).data;
      const lab = Img.toLab(rgba, n);
      const colors = Img.borderColors(lab, w, h, 3);
      const nearBg = Img.bgDistance(lab, n, colors);
      const prev = this.cut;
      const keepSettings = prev && prev.w === w && prev.h === h ? prev : null;
      this.cut = {
        w, h, n, rgba, lab, nearBg,
        tol: keepSettings ? keepSettings.tol : DEFAULTS.tol,
        specks: keepSettings ? keepSettings.specks : DEFAULTS.specks,
        shrink: baseMask ? 0 : DEFAULTS.shrink,
        feather: DEFAULTS.feather,
        brush: DEFAULTS.brush,
        tool: 'wand-remove',
        showRemoved: false,
        separate: true,
        base: null,
        edits: new Int8Array(n),
        history: [],
        future: [],
        alpha: null,
        hardFinal: null,
        comps: null,
        pieceCount: 0,
        fromSaved: !!baseMask
      };
      this.cut.base = baseMask || Img.autoForeground(lab, w, h, nearBg, this.cut.tol);
      this.cut.display = U.canvas(w, h);
      this.processCut(false);
    }

    startCut() {
      this.initCut(null);
      this.syncCutControls();
    }

    async startRecut() {
      const st = this.opts.sticker;
      try {
        const srcImg = await U.loadImage(st.source);
        const cutImg = await U.loadImage(st.image);
        this.straight = U.imageToCanvas(srcImg, 4000);
        const w = this.straight.width, h = this.straight.height;
        // Put the saved cut-out back where it came from, to recover its mask.
        const tmp = U.canvas(w, h);
        const o = st.srcOffset || { x: 0, y: 0, w: cutImg.width, h: cutImg.height };
        tmp.getContext('2d').drawImage(cutImg, o.x, o.y, o.w, o.h);
        const a = tmp.getContext('2d').getImageData(0, 0, w, h).data;
        const base = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) base[i] = a[i * 4 + 3] > 127 ? 1 : 0;
        this.mmPerPx = this.hooks.mmPerPxOf ? this.hooks.mmPerPxOf(st, cutImg.width) : null;
        this.initCut(base);
        this.cut.separate = false;
        this.render();
      } catch (err) {
        console.error(err);
        U.toast('This sticker’s original photo couldn’t be loaded.', { error: true });
        this.close(null);
      }
    }

    /** Recompute the final cut-out from the automatic mask plus touch-ups. */
    processCut(quick) {
      const c = this.cut;
      const n = c.n;
      // 1. Automatic mask, overridden by touch-ups.
      const hard = new Uint8Array(n);
      for (let i = 0; i < n; i++) hard[i] = c.edits[i] > 0 ? 1 : c.edits[i] < 0 ? 0 : c.base[i];
      // 2. Trim the edge a little to lose the halo of background colour.
      let mask = c.shrink > 0 ? Img.erode(hard, c.w, c.h, c.shrink) : hard;
      if (!quick) {
        // 3. Find separate pieces and drop specks (unless you painted them back on purpose).
        const minArea = Math.max(24, Math.round((c.specks * n) / 2000));
        const comps = Img.labelComponents(mask, c.w, c.h);
        const keep = new Uint8Array(comps.count + 1);
        for (let k = 1; k <= comps.count; k++) keep[k] = comps.areas[k] >= minArea ? 1 : 0;
        for (let i = 0; i < n; i++) if (c.edits[i] > 0 && comps.labels[i]) keep[comps.labels[i]] = 1;
        const cleaned = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          const k = comps.labels[i];
          if (k && keep[k]) cleaned[i] = 1;
          else if (k) comps.labels[i] = 0;
        }
        mask = cleaned;
        c.comps = comps;
        c.pieceIds = [];
        for (let k = 1; k <= comps.count; k++) if (keep[k]) c.pieceIds.push(k);
        c.pieceCount = c.pieceIds.length;
      }
      c.alpha = Img.feather(mask, c.w, c.h, c.feather);
      this.updateDisplay();
      if (!quick) this.updateCutInfo();
    }

    updateDisplay() {
      const c = this.cut;
      const out = new ImageData(c.w, c.h);
      const d = out.data;
      const src = c.rgba;
      const a = c.alpha;
      if (c.showRemoved) {
        for (let i = 0; i < c.n; i++) {
          const k = i * 4;
          const t = (255 - a[i]) / 255 * 0.62;
          d[k] = src[k] * (1 - t) + 235 * t;
          d[k + 1] = src[k + 1] * (1 - t) + 40 * t;
          d[k + 2] = src[k + 2] * (1 - t) + 60 * t;
          d[k + 3] = 255;
        }
      } else {
        for (let i = 0; i < c.n; i++) {
          const k = i * 4;
          d[k] = src[k];
          d[k + 1] = src[k + 1];
          d[k + 2] = src[k + 2];
          d[k + 3] = a[i];
        }
      }
      c.display.getContext('2d').putImageData(out, 0, 0);
      this.drawCut();
    }

    buildCutView() {
      const wrap = el('div', { class: 'canvas-wrap canvas-wrap--checker' });
      const view = { root: null, fc: null };
      view.fc = new FitCanvas(wrap, () => this.drawCut());
      this.cutFC = view.fc;
      const cv = view.fc.canvas;
      cv.addEventListener('pointerdown', (e) => this.cutDown(e));
      cv.addEventListener('pointermove', (e) => this.cutMove(e));
      cv.addEventListener('pointerup', (e) => this.cutUp(e));
      cv.addEventListener('pointercancel', (e) => this.cutUp(e));
      cv.addEventListener('pointerleave', () => { this.cutPointer = null; this.drawCut(); });

      const ctl = {};
      const slider = (key, label, min, max, step, fmt) => {
        const out = el('output', { class: 'field__value' });
        const input = el('input', { type: 'range', min, max, step, class: 'range' });
        const wrapEl = el('label', { class: 'field' }, el('span', { class: 'field__label' }, label, out), input);
        ctl[key] = { input, out, fmt, wrap: wrapEl };
        return wrapEl;
      };

      const reprocess = U.rafThrottle(() => this.processCut(false));

      const tolField = slider('tol', 'Background tolerance', 2, 60, 1, (v) => String(v));
      ctl.tol.input.addEventListener('input', () => {
        const c = this.cut;
        c.tol = +ctl.tol.input.value;
        ctl.tol.out.textContent = ctl.tol.fmt(c.tol);
        c.base = Img.autoForeground(c.lab, c.w, c.h, c.nearBg, c.tol);
        if (c.fromSaved && c.shrink === 0) {
          c.shrink = DEFAULTS.shrink;
          c.fromSaved = false;
          this.syncCutControls();
        }
        reprocess();
      });

      const toolBtn = (tool, label, iconName) => el('button', {
        class: 'seg__btn', type: 'button', 'data-tool': tool, 'aria-pressed': 'false',
        onclick: () => { this.cut.tool = tool; this.syncCutControls(); }
      }, U.icon(iconName), label);
      const tools = el('div', { class: 'seg', role: 'group', 'aria-label': 'Touch-up tool' },
        toolBtn('wand-remove', 'Remove area', 'wand'),
        toolBtn('wand-keep', 'Keep area', 'wand'),
        toolBtn('brush-erase', 'Erase', 'eraser'),
        toolBtn('brush-restore', 'Restore', 'brush'));
      ctl.tools = tools;

      const brushField = slider('brush', 'Brush size', 4, 120, 1, (v) => v + ' px');
      ctl.brush.input.addEventListener('input', () => {
        this.cut.brush = +ctl.brush.input.value;
        ctl.brush.out.textContent = ctl.brush.fmt(this.cut.brush);
      });

      ctl.undo = el('button', { class: 'btn btn--small', onclick: () => this.cutUndo() }, U.icon('undo'), 'Undo');
      ctl.redo = el('button', { class: 'btn btn--small', onclick: () => this.cutRedo() }, U.icon('redo'), 'Redo');
      ctl.clear = el('button', {
        class: 'btn btn--small', onclick: () => {
          this.pushCutHistory();
          this.cut.edits.fill(0);
          this.processCut(false);
          this.syncCutControls();
        }
      }, 'Clear touch-ups');

      const shrinkField = slider('shrink', 'Trim edge', 0, 4, 1, (v) => (+v === 0 ? 'off' : v + ' px'));
      ctl.shrink.input.addEventListener('input', () => {
        this.cut.shrink = +ctl.shrink.input.value;
        ctl.shrink.out.textContent = ctl.shrink.fmt(this.cut.shrink);
        reprocess();
      });
      const featherField = slider('feather', 'Soften edge', 0, 3, 1, (v) => (+v === 0 ? 'off' : v + ' px'));
      ctl.feather.input.addEventListener('input', () => {
        this.cut.feather = +ctl.feather.input.value;
        ctl.feather.out.textContent = ctl.feather.fmt(this.cut.feather);
        reprocess();
      });
      const specksField = slider('specks', 'Ignore specks', 0, 20, 1, (v) => (+v === 0 ? 'off' : +v <= 3 ? 'small' : +v <= 10 ? 'medium' : 'large'));
      ctl.specks.input.addEventListener('input', () => {
        this.cut.specks = +ctl.specks.input.value;
        ctl.specks.out.textContent = ctl.specks.fmt(this.cut.specks);
        reprocess();
      });

      ctl.showRemoved = el('input', {
        type: 'checkbox', onchange: () => {
          this.cut.showRemoved = ctl.showRemoved.checked;
          this.updateDisplay();
        }
      });

      ctl.info = el('div', { class: 'cut-info', 'aria-live': 'polite' });

      const side = el('aside', { class: 'side side--scroll' },
        ctl.info,
        el('section', { class: 'side__group' },
          el('h3', { class: 'side__heading' }, 'Background'),
          tolField,
          el('p', { class: 'side__text side__text--muted' }, 'Raise it if bits of desk are left behind. Lower it if parts of the sticker disappear.')),
        el('section', { class: 'side__group' },
          el('h3', { class: 'side__heading' }, 'Touch up'),
          tools,
          brushField,
          el('p', { class: 'side__text side__text--muted', 'data-tip': '' }),
          el('div', { class: 'btn-row' }, ctl.undo, ctl.redo, ctl.clear)),
        el('section', { class: 'side__group' },
          el('h3', { class: 'side__heading' }, 'Edges'),
          shrinkField, featherField, specksField,
          el('label', { class: 'check' }, ctl.showRemoved, el('span', {}, 'Show removed parts in red'))));
      this.cutCtl = ctl;
      this.cutTip = side.querySelector('[data-tip]');

      view.root = el('div', { class: 'step-split' }, wrap, side);
      view.onShow = () => { this.syncCutControls(); this.drawCut(); };
      return view;
    }

    syncCutControls() {
      const c = this.cut, ctl = this.cutCtl;
      if (!c || !ctl) return;
      for (const key of ['tol', 'brush', 'shrink', 'feather', 'specks']) {
        ctl[key].input.value = c[key];
        ctl[key].out.textContent = ctl[key].fmt(c[key]);
      }
      ctl.showRemoved.checked = c.showRemoved;
      for (const b of ctl.tools.querySelectorAll('.seg__btn')) b.setAttribute('aria-pressed', String(b.dataset.tool === c.tool));
      const isBrush = c.tool.startsWith('brush');
      ctl.brush.wrap.hidden = !isBrush;
      this.cutTip.textContent = {
        'wand-remove': 'Click a leftover patch of background to remove everything connected to it in a similar colour.',
        'wand-keep': 'Click a part of the sticker that went missing to bring back everything connected to it in a similar colour.',
        'brush-erase': 'Paint over anything that should go.',
        'brush-restore': 'Paint over parts of the sticker that should stay.'
      }[c.tool];
      ctl.undo.disabled = !c.history.length;
      ctl.redo.disabled = !c.future.length;
      ctl.clear.disabled = !c.edits.some((v) => v !== 0);
      this.updateCutInfo();
    }

    updateCutInfo() {
      const c = this.cut, ctl = this.cutCtl;
      if (!c || !ctl) return;
      ctl.info.replaceChildren();
      if (c.pieceCount === 0) {
        ctl.info.append(el('p', { class: 'cut-info__warn' }, 'Nothing is left. Lower the background tolerance, or use Restore to paint the sticker back.'));
      } else if (c.pieceCount > 1 && this.mode !== 'recut') {
        const radio = (value, label) => el('label', { class: 'check' },
          el('input', {
            type: 'radio', name: 'separate', checked: c.separate === value,
            onchange: () => { c.separate = value; this.updateNext(); }
          }),
          el('span', {}, label));
        ctl.info.append(
          el('p', { class: 'cut-info__title' }, `${c.pieceCount} separate stickers found`),
          radio(true, `Save as ${c.pieceCount} stickers`),
          radio(false, 'Save as one sticker'));
      } else {
        ctl.info.append(el('p', { class: 'cut-info__title' }, 'One sticker found'));
      }
      this.updateNext();
    }

    cutView() {
      return this.cutFC.fit(this.cut.w, this.cut.h, 20);
    }

    drawCut() {
      const fc = this.cutFC;
      const c = this.cut;
      if (!fc || !c || !fc.w) return;
      const ctx = fc.ctx;
      ctx.clearRect(0, 0, fc.w, fc.h);
      const v = this.cutView();
      const w = c.w * v.s, h = c.h * v.s;
      if (!c.showRemoved) {
        ctx.save();
        ctx.fillStyle = U.checkerPattern(ctx, 10, '#ffffff', '#dfe4ea');
        ctx.fillRect(v.ox, v.oy, w, h);
        ctx.restore();
      }
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(c.display, v.ox, v.oy, w, h);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(26, 32, 38, 0.25)';
      ctx.strokeRect(v.ox + 0.5, v.oy + 0.5, w - 1, h - 1);

      const p = this.cutPointer;
      if (p && c.tool.startsWith('brush')) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, c.brush / 2, 0, Math.PI * 2);
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ffffff';
        ctx.stroke();
        ctx.lineWidth = 1;
        ctx.strokeStyle = '#1a2026';
        ctx.stroke();
      }
    }

    pushCutHistory() {
      const c = this.cut;
      c.history.push(c.edits.slice());
      if (c.history.length > 20) c.history.shift();
      c.future = [];
    }

    cutUndo() {
      const c = this.cut;
      if (!c.history.length) return;
      c.future.push(c.edits);
      c.edits = c.history.pop();
      this.processCut(false);
      this.syncCutControls();
    }

    cutRedo() {
      const c = this.cut;
      if (!c.future.length) return;
      c.history.push(c.edits);
      c.edits = c.future.pop();
      this.processCut(false);
      this.syncCutControls();
    }

    toImage(p) {
      const v = this.cutView();
      return { x: (p.x - v.ox) / v.s, y: (p.y - v.oy) / v.s, s: v.s };
    }

    cutDown(e) {
      const c = this.cut;
      if (!c) return;
      const p = this.cutFC.point(e);
      const ip = this.toImage(p);
      if (ip.x < 0 || ip.y < 0 || ip.x >= c.w || ip.y >= c.h) {
        if (!c.tool.startsWith('brush')) return;
      }
      this.cutFC.canvas.setPointerCapture(e.pointerId);
      if (c.tool.startsWith('wand')) {
        this.pushCutHistory();
        const region = Img.floodRegion(c.lab, c.w, c.h, ip.x, ip.y, c.tol);
        const val = c.tool === 'wand-keep' ? 1 : -1;
        for (let i = 0; i < region.length; i++) c.edits[region[i]] = val;
        this.processCut(false);
        this.syncCutControls();
        return;
      }
      this.pushCutHistory();
      this.brushStroke = { last: ip, val: c.tool === 'brush-restore' ? 1 : -1 };
      this.paint(ip, ip);
      this.quickProcess();
    }

    cutMove(e) {
      const p = this.cutFC.point(e);
      this.cutPointer = p;
      const c = this.cut;
      if (!c) return;
      this.cutFC.canvas.style.cursor = c.tool.startsWith('brush') ? 'none' : 'crosshair';
      if (this.brushStroke) {
        const ip = this.toImage(p);
        this.paint(this.brushStroke.last, ip);
        this.brushStroke.last = ip;
        this.quickProcess();
      } else {
        this.drawCut();
      }
    }

    cutUp() {
      if (this.brushStroke) {
        this.brushStroke = null;
        this.processCut(false);
        this.syncCutControls();
      }
    }

    quickProcess() {
      if (!this._quick) this._quick = U.rafThrottle(() => this.processCut(true));
      this._quick();
    }

    /** Paint a line of brush dabs from a to b (image coordinates). */
    paint(a, b) {
      const c = this.cut;
      const r = c.brush / 2 / a.s;
      const dist = Math.hypot(b.x - a.x, b.y - a.y);
      const steps = Math.max(1, Math.ceil(dist / Math.max(1, r / 2)));
      const val = this.brushStroke.val;
      const r2 = r * r;
      for (let s = 0; s <= steps; s++) {
        const cx = a.x + ((b.x - a.x) * s) / steps;
        const cy = a.y + ((b.y - a.y) * s) / steps;
        const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(c.w - 1, Math.ceil(cx + r));
        const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(c.h - 1, Math.ceil(cy + r));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            if ((x - cx) * (x - cx) + (y - cy) * (y - cy) <= r2) c.edits[y * c.w + x] = val;
          }
        }
      }
    }

    /* ================================================================ *
     * Step 4: Name and size
     * ================================================================ */

    /** Cut the final stickers out of the straightened photo. */
    makePieces() {
      const c = this.cut;
      const w = c.w, h = c.h;
      const pieces = [];
      const separate = c.separate && c.pieceCount > 1 && this.mode !== 'recut';
      let groups;
      if (separate) {
        const grown = Img.dilateLabels(c.comps.labels, w, h, c.feather + 1);
        groups = c.pieceIds.map((k) => ({ test: (i) => grown[i] === k }));
      } else {
        groups = [{ test: () => true }];
      }
      for (const g of groups) {
        const alpha = new Uint8ClampedArray(c.n);
        for (let i = 0; i < c.n; i++) alpha[i] = g.test(i) ? c.alpha[i] : 0;
        const bounds = Img.alphaBounds(alpha, w, h, 0);
        if (!bounds) continue;
        const box = bounds; // tight crop, so the measured size matches the visible sticker
        const rgba = new Uint8ClampedArray(box.w * box.h * 4);
        for (let y = 0; y < box.h; y++) {
          for (let x = 0; x < box.w; x++) {
            const si = (box.y + y) * w + (box.x + x);
            const di = (y * box.w + x) * 4;
            rgba[di] = c.rgba[si * 4];
            rgba[di + 1] = c.rgba[si * 4 + 1];
            rgba[di + 2] = c.rgba[si * 4 + 2];
            rgba[di + 3] = alpha[si];
          }
        }
        const canvas = U.canvas(box.w, box.h);
        canvas.getContext('2d').putImageData(new ImageData(rgba, box.w, box.h), 0, 0);
        // Keep some of the original photo around each sticker so it can be re-cut later.
        const srcBox = Img.padBox(box, Math.round(Math.max(box.w, box.h) * 0.08) + 8, w, h);
        const srcCanvas = U.canvas(srcBox.w, srcBox.h);
        srcCanvas.getContext('2d').drawImage(this.straight, srcBox.x, srcBox.y, srcBox.w, srcBox.h, 0, 0, srcBox.w, srcBox.h);
        pieces.push({
          canvas, srcCanvas,
          srcOffset: { x: box.x - srcBox.x, y: box.y - srcBox.y, w: box.w, h: box.h },
          pxW: box.w, pxH: box.h,
          name: '', widthMm: 0, heightMm: 0
        });
      }
      // Sizes: measured from paper, from the old sticker, or a sensible guess.
      let mmPerPx = this.mmPerPx;
      this.sizeSource = mmPerPx ? (this.mode === 'recut' ? 'kept' : 'measured') : 'guessed';
      if (!mmPerPx) {
        const longest = Math.max(...pieces.map((p) => Math.max(p.pxW, p.pxH)));
        mmPerPx = 70 / longest;
      }
      pieces.forEach((p, i) => {
        p.widthMm = p.pxW * mmPerPx;
        p.heightMm = p.pxH * mmPerPx;
        p.name = this.mode === 'recut' ? this.opts.sticker.name : (this.hooks.suggestName ? this.hooks.suggestName(i) : `Sticker ${i + 1}`);
      });
      this.pieces = pieces;
      this.proportional = true;
      this.place = this.place == null ? true : this.place;
      if (this.views[3]) this.views[3].fill();
    }

    buildDetailsView() {
      const list = el('ul', { class: 'pieces' });
      const intro = el('p', { class: 'side__text' });
      const propCheck = el('input', { type: 'checkbox', checked: true, onchange: () => { this.proportional = propCheck.checked; } });
      const propRow = el('label', { class: 'check' }, propCheck, el('span', {}, 'Keep sizes in proportion (they were photographed together)'));
      const placeCheck = el('input', { type: 'checkbox', checked: true, onchange: () => { this.place = placeCheck.checked; } });
      const placeRow = el('label', { class: 'check' }, placeCheck, el('span', {}, 'Put on the laptop after saving'));

      const view = {
        root: el('div', { class: 'step-details' },
          intro,
          propRow,
          list,
          el('div', { class: 'details__foot' },
            placeRow,
            el('p', { class: 'side__text side__text--muted' }, 'Need something to compare with? A bank card is 8.6 × 5.4 cm.'))),
        fill: () => {
          const pieces = this.pieces || [];
          const many = pieces.length > 1;
          intro.textContent = this.sizeSource === 'measured'
            ? 'Sizes were measured from the paper. Check them against a ruler if you like.'
            : this.sizeSource === 'kept'
              ? 'The size stays the same unless you change it.'
              : 'Measure each sticker with a ruler and type its real size. One side is enough, the other follows.';
          propRow.hidden = !many;
          propCheck.checked = this.proportional;
          placeRow.hidden = this.mode === 'recut';
          placeCheck.checked = this.place;
          list.replaceChildren(...pieces.map((p, i) => this.pieceRow(p, i, pieces)));
        }
      };
      view.onShow = () => view.fill();
      return view;
    }

    pieceRow(p, i, pieces) {
      const thumb = U.canvas(120, 120);
      const g = thumb.getContext('2d');
      g.fillStyle = U.checkerPattern(g, 8, '#ffffff', '#e6eaef');
      g.fillRect(0, 0, 120, 120);
      const s = Math.min(104 / p.pxW, 104 / p.pxH);
      g.imageSmoothingQuality = 'high';
      g.drawImage(p.canvas, (120 - p.pxW * s) / 2, (120 - p.pxH * s) / 2, p.pxW * s, p.pxH * s);
      thumb.className = 'pieces__thumb';

      const name = el('input', { class: 'field__input', type: 'text', value: p.name, maxlength: 60, 'aria-label': 'Name' });
      name.addEventListener('input', () => { p.name = name.value; });
      const wIn = el('input', { class: 'field__input field__input--num', type: 'number', min: 0.5, max: 100, step: 0.1, value: (p.widthMm / 10).toFixed(1), 'data-w': i });
      const hIn = el('input', { class: 'field__input field__input--num', type: 'number', min: 0.5, max: 100, step: 0.1, value: (p.heightMm / 10).toFixed(1), 'data-h': i });

      const refresh = () => {
        const rows = this.body.querySelectorAll('.pieces__row');
        pieces.forEach((q, k) => {
          const row = rows[k];
          if (!row) return;
          const wi = row.querySelector('[data-w]');
          const hi = row.querySelector('[data-h]');
          if (document.activeElement !== wi) wi.value = (q.widthMm / 10).toFixed(1);
          if (document.activeElement !== hi) hi.value = (q.heightMm / 10).toFixed(1);
        });
      };
      const setSize = (mm, axis) => {
        if (!(mm > 0)) return;
        const mmPerPx = axis === 'w' ? mm / p.pxW : mm / p.pxH;
        const targets = this.proportional ? pieces : [p];
        for (const q of targets) {
          q.widthMm = q.pxW * mmPerPx;
          q.heightMm = q.pxH * mmPerPx;
        }
        refresh();
      };
      wIn.addEventListener('input', () => setSize(parseFloat(wIn.value) * 10, 'w'));
      hIn.addEventListener('input', () => setSize(parseFloat(hIn.value) * 10, 'h'));

      return el('li', { class: 'pieces__row' },
        thumb,
        el('div', { class: 'pieces__fields' },
          el('label', { class: 'field' }, el('span', { class: 'field__label' }, 'Name'), name),
          el('div', { class: 'size-row' },
            el('label', { class: 'field field--inline' }, el('span', { class: 'field__label' }, 'Width'), wIn, el('span', { class: 'field__unit' }, 'cm')),
            el('span', { class: 'size-row__x' }, '×'),
            el('label', { class: 'field field--inline' }, el('span', { class: 'field__label' }, 'Height'), hIn, el('span', { class: 'field__unit' }, 'cm')))));
    }

    async save() {
      const records = [];
      for (const [i, p] of this.pieces.entries()) {
        records.push({
          name: (p.name || '').trim() || `Sticker ${i + 1}`,
          widthMm: Math.max(3, p.widthMm),
          heightMm: Math.max(3, p.heightMm),
          image: await U.canvasToBlob(p.canvas, 'image/png'),
          source: await U.canvasToBlob(p.srcCanvas, 'image/jpeg', 0.9),
          srcOffset: p.srcOffset
        });
      }
      if (this.mode === 'recut') {
        await this.hooks.saveRecut(this.opts.sticker.id, records[0]);
        this.close(true);
        return;
      }
      await this.hooks.saveStickers(records, this.place);
      if (this.queue.length) {
        // On to the next photo.
        this.cut = null;
        this.pieces = null;
        if (this.views[2] && this.views[2].fc) this.views[2].fc.destroy();
        this.views[2] = null;
        this.views[3] = null;
        this.cutFC = null;
        this.cutCtl = null;
        this.step = 0;
        this.render();
        this.loadNextFromQueue();
      } else {
        this.close(true);
      }
    }
  }

  function pointInPolygon(p, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  SL.Scanner = {
    open(opts) {
      return new Scanner(opts).open();
    }
  };
})();
