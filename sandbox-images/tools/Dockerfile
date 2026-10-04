# Security scanners. Scans run with no network, so the Semgrep rules are
# downloaded here, at build time, and read from /opt/semgrep-rules.
ARG SEMGREP_VERSION=1.179.0
ARG GITLEAKS_VERSION=8.30.1

FROM zricethezav/gitleaks:v${GITLEAKS_VERSION} AS gitleaks

FROM semgrep/semgrep:${SEMGREP_VERSION}
ARG SEMGREP_RULES_URL=https://semgrep.dev/c/p/default

USER root
COPY --from=gitleaks /usr/bin/gitleaks /usr/local/bin/gitleaks
RUN mkdir -p /opt/semgrep-rules \
 && wget -q -O /opt/semgrep-rules/default.yml "${SEMGREP_RULES_URL}" \
 && grep -q '^rules:' /opt/semgrep-rules/default.yml \
 && (getent group 1000 >/dev/null || addgroup -g 1000 sandbox) \
 && (getent passwd 1000 >/dev/null || adduser -D -u 1000 -G "$(getent group 1000 | cut -d: -f1)" -h /tmp -s /sbin/nologin sandbox)

ENV HOME=/tmp \
    XDG_CONFIG_HOME=/tmp \
    SEMGREP_RULES_DIR=/opt/semgrep-rules \
    SEMGREP_SEND_METRICS=off \
    SEMGREP_ENABLE_VERSION_CHECK=0

WORKDIR /work
USER 1000:1000
ENTRYPOINT []
CMD ["semgrep", "--version"]
