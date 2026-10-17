# Next.js standalone build. Context = REPO ROOT (not frontend/): the app
# imports the shared access layer at ../../..//src/db (queries + client), so
# the builder needs frontend/ and src/db as siblings — same layout as the
# repo. Server code is webpack-bundled at build time, so the runtime image
# needs only the standalone output.
FROM node:24-bookworm-slim AS deps
WORKDIR /app/frontend
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install

FROM node:24-bookworm-slim AS build
WORKDIR /app/frontend
COPY --from=deps /app/frontend/node_modules ./node_modules
COPY frontend/ ./
COPY src/db/ /app/src/db/
RUN ln -s /app/frontend/node_modules /app/node_modules # bare imports (pg) in src/db resolve via the ancestor walk
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:24-bookworm-slim AS run
WORKDIR /app/frontend
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
COPY --from=build /app/frontend/.next/standalone ./
COPY --from=build /app/frontend/.next/static ./.next/static
COPY --from=build /app/frontend/public ./public
USER node
EXPOSE 3000
CMD ["node", "server.js"]
