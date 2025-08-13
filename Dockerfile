# Stage 1: Build the frontend
FROM node:20-alpine AS frontend
RUN npm install -g bun
WORKDIR /app/frontend
COPY frontend/package.json frontend/bun.lock* ./
RUN bun install
COPY frontend/ ./
RUN bun run build

# Stage 2: Build the backend
FROM golang:1.22-alpine AS backend
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
