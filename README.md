# Phantom Cloud Bridge

This server fascilitates WebRTC P2P conenction of a Phantom Bridge node running on a robot, and the Bridge UI app, or similar client using this API.

The server keeps a database of App and Robot IDs and their security keys. It offers API for both new Robot and App registration.

Cloud Bridge also relies messages between peers using Socket.io, when reliability is required, such as in case of WebRTC signalling, introspection results, and ROS service calls. By design, the fast WebRTC communication entirely bypasses this server.

# Install
### Install Docker & Docker Compose
```
sudo apt install docker docker-buildx docker-compose-v2
```

### Install MongoDB
```
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
```
cd ~
wget https://raw.githubusercontent.com/PhantomCybernetics/cloud_bridge/main/dev.Dockerfile -O cloud-bridge.Dockerfile
docker build -f cloud-bridge.Dockerfile -t phntm/cloud-bridge:latest .
```

### Create Config File
Create new config file `nano ~/cloud_bridge_config.jsonc` and paste:
```jsonc
{
    # "dbUrl": "mongodb://host.docker.internal:27017", # Mac
    "dbUrl": "mongodb://172.17.0.1:27017", # Linux
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
        "uiAddressPrefix": "https://bridge.phntm.io/", # full previx for UI links
        
        "admin": { // credentials required for password-protected APIs on here
		    "username": "admin",
		    "password": "**********"
	    },

        "verbose": false,
        "keepSessionsLoadedForMs": 30000 //30s, then unload
    }
}
```

### Add Service to your compose.yaml
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
      /bin/sh /phntm_cloud_bridge/run.bridge.sh
```

### Launch
```
docker compose up phntm_cloud_bridge
```

# Dev Mode
Dev mode mapps live git repo on the host machine to the container so that you can make changes more conventinetly.
```
cd ~
git clone git@github.com:PhantomCybernetics/cloud_bridge.git cloud_bridge
```
Make the following changes to your docker compose service in compose.yaml:
```yaml
services:
  phntm_cloud_bridge:
    volumes:
      - ~/cloud_bridge:/phntm_cloud_bridge
    command:
      /bin/sh -c "while sleep 1000; do :; done"
```

Launch server manually for better control:
```
docker compose up phntm_cloud_bridge -d
docker exec -it phntm-cloud-bridge bash
npm install # necessary on the first run from new source!
./run.web-ui.sh
```


# TURN Server
This is often a good place to run a TURN server as a backup when p2p connection is not available due to restrictive NAT.

### Install coturn
```
sudo apt install coturn
```
### Configure
TODO

### Launch
TODO

# Socket.io API
TODO
