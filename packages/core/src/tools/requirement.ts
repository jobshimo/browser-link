/**
 * What a tool handler may require from its transport (design 3.3), and the
 * dependencies that satisfy each requirement. A handler's `deps` is the
 * `Pick` of exactly what it `requires`, plus what every transport gives:
 * the clock, the dialog watch where the transport tracks dialogs (the
 * extension; read-only, design revision 8) and the capture watch where it
 * captures console messages and requests (the extension). Requirements join
 * with the first handler that needs them: slice 10 has the page's evaluator,
 * pointer and settle wait; slice 11 adds the keyboard; slice 13 adds
 * `capture-buffers`, which a transport provides by giving the capture watch;
 * slice 14 adds the drag input (`drag`) and the CDP event wait
 * (`cdp-events`); slice 15 adds the page info (`page`) and `canvas`, the
 * transport's word that it takes canvas screenshots, and the navigator
 * (`navigator`), the screen capture (`screen-capture`) and the response
 * bodies (`response-bodies`); slice 16 adds the dialog input
 * (`dialog-input`), the downloads (`downloads`) and the content settings
 * (`content-settings`).
 */
import type { Clock } from '../ports/clock.js';
import type { ContentSettings } from '../ports/content-settings.js';
import type { Downloads } from '../ports/downloads.js';
import type {
  CdpEvents,
  DialogInput,
  DragInput,
  Evaluator,
  Keyboard,
  Navigator,
  Pointer,
  ResponseBodies,
  ScreenCapture,
  Settler,
} from '../ports/page-driver.js';
import type { PageInfo } from '../ports/page-info.js';
import type { CaptureWatch, DialogWatch } from '../session/page-driver.js';

export interface RequirementDeps {
  evaluator: Evaluator;
  keyboard: Keyboard;
  pointer: Pointer;
  settler: Settler;
  drag: DragInput;
  'cdp-events': CdpEvents;
  page: PageInfo;
  navigator: Navigator;
  'screen-capture': ScreenCapture;
  'response-bodies': ResponseBodies;
  'dialog-input': DialogInput;
  downloads: Downloads;
  'content-settings': ContentSettings;
}

/** A requirement that is a provides-set entry, not a port: `capture-buffers`
 * (the transport captures its tab's console messages and requests, and gives
 * the capture watch) and `canvas` (the transport takes canvas screenshots,
 * through the evaluator). */
export type ScopeRequirement = 'capture-buffers' | 'canvas';

/** A port only some transports have an adapter for (design 3.1: cdp-direct
 * has none for `Downloads` or `ContentSettings`). A transport that provides
 * the requirement gives the port; a handler reads it with `providedPort`. */
export type AdapterRequirement = 'downloads' | 'content-settings';

/** What a tool may require: a port, or a scope entry. */
export type Requirement = keyof RequirementDeps | ScopeRequirement;

/** What every transport gives besides its requirements. */
export interface CommonDeps {
  clock: Clock;
  dialogs?: DialogWatch;
  /** Given by the transports that provide `capture-buffers`. */
  captureBuffers?: CaptureWatch;
}

/** Every dependency a transport gives the registry. */
export interface ToolDeps
  extends
    Omit<RequirementDeps, AdapterRequirement>,
    Partial<Pick<RequirementDeps, AdapterRequirement>>,
    CommonDeps {}

/** The deps of a handler that requires `R`. */
export type DepsFor<R extends Requirement> = Pick<ToolDeps, Exclude<R, ScopeRequirement>> &
  CommonDeps;

/** The port a transport gives with a requirement it provides. */
export function providedPort<T>(port: T | undefined, requirement: AdapterRequirement): T {
  if (port === undefined) throw new Error(`${requirement} provided without its port`);
  return port;
}
