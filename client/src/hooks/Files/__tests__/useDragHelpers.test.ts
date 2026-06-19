/**
 * [knauf] Seam test for the drag-drop File Search routing in useDragHelpers
 * (KK20-190). On the Knauf Azure Responses-API chat, a drop routes documents into
 * File Search (sets the ephemeral agent's file_search + calls handleFiles with the
 * file_search tool_resource) instead of popping the capability-picker modal. This
 * was previously SEAMS Tests=Manual; this pins it. react-dnd's useDrop is mocked to
 * capture the bound `drop` handler; the data surface (endpoints capabilities) is
 * driven through queryClient.getQueryData; useFileHandling + recoil are mocked at
 * the IO boundary only.
 */
import { renderHook, act } from '@testing-library/react';
import {
  EModelEndpoint,
  EToolResources,
  QueryKeys,
  AgentCapabilities,
} from 'librechat-data-provider';

// Capture the `drop` handler react-dnd would bind, so we can invoke it directly.
let mockCapturedDrop: ((item: { files: File[] }) => void) | undefined;
jest.mock('react-dnd', () => ({
  useDrop: (specFactory: () => { drop: (item: { files: File[] }) => void }) => {
    const spec = typeof specFactory === 'function' ? specFactory() : specFactory;
    mockCapturedDrop = spec.drop;
    return [{ canDrop: true, isOver: false }, jest.fn()];
  },
}));

jest.mock('react-dnd-html5-backend', () => ({ NativeTypes: { FILE: 'FILE' } }));

const mockHandleFiles = jest.fn();
jest.mock('../useFileHandling', () => ({
  __esModule: true,
  default: () => ({ handleFiles: mockHandleFiles }),
}));

const mockSetEphemeralAgent = jest.fn();
let mockConversation: Record<string, unknown> | undefined;
jest.mock('recoil', () => ({
  ...jest.requireActual('recoil'),
  useRecoilValue: jest.fn(() => mockConversation),
  useSetRecoilState: jest.fn(() => mockSetEphemeralAgent),
}));

const mockGetQueryData = jest.fn();
jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ getQueryData: mockGetQueryData }),
}));

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: jest.fn() }),
}));

jest.mock('../../useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => key,
}));

import useDragHelpers from '../useDragHelpers';

// [knauf] Seam test for the drag-drop File Search routing in useDragHelpers (KK20-190).
describe('[knauf] useDragHelpers — File Search drag-drop routing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConversation = undefined;
    // File Search is a platform capability of the agents endpoint.
    mockGetQueryData.mockImplementation((key: unknown) => {
      if (Array.isArray(key) && key[0] === QueryKeys.endpoints) {
        return { [EModelEndpoint.agents]: { capabilities: [AgentCapabilities.file_search] } };
      }
      return undefined;
    });
  });

  const pdf = () => new File([new ArrayBuffer(1024)], 'doc.pdf', { type: 'application/pdf' });

  it('routes a drop into File Search on the Azure Responses-API chat', () => {
    mockConversation = {
      conversationId: 'c1',
      endpoint: EModelEndpoint.azureOpenAI,
      useResponsesApi: true,
    };
    renderHook(() => useDragHelpers());

    const file = pdf();
    act(() => {
      mockCapturedDrop?.({ files: [file] });
    });

    expect(mockSetEphemeralAgent).toHaveBeenCalledTimes(1);
    expect(mockHandleFiles).toHaveBeenCalledWith([file], EToolResources.file_search);
  });

  it('does NOT route to File Search when the chat is not Azure Responses-API (falls through to the modal)', () => {
    mockConversation = {
      conversationId: 'c1',
      endpoint: EModelEndpoint.azureOpenAI,
      useResponsesApi: false,
    };
    renderHook(() => useDragHelpers());

    act(() => {
      mockCapturedDrop?.({ files: [pdf()] });
    });

    // Modal path: files are staged for the picker, not handed to File Search.
    expect(mockHandleFiles).not.toHaveBeenCalled();
    expect(mockSetEphemeralAgent).not.toHaveBeenCalled();
  });
});
// End [knauf]
