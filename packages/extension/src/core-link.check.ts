// Proof that the extension resolves a runtime import of @browser-link/core
// (design 2.2): `tsc --noEmit` type-checks this file, and
// fitness-core-link.test.ts bundles it with esbuild. No bundle entry reaches
// it, so it never ships; it goes away once background.ts imports core for
// real.
import { createMemoryCdpSession } from '@browser-link/core';

/** A fake session answering one command, built from core at runtime. */
export function coreLinkSession(): Promise<{ product: string }> {
  const session = createMemoryCdpSession({
    'Browser.getVersion': () => ({ product: 'core-link' }),
  });
  return session.send<{ product: string }>('Browser.getVersion');
}
