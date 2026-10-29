# Stage 1: build the React app
FROM node:22-alpine AS build

WORKDIR /build

COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY frontend/ ./
RUN npm run build

# Stage 2: serve the static build and proxy /api
FROM nginx:1.27-alpine

COPY nginx/nginx.conf /etc/nginx/nginx.conf
# The official image renders *.template files with the container's environment variables at start-up.
COPY nginx/templates/ /etc/nginx/templates/
COPY --from=build /build/dist /usr/share/nginx/html

# Defaults suit a single person on a laptop. Raise them (see README) for load tests from one machine.
ENV NGINX_RATE_CHECKOUT=5r/s \
    NGINX_BURST_CHECKOUT=10 \
    NGINX_RATE_STATUS=10r/s \
    NGINX_BURST_STATUS=20 \
    NGINX_RATE_API=20r/s \
    NGINX_BURST_API=40 \
    NGINX_MAX_CONN_PER_IP=100

EXPOSE 80
