/**
 * The console vocabulary `browser.console` documents is
 * log | info | warn | error | debug. Chrome reports `warning` (both
 * Runtime.consoleAPICalled and Log.entryAdded) and `verbose` (Log.entryAdded),
 * so the stored level is normalised to the documented names; otherwise a
 * `level: 'warn'` filter can never match a warning. Other CDP types (dir,
 * table, trace, ...) are kept as Chrome names them.
 */
export function normalizeConsoleLevel(level: string | undefined): string {
  switch (level) {
    case undefined:
      return 'log';
    case 'warning':
      return 'warn';
    case 'verbose':
      return 'debug';
    default:
      return level;
  }
}
