import { useState, useEffect } from 'react';
import { useRecoilValue } from 'recoil';
import { Outlet } from 'react-router-dom';
import { useMediaQuery } from '@librechat/client';
import {
  useSearchEnabled,
  useAssistantsMap,
  useAuthContext,
  useAgentsMap,
  useFileMap,
} from '~/hooks';
import store from '~/store';
import {
  PromptGroupsProvider,
  AssistantsMapContext,
  AgentsMapContext,
  SetConvoProvider,
  FileMapContext,
} from '~/Providers';
import { useUserTermsQuery, useGetStartupConfig } from '~/data-provider';
import { UnifiedSidebar } from '~/components/UnifiedSidebar';
import { TermsAndConditionsModal } from '~/components/ui';
import { useHealthCheck } from '~/data-provider';
import { Banner } from '~/components/Banners';
// [knauf] Mount post-login OneTrust and Adobe Analytics consent controller. (NO-TICKET)
import KnaufConsentAnalytics from '~/knauf/analytics/KnaufConsentAnalytics';
// End [knauf]
// [knauf] KK20-173 — full-width top header (logo left + user menu right).
// Renders above the sidebar+chat split; the layout height calc below
// subtracts KNAUF_HEADER_HEIGHT so the inner flex doesn't overflow.
import KnaufTopBar from '~/knauf/components/Header/KnaufTopBar';
const KNAUF_HEADER_HEIGHT = 56; // px — must match KnaufTopBar's `h-14` (56px)
// End [knauf]
// [knauf] Migration access gate — blocks users not on the allowlist after Okta login.
import KnaufAccessDenied from '~/knauf/components/AccessDenied/KnaufAccessDenied';
import { useMigrationAccess } from '~/knauf/hooks/Auth/useMigrationAccess';
// End [knauf]

export default function Root() {
  const [showTerms, setShowTerms] = useState(false);
  const [bannerHeight, setBannerHeight] = useState(0);
  const sidebarExpanded = useRecoilValue(store.sidebarExpanded);
  const isSmallScreen = useMediaQuery('(max-width: 768px)');

  const { isAuthenticated, logout } = useAuthContext();

  // [knauf] Block non-allowlisted users immediately after login.
  const { allowed: migrationAllowed, isLoading: migrationLoading } = useMigrationAccess();
  // End [knauf]

  useHealthCheck(isAuthenticated);

  const assistantsMap = useAssistantsMap({ isAuthenticated });
  const agentsMap = useAgentsMap({ isAuthenticated });
  const fileMap = useFileMap({ isAuthenticated });

  const { data: config } = useGetStartupConfig();
  // [knauf] Delay OneTrust until the required EULA flow is resolved so the cookie banner
  // cannot overlap the blocking terms modal for first-time users. (NO-TICKET)
  const termsAcceptanceRequired = config?.interface?.termsOfService?.modalAcceptance === true;
  const { data: termsData } = useUserTermsQuery({
    enabled: isAuthenticated && termsAcceptanceRequired,
  });
  const shouldMountKnaufConsentAnalytics =
    config != null && (!termsAcceptanceRequired || termsData?.termsAccepted === true);
  // End [knauf]

  useSearchEnabled(isAuthenticated);

  useEffect(() => {
    if (termsData) {
      setShowTerms(!termsData.termsAccepted);
    }
  }, [termsData]);

  const handleAcceptTerms = () => {
    setShowTerms(false);
  };

  const handleDeclineTerms = () => {
    setShowTerms(false);
    logout('/login?redirect=false');
  };

  if (!isAuthenticated) {
    return null;
  }

  // [knauf] Show access denied screen if the user is not on the migration allowlist.
  // While the check is loading we render null (avoids flash of main UI).
  if (migrationLoading) {
    return null;
  }
  if (!migrationAllowed) {
    return <KnaufAccessDenied />;
  }
  // End [knauf]

  return (
    <SetConvoProvider>
      {/* [knauf] OneTrust prompts after login and any required EULA acceptance; Adobe loads only after analytics cookie consent. (NO-TICKET) */}
      {shouldMountKnaufConsentAnalytics && <KnaufConsentAnalytics />}
      {/* End [knauf] */}
      {/* [knauf] KK20-173 — full-width top header. Sits above Banner so it
          spans the entire viewport width; the height calc below subtracts
          KNAUF_HEADER_HEIGHT so the sidebar+chat split fits the remaining
          viewport. */}
      <KnaufTopBar />
      {/* End [knauf] */}
      <FileMapContext.Provider value={fileMap}>
        <AssistantsMapContext.Provider value={assistantsMap}>
          <AgentsMapContext.Provider value={agentsMap}>
            <PromptGroupsProvider>
              <Banner onHeightChange={setBannerHeight} />
              <div
                className="flex"
                style={{
                  height: `calc(100dvh - ${bannerHeight}px - ${KNAUF_HEADER_HEIGHT}px)`,
                }}
              >
                <div className="relative z-0 flex h-full w-full overflow-hidden">
                  <UnifiedSidebar />
                  <div
                    className="relative flex h-full max-w-full flex-1 flex-col overflow-hidden"
                    style={{
                      transform:
                        isSmallScreen && sidebarExpanded ? 'translateX(min(85vw, 380px))' : 'none',
                      transition: 'transform 300ms cubic-bezier(0.2, 0, 0, 1)',
                    }}
                    inert={isSmallScreen && sidebarExpanded ? '' : undefined}
                  >
                    <Outlet />
                  </div>
                </div>
              </div>
            </PromptGroupsProvider>
          </AgentsMapContext.Provider>
          {config?.interface?.termsOfService?.modalAcceptance === true && (
            <TermsAndConditionsModal
              open={showTerms}
              onOpenChange={setShowTerms}
              onAccept={handleAcceptTerms}
              onDecline={handleDeclineTerms}
              title={config.interface.termsOfService.modalTitle}
              modalContent={config.interface.termsOfService.modalContent}
            />
          )}
        </AssistantsMapContext.Provider>
      </FileMapContext.Provider>
    </SetConvoProvider>
  );
}
