# syntax=docker/dockerfile:1
# The build runs once, on the build machine's own platform; Next.js's standalone output is plain
# JavaScript, so the same files serve amd64 and arm64.
FROM --platform=$BUILDPLATFORM node:26.13.1-alpine AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# The last stage has no RUN, so buildx assembles each platform's image without emulating it.
FROM node:26.13.1-alpine
LABEL org.opencontainers.image.source=https://github.com/kitecorp/netatlas
LABEL org.opencontainers.image.licenses=Apache-2.0
LABEL org.opencontainers.image.description="See the network policies of several Kubernetes clusters from one place."
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0
COPY --from=build --chown=node:node /app/.next/standalone ./
COPY --from=build --chown=node:node /app/.next/static ./.next/static
# The image's node user, by number, so a kubelet can check runAsNonRoot.
USER 1000:1000
EXPOSE 3000
CMD ["node", "server.js"]
