/*
 * samples.js
 * ----------
 * Draws a few original sample stickers so there is something to play
 * with before you scan your own. Each one gets a white "die-cut" border
 * like a real vinyl sticker.
 */
(function () {
  'use strict';
  const SL = (window.SL = window.SL || {});
  const U = SL.U;

  /** Wrap a drawing in a white die-cut border and trim the empty space. */
  function makeSticker(w, h, draw, border) {
    border = border || 16;
    const pad = border + 6;
    const W = w + pad * 2;
    const H = h + pad * 2;

    const design = U.canvas(W, H);
    const d = design.getContext('2d');
    d.translate(pad, pad);
    draw(d, w, h);

    // Solid-colour copies of the design's outline.
    const tint = (color) => {
      const c = U.canvas(W, H);
      const g = c.getContext('2d');
      g.drawImage(design, 0, 0);
      g.globalCompositeOperation = 'source-in';
      g.fillStyle = color;
      g.fillRect(0, 0, W, H);
      return c;
    };
    const white = tint('#ffffff');
    const edge = tint('#c9d0d8');

    const out = U.canvas(W, H);
    const o = out.getContext('2d');
    const steps = 32;
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      o.drawImage(edge, Math.cos(a) * (border + 1.5), Math.sin(a) * (border + 1.5));
    }
    for (let i = 0; i < steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      o.drawImage(white, Math.cos(a) * border, Math.sin(a) * border);
    }
    o.drawImage(white, 0, 0);
    o.drawImage(design, 0, 0);

    // Trim to the visible pixels.
    const data = o.getImageData(0, 0, W, H).data;
    const alpha = new Uint8Array(W * H);
    for (let i = 0; i < W * H; i++) alpha[i] = data[i * 4 + 3];
    const b = SL.Img.alphaBounds(alpha, W, H, 4);
    const trimmed = U.canvas(b.w, b.h);
    trimmed.getContext('2d').drawImage(out, -b.x, -b.y);
    return trimmed;
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  const FONT = '"Archivo", "Helvetica Neue", Arial, sans-serif';
  const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

  const designs = [
    {
      name: 'Terminal',
      widthMm: 72,
      w: 520, h: 340,
      draw(g, w, h) {
        roundRect(g, 0, 0, w, h, 30);
        g.fillStyle = '#1d2330';
        g.fill();
        g.save();
        roundRect(g, 0, 0, w, h, 30);
        g.clip();
        g.fillStyle = '#2c3446';
        g.fillRect(0, 0, w, 58);
        g.restore();
        ['#e86a5a', '#f2c14e', '#5cc98a'].forEach((c, i) => {
          g.beginPath();
          g.arc(36 + i * 30, 29, 10, 0, Math.PI * 2);
          g.fillStyle = c;
          g.fill();
        });
        g.fillStyle = '#7ee787';
        g.font = 'bold 110px ' + MONO;
        g.fillText('>_', 40, 200);
        g.fillStyle = '#c9d1d9';
        g.font = '500 46px ' + MONO;
        g.fillText('hello, world', 42, 290);
      }
    },
    {
      name: 'Gold star',
      widthMm: 50,
      w: 440, h: 420,
      draw(g, w, h) {
        const cx = w / 2, cy = h / 2 + 14, R = 210, r = R * 0.47;
        g.beginPath();
        for (let i = 0; i < 10; i++) {
          const rad = i % 2 ? r : R;
          const a = -Math.PI / 2 + (i * Math.PI) / 5;
          g.lineTo(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad);
        }
        g.closePath();
        const grad = g.createLinearGradient(0, 0, w, h);
        grad.addColorStop(0, '#ffe066');
        grad.addColorStop(1, '#f5a524');
        g.fillStyle = grad;
        g.fill();
        g.lineJoin = 'round';
        g.lineWidth = 12;
        g.strokeStyle = '#c9760f';
        g.stroke();
        g.beginPath();
        g.ellipse(cx - 40, cy - 70, 26, 14, -0.6, 0, Math.PI * 2);
        g.fillStyle = 'rgba(255,255,255,.75)';
        g.fill();
      }
    },
    {
      name: 'Planet',
      widthMm: 64,
      w: 540, h: 360,
      draw(g, w, h) {
        const cx = w / 2, cy = h / 2;
        const ring = (front) => {
          g.save();
          g.translate(cx, cy);
          g.rotate(-0.28);
          g.beginPath();
          if (front) g.ellipse(0, 0, 250, 66, 0, 0, Math.PI);
          else g.ellipse(0, 0, 250, 66, 0, Math.PI, Math.PI * 2);
          g.lineWidth = 22;
          g.strokeStyle = '#ffb547';
          g.stroke();
          g.restore();
        };
        ring(false);
        g.save();
        g.beginPath();
        g.arc(cx, cy, 128, 0, Math.PI * 2);
        g.fillStyle = '#7b5cff';
        g.fill();
        g.clip();
        g.fillStyle = '#6346e0';
        for (const y of [-70, -10, 50]) {
          g.save();
          g.translate(cx, cy + y);
          g.rotate(-0.28);
          g.fillRect(-160, 0, 320, 24);
          g.restore();
        }
        g.beginPath();
        g.arc(cx - 50, cy - 55, 24, 0, Math.PI * 2);
        g.fillStyle = 'rgba(255,255,255,.35)';
        g.fill();
        g.restore();
        ring(true);
      }
    },
    {
      name: 'Heart',
      widthMm: 45,
      w: 420, h: 380,
      draw(g, w, h) {
        g.beginPath();
        g.moveTo(w / 2, h - 20);
        g.bezierCurveTo(w * 0.1, h * 0.62, -w * 0.02, h * 0.28, w * 0.22, h * 0.1);
        g.bezierCurveTo(w * 0.36, 0, w * 0.48, h * 0.08, w / 2, h * 0.22);
        g.bezierCurveTo(w * 0.52, h * 0.08, w * 0.64, 0, w * 0.78, h * 0.1);
        g.bezierCurveTo(w * 1.02, h * 0.28, w * 0.9, h * 0.62, w / 2, h - 20);
        g.closePath();
        g.fillStyle = '#ff4d6d';
        g.fill();
        g.lineWidth = 10;
        g.lineJoin = 'round';
        g.strokeStyle = '#cf2346';
        g.stroke();
        g.beginPath();
        g.ellipse(w * 0.27, h * 0.27, 30, 16, -0.7, 0, Math.PI * 2);
        g.fillStyle = 'rgba(255,255,255,.7)';
        g.fill();
      }
    },
    {
      name: 'Works on my machine',
      widthMm: 55,
      w: 440, h: 440,
      draw(g, w, h) {
        const cx = w / 2, cy = h / 2;
        g.beginPath();
        g.arc(cx, cy, 218, 0, Math.PI * 2);
        g.fillStyle = '#2563eb';
        g.fill();
        g.beginPath();
        g.arc(cx, cy, 192, 0, Math.PI * 2);
        g.lineWidth = 6;
        g.strokeStyle = '#ffffff';
        g.stroke();
        g.fillStyle = '#ffffff';
        g.textAlign = 'center';
        g.font = '800 58px ' + FONT;
        g.fillText('IT WORKS', cx, cy - 44);
        g.font = '800 58px ' + FONT;
        g.fillText('ON MY', cx, cy + 22);
        g.font = '800 66px ' + FONT;
        g.fillText('MACHINE', cx, cy + 96);
        g.beginPath();
        g.moveTo(cx - 34, cy - 140);
        g.lineTo(cx - 8, cy - 114);
        g.lineTo(cx + 40, cy - 162);
        g.lineWidth = 16;
        g.lineCap = 'round';
        g.lineJoin = 'round';
        g.strokeStyle = '#ffd84a';
        g.stroke();
      }
    },
    {
      name: 'Coffee',
      widthMm: 44,
      w: 420, h: 440,
      draw(g, w, h) {
        g.lineCap = 'round';
        g.lineJoin = 'round';
        g.strokeStyle = '#4a2f22';
        g.lineWidth = 14;
        // steam
        for (const x of [110, 180, 250]) {
          g.beginPath();
          g.moveTo(x, 130);
          g.bezierCurveTo(x - 30, 100, x + 30, 70, x, 30);
          g.stroke();
        }
        // handle
        g.beginPath();
        g.arc(330, 270, 58, -Math.PI / 2, Math.PI / 2);
        g.lineWidth = 26;
        g.stroke();
        // mug
        roundRect(g, 40, 160, 290, 260, 34);
        g.fillStyle = '#f4ece2';
        g.fill();
        g.lineWidth = 14;
        g.stroke();
        g.beginPath();
        g.ellipse(185, 172, 128, 20, 0, 0, Math.PI * 2);
        g.fillStyle = '#6b3e26';
        g.fill();
        g.fillStyle = '#e8413c';
        g.beginPath();
        const hx = 185, hy = 300;
        g.moveTo(hx, hy + 34);
        g.bezierCurveTo(hx - 60, hy, hx - 40, hy - 40, hx, hy - 16);
        g.bezierCurveTo(hx + 40, hy - 40, hx + 60, hy, hx, hy + 34);
        g.fill();
      }
    },
    {
      name: 'Rainbow',
      widthMm: 66,
      w: 560, h: 320,
      draw(g, w, h) {
        const cx = w / 2, cy = h - 34;
        const colors = ['#ff5a5f', '#ffb547', '#ffe066', '#5cc98a', '#4ea8ff'];
        colors.forEach((c, i) => {
          g.beginPath();
          g.arc(cx, cy, 236 - i * 34, Math.PI, 0);
          g.lineWidth = 36;
          g.strokeStyle = c;
          g.stroke();
        });
        const cloud = (x) => {
          g.beginPath();
          g.arc(x - 34, cy + 4, 34, 0, Math.PI * 2);
          g.arc(x + 4, cy - 16, 44, 0, Math.PI * 2);
          g.arc(x + 46, cy + 6, 32, 0, Math.PI * 2);
          g.fillStyle = '#ffffff';
          g.fill();
          g.lineWidth = 5;
          g.strokeStyle = '#cfd6de';
          g.stroke();
          g.fillRect(x - 60, cy, 130, 34);
        };
        cloud(cx - 236);
        cloud(cx + 216);
      }
    },
    {
      name: 'Bug',
      widthMm: 40,
      w: 380, h: 440,
      draw(g, w, h) {
        const cx = w / 2;
        g.strokeStyle = '#1a2026';
        g.lineCap = 'round';
        g.lineWidth = 14;
        // legs
        for (const y of [210, 270, 330]) {
          g.beginPath(); g.moveTo(cx - 100, y); g.lineTo(cx - 160, y - 20); g.stroke();
          g.beginPath(); g.moveTo(cx + 100, y); g.lineTo(cx + 160, y - 20); g.stroke();
        }
        // antennae
        g.beginPath(); g.moveTo(cx - 20, 90); g.quadraticCurveTo(cx - 50, 20, cx - 90, 24); g.stroke();
        g.beginPath(); g.moveTo(cx + 20, 90); g.quadraticCurveTo(cx + 50, 20, cx + 90, 24); g.stroke();
        // head
        g.beginPath();
        g.arc(cx, 116, 58, 0, Math.PI * 2);
        g.fillStyle = '#1a2026';
        g.fill();
        // body
        g.beginPath();
        g.ellipse(cx, 270, 130, 150, 0, 0, Math.PI * 2);
        g.fillStyle = '#e8413c';
        g.fill();
        g.lineWidth = 10;
        g.stroke();
        g.beginPath(); g.moveTo(cx, 124); g.lineTo(cx, 418); g.stroke();
        g.fillStyle = '#1a2026';
        for (const [x, y, r] of [[-62, 220, 24], [58, 210, 20], [-70, 310, 20], [66, 318, 26], [-26, 380, 14], [28, 372, 14]]) {
          g.beginPath();
          g.arc(cx + x, y, r, 0, Math.PI * 2);
          g.fill();
        }
        g.fillStyle = '#ffffff';
        g.beginPath(); g.arc(cx - 20, 104, 9, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(cx + 20, 104, 9, 0, Math.PI * 2); g.fill();
      }
    }
  ];

  SL.Samples = {
    /** Returns [{ name, widthMm, canvas }] */
    generate() {
      return designs.map((d) => ({ name: d.name, widthMm: d.widthMm, canvas: makeSticker(d.w, d.h, d.draw) }));
    }
  };
})();
