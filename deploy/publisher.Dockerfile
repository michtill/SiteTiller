FROM node:24-alpine
RUN apk add --no-cache git php83 php83-curl && ln -sf /usr/bin/php83 /usr/bin/php
RUN mkdir /production && chown 1000:1000 /production
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY deploy ./deploy
COPY public ./public
USER 1000:1000
CMD ["node", "src/publisher.ts"]
