FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM nginx:1.27-alpine
# The nginx image runs envsubst over /etc/nginx/templates at startup, so the
# API upstream can differ between docker compose and ECS (Cloud Map DNS).
ENV API_UPSTREAM=core-api:4000
COPY nginx.conf /etc/nginx/templates/default.conf.template
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
