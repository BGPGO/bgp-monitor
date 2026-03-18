FROM node:20-alpine
WORKDIR /app
COPY server.js .
COPY package.json .
# Force rebuild: v6
EXPOSE 3000
CMD ["node", "server.js"]
