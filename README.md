# Laptop Sticker Planner

Try out sticker layouts on your laptop lid before you peel anything.

- **Scan your stickers** from a photo (or your webcam). The background is removed automatically, several stickers in one photo are split apart, and photos taken at an angle can be straightened.
- **Arrange them on a true-to-scale lid**: drag to move, use the yellow handle to rotate, change the stacking order, duplicate.
- **Keep several layouts** and switch between them. Everything is saved in your browser.
- **Save an image** of a layout to share or compare.

It is plain HTML, CSS and JavaScript. There is nothing to install and no build step.

---

## Running it from Cursor

Open the `sticker-planner` folder in Cursor (File › Open Folder). Then pick one of these:

**A. Simplest: open the file in a browser**
Right-click `index.html` in Cursor's file list › *Reveal in File Explorer / Finder*, then double-click it. Chrome or Edge work best.

**B. Live Server extension (reloads when you edit code)**
1. In Cursor, open Extensions (`Ctrl+Shift+X`), search for **Live Server** and install it.
2. Right-click `index.html` › **Open with Live Server**.

**C. A tiny local server from the terminal**
Open Cursor's terminal (`` Ctrl+` ``) in this folder and run:

```bash
python -m http.server 8000      # on some systems: python3 -m http.server 8000
```

Then go to <http://localhost:8000> in your browser. Stop it with `Ctrl+C`.

> **Your stickers are stored per address.** Opening the file directly (A) and opening it through a server (B or C) count as different sites to the browser, so each has its own sticker library. Pick one way and stick with it, or use **⋯ › Save a backup file** and **Restore from a backup file** to move things across.

The fonts load from Google Fonts. Offline, the app falls back to your system font and works the same.

---

## How to use it

### 1. Set up your laptop
Click **Laptop** (top right). Choose your size, or measure your lid with a ruler and type the width and height. Pick a colour, or use **Use a photo of my laptop**: take a picture of the closed lid, drag the four yellow corners onto the lid's corners, and the photo is straightened onto the preview.

The bottom edge on screen is the **hinge**, so you see the lid the way people across the table do while you're using the laptop.

### 2. Scan stickers
Click **Scan stickers**, or simply drop photos onto the window (or paste one with `Ctrl+V`).

1. **Photo**: choose one or more photos, or use your webcam.
2. **Straighten**: drag the yellow corners around the stickers. If the photo was taken at an angle, put the corners on the corners of the paper underneath to straighten it.
3. **Cut out**: the background is removed automatically. If it isn't perfect:
   - *Background tolerance*: raise it if bits of desk remain, lower it if parts of the sticker vanish.
   - *Remove area* / *Keep area*: click a patch to remove or bring back everything connected to it in a similar colour.
   - *Erase* / *Restore*: paint by hand.
   - *Show removed parts in red* helps you check the edges.
4. **Name and size**: type each sticker's real size (one side is enough).

**Tips for good scans**
- Use a plain surface that contrasts with the stickers. White-bordered vinyl stickers show up best on a dark desk.
- Shoot from straight above, in even light, without flash glare.
- **Automatic sizes:** lay the stickers on a sheet of A4 paper, include the whole sheet in the photo, put the corners on the paper's corners and choose *A4 paper* under "The corners are on". Every sticker is then measured for you.
- iPhone photos in HEIC format can't be opened by most browsers. Set *Settings › Camera › Formats › Most Compatible*, or export as JPEG.

Made a mistake? Use **⋯ › Fix the cut-out** on a sticker in your library.

Want to try the scanner before taking photos? The `test-photos` folder has two: `desk_stickers.jpg` (three stickers on a dark desk, shot at a slight angle) and `a4_stickers.jpg` (two stickers on an A4 sheet; put the corners on the paper and choose *A4 paper* to see automatic sizing).

### 3. Arrange
- Click a sticker in the library to place it in a free spot, or drag it onto the lid.
- **Drag** to move. It snaps to the lid's centre lines; hold `Alt` to stop snapping.
- **Yellow handle**: rotate. Hold `Shift` for 15° steps.
- **Real size only** (toolbar): when switched off, corner handles appear so you can try other sizes, for example before ordering a bigger print.
- **Preview** hides the handles and the parts hanging off the edge.
- The green mat is a real ruler: one square is 1 cm, numbered from the lid's top-left corner.

| Keys | Action |
| --- | --- |
| Arrow keys | Nudge 1 mm (`Shift`: 1 cm) |
| `R` / `Shift+R` | Rotate 15° right / left |
| `]` / `[` | Bring forward / send backward |
| `Ctrl+D` | Duplicate |
| `Delete` | Remove from the lid |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo |
| `P` | Preview on/off |
| `Ctrl` + scroll, or pinch | Zoom |
| Drag empty mat, or scroll | Pan (double-click the mat to fit again) |

On a Mac, use `Cmd` instead of `Ctrl`.

### 4. Layouts, images and backups
- The layout menu at the top lets you create, rename, duplicate and delete layouts. Duplicating is handy for trying a variation.
- **Save image** downloads a PNG of the current layout at high resolution.
- **⋯ › Save a backup file** downloads everything (stickers, layouts, laptop) as one `.json` file.

---

## How the code is organised

```
sticker-planner/
├── index.html        Page structure and the icon set
├── test-photos/      Two example photos for trying the scanner
├── css/style.css     All styling
└── js/
    ├── imaging.js    Image processing: straightening, background removal, splitting
    ├── util.js       Small helpers: elements, dialogs, menus, toasts, downloads
    ├── db.js         Saving to the browser (IndexedDB)
    ├── samples.js    Draws the sample stickers
    ├── editor.js     The lid on the mat: drawing, dragging, rotating, undo
    ├── scanner.js    The four-step scanning window
    └── app.js        Connects everything and starts the app
```

The scripts are ordinary `<script>` tags (not modules) so the page also works when opened straight from disk. Each file adds itself to a global `SL` object; for example `SL.Img.warpPerspective(...)`. In the browser console you can inspect `SL.state` and `SL.editor` while the app runs.

### How the scanning works

1. **Straightening**: the four corners you place define a *homography*, a 3×3 matrix that maps a tilted rectangle onto a flat one. `computeHomography` solves an 8×8 linear system with Gaussian elimination; `warpPerspective` then fills each output pixel by looking up where it came from in the photo (with bilinear interpolation).
2. **Finding the background**: pixels around the photo's border are assumed to be background. They are grouped into a few typical colours with k-means. Starting from the border, a flood fill (breadth-first search) spreads into neighbouring pixels whose colour is close to one of those background colours. Colours are compared in the CIE Lab colour space, where distance roughly matches how different two colours look.
3. **Splitting stickers**: whatever is left is labelled into connected groups of pixels. Each big enough group becomes its own sticker; tiny ones count as dust.
4. **Edges**: the mask is shrunk by a pixel to lose the coloured halo from the desk, then blurred slightly so edges are smooth.

Positions on the lid are stored in millimetres, so a sticker you measured at 5 cm is drawn at 5 cm on a lid you measured at 31.3 cm, at any zoom level.

---

## Ideas if you want to extend it

- A "sticker bomb" button that scatters every sticker randomly with random rotation.
- Showing two layouts side by side.
- Automatic corner detection for the paper in the straighten step.
- Glossy or holographic finishes when drawing stickers.

## License

Released under the [MIT License](LICENSE).
