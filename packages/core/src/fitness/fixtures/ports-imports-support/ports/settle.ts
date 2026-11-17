// RED: ports are the bottom layer and import nothing in core.
import type { SettleOptions } from '../support/settle.js';

export type Settle = (options: SettleOptions) => Promise<void>;
