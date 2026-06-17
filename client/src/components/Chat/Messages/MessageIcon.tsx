import { useMemo, memo } from 'react';
import { getEndpointField } from 'librechat-data-provider';
import type { Assistant, Agent } from 'librechat-data-provider';
import type { TMessageIcon } from '~/common';
import ConvoIconURL from '~/components/Endpoints/ConvoIconURL';
import { useGetEndpointsQuery } from '~/data-provider';
import useLocalize from '~/hooks/useLocalize';
import { getIconEndpoint } from '~/utils';
import Icon from '~/components/Endpoints/Icon';

type MessageIconProps = {
  iconData?: TMessageIcon;
  assistant?: Assistant;
  agent?: Agent;
};

// [knauf] Default Karl assistant turns use the Knauf wordmark when no custom avatar is set.
const KNAUF_DEFAULT_MODEL = 'gpt-5.4';
const KNAUF_DEFAULT_MODEL_LABEL = 'GPT-5.4';
const KNAUF_CHAT_ASSISTANT_NAME = 'Karl';
const KNAUF_LOGO_ICON_URL = '/assets/knauf-logo.png';

const isRenderableKnaufIconURL = (iconURL?: string | null): iconURL is string =>
  !!(
    iconURL &&
    (iconURL.includes('http') || iconURL.startsWith('/images/') || iconURL.startsWith('/assets/'))
  );

const normalizeKnaufLabel = (value?: string | null) => value?.trim().toLowerCase() ?? '';

const isDefaultKarlAssistantIcon = (iconData?: TMessageIcon, avatarURL = '') => {
  const model = normalizeKnaufLabel(iconData?.model);
  const modelLabel = normalizeKnaufLabel(iconData?.modelLabel);

  return (
    !!iconData &&
    iconData.isCreatedByUser !== true &&
    !avatarURL &&
    (model === KNAUF_DEFAULT_MODEL ||
      modelLabel === KNAUF_DEFAULT_MODEL ||
      modelLabel === KNAUF_DEFAULT_MODEL_LABEL.toLowerCase() ||
      modelLabel === KNAUF_CHAT_ASSISTANT_NAME.toLowerCase())
  );
};

const getKarlTooltipModelLabel = (iconData?: TMessageIcon) => {
  const modelLabel = iconData?.modelLabel?.trim();
  if (modelLabel && normalizeKnaufLabel(modelLabel) !== KNAUF_CHAT_ASSISTANT_NAME.toLowerCase()) {
    return modelLabel;
  }

  const model = iconData?.model?.trim();
  return normalizeKnaufLabel(model) === KNAUF_DEFAULT_MODEL
    ? KNAUF_DEFAULT_MODEL_LABEL
    : (model ?? KNAUF_DEFAULT_MODEL_LABEL);
};
// End [knauf]

/**
 * Compares only the fields MessageIcon actually renders.
 * `agent.id` / `assistant.id` are intentionally omitted because
 * this component renders display properties only, not identity-derived content.
 */
export function arePropsEqual(prev: MessageIconProps, next: MessageIconProps): boolean {
  const checks: [unknown, unknown][] = [
    [prev.iconData?.endpoint, next.iconData?.endpoint],
    [prev.iconData?.model, next.iconData?.model],
    [prev.iconData?.iconURL, next.iconData?.iconURL],
    [prev.iconData?.modelLabel, next.iconData?.modelLabel],
    [prev.iconData?.isCreatedByUser, next.iconData?.isCreatedByUser],
    [prev.agent?.name, next.agent?.name],
    [prev.agent?.avatar?.filepath, next.agent?.avatar?.filepath],
    [prev.assistant?.name, next.assistant?.name],
    [prev.assistant?.metadata?.avatar, next.assistant?.metadata?.avatar],
  ];

  for (const [prevVal, nextVal] of checks) {
    if (prevVal !== nextVal) {
      return false;
    }
  }
  return true;
}

const MessageIcon = memo(({ iconData, assistant, agent }: MessageIconProps) => {
  const { data: endpointsConfig } = useGetEndpointsQuery();
  // [knauf] Match the Karl name tooltip so the icon no longer exposes the upstream ChatGPT title.
  const localize = useLocalize();
  // End [knauf]

  const agentName = agent?.name ?? '';
  const agentAvatar = agent?.avatar?.filepath ?? '';
  const assistantName = assistant?.name ?? '';
  const assistantAvatar = assistant?.metadata?.avatar ?? '';
  let avatarURL = '';
  if (assistant) {
    avatarURL = assistantAvatar;
  } else if (agent) {
    avatarURL = agentAvatar;
  }

  const iconURL = iconData?.iconURL;
  // [knauf] Use the local Knauf logo for default Karl/modelSpec assistant messages.
  const useKnaufDefaultIcon = isDefaultKarlAssistantIcon(iconData, avatarURL);
  const effectiveIconURL = useKnaufDefaultIcon ? KNAUF_LOGO_ICON_URL : iconURL;
  const knaufModelTooltip = useKnaufDefaultIcon
    ? localize('com_knauf_powered_by_model', { 0: getKarlTooltipModelLabel(iconData) })
    : undefined;
  // End [knauf]
  const endpoint = useMemo(
    () =>
      getIconEndpoint({
        endpointsConfig,
        iconURL: effectiveIconURL,
        endpoint: iconData?.endpoint,
      }),
    [endpointsConfig, effectiveIconURL, iconData?.endpoint],
  );

  const endpointIconURL = useMemo(
    () => getEndpointField(endpointsConfig, endpoint, 'iconURL'),
    [endpointsConfig, endpoint],
  );

  if (iconData?.isCreatedByUser !== true && isRenderableKnaufIconURL(effectiveIconURL)) {
    return (
      <span className="flex h-full w-full items-center justify-center" title={knaufModelTooltip}>
        <ConvoIconURL
          iconURL={effectiveIconURL}
          modelLabel={iconData?.modelLabel}
          context="message"
          assistantAvatar={assistantAvatar}
          agentAvatar={agentAvatar}
          endpointIconURL={endpointIconURL}
          assistantName={assistantName}
          agentName={agentName}
        />
      </span>
    );
  }

  return (
    <Icon
      isCreatedByUser={iconData?.isCreatedByUser ?? false}
      endpoint={endpoint}
      iconURL={avatarURL || endpointIconURL}
      model={iconData?.model}
      assistantName={assistantName}
      agentName={agentName}
      size={28.8}
    />
  );
}, arePropsEqual);

MessageIcon.displayName = 'MessageIcon';

export default MessageIcon;
