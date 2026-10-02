import { useStore } from "@/app/hooks";
import { Panel } from "@/components/Panel";
import { formatSigned, Slider } from "@/components/Slider";
import { basicRanges, temperatureRange, tintRange } from "@/core/develop/params";
import type { Profile } from "@/core/develop/recipe";
import { beginGesture, develop, editRecipe, endGesture } from "@/core/develop/session";
import { averageNeutral, neutralize } from "@/core/develop/white-balance";
import { developEngine } from "@/core/gpu/develop-engine";
import { RecipeSlider, TEMPERATURE_TRACK, TINT_TRACK, useRecipe } from "../edit";
import { startEyedropper } from "../tools/eyedropper";

const rawPresets = [
  { id: "daylight", label: "Daylight", temperature: 5500, tint: 10 },
  { id: "cloudy", label: "Cloudy", temperature: 6500, tint: 10 },
  { id: "shade", label: "Shade", temperature: 7500, tint: 10 },
  { id: "tungsten", label: "Tungsten", temperature: 2850, tint: 0 },
  { id: "fluorescent", label: "Fluorescent", temperature: 3800, tint: 21 },
  { id: "flash", label: "Flash", temperature: 5500, tint: 0 },
];

export function autoWhiteBalance() {
  const { assetId, info } = develop.getState();
  const engine = developEngine();
  const source = assetId ? engine.sourceFor(assetId) : null;
  if (!source || !info) return;
  const pixels = engine.pipelineRef.sampleSource(source, 64, 64);
  const wb = neutralize(averageNeutral(pixels), info);
  editRecipe("Auto White Balance", (r) => ({ ...r, whiteBalance: { mode: "auto", ...wb } }));
}

// Kelvin is perceptually uneven, so the RAW temperature slider moves in (negative) mired:
// equal steps look like equal changes, and left stays cool like Lightroom.
const toMired = (k: number) => -1e6 / k;
const fromMired = (m: number) => Math.round(-1e6 / m / 50) * 50;

export function WhiteBalance() {
  const recipe = useRecipe();
  const info = useStore(develop, (s) => s.info);
  if (!recipe || !info) return null;
  const wb = recipe.whiteBalance;
  const raw = info.raw;
  const tRange = raw ? temperatureRange.raw : temperatureRange.rendered;
  const tintR = raw ? tintRange.raw : tintRange.rendered;
  const asShot = raw ? (info.asShot ?? { temperature: 5500, tint: 0 }) : { temperature: 0, tint: 0 };
  const preset =
    wb.mode === "as-shot"
      ? "as-shot"
      : wb.mode === "auto"
        ? "auto"
        : (raw && rawPresets.find((p) => p.temperature === wb.temperature && p.tint === wb.tint)?.id) || "custom";
  const choose = (id: string) => {
    if (id === "auto") return autoWhiteBalance();
    if (id === "as-shot") return editRecipe("White Balance: As Shot", (r) => ({ ...r, whiteBalance: { mode: "as-shot", ...asShot } }));
    const p = rawPresets.find((x) => x.id === id);
    if (p) editRecipe(`White Balance: ${p.label}`, (r) => ({ ...r, whiteBalance: { mode: "custom", temperature: p.temperature, tint: p.tint } }));
  };
  const setWb = (field: "temperature" | "tint", value: number) =>
    editRecipe(field === "temperature" ? "Temperature" : "Tint", (r) => ({ ...r, whiteBalance: { ...r.whiteBalance, mode: "custom", [field]: value } }));
  return (
    <>
      <div className="row" style={{ marginBottom: 6 }}>
        <span className="dim" style={{ width: 78 }}>
          WB
        </span>
        <select className="input" style={{ flex: 1 }} aria-label="White balance preset" value={preset} onChange={(e) => choose(e.target.value)}>
          <option value="as-shot">As Shot</option>
          <option value="auto">Auto</option>
          {raw && rawPresets.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          <option value="custom" disabled>
            Custom
          </option>
        </select>
        <button type="button" className="btn small" title="White balance selector: click something neutral (W)" aria-label="White balance selector" onClick={() => startEyedropper()}>
          ⌖
        </button>
      </div>
      {raw ? (
        <Slider
          label="Temp"
          value={toMired(wb.temperature)}
          min={toMired(tRange.min)}
          max={toMired(tRange.max)}
          step={0.01}
          defaultValue={toMired(asShot.temperature)}
          track={TEMPERATURE_TRACK}
          format={(v) => `${fromMired(v)}`}
          onGestureStart={() => beginGesture("Temperature")}
          onGestureEnd={endGesture}
          onChange={(v) => setWb("temperature", fromMired(v))}
        />
      ) : (
        <Slider
          label="Temp"
          value={wb.temperature}
          min={tRange.min}
          max={tRange.max}
          defaultValue={0}
          track={TEMPERATURE_TRACK}
          format={(v) => formatSigned(v)}
          onGestureStart={() => beginGesture("Temperature")}
          onGestureEnd={endGesture}
          onChange={(v) => setWb("temperature", v)}
        />
      )}
      <Slider
        label="Tint"
        value={wb.tint}
        min={tintR.min}
        max={tintR.max}
        defaultValue={asShot.tint}
        track={TINT_TRACK}
        onGestureStart={() => beginGesture("Tint")}
        onGestureEnd={endGesture}
        onChange={(v) => setWb("tint", v)}
      />
    </>
  );
}

/** Colour or black and white (on a phone it heads the Color group, like Lightroom's B&W). */
export function ProfileControls() {
  const recipe = useRecipe();
  const info = useStore(develop, (s) => s.info);
  if (!recipe) return null;
  const setProfile = (profile: Profile) => editRecipe(`Profile: ${profile === "color" ? "Color" : "Monochrome"}`, (r) => ({ ...r, profile }));
  return (
    <div className="row" style={{ marginBottom: 8 }}>
      <span className="dim" style={{ width: 78 }}>
        Profile
      </span>
      <div className="segmented">
        <button type="button" aria-pressed={recipe.profile === "color"} onClick={() => setProfile("color")}>
          Color
        </button>
        <button type="button" aria-pressed={recipe.profile === "monochrome"} onClick={() => setProfile("monochrome")}>
          B&W
        </button>
      </div>
      {info?.raw && (
        <span className="faint" title="Camera RAW gets a filmic base tone curve, like a camera profile">
          + base curve
        </span>
      )}
    </div>
  );
}

export function ToneSliders() {
  return (
    <>
      <RecipeSlider group="basic" field="exposure" range={basicRanges.exposure} />
      <RecipeSlider group="basic" field="contrast" range={basicRanges.contrast} />
      <RecipeSlider group="basic" field="highlights" range={basicRanges.highlights} />
      <RecipeSlider group="basic" field="shadows" range={basicRanges.shadows} />
      <RecipeSlider group="basic" field="whites" range={basicRanges.whites} />
      <RecipeSlider group="basic" field="blacks" range={basicRanges.blacks} />
    </>
  );
}

/** Texture, Clarity, Dehaze (Lightroom mobile files them under Effects). */
export function PresenceSliders() {
  return (
    <>
      <RecipeSlider group="basic" field="texture" range={basicRanges.texture} />
      <RecipeSlider group="basic" field="clarity" range={basicRanges.clarity} />
      <RecipeSlider group="basic" field="dehaze" range={basicRanges.dehaze} />
    </>
  );
}

export function SaturationSliders() {
  return (
    <>
      <RecipeSlider group="basic" field="vibrance" range={basicRanges.vibrance} />
      <RecipeSlider group="basic" field="saturation" range={basicRanges.saturation} />
    </>
  );
}

export function BasicPanel() {
  const recipe = useRecipe();
  if (!recipe) return null;
  return (
    <Panel id="dev-basic" title="Basic">
      <ProfileControls />
      <WhiteBalance />
      <div className="subhead">Tone</div>
      <ToneSliders />
      <div className="subhead">Presence</div>
      <PresenceSliders />
      <SaturationSliders />
    </Panel>
  );
}
