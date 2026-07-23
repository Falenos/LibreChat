import { Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button, TooltipAnchor } from '@librechat/client';
import { PermissionTypes, Permissions } from 'librechat-data-provider';
import { useHasAccess, useLocalize } from '~/hooks';

export default function CreatePromptButton() {
  const localize = useLocalize();
  const hasCreateAccess = useHasAccess({
    permissionType: PermissionTypes.PROMPTS,
    permission: Permissions.CREATE,
  });
  // [knauf] keep the create control discoverable when role policy disables prompt creation
  const buttonLabel = hasCreateAccess
    ? localize('com_ui_create_prompt')
    : `${localize('com_ui_create_prompt')} — ${localize('com_ui_unavailable')}`;

  return (
    <TooltipAnchor
      description={buttonLabel}
      side="bottom"
      render={
        <Button
          asChild={hasCreateAccess}
          variant="outline"
          size="icon"
          className="size-9 shrink-0 bg-transparent aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          aria-label={buttonLabel}
          aria-disabled={hasCreateAccess ? undefined : true}
        >
          {hasCreateAccess ? (
            <Link to="/prompts/new">
              <Plus className="size-4" aria-hidden="true" />
            </Link>
          ) : (
            <Plus className="size-4" aria-hidden="true" />
          )}
        </Button>
      }
    />
  );
  // End [knauf]
}
