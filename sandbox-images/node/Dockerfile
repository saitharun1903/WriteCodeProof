# Runs target-repo JavaScript/TypeScript code. See spec section 6 for the
# limits applied at run time; this image only has to work under them:
# read-only root, writable /work and /tmp, uid 1000, no network.
ARG NODE_VERSION=24.21.0
FROM node:${NODE_VERSION}-trixie-slim

# The base image's "node" user is already uid/gid 1000.
ENV HOME=/tmp \
    CI=true \
    npm_config_cache=/tmp/.npm \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false \
    NO_UPDATE_NOTIFIER=1

WORKDIR /work
USER 1000:1000
CMD ["node", "--version"]
