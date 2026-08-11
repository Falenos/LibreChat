'use strict';

function isSchedulerApiEnabled(value = process.env.KNAUF_SCHEDULER_API_ENABLED) {
  return value === 'true';
}

function applySchedulerInterfaceFlag(config, value = process.env.KNAUF_SCHEDULER_API_ENABLED) {
  if (!isSchedulerApiEnabled(value)) {
    return config;
  }

  config.interface ??= {};
  config.interface.knauf ??= {};
  config.interface.knauf.scheduler = true;
  return config;
}

module.exports = { applySchedulerInterfaceFlag, isSchedulerApiEnabled };
