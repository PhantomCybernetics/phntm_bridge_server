const startupTime:number = Date.now();

import { Debugger } from './lib/debugger';
const $d:Debugger = Debugger.Get('Cloud Bridge');

import { GetCerts, UncaughtExceptionHandler } from './lib/helpers'
const bcrypt = require('bcrypt-nodejs');
const crypto = require('crypto')
const fs = require('fs');
const path = require('path');
import * as C from 'colors'; C; //force import typings with string prototype extension
const _ = require('lodash');
const https = require('https');
import { MongoClient, Db, Collection, MongoError, InsertOneResult, ObjectId } from 'mongodb';
import * as SocketIO from "socket.io";
import * as express from "express";

import { App, AppSocket } from './lib/app'
import { Robot, RobotSocket } from './lib/robot'

// load config & ssl certs //
const dir:string  = __dirname + "/..";

if (!fs.existsSync(dir+'/config.jsonc')) {
    $d.e('CONFIG EXPECTED AND NOT FOUND IN '+dir+'/config.jsonc');
    process.exit();
};

import * as JSONC from 'comment-json';
const defaultConfig = JSONC.parse(fs.readFileSync(dir+'/config.jsonc').toString());
const CONFIG = _.merge(defaultConfig);
const BRIDGE_SIO_PORT:number = CONFIG['BRIDGE'].bridgePort;
const REGISTER_PORT:number = CONFIG['BRIDGE'].registerPort;
const FILES_PORT:number = CONFIG['BRIDGE'].filesPort;
const FILES_CACHE_DIR:string = CONFIG['BRIDGE'].filesCacheDir;
if (FILES_CACHE_DIR && !fs.existsSync(FILES_CACHE_DIR)) {
    $d.e('Files cache dir not found: '+FILES_CACHE_DIR);
    process.exit();
};
const DEFAULT_MAINTAINER_EMAIL:string = CONFIG['BRIDGE'].defaultMaintainerEmail;

const PUBLIC_REGISTER_ADDRESS:string = CONFIG['BRIDGE'].registerAddress; // this is geo loabalanced
const PUBLIC_BRIDGE_ADDRESS:string = CONFIG['BRIDGE'].bridgeAddress; // this is not
const UI_ADDRESS_PREFIX:string = CONFIG['BRIDGE'].uiAddressPrefix; // this is shared by several bridge instances and geo loadbalanced

const DB_URL:string = CONFIG.dbUrl;
const BRIDGE_SSL_CERT_PRIVATE = CONFIG['BRIDGE'].bridgeSsl.private;
const BRIDGE_SSL_CERT_PUBLIC = CONFIG['BRIDGE'].bridgeSsl.public;
const REGISTER_SSL_CERT_PRIVATE = CONFIG['BRIDGE'].registerSsl.private;
const REGISTER_SSL_CERT_PUBLIC = CONFIG['BRIDGE'].registerSsl.public;
const DIE_ON_EXCEPTION:boolean = CONFIG.dieOnException;

const regCertFiles:string[] = GetCerts(REGISTER_SSL_CERT_PRIVATE, REGISTER_SSL_CERT_PUBLIC);
const REGISTER_HTTPS_SERVER_OPTIONS = {
    key: fs.readFileSync(regCertFiles[0]),
    cert: fs.readFileSync(regCertFiles[1]),
};
const bridgeCertFiles:string[] = GetCerts(BRIDGE_SSL_CERT_PRIVATE, BRIDGE_SSL_CERT_PUBLIC);
const BRIDGE_HTTPS_SERVER_OPTIONS = {
    key: fs.readFileSync(bridgeCertFiles[0]),
    cert: fs.readFileSync(bridgeCertFiles[1]),
};

const ADMIN_USERNAME:string = CONFIG['BRIDGE'].admin.username;
const ADMIN_PASSWORD:string = CONFIG['BRIDGE'].admin.password;

const ICE_SERVERS:string[] = CONFIG['BRIDGE'].iceServers;
const ICE_SYNC_SERVERS:string[] = [];
if (ICE_SERVERS) {
    ICE_SERVERS.forEach((one_server:string)=>{
        let serverParts = one_server.split(':');
        if (serverParts.length != 3) {
            $d.err('Server misconfigured in config: '+one_server+'; ingnoring in sync');
            return;
        }
        if (ICE_SYNC_SERVERS.indexOf(serverParts[1]) == -1) {
            ICE_SYNC_SERVERS.push(serverParts[1]);
        }
    });
}
const ICE_SYNC_PORT:number = CONFIG['ICE_SYNC'].port;
const ICE_SYNC_SECRET:string = CONFIG['ICE_SYNC'].secret;

$d.log('Staring up...');
console.log('-----------------------------------------------------------------------'.yellow);
console.log(' PHNTM CLOUD BRIDGE'.yellow);
console.log('');
console.log((' '+PUBLIC_REGISTER_ADDRESS+':'+REGISTER_PORT+'/robot?yaml      Register new robot (YAML/JSON)').green);
console.log((' '+PUBLIC_REGISTER_ADDRESS+':'+REGISTER_PORT+'/app             Register new App (JSON)').green);
console.log('');
console.log((' '+PUBLIC_BRIDGE_ADDRESS+':'+BRIDGE_SIO_PORT+'/info                     System info').yellow);
console.log((' '+PUBLIC_BRIDGE_ADDRESS+':'+BRIDGE_SIO_PORT+'/robot/socket.io/         Robot API').cyan);
console.log((' '+PUBLIC_BRIDGE_ADDRESS+':'+BRIDGE_SIO_PORT+'/app/socket.io/           App API').cyan);
console.log('----------------------------------------------------------------------'.yellow);
console.log(('Using register certs: ').green, { key: regCertFiles[0], cert: regCertFiles[1] });
console.log(('Using bridge certs: ').green, { key: bridgeCertFiles[0], cert: bridgeCertFiles[1] });
console.log('Using ICE servers: '.green, ICE_SERVERS);
console.log(('Total unique ICE servers to sync with: '+ICE_SYNC_SERVERS.length).green);
console.log(('ICE sync port: '+ICE_SYNC_PORT).green);
console.log('----------------------------------------------------------------------'.yellow);

let db:Db = null;
let humansCollection:Collection = null;
let robotsCollection:Collection = null;
let robotLogsCollection:Collection = null;
let appsCollection:Collection = null;

const registerExpressApp = express();
const registerHttpServer = https.createServer(REGISTER_HTTPS_SERVER_OPTIONS, registerExpressApp);

const bridgeExpressApp = express();
const bridgeHttpServer = https.createServer(BRIDGE_HTTPS_SERVER_OPTIONS, bridgeExpressApp);

const filesApp = express();
const filesHttpServer = https.createServer(BRIDGE_HTTPS_SERVER_OPTIONS, filesApp);

process.on('uncaughtException', function(err) {
    $d.e('Caught unhandled exception: ', err);
});

filesApp.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, PUT");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    next();
});

filesApp.get('/:SECRET/:ID_ROBOT/:FILE_URL', async function(req:express.Request, res:express.Response) {

    let auth_ok = false;
    let app:App = null;
    for (let i = 0; i < App.connectedApps.length; i++) {
        let id_app:string = (App.connectedApps[i].idApp as ObjectId).toString();
        app = App.connectedApps[i];
        if (req.params.SECRET == App.connectedApps[i].filesSecret.toString()) {
            auth_ok = true;
            break;
        }
    };

    let remote_ip:string = (req.headers['x-forwarded-for'] || req.socket.remoteAddress) as string;

    if (!auth_ok) {    
        $d.e('Access to file fw denied '+req.params.FILE_URL+'; secret='+req.params.SECRET+'; IP='+remote_ip);
        return res.sendStatus(403); //access denied
    }

    if (!req.params.ID_ROBOT || !ObjectId.isValid(req.params.ID_ROBOT)) {
        $d.e('Invalid id robot in file request:', req.params);
        return res.sendStatus(400); //bad request
    }
    let id_robot = new ObjectId(req.params.ID_ROBOT);
    let robot = Robot.FindConnected(id_robot);
    if (!robot || !robot.socket) {
        $d.e('Error seding cached file, robot '+id_robot+' not connected');
        return res.sendStatus(502); //bad gateway
    }
    $d.l(('App #'+app.idApp.toString()+' inst #'+app.idInstance.toString()+' reguested '+req.params.FILE_URL+' for robot #'+id_robot).cyan);

    let base = path.basename(req.params.FILE_URL)
    let ext = path.extname(req.params.FILE_URL);
    let hash = crypto.createHash('md5').update(req.params.FILE_URL).digest("hex");
    let fname_cache = hash+'-'+base;
    
    let path_cache = FILES_CACHE_DIR ? FILES_CACHE_DIR+'/'+id_robot.toString()+'/'+fname_cache : null;

    if (FILES_CACHE_DIR) {
    
        try {
            await fs.promises.access(path_cache, fs.constants.R_OK);
            $d.l(path_cache+' found in cache');
    
            return res.sendFile(path_cache, {}, function (err) {
                try {
                    if (err) {
                        $d.e('Error seding cached file '+path_cache, err);
                        return res.sendStatus(500); // internal server error
                    }
                    $d.l('Sent cached: ' + path_cache)
                } catch (err1) {
                    $d.l('Exception caught and ignored', err1);
                }
            });
    
        } catch (err) {
            $d.l(fname_cache+' not found in cache');

            // check cache folder
            try {
                await fs.promises.access(FILES_CACHE_DIR+'/'+id_robot.toString(), fs.constants.R_OK | fs.constants.W_OK);
            } catch (err1) {
                try {
                    $d.l('Creating cache dir: '+FILES_CACHE_DIR+'/'+id_robot.toString());
                    await fs.promises.mkdir(FILES_CACHE_DIR+'/'+id_robot.toString(), { recursive: false });
                } catch (err2) {
                    if (err2.code != 'EEXIST') { // created since first check
                        $d.e('Failed to create cache dir: '+FILES_CACHE_DIR+'/'+id_robot.toString(), err2);
                        return res.sendStatus(500); // not caching but should => internal server error
                    }
                }
            }
        }
    }
    
    // fetch the file from robot
    $d.l('Fetching from robot... ');

    return robot.socket.emit('file', req.params.FILE_URL, (robot_res:any) => {

        if (!robot_res || robot_res.err){
            $d.e('Robot returned error... ', robot_res);
            return res.sendStatus(404); // not found
        }

        $d.l('Robot returned '+robot_res.length+' B');

        if (FILES_CACHE_DIR) {
            $d.l('  caching into '+path_cache);
            fs.open(path_cache, 'w', null, (err:any, fd:any)=>{
                if (err) {
                    $d.e('Failed to open cache file for writing: '+path_cache);
                    return;
                }
                fs.write(fd, robot_res, null, (err:any, bytesWritten:number) => {
                    if (err) {
                        $d.e('Failed to write cache file: '+err);
                    }
                    fs.closeSync(fd)
                });
            });
        }
        
        return res.send(robot_res)
    });
});

function auth_admin(req:any) {
    const authorization = req.headers.authorization;
    if (!authorization) {
        return false;
    }

    const [username, password] = Buffer.from(
            authorization.replace("Basic ", ""),
                "base64"
        )
        .toString()
        .split(":");

    if (!(username === ADMIN_USERNAME && password === ADMIN_PASSWORD)) {
        return false;
    }

    return true;
}

function reject(res:any) {
    res.setHeader("www-authenticate", "Basic");
    res.sendStatus(401);
};

const sioRobots:SocketIO.Server = new SocketIO.Server(
    bridgeHttpServer, {
        pingInterval: 10000,
        pingTimeout: 60*1000,
        path: "/robot/socket.io/",
        maxHttpBufferSize: 1e7 //allow 10MB for big file uploads
    }
);

// const sioHumans:SocketIO.Server = new SocketIO.Server(
//     sioHttpServer, {
//         pingInterval: 10000,
//         pingTimeout: 60*1000,
//         path: "/human/socket.io/"
//     }
// );

const sioApps:SocketIO.Server = new SocketIO.Server(
    bridgeHttpServer, {
        pingInterval: 10000,
        pingTimeout: 60*1000,
        path: "/app/socket.io/",
        cors: {
            origin: '*',
        }
    }
);

// return server info in json
bridgeExpressApp.get('/', function(req: any, res: any) {
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({
        phntm_cloud_bridge: Date.now(),
        robot: PUBLIC_BRIDGE_ADDRESS+':'+BRIDGE_SIO_PORT+'/robot/socket.io/',
        new_robot_json: PUBLIC_REGISTER_ADDRESS+':'+REGISTER_PORT+'/robot?json',
        new_robot_yaml: PUBLIC_REGISTER_ADDRESS+':'+REGISTER_PORT+'/robot?yaml',
        // human: PUBLIC_BRIDGE_ADDRESS+':'+SIO_PORT+'/human/socket.io/',
        app: PUBLIC_BRIDGE_ADDRESS+':'+BRIDGE_SIO_PORT+'/app/socket.io/',
        new_app_json: PUBLIC_REGISTER_ADDRESS+':'+REGISTER_PORT+'/app',
        info: PUBLIC_BRIDGE_ADDRESS+':'+BRIDGE_SIO_PORT+'/info',
    }, null, 4));
});

// get server utilization info
bridgeExpressApp.get('/info', function(req: any, res: any) {

    if (!auth_admin(req)) {
        return reject(res);
    }

    res.setHeader('Content-Type', 'application/json');

    let info_data:any = {
        time: new Date(),
        numConnectedRobots: Robot.connectedRobots.length,
        numConnectedApps: App.connectedApps.length,
        robots: [],
        apps: [],
    };

    let peers_subscribed_to_robot:any = {}

    let appsData = [];
    for (let i = 0; i < App.connectedApps.length; i++) {
        let id_app:string = (App.connectedApps[i].idApp as ObjectId).toString();

        let subs:any = {};
        if (App.connectedApps[i].robotSubscriptions) {
            for (let j = 0; j < App.connectedApps[i].robotSubscriptions.length; j++) {
                let id_robot:string = App.connectedApps[i].robotSubscriptions[j].id_robot.toString();
                subs[id_robot] = {
                    connection_state: App.connectedApps[i].robotSubscriptions[j].con_state,
                    method: App.connectedApps[i].robotSubscriptions[j].con_method,
                    turn_ip: App.connectedApps[i].robotSubscriptions[j].turn_ip,
                };
                if (!peers_subscribed_to_robot[id_robot])
                    peers_subscribed_to_robot[id_robot] = [];
                peers_subscribed_to_robot[id_robot].push({
                    id: id_app,
                    inst: App.connectedApps[i].idInstance.toString()
                });
            }
        }

        appsData.push({
            'id': id_app,
            'name': App.connectedApps[i].name ? App.connectedApps[i].name : 'Unnamed App',
            'inst': App.connectedApps[i].idInstance,
            'ip': App.connectedApps[i].socket.handshake.address,
            'subscriptions': subs
	    });
    }

    let robotsData = [];
    for (let i = 0; i < Robot.connectedRobots.length; i++) {
        let id_robot:string = (Robot.connectedRobots[i].idRobot as ObjectId).toString();
        let ui_url = UI_ADDRESS_PREFIX+id_robot;
        robotsData.push({
            'id': id_robot,
            'name': Robot.connectedRobots[i].name ? Robot.connectedRobots[i].name : 'Unnamed Robot',
            'maintainer_email': Robot.connectedRobots[i].maintainer_email,
            'ros_distro': Robot.connectedRobots[i].ros_distro,
            'git_sha': Robot.connectedRobots[i].git_sha,
            'git_tag': Robot.connectedRobots[i].git_tag,
            'ui': ui_url,
            'ip': Robot.connectedRobots[i].socket.handshake.address,
            'peers': peers_subscribed_to_robot[id_robot] ? peers_subscribed_to_robot[id_robot] : []
	    });
    }

    info_data['robots'] = robotsData;
    info_data['apps'] = appsData;

    res.send(JSON.stringify(info_data, null, 4));
});



registerExpressApp.get('/robot', async function(req:express.Request, res:express.Response) {

    if (req.query.id !== undefined || req.query.key !== undefined) {
        let robotUIAddress = UI_ADDRESS_PREFIX + req.query.id as string;
        return await Robot.GetDefaultConfig(req, res, 
            robotsCollection, PUBLIC_BRIDGE_ADDRESS, BRIDGE_SIO_PORT,
            robotUIAddress,
            DEFAULT_MAINTAINER_EMAIL);
    }
    
    return await Robot.Register(
        req, res, new ObjectId().toString(), //new key generated here
        robotsCollection,
        PUBLIC_BRIDGE_ADDRESS,
        ICE_SYNC_SERVERS,
        ICE_SYNC_PORT,
        ICE_SYNC_SECRET
    );
});

registerExpressApp.use(express.json());
registerExpressApp.post('/locate', async function(req:express.Request, res:express.Response) {

    let appId:string = req.body['app_id'];
    let appKey:string = req.body['app_key'];
    let robotId:string = req.body['id_robot'];
    
    if (!appId || !ObjectId.isValid(appId) || !appKey) {
        $d.err('Invalid app credentials provided in /locate: ', req.body)
        return res.status(403).send('Access denied, invalid credentials');
    }
    if (!robotId || !ObjectId.isValid(robotId)) {
        $d.err('Invalid id_robot provided in /locate: ', req.body)
        return res.status(404).send('Robot not found');
    }

    let searchAppId = new ObjectId(appId);
    const dbApp = (await appsCollection.findOne({_id: searchAppId }));
    
    if (dbApp) {
        
        return await bcrypt.compare(appKey, dbApp.key_hash, async (err:any, passRes:any) => {
            if (passRes) { //pass match => good

                let searchRobotId = new ObjectId(robotId as string);
                const dbRobot = (await robotsCollection.findOne({_id: searchRobotId }));
    
                if (!dbRobot) {
                    $d.err('Robot '+robotId+' not found in /locate')
                    return res.status(404).send('Robot not found');
                }

                res.setHeader('Content-Type', 'application/json');
                res.send(JSON.stringify({
                    'id_robot': robotId,
                    'bridge_server': dbRobot['bridge_server']
                }, null, 4));

            } else { // invalid app key
                $d.err('Invalid app credentials provided in /locate: ', req.body)
                return res.status(403).send('Access denied, invalid credentials');
            }
        });

    } else { //robot not found
        $d.err('Invalid app credentials provided in /locate: ', req.body)
        return res.status(403).send('Access denied, invalid credentials');
    }
});

registerExpressApp.get('/app', async function(req:express.Request, res:express.Response) {

    //return defaults for existing app
    if (req.query.id !== undefined || req.query.key !== undefined) { 
        return App.GetDefaultConfig(req, res, 
            appsCollection, PUBLIC_BRIDGE_ADDRESS, BRIDGE_SIO_PORT);
    }

    // register new app, sets name from ?name=
    return App.Register(
        req, res, new ObjectId().toString(), //new key generated here
        appsCollection
    );
});

const mongoClient = new MongoClient(DB_URL);
mongoClient.connect().then((client:MongoClient) => {
    $d.log(("We are connected to "+DB_URL).green);

    db = client.db('phntm');
    humansCollection = db.collection('humans');
    robotsCollection = db.collection('robots');
    robotLogsCollection = db.collection('robot_logs');
    appsCollection = db.collection('apps');

    registerHttpServer.listen(REGISTER_PORT);
    bridgeHttpServer.listen(BRIDGE_SIO_PORT);
    filesHttpServer.listen(FILES_PORT);

    $d.l(('Bridge Socket.io listening on port '+BRIDGE_SIO_PORT+', '+
          'Register listening on port '+REGISTER_PORT+', '+
          'file forwarder on '+FILES_PORT).green);

}).catch(()=>{
    $d.err("Error connecting to", DB_URL);
    process.exit();
});


// Robot Socket.io
sioRobots.use(async(robotSocket:RobotSocket, next) => {

    //err.data = { content: "Please retry later" }; // additional details
    let idRobot = robotSocket.handshake.auth.id_robot;

    if (!ObjectId.isValid(idRobot)) {
        $d.err('Invalidid id_robot provided: '+idRobot)
        const err = new Error("Access denied");
        return next(err);
    }
    if (!robotSocket.handshake.auth.key) {
        $d.err('Missin key from: '+idRobot)
        const err = new Error("Missing auth key");
        return next(err);
    }

    let searchId = new ObjectId(idRobot);
    const dbRobot = (await robotsCollection.findOne({_id: searchId }));

    if (dbRobot) {
        bcrypt.compare(robotSocket.handshake.auth.key, dbRobot.key_hash, function(err:any, res:any) {
            if (res) { //pass match => good
                $d.l(('Robot '+idRobot+' connected from '+robotSocket.handshake.address).green);
                robotSocket.dbData = dbRobot;
                return next();

            } else { //invalid key
                $d.l(('Robot '+idRobot+' auth failed for '+robotSocket.handshake.address).red);
                const err = new Error("Access denied");
                return next(err);
            }
        });
    } else { //robot not found
        $d.l(('Robot '+idRobot+' not found in db for '+robotSocket.handshake.address).red);
        const err = new Error("Access denied");
        return next(err);
    }
});

sioRobots.on('connect', async function(robotSocket : RobotSocket){

    let robot:Robot = new Robot();
    robot.idRobot = robotSocket.dbData._id;
    robot.name = robotSocket.handshake.auth.name ?
                    robotSocket.handshake.auth.name :
                        (robotSocket.dbData.name ? robotSocket.dbData.name : 'Unnamed Robot' );
    robot.maintainer_email = robotSocket.handshake.auth.maintainer_email == DEFAULT_MAINTAINER_EMAIL ? '' : robotSocket.handshake.auth.maintainer_email;
    
    robot.ros_distro = robotSocket.handshake.auth.ros_distro ? robotSocket.handshake.auth.ros_distro : '';
    robot.git_sha = robotSocket.handshake.auth.git_sha ? robotSocket.handshake.auth.git_sha : '';
    robot.git_tag = robotSocket.handshake.auth.git_tag ? robotSocket.handshake.auth.git_tag : '';

    $d.log(('Ohi, robot '+robot.name+' aka '+robot.idRobot.toString()+' ['+robot.ros_distro+'] connected to Socket.io').cyan);

    robot.isAuthentificated = true;
    let disconnectEvent:number = Robot.LOG_EVENT_DISCONNECT;
    robot.socket = robotSocket;

    robot.isConnected = true;
    robot.logConnect(robotsCollection, robotLogsCollection, PUBLIC_BRIDGE_ADDRESS);

    robot.topics = [];
    robot.services = [];
    robot.cameras = [];
    robot.docker_containers = [];
    robot.introspection = false;

    robotSocket.emit('ice-servers', { servers: ICE_SERVERS, secret: robotSocket.dbData.ice_secret }); // push this before peer info

    robot.addToConnected(); // sends update to subscribers and peers to the robot

    robotSocket.on('peer:update', async function(update_data:any, return_callback:any) {

        if (!robot.isAuthentificated || !robot.isConnected)
            return;

        let id_app:ObjectId = update_data['id_app'] && ObjectId.isValid(update_data['id_app']) ? new ObjectId(update_data['id_app']) : null;
        let id_instance:ObjectId = update_data['id_instance'] && ObjectId.isValid(update_data['id_instance']) ? new ObjectId(update_data['id_instance']) : null;
        delete update_data['id_app']
        delete update_data['id_instance']
        update_data = robot.getStateData(update_data)

        $d.l("Got peer:update from "+robot.idRobot+" for peer "+id_app+"/"+id_instance+": ", update_data);
        let app = App.FindConnected(id_app, id_instance);
        if (app && app.getRobotSubscription(robot.idRobot)) {
            app.socket.emit('robot:update', update_data, (app_answer:any) => {
                return_callback(app_answer);
            });
        } else {
            return_callback({err:1, msg:'Peer not found'});
        }
    });

    robotSocket.on('idls', async function(idls:any[]) {

        if (!robot.isAuthentificated || !robot.isConnected)
            return;

        let msg_types:string[] = Object.keys(idls);
        $d.l('Got '+ msg_types.length+' idls from '+robot.idRobot+' for msg_types:', msg_types);
        robot.idls = idls;

        robot.processIdls(()=>{ //on complete
            robot.msgDefsToSubscribers();
        });
    });

    robotSocket.on('nodes', async function(nodes:any) {

        if (!robot.isAuthentificated || !robot.isConnected)
            return;

        $d.l('Got '+Object.keys(nodes).length+' nodes from '+robot.idRobot, nodes);
        robot.nodes = nodes;
        robot.nodesToSubscribers();
    });

    robotSocket.on('topics', async function(topics:any[]) {

        if (!robot.isAuthentificated || !robot.isConnected)
            return;

        $d.l('Got '+topics.length+' topics from '+robot.idRobot, topics);
        robot.topics = topics;
        robot.topicsToSubscribers();
    });

    robotSocket.on('services', async function(services:any[]) {

        if (!robot.isAuthentificated || !robot.isConnected)
            return;

        $d.l('Got '+services.length+' services from '+robot.idRobot, services);
        robot.services = services;
        robot.servicesToSubscribers();
    });

    robotSocket.on('cameras', async function(cameras:any[]) {

        if (!robot.isAuthentificated || !robot.isConnected)
            return;

        $d.l('Got '+Object.keys(cameras).length+' cameras from '+robot.idRobot, cameras);
        robot.cameras = cameras;
        robot.camerasToSubscribers();
    });

    robotSocket.on('docker', async function(docker_updates:any[]) {

        if (!robot.isAuthentificated || !robot.isConnected)
            return;

        $d.l('Got Docker updates for '+Object.keys(docker_updates).length+' hosts from #'+robot.idRobot, docker_updates);
        robot.docker_containers = docker_updates;
        robot.dockerContainersToSubscribers();
    });

    robotSocket.on('introspection', async function(state:boolean) {

        if (!robot.isAuthentificated || !robot.isConnected)
            return;

        $d.l("Got introspection state from "+robot.idRobot+": "+state);

        robot.introspection = state;

        robot.introspectionToSubscribers();
    });

    /*
     * client disconnected
     */
    robotSocket.on('disconnect', (data:any) => {

        $d.l(('Socket disconnect for robot: '+data).red);
        robot.isAuthentificated = false;
        robot.isConnected = false;
        robot.topics = null;
        robot.services = null;
        robot.logDisconnect(robotsCollection, robotLogsCollection, disconnectEvent, () => {
            robot.socket = null;
            robot.removeFromConnected(!shuttingDown);
        });
    });

    robotSocket.on('disconnecting', (reason:any) => {
        $d.l(('Disconnecting socket for robot: '+reason).gray);
        disconnectEvent = Robot.LOG_EVENT_ERR;
        // robot.logDisconnect(robotsCollection, robotLogsCollection, Robot.LOG_EVENT_ERR);
    });

});

// App Socket.io
sioApps.use(async (appSocket:AppSocket, next) => {

    //err.data = { content: "Please retry later" }; // additional details
    let idApp = appSocket.handshake.auth.id_app;
    let appKey = appSocket.handshake.auth.key;

    if (!ObjectId.isValid(idApp)) {
        $d.err('Invalidid id_app provided: '+idApp)
        const err = new Error("Access denied");
        return next(err);
    }

    // TODO: users will be authenticated here, not apps
    // if (!appKey) {
    //     $d.err('Missin key from: '+idApp)
    //     const err = new Error("Missing auth key");
    //     return next(err);
    // }

    let searchId = new ObjectId(idApp);
    const dbApp = (await appsCollection.findOne({_id: searchId }));

    if (dbApp) {
        let appName = dbApp.name;
        appSocket.handshake.auth.name = appName;
        // TODO: users will be authenticated here, not apps

        // bcrypt.compare(appKey, dbApp.key_hash, function(err:any, res:any) {
            // if (res) { //pass match => good
                $d.l(((appName ? appName : 'Unnamed App')+' ['+idApp+'] connected from '+appSocket.handshake.address).green);
                appSocket.dbData = dbApp;
                return next();

            // } else { //invalid key
                // $d.l(((appName ? appName : 'Unnamed App')+' ['+idApp+'] auth failed for '+appSocket.handshake.address).red);
                // const err = new Error("Access denied");
                // return next(err);
            // }
        // });

    } else { //app not found
        $d.l(('App id '+idApp+' not found in db for '+appSocket.handshake.address).red);
        const err = new Error("Access denied");
        return next(err);
    }
});

sioApps.on('connect', async function(appSocket : AppSocket){

    $d.log('Connected w id_instance: ', appSocket.handshake.auth.id_instance);

    let app:App = new App(appSocket.handshake.auth.id_instance); //id instance generated in constructor, if not provided
    app.idApp = new ObjectId(appSocket.handshake.auth.id_app)
    app.name = appSocket.dbData.name;
    app.socket = appSocket;
    app.isConnected = true;
    app.robotSubscriptions = [];

    $d.log(('Ohi, app '+app.name+' aka '+app.idApp.toString()+' (inst '+app.idInstance.toString()+') connected to Socket.io').cyan);

    app.addToConnected();

    appSocket.emit('instance', app.idInstance.toString());

    appSocket.on('robot', async function (data:{id_robot:string, read?:string[], write?:string[][]}, returnCallback) {
        $d.log('Peer app requesting robot: ', data);

        if (!data.id_robot || !ObjectId.isValid(data.id_robot)) {
            if (returnCallback) {
                returnCallback({
                    'err': 1,
                    'msg': 'Invalid robot id '+data.id_robot
                })
            }
            return false;
        }
        let id_robot = new ObjectId(data.id_robot);
        let robot = Robot.FindConnected(id_robot);
        if (!robot || !robot.socket) {
            // robot not connected, check it exists and return basic info
            // TODO perhaps make this behavior optional?
            const dbRobot = (await robotsCollection.findOne({_id: id_robot }));
            if (!dbRobot) {
                return returnCallback({'err':1, 'msg': 'Robot not found here (did you register it first?)'}); //invalid id
            }

            app.subscribeRobot(id_robot, data.read, data.write);

            return returnCallback({
                id_robot: id_robot.toString(),
                name: dbRobot['name'] ? dbRobot['name'] : 'Unnamed Robot'
            });
        }

        app.subscribeRobot(robot.idRobot, data.read, data.write);
        if (true) // TODO: check max peer number
            robot.initPeer(app, data.read, data.write, returnCallback);
        else
            robot.peersToToSubscribers();
    });

    function ProcessForwardRequest(app:App, data:{ id_robot:string, id_app?:string, id_instance?:string}, returnCallback:any):Robot|boolean {

        if (!data.id_robot || !ObjectId.isValid(data.id_robot)) {
            if (returnCallback) {
                returnCallback({
                    'err': 1,
                    'msg': 'Invalid robot id '+data.id_robot
                })
            }
            return false;
        }
        let id_robot = new ObjectId(data.id_robot);
        let robot = Robot.FindConnected(id_robot);
        if (!robot || !robot.socket) {
            if (returnCallback) {
                returnCallback({
                    'err': 1,
                    'msg': 'Robot not connected'
                })
            }
            return false;
        }

        delete data['id_robot'];
        data['id_app'] = app.idApp.toString();
        data['id_instance'] = app.idInstance.toString();

        return robot;
    }

    appSocket.on('introspection', async function (data:{id_robot:string, state:boolean}, returnCallback) {
        $d.log('App requesting robot introspection', data);

        let robot:Robot = ProcessForwardRequest(app, data, returnCallback) as Robot;
        if (!robot)
            return;

        robot.socket.emit('introspection', data, (answerData:any) => {
            $d.log('Got robot\'s introspection answer:', answerData);
            return returnCallback(answerData);
        });
    });

    appSocket.on('subscribe', async function (data:{ id_robot:string, sources:string[]}, returnCallback) {
        $d.log('App subscribing to:', data);

        let robot:Robot = ProcessForwardRequest(app, data, returnCallback) as Robot;
        if (!robot)
            return;

        if (!data.sources) {
            if (returnCallback) {
                returnCallback({
                    'err': 1,
                    'msg': 'Invalid subscription sources'
                })
            }
            return;
        }

        app.addToRobotSubscriptions(robot.idRobot, data.sources, null)

        robot.socket.emit('subscribe', data, (resData:any) => {

            $d.log('Got robot\'s subscription answer:', resData);

            return returnCallback(resData);
        });
    });

    appSocket.on('subscribe:write', async function (data:{ id_robot:string, sources:any[]}, returnCallback) {

        $d.log('App requesting write subscription to:', data);

        let robot:Robot = ProcessForwardRequest(app, data, returnCallback) as Robot;
        if (!robot)
            return;

        if (!data.sources) {
            if (returnCallback) {
                returnCallback({
                    'err': 1,
                    'msg': 'Invalid write subscription data'
                })
            }
            return;
        }

        app.addToRobotSubscriptions(robot.idRobot, null, data.sources)

        robot.socket.emit('subscribe:write', data, (resData:any) => {

            $d.log('Got robot\'s write subscription answer:', resData);

            return returnCallback(resData);
        });

    });

    appSocket.on('unsubscribe', async function (data:{ id_robot:string, sources:string[]}, returnCallback) {
        $d.log('App unsubscribing from:', data);

        if (!data.id_robot || !ObjectId.isValid(data.id_robot)) {
            if (returnCallback) {
                returnCallback({
                    'err': 1,
                    'msg': 'Invalid robot id '+data.id_robot
                })
            }
            return false;
        }

        let id_robot = new ObjectId(data.id_robot);

        if (!data.sources) {
            if (returnCallback) {
                returnCallback({
                    'err': 1,
                    'msg': 'Invalid subscription sources'
                })
            }
            return;
        }

        // remove local subs even if robot is not connected
        app.removeFromRobotSubscriptions(id_robot, data.sources, null);

        let robot:Robot = ProcessForwardRequest(app, data, returnCallback) as Robot;
        if (!robot)
            return;        

        robot.socket.emit('unsubscribe', data, (resData:any) => {

            $d.log('Got robot\'s unsubscription answer:', resData);

            return returnCallback(resData);
        });
    });

    appSocket.on('unsubscribe:write', async function (data:{ id_robot:string, sources:string[]}, returnCallback) {
        $d.log('App unsubscribing from:', data);

        let robot:Robot = ProcessForwardRequest(app, data, returnCallback) as Robot;
        if (!robot)
            return;

        if (!data.sources) {
            if (returnCallback) {
                returnCallback({
                    'err': 1,
                    'msg': 'Invalid unsubscription sources'
                })
            }
            return;
        }

        app.removeFromRobotSubscriptions(robot.idRobot, null, data.sources);

        robot.socket.emit('unsubscribe:write', data, (resData:any) => {

            $d.log('Got robot\'s unsubscription answer:', resData);

            return returnCallback(resData);
        });
    });

    appSocket.on('sdp:answer', async function (data:{ id_robot:string, sdp:string}, returnCallback) {
        $d.log('App sending sdp answer with:', data);

        let robot:Robot = ProcessForwardRequest(app, data, returnCallback) as Robot;
        if (!robot)
            return;

        if (!data.sdp) {
            if (returnCallback) {
                returnCallback({
                    'err': 1,
                    'msg': 'Invalid subscription data'
                })
            }
            return;
        }

        robot.socket.emit('sdp:answer', data, (resData:any) => {

            $d.log('Got robot\'s sdp:answer answer:', resData);

            return returnCallback(resData);
        });
    });


    appSocket.on('service', async function (data:{ id_robot:string, service:string, msg:any}, returnCallback) {

        $d.log('App calling robot service:', data);

        let robot:Robot = ProcessForwardRequest(app, data, returnCallback) as Robot;
        if (!robot)
            return;

        if (!data.service) {
            if (returnCallback) {
                returnCallback({
                    'err': 1,
                    'msg': 'Invalid service call data'
                })
            }
            return;
        }

        robot.socket.emit('service', data, (resData:any) => {

            $d.log('Got robot\'s service call answer:', resData);

            if (returnCallback)
                return returnCallback(resData);
        });

        robot.broadcastPeerServiceCall(app, data.service, data.msg);
    });

    appSocket.on('con-info', async function (data:{ id_robot:string, state: string, method?:string, turn_ip?:string}) {

        if (!data.id_robot || !ObjectId.isValid(data.id_robot))
            return false;
        
        let id_robot = new ObjectId(data.id_robot);
        
        let sub = app.getRobotSubscription(id_robot);
        if (!sub)
            return false;
        
        sub.con_state = data.state;
        sub.con_method = data.method;
        sub.turn_ip = data.turn_ip;

        $d.log('Got app '+app.idApp.toString()+' (inst '+app.idInstance.toString()+') robot connection info:', data);

        return true;
    });

    /*
     * client disconnected
     */
    appSocket.on('disconnect', (msg:any) => {

        $d.l(('Socket disconnected for app '+app.idApp.toString()+' (inst '+app.idInstance.toString()+'): '+msg).red);

        app.isAuthentificated = false;
        app.isConnected = false;
        app.socket = null;
        app.removeFromConnected();

        for (let i = 0; i < app.robotSubscriptions.length; i++) {
            let id_robot = app.robotSubscriptions[i].id_robot;
            let robot = Robot.FindConnected(id_robot);
            if (robot && robot.socket) {
                robot.socket.emit('peer:disconnected', {
                    id_app: app.idApp.toString(),
                    id_instance: app.idInstance.toString()
                });
            }
            if (robot) {
                robot.peersToToSubscribers();
            }
        }
    });

    appSocket.on('disconnecting', (reason:any) => {
        $d.l(('Socket disconnecting from app: '+reason).gray);
    });
});

//error handling & shutdown
process.on('uncaughtException', (err:any) => {
    UncaughtExceptionHandler(err, false);
    if (DIE_ON_EXCEPTION) {
        _Clear();
        ShutdownWhenClear();
    }
} );

['SIGINT', 'SIGTERM', 'SIGQUIT' ]
  .forEach(signal => process.on(signal, () => {
    _Clear();
    ShutdownWhenClear();
}));

let shuttingDown:boolean = false;
function _Clear() {
    if (shuttingDown) return;
    shuttingDown = true;

    $d.log("Server exiting, cleaning up...");

    sioRobots.close();
    // sioHumans.close();
    sioApps.close();
}

function ShutdownWhenClear():void {
    if (Robot.connectedRobots.length) {
        $d.l('Waiting for '+Robot.connectedRobots.length+' robots to clear...');
        setTimeout(() => ShutdownWhenClear(), 1000);
        return;
    }
    $d.l('Shutdown clear, exiting...')
    process.exit(0);
}
