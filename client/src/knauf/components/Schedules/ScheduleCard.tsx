import {
  memo,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type MutableRefObject,
} from 'react';
import * as Ariakit from '@ariakit/react';
import { useNavigate } from 'react-router-dom';
import { Trans, useTranslation } from 'react-i18next';
import { Ellipsis, Pencil, Play, Trash } from 'lucide-react';
import {
  DropdownPopup,
  Label,
  OGDialog,
  OGDialogTemplate,
  Spinner,
  Switch,
  useToastContext,
} from '@librechat/client';
import type { Schedule, ScheduleRunStatus } from '~/knauf/common/schedules';
import {
  useDeleteScheduleMutation,
  useRunScheduleNowMutation,
  useUpdateScheduleMutation,
} from '~/knauf/data-provider/Schedules';
import { useGetAgentByIdQuery } from '~/data-provider';
import { useLocalize, type TranslationKeys } from '~/hooks';
import { useAgentsMapContext } from '~/Providers';
import { cn, getMessageTimestamp } from '~/utils';
import ScheduleDialog from './ScheduleDialog';
import { describeCadence } from './cadence';

const CHIP_BASE = 'rounded-full px-2 py-0.5 text-xs font-medium';
const GREEN_CHIP = 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300';
const RED_CHIP = 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-300';
const NEUTRAL_CHIP = 'bg-surface-tertiary text-text-secondary';

const STATUS_CHIPS: Record<ScheduleRunStatus, { label: TranslationKeys; className: string }> = {
  success: { label: 'com_knauf_scheduler_last_run', className: GREEN_CHIP },
  error: { label: 'com_knauf_scheduler_last_run_failed', className: RED_CHIP },
  interrupted: { label: 'com_knauf_scheduler_last_run_failed', className: RED_CHIP },
  started: { label: 'com_knauf_scheduler_run_started', className: NEUTRAL_CHIP },
};

function ScheduleCard({ schedule }: Readonly<{ schedule: Schedule }>) {
  const localize = useLocalize();
  const navigate = useNavigate();
  const { i18n } = useTranslation();
  const { showToast } = useToastContext();
  const agentsMap = useAgentsMapContext();
  const menuId = useId();
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);

  const mappedAgent = agentsMap?.[schedule.agent_id];
  const { data: fetchedAgent } = useGetAgentByIdQuery(schedule.agent_id, {
    enabled: mappedAgent == null,
  });
  const agentName = mappedAgent?.name || fetchedAgent?.name || schedule.agent_id;

  const updateSchedule = useUpdateScheduleMutation({
    onError: () => showToast({ message: localize('com_ui_error'), status: 'error' }),
  });
  const deleteSchedule = useDeleteScheduleMutation();
  const runSchedule = useRunScheduleNowMutation();

  const handleToggle = useCallback(
    (checked: boolean) => {
      updateSchedule.mutate({ id: schedule.id, payload: { enabled: checked } });
    },
    [schedule.id, updateSchedule],
  );
  const handleRunNow = useCallback(() => {
    runSchedule.mutate(schedule.id, {
      onSuccess: () => {
        showToast({
          message: localize('com_knauf_scheduler_run_now_started'),
          status: 'success',
        });
        setMenuOpen(false);
      },
      onError: () => showToast({ message: localize('com_ui_error'), status: 'error' }),
    });
  }, [localize, runSchedule, schedule.id, showToast]);
  const openEdit = useCallback(() => setEditOpen(true), []);
  const openDelete = useCallback(() => setDeleteOpen(true), []);
  const confirmDelete = useCallback(() => {
    deleteSchedule.mutate(schedule.id, {
      onSuccess: () => {
        showToast({ message: localize('com_ui_deleted'), status: 'success' });
        setDeleteOpen(false);
      },
      onError: () => showToast({ message: localize('com_ui_error'), status: 'error' }),
    });
  }, [deleteSchedule, localize, schedule.id, showToast]);

  const cadenceText = describeCadence(schedule.cadence, localize, i18n.language);
  const nextRunText = useMemo(() => {
    if (!schedule.enabled || schedule.nextRunAt == null) {
      return null;
    }
    const timestamp = getMessageTimestamp(schedule.nextRunAt, i18n.language);
    return timestamp
      ? localize('com_knauf_scheduler_next_run', { time: timestamp.relative })
      : null;
  }, [i18n.language, localize, schedule.enabled, schedule.nextRunAt]);
  const dropdownItems = useMemo(
    () => [
      {
        label: localize('com_knauf_scheduler_run_now'),
        onClick: handleRunNow,
        hideOnClick: false,
        icon: runSchedule.isLoading ? (
          <Spinner className="size-4" />
        ) : (
          <Play className="icon-sm mr-2 text-text-primary" aria-hidden="true" />
        ),
      },
      {
        label: localize('com_ui_edit'),
        onClick: openEdit,
        icon: <Pencil className="icon-sm mr-2 text-text-primary" aria-hidden="true" />,
        ariaHasPopup: 'dialog' as const,
        hideOnClick: false,
        ref: editButtonRef,
        render: (props: ButtonHTMLAttributes<HTMLButtonElement>) => (
          <button type="button" {...props} />
        ),
      },
      {
        label: localize('com_ui_delete'),
        onClick: openDelete,
        icon: <Trash className="icon-sm mr-2 text-text-primary" aria-hidden="true" />,
        ariaHasPopup: 'dialog' as const,
        hideOnClick: false,
        ref: deleteButtonRef,
        render: (props: ButtonHTMLAttributes<HTMLButtonElement>) => (
          <button type="button" {...props} />
        ),
      },
    ],
    [handleRunNow, localize, openDelete, openEdit, runSchedule.isLoading],
  );
  const statusChip = schedule.lastRun ? STATUS_CHIPS[schedule.lastRun.status] : null;
  const lastRunConvoId = schedule.lastRun?.conversationId;

  return (
    <div
      data-testid="schedule-card"
      className="rounded-lg border border-border-light bg-transparent px-3 py-2.5 hover:bg-surface-secondary"
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-text-primary">
          {schedule.name}
        </span>
        <Switch
          checked={schedule.enabled}
          onCheckedChange={handleToggle}
          disabled={updateSchedule.isLoading}
          aria-label={localize('com_knauf_scheduler_enabled')}
          className="shrink-0"
        />
        <DropdownPopup
          portal={true}
          menuId={menuId}
          focusLoop={true}
          className="z-[125]"
          unmountOnHide={true}
          isOpen={menuOpen}
          setIsOpen={setMenuOpen}
          trigger={
            <Ariakit.MenuButton
              id={`schedule-menu-${schedule.id}`}
              aria-label={localize('com_knauf_scheduler_options')}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-text-secondary hover:bg-surface-tertiary hover:text-text-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-border-heavy"
            >
              <Ellipsis className="size-4" aria-hidden={true} />
            </Ariakit.MenuButton>
          }
          items={dropdownItems}
        />
      </div>
      <p className="mt-0.5 truncate text-xs text-text-secondary" title={agentName}>
        {agentName}
      </p>
      <p className="mt-1 text-sm text-text-primary">{cadenceText}</p>
      {nextRunText != null && <p className="mt-0.5 text-xs text-text-secondary">{nextRunText}</p>}
      {!schedule.enabled && schedule.disabledReason === 'too_many_failures' && (
        <output className="mt-1.5 block text-xs text-text-secondary">
          {localize('com_knauf_scheduler_disabled_too_many_failures')}
        </output>
      )}
      {statusChip != null && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {lastRunConvoId ? (
            <button
              type="button"
              className={cn(CHIP_BASE, statusChip.className, 'hover:underline')}
              onClick={() => navigate(`/c/${lastRunConvoId}`)}
            >
              {localize(statusChip.label)}
            </button>
          ) : (
            <span className={cn(CHIP_BASE, statusChip.className)}>
              {localize(statusChip.label)}
            </span>
          )}
        </div>
      )}
      {editOpen && (
        <ScheduleDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          schedule={schedule}
          triggerRef={editButtonRef as MutableRefObject<HTMLButtonElement | null>}
        />
      )}
      <OGDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        triggerRef={deleteButtonRef as MutableRefObject<HTMLButtonElement | null>}
      >
        <OGDialogTemplate
          showCloseButton={false}
          title={localize('com_knauf_scheduler_delete')}
          className="w-11/12 max-w-lg"
          main={
            <Label className="text-left text-sm font-medium">
              <Trans
                i18nKey="com_ui_delete_confirm_strong"
                values={{ title: schedule.name }}
                components={{ strong: <strong /> }}
              />
            </Label>
          }
          selection={{
            selectHandler: confirmDelete,
            selectClasses:
              'bg-red-700 dark:bg-red-600 hover:bg-red-800 dark:hover:bg-red-800 text-white',
            selectText: localize('com_ui_delete'),
          }}
        />
      </OGDialog>
    </div>
  );
}

export default memo(ScheduleCard);
