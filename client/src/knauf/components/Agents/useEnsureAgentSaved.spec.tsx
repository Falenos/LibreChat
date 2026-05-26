/**
 * Knauf seam test — auto-save-before-upload hook (KK20-123 / FEAT-01).
 *
 * Pins the contract of `useEnsureAgentSaved`:
 *   - returns existing id immediately when the agent is non-ephemeral;
 *   - fails with the upstream "missing provider/model" toast when validation fails;
 *   - fails with the upstream "missing name" toast when name is empty;
 *   - on a successful create, calls setValue('id', ...), setCurrentAgentId(...),
 *     and shows the create-success toast;
 *   - re-entrant calls while a creation is in flight short-circuit with null
 *     and never trigger a second mutateAsync.
 *
 * If the upstream `composeAgentUpdatePayload` signature changes or the
 * create-mutation contract drifts, these assertions flip.
 */
import { renderHook, act } from '@testing-library/react';
import { FormProvider, useForm } from 'react-hook-form';
import type { ReactNode } from 'react';
import type { AgentForm } from '~/common';

const mockShowToast = jest.fn();
const mockSetCurrentAgentId = jest.fn();
let mockMutateAsync = jest.fn();
let mockCreateOptions: { onSuccess?: (a: { id: string; name?: string }) => void } = {};

jest.mock('@librechat/client', () => ({
  useToastContext: () => ({ showToast: mockShowToast }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/Providers/AgentPanelContext', () => ({
  useAgentPanelContext: () => ({ setCurrentAgentId: mockSetCurrentAgentId }),
}));

jest.mock('~/data-provider', () => ({
  useCreateAgentMutation: (options: typeof mockCreateOptions) => {
    mockCreateOptions = options;
    return { mutateAsync: mockMutateAsync, isLoading: false };
  },
}));

jest.mock('~/components/SidePanel/Agents/AgentPanel', () => ({
  composeAgentUpdatePayload: (data: AgentForm) => ({
    payload: { name: data.name, description: data.description ?? null },
    provider:
      typeof data.provider === 'string'
        ? data.provider
        : ((data.provider as { value?: string } | undefined)?.value ?? ''),
    model: data.model ?? '',
  }),
}));

import { useEnsureAgentSaved } from './useEnsureAgentSaved';

const DEFAULTS: Partial<AgentForm> = {
  id: '',
  name: 'My agent',
  description: null,
  instructions: null,
  model: 'gpt-5.4',
  provider: 'cst-karl-dev',
  category: 'general',
  model_parameters: {},
  tools: [],
};

function makeWrapper(initial: Partial<AgentForm> = {}) {
  return function Wrapper({ children }: Readonly<{ children: ReactNode }>) {
    const methods = useForm<AgentForm>({
      defaultValues: { ...DEFAULTS, ...initial } as AgentForm,
    });
    return <FormProvider {...methods}>{children}</FormProvider>;
  };
}

beforeEach(() => {
  mockShowToast.mockReset();
  mockSetCurrentAgentId.mockReset();
  mockMutateAsync = jest.fn();
  mockCreateOptions = {};
});

describe('useEnsureAgentSaved', () => {
  test('returns existing id immediately when agent is non-ephemeral', async () => {
    const { result } = renderHook(() => useEnsureAgentSaved(), {
      wrapper: makeWrapper({ id: 'agent_abc123' }),
    });

    const id = await act(() => result.current.ensureAgentSaved());

    expect(id).toBe('agent_abc123');
    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  test('toasts and bails when name is missing', async () => {
    const { result } = renderHook(() => useEnsureAgentSaved(), {
      wrapper: makeWrapper({ name: '' }),
    });

    const id = await act(() => result.current.ensureAgentSaved());

    expect(id).toBeNull();
    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'com_agents_missing_name', status: 'error' }),
    );
  });

  test('toasts and bails when provider/model is missing', async () => {
    const { result } = renderHook(() => useEnsureAgentSaved(), {
      wrapper: makeWrapper({ model: null }),
    });

    const id = await act(() => result.current.ensureAgentSaved());

    expect(id).toBeNull();
    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: 'com_agents_missing_provider_model',
        status: 'error',
      }),
    );
  });

  test('on success, fires onSuccess and shows success toast', async () => {
    mockMutateAsync = jest.fn().mockImplementation(async (params) => {
      const newAgent = { id: 'agent_new123', name: params.name };
      mockCreateOptions.onSuccess?.(newAgent);
      return newAgent;
    });

    const { result } = renderHook(() => useEnsureAgentSaved(), {
      wrapper: makeWrapper(),
    });

    const id = await act(() => result.current.ensureAgentSaved());

    expect(id).toBe('agent_new123');
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    expect(mockMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'My agent',
        model: 'gpt-5.4',
        provider: 'cst-karl-dev',
      }),
    );
    expect(mockSetCurrentAgentId).toHaveBeenCalledWith('agent_new123');
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('com_assistants_create_success'),
      }),
    );
  });

  test('re-entrant call while in-flight returns null without firing second mutate', async () => {
    let resolveCreate: (a: { id: string; name?: string }) => void = () => undefined;
    mockMutateAsync = jest.fn().mockImplementation(
      () =>
        new Promise<{ id: string; name?: string }>((resolve) => {
          resolveCreate = (newAgent) => {
            mockCreateOptions.onSuccess?.(newAgent);
            resolve(newAgent);
          };
        }),
    );

    const { result } = renderHook(() => useEnsureAgentSaved(), {
      wrapper: makeWrapper(),
    });

    let firstPromise!: Promise<string | null>;
    act(() => {
      firstPromise = result.current.ensureAgentSaved();
    });

    const secondId = await act(() => result.current.ensureAgentSaved());
    expect(secondId).toBeNull();
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolveCreate({ id: 'agent_first', name: 'My agent' });
      await firstPromise;
    });

    const firstId = await firstPromise;
    expect(firstId).toBe('agent_first');
  });
});
