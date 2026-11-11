# syntax=docker/dockerfile:1
# Profile ingest proxy (full telemetry profile). Build context: ./platformctl
#   docker build -f platformctl/profile-ingest/Dockerfile platformctl
FROM golang:1.26.11 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY internal/profileproxy ./internal/profileproxy
COPY profile-ingest ./profile-ingest
ARG TARGETOS
ARG TARGETARCH
RUN CGO_ENABLED=0 GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /out/profile-ingest ./profile-ingest

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/profile-ingest /profile-ingest
USER 65532:65532
EXPOSE 8080 8081
ENTRYPOINT ["/profile-ingest"]
