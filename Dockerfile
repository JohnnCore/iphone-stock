FROM node:20-alpine

WORKDIR /app
COPY stock-bot.js ./

# Sem dependências externas — só a lib padrão do Node (fetch incluído).
USER node
ENTRYPOINT ["node", "stock-bot.js"]
