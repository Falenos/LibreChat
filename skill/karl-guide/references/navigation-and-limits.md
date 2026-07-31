# Navigation, limits, and troubleshooting

Last verified from the application repository: 2026-07-31. Labels may vary with language, permissions, and rollout configuration.

## Common paths

| Goal | Typical path |
| --- | --- |
| Start general work | New chat -> describe the outcome you need |
| Upload conversation files | Chat composer -> attachment/paperclip -> Upload files |
| Enable or inspect chat capabilities | Chat composer -> Tools menu; only permitted items appear |
| Find an assigned agent | Main sidebar -> Agent Marketplace |
| Create or edit an agent | Main sidebar -> Agent Builder; requires agent-create permission |
| Add persistent agent knowledge | Agent Builder -> Data Knowledge -> upload files |
| Configure agent capabilities | Agent Builder -> What it can do |
| Inspect shipped skills | Main sidebar -> Skills; the deployed catalogue is read-only |
| Change personal UI preferences | Profile menu -> Settings |

If the UI path is absent, do not invent alternate paths. Explain that permissions or deployment configuration may hide it.

## Supported upload formats

Chat uploads accept:

- Documents: PDF, DOCX, PPTX, TXT, Markdown.
- Data: XLSX, CSV, JSON.
- Images: PNG, JPEG/JPG, WEBP.

Agent Builder Data Knowledge accepts the document and data formats above. Images are rejected for Agent Knowledge/File Search and must be supplied as message-scoped chat images instead.

Legacy DOC, XLS, PPT, archives, video, audio, SVG, and arbitrary code formats are not in the restricted allow-list.

## Upload limits

- Chat: at most 5 files in one send and 100 MB total.
- Agent Knowledge: no configured file-count or aggregate-size cap per selection.
- Per file: documents 25 MB, data/spreadsheets 50 MB, chat images 20 MB.

The platform can reject a file for type, size, encryption, upload, parsing, or indexing reasons even when the picker accepted the selection.

## Known web limitations

The exact-page reader:

- Fetches only an exact HTTPS link in the user's current message; plain HTTP is rejected.
- Reads static or server-rendered HTML and plain text.
- Does not execute JavaScript, authenticate, keep cookies, click controls, or behave like a browser.
- Cannot fetch a URL discovered by search or found in an older message unless the user supplies it again in the current message.
- Can fail on bot protection, client-rendered applications, timeouts, redirects, private-network targets, PDF, Office, image, audio, or video URLs.

Use model-native web search as the fallback. Ask for an uploaded permitted copy when the exact inaccessible document matters.

## Troubleshooting patterns

### Agent Marketplace is missing

For a regular user, it stays hidden until at least one agent is accessible. Other likely causes are missing Agents/Marketplace permissions or environment configuration.

### An expected agent is missing

Likely causes: it is still private, it was not assigned to the user's audience group, group membership changed, or access was revoked.

### Create or admin control is missing

Likely causes: the user's effective role lacks the permission, the capability is admin-managed, or the feature is disabled in that environment.

### Agent Knowledge does not answer yet

The file may still be indexing or may have failed. Check the visible file status, retry when the UI offers it, and avoid claiming the agent has indexed content until it is ready.

### File citations are absent

The answer may not have used File Search, the relevant content may not have been retrieved, or file-citation permission may be unavailable. Do not invent page or section citations.

### Webpage cannot be read

State the limitation, try model-native search for an alternative authoritative source, or ask for an uploaded copy. Never summarise a challenge page or empty result as if it were the requested content.
