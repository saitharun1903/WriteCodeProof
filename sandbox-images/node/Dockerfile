# Runs target-repo JavaScript/TypeScript code. See spec section 6 for the
# limits applied at run time; this image only has to work under them:
# read-only root, writable /work and /tmp, uid 1000, no network.
ARG NODE_VERSION=24.21.0
FROM node:${NODE_VERSION}-trixie-slim

# Dependencies are installed into a per-lockfile Docker volume mounted at
# /deps. The folder is created here, owned by uid 1000, so a fresh volume
# inherits that owner. /node_modules points into it: Node looks there last
# when resolving packages, so code anywhere under /work finds them.
# The base image's "node" user is already uid/gid 1000.
RUN mkdir -p /deps && chown 1000:1000 /deps && ln -s /deps/node_modules /node_modules

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
