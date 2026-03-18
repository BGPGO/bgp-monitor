FROM node:20-alpine
WORKDIR /app
COPY server.js .
COPY package.json .
# Force rebuild: v5
EXPOSE 3000
CMD ["node", "server.js"]
