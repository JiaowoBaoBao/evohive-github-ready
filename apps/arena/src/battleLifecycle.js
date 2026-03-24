import { db, now } from './db.js';
import { config } from './config.js';

export function sweepBattleWindows() {
  const ts = now();

  const challengeExpireBefore = ts - config.battleTiming.challengeWindowSec;
  const runWindow = config.battleTiming.acceptLockSec + config.battleTiming.executionSec + config.battleTiming.settlementSec;
  const acceptedExpireBefore = ts - runWindow;

  const expiredChallenged = db
    .prepare(
      `UPDATE battles
       SET status = 'expired_challenge'
       WHERE status = 'challenged' AND scheduled_at <= ?`
    )
    .run(challengeExpireBefore).changes;

  const expiredAccepted = db
    .prepare(
      `UPDATE battles
       SET status = 'expired_execution'
       WHERE status = 'accepted' AND accepted_at IS NOT NULL AND accepted_at <= ?`
    )
    .run(acceptedExpireBefore).changes;

  return {
    at: ts,
    expiredChallenged,
    expiredAccepted
  };
}
