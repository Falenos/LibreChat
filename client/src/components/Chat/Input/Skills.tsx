import React, { memo } from 'react';
import { ScrollText } from 'lucide-react';
import { CheckboxButton } from '@librechat/client';
import { Permissions, PermissionTypes, defaultAgentCapabilities } from 'librechat-data-provider';
import { useLocalize, useHasAccess, useAgentCapabilities } from '~/hooks';
import { useBadgeRowContext } from '~/Providers';

function Skills() {
  const localize = useLocalize();
  const context = useBadgeRowContext();
  const { toggleState: skillsActive, debouncedChange, isPinned } = context?.skills ?? {};

  const canUseSkills = useHasAccess({
    permissionType: PermissionTypes.SKILLS,
    permission: Permissions.USE,
  });

  const { skillsEnabled } = useAgentCapabilities(
    context?.agentsConfig?.capabilities ?? defaultAgentCapabilities,
  );

  // [knauf] Hide the skills chip on the Knauf chat. Every user-facing KARL spec
  // sets `skills: true`, so the capability is always on and the chip renders
  // permanently checked — a switch whose only reachable action is to turn skills
  // OFF. Hidden in the UI here — NOT via the SKILLS permission or the spec — so
  // `skills: true` keeps flowing through and the `$` popover, the skill catalog
  // and model-invoked skills all keep working. Mirrors the KK20-190 file-search
  // chip hide; the matching tools-menu gate is in ToolsDropdown.tsx. `as boolean`
  // keeps the upstream body reachable for clean merges.
  const KNAUF_HIDE_SKILLS_CHIP = true as boolean;
  if (KNAUF_HIDE_SKILLS_CHIP) {
    return null;
  }
  // End [knauf]

  if (!canUseSkills || !skillsEnabled) {
    return null;
  }

  return (
    (skillsActive || isPinned) && (
      <CheckboxButton
        className="max-w-fit"
        checked={skillsActive}
        setValue={debouncedChange}
        label={localize('com_ui_skills')}
        isCheckedClassName="border-cyan-600/40 bg-cyan-500/10 hover:bg-cyan-700/10"
        icon={<ScrollText className="icon-md" aria-hidden="true" />}
      />
    )
  );
}

export default memo(Skills);
