import { toast } from "@/app/state";
import { apply, outputToSource } from "@/core/develop/geometry";
import { develop, editRecipe } from "@/core/develop/session";
import { neutralize } from "@/core/develop/white-balance";
import { developEngine } from "@/core/gpu/develop-engine";

let stopActive: (() => void) | null = null;

/** White balance selector: the next click on the photo neutralizes that spot. */
export function startEyedropper() {
  const engine = developEngine();
  if (stopActive) {
    stopActive();
    return;
  }
  const canvas = engine.canvas;
  canvas.style.cursor = "crosshair";
  toast("Click something that should be neutral gray. Esc cancels.");
  const onDown = (e: PointerEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const { assetId, recipe, info } = develop.getState();
    const source = assetId ? engine.sourceFor(assetId) : null;
    stop();
    if (!source || !recipe || !info) return;
    const [u, v] = engine.clientToOutput(e.clientX, e.clientY);
    if (u < 0 || v < 0 || u > 1 || v > 1) return;
    const [sx, sy] = apply(outputToSource(source.size, recipe.geometry), u, v);
    // Average a small patch (about 0.5 % of the photo) to ignore noise.
    const r = 0.004;
    const px = engine.pipelineRef.sampleSource(source, 8, 8, { x: sx - r, y: sy - r, width: 2 * r, height: 2 * r });
    const avg: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < px.length; i += 4) {
      avg[0] += px[i];
      avg[1] += px[i + 1];
      avg[2] += px[i + 2];
    }
    const n = px.length / 4;
    const wb = neutralize([avg[0] / n, avg[1] / n, avg[2] / n], info);
    editRecipe("White Balance Selector", (rec) => ({ ...rec, whiteBalance: { mode: "custom", ...wb } }));
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") stop();
  };
  canvas.addEventListener("pointerdown", onDown, { capture: true });
  window.addEventListener("keydown", onKey);
  stopActive = stop;
  function stop() {
    canvas.removeEventListener("pointerdown", onDown, { capture: true });
    window.removeEventListener("keydown", onKey);
    canvas.style.cursor = "";
    stopActive = null;
  }
}
