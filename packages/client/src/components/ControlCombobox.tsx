import {
  useMemo,
  useState,
  useRef,
  memo,
  useEffect,
  useCallback,
  type MouseEvent,
  MemoExoticComponent,
} from 'react';
import * as Ariakit from '@ariakit/react';
import { matchSorter } from 'match-sorter';
// [knauf] Icons for custom-group creation and row-level deletion actions.
import { Search, ChevronDown, Plus, X } from 'lucide-react';
// End [knauf]
import { SelectRenderer } from '@ariakit/react-core/select/select-renderer';
import type { OptionWithIcon } from '~/common';
import './AnimatePopover.css';
import { JSX } from 'react/jsx-runtime';
import { cn } from '~/utils';

interface ControlComboboxProps {
  selectedValue: string;
  displayValue?: string;
  items: OptionWithIcon[];
  setValue: (value: string) => void;
  ariaLabel: string;
  searchPlaceholder?: string;
  selectPlaceholder?: string;
  isCollapsed: boolean;
  SelectIcon?: React.ReactNode;
  containerClassName?: string;
  iconClassName?: string;
  showCarat?: boolean;
  className?: string;
  disabled?: boolean;
  iconSide?: 'left' | 'right';
  selectId?: string;
  placement?: Ariakit.SelectStoreProps['placement'];
  // [knauf] Optional searched-value action for creatable selectors.
  createPromptLabel?: string;
  createInputPlaceholder?: string;
  createSaveLabel?: string;
  getCreateLabel?: (value: string) => string;
  // End [knauf]
  // [knauf] Optional row-level deletion for admin-managed custom groups.
  isItemDeletable?: (value: string) => boolean;
  onDeleteItem?: (value: string) => void;
  getDeleteItemLabel?: (label: string) => string;
  deleteItemDisabled?: boolean;
  // End [knauf]
}

const ROW_HEIGHT = 36;

function ControlCombobox({
  selectedValue,
  displayValue,
  items,
  setValue,
  ariaLabel,
  searchPlaceholder,
  selectPlaceholder,
  containerClassName,
  isCollapsed,
  SelectIcon,
  showCarat,
  className,
  disabled,
  iconClassName,
  iconSide = 'left',
  selectId,
  placement,
  // [knauf] Read the optional creatable-selector label callback.
  createPromptLabel,
  createInputPlaceholder,
  createSaveLabel,
  getCreateLabel,
  // End [knauf]
  // [knauf] Read optional row-level deletion controls.
  isItemDeletable,
  onDeleteItem,
  getDeleteItemLabel,
  deleteItemDisabled,
  // End [knauf]
}: ControlComboboxProps): JSX.Element {
  const [searchValue, setSearchValue] = useState('');
  const buttonRef = useRef<HTMLButtonElement>(null);
  // [knauf] Inline custom-group form state and focus target.
  const [isCreating, setIsCreating] = useState(false);
  const [createValue, setCreateValue] = useState('');
  const createInputRef = useRef<HTMLInputElement>(null);
  // End [knauf]
  const [buttonWidth, setButtonWidth] = useState<number | null>(null);

  const getItem = (option: OptionWithIcon) => ({
    // [knauf] Custom group labels may contain spaces or punctuation; keep DOM ids valid.
    id: `item-${encodeURIComponent(String(option.value ?? ''))}`,
    // End [knauf]
    value: option.value as string | undefined,
    label: option.label,
    icon: option.icon,
  });

  const combobox = Ariakit.useComboboxStore({
    defaultItems: items.map(getItem),
    resetValueOnHide: true,
    value: searchValue,
    setValue: setSearchValue,
  });

  const select = Ariakit.useSelectStore({
    combobox,
    defaultItems: items.map(getItem),
    value: selectedValue,
    setValue,
    placement,
  });

  // [knauf] Persist the inline form value through the selector's existing create path.
  useEffect(() => {
    if (isCreating) {
      createInputRef.current?.focus();
    }
  }, [isCreating]);

  const saveCreateValue = () => {
    const value = createValue.trim();
    if (!value) {
      return;
    }
    setValue(value);
    select.hide();
    setIsCreating(false);
    setCreateValue('');
  };
  // End [knauf]

  const matches = useMemo(() => {
    const filteredItems = matchSorter(items, searchValue, {
      keys: ['value', 'label'],
      baseSort: (a, b) => (a.index < b.index ? -1 : 1),
    });

    // [knauf] Offer the current search as a new value when no exact option exists.
    const createValue = searchValue.trim();
    const normalizedCreateValue = createValue.toLocaleLowerCase('en');
    const hasExactItem = items.some(
      (item) =>
        String(item.value ?? '').toLocaleLowerCase('en') === normalizedCreateValue ||
        (item.label ?? '').toLocaleLowerCase('en') === normalizedCreateValue,
    );
    if (getCreateLabel && createValue && !hasExactItem) {
      filteredItems.push({ value: createValue, label: getCreateLabel(createValue) });
    }
    return filteredItems.map(getItem);
  }, [getCreateLabel, searchValue, items]);
  // End [knauf]

  // [knauf] Keep delete clicks from selecting or closing the surrounding option row.
  const stopDeletePointer = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);
  const handleDeleteItem = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      stopDeletePointer(event);
      const value = event.currentTarget.dataset.value;
      if (value) {
        onDeleteItem?.(value);
      }
    },
    [onDeleteItem, stopDeletePointer],
  );
  // End [knauf]

  useEffect(() => {
    const button = buttonRef.current;
    if (!button || isCollapsed) {
      return;
    }

    setButtonWidth(button.offsetWidth);

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      const width = entry.borderBoxSize?.[0]?.inlineSize ?? button.offsetWidth;
      if (width > 0) {
        setButtonWidth(width);
      }
    });

    observer.observe(button);
    return () => observer.disconnect();
  }, [isCollapsed]);

  const selectIconClassName = cn(
    'flex h-5 w-5 items-center justify-center overflow-hidden rounded-full',
    iconClassName,
  );
  const optionIconClassName = cn(
    'mr-2 flex h-5 w-5 items-center justify-center overflow-hidden rounded-full',
    iconClassName,
  );

  return (
    <div className={cn('flex w-full items-center justify-center px-1', containerClassName)}>
      <Ariakit.SelectLabel store={select} className="sr-only">
        {ariaLabel}
      </Ariakit.SelectLabel>
      <Ariakit.Select
        ref={buttonRef}
        store={select}
        id={selectId}
        disabled={disabled}
        className={cn(
          'flex items-center justify-center gap-2 rounded-full bg-surface-secondary',
          'text-text-primary hover:bg-surface-tertiary',
          'border border-border-light',
          isCollapsed ? 'h-9 w-9' : 'h-9 w-full rounded-xl px-3 py-2 text-sm',
          className,
        )}
      >
        {SelectIcon != null && iconSide === 'left' && (
          <div className={selectIconClassName}>{SelectIcon}</div>
        )}
        {!isCollapsed && (
          <>
            <span className="flex-grow truncate text-left">
              {displayValue != null
                ? displayValue || selectPlaceholder
                : selectedValue || selectPlaceholder}
            </span>
            {SelectIcon != null && iconSide === 'right' && (
              <div className={selectIconClassName}>{SelectIcon}</div>
            )}
            {showCarat && <ChevronDown className="h-4 w-4 text-text-secondary" />}
          </>
        )}
      </Ariakit.Select>
      <Ariakit.SelectPopover
        store={select}
        gutter={4}
        portal
        className={cn(
          'animate-popover z-40 overflow-hidden rounded-xl border border-border-light bg-surface-secondary shadow-lg',
        )}
        style={{ width: isCollapsed ? '300px' : (buttonWidth ?? '300px') }}
      >
        <div className="py-1.5">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-primary" />
            <Ariakit.Combobox
              store={combobox}
              autoSelect
              placeholder={searchPlaceholder}
              className="w-full rounded-md bg-surface-secondary py-2 pl-9 pr-3 text-sm text-text-primary focus:outline-none"
            />
          </div>
        </div>
        <div className="max-h-[300px] overflow-auto">
          <Ariakit.ComboboxList store={combobox}>
            <SelectRenderer store={select} items={matches} itemSize={ROW_HEIGHT} overscan={5}>
              {({ value, icon, label, ...item }) => (
                <Ariakit.ComboboxItem
                  key={item.id}
                  {...item}
                  className={cn(
                    'flex w-full cursor-pointer items-center px-3 text-sm',
                    'text-text-primary hover:bg-surface-tertiary',
                    'data-[active-item]:bg-surface-tertiary',
                  )}
                  render={<Ariakit.SelectItem value={value} />}
                >
                  {icon != null && iconSide === 'left' && (
                    <div className={optionIconClassName}>{icon}</div>
                  )}
                  <span className="flex-grow truncate text-left">{label}</span>
                  {icon != null && iconSide === 'right' && (
                    <div className={optionIconClassName}>{icon}</div>
                  )}
                  {/* [knauf] Put the admin delete action directly on each custom-group row. */}
                  {value != null &&
                    isItemDeletable?.(value) &&
                    onDeleteItem &&
                    getDeleteItemLabel && (
                      <button
                        type="button"
                        data-value={value}
                        disabled={deleteItemDisabled}
                        aria-label={getDeleteItemLabel(String(label ?? value))}
                        title={getDeleteItemLabel(String(label ?? value))}
                        onMouseDown={stopDeletePointer}
                        onClick={handleDeleteItem}
                        className="ml-2 shrink-0 rounded p-1 text-text-secondary hover:bg-surface-tertiary hover:text-red-600 disabled:cursor-not-allowed disabled:opacity-50 dark:hover:text-red-400"
                      >
                        <X aria-hidden="true" className="h-4 w-4" />
                      </button>
                    )}
                  {/* End [knauf] */}
                </Ariakit.ComboboxItem>
              )}
            </SelectRenderer>
          </Ariakit.ComboboxList>
        </div>
        {/* [knauf] Keep custom-group creation discoverable before users start typing. */}
        {createPromptLabel && createInputPlaceholder && createSaveLabel && !searchValue.trim() && (
          <div className="border-t border-border-light p-1.5">
            {isCreating ? (
              <div className="flex items-center gap-2">
                <input
                  ref={createInputRef}
                  type="text"
                  aria-label={createInputPlaceholder}
                  placeholder={createInputPlaceholder}
                  value={createValue}
                  onChange={(event) => setCreateValue(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      saveCreateValue();
                    }
                  }}
                  className="h-8 min-w-0 flex-1 rounded-md border border-border-light bg-transparent px-2 text-sm text-text-primary focus:outline-none"
                />
                <button
                  type="button"
                  disabled={!createValue.trim()}
                  onClick={saveCreateValue}
                  className="h-8 rounded-md bg-primary px-3 text-sm text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {createSaveLabel}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setIsCreating(true)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-primary hover:bg-surface-tertiary"
              >
                <Plus aria-hidden="true" className="h-4 w-4" />
                <span>{createPromptLabel}</span>
              </button>
            )}
          </div>
        )}
        {/* End [knauf] */}
      </Ariakit.SelectPopover>
    </div>
  );
}

const ControlComboboxMemo: MemoExoticComponent<typeof ControlCombobox> = memo(ControlCombobox);
export default ControlComboboxMemo;
