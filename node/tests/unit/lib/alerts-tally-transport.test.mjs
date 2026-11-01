/**
 * The tally counts what the logger writes. It used to be built at level
 * 'silly', so in production (logger level info) it counted debug lines that
 * no file or console ever got, and the volume rule fired on them ("1088 lines
 * a minute, mostly tmdb-config") with nothing to show for it on the Logs page.
 */

import { describe, it, expect } from '@jest/globals';
import { createLogger, format } from 'winston';
import { LogTally, LogTallyTransport } from '../../../lib/alerts/tally.mjs';

function loggerAt(level) {
  const tally = new LogTally({ now: () => 0 });
  const logger = createLogger({ level, format: format.json(), transports: [new LogTallyTransport(tally)] });
  return { tally, logger };
}

const counted = (tally) => tally.snapshot().minutes.reduce((sum, minute) => sum + minute.total, 0);

describe('LogTallyTransport', () => {
  it("counts only the records at or above the logger's level", () => {
    const { tally, logger } = loggerAt('info');

    logger.debug('Loaded TMDB config', { category: 'tmdb-config' });
    logger.info('Generated new frame', { category: 'main' });
    logger.warn('Retrying', { category: 'tmdb-api' });

    expect(counted(tally)).toBe(2);
    const [minute] = tally.snapshot().minutes;
    expect(minute.categories.has('tmdb-config')).toBe(false);
  });

  it('counts debug lines when the logger writes them (development)', () => {
    const { tally, logger } = loggerAt('debug');

    logger.debug('Loaded TMDB config', { category: 'tmdb-config' });

    expect(counted(tally)).toBe(1);
  });
});
