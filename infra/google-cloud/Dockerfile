FROM node:22-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY app/src/ app/src/
COPY scripts/build-google.mjs scripts/build-google.mjs
RUN node scripts/build-google.mjs
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY --from=build /build/dist/google-cloud/server.cjs ./server.cjs
USER node
CMD ["node", "server.cjs"]
