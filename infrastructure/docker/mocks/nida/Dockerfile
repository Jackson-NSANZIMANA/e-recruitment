FROM node:24-alpine
WORKDIR /app
COPY package.json ./
RUN npm install
COPY server.js ./
# Data directory is NOT copied here
# It is mounted as a volume from the host at runtime
# This allows data updates without rebuilding the image
RUN mkdir -p /app/data
EXPOSE 3100
CMD ["node", "server.js"]
