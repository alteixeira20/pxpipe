import { beforeEach, describe, expect, it, vi } from 'vitest';

const { writeCooldown } = vi.hoisted(() => ({
  writeCooldown: vi.fn(),
}));

vi.mock('../src/agy-quota.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/agy-quota.js')>();
  return {
    ...actual,
    writeAgyCooldownForModel: writeCooldown,
  };
});

import { recordAgyBatchCooldown } from '../src/agy-execution.js';

describe('AGY batch cooldown scoping', () => {
  beforeEach(() => {
    writeCooldown.mockReset();
  });

  it('records quota exhaustion against the explicitly selected model', () => {
    const failure = {
      kind: 'quota_exhausted' as const,
      safeMessage: 'AGY quota is exhausted.',
      resetAfterSeconds: 2349,
    };
    recordAgyBatchCooldown(failure, [
      '--output-format', 'json',
      '--model', 'claude-sonnet-4-6',
    ]);
    expect(writeCooldown).toHaveBeenCalledTimes(1);
    expect(writeCooldown).toHaveBeenCalledWith(failure, 'claude-sonnet-4-6');
  });

  it('keeps a Gemini batch independent from a Claude model cooldown', () => {
    const failure = {
      kind: 'rate_limited' as const,
      safeMessage: 'AGY is rate limited.',
      resetAfterSeconds: 60,
    };
    recordAgyBatchCooldown(failure, [
      '--model=gemini-3.6-flash-high',
      '--output-format=json',
    ]);
    expect(writeCooldown).toHaveBeenCalledWith(failure, 'gemini-3.6-flash-high');
  });

  it('does not write a cooldown for successful calls', () => {
    recordAgyBatchCooldown(null, ['--model', 'gemini-3.6-flash-high']);
    expect(writeCooldown).not.toHaveBeenCalled();
  });
});
