import React, { memo } from 'react';
import { TerminalSquareIcon } from 'lucide-react';
import { CheckboxButton } from '@librechat/client';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { useLocalize, useHasAccess } from '~/hooks';
import { useBadgeRowContext } from '~/Providers';

function CodeInterpreter() {
  const localize = useLocalize();
  const context = useBadgeRowContext();
  const { toggleState: runCode, debouncedChange, isPinned } = context?.codeInterpreter ?? {};

  const canRunCode = useHasAccess({
    permissionType: PermissionTypes.RUN_CODE,
    permission: Permissions.USE,
  });

  // [knauf] KK20-257 — hide the code-interpreter chip on the Knauf chat. Code execution
  // is always on for every user-facing KARL spec (`executeCode: true`), so the chip
  // renders permanently checked — a switch whose only reachable action is to turn the
  // sandbox OFF. `interface.runCode` is now `true` because that permission is what makes
  // the manual per-code-block Run button work at all (api/server/controllers/tools.js
  // gates `POST /tools/:toolId/call` on RUN_CODE.USE); it never gated agent auto-run,
  // which comes from the capability plus the spec flag (packages/api/src/agents/load.ts).
  // So the permission stays ON and the surfaces are hidden here instead — same treatment
  // as the file-search chip (KK20-190) and the skills chip (KK20-243). The matching gates
  // are in ToolsDropdown.tsx and MarkdownComponents.tsx; all three move together.
  // `as boolean` keeps the upstream body reachable for clean merges.
  const KNAUF_HIDE_CODE_INTERPRETER_CHIP = true as boolean;
  if (KNAUF_HIDE_CODE_INTERPRETER_CHIP) {
    return null;
  }
  // End [knauf]

  if (!canRunCode) {
    return null;
  }

  return (
    (runCode || isPinned) && (
      <CheckboxButton
        className="max-w-fit"
        checked={runCode}
        setValue={debouncedChange}
        label={localize('com_ui_run_code')}
        isCheckedClassName="border-purple-600/40 bg-purple-500/10 hover:bg-purple-700/10"
        icon={<TerminalSquareIcon className="icon-md" aria-hidden="true" />}
      />
    )
  );
}

export default memo(CodeInterpreter);
