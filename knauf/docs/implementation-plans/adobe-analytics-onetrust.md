# Adobe Analytics and OneTrust temporary notes

## What changed

This branch adds a post-login consent and analytics controller for Agentic Karl.
The backend exposes a Knauf namespaced analytics config through `/api/config`.
The authenticated React app reads that config, loads OneTrust, waits for the
analytics consent category, and then loads Adobe Launch.

The default local/non-prod configuration is:

```text
OneTrust domain script ID: 1f2c6fdd-5a57-44ad-b965-2a85d905bbdc-test
Adobe Launch script: https://assets.adobedtm.com/ab43015a9bd1/1c0f435acc82/launch-5440eaedcac0-development.min.js
Consent category: C0002
Adobe app name: knauf_karl
```

The app currently emits one Adobe Client Data Layer event after Adobe Launch has
loaded and analytics consent is active:

```json
{
  "event": "pageview",
  "event_info": {
    "app_name": "knauf_karl",
    "event_specification": "pageview",
    "page_category": "karl_page",
    "page_section": "chat",
    "user_login_status": "logged_in",
    "user_session_id": "generated-per-browser-session",
    "user_timestamp_iso": "2026-06-01T10:00:00.000Z"
  }
}
```

No user email, prompt text, message text, agent content, or chat content is sent
by this branch. The current implementation also does not send `user_country`,
`user_is_knauf_employee`, or `user_hashed_knauf_id`; those need a verified data
source and privacy sign-off before they are added.

## Runtime configuration

These values are returned to the browser through `/api/config`, so they are not
secrets once the app is running. Treat them as environment-scoped deployment
configuration. If the platform sources application environment variables from
Key Vault, External Secrets, or another secret manager, store them there as
non-sensitive configuration entries.

Required deployment values:

```text
KNAUF_ANALYTICS_ENABLED=true
KNAUF_ANALYTICS_ENV=nonprod
KNAUF_ANALYTICS_CONSENT_CATEGORY_ID=C0002
KNAUF_ADOBE_APP_NAME=knauf_karl
```

For production, set:

```text
KNAUF_ANALYTICS_ENABLED=true
KNAUF_ANALYTICS_ENV=prod
KNAUF_ANALYTICS_CONSENT_CATEGORY_ID=C0002
KNAUF_ADOBE_APP_NAME=knauf_karl
```

Optional explicit overrides, useful if infra does not want to rely on code
defaults:

```text
KNAUF_ONETRUST_SCRIPT_SRC=https://cdn.cookielaw.org/scripttemplates/otSDKStub.js
KNAUF_ONETRUST_DOMAIN_SCRIPT_ID=1f2c6fdd-5a57-44ad-b965-2a85d905bbdc-test
KNAUF_ADOBE_ANALYTICS_SCRIPT_URL=https://assets.adobedtm.com/ab43015a9bd1/1c0f435acc82/launch-5440eaedcac0-development.min.js
```

Production override values, if the deployment stores every value explicitly:

```text
KNAUF_ONETRUST_SCRIPT_SRC=https://cdn.cookielaw.org/scripttemplates/otSDKStub.js
KNAUF_ONETRUST_DOMAIN_SCRIPT_ID=1f2c6fdd-5a57-44ad-b965-2a85d905bbdc
KNAUF_ADOBE_ANALYTICS_SCRIPT_URL=https://assets.adobedtm.com/ab43015a9bd1/1c0f435acc82/launch-6532ab2ce849.min.js
```

No OneTrust API key, Adobe API key, Adobe client secret, or user credential is
required by this implementation.

## External setup

OneTrust must be production-ready outside this repository:

```text
1. Add the final Agentic Karl production hostname to the relevant Knauf.com OneTrust setup.
2. Confirm that C0002 is the final Performance and Analytics Cookies category for Adobe Analytics.
3. Confirm the consent banner geo and language rules include the locales Agentic Karl serves.
4. Confirm the Adobe cookies created by Launch/AppMeasurement are classified under the analytics category.
5. Confirm whether the current generic Knauf.com production script ID is final or whether Agentic Karl needs a dedicated OneTrust ID.
```

Adobe Launch and Adobe Analytics must also be configured outside this
repository:

```text
1. Add a Launch rule for Adobe Client Data Layer event = pageview.
2. Scope the rule to event_info.app_name = knauf_karl and the deployed Agentic Karl hostname, or use myknauf_karl if the final placement is under myKnauf.
3. Map the dev/stage Launch property to the correct non-production report suite.
4. Map the production Launch property to the correct production report suite.
5. Map data elements from event_info, including app_name, page_url, page_name, page_title, page_domain, page_hostname, page_locale, page_query_string, page_category, page_section, user_language, user_login_status, user_session_id, and user_timestamp_iso.
6. Confirm no PII fields are required. This branch intentionally sends no email, prompt, message, agent content, or chat content.
```

## Local verification

Run the standard local development flow from the repository root:

```bash
docker compose up -d mongodb meilisearch vectordb rag_api
npm run backend:dev
npm run frontend:dev
```

Open `http://localhost:3090`, log in, accept Performance and Analytics Cookies,
and verify:

```js
document.getElementById('knauf-onetrust-sdk')?.outerHTML
document.getElementById('knauf-adobe-analytics')?.src
window.adobeDataLayer?.slice?.(-3)
```

Expected result: OneTrust is present, Adobe Launch is present, and the latest
data layer event has `event: "pageview"` and `event_info.app_name:
"knauf_karl"` or the app name configured through `KNAUF_ADOBE_APP_NAME`.

## Deployment readiness plan

Adobe Launch needs a matching rule/report-suite mapping for Agentic Karl. The
current dev Launch property loads successfully, but local testing may not show an
Adobe collection beacon (`b/ss` or `omtrdc`) until Adobe is configured for
the configured Adobe app name and the deployed hostname.

Before production rollout, confirm these open decisions with the analytics owner:

```text
1. Which hostname will Agentic Karl use in production?
2. Which Adobe report suite should receive knauf_karl/myknauf_karl events?
3. Should the Launch rule key only on event_info.app_name, or also on hostname?
4. Is C0002 the final OneTrust category for Adobe Analytics?
5. Should any additional non-content events be tracked beyond pageview?
```

Recommended rollout sequence:

```text
1. Configure non-production runtime values and deploy the branch to dev/stage.
2. Verify /api/config returns knauf.analytics.enabled = true and the non-production OneTrust and Adobe values.
3. Log in, accept Performance and Analytics Cookies, and confirm OneTrust, Adobe Launch, and window.adobeDataLayer pageview are present.
4. In browser Network, confirm Adobe Launch loads. If no Adobe collection request appears, finish the Launch rule/report-suite setup before production.
5. Test a clean browser session with Reject All and confirm knauf-adobe-analytics is not injected and no Adobe collection request is sent.
6. Configure production runtime values with KNAUF_ANALYTICS_ENV=prod.
7. Get OneTrust and Adobe owner approval for the production hostname, consent category, app name, Launch rule, and report suite.
8. Deploy production and verify the production OneTrust ID, production Adobe Launch URL, consent-positive collection request, and consent-negative suppression.
9. If rollback is needed, set KNAUF_ANALYTICS_ENABLED=false and restart/redeploy the app.
```
