import {
  EModelEndpoint,
  EToolResources,
  isDocumentSupportedProvider,
  inferMimeType,
} from 'librechat-data-provider';

// [knauf] Seam-test harness for the single-option auto-select (KK20-190). Renders
// DragDropModal with its hook dependencies mocked; librechat-data-provider stays
// REAL (the provider-detection suite below relies on it). The matching `describe`
// is at the bottom of this file. KK20-190.
import { render, screen } from '@testing-library/react';
import DragDropModal from '../DragDropModal';

let mockCapabilities = { fileSearchEnabled: true, codeEnabled: false, contextEnabled: false };
let mockToolPerms: {
  fileSearchAllowedByAgent: boolean;
  codeAllowedByAgent: boolean;
  provider: string;
} = {
  fileSearchAllowedByAgent: true,
  codeAllowedByAgent: false,
  provider: EModelEndpoint.openAI,
};

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useGetAgentsConfig: () => ({ agentsConfig: { capabilities: [] } }),
  useAgentCapabilities: () => mockCapabilities,
  useAgentToolPermissions: () => mockToolPerms,
}));
jest.mock('~/Providers', () => ({
  useDragDropContext: () => ({
    conversationId: 'c1',
    agentId: 'agent_1',
    endpoint: 'agents',
    endpointType: 'openAI',
    useResponsesApi: false,
  }),
}));
jest.mock('~/store', () => ({ ephemeralAgentByConvoId: (id: string) => id }));
jest.mock('recoil', () => ({ useRecoilValue: () => ({}) }));
jest.mock('@librechat/client', () => {
  const ReactLib = jest.requireActual('react');
  return {
    OGDialog: ({ open, children }: { open?: boolean; children?: unknown }) =>
      open ? ReactLib.createElement('div', null, children) : null,
    OGDialogTemplate: ({ title, main }: { title?: unknown; main?: unknown }) =>
      ReactLib.createElement('div', null, ReactLib.createElement('div', null, title), main),
  };
});
// End [knauf]

describe('DragDropModal - Provider Detection', () => {
  describe('endpointType priority over currentProvider', () => {
    it('should show upload option for LiteLLM with OpenAI endpointType', () => {
      const currentProvider = 'litellm'; // NOT in documentSupportedProviders
      const endpointType = EModelEndpoint.openAI; // IS in documentSupportedProviders

      // With fix: endpointType checked
      const withFix =
        isDocumentSupportedProvider(endpointType) || isDocumentSupportedProvider(currentProvider);
      expect(withFix).toBe(true);

      // Without fix: only currentProvider checked = false
      const withoutFix = isDocumentSupportedProvider(currentProvider || endpointType);
      expect(withoutFix).toBe(false);
    });

    it('should show upload option for any custom gateway with OpenAI endpointType', () => {
      const currentProvider = 'my-custom-gateway';
      const endpointType = EModelEndpoint.openAI;

      const result =
        isDocumentSupportedProvider(endpointType) || isDocumentSupportedProvider(currentProvider);
      expect(result).toBe(true);
    });

    it('should fallback to currentProvider when endpointType is undefined', () => {
      const currentProvider = EModelEndpoint.openAI;
      const endpointType = undefined;

      const result =
        isDocumentSupportedProvider(endpointType) || isDocumentSupportedProvider(currentProvider);
      expect(result).toBe(true);
    });

    it('should fallback to currentProvider when endpointType is null', () => {
      const currentProvider = EModelEndpoint.anthropic;
      const endpointType = null;

      const result =
        isDocumentSupportedProvider(endpointType as any) ||
        isDocumentSupportedProvider(currentProvider);
      expect(result).toBe(true);
    });

    it('should return false when neither provider supports documents', () => {
      const currentProvider = 'unsupported-provider';
      const endpointType = 'unsupported-endpoint' as any;

      const result =
        isDocumentSupportedProvider(endpointType) || isDocumentSupportedProvider(currentProvider);
      expect(result).toBe(false);
    });
  });

  describe('supported providers', () => {
    const supportedProviders = [
      { name: 'OpenAI', value: EModelEndpoint.openAI },
      { name: 'Anthropic', value: EModelEndpoint.anthropic },
      { name: 'Google', value: EModelEndpoint.google },
      { name: 'Custom', value: EModelEndpoint.custom },
    ];

    supportedProviders.forEach(({ name, value }) => {
      it(`should recognize ${name} as supported`, () => {
        expect(isDocumentSupportedProvider(value)).toBe(true);
      });
    });

    it('should NOT recognize Azure OpenAI as supported (requires useResponsesApi)', () => {
      expect(isDocumentSupportedProvider(EModelEndpoint.azureOpenAI)).toBe(false);
    });
  });

  describe('real-world scenarios', () => {
    it('should handle LiteLLM gateway pointing to OpenAI', () => {
      const scenario = {
        currentProvider: 'litellm',
        endpointType: EModelEndpoint.openAI,
      };

      expect(
        isDocumentSupportedProvider(scenario.endpointType) ||
          isDocumentSupportedProvider(scenario.currentProvider),
      ).toBe(true);
    });

    it('should handle direct OpenAI connection', () => {
      const scenario = {
        currentProvider: EModelEndpoint.openAI,
        endpointType: EModelEndpoint.openAI,
      };

      expect(
        isDocumentSupportedProvider(scenario.endpointType) ||
          isDocumentSupportedProvider(scenario.currentProvider),
      ).toBe(true);
    });

    it('should handle unsupported custom endpoint without override', () => {
      const scenario = {
        currentProvider: 'my-unsupported-endpoint',
        endpointType: undefined,
      };

      expect(
        isDocumentSupportedProvider(scenario.endpointType) ||
          isDocumentSupportedProvider(scenario.currentProvider),
      ).toBe(false);
    });
    it('should handle agents endpoints with document supported providers', () => {
      const scenario = {
        currentProvider: EModelEndpoint.google,
        endpointType: EModelEndpoint.agents,
      };

      expect(
        isDocumentSupportedProvider(scenario.endpointType) ||
          isDocumentSupportedProvider(scenario.currentProvider),
      ).toBe(true);
    });
  });

  describe('HEIC/HEIF file type inference', () => {
    it('should infer image/heic for .heic files when browser returns empty type', () => {
      const fileName = 'photo.heic';
      const browserType = '';

      const inferredType = inferMimeType(fileName, browserType);
      expect(inferredType).toBe('image/heic');
    });

    it('should infer image/heif for .heif files when browser returns empty type', () => {
      const fileName = 'photo.heif';
      const browserType = '';

      const inferredType = inferMimeType(fileName, browserType);
      expect(inferredType).toBe('image/heif');
    });

    it('should handle uppercase .HEIC extension', () => {
      const fileName = 'IMG_1234.HEIC';
      const browserType = '';

      const inferredType = inferMimeType(fileName, browserType);
      expect(inferredType).toBe('image/heic');
    });

    it('should preserve browser-provided type when available', () => {
      const fileName = 'photo.jpg';
      const browserType = 'image/jpeg';

      const inferredType = inferMimeType(fileName, browserType);
      expect(inferredType).toBe('image/jpeg');
    });

    it('should not override browser type even if extension differs', () => {
      const fileName = 'renamed.heic';
      const browserType = 'image/png';

      const inferredType = inferMimeType(fileName, browserType);
      expect(inferredType).toBe('image/png');
    });

    it('should correctly identify HEIC as image type for upload options', () => {
      const heicType = inferMimeType('photo.heic', '');
      expect(heicType.startsWith('image/')).toBe(true);
    });

    it('should return empty string for unknown extension with no browser type', () => {
      const fileName = 'file.xyz';
      const browserType = '';

      const inferredType = inferMimeType(fileName, browserType);
      expect(inferredType).toBe('');
    });
  });
});

// [knauf] Seam test — single-option auto-select (KK20-190). When the drag-drop
// picker would show exactly one applicable option, DragDropModal auto-selects it and
// renders no dialog (matching the "Upload files" menu / default chat — no second
// popup). The picker still renders for a genuine multi-way choice. KK20-190.
describe('DragDropModal — single-option auto-select (Knauf KK20-190)', () => {
  const makeFile = (name: string, type: string) => new File([new ArrayBuffer(8)], name, { type });

  beforeEach(() => {
    mockCapabilities = { fileSearchEnabled: true, codeEnabled: false, contextEnabled: false };
    mockToolPerms = {
      fileSearchAllowedByAgent: true,
      codeAllowedByAgent: false,
      provider: EModelEndpoint.openAI,
    };
  });

  it('auto-selects File Search and renders no dialog when it is the only option', () => {
    const onOptionSelect = jest.fn();
    // A .docx is not a valid provider file (not image/pdf), so the provider option is
    // filtered out — File Search is the lone option.
    render(
      <DragDropModal
        files={[
          makeFile(
            'report.docx',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          ),
        ]}
        isVisible={true}
        setShowModal={jest.fn()}
        onOptionSelect={onOptionSelect}
      />,
    );
    expect(onOptionSelect).toHaveBeenCalledTimes(1);
    expect(onOptionSelect).toHaveBeenCalledWith(EToolResources.file_search);
    expect(screen.queryByText('com_ui_upload_type')).not.toBeInTheDocument();
  });

  it('renders the picker (no auto-select) when more than one option applies', () => {
    const onOptionSelect = jest.fn();
    // A PDF IS a valid provider file, so "Upload to provider" + File Search = two options.
    render(
      <DragDropModal
        files={[makeFile('report.pdf', 'application/pdf')]}
        isVisible={true}
        setShowModal={jest.fn()}
        onOptionSelect={onOptionSelect}
      />,
    );
    expect(onOptionSelect).not.toHaveBeenCalled();
    expect(screen.getByText('com_ui_upload_type')).toBeInTheDocument();
  });
});
// End [knauf]
