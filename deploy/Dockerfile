# auto-school backend container.
# Headful Chromium under Xvfb + PulseAudio null sink for tab-audio capture.
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb ffmpeg pulseaudio pulseaudio-utils \
      fonts-liberation fonts-noto-color-emoji \
      tini procps ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# browsers land in a shared location (installed as root during build, run as node)
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json ./
# deps layer (cached unless package.json changes); --with-deps pulls system libs.
# Edge too: .env may set BROWSER_CHANNEL=msedge (Teams sometimes blocks
# vanilla Chromium) — install both so the env choice works in-container.
RUN npm install --omit=dev \
 && npx playwright install --with-deps chromium \
 && npx playwright install --with-deps msedge \
 && rm -rf /var/lib/apt/lists/*

COPY . .
RUN chmod +x deploy/entrypoint.sh

# writable data root — mount a PVC here (profile, notes, segments, out/)
ENV NODE_ENV=production \
    AUTO_SCHOOL_DATA=/data \
    USER_DATA_DIR=/data/user-data \
    CHROMIUM_SANDBOX=0 \
    DISPLAY=:99 \
    TZ=America/Toronto
RUN mkdir -p /data /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix && chown node:node /data

USER node
ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/entrypoint.sh"]
CMD ["node", "src/index.ts", "daemon"]
