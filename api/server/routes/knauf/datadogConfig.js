/**
 * Datadog Browser RUM + Logs config helper.
 *
 * Reads DATADOG_* env vars from the deployment ConfigMap and returns
 * a config object for the startup config API. Follows the same pattern
 * as analyticsConfig.js (Adobe Analytics).
 *
 * The frontend reads this config via useGetStartupConfig() to initialize
 * the @datadog/browser-rum and @datadog/browser-logs SDKs.
 */
const { logger } = require('@librechat/data-schemas');

function isTrueLike(value) {
  return /^(true|1|yes|on)$/i.test(String(value).trim());
}

/**
 * Build the Datadog browser config from DATADOG_* env vars.
 *
 * Returns undefined when both RUM and browser logs are disabled
 * (or required shared values are missing), so the frontend can
 * skip initialization entirely.
 */
function getKnaufDatadogConfig() {
  const rumEnabled = isTrueLike(process.env.DATADOG_RUM_ENABLED);
  const browserLogsEnabled = isTrueLike(process.env.DATADOG_BROWSER_LOGS_ENABLED);

  if (!rumEnabled && !browserLogsEnabled) {
    return undefined;
  }

  const clientToken = process.env.DATADOG_CLIENT_TOKEN?.trim();
  const site = process.env.DATADOG_SITE?.trim();
  const service = process.env.DATADOG_SERVICE?.trim();
  const env = process.env.DATADOG_ENV?.trim();

  if (!clientToken || !site) {
    logger.warn(
      '[knauf datadog] DATADOG_CLIENT_TOKEN and DATADOG_SITE are required; datadog config will not be exposed.',
    );
    return undefined;
  }

  const config = {
    clientToken,
    site,
    service: service || 'agentic-karl',
    env: env || 'unknown',
    rumEnabled,
    browserLogsEnabled,
  };

  if (rumEnabled) {
    const applicationId = process.env.DATADOG_RUM_APPLICATION_ID?.trim();
    if (!applicationId) {
      logger.warn(
        '[knauf datadog] DATADOG_RUM_APPLICATION_ID is required when RUM is enabled; datadog config will not be exposed.',
      );
      return undefined;
    }
    config.rumApplicationId = applicationId;
  }

  return config;
}

module.exports = {
  getKnaufDatadogConfig,
};
