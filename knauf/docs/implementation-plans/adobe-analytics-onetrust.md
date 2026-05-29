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
Adobe app name: agentic_karl
```

The app currently emits one Adobe Client Data Layer event after Adobe Launch has
loaded and analytics consent is active:

```json
{
  "event": "pageview",
  "event_info": {
    "app_name": "agentic_karl",
    "event_specification": "pageview",
    "page_section": "chat",
    "user_login_status": "logged_in"
  }
}
```

No user email, prompt text, message text, agent content, or chat content is sent
by this branch.

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
"agentic_karl"`.

## Next steps

Adobe Launch needs a matching rule/report-suite mapping for Agentic Karl. The
current dev Launch property loads successfully, but local testing may not show an
Adobe collection beacon (`b/ss` or `omtrdc`) until Adobe is configured for
`agentic_karl` and the deployed hostname.

Before production rollout, confirm these items with the analytics owner:

```text
1. Which hostname will Agentic Karl use in production?
2. Which Adobe report suite should receive agentic_karl events?
3. Should the Launch rule key only on event_info.app_name = agentic_karl, or also on hostname?
4. Is C0002 the final OneTrust category for Adobe Analytics?
5. Should any additional non-content events be tracked beyond pageview?
```

The negative consent path should be retested in a clean browser session by
choosing Reject All and confirming `knauf-adobe-analytics` is not injected.
