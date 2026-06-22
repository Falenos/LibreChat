import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { RecoilRoot } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EModelEndpoint, Providers, knaufChatUploadAccept } from 'librechat-data-provider';
import AttachFileMenu from '../AttachFileMenu';

jest.mock('~/hooks', () => ({
  useAgentToolPermissions: jest.fn(),
  useAgentCapabilities: jest.fn(),
  useGetAgentsConfig: jest.fn(),
  useFileHandlingNoChatContext: jest.fn(),
  useLocalize: jest.fn(),
}));

jest.mock('~/hooks/Files/useSharePointFileHandling', () => ({
  __esModule: true,
  default: jest.fn(),
  useSharePointFileHandlingNoChatContext: jest.fn(),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: jest.fn(),
}));

jest.mock('~/components/SharePoint', () => ({
  SharePointPickerDialog: () => null,
}));

// [knauf] The "Supported file types" dialog has its own seam test; stub it here so
// this menu test doesn't pull in OGDialog (absent from the @librechat/client mock
// above). A jest.fn so this spec can assert the dialog's `open` prop flips to true
// when the standalone formats menu item is clicked. KK20-190 (upload-guidance).
jest.mock('~/knauf/components/Chat/KnaufUploadFormatsDialog', () => ({
  __esModule: true,
  default: jest.fn(() => null),
}));

jest.mock('@librechat/client', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    // [knauf] forwardRef + render a real <input> so inputRef.current resolves and
    // the file-picker accept string can be observed via a click spy. KK20-190.
    FileUpload: R.forwardRef((props, ref) =>
      R.createElement(
        'div',
        { 'data-testid': 'file-upload' },
        props.children,
        R.createElement('input', { ref, type: 'file', 'data-testid': 'file-input' }),
      ),
    ),
    // End [knauf]
    TooltipAnchor: (props) => props.render,
    DropdownPopup: (props) =>
      R.createElement(
        'div',
        null,
        R.createElement('div', { onClick: () => props.setIsOpen(!props.isOpen) }, props.trigger),
        props.isOpen &&
          R.createElement(
            'div',
            { 'data-testid': 'dropdown-menu' },
            props.items.map((item, idx) =>
              R.createElement(
                'button',
                { key: idx, onClick: item.onClick, 'data-testid': `menu-item-${idx}` },
                item.label,
              ),
            ),
          ),
      ),
    AttachmentIcon: () => R.createElement('span', { 'data-testid': 'attachment-icon' }),
    SharePointIcon: () => R.createElement('span', { 'data-testid': 'sharepoint-icon' }),
    useToastContext: () => ({ showToast: jest.fn() }),
  };
});

jest.mock('@ariakit/react', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const R = require('react');
  return {
    MenuButton: (props) => R.createElement('button', props, props.children),
  };
});

const mockUseAgentToolPermissions = jest.requireMock('~/hooks').useAgentToolPermissions;
const mockUseAgentCapabilities = jest.requireMock('~/hooks').useAgentCapabilities;
const mockUseGetAgentsConfig = jest.requireMock('~/hooks').useGetAgentsConfig;
const mockUseFileHandlingNoChatContext = jest.requireMock('~/hooks').useFileHandlingNoChatContext;
const mockUseLocalize = jest.requireMock('~/hooks').useLocalize;
const mockUseSharePointFileHandling = jest.requireMock(
  '~/hooks/Files/useSharePointFileHandling',
).default;
const mockUseSharePointFileHandlingNoChatContext = jest.requireMock(
  '~/hooks/Files/useSharePointFileHandling',
).useSharePointFileHandlingNoChatContext;
const mockUseGetStartupConfig = jest.requireMock('~/data-provider').useGetStartupConfig;

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

function setupMocks(overrides: { provider?: string } = {}) {
  const translations: Record<string, string> = {
    // [knauf] KK20-123 — Tier 5 swap in AttachFileMenu.tsx replaced
    // `com_ui_upload_provider` ("Upload to Provider") with the generic
    // `com_ui_upload_files` ("Upload files"). Keep both mocks here so
    // any future revert of the label is detected by the spec.
    com_ui_upload_provider: 'Upload to Provider',
    com_ui_upload_files: 'Upload files',
    com_ui_upload_image_input: 'Upload Image',
    com_ui_upload_ocr_text: 'Upload as Text',
    com_ui_upload_file_search: 'Upload for File Search',
    com_ui_upload_code_files: 'Upload Code Files',
    com_sidepanel_attach_files: 'Attach Files',
    com_files_upload_sharepoint: 'Upload from SharePoint',
    // [knauf] Label of the standalone "View supported formats" menu item. KK20-190.
    com_knauf_upload_formats_title: 'Supported file types',
  };
  mockUseLocalize.mockReturnValue((key: string) => translations[key] || key);
  mockUseAgentCapabilities.mockReturnValue({
    contextEnabled: false,
    fileSearchEnabled: false,
    codeEnabled: false,
  });
  mockUseGetAgentsConfig.mockReturnValue({ agentsConfig: {} });
  mockUseFileHandlingNoChatContext.mockReturnValue({ handleFileChange: jest.fn() });
  const sharePointReturnValue = {
    handleSharePointFiles: jest.fn(),
    isProcessing: false,
    downloadProgress: 0,
    error: null,
  };
  mockUseSharePointFileHandling.mockReturnValue(sharePointReturnValue);
  mockUseSharePointFileHandlingNoChatContext.mockReturnValue(sharePointReturnValue);
  mockUseGetStartupConfig.mockReturnValue({ data: { sharePointFilePickerEnabled: false } });
  mockUseAgentToolPermissions.mockReturnValue({
    fileSearchAllowedByAgent: false,
    codeAllowedByAgent: false,
    provider: overrides.provider ?? undefined,
  });
}

function renderMenu(props: Record<string, unknown> = {}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <RecoilRoot>
        <AttachFileMenu
          conversationId="test-convo"
          files={new Map()}
          setFiles={() => {}}
          setFilesLoading={() => {}}
          conversation={null}
          {...props}
        />
      </RecoilRoot>
    </QueryClientProvider>,
  );
}

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: /attach file options/i }));
}

describe('AttachFileMenu', () => {
  beforeEach(jest.clearAllMocks);

  // [knauf] KK20-123 — provider-doc upload item is rendered with the
  // generic "Upload files" label (com_ui_upload_files) instead of
  // upstream's "Upload to Provider" (com_ui_upload_provider). The gating
  // logic (endpointType/provider → show provider-doc vs image-only) is
  // identical to upstream; only the label changed.
  describe('Upload files vs Upload Image', () => {
    it('shows "Upload files" when endpointType is custom (resolved from agent provider)', () => {
      setupMocks({ provider: 'Moonshot' });
      renderMenu({ endpointType: EModelEndpoint.custom });
      openMenu();
      expect(screen.getByText('Upload files')).toBeInTheDocument();
      expect(screen.queryByText('Upload Image')).not.toBeInTheDocument();
    });

    it('shows "Upload files" when endpointType is openAI', () => {
      setupMocks({ provider: EModelEndpoint.openAI });
      renderMenu({ endpointType: EModelEndpoint.openAI });
      openMenu();
      expect(screen.getByText('Upload files')).toBeInTheDocument();
    });

    it('shows "Upload files" when endpointType is anthropic', () => {
      setupMocks({ provider: EModelEndpoint.anthropic });
      renderMenu({ endpointType: EModelEndpoint.anthropic });
      openMenu();
      expect(screen.getByText('Upload files')).toBeInTheDocument();
    });

    it('shows "Upload files" when endpointType is google', () => {
      setupMocks({ provider: Providers.GOOGLE });
      renderMenu({ endpointType: EModelEndpoint.google });
      openMenu();
      expect(screen.getByText('Upload files')).toBeInTheDocument();
    });

    it('shows "Upload Image" when endpointType is agents (no provider resolution)', () => {
      setupMocks();
      renderMenu({ endpointType: EModelEndpoint.agents });
      openMenu();
      expect(screen.getByText('Upload Image')).toBeInTheDocument();
      expect(screen.queryByText('Upload files')).not.toBeInTheDocument();
    });

    it('shows "Upload Image" when neither endpointType nor provider supports documents', () => {
      setupMocks({ provider: 'unknown-provider' });
      renderMenu({ endpointType: 'unknown-type' });
      openMenu();
      expect(screen.getByText('Upload Image')).toBeInTheDocument();
    });

    it('shows "Upload files" for azureOpenAI with useResponsesApi', () => {
      setupMocks({ provider: EModelEndpoint.azureOpenAI });
      renderMenu({ endpointType: EModelEndpoint.azureOpenAI, useResponsesApi: true });
      openMenu();
      expect(screen.getByText('Upload files')).toBeInTheDocument();
    });

    it('shows "Upload Image" for azureOpenAI without useResponsesApi', () => {
      setupMocks({ provider: EModelEndpoint.azureOpenAI });
      renderMenu({ endpointType: EModelEndpoint.azureOpenAI, useResponsesApi: false });
      openMenu();
      expect(screen.getByText('Upload Image')).toBeInTheDocument();
    });
  });

  describe('agent provider resolution scenario', () => {
    it('shows "Upload files" when agents endpoint has custom endpointType from provider', () => {
      setupMocks({ provider: 'Moonshot' });
      renderMenu({
        endpoint: EModelEndpoint.agents,
        endpointType: EModelEndpoint.custom,
      });
      openMenu();
      expect(screen.getByText('Upload files')).toBeInTheDocument();
    });

    it('shows "Upload Image" when agents endpoint has no resolved provider type', () => {
      setupMocks();
      renderMenu({
        endpoint: EModelEndpoint.agents,
        endpointType: EModelEndpoint.agents,
      });
      openMenu();
      expect(screen.getByText('Upload Image')).toBeInTheDocument();
    });
  });

  describe('Basic Rendering', () => {
    it('renders the attachment button', () => {
      setupMocks();
      renderMenu();
      expect(screen.getByRole('button', { name: /attach file options/i })).toBeInTheDocument();
    });

    it('is disabled when disabled prop is true', () => {
      setupMocks();
      renderMenu({ disabled: true });
      expect(screen.getByRole('button', { name: /attach file options/i })).toBeDisabled();
    });

    it('is not disabled when disabled prop is false', () => {
      setupMocks();
      renderMenu({ disabled: false });
      expect(screen.getByRole('button', { name: /attach file options/i })).not.toBeDisabled();
    });
  });

  describe('Agent Capabilities', () => {
    it('shows OCR Text option when context is enabled', () => {
      setupMocks();
      mockUseAgentCapabilities.mockReturnValue({
        contextEnabled: true,
        fileSearchEnabled: false,
        codeEnabled: false,
      });
      renderMenu({ endpointType: EModelEndpoint.openAI });
      openMenu();
      expect(screen.getByText('Upload as Text')).toBeInTheDocument();
    });

    // [knauf] KK20-123 — Tier 5 swap hides the chat-paperclip "Upload
    // for File Search" item unconditionally. Knowledge uploads now go
    // through the agent builder's Data Knowledge panel (KnaufFileSearch)
    // only — adding files from chat would create an ad-hoc RAG corpus
    // tied to the conversation, conflicting with the Knauf per-agent
    // curation model. The test below pins the seam behavior: even when
    // upstream's gates (fileSearchEnabled + fileSearchAllowedByAgent)
    // are both true, the item stays out of the menu.
    it('does NOT show File Search even when enabled and allowed by agent (Knauf seam)', () => {
      setupMocks();
      mockUseAgentCapabilities.mockReturnValue({
        contextEnabled: false,
        fileSearchEnabled: true,
        codeEnabled: false,
      });
      mockUseAgentToolPermissions.mockReturnValue({
        fileSearchAllowedByAgent: true,
        codeAllowedByAgent: false,
        provider: undefined,
      });
      renderMenu({ endpointType: EModelEndpoint.openAI });
      openMenu();
      expect(screen.queryByText('Upload for File Search')).not.toBeInTheDocument();
    });

    it('does NOT show File Search when enabled but not allowed by agent', () => {
      setupMocks();
      mockUseAgentCapabilities.mockReturnValue({
        contextEnabled: false,
        fileSearchEnabled: true,
        codeEnabled: false,
      });
      renderMenu({ endpointType: EModelEndpoint.openAI });
      openMenu();
      expect(screen.queryByText('Upload for File Search')).not.toBeInTheDocument();
    });

    it('shows Code Files option when enabled and allowed by agent', () => {
      setupMocks();
      mockUseAgentCapabilities.mockReturnValue({
        contextEnabled: false,
        fileSearchEnabled: false,
        codeEnabled: true,
      });
      mockUseAgentToolPermissions.mockReturnValue({
        fileSearchAllowedByAgent: false,
        codeAllowedByAgent: true,
        provider: undefined,
      });
      renderMenu({ endpointType: EModelEndpoint.openAI });
      openMenu();
      expect(screen.getByText('Upload Code Files')).toBeInTheDocument();
    });

    it('shows all options when all capabilities are enabled', () => {
      setupMocks();
      mockUseAgentCapabilities.mockReturnValue({
        contextEnabled: true,
        fileSearchEnabled: true,
        codeEnabled: true,
      });
      mockUseAgentToolPermissions.mockReturnValue({
        fileSearchAllowedByAgent: true,
        codeAllowedByAgent: true,
        provider: undefined,
      });
      renderMenu({ endpointType: EModelEndpoint.openAI });
      openMenu();
      // [knauf] KK20-123 — "Upload files" replaces "Upload to Provider"
      // and "Upload for File Search" is hidden unconditionally.
      expect(screen.getByText('Upload files')).toBeInTheDocument();
      expect(screen.getByText('Upload as Text')).toBeInTheDocument();
      expect(screen.queryByText('Upload for File Search')).not.toBeInTheDocument();
      expect(screen.getByText('Upload Code Files')).toBeInTheDocument();
    });
  });

  // [knauf] KK20-190 — on the Azure Responses-API chat, "Upload files" routes
  // documents into chat-scoped File Search (RAG) via an ephemeral agent and
  // restricts the picker to the Knauf allow-list. This pins both the routing
  // decision (gated on capabilities.fileSearchEnabled) and the picker `accept`
  // string, which mirrors fileConfig.supportedMimeTypes in librechat.yaml — if
  // the YAML allow-list changes, this assertion fails so the two stay in sync.
  describe('Knauf File Search routing', () => {
    // Single source: the picker accept string is the exported knaufChatUploadAccept
    // (which mirrors the &knauf_allowed_mime allow-list in librechat.yaml).
    const KNAUF_ALLOWED_ACCEPT = knaufChatUploadAccept;

    function clickUploadFilesCapturingAccept(): string | undefined {
      let capturedAccept: string | undefined;
      const clickSpy = jest.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (
        this: HTMLInputElement,
      ) {
        capturedAccept = this.accept;
      });
      try {
        openMenu();
        fireEvent.click(screen.getByText('Upload files'));
      } finally {
        clickSpy.mockRestore();
      }
      return capturedAccept;
    }

    it('routes "Upload files" to the Knauf allow-list when File Search is enabled', () => {
      setupMocks({ provider: EModelEndpoint.azureOpenAI });
      mockUseAgentCapabilities.mockReturnValue({
        contextEnabled: false,
        fileSearchEnabled: true,
        codeEnabled: false,
      });
      renderMenu({ endpointType: EModelEndpoint.azureOpenAI, useResponsesApi: true });
      expect(clickUploadFilesCapturingAccept()).toBe(KNAUF_ALLOWED_ACCEPT);
    });

    it('keeps the upstream provider-upload path when File Search is disabled', () => {
      setupMocks({ provider: EModelEndpoint.azureOpenAI });
      mockUseAgentCapabilities.mockReturnValue({
        contextEnabled: false,
        fileSearchEnabled: false,
        codeEnabled: false,
      });
      renderMenu({ endpointType: EModelEndpoint.azureOpenAI, useResponsesApi: true });
      expect(clickUploadFilesCapturingAccept()).not.toBe(KNAUF_ALLOWED_ACCEPT);
    });

    // The supported-formats help is a standalone role=menuitem (not a button
    // nested inside the upload row) so it's keyboard/SR-reachable. These pin that
    // it exists only under the File Search gate and opens the dialog on click.
    it('opens the supported-formats dialog from its own menu item when File Search is enabled', () => {
      const formatsDialog = jest.requireMock(
        '~/knauf/components/Chat/KnaufUploadFormatsDialog',
      ).default;
      formatsDialog.mockClear();
      setupMocks({ provider: EModelEndpoint.azureOpenAI });
      mockUseAgentCapabilities.mockReturnValue({
        contextEnabled: false,
        fileSearchEnabled: true,
        codeEnabled: false,
      });
      renderMenu({ endpointType: EModelEndpoint.azureOpenAI, useResponsesApi: true });
      openMenu();
      // Dialog starts closed, then the menu item click flips `open` to true.
      expect(formatsDialog.mock.calls.at(-1)[0].open).toBe(false);
      fireEvent.click(screen.getByText('Supported file types'));
      expect(formatsDialog.mock.calls.at(-1)[0].open).toBe(true);
    });

    it('does not render the supported-formats menu item when File Search is disabled', () => {
      setupMocks({ provider: EModelEndpoint.azureOpenAI });
      mockUseAgentCapabilities.mockReturnValue({
        contextEnabled: false,
        fileSearchEnabled: false,
        codeEnabled: false,
      });
      renderMenu({ endpointType: EModelEndpoint.azureOpenAI, useResponsesApi: true });
      openMenu();
      expect(screen.queryByText('Supported file types')).toBeNull();
    });
  });
  // End [knauf]

  describe('SharePoint Integration', () => {
    it('shows SharePoint option when enabled', () => {
      setupMocks();
      mockUseGetStartupConfig.mockReturnValue({
        data: { sharePointFilePickerEnabled: true },
      });
      renderMenu({ endpointType: EModelEndpoint.openAI });
      openMenu();
      expect(screen.getByText('Upload from SharePoint')).toBeInTheDocument();
    });

    it('does NOT show SharePoint option when disabled', () => {
      setupMocks();
      renderMenu({ endpointType: EModelEndpoint.openAI });
      openMenu();
      expect(screen.queryByText('Upload from SharePoint')).not.toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('handles undefined endpoint and provider gracefully', () => {
      setupMocks();
      renderMenu({ endpoint: undefined, endpointType: undefined });
      const button = screen.getByRole('button', { name: /attach file options/i });
      expect(button).toBeInTheDocument();
      fireEvent.click(button);
      expect(screen.getByText('Upload Image')).toBeInTheDocument();
    });

    it('handles null endpoint and provider gracefully', () => {
      setupMocks();
      renderMenu({ endpoint: null, endpointType: null });
      expect(screen.getByRole('button', { name: /attach file options/i })).toBeInTheDocument();
    });

    it('handles missing agentId gracefully', () => {
      setupMocks();
      renderMenu({ agentId: undefined, endpointType: EModelEndpoint.openAI });
      expect(screen.getByRole('button', { name: /attach file options/i })).toBeInTheDocument();
    });

    it('handles empty string agentId', () => {
      setupMocks();
      renderMenu({ agentId: '', endpointType: EModelEndpoint.openAI });
      expect(screen.getByRole('button', { name: /attach file options/i })).toBeInTheDocument();
    });
  });
});
