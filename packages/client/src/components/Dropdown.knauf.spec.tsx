// [knauf] Guard shared Dropdown portal interaction and OGDialog stacking.
import { fireEvent, render, screen } from '@testing-library/react';
import Dropdown from './Dropdown';
import { OGDialog, OGDialogContent } from './OriginalDialog';

const options = [
  { label: 'Option A', value: 'a' },
  { label: 'Option B', value: 'b' },
];

const openDropdown = (name: string) => {
  fireEvent.click(screen.getByRole('combobox', { name }));
  return document.querySelector('.popover-ui') as HTMLElement | null;
};

describe('Dropdown portal stacking', () => {
  it('uses the standard portal layer outside dialogs', () => {
    render(
      <Dropdown
        value="a"
        onChange={jest.fn()}
        options={options}
        ariaLabel="Standalone dropdown"
      />,
    );

    expect(openDropdown('Standalone dropdown')).toHaveStyle({ zIndex: '50' });
  });

  it('keeps its body portal interactive and above the owning dialog', () => {
    render(
      <OGDialog open>
        <OGDialogContent>
          <Dropdown
            value="a"
            onChange={jest.fn()}
            options={options}
            ariaLabel="Modal dropdown"
          />
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

    const popover = openDropdown('Inline dropdown');
    expect(popover).not.toHaveClass('[pointer-events:auto]');
    expect(popover).not.toHaveStyle({ zIndex: '150' });
  });
});
// End [knauf]
