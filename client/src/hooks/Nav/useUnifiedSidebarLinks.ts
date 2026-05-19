import { useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { MessagesSquare } from 'lucide-react';
// [knauf] Marketplace promoted to the main sidebar (KK20-124 / FEAT-02).
// The marketplace entry is injected as a top-level NavLink with an onClick
// that navigates to /agents. NavIconButton honours link.onClick directly,
// so no side-panel Component is needed. Gating reuses useShowMarketplace.
import { LayoutGrid } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import useShowMarketplace from '~/hooks/Nav/useShowMarketplace';
// End [knauf]
import { useUserKeyQuery } from 'librechat-data-provider/react-query';
import { getConfigDefaults, getEndpointField } from 'librechat-data-provider';
import type { TEndpointsConfig } from 'librechat-data-provider';
import type { NavLink } from '~/common';
import ConversationsSection from '~/components/UnifiedSidebar/ConversationsSection';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import useSideNavLinks from '~/hooks/Nav/useSideNavLinks';
import store from '~/store';

const defaultInterface = getConfigDefaults().interface;

export default function useUnifiedSidebarLinks() {
  const conversation = useRecoilValue(store.conversationByIndex(0));
  const endpoint = conversation?.endpoint;
  const { data: startupConfig } = useGetStartupConfig();
  const { data: endpointsConfig = {} as TEndpointsConfig } = useGetEndpointsQuery();

  // [knauf] Marketplace sidebar entry — see import block above. KK20-124.
  const navigate = useNavigate();
  const showAgentMarketplace = useShowMarketplace();
  // End [knauf]

  const interfaceConfig = useMemo(
    () => startupConfig?.interface ?? defaultInterface,
    [startupConfig],
  );

  const endpointType = useMemo(
    () => getEndpointField(endpointsConfig, endpoint, 'type'),
    [endpoint, endpointsConfig],
  );

  const userProvidesKey = useMemo(
    () => !!(endpointsConfig?.[endpoint ?? '']?.userProvide ?? false),
    [endpointsConfig, endpoint],
  );

  const { data: keyExpiry = { expiresAt: undefined } } = useUserKeyQuery(endpoint ?? '');

  const keyProvided = useMemo(
    () => (userProvidesKey ? !!(keyExpiry.expiresAt ?? '') : true),
    [keyExpiry.expiresAt, userProvidesKey],
  );

  const sideNavLinks = useSideNavLinks({
    keyProvided,
    endpoint,
    endpointType,
    interfaceConfig,
    endpointsConfig,
    includeHidePanel: false,
  });

  const links = useMemo(() => {
    const conversationLink: NavLink = {
      title: 'com_ui_chat_history',
      label: '',
      icon: MessagesSquare,
      id: 'conversations',
      Component: ConversationsSection,
    };

    // [knauf] Marketplace nav entry, gated by useShowMarketplace. KK20-124.
    const marketplaceLink: NavLink | null = showAgentMarketplace
      ? {
          title: 'com_agents_marketplace',
          label: '',
          icon: LayoutGrid,
          id: 'marketplace',
          onClick: () => navigate('/agents'),
        }
      : null;
    // End [knauf]

    return [
      conversationLink,
      // [knauf] Inject marketplace immediately after Conversations. KK20-124.
      ...(marketplaceLink ? [marketplaceLink] : []),
      // End [knauf]
      ...sideNavLinks,
    ];
  }, [sideNavLinks, showAgentMarketplace, navigate]);

  return links;
}
