import React, { useEffect, memo } from 'react';
import TagManager from 'react-gtm-module';
import ReactMarkdown from 'react-markdown';
import type { TStartupConfig } from 'librechat-data-provider';
import { useGetStartupConfig } from '~/data-provider';
import { useLocalize } from '~/hooks';

// [knauf] Default footer fallback to the Agentic Karl brand when startup config does
// not provide `customFooter`; avoids exposing the upstream link. (NO-TICKET)
const KNAUF_FOOTER_FALLBACK = 'Agentic Karl | Knauf AI Platform';
// End [knauf]

type FooterProps = {
  className?: string;
  startupConfig?: FooterStartupConfig | null;
};

type FooterStartupConfig = Pick<Partial<TStartupConfig>, 'analyticsGtmId' | 'customFooter'> & {
  interface?: Pick<NonNullable<TStartupConfig['interface']>, 'privacyPolicy' | 'termsOfService'>;
};

function Footer({ className, startupConfig }: FooterProps) {
  const shouldFetchConfig = startupConfig === undefined;
  const { data: fetchedConfig } = useGetStartupConfig({ enabled: shouldFetchConfig });
  const config = shouldFetchConfig ? fetchedConfig : startupConfig;
  const localize = useLocalize();

  const privacyPolicy = config?.interface?.privacyPolicy;
  const termsOfService = config?.interface?.termsOfService;

  // [knauf] Collapse separate Privacy and Terms links into one legal page link.
  const legalUrl = privacyPolicy?.externalUrl ?? termsOfService?.externalUrl;
  const legalLinkRender = legalUrl != null && (
    <a className="text-text-secondary underline" href={legalUrl} rel="noreferrer">
      {localize('com_knauf_terms_and_privacy')}
    </a>
  );
  // End [knauf]

  const mainContentParts = (
    typeof config?.customFooter === 'string' ? config.customFooter : KNAUF_FOOTER_FALLBACK
  ).split('|');

  useEffect(() => {
    if (config?.analyticsGtmId != null && typeof window.google_tag_manager === 'undefined') {
      const tagManagerArgs = {
        gtmId: config.analyticsGtmId,
      };
      TagManager.initialize(tagManagerArgs);
    }
  }, [config?.analyticsGtmId]);

  const mainContentRender = mainContentParts.map((text, index) => (
    <React.Fragment key={`main-content-part-${index}`}>
      <ReactMarkdown
        components={{
          a: ({ node: _n, href, children, ...otherProps }) => {
            return (
              <a
                className="text-text-secondary underline"
                href={href}
                rel="noreferrer"
                {...otherProps}
              >
                {children}
              </a>
            );
          },

          p: ({ node: _n, ...props }) => <span {...props} />,
        }}
      >
        {text.trim()}
      </ReactMarkdown>
    </React.Fragment>
  ));

  const footerElements = [...mainContentRender, legalLinkRender].filter(Boolean);

  return (
    <div className="relative w-full">
      <div
        className={
          className ??
          'absolute bottom-0 left-0 right-0 hidden items-center justify-center gap-2 px-2 py-2 text-center text-xs text-text-primary sm:flex md:px-[60px]'
        }
        role="contentinfo"
      >
        {footerElements.map((contentRender, index) => {
          const isLastElement = index === footerElements.length - 1;
          return (
            <React.Fragment key={`footer-element-${index}`}>
              {contentRender}
              {!isLastElement && (
                <div
                  key={`separator-${index}`}
                  className="h-2 border-r-[1px] border-border-medium"
                />
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}

const MemoizedFooter = memo(Footer);
MemoizedFooter.displayName = 'Footer';

export default MemoizedFooter;
