const ONE_TRUST_SCRIPT_SRC = 'https://cdn.cookielaw.org/scripttemplates/otSDKStub.js';
const ONE_TRUST_DOMAIN_SCRIPT_IDS = {
  nonprod: '1f2c6fdd-5a57-44ad-b965-2a85d905bbdc-test',
  prod: '1f2c6fdd-5a57-44ad-b965-2a85d905bbdc',
};
const ADOBE_ANALYTICS_SCRIPT_URLS = {
  nonprod:
    'https://assets.adobedtm.com/ab43015a9bd1/1c0f435acc82/launch-5440eaedcac0-development.min.js',
  prod: 'https://assets.adobedtm.com/ab43015a9bd1/1c0f435acc82/launch-6532ab2ce849.min.js',
};
const ANALYTICS_CONSENT_CATEGORY_ID = 'C0002';
const ADOBE_APP_NAME = 'knauf_agentic_karl';

function isFalseLike(value) {
  return /^(false|0|no|off)$/i.test(String(value).trim());
}

function getAnalyticsEnvironment() {
  return /^(prod|production)$/i.test(process.env.KNAUF_ANALYTICS_ENV ?? '') ? 'prod' : 'nonprod';
}

function getKnaufAnalyticsConfig() {
  if (isFalseLike(process.env.KNAUF_ANALYTICS_ENABLED)) {
    return undefined;
  }

  const analyticsEnv = getAnalyticsEnvironment();

  return {
    enabled: true,
    oneTrustScriptSrc: process.env.KNAUF_ONETRUST_SCRIPT_SRC || ONE_TRUST_SCRIPT_SRC,
    oneTrustDomainScriptId:
      process.env.KNAUF_ONETRUST_DOMAIN_SCRIPT_ID ||
      ONE_TRUST_DOMAIN_SCRIPT_IDS[analyticsEnv],
    consentCategoryId:
      process.env.KNAUF_ANALYTICS_CONSENT_CATEGORY_ID || ANALYTICS_CONSENT_CATEGORY_ID,
    adobeLaunchScriptUrl:
      process.env.KNAUF_ADOBE_ANALYTICS_SCRIPT_URL ||
      ADOBE_ANALYTICS_SCRIPT_URLS[analyticsEnv],
    adobeAppName: process.env.KNAUF_ADOBE_APP_NAME || ADOBE_APP_NAME,
  };
}

module.exports = {
  getKnaufAnalyticsConfig,
};
