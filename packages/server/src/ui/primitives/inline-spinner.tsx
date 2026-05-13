import { Text } from 'ink';
import { useEffect, useState } from 'react';
import { COLORS } from '../tokens.js';

/* Inline animated spinner — used inside long-running async screens
 * (Updates, FreePort, Doctor). Hand-rolled instead of pulling in
 * `ink-spinner` because the dep isn't already in the lockfile and the
 * surface we need is exactly ten braille frames cycling at 100ms. */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const FRAME_INTERVAL_MS = 100;

interface InlineSpinnerProps {
  /** Optional override for the spinner color. Defaults to the primary
   * (cyan) role so it reads as "active" against the body. */
  color?: string;
}

export function InlineSpinner({ color = COLORS.primary }: InlineSpinnerProps) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setTick((t) => (t + 1) % FRAMES.length);
    }, FRAME_INTERVAL_MS);
    return () => {
      clearInterval(id);
    };
  }, []);
  return <Text color={color}>{FRAMES[tick]}</Text>;
}
