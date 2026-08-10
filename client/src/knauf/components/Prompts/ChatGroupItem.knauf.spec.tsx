import { fireEvent, render, screen } from '@testing-library/react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { PermissionBits, Permissions, ResourceType, SystemRoles } from 'librechat-data-provider';
import type { TPromptGroup } from 'librechat-data-provider';
import ChatGroupItem from '~/components/Prompts/lists/ChatGroupItem';

const mockUseHasAccess = jest.fn();
const mockHasPermission = jest.fn();
const mockUser = { id: 'owner-1', role: SystemRoles.USER };
let mockHasPeoplePickerAccess = true;
let mockCanSharePublic = false;

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: mockUser }),
  useCanSharePublic: () => mockCanSharePublic,
  useHasAccess: (args: unknown) => mockUseHasAccess(args),
  useLocalize: () => (key: string) => key,
  usePeoplePickerPermissions: () => ({ hasPeoplePickerAccess: mockHasPeoplePickerAccess }),
  useResourcePermissions: () => ({ hasPermission: mockHasPermission, isLoading: false }),
  useSubmitMessage: () => ({ submitPrompt: jest.fn() }),
}));

jest.mock('~/data-provider', () => ({
  useDeletePromptGroup: () => ({ mutate: jest.fn(), isLoading: false }),
  useRecordPromptUsage: () => ({ mutate: jest.fn() }),
}));

jest.mock('~/Providers', () => ({
  useLiveAnnouncer: () => ({ announcePolite: jest.fn() }),
}));

jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  DropdownPopup: ({
    items,
  }: {
    items: Array<{ label?: string; show?: boolean; onClick?: () => void }>;
  }) => (
    <div>
      {items
        .filter((item) => item.show !== false)
        .map((item) => (
          <button key={item.label} type="button" onClick={item.onClick}>
            {item.label}
          </button>
        ))}
    </div>
  ),
  Label: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  OGDialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  OGDialogTemplate: () => null,
  Spinner: () => <span>spinner</span>,
  TooltipAnchor: ({ render }: { render: React.ReactNode }) => render,
  useToastContext: () => ({ showToast: jest.fn() }),
}));

jest.mock('~/components/Sharing', () => ({
  GenericGrantAccessDialog: ({
    open,
    resourceType,
  }: {
    open?: boolean;
    resourceType: ResourceType;
  }) => (open ? <div data-testid="share-dialog">{resourceType}</div> : null),
}));

jest.mock('~/components/Prompts/dialogs/PreviewPrompt', () => () => null);
jest.mock('~/components/Prompts/dialogs/VariableDialog', () => () => null);
jest.mock('~/components/Prompts/utils/CategoryIcon', () => () => null);

const group = {
  _id: 'prompt-1',
  author: 'owner-1',
  name: 'Weather prompt',
  category: 'General',
  productionPrompt: { prompt: 'Tell me the weather' },
} as TPromptGroup;

function renderItem(promptGroup: TPromptGroup = group) {
  return render(
    <MemoryRouter>
      <ChatGroupItem group={promptGroup} isChatRoute={false} />
    </MemoryRouter>,
  );
}

describe('ChatGroupItem prompt sharing menu', () => {
  beforeEach(() => {
    mockUseHasAccess.mockImplementation(
      ({ permission }: { permission: Permissions }) => permission === Permissions.SHARE,
    );
    mockHasPermission.mockReturnValue(false);
    mockHasPeoplePickerAccess = true;
    mockCanSharePublic = false;
    mockUser.id = 'owner-1';
    mockUser.role = SystemRoles.USER;
  });

  it('opens peer sharing for an owner without public-sharing permission', () => {
    renderItem();

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_share' }));

    expect(screen.getByTestId('share-dialog')).toHaveTextContent(ResourceType.PROMPTGROUP);
  });

  it('shows sharing for a non-owner granted SHARE on the prompt', () => {
    mockHasPermission.mockImplementation((permission) => permission === PermissionBits.SHARE);

    renderItem({ ...group, author: 'other-user', authorName: 'Other User' });

    expect(screen.getByRole('button', { name: 'com_ui_share' })).toBeInTheDocument();
  });

  it('hides sharing when neither people search nor public sharing is available', () => {
    mockHasPeoplePickerAccess = false;

    renderItem();

    expect(screen.queryByRole('button', { name: 'com_ui_share' })).not.toBeInTheDocument();
  });
});
