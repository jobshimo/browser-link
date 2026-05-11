import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { claudeInstaller } from '../installers/claude.js';
import { installFor } from './install.js';
import { formatDoctor, runDoctor } from './doctor.js';
import { printExtensionInstructions } from './extension.js';

async function ask(rl: Interface, question: string): Promise<string> {
  const answer = await rl.question(question);
  return answer.trim();
}

function claudeStatusLabel(): string {
  const d = claudeInstaller.detect();
  if (!d.installed) return 'Claude config not found';
  return d.registered ? 'already registered' : 'not registered';
}

function renderMenu(): string {
  return [
    '',
    'browser-link — setup',
    '',
    'What do you want to do?',
    '',
    `  1) Register browser-link in Claude Code   (status: ${claudeStatusLabel()})`,
    `  2) Show Chrome extension install steps`,
    `  3) Run doctor (diagnose current setup)`,
    `  4) Quit`,
    '',
  ].join('\n');
}

async function handleChoice(choice: string): Promise<boolean> {
  // Returns true to keep the loop running, false to exit.
  switch (choice) {
    case '1': {
      const report = installFor('claude');
      const prefix = report.installedClient ? '✓' : '·';
      console.log(`${prefix} ${report.displayName}: ${report.message}`);
      if (report.installedClient) {
        console.log('  Restart Claude Code so it picks up the new MCP entry.');
        console.log('  Next: install the Chrome extension (option 2).');
      }
      return true;
    }
    case '2': {
      printExtensionInstructions();
      return true;
    }
    case '3': {
      const r = await runDoctor();
      console.log(formatDoctor(r));
      return true;
    }
    case '4':
    case 'q':
    case 'Q':
    case 'quit':
    case 'exit':
      return false;
    default:
      console.log(`Unknown choice: "${choice}". Pick a number between 1 and 4.`);
      return true;
  }
}

export async function runMenu(): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    let keepGoing = true;
    while (keepGoing) {
      console.log(renderMenu());
      let choice: string;
      try {
        choice = await ask(rl, 'Choose [1-4]: ');
      } catch {
        // SIGINT / Ctrl-C
        break;
      }
      console.log('');
      try {
        keepGoing = await handleChoice(choice);
      } catch (err) {
        console.error('Error:', err instanceof Error ? err.message : String(err));
      }
      if (keepGoing) {
        console.log('');
        try {
          await ask(rl, 'Press Enter to continue…');
        } catch {
          break;
        }
      }
    }
  } finally {
    rl.close();
  }
}
