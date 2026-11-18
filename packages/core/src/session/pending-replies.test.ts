import { describe, expect, it } from 'vitest';
import { createManualClock } from '../ports/contract/fakes.js';
import { PendingReplies } from './pending-replies.js';

function setup() {
  const clock = createManualClock(1_000);
  const replies = new PendingReplies<string>(clock);
  return { clock, replies };
}

describe('PendingReplies', () => {
  it('resolves a waiter with the reply to its id', async () => {
    const { replies } = setup();
    const answer = replies.wait('a', 100, () => 'timeout');
    replies.settle('a', 'reply-a');
    await expect(answer).resolves.toBe('reply-a');
  });

  it('correlates out-of-order replies by id', async () => {
    const { replies } = setup();
    const a = replies.wait('a', 100, () => 'timeout');
    const b = replies.wait('b', 100, () => 'timeout');
    replies.settle('b', 'reply-b');
    replies.settle('a', 'reply-a');
    await expect(a).resolves.toBe('reply-a');
    await expect(b).resolves.toBe('reply-b');
  });

  it('settles an id at most once: a second reply is ignored', async () => {
    const { replies } = setup();
    const seen: string[] = [];
    const answer = replies.wait('a', 100, () => 'timeout').then((r) => seen.push(r));
    replies.settle('a', 'first');
    replies.settle('a', 'second');
    await answer;
    expect(seen).toEqual(['first']);
  });

  it('ignores a reply for an id nobody waits for', () => {
    const { replies } = setup();
    expect(() => {
      replies.settle('unknown', 'x');
      replies.settle('__proto__', 'x');
      replies.settle('toString', 'x');
    }).not.toThrow();
  });

  it('expires a waiter at its timeout with onTimeout(), and a late reply is ignored', async () => {
    const { clock, replies } = setup();
    const seen: string[] = [];
    const answer = replies.wait('a', 100, () => 'timeout').then((r) => seen.push(r));
    await clock.advance(99);
    expect(seen).toEqual([]);
    await clock.advance(1);
    await answer;
    replies.settle('a', 'late');
    await Promise.resolve();
    expect(seen).toEqual(['timeout']);
  });

  it('a reply before the timeout cancels the timer: onTimeout never runs', async () => {
    const { clock, replies } = setup();
    let timeouts = 0;
    const answer = replies.wait('a', 100, () => {
      timeouts++;
      return 'timeout';
    });
    replies.settle('a', 'reply');
    await clock.advance(1_000);
    await expect(answer).resolves.toBe('reply');
    expect(timeouts).toBe(0);
  });

  it('builds the timeout value only when the timeout fires', async () => {
    const { clock, replies } = setup();
    let built = 0;
    const answer = replies.wait('a', 50, () => `timeout #${String(++built)}`);
    expect(built).toBe(0);
    await clock.advance(50);
    await expect(answer).resolves.toBe('timeout #1');
  });
});
