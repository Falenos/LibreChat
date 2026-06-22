import { useMemo, memo } from 'react';
import { getEndpointField } from 'librechat-data-provider';
import type { Assistant, Agent } from 'librechat-data-provider';
import type { TMessageIcon } from '~/common';
import ConvoIconURL from '~/components/Endpoints/ConvoIconURL';
import { useGetEndpointsQuery } from '~/data-provider';
import useLocalize from '~/hooks/useLocalize';
import {
  KARL_CHAT_ASSISTANT_NAME,
  KNAUF_LOGO_ICON_URL,
  getKarlModelLabel,
  isKarlModelName,
  normalizeKarlLabel,
} from '~/knauf/common/constants';
import { getIconEndpoint } from '~/utils';
import Icon from '~/components/Endpoints/Icon';

type MessageIconProps = {
  iconData?: TMessageIcon;
  assistant?: Assistant;
  agent?: Agent;
};

// [knauf] Default Karl assistant and no-avatar agent turns use the Knauf wordmark.
const isRenderableKnaufIconURL = (iconURL?: string | null): iconURL is string =>
  !!(
    iconURL &&
    (iconURL.includes('http') || iconURL.startsWith('/images/') || iconURL.startsWith('/assets/'))
  );

const isDefaultKarlAssistantIcon = (iconData?: TMessageIcon, avatarURL = '') => {
  const modelLabel = normalizeKarlLabel(iconData?.modelLabel);

  return (
    !!iconData &&
    iconData.isCreatedByUser !== true &&
    !avatarURL &&
    (isKarlModelName(iconData.model) ||
      isKarlModelName(iconData.modelLabel) ||
      modelLabel === normalizeKarlLabel(KARL_CHAT_ASSISTANT_NAME))
  );
};

const getKnaufAgentAvatar = (agent?: Agent) =>
  typeof agent?.avatar === 'string' ? agent.avatar : (agent?.avatar?.filepath ?? '');

const getKarlTooltipModelLabel = (iconData?: TMessageIcon) => {
  return getKarlModelLabel(iconData?.modelLabel, iconData?.model);
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
    // [knauf] Compare the normalized avatar URL so legacy string avatars do not collapse to fallback.
    [getKnaufAgentAvatar(prev.agent), getKnaufAgentAvatar(next.agent)],
    // End [knauf]
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
  const agentAvatar = getKnaufAgentAvatar(agent);
  const assistantName = assistant?.name ?? '';
  const assistantAvatar = assistant?.metadata?.avatar ?? '';
  let avatarURL = '';
  if (assistant) {
    avatarURL = assistantAvatar;
  } else if (agent) {
    avatarURL = agentAvatar;
  }

  const iconURL = iconData?.iconURL;
  // [knauf] Use the local Knauf logo for default Karl turns and no-avatar agent turns.
  const useKnaufDefaultIcon = isDefaultKarlAssistantIcon(iconData, avatarURL);
  const useKnaufAgentFallbackIcon =
    iconData?.isCreatedByUser !== true && Boolean(agent && !avatarURL);
  const effectiveIconURL =
    useKnaufDefaultIcon || useKnaufAgentFallbackIcon ? KNAUF_LOGO_ICON_URL : iconURL;
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
