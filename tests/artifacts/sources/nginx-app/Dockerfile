FROM nginx:1.25-alpine

ENV APP_ENV=production
ENV LOG_LEVEL=warn
ENV PORT=80

# Custom config + static site
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY html/ /usr/share/nginx/html/

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=3s --retries=3 \
  CMD wget -qO- http://localhost/health || exit 1

CMD ["nginx", "-g", "daemon off;"]
