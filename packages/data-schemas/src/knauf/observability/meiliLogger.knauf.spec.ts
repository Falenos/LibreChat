import logger from '../../config/winston';
import meiliLogger from '../../config/meiliLogger';

describe('Meilisearch logging contract', () => {
  it('uses the shared structured logger', () => {
    expect(meiliLogger).toBe(logger);
  });
});
