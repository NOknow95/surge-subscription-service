FROM node:22-alpine@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
WORKDIR /app
COPY package.json ./
COPY LICENSE ./
COPY src ./src
COPY public ./public
ENV NODE_ENV=production PORT=3080 DATA_DIR=/data
RUN mkdir /data && chown node:node /data
VOLUME /data
EXPOSE 3080
USER node
CMD ["node", "src/server.js"]
