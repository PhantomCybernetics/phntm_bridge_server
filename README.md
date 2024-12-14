# Phantom Cloud Bridge

This server facilitates WebRTC P2P connection between a Phantom Bridge node running on a robot, and the Bridge Web UI, or any similar clients using this API.

The server keeps a database of App and Robot IDs and their security keys. It offers API for both new Robot and App registration. This server also perfomrs some basic loggig of both robot and peer apps utilization withour recording any peer communication.

Cloud Bridge also relies messages between peers using Socket.io when reliability is required, such as in the case of WebRTC signalling, robot introspection results, and ROS service calls. By design, the fast WebRTC communication entirely bypasses this server and only uses a TURN server when P2P connection is not possible. See TURN Server below.

The server also parses and caches the ROS .idl files for all message and service types discovered on the robot by phntm_bridge. These are converted to JSON and pushed into peers such as the Phntm WEB UI, making consistent bi-directional message serialization and deserialization possible. Message definitions are loaded fresh on every robot connection, and cached in memory for the time robot remains connected.

Cloud bridge also forwards files requested by a peer App (UI) from the robot's filesystem. This is very useful for instance for extracting robot's URFF model components, such as meshes, textures and materials. These files are chached here in /file_fw_cache for faster replies that don't repeatedly exhaust robot's network connectivity.

![Infrastructure map](https://raw.githubusercontent.com/PhantomCybernetics/phntm_bridge_docs/refs/heads/main/img/Architecture_Cloud_Bridge.png)

## Install Cloud Bridge

### Install Node.js
Last tested v18.20.5
```bash
sudo apt install nodejs
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

### Clone this repo and install Node dependencies
```bash
cd ~
git clone git@github.com:PhantomCybernetics/cloud_bridge.git cloud_bridge
cd cloud_bridge
npm install
```

### Create a config file
Create a new config file e.g. `~/cloud_bridge/config.jsonc` and paste:
```jsonc
{
  "dbUrl": "mongodb://172.17.0.1:27017", // on Linux; use "mongodb://host.docker.internal:27017" on Mac
  "dieOnException": true,

  "BRIDGE": {
      "ssl": {
          // use certbot or the ssl/gen.sh script for self signed dev certificates
          "private": "/your_ssl_dir/private.pem",
          "public": "/your_ssl_dir/fullchain.crt"
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
      "filesCacheDir": "/home/ubuntu/file_fw_cache", // client files will be cached here

      "iceServers": [ // stun/turn servers to push to robots and sync ice credentials with
        "turn:ca.turn.phntm.io:3478",
        "turn:ca.turn.phntm.io:3479"
      ]
  },

  "ICE_SYNC": {
    "port": 1234, // stun/turn credential will be pushed to configured ice servers and this port
    "secret" : "SYNC_PASS" // secret matching credentials receiver config on each stun/turn server
  }
}
```
Note that in this cofiguration, ports 1337 and 1338 must be open to inboud TCP traffic!

### Add system service to your systemd
```bash
sudo vim /etc/systemd/system/phntm_cloud_bridge.service
```
... and paste:
```
[Unit]
Description=phntm cloud_bridge service
After=network.target

[Service]
ExecStart=/home/ubuntu/cloud_bridge/run.cloud-bridge.sh
Restart=always
User=root
Environment=NODE_ENV=production
WorkingDirectory=/home/ubuntu/cloud_bridge/
StandardOutput=append:/var/log/cloud_bridge.log
StandardError=append:/var/log/cloud_bridge.err.log

[Install]
WantedBy=multi-user.target
```
Reload systemctl daemon
```bash
sudo systemctl daemon-reload
```

### Launch:
```bash
sudo systemctl start phntm_cloud_bridge.service
sudo systemctl enable phntm_cloud_bridge.service # will launch on boot
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
# uncomment this line & save
TURNSERVER_ENABLED=1

sudo cp /etc/turnserver.conf /etc/turnserver.conf.bak # back up the original
sudo vim /etc/turnserver.conf
```

Paste and review this:
```conf
listening-port=3478
tls-listening-port=5349
alt-listening-port=3479
alt-tls-listening-port=5350
external-ip=52.53.174.178/172.31.4.189
min-port=32355
max-port=65535
server-name=turn.phntm.io
realm=phntm.io
lt-cred-mech
userdb=/var/lib/turn/turndb
cert=/your_ssl_dir/public_cert.pem
pkey=/your_ssl_dir/privkey.pem
cipher-list="DEFAULT"
ec-curve-name=prime256v1
log-file=/var/tmp/turn.log
verbose
```

Note that in this cofiguration, the following ports must be open to inboud traffic:
```
TCP	5349-5350
UDP	3478-3479
UDP	32355-65535
```

### Install TURN/STUN Credentials Receiver

You will also need the [ice_creds_receiver](https://github.com/PhantomCybernetics/ice_creds_receiver) service to synchronize STUN/TURN credentials with the Cloud Bridge. You can also use the command line utility `run.turn-sync.sh` of the Cloud Bridge package to selectively sync credentials with newly added TURN servers.

### Run coturn:
```bash
sudo systemctl start coturn
sudo systemctl enable coturn # start on boot
```
