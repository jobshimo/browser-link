// RED: a two-file import cycle (type-only imports count).
import type { B } from './b.js';

export interface A {
  b: B;
}
