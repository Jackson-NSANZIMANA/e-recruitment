FROM node:24-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY server.js ./
RUN mkdir -p /app/data
EXPOSE 3103
CMD ["node", "server.js"]
