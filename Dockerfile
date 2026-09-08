FROM node:20-bookworm-slim

WORKDIR /app
# qrcode 为纯 JS 实现（pngjs 出图），无原生依赖，无需 python/make/g++
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

ENV NODE_ENV=production
ENV SCAN_GATEWAY_HOST=0.0.0.0
ENV SCAN_GATEWAY_PORT=3101

EXPOSE 3101
CMD ["node", "src/index.js"]
