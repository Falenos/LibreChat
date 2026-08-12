import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { v4 } from 'uuid';
import { useTranslation } from 'react-i18next';
import { Controller, useForm } from 'react-hook-form';
import type { TChatProject } from 'librechat-data-provider';
import { PermissionBits } from 'librechat-data-provider';
import {
  Button,
  ControlCombobox,
  Dropdown,
  Input,
  Label,
  OGDialog,
  OGDialogTemplate,
  Spinner,
  useToastContext,
} from '@librechat/client';
import type {
  CreateSchedule,
  Schedule,
  ScheduleCadence,
  ScheduleFrequency,
} from '~/knauf/common/schedules';
import {
  useCreateScheduleMutation,
  useUpdateScheduleMutation,
} from '~/knauf/data-provider/Schedules';
import { useListAgentsQuery, useProjectsInfiniteQuery } from '~/data-provider';
import ProjectCreateDialog from '~/components/Projects/ProjectCreateDialog';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';
import { describeCadence, formatScheduleDay, to12Hour, to24Hour, type Meridiem } from './cadence';

type ScheduleDialogProps = Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schedule?: Schedule;
  triggerRef?: MutableRefObject<HTMLButtonElement | null>;
}>;

type ScheduleFormValues = {
  name: string;
  prompt: string;
  agent_id: string;
  chatProjectId: string;
  frequency: ScheduleFrequency;
  hour12: number;
  minute: number;
  meridiem: Meridiem;
  dayOfWeek: number;
};

type CadenceFormValues = Pick<
  ScheduleFormValues,
  'frequency' | 'hour12' | 'minute' | 'meridiem' | 'dayOfWeek'
>;

const BASE_MINUTES = [0, 15, 30, 45];

const getDefaultValues = (schedule?: Schedule): ScheduleFormValues => {
  if (!schedule) {
    return {
      name: '',
      prompt: '',
      agent_id: '',
      chatProjectId: '',
      frequency: 'daily',
      hour12: 9,
      minute: 0,
      meridiem: 'AM',
      dayOfWeek: 1,
    };
  }
  const { hour12, meridiem } = to12Hour(schedule.cadence.hour);
  return {
    name: schedule.name,
    prompt: schedule.prompt,
    agent_id: schedule.agent_id,
    chatProjectId: schedule.chatProjectId,
    frequency: schedule.cadence.frequency,
    hour12,
    minute: schedule.cadence.minute,
    meridiem,
    dayOfWeek: schedule.cadence.daysOfWeek?.[0] ?? 1,
  };
};

const buildCadence = (values: CadenceFormValues, overrideDays?: number[]): ScheduleCadence => {
  if (values.frequency === 'hourly') {
    return { frequency: 'hourly', hour: 0, minute: values.minute };
  }
  const hour = to24Hour(values.hour12, values.meridiem);
  if (values.frequency === 'weekly') {
    return {
      frequency: 'weekly',
      hour,
      minute: values.minute,
      daysOfWeek: overrideDays ?? [values.dayOfWeek],
    };
  }
  return { frequency: values.frequency, hour, minute: values.minute };
};

function FrequencyButton({
  frequency,
  selected,
  label,
  onSelect,
}: Readonly<{
  frequency: ScheduleFrequency;
  selected: boolean;
  label: string;
  onSelect: (frequency: ScheduleFrequency) => void;
}>) {
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      aria-pressed={selected}
      className={cn(
        'flex-1',
        selected ? 'bg-surface-hover hover:bg-surface-hover' : 'bg-transparent',
      )}
      onClick={() => onSelect(frequency)}
    >
      {label}
    </Button>
  );
}

export default function ScheduleDialog({
  open,
  onOpenChange,
  schedule,
  triggerRef,
}: ScheduleDialogProps) {
  const localize = useLocalize();
  const { i18n } = useTranslation();
  const { showToast } = useToastContext();
  const locale = i18n.language;
  const {
    control,
    register,
    setValue,
    watch,
    handleSubmit,
    formState: { dirtyFields },
  } = useForm<ScheduleFormValues>({ defaultValues: getDefaultValues(schedule) });
  const openedConfigRevision = useRef(schedule?.configRevision);
  const createRequestId = useRef(v4());
  const lastAttemptedPayload = useRef<string | null>(null);
  const [isProjectCreateOpen, setIsProjectCreateOpen] = useState(false);
  const [createdProject, setCreatedProject] = useState<TChatProject | null>(null);

  const name = watch('name');
  const prompt = watch('prompt');
  const agentId = watch('agent_id');
  const chatProjectId = watch('chatProjectId');
  const frequency = watch('frequency');
  const hour12 = watch('hour12');
  const minute = watch('minute');
  const meridiem = watch('meridiem');
  const dayOfWeek = watch('dayOfWeek');

  const { data: agents } = useListAgentsQuery(
    { requiredPermission: PermissionBits.VIEW },
    { select: (response) => response.data },
  );
  const agentItems = useMemo(
    () => (agents ?? []).map((agent) => ({ label: agent.name || agent.id, value: agent.id })),
    [agents],
  );
  const projectsQuery = useProjectsInfiniteQuery(
    { limit: 100, sortBy: 'name', sortDirection: 'asc' },
    { enabled: open, refetchOnMount: false },
  );
  const { data: projectsData, fetchNextPage, hasNextPage, isFetchingNextPage } = projectsQuery;
  useEffect(() => {
    if (open && hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [fetchNextPage, hasNextPage, isFetchingNextPage, open, projectsData?.pages.length]);
  const projectItems = useMemo(() => {
    const items = (projectsData?.pages ?? []).flatMap((page) =>
      page.projects.map((project) => ({ label: project.name, value: project._id })),
    );
    if (createdProject && !items.some((item) => item.value === createdProject._id)) {
      items.push({ label: createdProject.name, value: createdProject._id });
    }
    return items;
  }, [createdProject, projectsData]);
  const hourOptions = useMemo(
    () => Array.from({ length: 12 }, (_, index) => String(index + 1)),
    [],
  );
  const minuteOptions = useMemo(() => {
    const minutes = new Set(BASE_MINUTES);
    if (schedule) {
      minutes.add(schedule.cadence.minute);
    }
    return [...minutes]
      .sort((a, b) => a - b)
      .map((value) => ({ value: String(value), label: String(value).padStart(2, '0') }));
  }, [schedule]);
  const meridiemOptions = useMemo(
    () => [
      { value: 'AM', label: localize('com_knauf_scheduler_am') },
      { value: 'PM', label: localize('com_knauf_scheduler_pm') },
    ],
    [localize],
  );
  const dayOptions = useMemo(
    () =>
      Array.from({ length: 7 }, (_, day) => ({
        value: String(day),
        label: formatScheduleDay(day, locale),
      })),
    [locale],
  );
  const timezone = useMemo(
    () => schedule?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
    [schedule],
  );

  const createSchedule = useCreateScheduleMutation({
    onSuccess: () => {
      createRequestId.current = v4();
      lastAttemptedPayload.current = null;
      showToast({ message: localize('com_knauf_scheduler_created'), status: 'success' });
      onOpenChange(false);
    },
    onError: () => showToast({ message: localize('com_ui_error'), status: 'error' }),
  });
  const updateSchedule = useUpdateScheduleMutation({
    onSuccess: () => {
      showToast({ message: localize('com_knauf_scheduler_updated'), status: 'success' });
      onOpenChange(false);
    },
    onError: (error) => {
      const status = (error as { response?: { status?: number } }).response?.status;
      showToast({
        message: localize(status === 409 ? 'com_knauf_scheduler_conflict' : 'com_ui_error'),
        status: 'error',
      });
    },
  });

  const resolvePreservedWeeklyDays = (nextFrequency: ScheduleFrequency) =>
    schedule &&
    !dirtyFields.dayOfWeek &&
    !dirtyFields.frequency &&
    schedule.cadence.frequency === 'weekly' &&
    nextFrequency === 'weekly'
      ? schedule.cadence.daysOfWeek
      : undefined;

  const onSubmit = (values: ScheduleFormValues) => {
    if (schedule) {
      const cadenceTouched =
        dirtyFields.frequency ||
        dirtyFields.hour12 ||
        dirtyFields.minute ||
        dirtyFields.meridiem ||
        dirtyFields.dayOfWeek;
      const payload = {
        ...(dirtyFields.name ? { name: values.name.trim() } : {}),
        ...(dirtyFields.prompt ? { prompt: values.prompt.trim() } : {}),
        ...(dirtyFields.agent_id ? { agent_id: values.agent_id } : {}),
        ...(dirtyFields.chatProjectId ? { chatProjectId: values.chatProjectId } : {}),
        ...(cadenceTouched
          ? {
              cadence: buildCadence(values, resolvePreservedWeeklyDays(values.frequency)),
            }
          : {}),
      };
      if (Object.keys(payload).length === 0) {
        onOpenChange(false);
        return;
      }
      updateSchedule.mutate({
        id: schedule.id,
        payload: {
          ...payload,
          ...(openedConfigRevision.current != null
            ? { expectedConfigRevision: openedConfigRevision.current }
            : {}),
        },
      });
      return;
    }

    const content = {
      name: values.name.trim(),
      prompt: values.prompt.trim(),
      agent_id: values.agent_id,
      chatProjectId: values.chatProjectId,
      cadence: buildCadence(values),
      timezone,
      target: 'new' as const,
      enabled: true,
    };
    const fingerprint = JSON.stringify(content);
    if (lastAttemptedPayload.current != null && lastAttemptedPayload.current !== fingerprint) {
      createRequestId.current = v4();
    }
    lastAttemptedPayload.current = fingerprint;
    const payload: CreateSchedule = { ...content, clientRequestId: createRequestId.current };
    createSchedule.mutate(payload);
  };

  const summary = `${describeCadence(
    buildCadence(
      { frequency, hour12, minute, meridiem, dayOfWeek },
      resolvePreservedWeeklyDays(frequency),
    ),
    localize,
    locale,
  )} · ${timezone}`;
  const isLoading = createSchedule.isLoading || updateSchedule.isLoading;
  const canSubmit =
    name.trim().length > 0 &&
    prompt.trim().length > 0 &&
    agentId.length > 0 &&
    chatProjectId.length > 0;
  const handleProjectCreated = (project: TChatProject) => {
    setCreatedProject(project);
    setValue('chatProjectId', project._id, { shouldDirty: true, shouldValidate: true });
  };

  return (
    <>
      <OGDialog open={open} onOpenChange={onOpenChange} triggerRef={triggerRef}>
        <OGDialogTemplate
          title={localize(schedule ? 'com_knauf_scheduler_edit' : 'com_knauf_scheduler_new')}
          showCloseButton={false}
          className="w-11/12 md:max-w-lg"
          main={
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="schedule-name">{localize('com_ui_name')}</Label>
                <Input
                  id="schedule-name"
                  className="w-full"
                  {...register('name', { required: true })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="schedule-prompt">{localize('com_ui_prompt')}</Label>
                <textarea
                  id="schedule-prompt"
                  rows={4}
                  className="min-h-[100px] w-full resize-none rounded-lg border border-border-light bg-transparent px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-heavy"
                  {...register('prompt', { required: true })}
                />
              </div>
              <div className="space-y-2">
                <Label>{localize('com_ui_agent')}</Label>
                <Controller
                  name="agent_id"
                  control={control}
                  rules={{ required: true }}
                  render={({ field }) => (
                    <ControlCombobox
                      selectedValue={field.value}
                      displayValue={
                        agentItems.find((item) => item.value === field.value)?.label ?? ''
                      }
                      selectPlaceholder={localize('com_ui_select_agent')}
                      searchPlaceholder={localize('com_agents_search_name')}
                      setValue={field.onChange}
                      items={agentItems}
                      ariaLabel={localize('com_ui_agent')}
                      isCollapsed={false}
                      showCarat={true}
                      containerClassName="px-0"
                      className="h-9 w-full rounded-md border border-border-light bg-transparent"
                    />
                  )}
                />
                <p className="text-xs text-text-secondary">
                  {localize('com_knauf_scheduler_target_new_chat')}
                </p>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <Label>{localize('com_ui_projects')}</Label>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setIsProjectCreateOpen(true)}
                  >
                    {localize('com_ui_create_project')}
                  </Button>
                </div>
                <Controller
                  name="chatProjectId"
                  control={control}
                  rules={{ required: true }}
                  render={({ field }) => (
                    <ControlCombobox
                      selectedValue={field.value}
                      displayValue={
                        projectItems.find((item) => item.value === field.value)?.label ?? ''
                      }
                      selectPlaceholder={localize('com_ui_select_project')}
                      searchPlaceholder={localize('com_ui_search_projects')}
                      setValue={field.onChange}
                      items={projectItems}
                      ariaLabel={localize('com_ui_projects')}
                      isCollapsed={false}
                      showCarat={true}
                      containerClassName="px-0"
                      className="h-9 w-full rounded-md border border-border-light bg-transparent"
                    />
                  )}
                />
              </div>
              <div className="space-y-2">
                <Label>{localize('com_knauf_scheduler_frequency')}</Label>
                <Controller
                  name="frequency"
                  control={control}
                  render={({ field }) => (
                    <div
                      className="flex gap-1"
                      role="group"
                      aria-label={localize('com_knauf_scheduler_frequency')}
                    >
                      <FrequencyButton
                        frequency="hourly"
                        selected={field.value === 'hourly'}
                        label={localize('com_knauf_scheduler_hourly')}
                        onSelect={field.onChange}
                      />
                      <FrequencyButton
                        frequency="daily"
                        selected={field.value === 'daily'}
                        label={localize('com_knauf_scheduler_daily')}
                        onSelect={field.onChange}
                      />
                      <FrequencyButton
                        frequency="weekdays"
                        selected={field.value === 'weekdays'}
                        label={localize('com_knauf_scheduler_weekdays')}
                        onSelect={field.onChange}
                      />
                      <FrequencyButton
                        frequency="weekly"
                        selected={field.value === 'weekly'}
                        label={localize('com_knauf_scheduler_weekly')}
                        onSelect={field.onChange}
                      />
                    </div>
                  )}
                />
              </div>
              {frequency === 'weekly' && (
                <div className="space-y-2">
                  <Label>{localize('com_knauf_scheduler_day')}</Label>
                  <Controller
                    name="dayOfWeek"
                    control={control}
                    render={({ field }) => (
                      <Dropdown
                        value={String(field.value)}
                        onChange={(value) => field.onChange(Number(value))}
                        options={dayOptions}
                        className="w-full"
                        ariaLabel={localize('com_knauf_scheduler_day')}
                        testId="schedule-day-select"
                      />
                    )}
                  />
                </div>
              )}
              <div className="space-y-2">
                <Label>{localize('com_knauf_scheduler_time')}</Label>
                <div className="flex gap-2">
                  {frequency !== 'hourly' && (
                    <Controller
                      name="hour12"
                      control={control}
                      render={({ field }) => (
                        <Dropdown
                          value={String(field.value)}
                          onChange={(value) => field.onChange(Number(value))}
                          options={hourOptions}
                          className="flex-1"
                          ariaLabel={localize('com_knauf_scheduler_hour')}
                          testId="schedule-hour-select"
                        />
                      )}
                    />
                  )}
                  <Controller
                    name="minute"
                    control={control}
                    render={({ field }) => (
                      <Dropdown
                        value={String(field.value)}
                        onChange={(value) => field.onChange(Number(value))}
                        options={minuteOptions}
                        className="flex-1"
                        ariaLabel={localize('com_knauf_scheduler_minute')}
                        testId="schedule-minute-select"
                      />
                    )}
                  />
                  {frequency !== 'hourly' && (
                    <Controller
                      name="meridiem"
                      control={control}
                      render={({ field }) => (
                        <Dropdown
                          value={field.value}
                          onChange={field.onChange}
                          options={meridiemOptions}
                          className="flex-1"
                          ariaLabel={localize('com_knauf_scheduler_meridiem')}
                          testId="schedule-meridiem-select"
                        />
                      )}
                    />
                  )}
                </div>
              </div>
              <p className="text-sm text-text-secondary">{summary}</p>
            </div>
          }
          buttons={
            <Button
              type="button"
              variant="submit"
              onClick={handleSubmit(onSubmit)}
              disabled={isLoading || !canSubmit}
              className="text-white"
              aria-label={localize(schedule ? 'com_ui_save' : 'com_ui_create')}
            >
              {isLoading ? (
                <Spinner className="size-4" />
              ) : (
                localize(schedule ? 'com_ui_save' : 'com_ui_create')
              )}
            </Button>
          }
        />
      </OGDialog>
      <ProjectCreateDialog
        open={isProjectCreateOpen}
        onOpenChange={setIsProjectCreateOpen}
        onCreated={handleProjectCreated}
      />
    </>
  );
}
