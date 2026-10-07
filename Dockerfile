FROM node:24-alpine AS studio
RUN apk add --no-cache git chromium && mkdir /data && chown node:node /data
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node pnpm-lock.yaml ./
RUN npm install -g pnpm@11.19.0 && pnpm install --prod --frozen-lockfile --ignore-scripts
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node seed ./seed
USER node
ENV HOST=0.0.0.0 PORT=8080 SITETILLER_DATA_DIR=/data SITETILLER_BROWSER_EXECUTABLE=/usr/bin/chromium XDG_CACHE_HOME=/tmp/sitetiller-cache XDG_CONFIG_HOME=/tmp/sitetiller-config
EXPOSE 8080
CMD ["node", "src/server.ts"]
