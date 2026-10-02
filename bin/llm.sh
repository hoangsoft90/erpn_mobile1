#!/bin/bash
while true; do
  echo "Expose llm"
  lt -s llm9000 --port 9000
  sleep 1
done
