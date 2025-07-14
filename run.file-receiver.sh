#!/usr/bin/env bash

echo -e "\033[32m[launching File Receiver...]\033[0m"
clear

bun ./src/FileReceiver.ts "$@"
