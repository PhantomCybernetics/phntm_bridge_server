#!/usr/bin/env bash

echo -e "\033[32m[Registering new robot...]\033[0m"
bun ./exe/Register.ts "$@"
