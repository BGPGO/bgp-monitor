FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --production
COPY server.js .
# Force rebuild: v7
EXPOSE 3000
CMD ["node", "server.js"]
