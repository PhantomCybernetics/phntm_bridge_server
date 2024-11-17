# Phantom Cloud Bridge

This server facilitates WebRTC P2P connection between a Phantom Bridge node running on a robot, and the Bridge Web UI, or any similar clients using this API.

The server keeps a database of App and Robot IDs and their security keys. It offers API for both new Robot and App registration. This server also perfomrs some basic loggig of both robot and peer apps utilization withour recording any peer communication.

Cloud Bridge also relies messages between peers using Socket.io when reliability is required, such as in the case of WebRTC signalling, robot introspection results, and ROS service calls. By design, the fast WebRTC communication entirely bypasses this server and only uses a TURN server when P2P connection is not possible. See TURN Server below.

This server also parses the ROS .idl files for all message and service types discovered on the robot by phntm_bridge. These are converted to JSON and pushed into peers such as the Phntm WEB UI, making consistent bi-directional message serialization and deserialization possible. Message definitions are loaded fresh on every robot connection, and cached in memory for the time robot remains connected.

Cloud bridge also forwards files requested by a peer App (such as the Phntm WEB UI) and served by phntm_bridge from the robot's filesystem. This is very useful for instance for extracting robot's URFF model components, such as meshes, textures and materials. These files are chached on this server in /file_fw_cache for faster replies that don't repeatedly exhaust robot's network connectivity.

# Install Docker
### Install Docker & Docker Compose
```bash
sudo apt install docker docker-buildx docker-compose-v2
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

### Build the Docker Image
```bash
cd ~
wget https://raw.githubusercontent.com/PhantomCybernetics/cloud_bridge/main/dev.Dockerfile -O cloud-bridge.Dockerfile
docker build -f cloud-bridge.Dockerfile -t phntm/cloud-bridge:latest .
```

### Create a Config File
Create a new config file `vim ~/cloud_bridge_config.jsonc` and paste:
```jsonc
{
  "dbUrl": "mongodb://172.17.0.1:27017", // on Linux; use "mongodb://host.docker.internal:27017" on Mac
  "dieOnException": true,

  "BRIDGE": {
      "ssl": {
          // certificates need to be exposed to the docker container
          // use certbot or the ssl/gen.sh script for self signed dev certificates
          "private": "/ssl/private.pem",
          "public": "/ssl/public.crt"
      },
      "sioPort": 1337, # socket.io port of this server
      "address": "https://bridge.phntm.io", # address of this server
      "uiAddressPrefix": "https://bridge.phntm.io/", # full prefix for UI links
      
      "admin": { // credentials required for password-protected APIs here
      "username": "admin",
      "password": "**********"
    },
  }
}
```

### Add Cloud Bridge Service to Your compose.yaml
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
    volumes:
      - /etc/letsencrypt:/ssl
      - ~/cloud_bridge_config.jsonc:/phntm_cloud_bridge/config.jsonc
    command:
      [  /bin/sh,  /phntm_cloud_bridge/run.cloud-bridge.sh ]
```

### Launch
```bash
docker compose up phntm_cloud_bridge
```

# Dev mode
Dev mode maps live git repo on the host machine to the container so that you can make changes more conventinetly. First clone this repo...
```bash
cd ~
git clone git@github.com:PhantomCybernetics/cloud_bridge.git cloud_bridge
```
Then make the following changes to your Docker Compose service in compose.yaml:
```yaml
services:
  phntm_cloud_bridge:
    volumes:
      - ~/cloud_bridge:/phntm_cloud_bridge
    command:
      /bin/sh -c "while sleep 1000; do :; done" # in case you want to start/stop the server manually
```

Launch server manually for better developer experience:
```bash
docker compose up phntm_cloud_bridge -d
docker exec -it phntm-cloud-bridge bash
cd /phntm_cloud_bridge
npm install # necessary on the first run from new source!
./run.cloud-bridge.sh
```

# REST API

### Registering a New Robot

Fetching https://bridge.phntm.io:1337/robot/register?yaml registers a new robot and returns a default configuration YAML file for your phntm_bridge. This uses robot_config.templ.yaml as a template. 

Calling https://bridge.phntm.io:1337/robot/register?json also registers a new robot, but returns a JSON.

### Registering a New App

Fetching https://bridge.phntm.io:1337/app/register registers a new App on this server and returns a JSON with generated app id and a secret key. Phntm Web UI forks and other services using this API are considered individual apps and need to refister first

### Server Status

https://bridge.phntm.io:1337/info (protected via admin password)
Provides various statistical information about the server utilization.

# TURN Server
Phntm Cloud Bridge needs to be accompanied by a TURN server which provides a backup connectivity when P2P link is not available between peers, such as owhen teleoperating a robot from a different network. This can be installed on a separate machine with a public IP and load-balanced independently.

# Install Coturn
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

Run coturn:
```bash
sudo systemctl start coturn
sudo systemctl enable coturn # start on boot
```
