# Phantom Cloud Bridge

This server facilitates WebRTC P2P connection between a Phantom Bridge node running on a robot, and the Bridge Web UI, or any similar clients using this API.

The server keeps a database of App and Robot IDs and their security keys. It offers API for both new Robot and App registration. This server also perfomrs some basic loggig of both robot and peer apps utilization withour recording any peer communication.

Cloud Bridge also relies messages between peers using Socket.io when reliability is required, such as in the case of WebRTC signalling, robot introspection results, and ROS service calls. By design, the fast WebRTC communication entirely bypasses this server and only uses a TURN server when P2P connection is not possible. See TURN Server below.

The server also parses and caches the ROS .idl files for all message and service types discovered on the robot by phntm_bridge. These are converted to JSON and pushed into peers such as the Phntm WEB UI, making consistent bi-directional message serialization and deserialization possible. Message definitions are loaded fresh on every robot connection, and cached in memory for the time robot remains connected.

Cloud bridge also forwards files requested by a peer App (UI) from the robot's filesystem. This is very useful for instance for extracting robot's URFF model components, such as meshes, textures and materials. These files are chached here in /file_fw_cache for faster replies that don't repeatedly exhaust robot's network connectivity.

![Infrastructure map](https://raw.githubusercontent.com/PhantomCybernetics/phntm_bridge_docs/refs/heads/main/img/Architecture_Cloud_Bridge.png)

## Install Cloud Bridge

### Install Docker, Docker Build & Docker Compose
```bash
sudo apt install docker docker-buildx docker-compose-v2
```
Then add the current user to the docker group:
```bash
sudo usermod -aG docker ${USER}
# log out & back in
```

### Install MongoDB
```bash
sudo apt-get install gnupg curl
curl -fsSL https://pgp.mongodb.com/server-7.0.asc | sudo gpg -o /usr/share/keyrings/mongodb-server-7.0.gpg --dearmor
echo "deb [ arch=amd64,arm64 signed-by=/usr/share/keyrings/mongodb-server-7.0.gpg ] https://repo.mongodb.org/apt/ubuntu jammy/mongodb-org/7.0 multiverse" | sudo tee /etc/apt/sources.list.d/mongodb-org-7.0.list
sudo apt-get update
sudo apt-get install -y mongodb-org

# on linux, edit /etc/mongod.conf:
net:
  port: 27017
  bindIp: 127.0.0.1,172.17.0.1

sudo systemctl start mongod
sudo systemctl enable mongod # run at boot
```

### Clone this repo and build the Docker Image
```bash
cd ~
git clone git@github.com:PhantomCybernetics/cloud_bridge.git cloud_bridge
cd cloud_bridge
docker build -f Dockerfile -t phntm/cloud-bridge:latest .
```

### Create a config file
Create a new config file e.g. `~/cloud_bridge_config.jsonc` and paste:
```jsonc
{
  "dbUrl": "mongodb://172.17.0.1:27017", // on Linux; use "mongodb://host.docker.internal:27017" on Mac
  "dieOnException": true,

  "BRIDGE": {
      "ssl": {
          // certificates need to be exposed to the docker container
          // use certbot or the ssl/gen.sh script for self signed dev certificates
          "private": "/ssl/private.pem",
          "public": "/ssl/fullchain.crt"
      },
      "admin": { // credentials required for password-protected APIs here
            "username": "ADMIN_USER",
            "password": "ADMIN_PASS"
      },

      "sioPort": 1337, // socket.io port of this server
      "address": "https://bridge.phntm.io", // address of this server
      "uiAddressPrefix": "https://bridge.phntm.io/", // full prefix for robot UI links (ROBOT_ID will be appended)
      
      "verbose": false,
      "keepSessionsLoadedForMs": 30000, // keep 30s after robot disconnects, then unload

      "defaultMaintainerEmail": "robot.master@domain.com",

      "filesPort": 1338, // file extractor port
      "filesCacheDir": "/file_fw_cache" // client file will be cached here
  }
}
```

### Add Cloud Bridge service to your compose.yaml
```yaml
services:
  phntm_cloud_bridge:
    image: phntm/cloud-bridge:latest
    container_name: phntm-cloud-bridge
    hostname: phntm-cloud-bridge.local
    restart: unless-stopped
    privileged: true
    environment:
      - TERM=xterm
    ports:
      - 1337:1337
      - 1338:1338
    volumes:
      - /etc/letsencrypt:/ssl
      - ~/cloud_bridge_config.jsonc:/phntm_cloud_bridge/config.jsonc # config goes here
      - ~/file_fw_cache/:/file_fw_cache/ # client files are cached here
    command:
      [  /bin/sh,  /phntm_cloud_bridge/run.cloud-bridge.sh ]
```
Note that in this cofiguration, ports 1337 and 1338 must be open to inboud TCP traffic!

### Launch
```bash
docker compose up phntm_cloud_bridge
```

## REST API

### Registering a new Robot

Fetching https://bridge.phntm.io:1337/robot/register?yaml registers a new robot and returns a default configuration YAML file for your phntm_bridge. This uses robot_config.templ.yaml as a template. 

Calling https://bridge.phntm.io:1337/robot/register?json also registers a new robot, but returns a JSON.

### Registering a new App

Fetching https://bridge.phntm.io:1337/app/register registers a new App on this server and returns a JSON with generated app id and a secret key. Phntm Web UI forks and other services using this API are considered individual apps and need to refister first

### Server status

https://bridge.phntm.io:1337/info (protected with admin password) \
Provides various statistical information about the server utilization.

## TURN/STUN Server
Phntm Cloud Bridge needs to be accompanied by a TURN server which provides a backup connectivity when P2P link is not available between peers, such as when teleoperating a robot from a different network. This can be installed on a separate machine with a public IP and load-balanced independently.

### Install Coturn
Coturn is a popular open-source TURN server, more at https://github.com/coturn/coturn

```bash
sudo apt-get -y install coturn
sudo vim /etc/default/coturn
# TURNSERVER_ENABLED=1

sudo cp /etc/turnserver.conf /etc/turnserver.conf.bak
sudo vim /etc/turnserver.conf
```

Paste this:
```conf
listening-port=3478
tls-listening-port=5349
alt-listening-port=3479
alt-tls-listening-port=5350
external-ip=54.67.121.238/172.31.11.252
min-port=32355
max-port=65535
server-name=turn.phntm.io
# TODO: these will be appId:key, robotId:key pairs from Mongo
user=robo:pass
user=app:pass
realm=phntm.io
cert=/path/to/cert.pem
pkey=/path/to/privkey.pem
cipher-list="DEFAULT"
ec-curve-name=prime256v1
log-file=/var/tmp/turn.log
cli-password=*CLI_PASS*
```

Note that in this cofiguration, the following ports must be open to inboud traffic:
```
TCP	5349-5350
UDP	3478-3479
UDP	32355-65535
```

### Run coturn:
```bash
sudo systemctl start coturn
sudo systemctl enable coturn # start on boot
```
