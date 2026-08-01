# Build from repo root:
#   docker build -f examples/sdk-apps/node-api/Dockerfile -t sdk-node-api:local .
FROM node:20-alpine AS sdk
WORKDIR /src
COPY sdk-node/package*.json ./sdk-node/
RUN cd sdk-node && npm install
COPY sdk-node ./sdk-node
RUN cd sdk-node && npm run build && npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
COPY --from=sdk /src/sdk-node /sdk-node
COPY examples/sdk-apps/node-api/package.json ./
RUN npm pkg set dependencies.@mpratyush54/sdk-node=file:/sdk-node \
  && npm install --omit=dev
COPY examples/sdk-apps/node-api/src ./src
ENV PORT=4100
EXPOSE 4100
CMD ["node", "src/index.js"]
