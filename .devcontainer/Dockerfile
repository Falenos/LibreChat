FROM node:24.16.0-bullseye

# [knauf] Ghostscript recompresses translated PDFs locally the same way prod does. (KK20-297)
RUN apt-get update && apt-get install -y --no-install-recommends ghostscript \
    && rm -rf /var/lib/apt/lists/*
# End [knauf]

RUN useradd -m -s /bin/bash vscode
RUN mkdir -p /workspaces && chown -R vscode:vscode /workspaces
WORKDIR /workspaces
