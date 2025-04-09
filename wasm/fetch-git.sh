#!/bin/sh
set -e

fetch() {
    TARGET_DIR="$1"
    PREVIOUS_DIR="$(pwd)"
    URL="$2"
    REV="$3"
    
    if [ -d "$TARGET_DIR/.git" ]
    then
        cd "$TARGET_DIR"
    else
        mkdir -p "$TARGET_DIR"
        cd "$TARGET_DIR"
        git init
        git remote add origin "$URL"
    fi

    LOCAL_REV="$(git rev-parse HEAD 2> /dev/null || true)"

    if [ "$REV" != "$LOCAL_REV" ]
    then
        echo "Fetching thirdparty source for $TARGET_DIR from $URL ($REV) ..."
        git fetch origin "$REV" && \
        git reset --hard FETCH_HEAD
        echo "Done."
    fi
    
    cd "$PREVIOUS_DIR"
}



