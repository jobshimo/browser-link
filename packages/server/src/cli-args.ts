import type { Language } from './commands/welcome.js';

/**
 * The one option parser of the command line, and the grammar every command
 * declares to it (owner decision D9):
 *
 * - `--help` or `-h` in any position asks for that command's help, and
 *   nothing else happens;
 * - an unknown or malformed option, an option missing its value, or a word
 *   the command does not take, refuses the whole command before it touches
 *   anything, with an error naming what was not understood;
 * - `--option=value` and `--option value` mean the same everywhere.
 *
 * cli.ts parses every command line here before it loads a command module,
 * and the command modules read their options through the same functions and
 * the same grammar, so the rules cannot differ from one command to another.
 */

/** A switch is present or absent; a value option always carries a value. */
export type OptionKind = 'switch' | 'value';

export interface ArgsSpec {
  readonly options: Readonly<Record<string, OptionKind>>;
  /** How many plain words the command takes after its (sub)command word. */
  readonly maxPositionals: number;
}

export interface CommandGrammar {
  /** The arguments when the first word is not one of `subcommands`. */
  readonly args: ArgsSpec;
  readonly subcommands?: Readonly<Record<string, ArgsSpec>>;
  /** The command reports an unknown first word itself, with its own
   * message (an unknown action). Without it, an unknown first word is
   * parsed against `args` like any other word. */
  readonly reportsUnknownSubcommand?: boolean;
}

const NONE: ArgsSpec = { options: {}, maxPositionals: 0 };
const CLIENT: ArgsSpec = { options: { client: 'value' }, maxPositionals: 0 };
const ACTIVITY_FILTERS = {
  tab: 'value',
  agent: 'value',
  tool: 'value',
  flow: 'value',
  failed: 'switch',
  limit: 'value',
} as const;

/** Every command `browser-link` dispatches, with its subcommands and
 * options. This table is the contract of the command line. */
export const COMMAND_LINE: Readonly<Record<string, CommandGrammar>> = {
  start: { args: NONE },
  version: { args: NONE },
  install: { args: CLIENT },
  uninstall: { args: CLIENT },
  extension: { args: NONE },
  doctor: { args: NONE },
  about: { args: NONE },
  updates: { args: NONE },
  stop: { args: NONE },
  tools: {
    args: NONE,
    subcommands: {
      list: NONE,
      enable: { options: {}, maxPositionals: Number.POSITIVE_INFINITY },
      disable: { options: {}, maxPositionals: Number.POSITIVE_INFINITY },
      preset: { options: {}, maxPositionals: 1 },
    },
    reportsUnknownSubcommand: true,
  },
  'multi-agent': {
    args: NONE,
    subcommands: {
      list: NONE,
      enable: NONE,
      disable: NONE,
      'auto-reelect': { options: {}, maxPositionals: 1 },
    },
    reportsUnknownSubcommand: true,
  },
  config: {
    args: NONE,
    subcommands: {
      get: { options: {}, maxPositionals: 1 },
      set: { options: {}, maxPositionals: 2 },
      'restore-defaults': { options: { yes: 'switch' }, maxPositionals: 0 },
    },
    reportsUnknownSubcommand: true,
  },
  cdp: {
    args: NONE,
    subcommands: {
      allow: { options: { minutes: 'value' }, maxPositionals: 0 },
      revoke: NONE,
      status: NONE,
    },
    reportsUnknownSubcommand: true,
  },
  map: {
    args: NONE,
    subcommands: {
      ls: NONE,
      show: { options: {}, maxPositionals: 1 },
      forget: {
        options: { flow: 'value', pitfall: 'value', mechanism: 'value', yes: 'switch' },
        maxPositionals: 1,
      },
      export: { options: { out: 'value' }, maxPositionals: 1 },
      import: { options: { replace: 'switch' }, maxPositionals: 1 },
    },
    reportsUnknownSubcommand: true,
  },
  activity: {
    args: { options: ACTIVITY_FILTERS, maxPositionals: 0 },
    subcommands: {
      help: NONE,
      stats: NONE,
      report: { options: { since: 'value', agent: 'value' }, maxPositionals: 0 },
      export: {
        options: { ...ACTIVITY_FILTERS, out: 'value', format: 'value', redact: 'switch' },
        maxPositionals: 0,
      },
      clear: {
        options: { 'older-than': 'value', from: 'value', to: 'value', yes: 'switch' },
        maxPositionals: 0,
      },
    },
  },
  feedback: {
    args: { options: { limit: 'value' }, maxPositionals: 0 },
    subcommands: { help: NONE, issue: { options: {}, maxPositionals: 1 } },
    reportsUnknownSubcommand: true,
  },
  instructions: {
    args: CLIENT,
    subcommands: {
      status: CLIENT,
      install: { options: { client: 'value', 'with-core': 'switch' }, maxPositionals: 0 },
      uninstall: CLIENT,
    },
    reportsUnknownSubcommand: true,
  },
};

export type ArgProblem =
  | { readonly kind: 'unknown-option'; readonly token: string }
  | { readonly kind: 'missing-value'; readonly option: string }
  | { readonly kind: 'unexpected-value'; readonly option: string; readonly token: string }
  | { readonly kind: 'malformed-option'; readonly token: string }
  | { readonly kind: 'repeated-option'; readonly option: string }
  | { readonly kind: 'unexpected-argument'; readonly token: string };

/** The options and plain words of one command line, already validated. */
export class ParsedArgs {
  constructor(
    readonly positionals: readonly string[],
    private readonly options: ReadonlyMap<string, string | true>,
  ) {}

  /** The value of a value option, or undefined when it was not given. */
  value(name: string): string | undefined {
    const v = this.options.get(name);
    return typeof v === 'string' ? v : undefined;
  }

  /** Whether a switch (or a value option) was given. */
  has(name: string): boolean {
    return this.options.has(name);
  }
}

export type CommandLine =
  | { readonly kind: 'help'; readonly path: string }
  | { readonly kind: 'error'; readonly path: string; readonly problem: ArgProblem }
  /** An unknown first word the command reports itself (its unknown action). */
  | { readonly kind: 'unknown-subcommand' }
  | {
      readonly kind: 'ok';
      readonly path: string;
      readonly subcommand: string | undefined;
      readonly args: ParsedArgs;
    };

const HELP_TOKENS: ReadonlySet<string> = new Set(['--help', '-h']);
const OPTION_NAME = /^[a-z0-9][a-z0-9-]*$/i;

/** A word that is an option rather than a value: it starts with `-`, but a
 * lone `-` and a negative number (`-5`) are values. */
function isOptionToken(token: string): boolean {
  return token.startsWith('-') && token !== '-' && !/^-\d/.test(token);
}

type Parse = { ok: true; args: ParsedArgs } | { ok: false; problem: ArgProblem };

/** Parse the words after a (sub)command word against its spec. */
export function parseArgs(spec: ArgsSpec, tokens: readonly string[]): Parse {
  const positionals: string[] = [];
  const options = new Map<string, string | true>();
  const fail = (problem: ArgProblem): Parse => ({ ok: false, problem });

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!isOptionToken(token)) {
      if (positionals.length >= spec.maxPositionals)
        return fail({ kind: 'unexpected-argument', token });
      positionals.push(token);
      continue;
    }
    if (!token.startsWith('--')) return fail({ kind: 'unknown-option', token });

    const body = token.slice(2);
    const eq = body.indexOf('=');
    const name = eq === -1 ? body : body.slice(0, eq);
    if (!OPTION_NAME.test(name)) return fail({ kind: 'malformed-option', token });
    const kind = Object.hasOwn(spec.options, name) ? spec.options[name] : undefined;
    if (kind === undefined) return fail({ kind: 'unknown-option', token: `--${name}` });
    if (options.has(name)) return fail({ kind: 'repeated-option', option: name });

    if (kind === 'switch') {
      if (eq !== -1) return fail({ kind: 'unexpected-value', option: name, token });
      options.set(name, true);
      continue;
    }
    if (eq !== -1) {
      const inline = body.slice(eq + 1);
      if (inline === '') return fail({ kind: 'missing-value', option: name });
      options.set(name, inline);
      continue;
    }
    const next = tokens.at(i + 1);
    if (next === undefined || isOptionToken(next))
      return fail({ kind: 'missing-value', option: name });
    options.set(name, next);
    i++;
  }
  return { ok: true, args: new ParsedArgs(positionals, options) };
}

/** Parse the words after `command` against its grammar. Undefined for a
 * command the grammar does not know (an unknown command). With
 * `detectHelp` off, `--help` and `-h` are ordinary (unknown) options. */
export function parseCommandLine(
  command: string,
  argv: readonly string[],
  { detectHelp = true }: { detectHelp?: boolean } = {},
): CommandLine | undefined {
  if (!Object.hasOwn(COMMAND_LINE, command)) return undefined;
  const grammar = COMMAND_LINE[command];
  const first = argv.at(0);
  const sub =
    first !== undefined &&
    !isOptionToken(first) &&
    grammar.subcommands !== undefined &&
    Object.hasOwn(grammar.subcommands, first)
      ? first
      : undefined;
  const path = sub === undefined ? command : `${command} ${sub}`;

  if (detectHelp && argv.some((token) => HELP_TOKENS.has(token))) return { kind: 'help', path };

  if (sub === undefined && first !== undefined && !isOptionToken(first)) {
    if (grammar.reportsUnknownSubcommand === true) return { kind: 'unknown-subcommand' };
  }
  const spec = sub === undefined ? grammar.args : (grammar.subcommands?.[sub] ?? grammar.args);
  const parsed = parseArgs(spec, sub === undefined ? argv : argv.slice(1));
  if (!parsed.ok) return { kind: 'error', path, problem: parsed.problem };
  return { kind: 'ok', path, subcommand: sub, args: parsed.args };
}

const EMPTY_ARGS = new ParsedArgs([], new Map());

const ARG_I18N: Record<
  Language,
  { problem: (p: ArgProblem) => string; nothingDone: (command: string) => string }
> = {
  en: {
    problem: (p) => {
      switch (p.kind) {
        case 'unknown-option':
          return `unknown option ${p.token}`;
        case 'missing-value':
          return `option --${p.option} needs a value`;
        case 'unexpected-value':
          return `option --${p.option} does not take a value (got ${p.token})`;
        case 'malformed-option':
          return `could not read ${p.token} as an option`;
        case 'repeated-option':
          return `option --${p.option} was given more than once`;
        case 'unexpected-argument':
          return `unexpected argument ${p.token}`;
      }
    },
    nothingDone: (command) => `Nothing was done. See: browser-link ${command} --help`,
  },
  es: {
    problem: (p) => {
      switch (p.kind) {
        case 'unknown-option':
          return `opción desconocida ${p.token}`;
        case 'missing-value':
          return `la opción --${p.option} necesita un valor`;
        case 'unexpected-value':
          return `la opción --${p.option} no admite un valor (se recibió ${p.token})`;
        case 'malformed-option':
          return `no se pudo interpretar ${p.token} como opción`;
        case 'repeated-option':
          return `la opción --${p.option} se indicó más de una vez`;
        case 'unexpected-argument':
          return `argumento inesperado ${p.token}`;
      }
    },
    nothingDone: (command) => `No se hizo nada. Consulte: browser-link ${command} --help`,
  },
};

/** The refusal, as the lines the command line prints on stderr: what was
 * not understood, then that nothing was done and where the help is. */
export function formatArgProblem(path: string, problem: ArgProblem, language: Language): string[] {
  const t = ARG_I18N[language];
  const command = path.split(' ')[0] ?? path;
  return [`browser-link ${path}: ${t.problem(problem)}`, t.nothingDone(command)];
}

/** A refused command line, thrown by a command module that was called with
 * arguments the grammar does not accept. */
export class CommandLineError extends Error {
  constructor(
    readonly path: string,
    readonly problem: ArgProblem,
    language: Language,
  ) {
    super(formatArgProblem(path, problem, language).join('\n'));
    this.name = 'CommandLineError';
  }
}

/** The spec of one subcommand (or of the command itself when `sub` is
 * undefined). Throws for a pair the grammar does not declare: that is a
 * programming error, not a user one. */
export function argsSpec(command: string, sub?: string): ArgsSpec {
  const grammar = Object.hasOwn(COMMAND_LINE, command) ? COMMAND_LINE[command] : undefined;
  const spec = sub === undefined ? grammar?.args : grammar?.subcommands?.[sub];
  if (spec === undefined) throw new Error(`No command-line grammar for "${command} ${sub ?? ''}"`);
  return spec;
}

/** Read the words after `browser-link <path>` for a command module. A
 * refused line throws `CommandLineError`; help is the command line's job,
 * so here `--help` is an unknown option like any other. */
export function readArgs(path: string, tokens: readonly string[], language: Language): ParsedArgs {
  const [command, sub] = path.split(' ');
  const parsed = parseArgs(argsSpec(command, sub), tokens);
  if (!parsed.ok) throw new CommandLineError(path, parsed.problem, language);
  return parsed.args;
}

/** Read a whole command line (subcommand word included) for a command
 * module; an unknown first word yields no arguments, for the module to
 * report as its unknown action. */
export function readCommandArgs(
  command: string,
  argv: readonly string[],
  language: Language,
): ParsedArgs {
  const line = parseCommandLine(command, argv, { detectHelp: false });
  if (line === undefined) throw new Error(`No command-line grammar for "${command}"`);
  if (line.kind === 'error') throw new CommandLineError(line.path, line.problem, language);
  return line.kind === 'ok' ? line.args : EMPTY_ARGS;
}
