# Phantom Bridge Server

This server facilitates WebRTC P2P connection between a Phantom Bridge Client node running on a robot, and the Bridge Web UI, or any similar clients implementing this API.

The server keeps a database of App and Robot IDs and their security keys. It offers API and a command line utility for both new Robot and App registration. This server also perfomrs some basic loggig of both robot and peer apps utilization without recording any peer communication.

This server also forwards messages between peers using Socket.io when reliability is required, such as in the case of WebRTC signalling, robot introspection results, and ROS Service & Action calls. By design, the fast WebRTC communication entirely bypasses this server and only uses a TURN server when P2P connection is not possible. See TURN Server below.

The server also parses and caches the ROS `.idl` files for all message and service types discovered on the robot by Phntm Bridge Client. These are converted to JSON and pushed into peers such as the Phantom Bridge UI, making consistent bi-directional message serialization and deserialization possible. Message definitions are loaded fresh on every robot connection, and cached in memory for the time robot remains connected.

Bridge Server also forwards files requested by a peer App (e.g. the Web UI) from the robot's filesystem. This is very useful for instance for extracting robot's URFF model components, such as meshes, textures and materials. These files are chached here in /file_fw_cache for faster replies that don't repeatedly exhaust robot's network connectivity.
ROS service is provided to clear this cache.

In order to provide a secure STUN/TURN service, the Bridge Server also synchronizes robot's credentials (ID and ICE secret) with the list of configured ICE servers.

This server also provides the robot discovery service: Upon request from a peer, it queries the central database to determine
which Bridge Server instance is the robot currently associated with.

![Infrastructure map](https://raw.githubusercontent.com/PhantomCybernetics/phntm_bridge_docs/refs/heads/main/img/Architecture_Server.svg)

## Install Bridge Server

### Install Node.js
Last tested v18.20.5
```bash
sudo apt install npm nodejs
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
git clone git@github.com:PhantomCybernetics/phntm_bridge_server.git phntm_bridge_server
cd phntm_bridge_server
npm install
```

### Create a config file
Create a new config file e.g. `~/phntm_bridge_server/config.jsonc` and paste:
```jsonc
{
  "dbUrl": "mongodb://127.0.0.1:27017",
  "dieOnException": true,

  "BRIDGE": {
      "registerAddress": "https://register.phntm.io", // this is geo balanced
      "https": true,
      "registerPort": 443,
      "registerSsl": {
          "private": "/etc/letsencrypt/live/register.phntm.io/privkey.pem",
          "public": "/etc/letsencrypt/live/register.phntm.io/fullchain.pem"
      },
      "bridgeAddress": "https://us-ca.bridge.phntm.io", // this is not
      "bridgePort": 1337,
      "bridgeSsl": {
          "private": "/etc/letsencrypt/live/us-ca.bridge.phntm.io/privkey.pem",
          "public": "/etc/letsencrypt/live/us-ca.bridge.phntm.io/fullchain.pem"
      },
      "admin": {
          "username": "admin", // login+pass for /info
          "password": "*******"	
      },
      "uiAddressPrefix": "https://bridge.phntm.io/", // this is shared by several bridge instances and geo loadbalanced

      "sesAWSRegion": "", // emails via SES, e.g. "us-west-1"
      "emailSender": "Phantom Bridge <no-reply@phntm.io>",
      
      "verboseDefs": false,
      "verboseServices": false,
      "verboseTopics": false,
      "verboseNodes": false,
      "verboseDocker": false,
      "verboseWebRTC": false,

      "keepSessionsLoadedForMs": 30000, // keep 30s after robot disconnects, then unload

      "requireMaintainerEmail": true,

      "filesPort": 1338, // file extractor port
      "filesCacheDir": "/home/ubuntu/file_fw_cache", // client files will be cached here
      "filesCdnPrefix": "", // CDN url prefix, incl. server files prefix, e.g. "https://bridge-ui-cdn.phntm.io/robot-files-us-ca"
      "filesCdnPathPrefix": "", // server files CDN prefix, e.g. "/robot-files-us-ca"

      "iceServers": [ // stun/turn servers to push to robots and sync ice credentials with
        "turn:ca.turn.phntm.io:3478",
        "turn:ca.turn.phntm.io:3479"
      ]
  },

  "FILE_RECEIVER": {
    "uploadPort": 1336,
    "incomingFilesTmpDir": "/home/ubuntu/file_fw_cache/tmp/",
  },

  "ICE_SYNC": {
    "port": 1234, // stun/turn credential will be pushed to configured ice servers and this port
    "secret" : "SYNC_PASS" // secret matching credentials receiver config on each stun/turn server
  }
}
```
Note that in this cofiguration, ports 1336, 1337 and 1338 must be open to inboud TCP traffic!

### Add system services to your systemd
```bash
sudo vim /etc/systemd/system/phntm_bridge_server.service
```
... and paste:
```
[Unit]
Description=phntm bridge_server service
After=network.target

[Service]
ExecStart=/home/ubuntu/phntm_bridge_server/run.bridge-server.sh
Restart=always
User=root
Environment=NODE_ENV=production
WorkingDirectory=/home/ubuntu/phntm_bridge_server/
StandardOutput=append:/var/log/phntm_bridge_server.log
StandardError=append:/var/log/phntm_bridge_server.err.log

[Install]
WantedBy=multi-user.target
```
Same for the file receiver:
```bash
sudo vim /etc/systemd/system/phntm_file_receiver.service
```
... and paste:
```
[Unit]
Description=phntm file_receiver service
After=network.target

[Service]
ExecStart=/home/ubuntu/phntm_bridge_server/run.file-receiver.sh
Restart=always
User=root
Environment=NODE_ENV=production
WorkingDirectory=/home/ubuntu/phntm_bridge_server/
StandardOutput=append:/var/log/file_receiver.log
StandardError=append:/var/log/file_receiver.err.log

[Install]
WantedBy=multi-user.target
```
Reload systemctl daemon
```bash
sudo systemctl daemon-reload
```

### Enable on boot & Launch:
```bash
sudo systemctl enable phntm_bridge_server.service # will launch on boot
sudo systemctl enable phntm_file_receiver.service # will launch on boot
sudo systemctl start phntm_bridge_server.service
sudo systemctl start phntm_file_receiver.service
```

## REST API

> [!NOTE]
> The `register.phntm.io` hostname is geographically load-balanced and will return configuration with a Bridge Server instance nearest to you, such as `us-ca.bridge.phntm.io`. You can later change this to a different Bridge Server.

### Registering a new Robot

`https://register.phntm.io/register/robot` (POST) registers a new Robot and returns a default configuration YAML file for your Phantom Bridge Client. This uses robot_config.templ.yaml as a template. Use the Registration Utility (see below).

`https://register.phntm.io/config/robot/:FORMAT/:ID_ROBOT/:KEY` (GET) returns the default config for an already registered Robot (format is 'yaml' or 'json')

`https://register.phntm.io/locate` (POST) locates a registered robot (finds its current Bridge Server) and returns it with some useful metadata (Web UI uses this)

### Registering a new App

`https://register.phntm.io/register/app` (POST) registers a new App on this server and returns a JSON with generated APP_ID and a secret KEY. Phantom Web UI forks and other services using this API are considered individual Apps and need to be registered first. Use the Registration Utility (see below).

`https://register.phntm.io/config/app/:ID_APP/:KEY` (GET) returns default JSON config for an already registered App

### Registration utility

Use the provided register.sh for easy Robot/App registrations:
```bash
bash <(curl -s https://register.phntm.io/register.sh)
# then follow the instructions
```

### Server status

`https://us-ca.bridge.phntm.io:1337/info` (GET, protected with admin password) \
Provides various statistical information about the server instance utilization.

### File Receiver API

The File Receiver server shipped with Bridge Server comes with its own REST API for handling file uploads and cache cleanup: \
`https://us-ca.bridge.phntm.io:1336/upload` (POST) \
Receives one file chunk at the time; expects multi-part parts `file` and `json` { path, idRobot, key, parts } \
 \
`https://us-ca.bridge.phntm.io:1336/complete` (POST) \
Combines uploaded chunks; expects params `json` { path, idRobot, key, parts, totalBytes } \
 \
`https://us-ca.bridge.phntm.io:1336/clear_cache` (POST) \
Clears robot's server file cache; expects params `json` { idRobot, key }

## TURN/STUN Server
Phantom Bridge Server needs to be accompanied by a TURN server which provides a backup connectivity when P2P link is not available between the peers, such as when teleoperating a robot from a different network. This can be installed on a separate machine with a public IP. Secure ICE credentials for each robot are generated during registration and synced with the ICE servers listed in the Bridge Server's config file.

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

You will also need the [ice_creds_receiver](https://github.com/PhantomCybernetics/ice_creds_receiver) service to synchronize STUN/TURN credentials with the Bridge Server. Bridge Server pushes newly generated credentials to all TURN servers in its config on new robot registration.

You can also use the provided command line utility `run.turn-sync.sh` of the Bridge Server package to selectively sync credentials with newly added TURN servers.

### Launch coturn:
```bash
sudo systemctl start coturn
sudo systemctl enable coturn # start on boot
```
