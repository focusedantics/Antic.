import { type ReactNode, useLayoutEffect, useRef } from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "@/app/hooks";
import { Icon, type IconName } from "@/components/icons";
import { PresenceSliders, ProfileControls, SaturationSliders, ToneSliders, WhiteBalance } from "./Basic";
import { ColorGradingControls, ColorMixerControls } from "./Color";
import { GrainSliders, LensControls, NoiseSliders, SharpeningSliders, VignetteSliders } from "./Detail";
import { CurveBar } from "./ToneCurve";

type Part = { id: string; label: string; body: () => ReactNode };
/** A group shows `body`, or, when it has `parts`, one part at a time under sub-tabs (Effects · Vignette · Grain). */
type Group = { id: string; label: string; icon: IconName; body?: () => ReactNode; parts?: readonly Part[] };

// Lightroom mobile's groups. Texture, Clarity and Dehaze sit under Effects and
// Vibrance and Saturation under Color there, so they do here too.
const groups: readonly Group[] = [
  { id: "light", label: "Light", icon: "light", body: () => <ToneSliders /> },
  // The curve is drawn over the photo; the panel shrinks to a bar (CurveBar).
  { id: "curve", label: "Curve", icon: "curve" },
  {
    id: "color",
    label: "Color",
    icon: "color",
    body: () => (
      <>
        <ProfileControls />
        <WhiteBalance />
        <SaturationSliders />
      </>
    ),
  },
  { id: "mixer", label: "Mixer", icon: "mixer", body: () => <ColorMixerControls /> },
  { id: "grading", label: "Grading", icon: "grade", body: () => <ColorGradingControls /> },
  {
    id: "effects",
    label: "Effects",
    icon: "effects",
    parts: [
      { id: "presence", label: "Effects", body: () => <PresenceSliders /> },
      { id: "vignette", label: "Vignette", body: () => <VignetteSliders /> },
      { id: "grain", label: "Grain", body: () => <GrainSliders /> },
    ],
  },
  {
    id: "detail",
    label: "Detail",
    icon: "detail",
    parts: [
      { id: "sharpening", label: "Sharpening", body: () => <SharpeningSliders /> },
      { id: "noise", label: "Noise", body: () => <NoiseSliders /> },
    ],
  },
  { id: "optics", label: "Optics", icon: "optics", body: () => <LensControls /> },
];

/** The group on show (and each group's part); kept while the sheet closes and opens again. */
export const deck = createStore<{ group: string; parts: Readonly<Record<string, string>> }>(() => ({ group: "light", parts: {} }));

/**
 * Develop's adjustments on a phone, like Lightroom mobile: one group at a time in
 * a short translucent panel floating over the photo (about three sliders; swipe up
 * and down to scroll, drag sideways to change a value), sub-tabs for a group's parts,
 * and the groups in a row beneath. Curve draws over the photo and shrinks the panel
 * to a bar. The computer's right panel shows the same controls in its sections.
 */
export function EditDeck() {
  const id = useStore(deck, (s) => s.group);
  const partId = useStore(deck, (s) => s.parts[id]);
  const group = groups.find((g) => g.id === id) ?? groups[0];
  const part = group.parts?.find((p) => p.id === partId) ?? group.parts?.[0];
  const scroll = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    scroll.current?.scrollTo({ top: 0 });
    tabs.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [group.id, part?.id]);
  if (group.id === "curve") return <CurveBar onDone={() => deck.setState({ group: "light" })} />;
  return (
    <div className="edit-deck">
      {group.parts && (
        <div className="deck-parts" role="tablist" aria-label={`${group.label} sections`}>
          {group.parts.map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              className="deck-part"
              aria-selected={p.id === part?.id}
              onClick={() => deck.setState((s) => ({ parts: { ...s.parts, [group.id]: p.id } }))}
            >
              {p.label}
            </button>
          ))}
        </div>
      )}
      <div ref={scroll} className="deck-scroll" role="tabpanel" id="deck-panel" aria-labelledby={`deck-tab-${group.id}`} data-group={group.id}>
        {part ? part.body() : group.body?.()}
      </div>
      <div ref={tabs} className="deck-tabs" role="tablist" aria-label="Adjustments">
        {groups.map((g) => (
          <button
            key={g.id}
            id={`deck-tab-${g.id}`}
            type="button"
            role="tab"
            className="deck-tab"
            aria-selected={g.id === group.id}
            aria-controls="deck-panel"
            onClick={() => deck.setState({ group: g.id })}
          >
            <Icon name={g.icon} size={20} />
            <span>{g.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
