#!/usr/bin/env bash

set -u

printf '%s\n' '------------------------------------'
printf '%s\n' 'Phantom Bridge Registration Utility'
printf '%s\n' '(c) 2026 Phantom Cybernetics Inc.'
printf '%s\n' 'https://www.phantomcybernetics.com'
printf '%s\n' '------------------------------------'
printf '\n'

# robot or app selection
while true; do
    printf 'Register a new ROS2 (R)obot or a Bridge (A)pp? [R]: '
    IFS= read -r choice < /dev/tty || exit 1
    choice=${choice:-R}
    choice=$(printf '%s' "$choice" | tr '[:lower:]' '[:upper:]')
    case "$choice" in
    R)
      kind="robot"
      break
      ;;
    A)
      kind="app"
      break
      ;;
    *)
      printf '%s\n' "Invalid selection. Please enter R or A."
      printf '\n'
      ;;
    esac
done

# name prompt
if [ "$kind" = "robot" ]; then
    while true; do
        printf 'Robot Name [Unnamed Robot]: '
        default_file_name="phntm_bridge.yaml"
        IFS= read -r name < /dev/tty || exit 1
        name=${name:-Unnamed Robot}
        [ -n "$name" ] && break
    done
else
    while true; do
        printf 'App Name [Unnamed App]: '
        default_file_name="app_config.json"
        IFS= read -r name < /dev/tty || exit 1
        name=${name:-Unnamed App}
        [ -n "$name" ] && break
    done
fi

# e-mail prompt (no default, required)
while true; do
    printf "Maintainer's e-mail (required): "
    IFS= read -r email < /dev/tty || exit 1
    [ -n "$email" ] && break
done

# config file name
while true; do
    printf "Write configuration to file [$default_file_name]: "
    IFS= read -r config_name < /dev/tty || exit 1
    config_name=${config_name:-$default_file_name}
    
    if [ -f "$config_name" ]; then
        while true; do
            printf "File '%s' already exists. Overwrite? (Y)/(N) [N]: " "$config_name"
            IFS= read -r overwrite < /dev/tty || exit 1
            overwrite=${overwrite:-n}              # default to n if empty
            overwrite=$(printf '%s' "$overwrite" | tr '[:upper:]' '[:lower:]')

            case "$overwrite" in
                y)
                    break 2   # break out of both loops
                ;;
                n)
                    break     # go back to file name prompt
                ;;
                *)
                    printf '%s\n' "Invalid selection. Please enter Y or N."
                    printf '\n'
                ;;
            esac
        done
    else
        break # file doesn't exist, no need to ask
    fi
done

while true; do
    printf 'Server to use [register.phntm.io]: '
    IFS= read -r reg_server < /dev/tty || exit 1
    reg_server=${reg_server:-register.phntm.io}
    [ -n "$reg_server" ] && break
done

printf '\n'
printf '%s\n' "Working..."

case "$kind" in
    robot)
        reg_url="https://$reg_server/register/robot"
        ;;
    app)
        reg_url="https://$reg_server/register/app"
        
        ;;
esac

response=$(curl -sS -w "%{http_code}" -X POST \
  --data-urlencode "name=$name" \
  --data-urlencode "maintainer_email=$email" \
  "$reg_url") || {
  printf '%s\n' "Network or HTTP request failed."
  exit 1
}

# extract status code (last 3 characters)
http_code="${response: -3}"
# extract response body (everything except last 3 chars)
response_body="${response%???}"

printf '\n'

# Check if status code is 200
if [[ $http_code -eq 200 ]]; then
  printf '%s\n' "Registration successful!"
  case "$kind" in
    robot)
        printf '%s\n' "Saving generated configuration to: $config_name (feel free to edit this file)"
        printf '%s\n' "$response_body" > "$config_name"
        ui_url=$(sed -n '6s/^## //p' $config_name)
        printf '%s\n' "All done, your robot will be available at: $ui_url"
        ;;
    app)
        printf '%s\n' "Saving generated configuration to: $config_name"
        printf '%s\n' "$response_body" > "$config_name"
        printf '%s\n' "All done."
        ;;
    esac
else
  printf '%s\n' "Registration failed!"
  printf '%s\n' "$response_body"
  exit 1
fi