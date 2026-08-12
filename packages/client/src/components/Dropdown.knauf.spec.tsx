// [knauf] Guard shared Dropdown portal interaction and OGDialog stacking.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen } from '@testing-library/react';
import Dropdown from './Dropdown';
import { OGDialog, OGDialogContent } from './OriginalDialog';

const options = [
  { label: 'Option A', value: 'a' },
  { label: 'Option B', value: 'b' },
];

const readClientSource = (relativePath: string) =>
  readFileSync(resolve(__dirname, '../../../../client/src', relativePath), 'utf8');

const openDropdown = (name: string) => {
  fireEvent.click(screen.getByRole('combobox', { name }));
  return document.querySelector('.popover-ui') as HTMLElement | null;
};

describe('Dropdown portal stacking', () => {
  it('uses the standard portal layer outside dialogs', () => {
    render(
      <Dropdown value="a" onChange={jest.fn()} options={options} ariaLabel="Standalone dropdown" />,
    );

    expect(openDropdown('Standalone dropdown')).toHaveStyle({ zIndex: '50' });
  });

  it('keeps its body portal interactive and above the owning dialog', () => {
    render(
      <OGDialog open>
        <OGDialogContent>
          <Dropdown value="a" onChange={jest.fn()} options={options} ariaLabel="Modal dropdown" />
        </OGDialogContent>
      </OGDialog>,
    );

    const popover = openDropdown('Modal dropdown');
    expect(popover).toHaveClass('[pointer-events:auto]');
    expect(popover).toHaveStyle({ zIndex: '150' });
  });

  it('does not override stacking when the portal is disabled', () => {
    render(
      <OGDialog open>
        <OGDialogContent>
          <Dropdown
            value="a"
            onChange={jest.fn()}
            options={options}
            ariaLabel="Inline dropdown"
            portal={false}
          />
        </OGDialogContent>
      </OGDialog>,
    );

    expect(openDropdown('Inline dropdown')).not.toHaveStyle({ zIndex: '150' });
  });
});

describe('legacy modal dropdown workarounds', () => {
  it.each([
    'components/Nav/ExportConversation/ExportModal.tsx',
    'components/Input/SetKeyDialog/SetKeyDialog.tsx',
  ])('uses the shared portal stack in %s', (relativePath) => {
    const source = readClientSource(relativePath);

    expect(source).not.toContain('portal={false}');
    expect(source).not.toContain('className="z-50"');
  });
});
// End [knauf]
