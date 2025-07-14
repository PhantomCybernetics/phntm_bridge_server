#!/usr/bin/env bash

echo -e "\033[32m[launching TURN Synchronizer...]\033[0m"
bun ./src/SyncTURNCredentials.js "$@"
