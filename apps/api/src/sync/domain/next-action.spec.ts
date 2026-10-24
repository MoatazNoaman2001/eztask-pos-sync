import { nextAction } from './next-action';

describe('nextAction (the sync decision table)', () => {
  it.each([
    ['present', 'none', 'create'],
    ['present', 'unknown', 'lookup'],
    ['present', 'created', 'done'],
    ['present', 'cancelled', 'done'],
    ['absent', 'none', 'done'],
    ['absent', 'unknown', 'lookup'],
    ['absent', 'created', 'cancel'],
    ['absent', 'cancelled', 'done'],
  ] as const)('desired=%s, posState=%s → %s', (desired, posState, expected) => {
    expect(nextAction(desired, posState)).toBe(expected);
  });

  it('never creates when the outcome of an earlier create is unknown', () => {
    expect(nextAction('present', 'unknown')).not.toBe('create');
  });

  it('never sends anything for a check cancelled before its create was sent', () => {
    expect(nextAction('absent', 'none')).toBe('done');
  });
});
