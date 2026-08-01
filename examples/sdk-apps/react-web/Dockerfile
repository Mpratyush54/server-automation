# Build from repo root:
#   docker build -f examples/sdk-apps/react-web/Dockerfile --build-arg VITE_API_URL=https://... -t sdk-react-web:local .
FROM node:20-alpine AS build
WORKDIR /app
COPY examples/sdk-apps/react-web/package*.json ./
RUN npm install
COPY examples/sdk-apps/react-web/ ./
ARG VITE_API_URL=
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM nginx:alpine
COPY examples/sdk-apps/react-web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
