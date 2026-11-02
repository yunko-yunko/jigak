# syntax=docker/dockerfile:1
# Model refresh Cloud Run Job: Node (TypeScript steps, tsx) + Python (training), one image.
#
# Build context = the jigak-backend repository root (the backend-only repository, or jigak-backend/ in the monorepo):
#   docker build -f model-refresh/Dockerfile -t jigak-model-refresh:dev .
# model-refresh/Dockerfile.dockerignore keeps the context to what is copied below. The API image (./Dockerfile) never
# sees model-refresh/ or Python, and this image carries only the engine files the job imports, not the API.
#
# The entrypoint runs the same orchestrator as a developer machine; only --store differs:
# /models-store is the bucket mounted as a Cloud Run volume (type=cloud-storage).

ARG NODE_IMAGE=node:24-bookworm-slim
ARG PYTHON_IMAGE=python:3.14-slim-bookworm

FROM ${NODE_IMAGE} AS node-deps
WORKDIR /deps
COPY model-refresh/package.json model-refresh/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM ${NODE_IMAGE} AS node-binary

FROM ${PYTHON_IMAGE} AS python-deps
ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1
COPY model-refresh/scripts/requirements-spatial-eta.txt /tmp/requirements-spatial-eta.txt
# certifi: the Python of this image verifies apis.data.go.kr and t-data.seoul.go.kr with the system CAs below;
# certifi stays as the fallback for any script that asks for it.
RUN python -m venv /opt/venv \
 && /opt/venv/bin/pip install -r /tmp/requirements-spatial-eta.txt certifi

FROM ${PYTHON_IMAGE} AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates libstdc++6 tzdata \
 && rm -rf /var/lib/apt/lists/*
COPY --from=node-binary /usr/local/bin/node /usr/local/bin/node
ENV TZ=Asia/Seoul \
    PYTHON=/opt/venv/bin/python \
    PATH=/opt/venv/bin:$PATH \
    SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt \
    PYTHONUNBUFFERED=1 \
    NODE_ENV=production \
    MODEL_REFRESH_MODE=cloud
WORKDIR /app
COPY --from=python-deps /opt/venv /opt/venv
COPY --from=node-deps /deps/node_modules ./node_modules
# "type": "module" for the engine files under src/ (the marker the API uses); nothing is installed from it.
COPY package.json ./package.json
# The parsers and model code the API itself runs (zod only): the intelligence folder, two helpers and the shipped
# holiday calendars (the Python trainers' default calendar too). Same relative layout as the repository.
COPY src/common/engine/intelligence ./src/common/engine/intelligence
COPY src/common/engine/private-files.ts ./src/common/engine/private-files.ts
COPY src/common/engine/realtime/bicycle-ride-times.ts ./src/common/engine/realtime/bicycle-ride-times.ts
COPY src/common/engine/realtime/data/korea-holidays-*.json ./src/common/engine/realtime/data/
COPY model-refresh/package.json ./model-refresh/package.json
COPY model-refresh/scripts ./model-refresh/scripts
# Fixed training inputs (road priors, station coordinates), checked by sha256 at run time. The store's static/ copy wins.
COPY model-refresh/data-static ./model-refresh/data-static
WORKDIR /app/model-refresh
# Build-time smoke test: every TypeScript entry point resolves its whole import graph from what this image carries,
# and the Python gate loads both trainers (numpy, scikit-learn) from the venv.
RUN for entry in models-refresh join-public-bus-context train-public-bus-model refresh-public-bus-model verify-public-bus-reproduction promote-spatial-bus promote-rail-gate promote-spatial-bicycle; do \
      node --import tsx -e "import('./scripts/$entry.ts')" || exit 1; done \
 && /opt/venv/bin/python -X utf8 scripts/model-refresh/incumbent-gate.py --help > /dev/null
RUN mkdir -p /tmp/jigak-refresh
# Runs as root on purpose: a Cloud Run Cloud Storage volume is owned by root unless uid/gid mount options are
# set, and the job must write the bucket. The container has no inbound port and only this bucket's objectUser role.
# One line: the store is a bucket volume. Extra arguments (--plan, --only spatialBus, --run-id ...) follow it.
ENTRYPOINT ["node", "--import", "tsx", "scripts/models-refresh.ts", "--store", "/models-store"]
