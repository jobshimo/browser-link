import { execFile as nodeExecFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import type Database from 'better-sqlite3';
import { getActivityDb } from '../activity/db.js';
import { getFeedback, listFeedback, type FeedbackRow } from '../activity/feedback.js';
import { VERSION } from '../version.js';
import type { Language } from './welcome.js';

/**
 * `browser-link feedback` — what agents reported about browser-link itself.
 *
 * Agents record feedback; they never open issues. The owner reads the list
 * here and, for an entry worth reporting, `feedback issue <id>` prints a
 * GitHub issue draft and creates it with `gh` only after a `y` typed in the
 * console. Without a terminal it prints the draft and creates nothing.
 */

/** The repository issues are filed against. */
export const ISSUE_REPO = 'jobshimo/browser-link';

const TITLE_OBSERVED_CHARS = 60;
const MAX_LIMIT = 500;

export interface FeedbackCommandDeps {
  /** Activity database; defaults to the shared one. */
  db?: Database.Database;
  /** Output sink, one line per call; defaults to `console.log`. */
  print?: (line: string) => void;
  /** Whether a human can answer the prompt; defaults to stdin and stdout
   * both being TTYs. */
  isTTY?: boolean;
  /** Ask one question on the console and resolve with the answer. */
  ask?: (question: string) => Promise<string>;
  /** Runs `gh`; injected so tests never call the real binary. */
  execFile?: (file: string, args: readonly string[]) => Promise<{ stdout: string; stderr: string }>;
}

const I18N = {
  en: {
    empty: 'No agent feedback recorded yet.',
    header:
      'Agent feedback, newest first. Draft a GitHub issue from one: browser-link feedback issue <id>',
    observed: 'observed',
    expected: 'expected',
    badLimit: `--limit takes a whole number from 1 to ${MAX_LIMIT}.`,
    usage: [
      'browser-link feedback [--limit <n>]     What agents reported about browser-link, newest first',
      'browser-link feedback issue <id>        Draft a GitHub issue from one entry; created with gh only after you type y',
    ].join('\n'),
    issueUsage: 'Usage: browser-link feedback issue <id>',
    notFound: (id: number) => `No feedback entry #${id}.`,
    title: 'Title:',
    confirm: `Create this issue on ${ISSUE_REPO} with gh? [y/N] `,
    declined: 'Nothing was created.',
    notTty: 'Not a terminal: nothing was created. Run the command in a terminal to confirm.',
    created: (url: string) => `Created: ${url}`,
    ghMissing:
      'The GitHub CLI (gh) was not found. Install it and run `gh auth login`, or file the draft above by hand.',
    ghFailed: (msg: string) => `gh issue create failed: ${msg}`,
  },
  es: {
    empty: 'Todavía no hay feedback de agentes.',
    header:
      'Feedback de los agentes, más reciente primero. Para preparar un issue de GitHub: browser-link feedback issue <id>',
    observed: 'observado',
    expected: 'esperado',
    badLimit: `--limit acepta un número entero de 1 a ${MAX_LIMIT}.`,
    usage: [
      'browser-link feedback [--limit <n>]     Lo que los agentes reportaron sobre browser-link, más reciente primero',
      'browser-link feedback issue <id>        Prepara un issue de GitHub con una entrada; se crea con gh solo si escribís y',
    ].join('\n'),
    issueUsage: 'Uso: browser-link feedback issue <id>',
    notFound: (id: number) => `No hay una entrada de feedback #${id}.`,
    title: 'Título:',
    confirm: `¿Crear este issue en ${ISSUE_REPO} con gh? [y/N] `,
    declined: 'No se creó nada.',
    notTty: 'No es una terminal: no se creó nada. Corré el comando en una terminal para confirmar.',
    created: (url: string) => `Creado: ${url}`,
    ghMissing:
      'No se encontró la CLI de GitHub (gh). Instalala y corré `gh auth login`, o cargá el borrador de arriba a mano.',
    ghFailed: (msg: string) => `gh issue create falló: ${msg}`,
  },
} as const;

/** Secret-shaped or personal fragments replaced before anything leaves the
 * machine: JWTs, `key=value` credentials, e-mail addresses, long hex and
 * long opaque tokens. */
const REDACTIONS: readonly RegExp[] = [
  /\beyJ[\w-]+\.[\w-]+\.[\w-]+/g,
  /\b(password|passwd|token|secret|cookie|authorization|api[_-]?key|session)\b(\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi,
  /[\w.+-]+@[\w-]+(\.[\w-]+)+/g,
  /\b[0-9a-f]{32,}\b/gi,
  /\b[A-Za-z0-9+/_-]{40,}={0,2}/g,
];

function redact(text: string): string {
  let out = text;
  for (const pattern of REDACTIONS) {
    out = out.replace(pattern, (...m: unknown[]) =>
      // The credential pattern keeps its key so the reader still knows what
      // was there.
      pattern === REDACTIONS[1] ? `${String(m[1])}${String(m[2])}[redacted]` : '[redacted]',
    );
  }
  return out;
}

export interface IssueDraft {
  title: string;
  body: string;
}

/** The GitHub issue for one entry. Never carries the agent id. */
export function issueDraft(row: FeedbackRow): IssueDraft {
  const observed = redact(row.observed);
  const oneLine = observed.replace(/\s+/g, ' ').trim();
  const title = `[agent feedback] ${row.tool}: ${oneLine.slice(0, TITLE_OBSERVED_CHARS).trimEnd()}`;
  const body = [
    `**Tool:** \`${row.tool}\``,
    '',
    `**Observed:** ${observed}`,
    '',
    `**Expected:** ${redact(row.expected)}`,
    '',
    `**Origin:** ${row.origin ?? '—'}`,
    `**App build:** ${row.build ?? '—'}`,
    `**Date:** ${row.at}`,
    `**browser-link:** v${VERSION}`,
    '',
    '_Reported by an agent through browser-link feedback; reviewed by the owner before filing._',
  ].join('\n');
  return { title, body };
}

function localStamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function defaultAsk(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

const defaultExecFile = promisify(nodeExecFile) as unknown as NonNullable<
  FeedbackCommandDeps['execFile']
>;

function parsePositiveInt(value: string | undefined, max: number): number | null {
  if (value === undefined || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= max ? n : null;
}

/** Run `browser-link feedback ...`; resolves with the process exit code. */
export async function runFeedbackCommand(
  argv: string[],
  language: Language = 'en',
  deps: FeedbackCommandDeps = {},
): Promise<number> {
  const t = I18N[language];
  const print =
    deps.print ??
    ((line: string) => {
      console.log(line);
    });
  const db = deps.db ?? getActivityDb();
  const sub = argv.at(0);

  if (sub === 'help' || argv.includes('--help')) {
    print(t.usage);
    return 0;
  }

  if (sub === 'issue') {
    const id = parsePositiveInt(argv.at(1), Number.MAX_SAFE_INTEGER);
    if (id === null) {
      print(t.issueUsage);
      return 2;
    }
    const row = getFeedback(db, id);
    if (row === null) {
      print(t.notFound(id));
      return 2;
    }
    const draft = issueDraft(row);
    print(`${t.title} ${draft.title}`);
    print('');
    print(draft.body);
    print('');
    const isTTY = deps.isTTY ?? (process.stdin.isTTY && process.stdout.isTTY);
    if (!isTTY) {
      print(t.notTty);
      return 0;
    }
    const answer = (await (deps.ask ?? defaultAsk)(t.confirm)).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      print(t.declined);
      return 0;
    }
    const dir = mkdtempSync(join(tmpdir(), 'browser-link-issue-'));
    const bodyFile = join(dir, 'body.md');
    try {
      writeFileSync(bodyFile, draft.body, 'utf8');
      const run = deps.execFile ?? defaultExecFile;
      const { stdout } = await run('gh', [
        'issue',
        'create',
        '--repo',
        ISSUE_REPO,
        '--title',
        draft.title,
        '--body-file',
        bodyFile,
      ]);
      print(t.created(stdout.trim()));
      return 0;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      print(
        code === 'ENOENT'
          ? t.ghMissing
          : t.ghFailed(err instanceof Error ? err.message : String(err)),
      );
      return 1;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  if (sub !== undefined && sub !== '--limit') {
    print(t.usage);
    return 2;
  }

  let limit: number | undefined;
  const at = argv.indexOf('--limit');
  if (at !== -1) {
    const n = parsePositiveInt(argv.at(at + 1), MAX_LIMIT);
    if (n === null) {
      print(t.badLimit);
      return 2;
    }
    limit = n;
  }

  const rows = listFeedback(db, { limit });
  if (rows.length === 0) {
    print(t.empty);
    return 0;
  }
  print(t.header);
  for (const r of rows) {
    print('');
    print(`#${r.id}  ${localStamp(r.at)}  ${r.tool}${r.origin ? `  ${r.origin}` : ''}`);
    print(`    ${t.observed}: ${r.observed}`);
    print(`    ${t.expected}: ${r.expected}`);
  }
  return 0;
}
