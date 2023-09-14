FROM node:20

RUN apt update
RUN apt install -y git python3 curl xz-utils build-essential

RUN git clone https://chromium.googlesource.com/chromium/tools/depot_tools.git /depot_tools
ENV PATH="/depot_tools:${PATH}"
RUN update_depot_tools

RUN mkdir /devtools
ENV TAR_OPTIONS="--no-same-owner --no-same-permissions"

# It uses Python's 'tarfile' module to extract which doesn't correctly honor all TAR_OPTIONS and forgets file permissions.
# It *should* use the umask with these TAR_OPTIONS, but it does not, and fails to set +x on the node binary. I tried to
# find a better way to deal with this, but didn't get anywhere. It'll try to continue when we sync later.
RUN cd /devtools && fetch --nohistory devtools-frontend || echo "First failed, chmodding and trying again..."
RUN chmod -R 775 /devtools/devtools-frontend/third_party/node

# Tell gclient to checkout the deps necessary to build the CXX debugging extension
RUN sed -i 's/"custom_deps": {}/"custom_deps": {},"custom_vars":{"checkout_cxx_debugging_extension_deps":True}/' /devtools/.gclient
WORKDIR /devtools/devtools-frontend
RUN gclient sync

# CXX debugging builds a devtools extension, which is browser-based. But we're running this in Node. Update the
# environment for emscripten so it creates the correct bindings.
RUN sed -i 's/ENVIRONMENT=web,worker/ENVIRONMENT=node/' /devtools/devtools-frontend/extensions/cxx_debugging/src/CMakeLists.txt

WORKDIR /devtools/devtools-frontend/extensions/cxx_debugging
RUN ./tools/bootstrap.py -no-check -no-goma ../../out