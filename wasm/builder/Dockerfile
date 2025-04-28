FROM node:20

WORKDIR /

# Install python, ninja and cmake
RUN apt-get update && apt-get install -y python3 git cmake ninja-build

# Install emsdk
RUN git config --global init.defaultBranch main
RUN git clone https://github.com/emscripten-core/emsdk.git
WORKDIR /emsdk
ENV EMSDK_VERSION=3.1.14
ENV EMSDK=/emsdk
RUN ./emsdk install "$EMSDK_VERSION" && ./emsdk activate "$EMSDK_VERSION"

ENV HOST_C_COMPILER=/emsdk/upstream/bin/clang
ENV HOST_CXX_COMPILER=/emsdk/upstream/bin/clang++

WORKDIR /

# Install rust
RUN curl https://sh.rustup.rs -sSf | bash -s -- -y
RUN /root/.cargo/bin/rustup target add wasm32-wasip1 wasm32-unknown-unknown
ENV PATH="/root/.cargo/bin:${PATH}"

# Install global node modules
RUN npm i -g js-yaml@4.1.0
ENV NODE_PATH="/usr/local/lib/node_modules"

WORKDIR /wasm

ENTRYPOINT [ "/bin/sh", "build.sh" ]