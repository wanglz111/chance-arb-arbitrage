FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY viewer ./viewer
COPY README.md architect.md session.md ./
COPY .env.example ./

RUN npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/viewer ./viewer
COPY --from=builder /app/README.md ./README.md
COPY --from=builder /app/.env.example ./.env.example

RUN mkdir -p /app/data

CMD ["node", "dist/src/index.js"]
