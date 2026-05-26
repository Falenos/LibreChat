/**
 * [knauf] Auto-save the in-progress agent when the user triggers an
 * agent-bound action (currently: file upload in KnaufFileSearch) before
 * clicking the form's Save button. Upstream gates these actions behind
 * isEphemeralAgent — the Knauf builder lifts that gate by ensuring the
 * agent exists first, transparently. KK20-123.
 */
import { useCallback, useRef } from 'react';
import { useFormContext } from 'react-hook-form';
import { useToastContext } from '@librechat/client';
import { Tools } from 'librechat-data-provider';
import type { AgentForm } from '~/common';
import { useCreateAgentMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';
import { useAgentPanelContext } from '~/Providers/AgentPanelContext';
import { isEphemeralAgent } from '~/common';
import { composeAgentUpdatePayload } from '~/components/SidePanel/Agents/AgentPanel';

export function useEnsureAgentSaved(): {
  ensureAgentSaved: () => Promise<string | null>;
  isSaving: boolean;
} {
  const localize = useLocalize();
  const { showToast } = useToastContext();
  const { getValues, setValue } = useFormContext<AgentForm>();
  const { setCurrentAgentId } = useAgentPanelContext();
  const inFlightRef = useRef(false);

  const create = useCreateAgentMutation({
    onSuccess: (newAgent) => {
      setValue('id', newAgent.id, { shouldDirty: false });
      setCurrentAgentId(newAgent.id);
      showToast({
        message: `${localize('com_assistants_create_success')} ${
          newAgent.name ?? localize('com_ui_agent')
        }`,
      });
    },
    onError: (err) => {
      const error = err as Error;
      showToast({
        message: `${localize('com_agents_create_error')}${
          error.message ? ` ${localize('com_ui_error')}: ${error.message}` : ''
        }`,
        status: 'error',
      });
    },
  });

  const ensureAgentSaved = useCallback(async (): Promise<string | null> => {
    const existingId = getValues('id');
    if (existingId && !isEphemeralAgent(existingId)) {
      return existingId;
    }

    if (inFlightRef.current) {
      return null;
    }

    const data = getValues();
    const { payload, provider, model } = composeAgentUpdatePayload(data, '');

    if (!provider || !model) {
      showToast({
        message: localize('com_agents_missing_provider_model'),
        status: 'error',
      });
      return null;
    }
    if (!data.name) {
      showToast({
        message: localize('com_agents_missing_name'),
        status: 'error',
      });
      return null;
    }

    const tools = data.tools ?? [];
    if (data.execute_code === true) {
      tools.push(Tools.execute_code);
    }
    if (data.web_search === true) {
      tools.push(Tools.web_search);
    }
    // file_search is intentionally omitted: KnaufAgentConfig syncs the
    // file_search flag from knowledge_files.length once the agent exists.
    // Adding it here would duplicate that effect's logic.

    inFlightRef.current = true;
    try {
      const newAgent = await create.mutateAsync({ ...payload, model, tools, provider });
      return newAgent.id;
    } catch {
      return null; // onError shows the toast
    } finally {
      inFlightRef.current = false;
    }
  }, [create, getValues, localize, showToast]);

  return { ensureAgentSaved, isSaving: create.isLoading };
}
