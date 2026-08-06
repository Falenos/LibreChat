import { Folder } from 'lucide-react';
import type { TChatProject } from 'librechat-data-provider';

export default function ProjectLandingChip({ project }: { project: TChatProject }) {
  return (
    // [knauf] KK20-248 — once the user is already inside a project-scoped chat,
    // show the project as a read-only chip instead of offering project switching
    // or removal from the composer header.
    <div className="mb-2.5 flex items-center px-1">
      <div className="inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-sm font-medium text-text-secondary">
        <Folder className="h-3.5 w-3.5 text-text-secondary" aria-hidden="true" />
        <span className="truncate">{project.name}</span>
      </div>
    </div>
  );
}
