FROM mcr.microsoft.com/devcontainers/typescript-node:24-bookworm

ARG PIP_INDEX_URL
ARG NPM_CONFIG_REGISTRY

ENV PIP_INDEX_URL=${PIP_INDEX_URL:-https://pypi.org/simple} \
    NPM_CONFIG_REGISTRY=${NPM_CONFIG_REGISTRY:-https://registry.npmjs.org/} \
    POETRY_PYPI_MIRROR_URL=${PIP_INDEX_URL}
