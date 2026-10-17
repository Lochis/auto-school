# auto-school backend container.
# Headful Chromium under Xvfb + PulseAudio null sink for tab-audio capture.
FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      xvfb ffmpeg pulseaudio pulseaudio-utils poppler-utils \
      fonts-liberation fonts-noto-color-emoji \
      tini procps ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# browsers land in a shared location (installed as root during build, run as node).
# Edge browser install is hoisted ABOVE package.json with a pinned playwright
# version — dependency changes must never invalidate the ~1.4GB browser layer
# (learned 2026-10-16: a dep bump forced every node to re-pull the whole layer).
# Keep this version in sync with package.json's playwright when bumping.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN npx -y playwright@1.63.0 install --with-deps msedge \
 && rm -rf /var/lib/apt/lists/*
# Edge only: BROWSER_CHANNEL=msedge in .env (Teams sometimes blocks vanilla
# Chromium). If you ever switch the channel to chromium, re-add its install
# here — otherwise the launch will fail with "browser not found".
COPY package.json ./
# deps layer (cached unless package.json changes). Runtime-only deps; the
# playwright npm package itself never downloads browsers (already in /ms-playwright).
RUN npm install --omit=dev

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
