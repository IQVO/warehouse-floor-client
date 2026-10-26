# syntax=docker/dockerfile:1.7
#
# warehouse-floor-client depends on @warehouse/ui-kit via `file:../warehouse-ui-kit`
# (a sibling checkout, not a registry package -- see package.json). Build with:
#   docker build --build-context uikit=../warehouse-ui-kit -t warehouse-floor-client .
# (or `make image`). Same approach, and same reasons, as warehouse-console's Dockerfile:
#
# - node:26-bookworm-slim (glibc), not alpine: the platform-specific optional
#   dependencies of Vite 8 / oxlint publish *-gnu bindings.
# - The lockfile is generated on macOS and carries no linux optional entries,
#   so the image resolves with `npm install --no-save` and discards the lockfile
#   inside the throwaway build layer. The committed lockfile is never mutated.

# --- ui-kit build stage (sibling dependency) ---
FROM node:26-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe AS uikit-build
WORKDIR /uikit
COPY --from=uikit . .
RUN --mount=type=cache,target=/root/.npm \
    rm -rf node_modules package-lock.json && npm install --no-save && npm run build

# --- app build stage ---
FROM node:26-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe AS build
WORKDIR /workspace/warehouse-ui-kit
COPY --from=uikit-build /uikit/package.json ./package.json
COPY --from=uikit-build /uikit/dist ./dist

WORKDIR /workspace/warehouse-floor-client
COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm install --no-save
COPY . .
RUN rm -f package-lock.json
RUN npm run build

# --- runtime stage ---
FROM nginxinc/nginx-unprivileged:1.31-alpine@sha256:26b0bf6fbf07297983cb341998d79c831508787de26627dd2a112321b9c3a4af
# Same CVE pins as warehouse-console's runtime stage (they bust the cached
# `apk upgrade` layer so the fixed packages are installed).
USER root
RUN apk upgrade --no-cache && apk add --no-cache 'libexpat>=2.9.0-r0' 'pcre2>=10.49-r0' 'tiff>=4.7.2-r0' 'libx11>=1.8.14-r0'
USER nginx
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build --chown=nginx:nginx /workspace/warehouse-floor-client/dist /usr/share/nginx/html
EXPOSE 8080
