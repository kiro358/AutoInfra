FROM node:20-alpine AS base

# Install dependencies
FROM base AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app/webapp

COPY webapp/package.json webapp/package-lock.json* ./
RUN npm ci

# Build
FROM base AS builder
WORKDIR /app

# Copy templates (needed at build time for path resolution)
COPY empty_templates ./empty_templates

# Copy webapp source
COPY webapp ./webapp
COPY --from=deps /app/webapp/node_modules ./webapp/node_modules

WORKDIR /app/webapp
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN npm run build

# Production image
FROM base AS runner
WORKDIR /app/webapp

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 nextjs

# Copy the empty templates (with correct ownership)
COPY --from=builder --chown=nextjs:nodejs /app/empty_templates /app/empty_templates

# Copy Next.js standalone build
COPY --from=builder --chown=nextjs:nodejs /app/webapp/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/webapp/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/webapp/.next/static ./.next/static

# Create writable dirs for uploads and outputs
RUN mkdir -p /app/webapp/uploads /app/webapp/outputs && \
    chown -R nextjs:nodejs /app/webapp/uploads /app/webapp/outputs

USER nextjs

EXPOSE 8080
ENV PORT=8080
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
