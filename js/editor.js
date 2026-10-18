/*
 * editor.js
 * ---------
 * The laptop lid on the cutting mat: drawing, selecting, moving,
 * rotating and resizing stickers, plus undo/redo.
 *
 * Coordinates: everything is stored in millimetres measured from the
 * top-left corner of the lid. The "view" converts millimetres to screen
 * pixels: screenX = view.ox + x * view.ppm (ppm = pixels per millimetre).
 *
 * A placed sticker ("item") looks like:
 *   { uid, stickerId, x, y, rot, scale }
 *   x, y  = centre of the sticker in mm
 *   rot   = rotation in degrees (clockwise)
 *   scale = 1 means the sticker's real measured size
 */
(function () {
  'use strict';
  const SL = (window.SL = window.SL || {});
  const U = SL.U;

  const COLORS = {
    mat: '#1f5c4d',
    matLine: 'rgba(226, 238, 196, 0.12)',
    matLineMajor: 'rgba(226, 238, 196, 0.26)',
    matText: 'rgba(226, 238, 196, 0.62)',
    accent: '#ffc93c',
    ink: '#1a2026'
  };
  const HANDLE_GAP = 30; // px between sticker top and the rotate handle
  const TAU = Math.PI * 2;

  class Editor {
    constructor(canvas, hooks) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.hooks = hooks; // { getSticker, onChange, onSelect, onDropSticker }
      this.items = [];
      this.laptop = null;
      this.photo = null; // straightened photo of the lid, or null
      this.flags = { shadows: true, lockSize: true, preview: false };
      this.selected = null;
      this.drag = null;
      this.hover = null;
      this.guides = null;
      this.past = [];
      this.future = [];
      this.zoom = 1;
      this.pan = { x: 0, y: 0 };
      this.cssW = 0;
      this.cssH = 0;
      this.dpr = 1;
      this.bottomReserve = 84; // keep the lid clear of the selection bar
      this.requestRender = U.rafThrottle(() => this.render());

      const ro = new ResizeObserver(() => this.resize());
      ro.observe(canvas.parentElement);

      canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e));
      canvas.addEventListener('pointermove', (e) => this.onPointerMove(e));
      canvas.addEventListener('pointerup', (e) => this.onPointerUp(e));
      canvas.addEventListener('pointercancel', (e) => this.onPointerUp(e));
      canvas.addEventListener('pointerleave', () => {
        if (!this.drag && this.hover) {
          this.hover = null;
          this.requestRender();
        }
      });
      canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
      canvas.addEventListener('dblclick', (e) => {
        const p = this.eventPoint(e);
        if (!this.hitItem(p.wx, p.wy)) this.resetView();
      });

      // Drag a sticker from the library onto the mat.
      canvas.addEventListener('dragover', (e) => {
        if ([...e.dataTransfer.types].includes('text/x-sticker-id')) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      });
      canvas.addEventListener('drop', (e) => {
        const id = e.dataTransfer.getData('text/x-sticker-id');
        if (!id) return;
        e.preventDefault();
        const p = this.eventPoint(e);
        this.addSticker(id, p.wx, p.wy);
      });
    }

    /* ------------------------------------------------------------ *
     * Setup
     * ------------------------------------------------------------ */

    setLaptop(laptop, photo) {
      this.laptop = laptop;
      this.photo = photo || null;
      this.resize();
    }

    /** Point the editor at a layout's item list (edited in place). */
    setItems(items) {
      this.items = items;
      this.past = [];
      this.future = [];
      this.select(null);
      this.requestRender();
    }

    setFlag(name, value) {
      this.flags[name] = value;
      if (name === 'preview' && value) this.hover = null;
      this.requestRender();
    }

    resize() {
      const host = this.canvas.parentElement;
      const r = host.getBoundingClientRect();
      this.dpr = window.devicePixelRatio || 1;
      this.cssW = Math.max(50, r.width);
      this.cssH = Math.max(50, r.height);
      this.canvas.width = Math.round(this.cssW * this.dpr);
      this.canvas.height = Math.round(this.cssH * this.dpr);
      this.render();
    }

    /** Fit the lid into the canvas, then apply zoom and pan. */
    get view() {
      const L = this.laptop;
      const marginX = Math.max(48, this.cssW * 0.07);
      const top = 64;
      const bottom = this.bottomReserve + 30;
      const availW = Math.max(40, this.cssW - marginX * 2);
      const availH = Math.max(40, this.cssH - top - bottom);
      const fit = Math.min(availW / L.widthMm, availH / L.heightMm);
      const ppm = fit * this.zoom;
      const cx = this.cssW / 2 + this.pan.x;
      const cy = top + availH / 2 + this.pan.y;
      return { ppm, ox: cx - (L.widthMm * ppm) / 2, oy: cy - (L.heightMm * ppm) / 2, fit, cx0: this.cssW / 2, cy0: top + availH / 2 };
    }

    resetView() {
      this.zoom = 1;
      this.pan = { x: 0, y: 0 };
      this.requestRender();
      if (this.hooks.onViewChange) this.hooks.onViewChange(this.zoom);
    }

    zoomBy(factor, sx, sy) {
      const v = this.view;
      if (sx == null) { sx = this.cssW / 2; sy = v.cy0; }
      const newZoom = U.clamp(this.zoom * factor, 0.5, 6);
      const wx = (sx - v.ox) / v.ppm;
      const wy = (sy - v.oy) / v.ppm;
      const ppm2 = v.fit * newZoom;
      const ox2 = sx - wx * ppm2;
      const oy2 = sy - wy * ppm2;
      this.zoom = newZoom;
      this.pan.x = ox2 + (this.laptop.widthMm * ppm2) / 2 - v.cx0;
      this.pan.y = oy2 + (this.laptop.heightMm * ppm2) / 2 - v.cy0;
      this.requestRender();
      if (this.hooks.onViewChange) this.hooks.onViewChange(this.zoom);
    }

    onWheel(e) {
      e.preventDefault();
      const p = this.eventPoint(e);
      if (e.ctrlKey || e.metaKey) {
        // Trackpad pinch or Ctrl + scroll wheel: zoom around the cursor.
        this.zoomBy(Math.exp(-e.deltaY * 0.01), p.sx, p.sy);
      } else {
        this.pan.x -= e.deltaX;
        this.pan.y -= e.deltaY;
        this.requestRender();
      }
    }

    /* ------------------------------------------------------------ *
     * Geometry helpers
     * ------------------------------------------------------------ */

    eventPoint(e) {
      const r = this.canvas.getBoundingClientRect();
      const sx = e.clientX - r.left;
      const sy = e.clientY - r.top;
      const v = this.view;
      return { sx, sy, wx: (sx - v.ox) / v.ppm, wy: (sy - v.oy) / v.ppm };
    }

    itemSize(it) {
      const st = this.hooks.getSticker(it.stickerId);
      if (!st) return null;
      return { w: st.widthMm * it.scale, h: st.heightMm * it.scale, st };
    }

    /** Topmost sticker under a point (ignores transparent corners). */
    hitItem(wx, wy) {
      for (let i = this.items.length - 1; i >= 0; i--) {
        const it = this.items[i];
        const s = this.itemSize(it);
        if (!s) continue;
        const a = (-it.rot * Math.PI) / 180;
        const dx = wx - it.x;
        const dy = wy - it.y;
        const lx = dx * Math.cos(a) - dy * Math.sin(a);
        const ly = dx * Math.sin(a) + dy * Math.cos(a);
        if (Math.abs(lx) > s.w / 2 || Math.abs(ly) > s.h / 2) continue;
        const hit = s.st.hit;
        if (hit) {
          const hx = Math.floor(((lx + s.w / 2) / s.w) * hit.w);
          const hy = Math.floor(((ly + s.h / 2) / s.h) * hit.h);
          // Check a small neighbourhood so thin edges are still easy to grab.
          let solid = false;
          for (let oy = -1; oy <= 1 && !solid; oy++) {
            for (let ox = -1; ox <= 1 && !solid; ox++) {
              const x = U.clamp(hx + ox, 0, hit.w - 1);
              const y = U.clamp(hy + oy, 0, hit.h - 1);
              if (hit.data[y * hit.w + x] > 40) solid = true;
            }
          }
          if (!solid) continue;
        }
        return it;
      }
      return null;
    }

    /** Screen positions of the selected sticker's handles. */
    handles(it) {
      const s = this.itemSize(it);
      if (!s) return null;
      const v = this.view;
      const cx = v.ox + it.x * v.ppm;
      const cy = v.oy + it.y * v.ppm;
      const hw = (s.w * v.ppm) / 2;
      const hh = (s.h * v.ppm) / 2;
      const a = (it.rot * Math.PI) / 180;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      const pt = (lx, ly) => ({ x: cx + lx * cos - ly * sin, y: cy + lx * sin + ly * cos });
      return {
        center: { x: cx, y: cy },
        corners: [pt(-hw, -hh), pt(hw, -hh), pt(hw, hh), pt(-hw, hh)],
        rotate: pt(0, -hh - HANDLE_GAP),
        topMid: pt(0, -hh),
        hw, hh
      };
    }

    /* ------------------------------------------------------------ *
     * Selection and editing
     * ------------------------------------------------------------ */

    get selectedItem() {
      return this.items.find((it) => it.uid === this.selected) || null;
    }

    select(uid) {
      this.selected = uid;
      if (this.hooks.onSelect) this.hooks.onSelect(this.selectedItem);
      this.requestRender();
    }

    beginChange() {
      this._before = JSON.stringify(this.items);
    }

    endChange() {
      if (this._before == null) return;
      const before = this._before;
      this._before = null;
      if (JSON.stringify(this.items) === before) return;
      this.past.push(before);
      if (this.past.length > 120) this.past.shift();
      this.future = [];
      if (this.hooks.onChange) this.hooks.onChange();
    }

    /** Wrap an edit so it can be undone. */
    mutate(fn) {
      this.beginChange();
      fn();
      this.endChange();
      if (this.hooks.onSelect) this.hooks.onSelect(this.selectedItem);
      this.requestRender();
    }

    replaceItems(list) {
      this.items.length = 0;
      for (const it of list) this.items.push(it);
      if (!this.selectedItem) this.selected = null;
      if (this.hooks.onSelect) this.hooks.onSelect(this.selectedItem);
      if (this.hooks.onChange) this.hooks.onChange();
      this.requestRender();
    }

    undo() {
      if (!this.past.length) return;
      this.future.push(JSON.stringify(this.items));
      this.replaceItems(JSON.parse(this.past.pop()));
    }

    redo() {
      if (!this.future.length) return;
      this.past.push(JSON.stringify(this.items));
      this.replaceItems(JSON.parse(this.future.pop()));
    }

    /**
     * Find a spot on the lid where a w × h sticker overlaps the others as
     * little as possible, preferring spots near the middle.
     * `extra` lists stickers that are about to be added as well.
     */
    findFreeSpot(w, h, extra) {
      const L = this.laptop;
      const others = [];
      for (const it of this.items.concat(extra || [])) {
        const s = this.itemSize(it);
        if (s) others.push({ x: it.x, y: it.y, r: Math.max(s.w, s.h) / 2 });
      }
      const r = Math.max(w, h) / 2;
      const cx = L.widthMm / 2, cy = L.heightMm / 2;
      const margin = 4;
      const x0 = Math.min(cx, w / 2 + margin), x1 = Math.max(cx, L.widthMm - w / 2 - margin);
      const y0 = Math.min(cy, h / 2 + margin), y1 = Math.max(cy, L.heightMm - h / 2 - margin);
      const step = 4;
      let best = { x: cx, y: cy, score: Infinity };
      for (let y = y0; y <= y1 + 0.01; y += step) {
        for (let x = x0; x <= x1 + 0.01; x += step) {
          let overlap = 0;
          for (const o of others) {
            const d = r + o.r - Math.hypot(x - o.x, y - o.y);
            if (d > 0) overlap += d * d;
          }
          // Small pull towards the centre breaks ties between empty spots.
          const score = overlap * 10 + Math.hypot((x - cx) / L.widthMm, (y - cy) / L.heightMm);
          if (score < best.score) best = { x, y, score };
        }
      }
      return best;
    }

    addSticker(stickerId, x, y) {
      if (x == null) {
        const st = this.hooks.getSticker(stickerId);
        const spot = st ? this.findFreeSpot(st.widthMm, st.heightMm) : { x: this.laptop.widthMm / 2, y: this.laptop.heightMm / 2 };
        x = spot.x;
        y = spot.y;
      }
      const item = { uid: U.uid(), stickerId, x, y, rot: 0, scale: 1 };
      this.mutate(() => this.items.push(item));
      this.select(item.uid);
      return item;
    }

    /** Add several stickers at once (one undo step), each in a free spot. */
    addMany(stickerIds) {
      const added = [];
      for (const id of stickerIds) {
        const st = this.hooks.getSticker(id);
        if (!st) continue;
        const spot = this.findFreeSpot(st.widthMm, st.heightMm, added);
        added.push({ uid: U.uid(), stickerId: id, x: spot.x, y: spot.y, rot: 0, scale: 1 });
      }
      if (!added.length) return;
      this.mutate(() => this.items.push(...added));
      this.select(added[added.length - 1].uid);
    }

    updateSelected(fn) {
      const it = this.selectedItem;
      if (!it) return;
      this.mutate(() => fn(it));
    }

    removeSelected() {
      const it = this.selectedItem;
      if (!it) return;
      this.mutate(() => this.items.splice(this.items.indexOf(it), 1));
      this.select(null);
    }

    duplicateSelected() {
      const it = this.selectedItem;
      if (!it) return;
      const copy = Object.assign({}, it, { uid: U.uid(), x: it.x + 8, y: it.y + 8 });
      this.mutate(() => this.items.splice(this.items.indexOf(it) + 1, 0, copy));
      this.select(copy.uid);
    }

    rotateSelected(delta) {
      this.updateSelected((it) => { it.rot = normAngle(it.rot + delta); });
    }

    setRotation(deg) {
      this.updateSelected((it) => { it.rot = normAngle(deg); });
    }

    resetScale() {
      this.updateSelected((it) => { it.scale = 1; });
    }

    nudge(dx, dy) {
      this.updateSelected((it) => { it.x += dx; it.y += dy; });
    }

    /** Move the selected sticker up (+1) or down (-1) in the stack; ±Infinity = to top/bottom. */
    restack(dir) {
      const it = this.selectedItem;
      if (!it) return;
      const i = this.items.indexOf(it);
      let j = dir === Infinity ? this.items.length - 1 : dir === -Infinity ? 0 : i + dir;
      j = U.clamp(j, 0, this.items.length - 1);
      if (i === j) return;
      this.mutate(() => {
        this.items.splice(i, 1);
        this.items.splice(j, 0, it);
      });
    }

    /* ------------------------------------------------------------ *
     * Pointer interaction
     * ------------------------------------------------------------ */

    onPointerDown(e) {
      if (e.button !== 0 && e.pointerType === 'mouse') return;
      const p = this.eventPoint(e);
      this.canvas.setPointerCapture(e.pointerId);
      const touchPad = e.pointerType === 'touch' ? 20 : 12;

      const sel = this.selectedItem;
      if (sel && !this.flags.preview) {
        const h = this.handles(sel);
        if (h && Math.hypot(p.sx - h.rotate.x, p.sy - h.rotate.y) <= touchPad) {
          this.beginChange();
          this.drag = {
            type: 'rotate',
            item: sel,
            startAngle: Math.atan2(p.sy - h.center.y, p.sx - h.center.x),
            startRot: sel.rot
          };
          this.updateCursor(p);
          return;
        }
        if (h && !this.flags.lockSize) {
          for (const c of h.corners) {
            if (Math.hypot(p.sx - c.x, p.sy - c.y) <= touchPad) {
              this.beginChange();
              this.drag = {
                type: 'scale',
                item: sel,
                startDist: Math.max(4, Math.hypot(p.sx - h.center.x, p.sy - h.center.y)),
                startScale: sel.scale
              };
              return;
            }
          }
        }
      }

      const hit = this.hitItem(p.wx, p.wy);
      if (hit) {
        if (this.selected !== hit.uid) this.select(hit.uid);
        this.beginChange();
        this.drag = { type: 'move', item: hit, dx: hit.x - p.wx, dy: hit.y - p.wy, moved: false };
        this.canvas.style.cursor = 'grabbing';
      } else {
        this.select(null);
        // Dragging empty mat pans the view.
        this.drag = { type: 'pan', sx: p.sx, sy: p.sy, panX: this.pan.x, panY: this.pan.y };
        this.canvas.style.cursor = 'grabbing';
      }
    }

    onPointerMove(e) {
      const p = this.eventPoint(e);
      const d = this.drag;
      if (!d) {
        this.updateCursor(p);
        return;
      }
      const v = this.view;
      if (d.type === 'move') {
        let x = p.wx + d.dx;
        let y = p.wy + d.dy;
        this.guides = null;
        if (!e.altKey) {
          // Snap to the centre lines of the lid.
          const tol = 5 / v.ppm;
          const L = this.laptop;
          const g = {};
          if (Math.abs(x - L.widthMm / 2) < tol) { x = L.widthMm / 2; g.x = true; }
          if (Math.abs(y - L.heightMm / 2) < tol) { y = L.heightMm / 2; g.y = true; }
          if (g.x || g.y) this.guides = g;
        }
        d.item.x = x;
        d.item.y = y;
        d.moved = true;
      } else if (d.type === 'rotate') {
        const h = this.handles(d.item);
        const ang = Math.atan2(p.sy - h.center.y, p.sx - h.center.x);
        let deg = d.startRot + ((ang - d.startAngle) * 180) / Math.PI;
        if (e.shiftKey) deg = Math.round(deg / 15) * 15;
        else {
          const nearest = Math.round(deg / 90) * 90;
          if (Math.abs(deg - nearest) < 3) deg = nearest; // gentle snap to straight
        }
        d.item.rot = normAngle(deg);
      } else if (d.type === 'scale') {
        const h = this.handles(d.item);
        const dist = Math.hypot(p.sx - h.center.x, p.sy - h.center.y);
        let s = (d.startScale * dist) / d.startDist;
        if (Math.abs(s - 1) < 0.04) s = 1; // snap back to real size
        d.item.scale = U.clamp(s, 0.2, 5);
      } else if (d.type === 'pan') {
        this.pan.x = d.panX + (p.sx - d.sx);
        this.pan.y = d.panY + (p.sy - d.sy);
      }
      if (d.type !== 'pan' && this.hooks.onSelect) this.hooks.onSelect(d.item, true);
      this.requestRender();
    }

    onPointerUp(e) {
      const d = this.drag;
      if (!d) return;
      this.drag = null;
      this.guides = null;
      if (d.type !== 'pan') this.endChange();
      if (this.hooks.onSelect) this.hooks.onSelect(this.selectedItem);
      this.updateCursor(this.eventPoint(e));
      this.requestRender();
    }

    updateCursor(p) {
      let cursor = 'grab';
      let hover = null;
      const sel = this.selectedItem;
      if (sel && !this.flags.preview) {
        const h = this.handles(sel);
        if (h && Math.hypot(p.sx - h.rotate.x, p.sy - h.rotate.y) <= 12) cursor = 'alias';
        else if (h && !this.flags.lockSize && h.corners.some((c) => Math.hypot(p.sx - c.x, p.sy - c.y) <= 12)) cursor = 'nwse-resize';
      }
      if (cursor === 'grab') {
        hover = this.hitItem(p.wx, p.wy);
        cursor = hover ? 'move' : 'grab';
      }
      this.canvas.style.cursor = cursor;
      const uid = hover ? hover.uid : null;
      if (uid !== this.hover) {
        this.hover = uid;
        this.requestRender();
      }
    }

    /* ------------------------------------------------------------ *
     * Drawing
     * ------------------------------------------------------------ */

    lidPath(ctx, v) {
      const L = this.laptop;
      const x = v.ox, y = v.oy;
      const w = L.widthMm * v.ppm, h = L.heightMm * v.ppm;
      const r = Math.min(L.radiusMm * v.ppm, w / 2, h / 2);
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }

    drawMat(ctx, v) {
      const W = this.cssW, H = this.cssH;
      ctx.fillStyle = COLORS.mat;
      ctx.fillRect(0, 0, W, H);
      const step = v.ppm * 10 >= 6 ? 10 : 50; // 1 cm squares, or 5 cm when zoomed far out
      const startX = Math.floor(-v.ox / v.ppm / step) * step;
      const startY = Math.floor(-v.oy / v.ppm / step) * step;
      ctx.lineWidth = 1;
      for (let mm = startX; v.ox + mm * v.ppm <= W; mm += step) {
        const x = Math.round(v.ox + mm * v.ppm) + 0.5;
        ctx.strokeStyle = mm % 50 === 0 ? COLORS.matLineMajor : COLORS.matLine;
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
      }
      for (let mm = startY; v.oy + mm * v.ppm <= H; mm += step) {
        const y = Math.round(v.oy + mm * v.ppm) + 0.5;
        ctx.strokeStyle = mm % 50 === 0 ? COLORS.matLineMajor : COLORS.matLine;
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
      }
      // Ruler numbers in cm, counted from the lid's top-left corner.
      ctx.fillStyle = COLORS.matText;
      ctx.font = '500 11px "Archivo", sans-serif';
      try { ctx.fontStretch = 'condensed'; } catch (_) { /* older browsers */ }
      const every = v.ppm * 10 >= 24 ? 10 : v.ppm * 10 >= 9 ? 50 : 100;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let mm = Math.ceil(-v.ox / v.ppm / every) * every; v.ox + mm * v.ppm <= W; mm += every) {
        ctx.fillText(String(mm / 10), v.ox + mm * v.ppm, 8);
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      for (let mm = Math.ceil(-v.oy / v.ppm / every) * every; v.oy + mm * v.ppm <= H; mm += every) {
        if (v.oy + mm * v.ppm < 24) continue;
        ctx.fillText(String(mm / 10), 8, v.oy + mm * v.ppm);
      }
      try { ctx.fontStretch = 'normal'; } catch (_) { /* ignore */ }
    }

    drawLid(ctx, v, forExport) {
      const L = this.laptop;
      const w = L.widthMm * v.ppm, h = L.heightMm * v.ppm;
      // Shadow under the laptop
      ctx.save();
      ctx.shadowColor = 'rgba(5, 25, 20, 0.45)';
      ctx.shadowBlur = forExport ? 0 : Math.min(40, 6 * v.ppm) * this.dpr;
      ctx.shadowOffsetY = forExport ? 0 : Math.min(14, 2 * v.ppm) * this.dpr;
      ctx.beginPath();
      this.lidPath(ctx, v);
      ctx.fillStyle = L.color;
      ctx.fill();
      ctx.restore();

      ctx.save();
      ctx.beginPath();
      this.lidPath(ctx, v);
      ctx.clip();
      if (this.photo) {
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(this.photo, v.ox, v.oy, w, h);
      } else {
        // Soft sheen so the lid reads as a surface.
        const g = ctx.createLinearGradient(v.ox, v.oy, v.ox + w, v.oy + h);
        g.addColorStop(0, 'rgba(255,255,255,0.16)');
        g.addColorStop(0.55, 'rgba(255,255,255,0)');
        g.addColorStop(1, 'rgba(0,0,0,0.10)');
        ctx.fillStyle = g;
        ctx.fillRect(v.ox, v.oy, w, h);
        // Hinge band along the bottom edge.
        const band = Math.min(9 * v.ppm, h * 0.045);
        const hg = ctx.createLinearGradient(0, v.oy + h - band, 0, v.oy + h);
        hg.addColorStop(0, 'rgba(0,0,0,0)');
        hg.addColorStop(1, 'rgba(0,0,0,0.16)');
        ctx.fillStyle = hg;
        ctx.fillRect(v.ox, v.oy + h - band, w, band);
      }
      if (L.logo && L.logo.show) {
        const cx = v.ox + (L.logo.x / 100) * w;
        const cy = v.oy + (L.logo.y / 100) * h;
        const r = (L.logo.diameterMm / 2) * v.ppm;
        const lg = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
        lg.addColorStop(0, 'rgba(255,255,255,0.42)');
        lg.addColorStop(1, 'rgba(255,255,255,0.12)');
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, TAU);
        ctx.fillStyle = lg;
        ctx.fill();
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(0,0,0,0.12)';
        ctx.stroke();
      }
      ctx.restore();

      // Edge highlight
      ctx.save();
      ctx.beginPath();
      this.lidPath(ctx, v);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.stroke();
      ctx.restore();
    }

    drawItem(ctx, it, v, shadow) {
      const s = this.itemSize(it);
      if (!s) return;
      const w = s.w * v.ppm;
      const h = s.h * v.ppm;
      const st = s.st;
      // Use the small preview image unless we're drawing it large.
      const img = st.small && w * this.dpr <= st.small.width * 1.2 ? st.small : st.full;
      ctx.save();
      ctx.translate(v.ox + it.x * v.ppm, v.oy + it.y * v.ppm);
      ctx.rotate((it.rot * Math.PI) / 180);
      if (shadow) {
        ctx.shadowColor = 'rgba(10, 16, 22, 0.32)';
        ctx.shadowBlur = Math.min(24, 1.1 * v.ppm) * this.dpr;
        ctx.shadowOffsetY = Math.min(8, 0.45 * v.ppm) * this.dpr;
      }
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
      ctx.restore();
    }

    drawItems(ctx, v, opts) {
      const ghosts = !opts.forExport && !this.flags.preview;
      if (ghosts) {
        // Parts hanging off the lid are shown faintly so you can still grab them.
        ctx.save();
        ctx.beginPath();
        ctx.rect(-10, -10, this.cssW + 20, this.cssH + 20);
        this.lidPath(ctx, v);
        ctx.clip('evenodd');
        ctx.globalAlpha = 0.32;
        for (const it of this.items) this.drawItem(ctx, it, v, false);
        ctx.restore();
      }
      ctx.save();
      ctx.beginPath();
      this.lidPath(ctx, v);
      ctx.clip();
      for (const it of this.items) this.drawItem(ctx, it, v, this.flags.shadows);
      ctx.restore();
    }

    drawOverlay(ctx, v) {
      const L = this.laptop;
      // Orientation labels on the mat.
      ctx.fillStyle = COLORS.matText;
      ctx.font = '500 12px "Archivo", sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('Hinge', v.ox + (L.widthMm * v.ppm) / 2, v.oy + L.heightMm * v.ppm + 10);
      ctx.textBaseline = 'bottom';
      ctx.fillText(U.cm(L.widthMm) + ' × ' + U.cm(L.heightMm) + ' cm', v.ox + (L.widthMm * v.ppm) / 2, v.oy - 10);

      if (this.flags.preview) return;

      // Centre guides while snapping.
      if (this.guides) {
        ctx.save();
        ctx.setLineDash([6, 5]);
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(255, 201, 60, 0.9)';
        if (this.guides.x) {
          const x = v.ox + (L.widthMm / 2) * v.ppm;
          ctx.beginPath(); ctx.moveTo(x, v.oy); ctx.lineTo(x, v.oy + L.heightMm * v.ppm); ctx.stroke();
        }
        if (this.guides.y) {
          const y = v.oy + (L.heightMm / 2) * v.ppm;
          ctx.beginPath(); ctx.moveTo(v.ox, y); ctx.lineTo(v.ox + L.widthMm * v.ppm, y); ctx.stroke();
        }
        ctx.restore();
      }

      const outline = (it, style, dash) => {
        const h = this.handles(it);
        if (!h) return null;
        ctx.save();
        ctx.beginPath();
        h.corners.forEach((c, i) => (i ? ctx.lineTo(c.x, c.y) : ctx.moveTo(c.x, c.y)));
        ctx.closePath();
        ctx.setLineDash(dash || []);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = style;
        ctx.stroke();
        ctx.restore();
        return h;
      };

      if (this.hover && this.hover !== this.selected) {
        const it = this.items.find((x) => x.uid === this.hover);
        if (it) outline(it, 'rgba(255, 255, 255, 0.55)', [4, 4]);
      }

      const sel = this.selectedItem;
      if (!sel) return;
      const h = outline(sel, COLORS.accent, [6, 4]);
      if (!h) return;
      // Rotate handle
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(h.topMid.x, h.topMid.y);
      ctx.lineTo(h.rotate.x, h.rotate.y);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = COLORS.accent;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(h.rotate.x, h.rotate.y, 8, 0, TAU);
      ctx.fillStyle = COLORS.accent;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = COLORS.ink;
      ctx.stroke();
      // small curved arrow inside the handle
      ctx.beginPath();
      ctx.arc(h.rotate.x, h.rotate.y, 3.5, -Math.PI * 0.9, Math.PI * 0.4);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();

      if (!this.flags.lockSize) {
        for (const c of h.corners) {
          ctx.beginPath();
          ctx.rect(c.x - 5, c.y - 5, 10, 10);
          ctx.fillStyle = '#ffffff';
          ctx.fill();
          ctx.lineWidth = 1.5;
          ctx.strokeStyle = COLORS.ink;
          ctx.stroke();
        }
      }

      if (this.drag && (this.drag.type === 'rotate' || this.drag.type === 'scale')) {
        const label = this.drag.type === 'rotate'
          ? Math.round(sel.rot) + '°'
          : '×' + sel.scale.toFixed(2);
        ctx.font = '600 12px "Archivo", sans-serif';
        const tw = ctx.measureText(label).width + 14;
        const lx = h.rotate.x - tw / 2;
        const ly = h.rotate.y - 34;
        ctx.fillStyle = COLORS.ink;
        roundRectPath(ctx, lx, ly, tw, 22, 6);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, h.rotate.x, ly + 11);
      }
    }

    render() {
      if (!this.laptop || !this.cssW) return;
      const ctx = this.ctx;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const v = this.view;
      this.drawMat(ctx, v);
      this.drawLid(ctx, v, false);
      this.drawItems(ctx, v, {});
      this.drawOverlay(ctx, v);
    }

    /** Render just the lid and stickers at `ppm` pixels per mm, for saving as an image. */
    exportCanvas(ppm) {
      const L = this.laptop;
      const pad = 0;
      const c = U.canvas(L.widthMm * ppm + pad * 2, L.heightMm * ppm + pad * 2);
      const ctx = c.getContext('2d');
      const v = { ppm, ox: pad, oy: pad };
      const savedDpr = this.dpr;
      this.dpr = 1;
      this.drawLid(ctx, v, true);
      const savedW = this.cssW, savedH = this.cssH;
      this.cssW = c.width; this.cssH = c.height;
      // Use full-resolution images for export.
      ctx.save();
      ctx.beginPath();
      this.lidPath(ctx, v);
      ctx.clip();
      for (const it of this.items) {
        const s = this.itemSize(it);
        if (!s) continue;
        const w = s.w * ppm, h = s.h * ppm;
        ctx.save();
        ctx.translate(it.x * ppm + pad, it.y * ppm + pad);
        ctx.rotate((it.rot * Math.PI) / 180);
        if (this.flags.shadows) {
          ctx.shadowColor = 'rgba(10, 16, 22, 0.32)';
          ctx.shadowBlur = 1.1 * ppm;
          ctx.shadowOffsetY = 0.45 * ppm;
        }
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(s.st.full, -w / 2, -h / 2, w, h);
        ctx.restore();
      }
      ctx.restore();
      this.cssW = savedW; this.cssH = savedH;
      this.dpr = savedDpr;
      return c;
    }

    /** Share of the lid covered by stickers (0..1), estimated on a small grid. */
    coverage() {
      const L = this.laptop;
      if (!this.items.length) return 0;
      const ppm = 200 / L.widthMm;
      const c = U.canvas(L.widthMm * ppm, L.heightMm * ppm);
      const ctx = c.getContext('2d');
      const v = { ppm, ox: 0, oy: 0 };
      ctx.beginPath();
      this.lidPath(ctx, v);
      ctx.clip();
      for (const it of this.items) {
        const s = this.itemSize(it);
        if (!s) continue;
        ctx.save();
        ctx.translate(it.x * ppm, it.y * ppm);
        ctx.rotate((it.rot * Math.PI) / 180);
        ctx.drawImage(s.st.small || s.st.full, (-s.w * ppm) / 2, (-s.h * ppm) / 2, s.w * ppm, s.h * ppm);
        ctx.restore();
      }
      const data = ctx.getImageData(0, 0, c.width, c.height).data;
      let covered = 0;
      for (let i = 3; i < data.length; i += 4) if (data[i] > 128) covered++;
      // Area of the rounded lid in pixels
      const r = L.radiusMm * ppm;
      const lidArea = c.width * c.height - (4 - Math.PI) * r * r;
      return Math.min(1, covered / lidArea);
    }
  }

  function normAngle(deg) {
    let a = deg % 360;
    if (a > 180) a -= 360;
    if (a <= -180) a += 360;
    return Math.round(a * 10) / 10;
  }

  function roundRectPath(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  SL.Editor = Editor;
})();
