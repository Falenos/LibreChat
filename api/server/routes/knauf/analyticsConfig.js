const { logger } = require('@librechat/data-schemas');

const ONE_TRUST_SCRIPT_SRC = 'https://cdn.cookielaw.org/scripttemplates/otSDKStub.js';
const ANALYTICS_CONSENT_CATEGORY_ID = 'C0002';
const ADOBE_APP_NAME = 'knauf_agentic_karl';

function isFalseLike(value) {
  return /^(false|0|no|off)$/i.test(String(value).trim());
}

function getRequiredConfigValue(envName) {
  const value = process.env[envName]?.trim();

  if (!value) {
    logger.warn(
      `[knauf analytics] ${envName} is required when Knauf analytics is enabled; analytics config will not be exposed.`,
    );
    return undefined;
  }

  return value;
}

function getKnaufAnalyticsConfig() {
  if (isFalseLike(process.env.KNAUF_ANALYTICS_ENABLED)) {
    return undefined;
  }

  const oneTrustDomainScriptId = getRequiredConfigValue('KNAUF_ONETRUST_DOMAIN_SCRIPT_ID');
  const adobeLaunchScriptUrl = getRequiredConfigValue('KNAUF_ADOBE_ANALYTICS_SCRIPT_URL');

  if (!oneTrustDomainScriptId || !adobeLaunchScriptUrl) {
    return undefined;
  }

  return {
    enabled: true,
    oneTrustScriptSrc: process.env.KNAUF_ONETRUST_SCRIPT_SRC || ONE_TRUST_SCRIPT_SRC,
    oneTrustDomainScriptId,
    consentCategoryId:
      process.env.KNAUF_ANALYTICS_CONSENT_CATEGORY_ID || ANALYTICS_CONSENT_CATEGORY_ID,
    adobeLaunchScriptUrl,
    adobeAppName: process.env.KNAUF_ADOBE_APP_NAME || ADOBE_APP_NAME,
  };
}

module.exports = {
  getKnaufAnalyticsConfig,
};
