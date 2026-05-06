FROM node:22-alpine AS base

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/tsconfig/package.json packages/tsconfig/package.json
COPY packages/tsconfig packages/tsconfig
COPY packages/modal-helper/package.json packages/modal-helper/package.json

RUN pnpm install --filter @extension/modal-helper... --frozen-lockfile --ignore-scripts

COPY packages/modal-helper packages/modal-helper

RUN pnpm --filter @extension/modal-helper build

EXPOSE 5477

CMD ["node", "packages/modal-helper/dist/index.js"]
