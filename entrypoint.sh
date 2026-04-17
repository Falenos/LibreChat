#!/bin/sh

# Build runtime config from the resources template using only OPENAI_API_KEY.

escaped_openai_api_key=$(printf '%s' "${OPENAI_API_KEY}" | sed -e 's/[\/&|]/\\&/g')
sed 's|${OPENAI_API_KEY}|'"${escaped_openai_api_key}"'|g' resources/librechat.yaml > librechat.yaml

exec "$@"
