import { type PointerEvent, useEffect, useState } from "react";
import { useStore } from "@/app/hooks";
import { Panel } from "@/components/Panel";
import { formatSigned, Slider } from "@/components/Slider";
import { fullCrop } from "@/core/develop/defaults";
import { constrainCrop, frameSize } from "@/core/develop/geometry";
import type { Geometry } from "@/core/develop/recipe";
import { beginGesture, develop, editRecipe, endGesture } from "@/core/develop/session";
import { developEngine } from "@/core/gpu/develop-engine";
import { clamp } from "@/lib/math";

type Crop = Geometry["crop"];

const aspects: { label: string; value: number | null | "original" }[] = [
  { label: "Free", value: null },
  { label: "Original", value: "original" },
  { label: "1 : 1", value: 1 },
  { label: "4 : 5", value: 4 / 5 },
  { label: "5 : 4", value: 5 / 4 },
  { label: "2 : 3", value: 2 / 3 },
  { label: "3 : 2", value: 3 / 2 },
  { label: "16 : 9", value: 16 / 9 },
  { label: "9 : 16", value: 9 / 16 },
];

function setGeometry(label: string, patch: Partial<Geometry>) {
  editRecipe(label, (r) => ({ ...r, geometry: { ...r.geometry, ...patch } }));
}

function sourceSize() {
  const { assetId } = develop.getState();
  const src = assetId ? developEngine().sourceFor(assetId) : null;
  return src?.size ?? { width: 3, height: 2 };
}

/** Crop rectangle with aspect `aspect` (pixel width / height) centered in the frame. */
function fitAspect(g: Geometry, aspect: number): Crop {
  const frame = frameSize(sourceSize(), g);
  const frameAspect = frame.width / frame.height;
  const n = aspect / frameAspect;
  const width = n >= 1 ? 1 : n;
  const height = n >= 1 ? 1 / n : 1;
  return constrainCrop(frame, g.angle, { x: (1 - width) / 2, y: (1 - height) / 2, width, height });
}

export function CropPanel() {
  const geometry = useStore(develop, (s) => s.recipe?.geometry);
  if (!geometry) return null;
  const frame = frameSize(sourceSize(), geometry);
  const currentAspect = geometry.aspect;
  const straighten = (angle: number) => {
    const crop = constrainCrop(frame, angle, geometry.crop.width === 1 && geometry.crop.height === 1 ? fullCrop : geometry.crop);
    setGeometry("Straighten", { angle, crop: geometry.angle === 0 && angle !== 0 ? constrainCrop(frame, angle, fullCrop) : crop });
  };
  return (
    <Panel id="dev-crop" title="Crop & Straighten">
      <div className="row wrap" style={{ marginBottom: 8 }}>
        <label className="field" style={{ flex: 1 }}>
          <span>Aspect</span>
          <select
            className="input"
            value={currentAspect === null ? "Free" : (aspects.find((a) => typeof a.value === "number" && Math.abs(a.value - currentAspect) < 1e-3)?.label ?? "Original")}
            onChange={(e) => {
              const choice = aspects.find((a) => a.label === e.target.value)!;
              if (choice.value === null) return setGeometry("Crop aspect: Free", { aspect: null });
              const aspect = choice.value === "original" ? frame.width / frame.height : choice.value;
              setGeometry(`Crop aspect: ${choice.label}`, { aspect, crop: fitAspect(geometry, aspect) });
            }}
          >
            {aspects.map((a) => (
              <option key={a.label}>{a.label}</option>
            ))}
          </select>
        </label>
      </div>
      <Slider
        label="Angle"
        value={geometry.angle}
        min={-45}
        max={45}
        step={0.1}
        defaultValue={0}
        format={(v) => `${formatSigned(v, 0.1)}°`}
        onGestureStart={() => beginGesture("Straighten")}
        onGestureEnd={endGesture}
        onChange={straighten}
      />
      <div className="row wrap" style={{ marginTop: 8 }}>
        <button type="button" className="btn small" title="Rotate left" onClick={() => setGeometry("Rotate left", { rotate90: (geometry.rotate90 + 3) % 4, crop: fullCrop, aspect: geometry.aspect ? 1 / geometry.aspect : null })}>
          ⟲ 90°
        </button>
        <button type="button" className="btn small" title="Rotate right" onClick={() => setGeometry("Rotate right", { rotate90: (geometry.rotate90 + 1) % 4, crop: fullCrop, aspect: geometry.aspect ? 1 / geometry.aspect : null })}>
          ⟳ 90°
        </button>
        <button type="button" className="btn small" aria-pressed={geometry.flipHorizontal} onClick={() => setGeometry("Flip horizontal", { flipHorizontal: !geometry.flipHorizontal })}>
          Flip H
        </button>
        <button type="button" className="btn small" aria-pressed={geometry.flipVertical} onClick={() => setGeometry("Flip vertical", { flipVertical: !geometry.flipVertical })}>
          Flip V
        </button>
        <button type="button" className="btn small" onClick={() => setGeometry("Reset crop", { crop: fullCrop, angle: 0, aspect: null })}>
          Reset
        </button>
      </div>
      <div className="subhead">Transform</div>
      <Slider label="Vertical" value={geometry.vertical} min={-100} max={100} defaultValue={0} onGestureStart={() => beginGesture("Vertical")} onGestureEnd={endGesture} onChange={(v) => setGeometry("Vertical", { vertical: v })} />
      <Slider label="Horizontal" value={geometry.horizontal} min={-100} max={100} defaultValue={0} onGestureStart={() => beginGesture("Horizontal")} onGestureEnd={endGesture} onChange={(v) => setGeometry("Horizontal", { horizontal: v })} />
      <p className="faint" style={{ fontSize: 10 }}>
        Drag inside the frame to move it, drag edges or corners to resize. Enter or R applies; Esc resets.
      </p>
    </Panel>
  );
}

type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/**
 * Crop overlay. While cropping the photo is rendered uncropped (straightened),
 * so the crop rectangle's frame coordinates are exactly this view's output uv.
 */
export function CropOverlay() {
  const recipe = useStore(develop, (s) => s.recipe);
  const [, force] = useState(0);
  useEffect(() => {
    const engine = developEngine();
    const previous = engine.onFrame;
    engine.onFrame = () => force((n) => n + 1);
    return () => {
      engine.onFrame = previous;
    };
  }, []);
  if (!recipe) return null;
  const g = recipe.geometry;
  const engine = developEngine();
  const [x0, y0] = engine.outputToClient(g.crop.x, g.crop.y);
  const [x1, y1] = engine.outputToClient(g.crop.x + g.crop.width, g.crop.y + g.crop.height);
  const rect = engine.canvas.getBoundingClientRect();
  const box = { left: x0 - rect.left, top: y0 - rect.top, width: x1 - x0, height: y1 - y0 };
  const frame = frameSize(sourceSize(), g);

  const start = (handle: Handle) => (e: PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const [su, sv] = engine.clientToOutput(e.clientX, e.clientY);
    const startCrop = g.crop;
    const aspect = g.aspect ? g.aspect / (frame.width / frame.height) : null;
    beginGesture("Crop");
    const move = (ev: globalThis.PointerEvent) => {
      const [u, v] = engine.clientToOutput(ev.clientX, ev.clientY);
      const du = u - su;
      const dv = v - sv;
      let { x, y, width, height } = startCrop;
      if (handle === "move") {
        x = clamp(x + du, 0, 1 - width);
        y = clamp(y + dv, 0, 1 - height);
      } else {
        let left = x;
        let top = y;
        let right = x + width;
        let bottom = y + height;
        if (handle.includes("w")) left = clamp(left + du, 0, right - 0.02);
        if (handle.includes("e")) right = clamp(right + du, left + 0.02, 1);
        if (handle.includes("n")) top = clamp(top + dv, 0, bottom - 0.02);
        if (handle.includes("s")) bottom = clamp(bottom + dv, top + 0.02, 1);
        width = right - left;
        height = bottom - top;
        if (aspect) {
          // Keep the aspect: the dragged dimension leads, the other follows.
          if (handle === "n" || handle === "s") width = height * aspect;
          else height = width / aspect;
          if (handle.includes("w")) left = right - width;
          if (handle.includes("n")) top = bottom - height;
          if (left < 0 || top < 0 || left + width > 1 || top + height > 1) return;
        }
        x = left;
        y = top;
      }
      const crop = constrainCrop(frame, g.angle, { x, y, width, height });
      editRecipe("Crop", (r) => ({ ...r, geometry: { ...r.geometry, crop } }));
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      endGesture();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const handles: Handle[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
  const pos = (h: Handle) => ({
    left: h.includes("w") ? -6 : h.includes("e") ? box.width - 6 : box.width / 2 - 6,
    top: h.includes("n") ? -6 : h.includes("s") ? box.height - 6 : box.height / 2 - 6,
    cursor: `${h}-resize`,
  });
  return (
    <div className="crop-layer">
      <div className="crop-box" style={box} onPointerDown={start("move")}>
        <div className="crop-grid" />
        {handles.map((h) => (
          <div key={h} className="crop-handle" style={pos(h)} onPointerDown={start(h)} />
        ))}
      </div>
    </div>
  );
}
