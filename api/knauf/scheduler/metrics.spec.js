'use strict';

const { createSchedulerMetrics } = require('./metrics');

describe('scheduler metrics', () => {
  test('exports scheduler capacity, queue, dispatch, and execution metrics', async () => {
    const { metrics, getMetricsText } = createSchedulerMetrics();

    metrics.recordDispatch('queued');
    metrics.recordExecution('completed');
    metrics.recordExecutionDuration(12);
    metrics.setConversationIntegrity({
      missingChatProjectId: 3,
      scanHealthy: true,
    });
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
    expect(output).toContain('knauf_conversation_chat_project_id_missing 3');
    expect(output).toContain('knauf_conversation_integrity_scan_healthy 1');
  });
});
