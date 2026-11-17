/**
 * How the popup's Flows panel words a flow: its tab, its progress line and
 * the summary of a finished one. UI copy, so it stays in the extension while
 * the flow registry's rules move to core (docs/design/service-worker-architecture.md,
 * 5.1).
 */

import type { Messages } from './i18n.js';
import {
  formatFlowDuration,
  type FlowHistoryEntry,
  type FlowStopReason,
  type RunningFlowView,
} from './flow-registry.js';

/** What the popup calls a flow's tab. The title is best-effort (it is
 * captured asynchronously at flow start and can legitimately be empty on
 * a blank or still-loading tab), so the Chrome tab id is the fallback —
 * an unlabelled Stop button next to an unlabelled flow would be exactly
 * the wrong thing to hand someone trying to stop the right one. */
export function flowTabLabel(view: { title: string; tabId: number }, t: Messages): string {
  const trimmed = view.title.trim();
  return trimmed.length > 0 ? trimmed : t.flowTab(view.tabId);
}

/** The progress line for one running flow: "step 2/5" outside a repeat,
 * "step 2/5 · iteration 12/50" inside one, "starting…" before the runner
 * has reported its first step. A detached flow is labelled as such: it is
 * the one row where the human is the ONLY party still watching. */
export function describeFlowProgress(view: RunningFlowView, t: Messages): string {
  const line = (): string => {
    if (view.step < 1) return t.flowStarting;
    const step = t.flowStep(view.step, view.steps);
    if (view.iteration === undefined || view.iterations === undefined) return step;
    return `${step} · ${t.flowIteration(view.iteration, view.iterations)}`;
  };
  return view.detached ? t.flowDetached(line()) : line();
}

/** How a stop reason reads in the panel. `worker-terminated` gets a real
 * sentence because it is the one outcome a user cannot otherwise explain:
 * Chrome killed the extension's service worker and the flow died with it.
 * `cancelled` has none: its badge already says so. */
function stopReasonLabel(reason: Exclude<FlowStopReason, 'cancelled'>, t: Messages): string {
  return reason === 'expired' ? t.flowExpired : t.flowWorkerTerminated;
}

/** The one-line summary for a finished flow: outcome, what it got through,
 * and how long it took. Structure and counts only. */
export function describeFlowHistoryEntry(entry: FlowHistoryEntry, t: Messages): string {
  const parts = [t.flowStepsDone(entry.stepsCompleted, entry.steps)];
  if (entry.iterationsCompleted !== undefined) {
    parts.push(t.flowIterationsDone(entry.iterationsCompleted));
  }
  parts.push(formatFlowDuration(entry.durationMs));
  if (entry.outcome === 'failed' && entry.failedStep !== undefined) {
    parts.push(t.flowFailedAt(entry.failedStep + 1, entry.failedStepKind));
  }
  // Only when it adds something: a `cancelled` entry already says
  // "cancelled" in its own badge, so repeating it there would be noise.
  if (entry.stoppedBy !== undefined && entry.stoppedBy !== 'cancelled') {
    parts.push(stopReasonLabel(entry.stoppedBy, t));
  }
  const line = parts.join(' · ');
  return entry.detached === true ? t.flowDetached(line) : line;
}
