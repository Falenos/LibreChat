import { useMemo, useCallback, useState, useEffect, useRef } from 'react';
import { easings } from '@react-spring/web';
import { EModelEndpoint } from 'librechat-data-provider';
import { BirthdayIcon, TooltipAnchor, SplitText } from '@librechat/client';
// [knauf] Icons for the default-spec landing capability tiles.
import { EarthIcon, FileText, ImageIcon } from 'lucide-react';
// End [knauf]
import {
  getIconEndpoint,
  getEntity,
  getModelSpec,
  createConfigHtmlSanitizer,
  CONFIG_HTML_MEDIA_TAGS,
  CONFIG_HTML_MEDIA_ATTR,
} from '~/utils';
import { useChatContext, useAgentsMapContext, useAssistantsMapContext } from '~/Providers';
import { useGetEndpointsQuery, useGetStartupConfig } from '~/data-provider';
import ConvoIcon from '~/components/Endpoints/ConvoIcon';
// [knauf] Shared contained Knauf avatar for circular logo placements.
import KnaufLogoAvatar from '~/knauf/components/Brand/KnaufLogoAvatar';
// End [knauf]
import { useLocalize, useAuthContext } from '~/hooks';

const containerClassName =
  'shadow-stroke relative flex h-full items-center justify-center rounded-full bg-white dark:bg-presentation dark:text-white text-black dark:after:shadow-none ';

function getTextSizeClass(text: string | undefined | null) {
  if (!text) {
    return 'text-xl sm:text-2xl';
  }

  if (text.length < 40) {
    return 'text-2xl sm:text-4xl';
  }

  if (text.length < 70) {
    return 'text-xl sm:text-2xl';
  }

  return 'text-lg sm:text-md';
}

export default function Landing({ centerFormOnLanding }: { centerFormOnLanding: boolean }) {
  const { conversation } = useChatContext();
  const agentsMap = useAgentsMapContext();
  const assistantMap = useAssistantsMapContext();
  const { data: startupConfig } = useGetStartupConfig();
  const { data: endpointsConfig } = useGetEndpointsQuery();
  const { user } = useAuthContext();
  const localize = useLocalize();

  const [textHasMultipleLines, setTextHasMultipleLines] = useState(false);
  const [lineCount, setLineCount] = useState(1);
  const [contentHeight, setContentHeight] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);

  const endpointType = useMemo(() => {
    let ep = conversation?.endpoint ?? '';
    if (ep === EModelEndpoint.azureOpenAI) {
      ep = EModelEndpoint.openAI;
    }
    return getIconEndpoint({
      endpointsConfig,
      iconURL: conversation?.iconURL,
      endpoint: ep,
    });
  }, [conversation?.endpoint, conversation?.iconURL, endpointsConfig]);

  const { entity, isAgent, isAssistant } = getEntity({
    endpoint: endpointType,
    agentsMap,
    assistantMap,
    agent_id: conversation?.agent_id,
    assistant_id: conversation?.assistant_id,
  });

  const modelSpec = useMemo(
    () => getModelSpec({ specName: conversation?.spec, startupConfig }),
    [conversation?.spec, startupConfig],
  );

  const brandedSpecLabel = modelSpec?.showOnLanding ? modelSpec.label : '';
  const brandedSpecDescription = (modelSpec?.showOnLanding && modelSpec.description) || '';
  const name = entity?.name ?? brandedSpecLabel;
  const description =
    (entity?.description || brandedSpecDescription || conversation?.greeting) ?? '';
  const descriptionIsHTML = description.trim().startsWith('<');

  const sanitizeDescription = useMemo(
    () =>
      createConfigHtmlSanitizer({
        allowedTags: CONFIG_HTML_MEDIA_TAGS,
        allowedAttr: CONFIG_HTML_MEDIA_ATTR,
      }),
    [],
  );

  // [knauf] KK20-159 — flag whether the conversation is on a default
  // modelSpec (today: `karl`). Used below to render a small "what you
  // can do" tips block under the customWelcome heading on the
  // default-spec landing. The customWelcome title itself flows through
  // the upstream greetingText branch unchanged.
  const isDefaultSpecLanding = useMemo(() => {
    if (entity) return false;
    const specName = conversation?.spec;
    if (!specName) return false;
    const list = startupConfig?.modelSpecs?.list ?? [];
    const match = list.find((s) => s.name === specName);
    return match?.default === true;
  }, [entity, conversation?.spec, startupConfig?.modelSpecs?.list]);
  // End [knauf]

  const getGreeting = useCallback(() => {
    if (typeof startupConfig?.interface?.customWelcome === 'string') {
      const customWelcome = startupConfig.interface.customWelcome;
      // Replace {{user.name}} with actual user name if available
      if (user?.name && customWelcome.includes('{{user.name}}')) {
        return customWelcome.replace(/{{user.name}}/g, user.name);
      }
      return customWelcome;
    }

    const now = new Date();
    const hours = now.getHours();

    const dayOfWeek = now.getDay();
    const isWeekend = dayOfWeek === 0 || dayOfWeek === 6;

    // Early morning (midnight to 4:59 AM)
    if (hours >= 0 && hours < 5) {
      return localize('com_ui_late_night');
    }
    // Morning (6 AM to 11:59 AM)
    else if (hours < 12) {
      if (isWeekend) {
        return localize('com_ui_weekend_morning');
      }
      return localize('com_ui_good_morning');
    }
    // Afternoon (12 PM to 4:59 PM)
    else if (hours < 17) {
      return localize('com_ui_good_afternoon');
    }
    // Evening (5 PM to 8:59 PM)
    else {
      return localize('com_ui_good_evening');
    }
  }, [localize, startupConfig?.interface?.customWelcome, user?.name]);

  const handleLineCountChange = useCallback((count: number) => {
    setTextHasMultipleLines(count > 1);
    setLineCount(count);
  }, []);

  useEffect(() => {
    if (contentRef.current) {
      setContentHeight(contentRef.current.offsetHeight);
    }
  }, [lineCount, description]);

  const getDynamicMargin = useMemo(() => {
    let margin = 'mb-0';

    if (lineCount > 2 || (description && description.length > 100)) {
      margin = 'mb-10';
    } else if (lineCount > 1 || (description && description.length > 0)) {
      margin = 'mb-6';
    } else if (textHasMultipleLines) {
      margin = 'mb-4';
    }

    if (contentHeight > 200) {
      margin = 'mb-16';
    } else if (contentHeight > 150) {
      margin = 'mb-12';
    }

    return margin;
  }, [lineCount, description, textHasMultipleLines, contentHeight]);

  const greetingText =
    typeof startupConfig?.interface?.customWelcome === 'string'
      ? getGreeting()
      : getGreeting() + (user?.name ? ', ' + user.name : '');
  // [knauf] Keep the default-spec capability cards clear of the composer.
  const landingBottomPadding = isDefaultSpecLanding ? 'pb-28 sm:pb-32' : 'pb-16';
  // End [knauf]

  return (
    <div
      className={`flex h-full transform-gpu flex-col items-center justify-center ${landingBottomPadding} transition-all duration-200 ${centerFormOnLanding ? 'max-h-full sm:max-h-0' : 'max-h-full'} ${getDynamicMargin}`}
    >
      <div ref={contentRef} className="flex flex-col items-center gap-0 p-2">
        {/* [knauf] KK20-159 — on the default-spec landing, the Knauf
            wordmark sits inside the same round white avatar container
            the upstream agent landing uses (visual parity). The
            modelSpec's preset.greeting is the title below; the
            customWelcome line is suppressed so users see one
            brand-led message instead of two stacked greetings. Every
            other branch (agents / assistants / non-default spec)
            renders the upstream layout unchanged. */}
        {isDefaultSpecLanding ? (
          <div className="flex flex-col items-center gap-3">
            <div className="relative mb-2 size-12">
              <KnaufLogoAvatar className={containerClassName} />
              {startupConfig?.showBirthdayIcon && (
                <TooltipAnchor
                  className="absolute bottom-[27px] right-2"
                  description={localize('com_ui_happy_birthday')}
                  aria-label={localize('com_ui_happy_birthday')}
                >
                  <BirthdayIcon />
                </TooltipAnchor>
              )}
            </div>
            <SplitText
              key={`split-text-knauf-${conversation?.greeting ?? ''}`}
              text={conversation?.greeting ?? greetingText}
              className={`${getTextSizeClass(conversation?.greeting ?? greetingText)} max-w-2xl font-medium text-text-primary`}
              delay={50}
              textAlign="center"
              animationFrom={{ opacity: 0, transform: 'translate3d(0,50px,0)' }}
              animationTo={{ opacity: 1, transform: 'translate3d(0,0,0)' }}
              easing={easings.easeOutCubic}
              threshold={0}
              rootMargin="0px"
              onLineCountChange={handleLineCountChange}
            />
          </div>
        ) : (
          <div
            className={`flex ${textHasMultipleLines ? 'flex-col' : 'flex-col md:flex-row'} items-center justify-center gap-2`}
          >
            <div
              className={`relative size-10 justify-center ${textHasMultipleLines ? 'mb-2' : ''}`}
            >
              <ConvoIcon
                agentsMap={agentsMap}
                assistantMap={assistantMap}
                conversation={conversation}
                endpointsConfig={endpointsConfig}
                containerClassName={containerClassName}
                context="landing"
                className="h-2/3 w-2/3 text-black dark:text-white"
                size={41}
              />
              {startupConfig?.showBirthdayIcon && (
                <TooltipAnchor
                  className="absolute bottom-[27px] right-2"
                  description={localize('com_ui_happy_birthday')}
                  aria-label={localize('com_ui_happy_birthday')}
                >
                  <BirthdayIcon />
                </TooltipAnchor>
              )}
            </div>
            {((isAgent || isAssistant) && name) || name ? (
              <div className="flex flex-col items-center gap-0 p-2">
                <SplitText
                  key={`split-text-${name}`}
                  text={name}
                  className={`${getTextSizeClass(name)} font-medium text-text-primary`}
                  delay={50}
                  textAlign="center"
                  animationFrom={{ opacity: 0, transform: 'translate3d(0,50px,0)' }}
                  animationTo={{ opacity: 1, transform: 'translate3d(0,0,0)' }}
                  easing={easings.easeOutCubic}
                  threshold={0}
                  rootMargin="0px"
                  onLineCountChange={handleLineCountChange}
                />
              </div>
            ) : (
              <SplitText
                key={`split-text-${greetingText}${user?.name ? '-user' : ''}`}
                text={greetingText}
                className={`${getTextSizeClass(greetingText)} font-medium text-text-primary`}
                delay={50}
                textAlign="center"
                animationFrom={{ opacity: 0, transform: 'translate3d(0,50px,0)' }}
                animationTo={{ opacity: 1, transform: 'translate3d(0,0,0)' }}
                easing={easings.easeOutCubic}
                threshold={0}
                rootMargin="0px"
                onLineCountChange={handleLineCountChange}
              />
            )}
          </div>
        )}
        {/* End [knauf] */}
        {/* [knauf] KK20-159 — suppress the plain description on the default-spec landing
            (the capability tiles below replace it); otherwise adopt upstream's HTML-aware
            description rendering. */}
        {description &&
          !isDefaultSpecLanding &&
          (descriptionIsHTML ? (
            <div
              className="animate-fadeIn mt-4 flex max-w-md items-center justify-center gap-2 text-center text-sm font-normal text-text-primary [&_img]:inline-block [&_img]:h-4 [&_img]:w-4"
              dangerouslySetInnerHTML={{ __html: sanitizeDescription(description) }}
            />
          ) : (
            <div className="animate-fadeIn mt-4 max-w-md text-center text-sm font-normal text-text-primary">
              {description}
            </div>
          ))}
        {/* [knauf] KK20-159 — concise feature capability tiles below the
            customWelcome title on the default-spec landing. Keeps the
            default landing scan-friendly while making direct web browsing
            visible as a first-class capability. */}
        {isDefaultSpecLanding && (
          <ul className="animate-fadeIn mt-7 grid w-full max-w-3xl list-none grid-cols-1 gap-2.5 px-2 text-left sm:grid-cols-3">
            <li className="bg-surface-primary/80 dark:bg-surface-secondary/60 rounded-lg border border-border-light px-3.5 py-3 shadow-sm">
              <div className="mb-2 flex min-w-0 items-center gap-2">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-tertiary text-blue-600 dark:text-blue-400">
                  <EarthIcon className="size-4" aria-hidden="true" />
                </div>
                <p className="min-w-0 text-sm font-medium text-text-primary">
                  {localize('com_knauf_landing_capability_web_title')}
                </p>
              </div>
              <p className="mt-1 text-xs leading-5 text-text-secondary">
                {localize('com_knauf_landing_capability_web_description')}
              </p>
            </li>
            <li className="bg-surface-primary/80 dark:bg-surface-secondary/60 rounded-lg border border-border-light px-3.5 py-3 shadow-sm">
              <div className="mb-2 flex min-w-0 items-center gap-2">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-tertiary text-blue-600 dark:text-blue-400">
                  <FileText className="size-4" aria-hidden="true" />
                </div>
                <p className="min-w-0 text-sm font-medium text-text-primary">
                  {localize('com_knauf_landing_capability_files_title')}
                </p>
              </div>
              <p className="mt-1 text-xs leading-5 text-text-secondary">
                {localize('com_knauf_landing_capability_files_description')}
              </p>
            </li>
            <li className="bg-surface-primary/80 dark:bg-surface-secondary/60 rounded-lg border border-border-light px-3.5 py-3 shadow-sm">
              <div className="mb-2 flex min-w-0 items-center gap-2">
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-surface-tertiary text-blue-600 dark:text-blue-400">
                  <ImageIcon className="size-4" aria-hidden="true" />
                </div>
                <p className="min-w-0 text-sm font-medium text-text-primary">
                  {localize('com_knauf_landing_capability_images_title')}
                </p>
              </div>
              <p className="mt-1 text-xs leading-5 text-text-secondary">
                {localize('com_knauf_landing_capability_images_description')}
              </p>
            </li>
          </ul>
        )}
        {/* End [knauf] */}
      </div>
    </div>
  );
}
