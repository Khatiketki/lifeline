# One-off migration image for managed Postgres (RDS doesn't run
# docker-entrypoint-initdb.d). Run as an ECS task; see scripts/deploy-aws.sh.
FROM postgres:16-alpine
COPY init /migrations
COPY migrate.sh /usr/local/bin/migrate.sh
RUN chmod +x /usr/local/bin/migrate.sh
ENTRYPOINT ["/usr/local/bin/migrate.sh"]
