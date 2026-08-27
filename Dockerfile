# Zero dependencies, so the image is just node plus the source.
FROM node:20-alpine

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY site ./site
COPY config.json ./

RUN mkdir -p data ads-drop docs

ENV INTERVAL_MINUTES=5
CMD ["node", "src/loop.mjs"]
