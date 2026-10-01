# 基础镜像自带 Node 20 + Playwright 依赖 + 预装浏览器（版本需与 package.json 中 playwright 一致）
FROM mcr.microsoft.com/playwright:v1.63.0-noble

WORKDIR /app

# 先装依赖以利用层缓存
COPY package.json package-lock.json ./
RUN npm ci

COPY src ./src
COPY config.example.json ./

# 数据与登录态通过卷挂载持久化；浏览器已在镜像内，无需再 install
ENV NODE_ENV=production

EXPOSE 8787

CMD ["node", "src/index.js", "run"]
