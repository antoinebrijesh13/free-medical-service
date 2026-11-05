FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.js ./
COPY public ./public
ENV DATA_DIR=/data NODE_ENV=production PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node", "server.js"]
