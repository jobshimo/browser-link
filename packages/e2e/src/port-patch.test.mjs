// patchBridgePort: rewrites the bridge port in the built background.js. esbuild
// emits `var`, tsc-style builds keep `const`; both must be patched.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { patchBridgePort } from './lib.mjs';

test('patches a const BRIDGE_PORT and keeps const', () => {
  const src = 'x();\nconst BRIDGE_PORT = 17529;\ny();\n';
  assert.equal(patchBridgePort(src, 4242), 'x();\nconst BRIDGE_PORT = 4242;\ny();\n');
});

test('patches a var BRIDGE_PORT (esbuild) and keeps var', () => {
  const src = 'x();\nvar BRIDGE_PORT = 17529;\ny();\n';
  assert.equal(patchBridgePort(src, 4242), 'x();\nvar BRIDGE_PORT = 4242;\ny();\n');
});

test('throws naming const|var when the line is absent', () => {
  assert.throws(() => patchBridgePort('let BRIDGE_PORT = 17529;\n', 4242), {
    message: '"const|var BRIDGE_PORT = 17529;" not found in background.js',
  });
});

test('does not match an indented or mid-line declaration', () => {
  assert.throws(() => patchBridgePort('  var BRIDGE_PORT = 17529;\n', 4242), /not found/);
});
