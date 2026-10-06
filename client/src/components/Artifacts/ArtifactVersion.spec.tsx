// [knauf] KK20-410 — sparse persisted revision seam test.
import { fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import ArtifactVersion from './ArtifactVersion';

jest.mock('@ariakit/react', () => ({
  MenuButton: ({ children }: { children: ReactNode }) => <button>{children}</button>,
}));

jest.mock('@librechat/client', () => ({
  Button: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownPopup: ({
    trigger,
    items,
  }: {
    trigger: ReactNode;
    items: Array<{ label: string; onClick: () => void; disabled?: boolean }>;
  }) => (
    <div>
      {trigger}
      {items.map((item) => (
        <button key={item.label} type="button" disabled={item.disabled} onClick={item.onClick}>
          {item.label}
        </button>
      ))}
    </div>
  ),
  TooltipAnchor: ({ render }: { render: ReactNode }) => <>{render}</>,
  useMediaQuery: () => false,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<number, string>) =>
    values?.[0] ? `${key}:${values[0]}` : key,
}));

describe('ArtifactVersion', () => {
  it('labels sparse history with persisted version numbers', () => {
    const onVersionChange = jest.fn();

    render(
      <ArtifactVersion
        currentIndex={1}
        versions={[
          { version: 1, available: false },
          { version: 4, available: true },
        ]}
        onVersionChange={onVersionChange}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'com_ui_version_var:1 — com_ui_unavailable' }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_version_var:4' }));
    expect(onVersionChange).toHaveBeenCalledWith(1);
  });
});
// End [knauf]
