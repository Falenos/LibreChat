import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import CreatePromptButton from '~/components/Prompts/buttons/CreatePromptButton';

const mockUseHasAccess = jest.fn();

jest.mock('~/hooks', () => ({
  useHasAccess: () => mockUseHasAccess(),
  useLocalize: () => (key: string) => key,
}));

describe('CreatePromptButton', () => {
  it('keeps an unavailable create control visible without linking restricted users', () => {
    mockUseHasAccess.mockReturnValue(false);

    render(
      <MemoryRouter>
        <CreatePromptButton />
      </MemoryRouter>,
    );

    expect(
      screen.getByRole('button', {
        name: 'com_ui_create_prompt — com_ui_unavailable',
      }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('links users with create access to the new prompt form', () => {
    mockUseHasAccess.mockReturnValue(true);

    render(
      <MemoryRouter>
        <CreatePromptButton />
      </MemoryRouter>,
    );

    expect(screen.getByRole('link', { name: 'com_ui_create_prompt' })).toHaveAttribute(
      'href',
      '/prompts/new',
    );
  });
});
