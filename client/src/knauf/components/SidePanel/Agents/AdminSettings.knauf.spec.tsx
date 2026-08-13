import { render } from '@testing-library/react';

let mockDialogProps: {
  permissionType?: string;
  permissions?: Array<{ permission: string; labelKey: string }>;
} = {};

jest.mock('librechat-data-provider', () => ({
  PermissionTypes: { AGENTS: 'AGENTS' },
  Permissions: {
    USE: 'USE',
    KNAUF_SCHEDULE: 'KNAUF_SCHEDULE',
    CREATE: 'CREATE',
    SHARE: 'SHARE',
    SHARE_PUBLIC: 'SHARE_PUBLIC',
  },
}));

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: jest.fn() }),
}));

jest.mock('~/components/ui', () => ({
  AdminSettingsDialog: (props: typeof mockDialogProps) => {
    mockDialogProps = props;
    return null;
  },
}));

jest.mock('~/data-provider', () => ({
  useUpdateAgentPermissionsMutation: () => ({ mutate: jest.fn() }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

import AdminSettings from '~/components/SidePanel/Agents/AdminSettings';

describe('Agent AdminSettings scheduler seam', () => {
  it('exposes Scheduled Chats as a dedicated Agent role permission', () => {
    render(<AdminSettings />);

    expect(mockDialogProps.permissionType).toBe('AGENTS');
    expect(mockDialogProps.permissions).toContainEqual({
      permission: 'KNAUF_SCHEDULE',
      labelKey: 'com_knauf_scheduler_title',
    });
  });
});
