import { type ReactNode, useLayoutEffect, useRef } from "react";
import { createStore } from "zustand/vanilla";
import { useStore } from "@/app/hooks";
import { Icon, type IconName } from "@/components/icons";
import { PresenceSliders, ProfileControls, SaturationSliders, ToneSliders, WhiteBalance } from "./Basic";
import { ColorGradingControls, ColorMixerControls } from "./Color";
import { DetailControls, EffectsControls, LensControls } from "./Detail";
import { ToneCurveControls } from "./ToneCurve";

type Group = { id: string; label: string; icon: IconName; body: () => ReactNode };

// Lightroom mobile's groups. Texture, Clarity and Dehaze sit under Effects and
// Vibrance and Saturation under Color there, so they do here too.
const groups: readonly Group[] = [
  { id: "light", label: "Light", icon: "light", body: () => <ToneSliders /> },
  { id: "curve", label: "Curve", icon: "curve", body: () => <ToneCurveControls inlineReset /> },
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
    body: () => (
      <>
        <PresenceSliders />
        <EffectsControls />
      </>
    ),
  },
  { id: "detail", label: "Detail", icon: "detail", body: () => <DetailControls /> },
  { id: "optics", label: "Optics", icon: "optics", body: () => <LensControls /> },
];

/** The group on show; kept while the sheet closes and opens again. */
const deck = createStore<{ group: string }>(() => ({ group: "light" }));

/**
 * Develop's adjustments on a phone, like Lightroom mobile: one group at a time in
 * a short panel (about three sliders, so the photo stays in view; swipe up and
 * down to scroll, drag sideways to change a value) with the groups in a row
 * beneath it. The computer's right panel shows the same controls in its sections.
 */
export function EditDeck() {
  const id = useStore(deck, (s) => s.group);
  const group = groups.find((g) => g.id === id) ?? groups[0];
  const scroll = useRef<HTMLDivElement>(null);
  const tabs = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    scroll.current?.scrollTo({ top: 0 });
    tabs.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [group.id]);
  return (
    <div className="edit-deck">
      <div ref={scroll} className="deck-scroll" role="tabpanel" id="deck-panel" aria-labelledby={`deck-tab-${group.id}`} data-group={group.id}>
        {group.body()}
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
