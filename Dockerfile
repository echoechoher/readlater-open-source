FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile

COPY server.mjs ./
COPY lib ./lib
COPY extension/content-normalization.js ./extension/content-normalization.js
COPY public ./public
COPY scripts ./scripts
COPY prompts ./prompts

EXPOSE 3000
CMD ["node", "server.mjs"]
