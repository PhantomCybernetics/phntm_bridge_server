# Phantom Bridge Server

This server facilitates WebRTC P2P connection between a Phantom Bridge Client node running on a robot, and the Bridge Web UI, or any similar clients using this API.

The server keeps a database of App and Robot IDs and their security keys. It offers API for both new Robot and App registration. This server also perfomrs some basic loggig of both robot and peer apps utilization without recording any peer communication.

Bridge Server also relies messages between peers using Socket.io when reliability is required, such as in the case of WebRTC signalling, robot introspection results, and ROS service calls. By design, the fast WebRTC communication entirely bypasses this server and only uses a TURN server when P2P connection is not possible. See TURN Server below.

The server also parses and caches the ROS .idl files for all message and service types discovered on the robot by phntm_bridge. These are converted to JSON and pushed into peers such as the Phntm WEB UI, making consistent bi-directional message serialization and deserialization possible. Message definitions are loaded fresh on every robot connection, and cached in memory for the time robot remains connected.

Bridge Server also forwards files requested by a peer App (UI) from the robot's filesystem. This is very useful for instance for extracting robot's URFF model components, such as meshes, textures and materials. These files are chached here in /file_fw_cache for faster replies that don't repeatedly exhaust robot's network connectivity.

In order to provide a secure STUN/TURN service, the Bridge Server also synchronizes robot's credentials (ID and ICE secret) with the list of configured ICE servers.

![Infrastructure map](https://raw.githubusercontent.com/PhantomCybernetics/phntm_bridge_docs/refs/heads/main/img/Architecture_Cloud_Bridge.png)

## Install Bridge Server

### Install Node.js & Bun

[Bun](https://bun.sh/) is used as package manager, but it is not used as a runtime for bridge server: there is a websocket incompatibility causing bridge client websocket
connection to be immediately closed.

Last tested with node.js v24.3. With [nvm](https://github.com/nvm-sh/nvm?tab=readme-ov-file#installing-and-updating):

```bash
nvm install 24
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

### Create a config file or setup environment variables

See [configuration file example](./config.example.jsonc). All configuration
fields can be also provided from environment variables. Environment variables take precedence over configuration file.

It is also possible to use `bridgeServerConfigFile` environment variable with
location to configuration file.

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

### Registering a new Robot

Fetching `https://register.phntm.io/robot?yaml` (GET) registers a new robot and returns a default configuration YAML file for your phntm_bridge. This uses robot_config.templ.yaml as a template.

Calling `https://register.phntm.io/robot?json` also registers a new robot, but returns a simplyfied JSON.

> [!NOTE]
> <<<<<<< HEAD
> The `register.phntm.io` hostname is geographically load-balanced and will return configuration with a Bridge Server instance nearest to you, such as `us-ca.bridge.phntm.io`.
> ||||||| parent of fd278da (Configuration, bun as package manager, node version that is not EOL, prettier)
> The `register.phntm.io` hostname is geographically load-balanced and will return configuration with a Cloud Bridge host nearest to you, such as `us-ca.bridge.phntm.io`.
> =======
> The `register.phntm.io` hostname is geographically load-balanced and will return configuration with a Bridge Server host nearest to you, such as `us-ca.bridge.phntm.io`.
>
> > > > > > > fd278da (Configuration, bun as package manager, node version that is not EOL, prettier)

### Server status

`https://us-ca.bridge.phntm.io:1337/info` (GET, protected with admin password) \
Provides various statistical information about the server instance utilization.

### File Receiver API

The File Receiver server shipped with Coud Bridge comes with its own REST API for handling file uploads and cache cleanup: \
`https://us-ca.bridge.phntm.io:1336/upload` (POST) \
Receives one file chunk at the time; expects params `file` and `json` {fileUrl, idRobot, authKey} \
 \
`https://us-ca.bridge.phntm.io:1336/complete` (POST) \
Combines uploaded chunks; expects params `json` {idRobot, authKey, fileUrl, totalParts} \
 \
`https://us-ca.bridge.phntm.io:1336/clear_cache` (POST) \
Clears robot's server file cache; expects params `json` {idRobot, authKey}

## TURN/STUN Server

<<<<<<< HEAD
Phantom Bridge Server needs to be accompanied by a TURN server which provides a backup connectivity when P2P link is not available between the peers, such as when teleoperating a robot from a different network. This can be installed on a separate machine with a public IP. Secure ICE credentials for each robot are generated during registration and synced with the ICE servers listed in the Bridge Server's config file.
||||||| parent of fd278da (Configuration, bun as package manager, node version that is not EOL, prettier)
Phantom Cloud Bridge needs to be accompanied by a TURN server which provides a backup connectivity when P2P link is not available between the peers, such as when teleoperating a robot from a different network. This can be installed on a separate machine with a public IP. Secure ICE credentials for each robot are generated during registration and synced with the ICE servers listed in the Cloud Bridge's config file.
=======

Phantom Bridge Server needs to be accompanied by a TURN server which provides a backup connectivity when P2P link is not available between the peers, such as when teleoperating a robot from a different network. This can be installed on a separate machine with a public IP. Secure ICE credentials for each robot are generated during registration and synced with the ICE servers listed in the Bridge Server's config file.

> > > > > > > fd278da (Configuration, bun as package manager, node version that is not EOL, prettier)

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
