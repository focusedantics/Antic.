import { useStore } from "@/app/hooks";
import { Panel } from "@/components/Panel";
import { Slider } from "@/components/Slider";
import { effectById, newEffect } from "@/core/effects/registry";
import type { AudioFx, Segment, VisualFx } from "@/core/video/model";
import { beginVideoGesture, editVideo, endVideoGesture, video } from "@/core/video/session";
import { segmentIndexAt } from "@/core/video/timeline";
import { EffectParams } from "@/features/effects/EffectParams";
import { openEffectsBrowser } from "@/features/effects/EffectsBrowser";
import { changeSegments, chopAndShuffle, clearTreatments, editor, POOPISMS, randomPoop, resetAudio, resetPicture, targetIds, togglePoopism } from "./actions";
import { engine, player } from "./engine";
import { formatClock } from "./format";

const gesture = (label: string) => ({ onGestureStart: () => beginVideoGesture(label), onGestureEnd: endVideoGesture });

/** The segment the inspector shows: the first selected one, else the one under the playhead. */
function useFocused(): { segment: Segment | null; index: number; count: number } {
  const edit = useStore(video, (s) => s.edit);
  const selection = useStore(editor, (s) => s.selection);
  const frame = useStore(player, (s) => s.frame);
  // Re-render when the timeline is (re)compiled, so "the segment under the playhead" is current.
  useStore(player, (s) => s.frames);
  if (!edit) return { segment: null, index: -1, count: 0 };
  const sel = edit.segments.findIndex((s) => selection.includes(s.id));
  const index = sel >= 0 ? sel : engine.plan ? segmentIndexAt(engine.plan, frame) : -1;
  return { segment: edit.segments[index] ?? null, index, count: selection.length || (index >= 0 ? 1 : 0) };
}

function Check({ label, checked, onChange, hint }: { label: string; checked: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <label className="check" title={hint}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    </label>
  );
}

export function PoopPanel() {
  const { segment, count } = useFocused();
  return (
    <Panel id="vid-poop" title="YTP">
      {!segment ? (
        <p className="faint">Select a segment on the timeline.</p>
      ) : (
        <>
          <p className="faint" style={{ marginTop: 0, fontSize: 11 }}>
            {count > 1 ? `Applies to ${count} selected segments.` : "Applies to the selected segment (or the one under the playhead)."} Cut with S, then treat each piece.
          </p>
          <div className="poop-grid">
            {POOPISMS.map((p) => (
              <button key={p.id} type="button" className="btn small" aria-pressed={p.active(segment)} title={p.hint} onClick={() => togglePoopism(p)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="row wrap" style={{ marginTop: 8, gap: 6 }}>
            <button type="button" className="btn small" title="Give each selected segment one to three random treatments" onClick={() => randomPoop()}>
              🎲 Random poop
            </button>
            <button type="button" className="btn small" title="Sentence mixing: chop the selected segments into short pieces, shuffle and treat some" onClick={() => chopAndShuffle()}>
              ✂ Chop &amp; shuffle
            </button>
            <button type="button" className="btn small ghost" onClick={clearTreatments}>
              Clear
            </button>
          </div>
        </>
      )}
    </Panel>
  );
}

export function SegmentPanel() {
  const { segment: s, index } = useFocused();
  const clips = useStore(video, (st) => st.clips);
  if (!s) return null;
  const set = (label: string, change: (x: Segment) => Segment) => changeSegments(label, change);
  const setAudio = (label: string, patch: Partial<AudioFx>) => set(label, (x) => ({ ...x, audio: { ...x.audio, ...patch } }));
  const setVisual = (label: string, patch: Partial<VisualFx>) => set(label, (x) => ({ ...x, visual: { ...x.visual, ...patch } }));
  const source = s.clip ? (clips.find((c) => c.id === s.clip)?.name ?? "another clip") : "this clip";
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const ids = targetIds();
  const chooseEffect = () =>
    openEffectsBrowser({
      mode: "custom",
      current: s.effect?.id ?? null,
      image: () => engine.grab(),
      onPick: (id) => changeSegments(`Segment effect: ${effectById(id)?.name ?? id}`, (x) => ({ ...x, effect: newEffect(id), effectMix: x.effectMix || 1 }), ids),
    });
  return (
    <>
      <Panel id="vid-timing" title={`Segment ${index + 1} · Timing`}>
        <p className="faint num" style={{ marginTop: 0, fontSize: 11 }}>
          {formatClock(s.in)}–{formatClock(s.out)} of {source}
        </p>
        <Slider label="Speed" value={s.speed} min={0.1} max={8} step={0.05} defaultValue={1} format={(v) => `${v.toFixed(2)}×`} {...gesture("Speed")} onChange={(v) => set("Speed", (x) => ({ ...x, speed: v }))} />
        <Check label="Keep pitch when changing speed" checked={s.keepPitch} hint="Off: tape-style (faster = higher). On: time-stretch, same voice." onChange={(v) => set("Keep pitch", (x) => ({ ...x, keepPitch: v }))} />
        <Check label="Reverse" checked={s.reverse} onChange={(v) => set("Reverse", (x) => ({ ...x, reverse: v }))} />
        <Slider label="Stutter" value={s.stutter} min={1} max={16} defaultValue={1} format={(v) => (v <= 1 ? "off" : `${v}×`)} {...gesture("Stutter")} onChange={(v) => set("Stutter", (x) => ({ ...x, stutter: v }))} />
        {s.stutter > 1 && (
          <Slider label="Stutter len." value={Math.round(s.stutterLength * 1000)} min={20} max={1000} step={10} defaultValue={120} format={(v) => `${v}ms`} {...gesture("Stutter length")} onChange={(v) => set("Stutter length", (x) => ({ ...x, stutterLength: v / 1000 }))} />
        )}
        <Slider label="Dance" value={s.pingPong} min={0} max={8} defaultValue={0} format={(v) => (v ? `${v}×` : "off")} {...gesture("Dance")} onChange={(v) => set("Dance", (x) => ({ ...x, pingPong: v }))} />
        <Slider label="Stare down" value={s.hold} min={0} max={5} step={0.1} defaultValue={0} format={(v) => (v ? `${v.toFixed(1)} s` : "off")} {...gesture("Stare down")} onChange={(v) => set("Stare down", (x) => ({ ...x, hold: v }))} />
      </Panel>
      <Panel id="vid-sound" title="Sound">
        <Slider label="Pitch" value={s.pitch} min={-24} max={24} defaultValue={0} origin={0} format={(v) => `${v > 0 ? "+" : ""}${v} st`} {...gesture("Pitch")} onChange={(v) => set("Pitch", (x) => ({ ...x, pitch: v }))} />
        <Slider label="Volume" value={s.volume} min={-40} max={24} defaultValue={0} origin={0} format={(v) => `${v > 0 ? "+" : ""}${v} dB`} {...gesture("Volume")} onChange={(v) => set("Volume", (x) => ({ ...x, volume: v }))} />
        <Check label="Mute" checked={s.mute} onChange={(v) => set("Mute", (x) => ({ ...x, mute: v }))} />
        <Slider label="Ear rape" value={Math.round(s.audio.earrape * 100)} min={0} max={100} defaultValue={0} format={(v) => pct(v / 100)} {...gesture("Ear rape")} onChange={(v) => setAudio("Ear rape", { earrape: v / 100 })} />
        <Slider label="Sus" value={Math.round(s.audio.sus * 100)} min={0} max={100} defaultValue={0} format={(v) => pct(v / 100)} {...gesture("Sus")} onChange={(v) => setAudio("Sus", { sus: v / 100 })} />
        <Slider label="Echo" value={Math.round(s.audio.echo * 100)} min={0} max={100} defaultValue={0} format={(v) => pct(v / 100)} {...gesture("Echo")} onChange={(v) => setAudio("Echo", { echo: v / 100 })} />
        {s.audio.echo > 0 && (
          <Slider label="Echo delay" value={Math.round(s.audio.echoTime * 1000)} min={20} max={1000} step={10} defaultValue={250} format={(v) => `${v}ms`} {...gesture("Echo delay")} onChange={(v) => setAudio("Echo delay", { echoTime: v / 1000 })} />
        )}
        <Slider label="Reverb" value={Math.round(s.audio.reverb * 100)} min={0} max={100} defaultValue={0} format={(v) => pct(v / 100)} {...gesture("Reverb")} onChange={(v) => setAudio("Reverb", { reverb: v / 100 })} />
        <Slider label="Chorus" value={Math.round(s.audio.chorus * 100)} min={0} max={100} defaultValue={0} format={(v) => pct(v / 100)} {...gesture("Chorus")} onChange={(v) => setAudio("Chorus", { chorus: v / 100 })} />
        <Slider label="Vibrato" value={Math.round(s.audio.vibrato * 100)} min={0} max={100} defaultValue={0} format={(v) => pct(v / 100)} {...gesture("Vibrato")} onChange={(v) => setAudio("Vibrato", { vibrato: v / 100 })} />
        <Slider label="Bitcrush" value={Math.round(s.audio.bitcrush * 100)} min={0} max={100} defaultValue={0} format={(v) => pct(v / 100)} {...gesture("Bitcrush")} onChange={(v) => setAudio("Bitcrush", { bitcrush: v / 100 })} />
        <button type="button" className="btn small ghost" onClick={resetAudio}>
          Reset sound
        </button>
      </Panel>
      <Panel id="vid-picture" title="Picture">
        <div className="row wrap" style={{ gap: 10 }}>
          <Check label="Mirror" checked={s.visual.mirror} onChange={(v) => setVisual("Mirror", { mirror: v })} />
          <Check label="Flip" checked={s.visual.flip} onChange={(v) => setVisual("Flip", { flip: v })} />
          <Check label="Invert" checked={s.visual.invert} onChange={(v) => setVisual("Invert", { invert: v })} />
          <Check label="Rainbow" checked={s.visual.rainbow} onChange={(v) => setVisual("Rainbow", { rainbow: v })} />
        </div>
        <Slider label="Hue" value={s.visual.hue} min={-180} max={180} defaultValue={0} origin={0} format={(v) => `${v}°`} {...gesture("Hue")} onChange={(v) => setVisual("Hue", { hue: v })} />
        <Slider label="Zoom" value={s.visual.zoom} min={1} max={4} step={0.05} defaultValue={1} format={(v) => `${v.toFixed(2)}×`} {...gesture("Zoom")} onChange={(v) => setVisual("Zoom", { zoom: v })} />
        <Slider label="Shake" value={Math.round(s.visual.shake * 100)} min={0} max={100} defaultValue={0} format={(v) => pct(v / 100)} {...gesture("Shake")} onChange={(v) => setVisual("Shake", { shake: v / 100 })} />
        <Slider label="Deep fry" value={Math.round(s.visual.contrast * 100)} min={0} max={100} defaultValue={0} format={(v) => pct(v / 100)} {...gesture("Deep fry")} onChange={(v) => setVisual("Deep fry", { contrast: v / 100 })} />
        <button type="button" className="btn small ghost" onClick={resetPicture}>
          Reset picture
        </button>
      </Panel>
      <Panel id="vid-seg-effect" title="Segment effect" defaultOpen={false}>
        {!s.effect ? (
          <button type="button" className="btn small" onClick={chooseEffect}>
            ✦ Add effect to segment…
          </button>
        ) : (
          <>
            <Slider label="Strength" value={Math.round(s.effectMix * 100)} min={0} max={100} defaultValue={100} origin={0} format={(v) => `${v}%`} {...gesture("Effect strength")} onChange={(v) => set("Effect strength", (x) => ({ ...x, effectMix: v / 100 }))} />
            <EffectParams
              effect={s.effect}
              onParam={(key, label, value) => set(label, (x) => (x.effect ? { ...x, effect: { ...x.effect, params: { ...x.effect.params, [key]: value } } } : x))}
              onGestureStart={beginVideoGesture}
              onGestureEnd={endVideoGesture}
              onReset={(fresh) => set("Reset effect", (x) => ({ ...x, effect: fresh }))}
              onChangeEffect={chooseEffect}
            />
            <button type="button" className="btn small ghost danger" onClick={() => set("Remove segment effect", (x) => ({ ...x, effect: null }))}>
              Remove effect
            </button>
          </>
        )}
      </Panel>
    </>
  );
}

/** The whole-video effect (what Looks save and apply). */
export function VideoEffectPanel() {
  const edit = useStore(video, (s) => s.edit);
  if (!edit) return null;
  const choose = () =>
    openEffectsBrowser({
      mode: "custom",
      current: edit.effect?.id ?? null,
      image: () => engine.grab(),
      onPick: (id) => editVideo(`Effect: ${effectById(id)?.name ?? id}`, (e) => ({ ...e, effect: newEffect(id), effectMix: e.effectMix || 1 })),
    });
  return (
    <Panel id="vid-effect" title="Whole-video effect" defaultOpen={!!edit.effect}>
      {!edit.effect ? (
        <>
          <p className="faint" style={{ marginTop: 0 }}>
            Stylize every frame: ASCII, halftone, VHS, glitch, neon edges and more.
          </p>
          <button type="button" className="btn small" onClick={choose}>
            ✦ Add effect…
          </button>
        </>
      ) : (
        <>
          <Slider label="Strength" value={Math.round(edit.effectMix * 100)} min={0} max={100} defaultValue={100} origin={0} format={(v) => `${v}%`} {...gesture("Effect strength")} onChange={(v) => editVideo("Effect strength", (e) => ({ ...e, effectMix: v / 100 }))} />
          <EffectParams
            effect={edit.effect}
            onParam={(key, label, value) => editVideo(label, (e) => (e.effect ? { ...e, effect: { ...e.effect, params: { ...e.effect.params, [key]: value } } } : e))}
            onGestureStart={beginVideoGesture}
            onGestureEnd={endVideoGesture}
            onReset={(fresh) => editVideo("Reset effect", (e) => ({ ...e, effect: fresh }))}
            onChangeEffect={choose}
          />
          <button type="button" className="btn small ghost danger" style={{ marginTop: 4 }} onClick={() => editVideo("Remove effect", (e) => ({ ...e, effect: null }))}>
            Remove effect
          </button>
        </>
      )}
    </Panel>
  );
}
