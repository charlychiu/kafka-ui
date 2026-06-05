# syntax=docker/dockerfile:1
#
# Self-contained multi-stage build: the frontend (React) and backend (Spring Boot)
# are compiled ENTIRELY inside Docker. The host only needs Docker running — no
# JDK / Node / Maven required, so the host's JDK version is irrelevant.
#
#   docker build -t kafka-ui:kafka4 .
# or, with the bundled compose file:
#   docker compose -f docker-compose.kafka4.yml up -d --build
#
# ---------------------------------------------------------------------------
# Build stage — JDK 17 + Maven (the frontend-maven-plugin fetches its own Node).
# ---------------------------------------------------------------------------
FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /build

# Copy the whole project (see .dockerignore for what is excluded) and build the
# executable jar.
#   -Pprod              -> builds the React app and bundles it into the jar
#   -Ddocker.skip       -> skip the in-build fabric8 image (we assemble it below)
#   -Dmaven.test.skip   -> skip tests for a faster, self-contained image build
# The --mount cache keeps the local Maven repo between builds (BuildKit).
COPY . .
RUN --mount=type=cache,target=/root/.m2 \
    mvn -B -Pprod -Dmaven.test.skip=true -Ddocker.skip=true \
        -pl kafka-ui-api -am clean package

# ---------------------------------------------------------------------------
# Runtime stage — slim JRE with just the jar (mirrors the upstream image).
# ---------------------------------------------------------------------------
FROM azul/zulu-openjdk-alpine:17-jre-headless
RUN apk add --no-cache gcompat tzdata \
 && addgroup -S kafkaui && adduser -S kafkaui -G kafkaui \
 && mkdir /etc/kafkaui && chown kafkaui /etc/kafkaui
USER kafkaui

COPY --from=build /build/kafka-ui-api/target/kafka-ui-api-*.jar /kafka-ui-api.jar

ENV JAVA_OPTS=
EXPOSE 8080

# see JmxSslSocketFactory docs for why add-opens is needed
ENTRYPOINT ["sh", "-c", "java --add-opens java.rmi/javax.rmi.ssl=ALL-UNNAMED $JAVA_OPTS -jar kafka-ui-api.jar"]
