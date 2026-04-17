#!/bin/sh

# Build runtime config from the resources template using only OPENAI_API_KEY.
envsubst '${OPENAI_API_KEY}' < resources/librechat.yaml > librechat.yaml

exec "$@"
