const isPublicSharedLinkRead = require('./isPublicSharedLinkRead');

const request = (path, method = 'GET') => ({ path, method });

describe('isPublicSharedLinkRead', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.ALLOW_SHARED_LINKS = 'true';
    process.env.ALLOW_SHARED_LINKS_PUBLIC = 'true';
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test.each([
    '/share/share-1',
    '/share/share-1/config',
    '/share/share-1/files/file-1',
    '/share/share-1/files/file-1/download',
    '/share/share-1/files/file-1/preview',
  ])('allows the public read route %s to reach share authorization', (path) => {
    expect(isPublicSharedLinkRead(request(path))).toBe(true);
  });

  test.each([
    ['POST', '/share/conversation-1/artifact'],
    ['PATCH', '/share/share-1'],
    ['DELETE', '/share/share-1'],
    ['GET', '/share/link/conversation-1'],
    ['GET', '/share'],
    ['GET', '/share/share-1/unknown'],
  ])('keeps %s %s behind the migration gate', (method, path) => {
    expect(isPublicSharedLinkRead(request(path, method))).toBe(false);
  });

  it('keeps reads gated when public sharing is disabled', () => {
    process.env.ALLOW_SHARED_LINKS_PUBLIC = 'false';

    expect(isPublicSharedLinkRead(request('/share/share-1'))).toBe(false);
  });

  it('keeps reads gated when shared links are disabled', () => {
    process.env.ALLOW_SHARED_LINKS = 'false';

    expect(isPublicSharedLinkRead(request('/share/share-1'))).toBe(false);
  });
});
