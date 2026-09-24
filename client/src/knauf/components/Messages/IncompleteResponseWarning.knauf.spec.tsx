import fs from 'fs';
import path from 'path';
import { render, screen } from '@testing-library/react';
import IncompleteResponseWarning, { isIncompleteResponseError } from './IncompleteResponseWarning';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

describe('[knauf] incomplete streamed response warning', () => {
  it('recognizes only the bounded application-owned error payload', () => {
    expect(isIncompleteResponseError('{"type":"incomplete_response"}')).toBe(true);
    expect(
      isIncompleteResponseError(
        '{"type":"incomplete_response","message":"private provider detail"}',
      ),
    ).toBe(false);
  });

  it('renders a polite localized warning', () => {
    render(<IncompleteResponseWarning />);

    expect(screen.getByRole('status')).toHaveTextContent('com_knauf_incomplete_response_warning');
    expect(screen.getByRole('status')).toHaveAttribute('aria-live', 'polite');
  });

  it('is mounted by the upstream content-part renderer', () => {
    const partSource = fs.readFileSync(
      path.resolve(__dirname, '../../../components/Chat/Messages/Content/Part.tsx'),
      'utf8',
    );

    expect(partSource).toContain('isIncompleteResponseError(errorText)');
    expect(partSource).toContain('<IncompleteResponseWarning />');
  });
});
