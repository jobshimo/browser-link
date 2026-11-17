// The cdp-direct `PageInfo` (design 3.1): `Target.getTargetInfo` for the
// title and url, and the load wait on `Page.loadEventFired` (core's
// `armLoadWait` holds the timer and the once-only rule).
import type { Clock } from '../../generated/core/ports/clock.js';
import type { PageInfo } from '../../generated/core/ports/page-info.js';
import { armLoadWait } from '../../generated/core/session/load-wait.js';
import type { CdpClient } from '../client.js';

interface TargetInfoResult {
  targetInfo: { title?: string; url?: string };
}

export function createCdpPageInfo(client: CdpClient, clock: Clock): PageInfo {
  return {
    info: () =>
      client.send<TargetInfoResult>('Target.getTargetInfo').then((info) => ({
        title: info.targetInfo.title ?? '',
        url: info.targetInfo.url ?? '',
      })),
    armLoadWait: (timeoutMs) =>
      armLoadWait((loaded) => client.on('Page.loadEventFired', loaded), clock, timeoutMs),
  };
}
