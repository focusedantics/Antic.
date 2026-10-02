import { createStore } from "zustand/vanilla";
import { prefs, setPrefs } from "@/app/prefs";
import { setWorkspace, ui, type Workspace } from "@/app/state";
import { chapterStart, nextChapterStart, STEPS } from "./steps";

type TourState = {
  readonly active: boolean;
  readonly index: number;
  /** Where the person was when the tour started; they go back there at the end. */
  readonly returnTo: Workspace | null;
};

export const tour = createStore<TourState>(() => ({ active: false, index: 0, returnTo: null }));

function show(index: number) {
  const step = STEPS[index];
  if (!step) return endTour();
  if (step.workspace && ui.getState().workspace !== step.workspace) setWorkspace(step.workspace);
  tour.setState({ index });
}

/** Opens the tour at a chapter (0 = the welcome card). */
export function startTour(chapter = 0) {
  const s = tour.getState();
  tour.setState({ active: true, returnTo: s.active ? s.returnTo : ui.getState().workspace });
  show(chapterStart(chapter));
}

/** Opens the welcome card once, for someone who has never finished or skipped the tour. */
export function startTourIfNew() {
  if (!prefs.getState().tourDone && !tour.getState().active) startTour(0);
}

export const nextStep = () => show(tour.getState().index + 1);
export const previousStep = () => show(Math.max(0, tour.getState().index - 1));
export const skipChapter = () => show(nextChapterStart(tour.getState().index));
export const goToStep = (index: number) => show(Math.min(Math.max(0, index), STEPS.length - 1));

/** Closes the tour (finished or skipped) and returns to where it started. */
export function endTour() {
  const { active, returnTo } = tour.getState();
  if (!active) return;
  tour.setState({ active: false, index: 0, returnTo: null });
  setPrefs({ tourDone: true });
  if (returnTo) setWorkspace(returnTo);
}
