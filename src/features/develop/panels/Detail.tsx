import { useStore } from "@/app/hooks";
import { Panel } from "@/components/Panel";
import { formatSigned } from "@/components/Slider";
import { defaultDetail } from "@/core/develop/defaults";
import { detailRanges, effectsRanges, opticsRanges } from "@/core/develop/params";
import { develop } from "@/core/develop/session";
import { RecipeSlider } from "../edit";

const plain = (v: number) => formatSigned(v).replace("+", "");

function useDetailDefaults() {
  const raw = useStore(develop, (s) => s.info?.raw ?? false);
  return defaultDetail(raw);
}

export function SharpeningSliders() {
  const d = useDetailDefaults();
  return (
    <>
      <RecipeSlider group="detail" field="sharpenAmount" range={detailRanges.sharpenAmount} defaultValue={d.sharpenAmount} format={plain} />
      <RecipeSlider group="detail" field="sharpenRadius" range={detailRanges.sharpenRadius} defaultValue={d.sharpenRadius} format={(v) => v.toFixed(1)} />
      <RecipeSlider group="detail" field="sharpenDetail" range={detailRanges.sharpenDetail} defaultValue={d.sharpenDetail} format={plain} />
      <RecipeSlider group="detail" field="sharpenMasking" range={detailRanges.sharpenMasking} defaultValue={d.sharpenMasking} format={plain} />
    </>
  );
}

export function NoiseSliders() {
  const d = useDetailDefaults();
  return (
    <>
      <RecipeSlider group="detail" field="noiseLuminance" range={detailRanges.noiseLuminance} defaultValue={d.noiseLuminance} format={plain} />
      <RecipeSlider group="detail" field="noiseDetail" range={detailRanges.noiseDetail} defaultValue={d.noiseDetail} format={plain} />
      <RecipeSlider group="detail" field="noiseColor" range={detailRanges.noiseColor} defaultValue={d.noiseColor} format={plain} />
    </>
  );
}

export function DetailControls() {
  return (
    <>
      <p className="faint" style={{ fontSize: 10, margin: "0 0 6px" }}>
        Sharpening and noise reduction show fully at 100% zoom (press 2).
      </p>
      <div className="subhead">Sharpening</div>
      <SharpeningSliders />
      <div className="subhead">Noise Reduction</div>
      <NoiseSliders />
    </>
  );
}

export const DetailPanel = () => (
  <Panel id="dev-detail" title="Detail" defaultOpen={false}>
    <DetailControls />
  </Panel>
);

export function LensControls() {
  return (
    <>
      <div className="subhead">Manual</div>
      <RecipeSlider group="optics" field="distortion" range={opticsRanges.distortion} />
      <RecipeSlider group="optics" field="vignetting" range={opticsRanges.vignetting} />
      <RecipeSlider group="optics" field="vignettingMidpoint" range={opticsRanges.vignettingMidpoint} defaultValue={50} format={plain} />
    </>
  );
}

export const LensPanel = () => (
  <Panel id="dev-lens" title="Lens Corrections" defaultOpen={false}>
    <LensControls />
  </Panel>
);

export function VignetteSliders() {
  return (
    <>
      <RecipeSlider group="effects" field="vignetteAmount" range={effectsRanges.vignetteAmount} />
      <RecipeSlider group="effects" field="vignetteMidpoint" range={effectsRanges.vignetteMidpoint} defaultValue={50} format={plain} />
      <RecipeSlider group="effects" field="vignetteRoundness" range={effectsRanges.vignetteRoundness} />
      <RecipeSlider group="effects" field="vignetteFeather" range={effectsRanges.vignetteFeather} defaultValue={50} format={plain} />
    </>
  );
}

export function GrainSliders() {
  return (
    <>
      <RecipeSlider group="effects" field="grainAmount" range={effectsRanges.grainAmount} format={plain} />
      <RecipeSlider group="effects" field="grainSize" range={effectsRanges.grainSize} defaultValue={25} format={plain} />
      <RecipeSlider group="effects" field="grainRoughness" range={effectsRanges.grainRoughness} defaultValue={50} format={plain} />
    </>
  );
}

export function EffectsControls() {
  return (
    <>
      <div className="subhead">Post-Crop Vignetting</div>
      <VignetteSliders />
      <div className="subhead">Grain</div>
      <GrainSliders />
    </>
  );
}

export const EffectsPanel = () => (
  <Panel id="dev-effects" title="Effects" defaultOpen={false}>
    <EffectsControls />
  </Panel>
);
