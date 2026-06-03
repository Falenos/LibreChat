const { logger } = require('@librechat/data-schemas');

const ONE_TRUST_SCRIPT_SRC = 'https://cdn.cookielaw.org/scripttemplates/otSDKStub.js';
const ONE_TRUST_DOMAIN_SCRIPT_IDS = {
  nonprod: '1f2c6fdd-5a57-44ad-b965-2a85d905bbdc-test',
  prod: '1f2c6fdd-5a57-44ad-b965-2a85d905bbdc',
};
const ANALYTICS_CONSENT_CATEGORY_ID = 'C0002';
const ADOBE_APP_NAME = 'knauf_agentic_karl';

function isFalseLike(value) {
  return /^(false|0|no|off)$/i.test(String(value).trim());
}

function getAnalyticsEnvironment() {
  return /^(prod|production)$/i.test(process.env.KNAUF_ANALYTICS_ENV ?? '') ? 'prod' : 'nonprod';
}

function getRequiredAdobeLaunchScriptUrl() {
  const scriptUrl = process.env.KNAUF_ADOBE_ANALYTICS_SCRIPT_URL?.trim();

  if (!scriptUrl) {
    logger.warn(
      '[knauf analytics] KNAUF_ADOBE_ANALYTICS_SCRIPT_URL is required when Knauf analytics is enabled; analytics config will not be exposed.',
    );
    return undefined;
  }

  return scriptUrl;
}

function getKnaufAnalyticsConfig() {
  if (isFalseLike(process.env.KNAUF_ANALYTICS_ENABLED)) {
    return undefined;
  }

  const analyticsEnv = getAnalyticsEnvironment();
  const adobeLaunchScriptUrl = getRequiredAdobeLaunchScriptUrl();

  if (!adobeLaunchScriptUrl) {
    return undefined;
  }

  return {
    enabled: true,
    oneTrustScriptSrc: process.env.KNAUF_ONETRUST_SCRIPT_SRC || ONE_TRUST_SCRIPT_SRC,
    oneTrustDomainScriptId:
      process.env.KNAUF_ONETRUST_DOMAIN_SCRIPT_ID ||
      ONE_TRUST_DOMAIN_SCRIPT_IDS[analyticsEnv],
    consentCategoryId:
      process.env.KNAUF_ANALYTICS_CONSENT_CATEGORY_ID || ANALYTICS_CONSENT_CATEGORY_ID,
    adobeLaunchScriptUrl,
    adobeAppName: process.env.KNAUF_ADOBE_APP_NAME || ADOBE_APP_NAME,
  };
}

module.exports = {
  getKnaufAnalyticsConfig,
};
