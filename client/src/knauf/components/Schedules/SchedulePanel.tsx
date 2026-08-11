import { useCallback, useState } from 'react';
import { Plus } from 'lucide-react';
import { Button, Spinner, TooltipAnchor } from '@librechat/client';
import type { Schedule } from '~/knauf/common/schedules';
import { useSchedulesQuery } from '~/knauf/data-provider/Schedules';
import { useLocalize } from '~/hooks';
import ScheduleCard from './ScheduleCard';
import ScheduleDialog from './ScheduleDialog';

const renderScheduleCard = (schedule: Schedule) => (
  <ScheduleCard key={schedule.id} schedule={schedule} />
);

export default function SchedulePanel() {
  const localize = useLocalize();
  const { data, isLoading, isError, refetch } = useSchedulesQuery();
  const [createOpen, setCreateOpen] = useState(false);
  const openCreate = useCallback(() => setCreateOpen(true), []);
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  if (isLoading) {
    return (
      <div className="flex h-full w-full items-center justify-center p-4">
        <Spinner />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 p-4">
        <p className="text-center text-sm text-text-secondary">
          {localize('com_knauf_scheduler_error')}
        </p>
        <Button variant="outline" size="sm" onClick={retry}>
          {localize('com_ui_retry')}
        </Button>
      </div>
    );
  }

  const schedules = data?.schedules ?? [];
  const maxPerUser = data?.limits.maxPerUser;
  const atLimit = maxPerUser !== undefined && schedules.length >= maxPerUser;

  return (
    <div className="flex h-auto w-full flex-col px-3 pb-3 pt-2">
      <div role="region" aria-label={localize('com_knauf_scheduler_title')} className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-text-primary">
            {localize('com_knauf_scheduler_title')}
          </span>
          <TooltipAnchor
            description={localize('com_knauf_scheduler_new')}
            side="bottom"
            render={
              <Button
                type="button"
                variant="outline"
                size="icon"
                className="size-9 shrink-0 bg-transparent"
                aria-label={localize('com_knauf_scheduler_new')}
                disabled={atLimit}
                onClick={openCreate}
              >
                <Plus className="size-4" aria-hidden="true" />
              </Button>
            }
          />
        </div>
        {schedules.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border-light p-4 text-center">
            <p className="text-sm text-text-secondary">{localize('com_knauf_scheduler_empty')}</p>
          </div>
        ) : (
          <div className="space-y-2">{schedules.map(renderScheduleCard)}</div>
        )}
        {maxPerUser !== undefined && (
          <p className="text-xs text-text-secondary">
            {localize('com_knauf_scheduler_used', {
              used: schedules.length,
              max: maxPerUser,
            })}
          </p>
        )}
        {createOpen && <ScheduleDialog open={createOpen} onOpenChange={setCreateOpen} />}
      </div>
    </div>
  );
}
