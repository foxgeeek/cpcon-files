FROM node:20-alpine

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.js ./

# Volume onde os arquivos ficam persistidos
VOLUME ["/uploads"]

EXPOSE 80

CMD ["node", "server.js"]
