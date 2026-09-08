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
# Edge only: BROWSER_CHANNEL=msedge in .env (Teams sometimes blocks vanilla
# Chromium). If you ever switch the channel to chromium, re-add its install
# here — otherwise the launch will fail with "browser not found".
# Then: purge packages --with-deps drags in via recommend-chains but nothing
# uses at runtime (C compiler, theorem prover, TTS, icon themes…), and strip
# Edge locale packs (keep en-*) — saves ~350MB uncompressed.
RUN npm install --omit=dev \
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
