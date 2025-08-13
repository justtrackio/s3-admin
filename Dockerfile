# Stage 1: Build the frontend
FROM alpine:latest AS frontend

RUN apk add --no-cache curl unzip bash libstdc++

RUN curl -fsSL https://bun.sh/install | bash

ENV PATH="/root/.bun/bin:$PATH"
WORKDIR /app/frontend
COPY frontend/package.json frontend/bun.lock* ./
RUN bun install
COPY frontend/ ./
RUN bun run build

# Stage 2: Build the backend
FROM golang:1.24.6-alpine AS backend
WORKDIR /app/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -o /app/backend/main .

# Stage 3: Final image
FROM caddy:2-alpine
WORKDIR /app
COPY --from=backend /app/backend/main .
COPY --from=frontend /app/frontend/dist ./frontend/dist
COPY backend/config.yaml .
COPY start.sh .

EXPOSE 8080

CMD ["/app/start.sh"]
