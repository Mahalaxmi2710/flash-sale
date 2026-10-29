FROM node:22-alpine AS deps
WORKDIR /app
COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY backend/package.json ./package.json
COPY backend/src ./src
COPY db/migrations ./db/migrations
USER node
EXPOSE 3000
CMD ["node", "src/api/server.js"]