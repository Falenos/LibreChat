import { act, fireEvent, render, screen } from '@testing-library/react';
import ControlCombobox from './ControlCombobox';
// [knauf] Exercise the combobox through the same modal stack used by scheduler.
import { OGDialog, OGDialogContent } from './OriginalDialog';
// End [knauf]

type CapturedObserver = {
  callback: ResizeObserverCallback;
  target: Element | null;
  disconnect: jest.Mock;
};

const observers: CapturedObserver[] = [];

class CapturingResizeObserver {
  callback: ResizeObserverCallback;
  target: Element | null = null;
  disconnect = jest.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }

  observe(target: Element) {
    this.target = target;
  }

  unobserve = jest.fn();
}

const originalResizeObserver = window.ResizeObserver;

beforeEach(() => {
  observers.length = 0;
  (window as unknown as { ResizeObserver: typeof CapturingResizeObserver }).ResizeObserver =
    CapturingResizeObserver;
});

afterEach(() => {
  (window as unknown as { ResizeObserver: typeof ResizeObserver }).ResizeObserver =
    originalResizeObserver;
});

const items = [
  { label: 'Option A', value: 'a' },
  { label: 'Option B', value: 'b' },
];

const renderCombobox = (initialButtonWidth: number, isCollapsed = false) => {
  const offsetWidthSpy = jest
    .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
    .mockReturnValue(initialButtonWidth);

  const utils = render(
    <ControlCombobox
      selectedValue="a"
      displayValue="Option A"
      items={items}
      setValue={() => undefined}
      ariaLabel="Test combobox"
      isCollapsed={isCollapsed}
      showCarat
    />,
  );

  return { ...utils, offsetWidthSpy };
};

const getPopoverWidth = () => {
  const popover = document.querySelector('.animate-popover') as HTMLElement | null;
  return popover?.style.width ?? null;
};

const openPopover = () => {
  const trigger = screen.getByRole('combobox');
  act(() => {
    trigger.click();
  });
};

describe('ControlCombobox popover sizing', () => {
  it('uses the button width measured on mount when layout is stable', () => {
    renderCombobox(275);
    openPopover();
    expect(getPopoverWidth()).toBe('275px');
  });

  it('updates the popover width when the trigger resizes after mount (regression: agent select dropdown rendering at narrow width)', () => {
    const { offsetWidthSpy } = renderCombobox(26);
    openPopover();
    expect(getPopoverWidth()).toBe('26px');

    const observer = observers[0];
    expect(observer).toBeDefined();
    expect(observer.target).not.toBeNull();

    offsetWidthSpy.mockReturnValue(275);

    act(() => {
      observer.callback(
        [
          {
            target: observer.target as Element,
            contentRect: { width: 275 } as DOMRectReadOnly,
            borderBoxSize: [{ inlineSize: 275, blockSize: 36 }],
            contentBoxSize: [{ inlineSize: 275, blockSize: 36 }],
            devicePixelContentBoxSize: [{ inlineSize: 275, blockSize: 36 }],
          } as unknown as ResizeObserverEntry,
        ],
        observer as unknown as ResizeObserver,
      );
    });

    expect(getPopoverWidth()).toBe('275px');
  });

  it('disconnects the ResizeObserver on unmount', () => {
    const { unmount } = renderCombobox(275);
    openPopover();
    const observer = observers[0];
    expect(observer).toBeDefined();
    unmount();
    expect(observer.disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not observe the trigger button when isCollapsed is true', () => {
    renderCombobox(275, true);
    const triggerObservers = observers.filter(
      (o) => (o.target as HTMLElement | null)?.tagName === 'BUTTON',
    );
    expect(triggerObservers).toHaveLength(0);
  });

  it('falls back to synchronous offsetWidth when ResizeObserver is unavailable', () => {
    (window as unknown as { ResizeObserver: typeof ResizeObserver | undefined }).ResizeObserver =
      undefined;

    renderCombobox(275);
    openPopover();

    expect(getPopoverWidth()).toBe('275px');
    const triggerObservers = observers.filter(
      (o) => (o.target as HTMLElement | null)?.tagName === 'BUTTON',
    );
    expect(triggerObservers).toHaveLength(0);
  });

  it('uses button.offsetWidth when borderBoxSize is unavailable', () => {
    const { offsetWidthSpy } = renderCombobox(26);
    openPopover();
    expect(getPopoverWidth()).toBe('26px');

    const observer = observers[0];
    expect(observer).toBeDefined();

    offsetWidthSpy.mockReturnValue(275);

    act(() => {
      observer.callback(
        [
          {
            target: observer.target as Element,
            contentRect: { width: 251 } as DOMRectReadOnly,
            borderBoxSize: undefined,
            contentBoxSize: undefined,
            devicePixelContentBoxSize: undefined,
          } as unknown as ResizeObserverEntry,
        ],
        observer as unknown as ResizeObserver,
      );
    });

    expect(getPopoverWidth()).toBe('275px');
  });

  it('ignores zero-width resize entries', () => {
    renderCombobox(275);
    openPopover();
    expect(getPopoverWidth()).toBe('275px');

    const observer = observers[0];
    expect(observer).toBeDefined();

    act(() => {
      observer.callback(
        [
          {
            target: observer.target as Element,
            contentRect: { width: 0 } as DOMRectReadOnly,
            borderBoxSize: [{ inlineSize: 0, blockSize: 0 }],
            contentBoxSize: [{ inlineSize: 0, blockSize: 0 }],
            devicePixelContentBoxSize: [{ inlineSize: 0, blockSize: 0 }],
          } as unknown as ResizeObserverEntry,
        ],
        observer as unknown as ResizeObserver,
      );
    });

    expect(getPopoverWidth()).toBe('275px');
  });

  // [knauf] Guard modal compatibility for the scheduler's portalled agent picker.
  it('keeps the portalled popover pointer-interactive inside modal body locks', () => {
    renderCombobox(275);
    openPopover();

    expect(document.querySelector('.animate-popover')).toHaveClass('[pointer-events:auto]');
  });
  // End [knauf]

  // [knauf] Guard the scheduler selector's modal stacking contract.
  it('stacks its portalled popover above the owning dialog', () => {
    render(
      <OGDialog open>
        <OGDialogContent>
          <ControlCombobox
            selectedValue=""
            items={items}
            setValue={() => undefined}
            ariaLabel="Modal combobox"
            isCollapsed={false}
          />
        </OGDialogContent>
      </OGDialog>,
    );

    fireEvent.click(screen.getByRole('combobox', { name: 'Modal combobox' }));

    expect(document.querySelector('.animate-popover')).toHaveStyle({ zIndex: '150' });
  });
  // End [knauf]

  // [knauf] Guard selectors whose options arrive after their initial render.
  it('renders options that load asynchronously', () => {
    const props = {
      selectedValue: '',
      items: [] as typeof items,
      setValue: jest.fn(),
      ariaLabel: 'Async combobox',
      isCollapsed: false,
    };
    const { rerender } = render(<ControlCombobox {...props} />);

    rerender(<ControlCombobox {...props} items={items} />);
    fireEvent.click(screen.getByRole('combobox'));

    expect(screen.getByRole('option', { name: 'Option A' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Option B' })).toBeInTheDocument();
  });
  // End [knauf]
});

// [knauf] Pin the searched-value extension used by agent custom groups.
describe('ControlCombobox creatable values', () => {
  it('opens an inline form and saves a new value from the persistent prompt', () => {
    const setValue = jest.fn();
    render(
      <ControlCombobox
        selectedValue="a"
        displayValue="Option A"
        items={items}
        setValue={setValue}
        ariaLabel="Creatable combobox"
        searchPlaceholder="Search"
        isCollapsed={false}
        createPromptLabel="Create new group"
        createInputPlaceholder="Name"
        createSaveLabel="Save"
        getCreateLabel={(value) => `Create group ${value}`}
      />,
    );

    fireEvent.click(screen.getByRole('combobox'));
    const createPrompt = screen.getByRole('button', { name: 'Create new group' });
    fireEvent.click(createPrompt);

    const nameInput = screen.getByRole('textbox', { name: 'Name' });
    expect(nameInput).toHaveFocus();
    fireEvent.change(nameInput, { target: { value: 'Field Operations' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(setValue).toHaveBeenCalledWith('Field Operations');
  });

  it('offers an unmatched search as a create option but not an exact item', () => {
    render(
      <ControlCombobox
        selectedValue="a"
        displayValue="Option A"
        items={items}
        setValue={() => undefined}
        ariaLabel="Creatable combobox"
        searchPlaceholder="Search"
        isCollapsed={false}
        createPromptLabel="Create new group"
        createInputPlaceholder="Name"
        createSaveLabel="Save"
        getCreateLabel={(value) => `Create group ${value}`}
      />,
    );

    fireEvent.click(screen.getByRole('combobox'));
    const search = screen.getByPlaceholderText('Search');
    fireEvent.change(search, { target: { value: 'Field Operations' } });
    expect(screen.queryByRole('button', { name: 'Create new group' })).not.toBeInTheDocument();
    expect(screen.getByText('Create group Field Operations')).toBeInTheDocument();

    fireEvent.change(search, { target: { value: 'Option A' } });
    expect(screen.queryByText('Create group Option A')).not.toBeInTheDocument();
  });

  it('deletes only eligible option rows without selecting them', () => {
    const setValue = jest.fn();
    const onDeleteItem = jest.fn();
    render(
      <ControlCombobox
        selectedValue="a"
        displayValue="Option A"
        items={items}
        setValue={setValue}
        ariaLabel="Deletable combobox"
        isCollapsed={false}
        isItemDeletable={(value) => value === 'b'}
        onDeleteItem={onDeleteItem}
        getDeleteItemLabel={(label) => `Delete ${label}`}
      />,
    );

    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.queryByRole('button', { name: 'Delete Option A' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete Option B' }));

    expect(onDeleteItem).toHaveBeenCalledWith('b');
    expect(setValue).not.toHaveBeenCalled();
  });
});
// End [knauf]
