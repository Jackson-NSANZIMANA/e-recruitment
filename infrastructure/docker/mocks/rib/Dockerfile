FROM node:24-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY server.js ./
RUN mkdir -p /app/data
EXPOSE 3102
CMD ["node", "server.js"]
