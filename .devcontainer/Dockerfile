# The devcontainer should use the developer target and run as root with podman
# or docker with user namespaces.
FROM ghcr.io/diamondlightsource/ubuntu-devcontainer:resolute AS developer

# Add any system dependencies for the developer/build environment here
# socat: the end-to-end test runs the SessionStart hook's relay for real
RUN apt-get update -y && apt-get install -y --no-install-recommends \
    socat \
    && apt-get dist-clean

# Upstream Node, as CI's setup-node uses: Ubuntu's nodejs is built without
# type stripping, so `npm test` cannot load the .ts tests with it.
# /usr/local/bin comes before /usr/bin on PATH.
COPY --from=docker.io/library/node:22-trixie-slim /usr/local/bin/node /usr/local/bin/
COPY --from=docker.io/library/node:22-trixie-slim /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/npm
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
