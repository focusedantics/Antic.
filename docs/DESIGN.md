# Design workspace — plan and checklist

A fifth tab, **Design**, for graphic design: posters, flyers, social posts, stories,
wallpapers, invitations, logos and collages. The feature list was taken from a
popular phone design app's description; its features were ported, not its interface.
Design follows this app's own look (dark glass panels, the
Library/Develop/Composite layout on computers, the dock and floating sheets on phones),
and every edit stays data (CLAUDE.md).

## Approach

**One document system.** Composite already is a layered editor: layers, groups, 24
blend modes, opacity and fill opacity, clipping, brush/gradient/AI layer masks,
perspective transforms, text with bundled fonts and motion, shapes, gradients,
adjustment and effect layers, background removal, animation and GIF/MP4 export. Design
does not duplicate it. A design is a `CompositeDocument` marked `purpose: "design"`,
rendered by the same compositor and edited through the same session, history, canvas,
layers and properties. Composite keeps its own documents and behaves exactly as before.
Each workspace reopens its own last document. A document can move between them
("Open in Composite" / "Open in Design").

**What Design adds** is a design-first start (sizes and templates instead of an empty
dialog) and the layer kinds, tools and libraries a designer needs. New layer kinds and
styles live in `core/document` and the compositor, so they work, save, export and
sanitize the same way in both workspaces. Composite gains them as well.

**Interface (ours, not the reference app's).**
- Computers: the usual three columns. The left column holds *Make* (templates, sizes,
  elements, text styles, photos, palettes). The centre is the canvas with a tool strip
  across its top. The right column holds Layers and Properties.
- Phones: a dock (Make · Layers · Properties · Export). Panels float as translucent
  sheets over the canvas, as in Develop, and the tool strip scrolls horizontally above
  the dock. Everything is checked at 390 × 664.
- The Design home (no document open) shows a size picker (cards with each size drawn to
  scale), the template gallery with category chips and a search, and recent designs.

**Phase 1 notes.** On phones the Library filmstrip is not shown in Design (photos are
added from the Add sheet, and the canvas needs the height); it stays in every other
workspace. On computers the right column is left out on start screens that pass no
right panel (Design's home, Composite's empty state), giving the centre the room; it
comes back as soon as there is something to show.

**Nothing is removed.** Composite's documents, dialog, toolbar and shortcuts stay.
Design's keyboard shortcut is `B`, which is free. The top bar and the phone's workspace
menu gain one entry. If anything has to move to make room, this section will say why
and where it went.

## Feature list

Status: ✅ done · ⬜ to do. "Exists" means the feature is already in Composite and Design
exposes it. "New" means it is built here. "Workaround" means a free replacement for a
paid or online feature. "Skip" means it is left out, with the reason.

### Templates and starting points
| # | Feature | How | Status |
| --- | --- | --- | --- |
| T1 | Size presets: Instagram post / portrait / story, TikTok, Facebook post and cover, X post and header, YouTube thumbnail and banner, LinkedIn, Pinterest pin, phone and desktop wallpaper, contact poster, profile picture, logo, flyer (Letter, A4, A5), poster, business card, invitation, postcard, presentation, custom | New: `design/presets.ts`, cards drawn to scale | ✅ |
| T2 | Template gallery: categories, tags, search, one tap to start | New: 41 original templates written as code (`design/templates.ts`) in 9 categories, previewed as SVG sketches | ✅ |
| T7 | "Yes / but" before-and-after posts (edit vs. as shot) | New: post and story templates whose lower frame shows the photo before its Develop edits (`slot.original`); one photo fills both | ✅ |
| T8 | Playing card: the photo mirrored through the middle | New: card template whose two halves are linked frames (`slot.link`), the lower one upside down; one photo fills both, zoom and move follow, Unlink in Properties | ✅ |
| T3 | Templates with photo slots ("tap to add your photo"), replace photo | New: `slot` layer kind (frame shape, zoom and pan); replacing keeps transform, clip, mask and styles; photo layers get "Replace photo" too | ✅ |
| T4 | Save a design as my template, in folders | New: `designAssets` store (IndexedDB), folders by path; More → Save as template; My templates in the gallery (use, rename, move, delete) | ✅ |
| T5 | Collages: grid layouts with photo slots, spacing and corner radius | New: collage groups (16 layouts, spacing, rounding, shuffle; re-layout any time), collage templates, "Collage from your photos" (Library selection or device) | ✅ |
| T6 | Stock photos in templates | Skip: licensed stock costs money and needs a server. Templates use slots and the user's own photos | — |

### Photo editing (in a design)
| # | Feature | How | Status |
| --- | --- | --- | --- |
| P1 | Effects and filters | Exists: effects browser, Looks; New: quick filter strip on image layers (develop presets) | ⬜ |
| P2 | Background remover | Exists (local AI) | ✅ |
| P3 | Transform, perspective | Exists (corners) | ✅ |
| P4 | Shadows: drop shadow, glow, outline on any layer | New: layer styles, rendered on the GPU from the layer's alpha | ✅ |
| P5 | Extract an element from a photo and keep it for later | New: cut-out → PNG in the Library → saved element | ⬜ |
| P6 | Curves, Color Balance, Selective Color, Tint on adjustment layers | Partly exists (the develop engine has them); New: their controls on adjustment layers, plus a tint | ⬜ |
| P7 | Brightness, contrast, grain, vibrance, shadows/highlights | Exists (adjustment layers, grain) | ✅ |
| P8 | Blur | New: a Blur effect category (Gaussian, lens, motion, zoom, spin, tilt-shift) for whole designs, photos, clipped layers and video; Layer blur in Styles for one layer | ✅ |
| P9 | No ads, no watermark | Exists (watermark is opt-in) | ✅ |

### Vector, text and logos
| # | Feature | How | Status |
| --- | --- | --- | --- |
| V1 | Pen tool, node editing | New: `path` layer kind (cubic Béziers), pen and node tool on the canvas | ✅ |
| V2 | Smart shapes: polygon, star, heart, arrow, speech bubble, line, burst, ring… | New: shape generators producing paths | ✅ |
| V3 | Fill and stroke with colours or gradients, dashes, caps | New: path fill and stroke styles | ✅ |
| V4 | Save vector shapes in folders | New: More → Save selection as element; Elements → Mine (folders managed in P5) | ✅ |
| V5 | SVG import and export | New: SVG subset parser (path, rect, circle, ellipse, line, polyline, polygon, transforms) and an SVG writer | ⬜ |
| V6 | Curved text | New: text arc (bend) | ✅ |
| V7 | Text fill gradient, outline, case, underline | New: text style fields (outline is the Outline layer style); plus a highlight box | ✅ |
| V8 | Custom fonts | New: import TTF/OTF/WOFF files (kept locally, FontFace); Workaround for paid font libraries: bundled OFL fonts | ✅ |
| V9 | Text knockout (photo inside letters) | Exists: clipping. New: one-tap "Photo inside text" | ⬜ |

### Drawing
| # | Feature | How | Status |
| --- | --- | --- | --- |
| D1 | Paint layers with brushes and colours | New: `paint` layer kind; strokes are data (resolution independent, "vector paint") | ✅ |
| D2 | Brush presets: round, soft, marker, pencil, spray, calligraphy, eraser | New | ✅ |
| D3 | Custom brush tips from images | New: a tip image kept as a design asset (dark or opaque areas paint), stamped along the stroke | ✅ |
| D4 | Predictive brush: smoothing, and hold to straighten into a line, circle or rectangle | New (also triangles and polygons) | ✅ |
| D5 | Colour fill (bucket) | New: fill operations replayed with the strokes | ✅ |
| D6 | Mask any layer with brushes | Exists: layer masks | ✅ |
| D7 | Free crop: double-tap a photo | New: Crop tool on the canvas (`tools/CropTool.tsx`), any edge or corner, drag inside to move, the cut part shown dimmed; Reset and Done; also "Crop on the canvas" in Properties | ✅ |

### Elements and text panels
| # | Feature | How | Status |
| --- | --- | --- | --- |
| E1 | Elements: badges, ribbons, price tags, stamps, speech bubbles, doodles, dividers, sparkles, confetti, tape, frames | New: original vector elements built as editable layer groups (`design/elements.ts`), previewed as SVG sketches | ✅ |
| E2 | Text styles and text combinations (title + subtitle, quote, big number, event date, script + capitals, neon, sticker, highlight) | New | ✅ |

### Layers
| # | Feature | How | Status |
| --- | --- | --- | --- |
| L1 | Unlimited layers, blend modes, opacity, clipping, hide/show, duplicate, groups | Exists | ✅ |
| L2 | Merge layers | New: flatten the selection into one image (a PNG in the Library) | ⬜ |
| L3 | Import layers from another design or template | New | ⬜ |
| L4 | Lock | Exists | ✅ |
| L5 | Reorder layers on computers and phones | New: pointer drag with a grip (touch, mouse, pen) and into groups, Bring to Front / Forward, Send Backward / to Back in the layer menu and select bar, Ctrl+[ ] shortcuts, ↑/↓ on the grip | ✅ |

### Colours and folders
| # | Feature | How | Status |
| --- | --- | --- | --- |
| C1 | Colour picker: wheel, square, values (hex, RGB, HSB), eyedropper | New: `features/color` picker (wheel, square, values; the EyeDropper API where present, else a tap on the design) with hex entry, recent, document and palette swatches | ✅ |
| C2 | Palettes and gradient presets in folders; import/export (JSON, GIMP .gpl, hex lists) | New; also Adobe .ase; 11 built-in palettes and 9 gradients | ✅ |
| C3 | Palette from a photo | New (k-means on a thumbnail) | ✅ |
| C4 | Folder manager: designs, templates, elements, brushes, palettes, gradients, fonts (rename, move, duplicate, delete, import/export) | New: `designAssets` with folders; "Your things" manager; `.focusedkit` bundles | ✅ |
| C5 | Guides, rulers, grid, snapping | Guides and snapping exist; New: rulers and grid (snap to grid) | ⬜ |

### Social and motion
| # | Feature | How | Status |
| --- | --- | --- | --- |
| S1 | Profile pictures, posts, stories, wallpapers, contact posters | Sizes (T1) and templates (T2) | ✅ |
| S2 | Animator: animate any layer (fade, slide, zoom, pop, float, spin…), one tap to animate a whole design | New: layer `animation`, applied by the compositor over the loop; exports with the existing GIF/MP4 | ⬜ |
| S3 | Wallpaper preview with the lock-screen clock | New: an overlay that is never exported | ⬜ |
| S6 | Instagram carousels: one seamless canvas several slides wide, so a photo or a line can run across slides; add, duplicate, move and delete slides; swipe between slides while editing; a phone-style swipe preview; export every slide, chosen slides or the whole strip | New (not in the reference app): `doc.carousel`, `core/document/carousel.ts`, `features/design/Carousel.tsx`, carousel sizes and templates, export parts | ✅ |
| S7 | Add slides from templates of the same slide shape (built-in and saved; carousel templates add all their slides) | New: the slide bar's Template button and picker; `insertSlidesWith`; + stays for blank slides | ✅ |
| S8 | Copy, cut and paste; pasting (and adding) goes on the slide in use | New: layer clipboard (keyboard, layer menu, More → Paste), images and text pasted from other apps, new layers sized for and placed on the working slide | ✅ |
| S4 | Cloud sync, accounts | Skip: costs a server; designs stay local, `.focused` files move them | — |
| S5 | AI image generation | Skip: needs paid inference | — |

## Phases

Each phase is its own commit (or several), with tests, then pushed.

1. **Workspace**: the Design tab, document purpose, the home (sizes, gallery shell,
   recents), and the editor reusing Composite's canvas, layers and properties.
2. **Engine**: path layers and smart shapes, layer styles, text upgrades, slots,
   sanitizers and unit tests.
3. **Tools**: pen and node editing, paint layers and brushes, the Elements and Text
   panels.
4. **Templates**: the gallery, collages, save as template.
5. **Colours and folders**: picker, palettes, gradients, palette from photo, folder
   manager, custom fonts.
6. **Motion and layout**: layer animations, lock-screen preview, rulers and grid.
7. **Interchange**: SVG import/export, merge, import layers, extract element.
8. **Adjustments**: curves, colour balance, selective colour, tint, blur.
9. **Docs and full test run**.
