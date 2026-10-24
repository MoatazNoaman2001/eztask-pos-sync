import { PosSync } from '../../db/schema';

export type NextAction = 'create' | 'lookup' | 'cancel' | 'done';

/**
 * The whole sync state machine in one table (docs/sync-state-machine.md):
 * compare what we want the POS to hold with what we know it holds, and pick the next step.
 *
 * Because a cancel only changes `desired`, a cancel can never overtake its create:
 * both are steps on the same row, decided here one at a time (spec guarantee 3).
 */
export function nextAction(desired: PosSync['desired'], posState: PosSync['posState']): NextAction {
  if (desired === 'present') {
    switch (posState) {
      case 'none':
        return 'create';
      case 'unknown':
        return 'lookup'; // a create may have landed: never create blindly again
      case 'created':
        return 'done';
      case 'cancelled':
        return 'done'; // can't happen: a cancelled check can't be paid again (409)
    }
  }

  switch (posState) {
    case 'none':
      return 'done'; // create never sent: the POS never hears of this check
    case 'unknown':
      return 'lookup'; // find out what exists, then cancel it
    case 'created':
      return 'cancel';
    case 'cancelled':
      return 'done';
  }
}
