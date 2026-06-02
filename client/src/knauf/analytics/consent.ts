import type { OneTrustWindow } from './types';

function normalizeGroupId(groupId: unknown): string | null {
  if (typeof groupId !== 'string') {
    return null;
  }

  const normalized = groupId.trim();
  return normalized ? normalized : null;
}

export function parseOneTrustGroups(groups: unknown): Set<string> {
  if (Array.isArray(groups)) {
    return new Set(groups.map(normalizeGroupId).filter(Boolean) as string[]);
  }

  if (typeof groups === 'string') {
    return new Set(groups.split(',').map(normalizeGroupId).filter(Boolean) as string[]);
  }

  if (groups && typeof groups === 'object' && 'groups' in groups) {
    return parseOneTrustGroups((groups as { groups?: unknown }).groups);
  }

  return new Set();
}

export function getOneTrustGroupsFromEvent(
  event: Event | undefined,
  oneTrustWindow: Pick<OneTrustWindow, 'OnetrustActiveGroups' | 'OptanonActiveGroups'>,
): Set<string> {
  const detail = event instanceof CustomEvent ? event.detail : undefined;
  const eventGroups = parseOneTrustGroups(detail);

  if (eventGroups.size > 0) {
    return eventGroups;
  }

  return new Set([
    ...parseOneTrustGroups(oneTrustWindow.OptanonActiveGroups),
    ...parseOneTrustGroups(oneTrustWindow.OnetrustActiveGroups),
  ]);
}

export function hasAnalyticsConsent(groups: Set<string>, consentCategoryId: string): boolean {
  return groups.has(consentCategoryId);
}

export function formatOneTrustConsentState(groups: Set<string>): string {
  if (groups.size === 0) {
    return '';
  }

  return `,${Array.from(groups).join(',')},`;
}
