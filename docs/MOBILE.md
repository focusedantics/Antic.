# Phones and resizable panels: design notes

How Focused runs on a phone, and why. The code is described in
`docs/ARCHITECTURE.md` ("Layout on computers and phones").

## Goals

1. Computers keep their layout: tools stay where they are. Panels can be resized and
   hidden; nothing moves unless the user moves it.
2. Phones get a layout made for them, not a squeezed desktop.
3. A phone browser must not run out of memory and reload the page, losing the work.
4. Every feature stays reachable on a phone. Decorative animation may go; function may not.

## Reference: Lightroom mobile

What Adobe's mobile editor does, from Adobe's guides and reviews (see Sources):

- The photo takes the screen. Tools are grouped in a **bottom toolbar** (Light, Color,
  Effects, Detail, Optics…); the 2023 redesign cut the visible groups "from 15 to just
  five", moving rare ones into a ⋯ menu.
- A group opens its **sliders in a panel over the bottom**; swiping up shows more and
  swiping down closes it.
- **Undo/redo** sit at the top; double-tapping a slider resets it; pressing and holding
  the photo shows the original.
- On iPad in landscape the toolbar moves to the side. Handedness can flip it.

What we took:

| Lightroom mobile | Focused on a phone |
| --- | --- |
| Bottom toolbar of groups | Dock: Presets · Edit · Crop · Masks · Heal (Develop); Folders · Info (Library); Documents · Layers (Composite); Clips · Edit (Video) |
| Edit: a short translucent panel of about three sliders floating over the photo, the groups (Light, Color, Effects, Detail, Optics…) in a row beneath, sub-tabs inside a group (Effects · Vignette · Grain) | Edit opens one group at a time in a panel just tall enough for three sliders, floating translucent over the bottom of the photo: Light · Curve · Color · Mixer · Grading · Effects · Detail · Optics in a scrolling row of icons, with Effects · Vignette · Grain and Sharpening · Noise as sub-tabs. The photo keeps the size that fits the whole viewer and moves up clear of the panel when it fits above it. Like Lightroom, Texture/Clarity/Dehaze are in Effects and Vibrance/Saturation (and B&W) in Color. Held sideways the panel sits beside the photo instead |
| Curve: drawn over the photo, a slim bar with the channels and Done | The same: the curve's grid and points lie over the photo (tap to add a point, drag to shape, double tap to remove), and the panel becomes a bar with Reset, Done, the RGB/R/G/B channels and the parametric sliders |
| Each slider: name and value on one line, a wide track beneath | The same in every phone sheet: 58 px rows, a thin track the width of the screen, a large white thumb |
| Drag a slider anywhere; swipe up and down to scroll | A finger moves the value from where it was by the distance dragged sideways; a tap changes nothing and a vertical swipe scrolls the panel, so scrolling never nudges a slider |
| Histogram floating, small, at the top of the photo | Top-left corner, translucent glass, touches pass through; the corners light when shadows or highlights clip. It shows while editing (not in Crop, Masks or Heal, which need the corner) and can be hidden from ⋯ |
| Sliders in a panel over the bottom; swipe to resize or close | Sheet with a grip: drag to resize, it snaps to 30/50/85 % (Edit: its own height, then 50/85 %); drag below 20 % or flick down to close |
| Panels translucent over the picture | Every phone panel floats over the picture, in every workspace (Presets, Crop, Masks, Heal, Library's Folders and Info, Composite's Documents and Layers, Video's Clips and Edit) |
| Photo stays visible while editing | The picture moves up clear of the panel. Edit and Video keep it at full size (a tall one shows through the panel); Crop, Masks, Heal and Composite fit it whole above the panel so every handle is reachable; the Library pads its grid and loupe. Video floats panels over the frame only, so play, split and the timeline stay in reach |
| Fewer options, rest in ⋯ | Top bar: a workspace switcher, then undo, redo and export (as Lightroom keeps them at the top), and ⋯ for import, filmstrip, glow and tour. The long toolbars keep the rest and scroll sideways |
| Presets and effects as a scrolling grid | The effects browser goes full screen: search, a row of category chips, two columns of live previews |
| Pinch and double tap on the photo | Pinch zooms and pans; a double tap toggles 100 % |
| Swipe sideways between photos | In the Library's loupe and in Develop (at fit, while editing), a sideways swipe moves the photo with the finger while the next slides in beside it; past a third of the way or with a flick it glides on, otherwise it springs back, and the ends give like a rubber band |
| Batch select (Photos-style: Select, tap to toggle, swipe across, a bar of actions) | Select mode for photos (grid and filmstrip), layers, clips and timeline segments: hold an item or tap Select; taps toggle, a sideways swipe sweeps across several (vertical swipes still scroll), and a bar replaces the dock with Done, the count, All/None and Actions (the computer's batch menu: export, Looks, stack, group, delete…) |
| Double-tap a slider to reset | Double-click on a slider's label or track resets it; mobile browsers usually deliver a double tap as a double-click (not checked on every phone) |
| Landscape: the toolbar moves to the side | Phones held sideways: the dock becomes a rail on the right and panels open beside the picture |

Video on phones follows the same idea: the toolbar row folds into the transport (play,
frame steps, time, split, duplicate, delete, ⋯), the timeline is shorter, and touch has
its own gestures (tap selects, swipe scrolls, hold to move, pinch to zoom, trim handles
on the selected clip). iPhone video (HEVC, often HDR or Dolby Vision, index at the end of
a .MOV, a spatial-audio track beside the stereo one) is read without loading the file
into memory and decoded by WebCodecs, or by the browser's own player where only it can.

What we did not take: hold-to-compare (it would fight brush and heal strokes on the
photo; the Before/After buttons stay in the toolbar).

## Mobile web constraints

| Constraint | Consequence |
| --- | --- |
| iOS Safari kills tabs at roughly 300–400 MB on many iPhones and may then reload them in a loop; GPU memory above ~256 MB has crashed older devices. A 24 MP photo as an RGBA16F texture with mipmaps is ~260 MB. | `lite` profile: photos are kept on the GPU at most 4096 px on the long side (a 12 MP phone photo fits exactly), exports at most 4096 px, an idle target pool of 64 MB instead of 320 MB, and idle GPU memory is freed when the tab is hidden. The export dialog says so. |
| iOS renders to 16-bit float textures (`EXT_color_buffer_half_float`, ~100 %) but not 32-bit ones, and `OES_texture_float_linear` is on only about half of iOS devices. | Nothing to change: the pipeline already works in RGBA16F. |
| WebGL contexts are lost when Safari is backgrounded. | Already handled (`webglcontextlost` → `restore()`), and freeing memory when hidden makes it rarer. |
| Phones report a device pixel ratio of 3; rendering the viewer at 3× costs 2.25× the pixels of 2× with little visible gain. | Viewer canvases render at most 2 device pixels per CSS pixel. |
| `deviceMemory` exists only in Chromium; Safari does not expose memory. | The profile also uses the user agent (iPhone, Android, iPadOS reporting a touch Mac) and the screen. |
| Touch targets: Apple asks for 44 pt, Material for 48 dp. Inputs under 16 px make iOS zoom the page on focus. | `(pointer: coarse)` raises sliders to 36 px (58 px rows in a phone sheet), buttons to 32–34 px, dock buttons to 50 px, and inputs (slider values too) to 16 px. |
| Notches and home indicators; the URL bar changes the viewport height. | `viewport-fit=cover`, `env(safe-area-inset-*)` paddings, `100dvh`. |
| Sheets inside a scrolling page fight the page's own scroll. | The page never scrolls (`minmax(0, 1fr)` rows); the sheet body scrolls with `overscroll-behavior: contain`; the grip has `touch-action: none`. |
| iOS Safari drops the files of a file input that isn't in the document, can refuse to store photo-picker Files in IndexedDB, and converts photos according to the accept list. | Pickers stay in the document until they deliver (`chooseFiles`); originals are stored as bytes on iPhone and iPad; the photo library is asked for `image/*,video/*`. |
| Battery and GPU on phones. | The glow starts off (it can be switched on), the export marble holds still, and Remove Background uses its crossfade instead of the particle globe. Computers keep all of them. |

## Computers: resizable and hideable panels

- Each side panel has a drag handle on its inner edge (it highlights on hover). Drag it,
  or focus it and use the arrow keys; double-click returns to the default width. Widths
  are clamped (left 180–480 px, right 240–560 px) and remembered.
- Three toggles in the top bar show or hide the left panel (in Develop: presets,
  snapshots and history), the filmstrip and the right panel. Tab and Shift+F still work.
  The choices are remembered.
- Defaults are the old layout exactly, so nothing changes until the user changes it.

## Sources

- Adobe, *Adobe Photoshop Lightroom has a new mobile interface* (2023): https://blog.adobe.com/en/publish/2023/07/26/adobe-photoshop-lightroom-has-new-mobile-interface-make-editing-even-easier-on-go
- Adobe, *Edit photos in Lightroom for mobile (iOS)*: https://helpx.adobe.com/lightroom-cc/using/edit-photos-mobile-ios.html
- Adobe, *Gesture controls in Lightroom for mobile*: https://helpx.adobe.com/ee/lightroom/mobile/get-started/gesture-controls-in-lightroom-for-mobile.html
- Amateur Photographer, *Using Lightroom mobile editing*: https://amateurphotographer.com/technique/photo_editing/using-lightroom-mobile-editing/
- Adobe Community, Lightroom iPad toolbar position: https://community.adobe.com/t5/lightroom-ecosystem-cloud-based-discussions/toolbar-to-bottom/m-p/14781961
- iOS Safari memory and WebGL limits: https://abratabia.com/mobile-web-games/ios-safari-gotchas.php, https://bugs.webkit.org/show_bug.cgi?id=250862, https://forum.babylonjs.com/t/ios-cannot-open-an-app-on-ios-browsers-memory-limit/40698
- Half-float render targets on iOS: https://bugs.webkit.org/show_bug.cgi?id=217107, https://web3dsurvey.com/webgl/extensions/EXT_color_buffer_half_float, https://web3dsurvey.com/webgl2/extensions/OES_texture_float_linear
- Handling context loss: https://wikis.khronos.org/webgl/HandlingContextLost, https://discourse.threejs.org/t/context-lost-when-backgrounding-safari-on-ios-17-developer-beta-8/55772
- Device Memory API: https://developer.chrome.com/blog/device-memory
- iOS file inputs and storage: https://bugs.webkit.org/show_bug.cgi?id=201289, https://discourse.elm-lang.org/t/cross-browser-compatibility-fix-for-file-select-file-s-in-elm-file/3060, https://bugs.webkit.org/show_bug.cgi?id=188438, https://developer.apple.com/forums/thread/677374, https://bugs.webkit.org/show_bug.cgi?id=303803
- Bottom sheets (snap points, grip, scroll containment): https://www.eleken.co/blog-posts/bottom-sheet-ui, https://www.techinterview.org/post/3233475371/build-bottom-sheet-component-mobile-web/
