#!/bin/bash

echo "Compiling TypeScript..."
./node_modules/typescript/bin/tsc --pretty --allowUnreachableCode -p ./tsconfig/file-receiver.json
CODE=$?;
#echo $CODE    # Exit status 0 returned because command executed successfully.

_term() { 
  echo "Caught SIGTERM signal!" 
  kill -TERM "$child" 2>/dev/null
}

trap _term SIGTERN

if [ $CODE -eq 0 ] ; then
	echo -e "\033[32m[tsc good, launching File Receiver...]\033[0m"
	clear
	trap 'kill -TERM $PID' TERM INT
	node ./build/FileReceiver.js "$@" &
	PID=$!
	wait $PID
	trap - TERM INT
	wait $PID
	EXIT_STATUS=$?
else
	echo -e "\033[41m[TypeScript errors detected, launch cancelled]\033[0m"
fi


