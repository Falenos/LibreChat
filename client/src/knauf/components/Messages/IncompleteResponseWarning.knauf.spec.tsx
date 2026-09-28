import fs from 'fs';
import path from 'path';
import { isIncompleteResponseError } from './IncompleteResponseWarning';

describe('[knauf] incomplete streamed response payload', () => {
  it('recognizes only the bounded application-owned error payload', () => {
    expect(isIncompleteResponseError('{"type":"incomplete_response"}')).toBe(true);
    expect(
      isIncompleteResponseError(
        '{"type":"incomplete_response","message":"private provider detail"}',
      ),
    ).toBe(false);
  });

  it('is suppressed by the upstream content-part renderer', () => {
    const partSource = fs.readFileSync(
      path.resolve(__dirname, '../../../components/Chat/Messages/Content/Part.tsx'),
      'utf8',
    );

    expect(partSource).toContain('isIncompleteResponseError(errorText)');
    expect(partSource).toMatch(/if \(isIncompleteResponseError\(errorText\)\) \{\s+return null;/);
  });
});
