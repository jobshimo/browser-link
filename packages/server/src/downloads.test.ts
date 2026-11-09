import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_DOWNLOAD_TIMEOUT_MS,
  MAX_DOWNLOAD_BYTES,
  MAX_DOWNLOAD_TIMEOUT_MS,
  buildFetchDownloadJs,
  clampDownloadTimeoutMs,
  downloadMaxBytes,
  filenameFromContentDisposition,
  filenameFromUrl,
  pickFilename,
  resolveDownloadsDir,
  sanitizeDerivedFilename,
  shapeDownloadResult,
  validateRequestedFilename,
  writeDownloadFile,
  type FetchDownloadOutcome,
} from './downloads.js';

/** The two `fetch` init fields the in-page expression sets. */
interface FetchInit {
  credentials?: string;
  signal?: AbortSignal;
}

describe('validateRequestedFilename', () => {
  test('accepts a plain basename', () => {
    expect(validateRequestedFilename('report.pdf')).toBe('report.pdf');
  });

  test.each(['../evil.txt', 'a/b.txt', 'a\\b.txt', '..', '.', '', '   ', 'C:evil', 'x\u0000y'])(
    'rejects %j',
    (name) => {
      expect(() => validateRequestedFilename(name)).toThrow(/filename/);
    },
  );

  test.each(['CON', 'nul', 'Aux.txt', 'com1', 'LPT9.log', 'prn.tar.gz', 'name.', 'name '])(
    'rejects the Windows-unsafe name %j',
    (name) => {
      expect(() => validateRequestedFilename(name)).toThrow(/filename/);
    },
  );

  test('accepts names that merely start like a device name', () => {
    expect(validateRequestedFilename('console.log')).toBe('console.log');
    expect(validateRequestedFilename('com10.txt')).toBe('com10.txt');
  });

  test('rejects a non-string', () => {
    expect(() => validateRequestedFilename(42)).toThrow(/filename/);
  });

  test('rejects a name longer than 200 characters', () => {
    expect(() => validateRequestedFilename('a'.repeat(201))).toThrow(/filename/);
  });
});

describe('sanitizeDerivedFilename', () => {
  test('keeps only the last path segment (both separators)', () => {
    expect(sanitizeDerivedFilename('C:\\Users\\x\\Downloads\\file.zip')).toBe('file.zip');
    expect(sanitizeDerivedFilename('/tmp/../etc/passwd')).toBe('passwd');
  });

  test('replaces reserved characters and strips control chars', () => {
    expect(sanitizeDerivedFilename('a:b*c?.txt')).toBe('a_b_c_.txt');
    expect(sanitizeDerivedFilename('a\u0001b.txt')).toBe('ab.txt');
  });

  test('returns null for nothing usable', () => {
    expect(sanitizeDerivedFilename('')).toBeNull();
    expect(sanitizeDerivedFilename('..')).toBeNull();
    expect(sanitizeDerivedFilename(undefined)).toBeNull();
    expect(sanitizeDerivedFilename('dir/')).toBeNull();
  });

  test('defuses Windows device names from the page by prefixing "_"', () => {
    expect(sanitizeDerivedFilename('NUL')).toBe('_NUL');
    expect(sanitizeDerivedFilename('con.txt')).toBe('_con.txt');
    expect(sanitizeDerivedFilename('LPT1. ')).toBe('_LPT1');
    expect(pickFilename({ contentDisposition: 'attachment; filename="aux.csv"' })).toBe('_aux.csv');
  });

  test('strips leading dots so a derived name never becomes hidden or relative', () => {
    expect(sanitizeDerivedFilename('...bashrc')).toBe('bashrc');
  });
});

describe('filenameFromContentDisposition', () => {
  test('reads a quoted filename', () => {
    expect(filenameFromContentDisposition('attachment; filename="r e.pdf"')).toBe('r e.pdf');
  });

  test('prefers RFC 5987 filename* over filename', () => {
    expect(
      filenameFromContentDisposition(
        'attachment; filename="fallback.txt"; filename*=UTF-8\'\'na%C3%AFve.txt',
      ),
    ).toBe('naïve.txt');
  });

  test('returns null when absent or unparseable', () => {
    expect(filenameFromContentDisposition(null)).toBeNull();
    expect(filenameFromContentDisposition('inline')).toBeNull();
  });
});

describe('filenameFromUrl', () => {
  test('takes the last path segment, decoded', () => {
    expect(filenameFromUrl('https://x.test/files/my%20doc.pdf?x=1')).toBe('my doc.pdf');
  });

  test('null for blob:, data:, a bare origin or garbage', () => {
    expect(filenameFromUrl('blob:https://x.test/1234-uuid')).toBeNull();
    expect(filenameFromUrl('data:text/plain,hi')).toBeNull();
    expect(filenameFromUrl('https://x.test/')).toBeNull();
    expect(filenameFromUrl('not a url')).toBeNull();
  });
});

describe('pickFilename', () => {
  test('requested wins over everything', () => {
    expect(
      pickFilename({
        requested: 'mine.csv',
        suggested: 'theirs.csv',
        contentDisposition: 'attachment; filename="cd.csv"',
        url: 'https://x.test/u.csv',
      }),
    ).toBe('mine.csv');
  });

  test('falls back suggested → content-disposition → url → "download"', () => {
    expect(pickFilename({ suggested: 'C:\\dl\\s.csv', url: 'https://x.test/u.csv' })).toBe('s.csv');
    expect(
      pickFilename({ contentDisposition: 'attachment; filename=cd.csv', url: 'https://x/u.csv' }),
    ).toBe('cd.csv');
    expect(pickFilename({ url: 'https://x.test/u.csv' })).toBe('u.csv');
    expect(pickFilename({ url: 'blob:https://x.test/abc' })).toBe('download');
  });
});

describe('clampDownloadTimeoutMs', () => {
  test('defaults when absent or invalid', () => {
    expect(clampDownloadTimeoutMs(undefined)).toBe(DEFAULT_DOWNLOAD_TIMEOUT_MS);
    expect(clampDownloadTimeoutMs(-1)).toBe(DEFAULT_DOWNLOAD_TIMEOUT_MS);
    expect(clampDownloadTimeoutMs('5')).toBe(DEFAULT_DOWNLOAD_TIMEOUT_MS);
  });

  test('caps at the maximum', () => {
    expect(clampDownloadTimeoutMs(10_000_000)).toBe(MAX_DOWNLOAD_TIMEOUT_MS);
    expect(clampDownloadTimeoutMs(5_000)).toBe(5_000);
  });
});

describe('resolveDownloadsDir', () => {
  test('defaults to <dataDir>/downloads', () => {
    expect(resolveDownloadsDir({}, '/data')).toBe(join('/data', 'downloads'));
  });

  test('uses a configured absolute path', () => {
    const abs = join(tmpdir(), 'bl-dl');
    expect(resolveDownloadsDir({ downloadsDir: abs }, '/data')).toBe(abs);
  });

  test('ignores a relative or non-string configured value (untrusted config.json)', () => {
    expect(resolveDownloadsDir({ downloadsDir: 'rel/dir' }, '/data')).toBe(
      join('/data', 'downloads'),
    );
    expect(resolveDownloadsDir({ downloadsDir: 5 as unknown as string }, '/data')).toBe(
      join('/data', 'downloads'),
    );
  });
});

describe('writeDownloadFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bl-dl-test-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('creates the directory and writes the bytes', () => {
    const target = join(dir, 'nested');
    const path = writeDownloadFile(target, 'a.txt', Buffer.from('hello'));
    expect(path).toBe(join(target, 'a.txt'));
    expect(readFileSync(path, 'utf8')).toBe('hello');
  });

  test('never overwrites: a second file with the same name is uniquified', () => {
    writeDownloadFile(dir, 'a.txt', Buffer.from('one'));
    const second = writeDownloadFile(dir, 'a.txt', Buffer.from('two'));
    expect(second).toBe(join(dir, 'a (1).txt'));
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('one');
    expect(readFileSync(second, 'utf8')).toBe('two');
  });
});

describe('shapeDownloadResult', () => {
  const save = vi.fn((filename: string, data: Buffer) => `/dl/${filename}#${data.length}`);

  test('complete → writes the file and reports path/bytes/mime', () => {
    const outcome: FetchDownloadOutcome = {
      state: 'complete',
      status: 200,
      mime: 'text/csv',
      content_disposition: 'attachment; filename="r.csv"',
      final_url: 'https://x.test/r',
      bytes: 3,
      data_b64: Buffer.from('a,b').toString('base64'),
    };
    expect(shapeDownloadResult(outcome, { url: 'https://x.test/r' }, save)).toEqual({
      ok: true,
      state: 'complete',
      path: '/dl/r.csv#3',
      filename: 'r.csv',
      bytes: 3,
      mime: 'text/csv',
      url: 'https://x.test/r',
    });
  });

  test('timeout → keeps the partial info it has, writes nothing', () => {
    save.mockClear();
    const outcome: FetchDownloadOutcome = {
      state: 'timeout',
      mime: 'application/zip',
      final_url: 'https://x.test/big.zip',
      bytes: 1024,
      error: 'timed out after 100ms',
    };
    const res = shapeDownloadResult(outcome, { url: 'https://x.test/big.zip' }, save);
    expect(save).not.toHaveBeenCalled();
    expect(res).toEqual({
      ok: false,
      state: 'timeout',
      path: null,
      filename: 'big.zip',
      bytes: 1024,
      mime: 'application/zip',
      url: 'https://x.test/big.zip',
      error: 'timed out after 100ms',
    });
  });

  test('a failing writer turns a complete fetch into interrupted with the error', () => {
    const outcome: FetchDownloadOutcome = { state: 'complete', bytes: 1, data_b64: 'YQ==' };
    const res = shapeDownloadResult(
      outcome,
      { url: 'https://x.test/f', requested: 'f.bin' },
      () => {
        throw new Error('EACCES');
      },
    );
    expect(res.ok).toBe(false);
    expect(res.state).toBe('interrupted');
    expect(res.error).toMatch(/EACCES/);
    expect(res.filename).toBe('f.bin');
  });
});

describe('buildFetchDownloadJs (run against a stubbed fetch)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function run(expr: string): Promise<FetchDownloadOutcome> {
    // The expression is an async IIFE meant for Runtime.evaluate; indirect
    // eval runs it against Node's globals (fetch, btoa, AbortController).
    return (await (0, eval)(expr)) as FetchDownloadOutcome;
  }

  test('fetches with credentials and returns base64 bytes + headers', async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response('hello', {
          status: 200,
          headers: {
            'content-type': 'text/plain',
            'content-disposition': 'attachment; filename="h.txt"',
          },
        }),
    );
    vi.stubGlobal('fetch', fetchSpy);
    const out = await run(
      buildFetchDownloadJs({ url: 'https://x.test/h', timeoutMs: 1000, maxBytes: 100 }),
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    const init = (fetchSpy.mock.calls[0] as unknown[])[1] as FetchInit;
    expect(init.credentials).toBe('include');
    expect(out.state).toBe('complete');
    expect(out.mime).toBe('text/plain');
    expect(out.content_disposition).toBe('attachment; filename="h.txt"');
    expect(out.bytes).toBe(5);
    expect(Buffer.from(out.data_b64 ?? '', 'base64').toString()).toBe('hello');
  });

  test('an HTTP error status is interrupted, not complete', async () => {
    vi.stubGlobal('fetch', async () => new Response('nope', { status: 403 }));
    const out = await run(
      buildFetchDownloadJs({ url: 'https://x.test/h', timeoutMs: 1000, maxBytes: 100 }),
    );
    expect(out.state).toBe('interrupted');
    expect(out.status).toBe(403);
    expect(out.error).toMatch(/403/);
    expect(out.data_b64).toBeUndefined();
  });

  test('a body over maxBytes is interrupted and reports the cap', async () => {
    vi.stubGlobal('fetch', async () => new Response('x'.repeat(50), { status: 200 }));
    const out = await run(
      buildFetchDownloadJs({ url: 'https://x.test/h', timeoutMs: 1000, maxBytes: 10 }),
    );
    expect(out.state).toBe('interrupted');
    expect(out.error).toMatch(/10 bytes/);
    expect(out.data_b64).toBeUndefined();
  });

  test('a fetch that never answers times out with partial info', async () => {
    vi.stubGlobal(
      'fetch',
      (_url: string, init: FetchInit) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    const out = await run(
      buildFetchDownloadJs({ url: 'https://x.test/h', timeoutMs: 20, maxBytes: 10 }),
    );
    expect(out.state).toBe('timeout');
    expect(out.bytes).toBe(0);
    expect(out.error).toMatch(/20ms/);
  });

  test('a network error is interrupted with the message', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    const out = await run(
      buildFetchDownloadJs({ url: 'https://x.test/h', timeoutMs: 1000, maxBytes: 10 }),
    );
    expect(out.state).toBe('interrupted');
    expect(out.error).toMatch(/Failed to fetch/);
  });

  test('the URL is embedded as a JSON literal (no injection)', () => {
    const js = buildFetchDownloadJs({
      url: 'https://x.test/"); alert(1); ("',
      timeoutMs: 1000,
      maxBytes: MAX_DOWNLOAD_BYTES,
    });
    expect(js).toContain(JSON.stringify('https://x.test/"); alert(1); ("'));
  });
});

describe('downloadMaxBytes', () => {
  const MiB = 1024 * 1024;

  test('the default is MAX_DOWNLOAD_BYTES (25 MiB)', () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(25 * MiB);
    expect(downloadMaxBytes({})).toBe(MAX_DOWNLOAD_BYTES);
  });

  test('a configured whole number of MiB in [1, 64] is applied', () => {
    expect(downloadMaxBytes({ downloadsMaxMb: 1 })).toBe(MiB);
    expect(downloadMaxBytes({ downloadsMaxMb: 50 })).toBe(50 * MiB);
    expect(downloadMaxBytes({ downloadsMaxMb: 64 })).toBe(64 * MiB);
  });

  test.each([0, 65, 501, 1e9, -5, 2.5, '50', null, Number.NaN])(
    'an untrusted value %j reads as the default, never past the 64 MiB ceiling',
    (raw) => {
      expect(downloadMaxBytes({ downloadsMaxMb: raw })).toBe(MAX_DOWNLOAD_BYTES);
    },
  );
});

describe('buildFetchDownloadJs over-cap message', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('a whole-MiB cap is named in MiB with its byte count and how the human raises it', async () => {
    const MiB = 1024 * 1024;
    vi.stubGlobal('fetch', async () => new Response(new Uint8Array(MiB + 1), { status: 200 }));
    const out = (await (0, eval)(
      buildFetchDownloadJs({ url: 'https://x.test/big', timeoutMs: 5000, maxBytes: MiB }),
    )) as FetchDownloadOutcome;
    expect(out.state).toBe('interrupted');
    expect(out.error).toBe(
      'download exceeds the 1 MiB cap (1048576 bytes); the human can change it with: browser-link config set downloads.max-mb <1..64>',
    );
    expect(out.data_b64).toBeUndefined();
  });
});
