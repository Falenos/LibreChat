/**
 * Section wrapper that matches the upstream AgentConfig style:
 * `<div className="mb-4">` with a label-styled heading. The heading uses the
 * same `labelClass` AgentConfig uses for its field labels so visually a
 * KnaufSection sits flush with native LibreChat sections.
 */
import type { ReactNode } from 'react';
import { cn } from '~/utils';
import KnaufInfoBadge from './KnaufInfoBadge';

export const sectionLabelClass =
  'text-token-text-primary block text-sm font-medium';

export default function KnaufSection({
  title,
  info,
  action,
  children,
}: {
  title: string;
  info?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mb-6">
      <div className="mb-2 flex items-center justify-between gap-2">
        <label className={cn(sectionLabelClass, 'mb-0 inline-flex items-center gap-1.5')}>
          {title}
          {info ? <KnaufInfoBadge tip={info} /> : null}
        </label>
        {action ? <div className="flex items-center gap-1.5">{action}</div> : null}
      </div>
      {children}
    </div>
  );
}
