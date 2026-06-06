# ---- build ----
FROM golang:1.25 AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# CGO off: modernc.org/sqlite is pure Go, so this is a static binary.
RUN CGO_ENABLED=0 go build -buildvcs=false -o /out/abs-stats .

# ---- runtime ----
FROM gcr.io/distroless/static-debian12:nonroot
WORKDIR /app
COPY --from=build /out/abs-stats /app/abs-stats
COPY public/ /app/public/
ENV PORT=8080 DATA_DIR=/data WEB_DIR=/app/public
EXPOSE 8080
VOLUME ["/data"]
# Distroless has no shell/curl, so the binary probes itself (-healthcheck -> GET /healthz).
HEALTHCHECK --interval=2s --timeout=5s --start-period=1s --retries=5 \
  CMD ["/app/abs-stats", "-healthcheck"]
ENTRYPOINT ["/app/abs-stats"]
