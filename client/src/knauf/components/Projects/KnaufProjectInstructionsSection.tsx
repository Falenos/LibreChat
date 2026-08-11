import { useEffect, useId, useState, type FormEvent } from 'react';
import { Button, Textarea, useToastContext } from '@librechat/client';
import type { TChatProject } from 'librechat-data-provider';
import { useUpdateProjectMutation } from '~/data-provider';
import { useLocalize } from '~/hooks';

export default function KnaufProjectInstructionsSection({ project }: { project: TChatProject }) {
  const localize = useLocalize();
  const textareaId = useId();
  const [instructions, setInstructions] = useState(project.instructions ?? '');
  const updateProject = useUpdateProjectMutation();
  const { showToast } = useToastContext();

  useEffect(() => {
    setInstructions(project.instructions ?? '');
  }, [project._id, project.instructions]);

  const trimmedCurrent = instructions.trim();
  const trimmedSaved = (project.instructions ?? '').trim();
  const hasChanges = trimmedCurrent !== trimmedSaved;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!hasChanges || updateProject.isLoading) {
      return;
    }

    try {
      await updateProject.mutateAsync({ projectId: project._id, instructions });
      showToast({ message: localize('com_ui_saved'), status: 'success' });
    } catch {
      showToast({ message: localize('com_ui_project_update_error'), status: 'error' });
    }
  };

  return (
    <section className="mt-6 rounded-2xl border border-border-light bg-surface-secondary p-4">
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor={textareaId} className="text-sm font-medium text-text-primary">
            {localize('com_ui_instructions')}
          </label>
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={!hasChanges || updateProject.isLoading}
          >
            {localize('com_ui_save')}
          </Button>
        </div>
        <Textarea
          id={textareaId}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          rows={4}
          maxLength={8000}
          className="w-full resize-y bg-surface-primary text-sm text-text-primary placeholder:text-text-secondary"
        />
      </form>
    </section>
  );
}
