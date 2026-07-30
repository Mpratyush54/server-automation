# Build JS on the native builder arch. Angular/esbuild crashes under QEMU
# (linux/arm64 on amd64 runners → "Illegal instruction" / deadlock).
# The dist output is arch-independent; only the runtime image is multi-arch.
FROM --platform=$BUILDPLATFORM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist/portal/browser /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
