FROM node:22-alpine
WORKDIR /app
COPY package.json server.js ./
COPY public ./public
COPY tools/mock-tsa.js ./tools/mock-tsa.js
ENV PORT=8080 HOST=0.0.0.0 TRUST_PROXY=1
EXPOSE 8080
USER node
HEALTHCHECK CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "server.js"]
