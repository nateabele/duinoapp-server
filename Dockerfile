FROM node:24.21.0-bookworm-slim

# Native installs are the primary deployment (see deploy/README.md); this image
# is kept for anyone who still wants a container. Same pinned setup either way.
ENV DATA_DIR=/mnt/duino-data \
    HOST=0.0.0.0 \
    PORT=3030

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 python3-serial \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home duino \
  && mkdir -p /mnt/duino-data && chown duino:duino /mnt/duino-data

WORKDIR /home/duino/app
COPY --chown=duino:duino package*.json ./
USER duino
RUN npm ci --omit=dev

COPY --chown=duino:duino setup ./setup
COPY --chown=duino:duino src ./src
ARG CORES
RUN CORES=$CORES npm run setup

EXPOSE 3030
CMD [ "node", "src/index.js" ]
