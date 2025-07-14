#!/usr/bin/env bash

# Function to handle shutdown
cleanup() {
    echo "Shutting down gracefully..."
    if [[ -n $PID ]]; then
        kill -TERM "$PID" 2>/dev/null
        wait "$PID"
    fi
    exit $?
}

# Set up signal handlers
trap cleanup TERM INT

echo -e "\033[32m[launching TURN Synchronizer...]\033[0m"
clear

# Start the Node.js process
tsx ./src/CloudBridge.js "$@"
PID=$!

# Wait for the process to complete
wait $PID
EXIT_STATUS=$?

# Clean up and exit
trap - TERM INT
exit $EXIT_STATUS