// The page driver's navigator, screen capture and response bodies (slice
// 15): their contracts on an in-memory session, the commands they send, and
// RED probes showing each contract catches a broken subject.
import { describe, expect, it } from 'vitest';
import {
  createManualClock,
  createMemoryCdpSession,
  createMemoryPageInfo,
  defineNavigatorContract,
  defineResponseBodiesContract,
  defineScreenCaptureContract,
  type ContractCase,
  type NavigatorHarness,
  type ResponseBodiesHarness,
  type ScreenCaptureHarness,
} from '../ports/contract/index.js';
import type { CaptureParams } from '../ports/values.js';
import { createPageDriver } from './page-driver.js';

const INVALID_URL = 'Cannot navigate to invalid URL';
const INVALID = 'Invalid image format';
const NO_RESOURCE = 'No resource with given identifier found';
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAI';

function driverOn(handlers: Parameters<typeof createMemoryCdpSession>[0]) {
  const clock = createManualClock();
  const session = createMemoryCdpSession(handlers);
  const page = createMemoryPageInfo({ url: 'https://t.test/', title: 'T' }, clock);
  return createPageDriver({ session, page, clock });
}

function navigatorHarness(sent: unknown[] = []): NavigatorHarness {
  const driver = driverOn({
    'Page.navigate': (params) => {
      sent.push(params);
      if (params.url === 'not a url') throw new Error(INVALID_URL);
      return { frameId: 'F', loaderId: 'L' };
    },
  });
  return {
    navigator: driver.navigator,
    url: 'https://t.test/next',
    failing: { url: 'not a url', message: INVALID_URL },
  };
}

function screenHarness(sent: [string, unknown][] = []): ScreenCaptureHarness {
  const driver = driverOn({
    'Page.getLayoutMetrics': (params) => {
      sent.push(['Page.getLayoutMetrics', params]);
      return {
        cssContentSize: { x: 0, y: 0, width: 800, height: 1200 },
        cssLayoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
        layoutViewport: { pageX: 0, pageY: 0, clientWidth: 800, clientHeight: 600 },
      };
    },
    'Page.captureScreenshot': (params) => {
      sent.push(['Page.captureScreenshot', params]);
      if (params.format !== 'png' && params.format !== 'jpeg') throw new Error(INVALID);
      return { data: PNG };
    },
  });
  return {
    screen: driver.screen,
    failing: {
      params: {
        format: 'gif',
        captureBeyondViewport: false,
        clip: { x: 0, y: 0, width: 8, height: 8, scale: 1 },
      } as unknown as CaptureParams,
      message: INVALID,
    },
  };
}

function responsesHarness(sent: unknown[] = []): ResponseBodiesHarness {
  const driver = driverOn({
    'Network.getResponseBody': (params) => {
      sent.push(params);
      if (params.requestId !== 'R1') throw new Error(NO_RESOURCE);
      return { base64Encoded: false, body: '<p>hi</p>' };
    },
  });
  return {
    responses: driver.responses,
    captured: { requestId: 'R1', body: { body: '<p>hi</p>', base64Encoded: false } },
    failing: { requestId: 'nope', message: NO_RESOURCE },
  };
}

function run(cases: ContractCase[]): void {
  for (const contractCase of cases) it(contractCase.name, () => contractCase.run());
}

function caseNamed(cases: ContractCase[], name: string): ContractCase {
  const found = cases.find((c) => c.name === name);
  if (!found) throw new Error(`no contract case named ${name}`);
  return found;
}

describe('Navigator contract: in-memory session', () => {
  run(defineNavigatorContract(() => navigatorHarness()));

  it('sends one Page.navigate with the url and nothing else', async () => {
    const sent: unknown[] = [];
    await navigatorHarness(sent).navigator.navigate('https://t.test/a');
    expect(sent).toEqual([{ url: 'https://t.test/a' }]);
  });
});

describe('ScreenCapture contract: in-memory session', () => {
  run(defineScreenCaptureContract(() => screenHarness()));

  it('sends the capture params unchanged and answers the data only', async () => {
    const sent: [string, unknown][] = [];
    const params: CaptureParams = {
      format: 'jpeg',
      captureBeyondViewport: true,
      clip: { x: 1, y: 2, width: 3, height: 4, scale: 0.5 },
      quality: 70,
    };
    const harness = screenHarness(sent);
    expect(await harness.screen.capture(params)).toBe(PNG);
    await harness.screen.layoutMetrics();
    expect(sent).toEqual([
      ['Page.captureScreenshot', params],
      ['Page.getLayoutMetrics', {}],
    ]);
  });
});

describe('ResponseBodies contract: in-memory session', () => {
  run(defineResponseBodiesContract(() => responsesHarness()));

  it('sends one Network.getResponseBody with the request id', async () => {
    const sent: unknown[] = [];
    await responsesHarness(sent).responses.body('R1');
    expect(sent).toEqual([{ requestId: 'R1' }]);
  });
});

describe('the contracts catch a broken subject (RED probes)', () => {
  it('Navigator: a refusal that resolves', async () => {
    const cases = defineNavigatorContract(() => {
      const harness = navigatorHarness();
      return { ...harness, navigator: { navigate: () => Promise.resolve() } };
    });
    await expect(
      caseNamed(cases, 'a refused navigation rejects with the CDP error message unchanged').run(),
    ).rejects.toThrow(/error message/);
  });

  it('ScreenCapture: an image that is not the page answer', async () => {
    const cases = defineScreenCaptureContract(() => {
      const harness = screenHarness();
      return {
        ...harness,
        screen: { ...harness.screen, capture: () => Promise.resolve('data:image/png;base64,') },
      };
    });
    await expect(
      caseNamed(cases, 'capture answers the image the page renders, base64').run(),
    ).rejects.toThrow(/PNG signature/);
  });

  it('ScreenCapture: metrics without the layout viewport', async () => {
    const cases = defineScreenCaptureContract(() => {
      const harness = screenHarness();
      return {
        ...harness,
        screen: { ...harness.screen, layoutMetrics: () => Promise.resolve({}) },
      };
    });
    await expect(
      caseNamed(
        cases,
        'layoutMetrics answers the content size and the layout viewport width in CSS pixels',
      ).run(),
    ).rejects.toThrow(/cssContentSize/);
  });

  it('ResponseBodies: keys in another order', async () => {
    const cases = defineResponseBodiesContract(() => {
      const harness = responsesHarness();
      return {
        ...harness,
        responses: {
          body: () => Promise.resolve({ base64Encoded: false, body: '<p>hi</p>' }),
        },
      };
    });
    await expect(
      caseNamed(cases, 'body answers the body and its encoding, in that key order').run(),
    ).rejects.toThrow(/response body/);
  });
});
