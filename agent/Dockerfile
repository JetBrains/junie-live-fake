# syntax=docker/dockerfile:1
FROM --platform=linux/amd64 node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM --platform=linux/amd64 node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

FROM --platform=linux/amd64 node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# uid 1000 is the `node` user in this image. The cluster injects runAsNonRoot without
# a uid, so the manifest pins runAsUser explicitly; a non-numeric USER would be
# rejected by the kubelet the same way the attendee image was.
USER 1000
EXPOSE 8080
CMD ["node", "dist/index.js"]
