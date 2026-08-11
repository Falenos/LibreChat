'use strict';

const { createSchedulerMetrics } = require('./metrics');

describe('scheduler metrics', () => {
  test('exports scheduler capacity, queue, dispatch, and execution metrics', async () => {
    const { metrics, getMetricsText } = createSchedulerMetrics();

    metrics.recordDispatch('queued');
    metrics.recordExecution('completed');
    metrics.recordExecutionDuration(12);
    metrics.setState({
      active: 7,
      capacity: 25,
      queued: 42,
      oldestQueueAgeSeconds: 90,
    });

    const output = await getMetricsText();
    expect(output).toContain('knauf_scheduler_dispatches_total{outcome="queued"} 1');
    expect(output).toContain('knauf_scheduler_executions_total{outcome="completed"} 1');
    expect(output).toContain('knauf_scheduler_active_executions 7');
    expect(output).toContain('knauf_scheduler_execution_capacity 25');
    expect(output).toContain('knauf_scheduler_queue_depth 42');
    expect(output).toContain('knauf_scheduler_oldest_queue_age_seconds 90');
  });
});
