FROM nginx:stable-alpine
COPY site /app/site
COPY nginx.conf /app/nginx.conf
USER 101:101
EXPOSE 8080
ENTRYPOINT ["nginx", "-c", "/app/nginx.conf", "-g", "daemon off;"]
