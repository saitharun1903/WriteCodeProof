# Runs target-repo Python code under the same limits as the node image.
ARG PYTHON_VERSION=3.13.16
FROM python:${PYTHON_VERSION}-slim-trixie

# Dependencies go into a per-lockfile Docker volume mounted at /deps
# (installed with pip --target /deps/site-packages, found via PYTHONPATH).
# pytest is preinstalled so generated tests can run in repos that don't use it.
ARG PYTEST_VERSION=9.1.1
RUN pip install --no-cache-dir "pytest==${PYTEST_VERSION}" \
 && groupadd --gid 1000 sandbox \
 && useradd --uid 1000 --gid 1000 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin sandbox \
 && mkdir -p /deps && chown 1000:1000 /deps

ENV HOME=/tmp \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_CACHE_DIR=/tmp/.pip \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_INPUT=1

WORKDIR /work
USER 1000:1000
CMD ["python", "--version"]
