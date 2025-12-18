const startupTime:number = Date.now();

import { Debugger } from './lib/debugger';
const $d:Debugger = Debugger.Get('Bridge Server');

import { SESClient } from "@aws-sdk/client-ses";

import { GetCerts, UncaughtExceptionHandler, GetCachedFileName, SendEmail, GetDomainName } from './lib/helpers'
const bcrypt = require('bcrypt-nodejs');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
import * as C from 'colors'; C; //force import typings with string prototype extension
const _ = require('lodash');
const https = require('https');
const http = require('http');
import { MongoClient, Db, Collection, MongoError, InsertOneResult, ObjectId } from 'mongodb';
import * as SocketIO from "socket.io";
import * as express from "express";

import { PeerApp, PeerAppSocket } from './lib/peerApp'
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
const USE_HTTPS:number = CONFIG['BRIDGE'].useHttps;
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

const VERBOSE_WEBRTC:boolean = CONFIG['BRIDGE'].verboseWebRTC;
const VERBOSE_DEFS:boolean = CONFIG['BRIDGE'].verboseDefs;
const VERBOSE_SERVICES:boolean = CONFIG['BRIDGE'].verboseServices;
const VERBOSE_TOPICS:boolean = CONFIG['BRIDGE'].verboseTopics;
const VERBOSE_NODES:boolean = CONFIG['BRIDGE'].verboseNodes;
const VERBOSE_DOCKER:boolean = CONFIG['BRIDGE'].verboseDocker;
const VERBOSE_PEERS:boolean = CONFIG['BRIDGE'].verbosePeers;
const VERBOSE_INPUT_LOCKS:boolean = CONFIG['BRIDGE'].verboseInputLocks;

const DB_URL:string = CONFIG.dbUrl;
const BRIDGE_SSL_CERT_PRIVATE = USE_HTTPS ? CONFIG['BRIDGE'].bridgeSsl.private : null;
const BRIDGE_SSL_CERT_PUBLIC = USE_HTTPS ? CONFIG['BRIDGE'].bridgeSsl.public : null;
const REGISTER_SSL_CERT_PRIVATE = USE_HTTPS ? CONFIG['BRIDGE'].registerSsl.private : null;
const REGISTER_SSL_CERT_PUBLIC = USE_HTTPS ? CONFIG['BRIDGE'].registerSsl.public : null;
const DIE_ON_EXCEPTION:boolean = CONFIG.dieOnException;

const reg_cert_files:string[] = USE_HTTPS ? GetCerts(REGISTER_SSL_CERT_PRIVATE, REGISTER_SSL_CERT_PUBLIC) : [];
const REGISTER_HTTPS_SERVER_OPTIONS = USE_HTTPS ? {
    key: fs.readFileSync(reg_cert_files[0]),
    cert: fs.readFileSync(reg_cert_files[1]),
} : null;
const bridge_cert_files:string[] = USE_HTTPS ? GetCerts(BRIDGE_SSL_CERT_PRIVATE, BRIDGE_SSL_CERT_PUBLIC) : [];
const BRIDGE_HTTPS_SERVER_OPTIONS = USE_HTTPS ? {
    key: fs.readFileSync(bridge_cert_files[0]),
    cert: fs.readFileSync(bridge_cert_files[1]),
} : null;

const ADMIN_USERNAME:string = CONFIG['BRIDGE'].admin.username;
const ADMIN_PASSWORD:string = CONFIG['BRIDGE'].admin.password;

const ICE_SERVERS:string[] = [];
const ICE_SYNC_SERVERS:string[] = [];
if (CONFIG['BRIDGE'].iceServers) {
    CONFIG['BRIDGE'].iceServers.forEach((one_server:string)=>{
        ICE_SERVERS.push(one_server);
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

const SES_AWS_REGION:string = CONFIG['BRIDGE'].sesAWSRegion;
const sesClient = new SESClient({ region: SES_AWS_REGION });
const EMAIL_SENDER:string = CONFIG['BRIDGE'].emailSender;

// gosquared credentials
const GS_API_KEY:string = CONFIG['BRIDGE'].gsApiKey;
const GS_SITE_TOKEN:string = CONFIG['BRIDGE'].gsSiteToken;
let GSQ:any|null = null; 
if (GS_API_KEY && GS_SITE_TOKEN) {
    GSQ = {
        site_token: GS_SITE_TOKEN,
        api_key: GS_API_KEY // https://www.gosquared.com/settings/api
    };
}

$d.log('Staring up...');
const pad_width = 70;
console.log('-----------------------------------------------------------------------'.yellow);
console.log(' PHNTM BRIDGE SERVER'.yellow);
console.log('');
console.log((' '+(PUBLIC_REGISTER_ADDRESS+':'+REGISTER_PORT+'/robot?yaml').padEnd(pad_width) + ' Register new robot (YAML/JSON)').green);
console.log((' '+(PUBLIC_REGISTER_ADDRESS+':'+REGISTER_PORT+'/app').padEnd(pad_width) + ' Register new App (JSON)').green);
console.log('');
console.log((' '+(PUBLIC_BRIDGE_ADDRESS+':'+FILES_PORT).padEnd(pad_width) + ' Forwarding files').green);
console.log('');
console.log((' '+(PUBLIC_BRIDGE_ADDRESS+':'+BRIDGE_SIO_PORT+'/info').padEnd(pad_width) + ' System info').yellow);
console.log((' '+(PUBLIC_BRIDGE_ADDRESS+':'+BRIDGE_SIO_PORT+'/robot/socket.io/').padEnd(pad_width) + ' Robot Scoket.io API').cyan);
console.log((' '+(PUBLIC_BRIDGE_ADDRESS+':'+BRIDGE_SIO_PORT+'/app/socket.io/').padEnd(pad_width) + ' App Socket.io API').cyan);
console.log('----------------------------------------------------------------------'.yellow);
if (USE_HTTPS) {
    console.log(('Using register certs: ').green, { key: reg_cert_files[0], cert: reg_cert_files[1] });
    console.log(('Using bridge certs: ').green, { key: bridge_cert_files[0], cert: bridge_cert_files[1] });
}
console.log(('Using ICE servers ('+ICE_SYNC_SERVERS.length+' unique): ').green, ICE_SERVERS);
console.log(('ICE sync port: '+ICE_SYNC_PORT).green);
console.log('----------------------------------------------------------------------'.yellow);

let db:Db;
let humans_collection:Collection;
let robots_collection:Collection;
let robot_logs_collection:Collection;
let apps_collection:Collection;

const register_express = express();
const register_http_server = USE_HTTPS ?
                             https.createServer(REGISTER_HTTPS_SERVER_OPTIONS, register_express) :
                             http.createServer(register_express);

const bridge_express = express();
const bridge_http_server = USE_HTTPS ?
                           https.createServer(BRIDGE_HTTPS_SERVER_OPTIONS, bridge_express) :
                           http.createServer(bridge_express);

const files_express = express();
const files_http_server = USE_HTTPS ?
                          https.createServer(BRIDGE_HTTPS_SERVER_OPTIONS, files_express) :
                          http.createServer(files_express);

process.on('uncaughtException', function(err) {
    $d.e('Caught unhandled exception: ', err);
});

files_express.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, PUT");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    next();
});

files_express.get('/', async function(req:express.Request, res:express.Response) {
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({'file_forwarder': PUBLIC_BRIDGE_ADDRESS}, null, 4));
});

files_express.get('/:SECRET/:ID_ROBOT/:FILE_URL', async function(req:express.Request, res:express.Response) {

    let auth_ok = false;
    let peer_app:PeerApp|null = null;
    for (let i = 0; i < PeerApp.connected_apps.length; i++) {
        //let id_app:string = PeerApp.connected_apps[i].id.toString();
        peer_app = PeerApp.connected_apps[i];
        if (req.params.SECRET == PeerApp.connected_apps[i].files_secret.toString()) {
            auth_ok = true;
            break;
        }
    };

    let remote_ip:string = (req.headers['x-forwarded-for'] || req.socket.remoteAddress) as string;

    if (!auth_ok || !peer_app) {    
        $d.e('Access to file fw denied '+req.params.FILE_URL+'; secret='+req.params.SECRET+'; IP='+remote_ip);
        return res.sendStatus(403); //access denied
    }

    if (!req.params.ID_ROBOT || !ObjectId.isValid(req.params.ID_ROBOT)) {
        $d.e('Invalid id robot in file request:', req.params);
        return res.sendStatus(400); //bad request
    }
    let id_robot = new ObjectId(req.params.ID_ROBOT);
    let robot = Robot.FindConnected(id_robot);
    if (!robot) {
        $d.e('Error seding cached file, robot '+id_robot+' not connected');
        return res.sendStatus(502); //bad gateway
    }
    $d.l((peer_app + ' reguested ' + req.params.FILE_URL + ' for robot #'+id_robot).cyan);

    let fname_cache = GetCachedFileName(req.params.FILE_URL);
    
    if (!FILES_CACHE_DIR)  {
        $d.e('Files chache dir not set');
        return res.sendStatus(500); // not caching but should => internal server error
    }

    let path_cache = FILES_CACHE_DIR+'/'+id_robot.toString()+'/'+fname_cache;
    
    try {
        await fs.promises.access(path_cache, fs.constants.R_OK);
        $d.l(path_cache+' found in cache');
        return res.sendFile(path_cache, {}, function (err) {
            try {
                if (err) {
                    $d.e('Error seding cached file '+path_cache, err);
                    return res.sendStatus(500); // internal server error
                }
            } catch (err1) {
                $d.l('Exception caught and ignored', err1);
            }
        });

    } catch (err) {
        $d.l(fname_cache+' not found in server cache');

        // check cache folder
        try {
            await fs.promises.access(FILES_CACHE_DIR+'/'+id_robot.toString(), fs.constants.R_OK | fs.constants.W_OK);
        } catch (err1:any) {
            try {
                $d.l('Creating cache dir: '+FILES_CACHE_DIR+'/'+id_robot.toString());
                await fs.promises.mkdir(FILES_CACHE_DIR+'/'+id_robot.toString(), { recursive: false });
            } catch (err2:any) {
                if (err2 && err2.code != 'EEXIST') { // created since first check
                    $d.e('Failed to create cache dir: '+FILES_CACHE_DIR+'/'+id_robot.toString(), err2);
                    return res.sendStatus(500); // not caching but should => internal server error
                }
            }
        }
    }
    
    // fetch the file from robot
    $d.l('Fetching file from robot... ');

    return robot.socket.emit('file', req.params.FILE_URL, async (robot_res:any) => {

        if (!robot_res || robot_res.err || !robot_res.fileName) {
            $d.e(robot + ' returned error... ', robot_res);
            return res.sendStatus(404); // not found
        }

        $d.l((robot + ' uploaded file '+robot_res.fileName).cyan);

        if (!path_cache.endsWith(robot_res.fileName)) {
            $d.l(robot+ ' robot returned wrong file name, requested: ', path_cache);
            return res.sendStatus(404); // not found
        }

        try {
            await fs.promises.access(path_cache, fs.constants.R_OK);
            return res.sendFile(path_cache, {}, function (err) {
                try {
                    if (err) {
                        $d.e('Error seding cached file '+path_cache, err);
                        return res.sendStatus(500); // internal server error
                    }
                } catch (err1) {
                    $d.l('Exception caught and ignored', err1);
                }
            });

        } catch (err) {
            $d.l(fname_cache+' not found in server cache');
            return res.sendStatus(404); // not found
        }

        // if (FILES_CACHE_DIR) {
        //     $d.l('  caching into '+path_cache);
        //     fs.open(path_cache, 'w', null, (err:any, fd:any)=>{
        //         if (err) {
        //             $d.e('Failed to open cache file for writing: '+path_cache);
        //             return;
        //         }
        //         fs.write(fd, robot_res, null, (err:any, bytesWritten:number) => {
        //             if (err) {
        //                 $d.e('Failed to write cache file: '+err);
        //             }
        //             fs.closeSync(fd)
        //         });
        //     });
        // }
        
        // return res.send(robot_res)
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

const sio_robots:SocketIO.Server = new SocketIO.Server(
    bridge_http_server, {
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

const sio_peer_apps:SocketIO.Server = new SocketIO.Server(
    bridge_http_server, {
        pingInterval: 10000,
        pingTimeout: 60*1000,
        path: "/app/socket.io/",
        cors: {
            origin: '*',
        }
    }
);

// return server info in json
bridge_express.get('/', function(req: any, res: any) {
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
bridge_express.get('/info', function(req: any, res: any) {

    if (!auth_admin(req)) {
        return reject(res);
    }

    res.setHeader('Content-Type', 'application/json');

    let info_data:any = {
        'time': new Date(),
        'numConnectedRobots': Robot.connected_robots.length,
        'numConnectedApps': PeerApp.connected_apps.length,
        'robots': [],
        'peer_apps': [],
    };

    let peers_subscribed_to_robot:any = {}

    let peerAppsData = [];
    for (let i = 0; i < PeerApp.connected_apps.length; i++) {
        let id_app_type:string = PeerApp.connected_apps[i].id_type.toString();
        let id_app:string = PeerApp.connected_apps[i].id.toString();

        let subs:any = {};
        if (PeerApp.connected_apps[i].robot_subscriptions) {
            for (let j = 0; j < PeerApp.connected_apps[i].robot_subscriptions.length; j++) {
                let id_robot:string = PeerApp.connected_apps[i].robot_subscriptions[j].id_robot.toString();
                subs[id_robot] = {
                    wrtc_connection_state: PeerApp.connected_apps[i].robot_subscriptions[j].wrtc_connection_state,
                    wrtc_connection_method: PeerApp.connected_apps[i].robot_subscriptions[j].wrtc_connection_method,
                    wrtc_connection_ip: PeerApp.connected_apps[i].robot_subscriptions[j].wrtc_connection_ip,
                };
                if (!peers_subscribed_to_robot[id_robot])
                    peers_subscribed_to_robot[id_robot] = [];
                peers_subscribed_to_robot[id_robot].push({
                    id: id_app,
                    type: id_app_type
                });
            }
        }

        peerAppsData.push({
            'id': id_app,
            'name': PeerApp.connected_apps[i].name ? PeerApp.connected_apps[i].name : 'Unnamed App',
            'type': id_app_type,
            'ip': PeerApp.connected_apps[i].socket.handshake.address,
            'subscriptions': subs
	    });
    }

    let robotsData = [];
    for (let i = 0; i < Robot.connected_robots.length; i++) {
        let id_robot:string = Robot.connected_robots[i].id.toString();
        let ui_url = UI_ADDRESS_PREFIX+id_robot;
        robotsData.push({
            'id': id_robot,
            'name': Robot.connected_robots[i].name ? Robot.connected_robots[i].name : 'Unnamed Robot',
            'maintainer_email': Robot.connected_robots[i].maintainer_email,
            'ros_distro': Robot.connected_robots[i].ros_distro,
            'rmw_implementation': Robot.connected_robots[i].rmw_implementation,
            'git_sha': Robot.connected_robots[i].git_sha,
            'git_tag': Robot.connected_robots[i].git_tag,
            'ui': ui_url,
            'ip': Robot.connected_robots[i].socket.handshake.address,
            'peers': peers_subscribed_to_robot[id_robot] ? peers_subscribed_to_robot[id_robot] : []
	    });
    }

    info_data['robots'] = robotsData;
    info_data['peer_apps'] = peerAppsData;

    res.send(JSON.stringify(info_data, null, 4));
});

register_express.use(express.json());

register_express.get('/', async function(req:express.Request, res:express.Response) {
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({'bridge_server': PUBLIC_BRIDGE_ADDRESS}, null, 4));
});

// register a new robot, then forward to config
register_express.get('/robot', async function(req:express.Request, res:express.Response) {

    // return default config for robot id + key pair
    if (req.query.id !== undefined || req.query.key !== undefined) {
        let robotUIAddress = UI_ADDRESS_PREFIX + req.query.id as string;
        return await Robot.GetDefaultConfig(req, res, 
            robots_collection, PUBLIC_BRIDGE_ADDRESS, BRIDGE_SIO_PORT,
            robotUIAddress,
            DEFAULT_MAINTAINER_EMAIL);
    }
    
    // return default config for new robot
    return await Robot.Register(
        req, res, new ObjectId().toString(), //new key generated here
        robots_collection,
        PUBLIC_BRIDGE_ADDRESS,
        ICE_SYNC_SERVERS,
        ICE_SYNC_PORT,
        ICE_SYNC_SECRET,
        UI_ADDRESS_PREFIX, GSQ
    );
});

// locate robot (find its server), return with custom includes
register_express.post('/locate', async function(req:express.Request, res:express.Response) {

    let app_id:string = req.body['app_id'];
    let app_key:string = req.body['app_key'];
    let robot_id:string = req.body['id_robot'];
    
    if (!app_id || !ObjectId.isValid(app_id) || !app_key) {
        $d.err('Invalid app credentials provided in /locate: ', req.body)
        return res.status(403).send('Access denied, invalid credentials');
    }
    if (!robot_id || !ObjectId.isValid(robot_id)) {
        return res.status(404).send('Robot not found');
    }

    let search_app_id = new ObjectId(app_id);
    const db_app = (await apps_collection.findOne({_id: search_app_id }));
    
    if (!db_app) { // app not found
         $d.err('Invalid app credentials provided in /locate: ', req.body)
        return res.status(403).send('Access denied, invalid credentials');
    }
        
    return await bcrypt.compare(app_key, db_app.key_hash, async (err:any, passRes:any) => {
        if (passRes) { //pass match => good

            let searchRobotId = new ObjectId(robot_id as string);
            const dbRobot = (await robots_collection.findOne({_id: searchRobotId }));

            if (!dbRobot) {
                $d.err('Robot '+robot_id+' not found in /locate')
                return res.status(404).send('Robot not found');
            }

            res.setHeader('Content-Type', 'application/json');
            res.send(JSON.stringify({
                'id_robot': robot_id,
                'bridge_server': dbRobot['bridge_server'],
                'ui_custom_css': dbRobot['ui_custom_includes_css'],
                'ui_custom_js': dbRobot['ui_custom_includes_js'],
                'ui_background_disconnect_sec': dbRobot['ui_background_disconnect_sec']
            }, null, 4));

        } else { // invalid app key
            $d.err('Invalid app credentials provided in /locate: ', req.body)
            return res.status(403).send('Access denied, invalid credentials');
        }
    });
});

// register new app
register_express.get('/app', async function(req:express.Request, res:express.Response) {

    //return defaults for existing app
    if (req.query.id !== undefined || req.query.key !== undefined) { 
        return PeerApp.GetDefaultConfig(req, res, 
            apps_collection, PUBLIC_BRIDGE_ADDRESS, BRIDGE_SIO_PORT);
    }

    // register new app, sets name from ?name=
    return PeerApp.Register(
        req, res, new ObjectId().toString(), //new key generated here
        apps_collection
    );
});

const mongo_client = new MongoClient(DB_URL);
mongo_client.connect().then((client:MongoClient) => {
    $d.log(("We are connected to "+DB_URL).green);

    db = client.db('phntm');
    humans_collection = db.collection('humans');
    robots_collection = db.collection('robots');
    robot_logs_collection = db.collection('robot_logs');
    apps_collection = db.collection('apps');

    register_http_server.listen(REGISTER_PORT);
    bridge_http_server.listen(BRIDGE_SIO_PORT);
    files_http_server.listen(FILES_PORT);

    $d.l(('Bridge Socket.io listening on port '+BRIDGE_SIO_PORT+', '+
          'Register listening on port '+REGISTER_PORT+', '+
          'File Forwarder on '+FILES_PORT).green);

}).catch(()=>{
    $d.err("Error connecting to", DB_URL);
    process.exit();
});


// Robot Socket.io
sio_robots.use(async(robot_socket:RobotSocket, next) => {

    //err.data = { content: "Please retry later" }; // additional details
    let id_robot = robot_socket.handshake.auth.id_robot;

    if (!ObjectId.isValid(id_robot)) {
        $d.err('Invalidid id_robot provided: ' + id_robot)
        const err = new Error("Access denied");
        return next(err);
    }
    if (!robot_socket.handshake.auth.key) {
        $d.err('Missin key from: ' + id_robot)
        const err = new Error("Missing auth key");
        return next(err);
    }

    let search_id = new ObjectId(id_robot);
    const db_robot = (await robots_collection.findOne({_id: search_id }));

    if (db_robot) {
        bcrypt.compare(robot_socket.handshake.auth.key, db_robot.key_hash, function(err:any, res:any) {
            if (res) { //pass match => good
                $d.l(('Robot #' + id_robot + ' connected from '+robot_socket.handshake.address).green);
                robot_socket.db_data = db_robot;
                return next();

            } else { //invalid key
                $d.l(('Robot #' + id_robot + ' auth failed for '+robot_socket.handshake.address).red);
                const err = new Error("Access denied");
                return next(err);
            }
        });
    } else { //robot not found
        $d.l(('Robot #' + id_robot + ' not found in db for '+robot_socket.handshake.address).red);
        const err = new Error("Access denied");
        return next(err);
    }
});

sio_robots.on('connect', async function(robot_socket : RobotSocket){

    let robot:Robot = new Robot(
        robot_socket.db_data._id,
        robot_socket,
        robot_socket.handshake.auth.name ? robot_socket.handshake.auth.name : (robot_socket.db_data.name ? robot_socket.db_data.name : 'Unnamed Robot'),
        robot_socket.handshake.auth.maintainer_email == DEFAULT_MAINTAINER_EMAIL ? '' : robot_socket.handshake.auth.maintainer_email,
        robot_socket.handshake.auth.peer_limit,
        robot_socket.handshake.auth.ros_distro,
        robot_socket.handshake.auth.rmw_implementation,
        robot_socket.handshake.auth.git_sha,
        robot_socket.handshake.auth.git_tag,
        robot_socket.handshake.auth.ui_custom_includes_js,
        robot_socket.handshake.auth.ui_custom_includes_css,
        robot_socket.handshake.auth.ui_background_disconnect_sec,
        VERBOSE_WEBRTC, VERBOSE_DEFS, VERBOSE_PEERS, VERBOSE_INPUT_LOCKS
    );

    $d.log(('Ohi, ' + robot + ' aka '+ robot.name + ' ['+robot.ros_distro+'] connected to Socket.io').cyan);
    $d.log(robot + ' peer limit is ' + robot.peer_limit);
    if (robot.ui_custom_includes_js.length)
        $d.log(robot + ' custom UI JS includes ', robot.ui_custom_includes_js);
    if (robot.ui_custom_includes_css.length)
        $d.log(robot + ' custom UI CSS includes ', robot.ui_custom_includes_css);

    let disconnect_event:number = Robot.LOG_EVENT_DISCONNECT;

    // send email on maintainer_email or robot name change
    if (robot.maintainer_email != robot_socket.db_data.maintainer_email || robot.name != robot_socket.db_data.name) {
        if (robot.maintainer_email) {
            $d.log('Robot name or maintainer\'s e-mail of ' + robot + ' changed, sending link...');
            let subject = robot.name + ' on Phantom Bridge';
            let body = 'Hello,\n' +
                       '\n' +
                       'Your robot '+robot.name+' is available at:\n' +
                       '\n' +
                       UI_ADDRESS_PREFIX + robot.id.toString() + '\n' +
                       '\n' +
                       'Read the docs here: https://docs.phntm.io/bridge' + '\n' +
                       '\n' +
                       '- Phantom Bridge';
            SendEmail(robot.maintainer_email, subject, body, EMAIL_SENDER, sesClient);
        }
    }

    // robot first connected
    if (!robot_socket.db_data.last_connected && GSQ) {
        const response = await fetch('https://api.gosquared.com/tracking/v1/event?api_key='+GSQ.api_key+'&site_token='+GSQ.site_token, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json'},
            body: JSON.stringify({
                'event': {
                    'name': 'Robot activated (' + GetDomainName(PUBLIC_BRIDGE_ADDRESS) + ')',
                    'data': {
                        'id_robot': robot.id.toString()
                    }
                },
                'ip': robot.socket.handshake.address,
                'page': {
                    'url': UI_ADDRESS_PREFIX + '#' + robot.id.toString()
                }
            })
        });
        const responseData:any = await response.json();
        if (!responseData.success) {
            $d.err('Got error from GSQ "activate" event: ', responseData);
        }
    }

    function finishConnect():void {
        robot_socket.emit('ice-servers', { servers: ICE_SERVERS, secret: robot_socket.db_data.ice_secret }); // push this before peer info
        robot.addToConnected(); // sends update to subscribers and peers to the robot
    }

    // robot moved to another server, sync coturn creds
    if (robot_socket.db_data.bridge_server != PUBLIC_BRIDGE_ADDRESS) {
        $d.log(robot + ' moved from another Bridge Server; syncing ICE credentials');
        Robot.SyncICECredentials(robot.id.toString(), robot_socket.db_data.ice_secret,
                                 ICE_SYNC_SERVERS, ICE_SYNC_PORT, ICE_SYNC_SECRET, () => {
                                   finishConnect();
                                 });
    } else {
        finishConnect();
    }

    robot.updateDbLogConnect(robots_collection, robot_logs_collection, PUBLIC_BRIDGE_ADDRESS);

    robot_socket.on('peer:update', async function(update_data:any, return_callback:any) {

        if (!robot.is_authentificated || !robot.is_connected)
            return;

        let id_app_type:ObjectId|null = update_data['id_app'] && ObjectId.isValid(update_data['id_app']) ? new ObjectId(update_data['id_app']) : null;
        let id_app:ObjectId|null = update_data['id_instance'] && ObjectId.isValid(update_data['id_instance']) ? new ObjectId(update_data['id_instance']) : null;
        delete update_data['id_app']
        delete update_data['id_instance']
        update_data = robot.getStateData(update_data)
        
        let log_label = "Got peer:update from " + robot + " for peer app #"+id_app;
        if (VERBOSE_PEERS) $d.l(log_label + ": ", update_data);
        else $d.l(log_label);

        if (!id_app || !id_app_type)
            return;
        
        let peer_app = PeerApp.FindConnected(id_app, id_app_type);
        if (peer_app && peer_app.getRobotSubscription(robot.id)) {
            peer_app.socket.emit('robot:update', update_data, (peer_app_answer:any) => {
                return_callback(peer_app_answer);
            });
        } else {
            return_callback({err:1, msg:'Peer App not found'});
        }
    });

    robot_socket.on('idls', async function(idls:any[]) {

        if (!robot.is_authentificated || !robot.is_connected)
            return;

        let msg_types:string[] = Object.keys(idls);
        if (VERBOSE_DEFS)
            $d.l('Got '+ msg_types.length+' idls from '+robot+' for msg_types:', msg_types);
        else
            $d.l('Got '+ msg_types.length+' idls from '+robot+' for msg_types');

        robot.idls = idls;

        robot.processIdls(VERBOSE_DEFS, ()=>{ //on complete
            robot.msgDefsToSubscribers(VERBOSE_DEFS);
        });
    });

    robot_socket.on('nodes', async function(nodes:any) {

        if (!robot.is_authentificated || !robot.is_connected)
            return;

        if (VERBOSE_NODES)
            $d.l('Got '+Object.keys(nodes).length+' nodes from '+robot, nodes);
        else
            $d.l('Got '+Object.keys(nodes).length+' nodes from '+robot);

        robot.nodes = nodes;
        robot.nodesToSubscribers();
    });

    robot_socket.on('topics', async function(topics:any[]) {

        if (!robot.is_authentificated || !robot.is_connected)
            return;

        if (VERBOSE_TOPICS)
            $d.l('Got '+topics.length+' topics from '+robot, topics);
        else
            $d.l('Got '+topics.length+' topics from '+robot);

        robot.topics = topics;
        robot.topicsToSubscribers();
    });

    robot_socket.on('services', async function(services:any[]) {

        if (!robot.is_authentificated || !robot.is_connected)
            return;
        
        if (VERBOSE_SERVICES)
            $d.l('Got '+services.length+' services from '+robot, services);
        else
            $d.l('Got '+services.length+' services from '+robot);

        robot.services = services;
        robot.servicesToSubscribers();
    });

    robot_socket.on('cameras', async function(cameras:any[]) {

        if (!robot.is_authentificated || !robot.is_connected)
            return;

        $d.l('Got '+Object.keys(cameras).length+' cameras from '+robot, cameras);
        robot.cameras = cameras;
        robot.camerasToSubscribers();
    });

    robot_socket.on('docker', async function(docker_updates:any[]) {

        if (!robot.is_authentificated || !robot.is_connected)
            return;

        if (VERBOSE_DOCKER)
            $d.l('Got Docker updates for '+Object.keys(docker_updates).length+' hosts from '+robot, docker_updates);
        else
            $d.l('Got Docker updates for '+Object.keys(docker_updates).length+' hosts from '+robot);
        robot.docker_containers = docker_updates;
        robot.dockerContainersToSubscribers();
    });

    robot_socket.on('introspection', async function(state:boolean) {

        if (!robot.is_authentificated || !robot.is_connected)
            return;

        $d.l("Got introspection state from " + robot + ": " + state);

        robot.introspection = state;

        robot.introspectionToSubscribers();
    });

    /*
     * client disconnected
     */
    robot_socket.on('disconnect', (data:any) => {

        $d.l(('Socket disconnect for ' + robot + ': '+data).red);
        robot.is_authentificated = false;
        robot.is_connected = false;
        robot.topics = [];
        robot.services = [];
        robot.logDisconnect(robots_collection, robot_logs_collection, disconnect_event, () => {
            robot.ip = null;
            robot.removeFromConnected(!shutting_down);
        });
    });

    robot_socket.on('disconnecting', (reason:any) => {
        $d.l(('Disconnecting socket for ' + robot + ': '+reason).gray);
        disconnect_event = Robot.LOG_EVENT_ERR;
        // robot.logDisconnect(robotsCollection, robotLogsCollection, Robot.LOG_EVENT_ERR);
    });

});

// Peer App Socket.io
sio_peer_apps.use(async (peer_app_socket:PeerAppSocket, next) => {

    //err.data = { content: "Please retry later" }; // additional details
    let id_app = peer_app_socket.handshake.auth.id_app;
    let app_key = peer_app_socket.handshake.auth.key;

    if (!ObjectId.isValid(id_app)) {
        $d.err('Invalidid id_app provided: '+id_app)
        const err = new Error("Access denied");
        return next(err);
    }

    let search_id = new ObjectId(id_app);
    const db_app = (await apps_collection.findOne({_id: search_id }));

    if (!db_app) { // app not found
        $d.l(('App id '+id_app+' not found in db for '+peer_app_socket.handshake.address).red);
        const err = new Error("Access denied");
        return next(err);
    }

    let app_name = db_app.name;
    peer_app_socket.handshake.auth.name = app_name;
    // TODO: users will be authenticated here, not apps

    $d.l(((app_name ? app_name : 'Unnamed App')+' ['+id_app+'] connected from '+peer_app_socket.handshake.address).green);
    peer_app_socket.db_data = db_app;
    return next();
});

sio_peer_apps.on('connect', async function(peer_app_socket : PeerAppSocket){

    let peer_app:PeerApp = new PeerApp(
        peer_app_socket.handshake.auth.id_app,
        peer_app_socket.db_data.name,
        peer_app_socket
    ); // id instance generated here
  
    $d.log(('Ohi, ' + peer_app + ' (' + peer_app.name + ') connected to Socket.io').cyan);

    peer_app.addToConnected();

    peer_app_socket.emit('instance', peer_app.id.toString());

    peer_app_socket.on('robot', async function (data:{id_robot:string, read?:string[], write?:string[][]}, returnCallback) {
        $d.log(peer_app+' requesting robot ', VERBOSE_PEERS ? data : '#' + data.id_robot);

        if (!data.id_robot || !ObjectId.isValid(data.id_robot)) {
            if (returnCallback) {
                returnCallback({
                    'err': 1,
                    'msg': 'Invalid robot id '+data.id_robot
                });
            }
            return false;
        }
        let id_robot = new ObjectId(data.id_robot);
        let robot = Robot.FindConnected(id_robot);
        if (!robot) { // robot not connected, check it exists and return basic info
            
            const db_robot = (await robots_collection.findOne({_id: id_robot }));
            if (!db_robot) {
                return returnCallback({'err':1, 'msg': 'Robot not found here (did you register it first?)'}); //invalid id
            }

            peer_app.subscribeRobot(id_robot, data.read ? data.read : [], data.write ? data.write : []);

            return returnCallback({
                id_robot: id_robot.toString(),
                name: db_robot['name'] ? db_robot['name'] : 'Unnamed Robot'
            });
        }

        let sub = peer_app.subscribeRobot(robot.id, data.read ? data.read : [], data.write ? data.write : []);
        //if (true) // TODO: check max peer number
        if (!robot.peer_limit || Object.keys(robot.connected_peers).length < robot.peer_limit) {
            if (!robot.connected_peers[peer_app.id.toString()])
                robot.connected_peers[peer_app.id.toString()] = peer_app;
            $d.l('Initializing '+peer_app);
            robot.initPeer(peer_app, sub, returnCallback);
        } else {
            if (robot.waiting_peers.indexOf(peer_app) === -1)
                robot.waiting_peers.push(peer_app);
            $d.l('Queuing '+peer_app);
            robot.updateWaitingPeers(peer_app, returnCallback);
        }
    });

    function ProcessForwardRequest(peer_app:PeerApp, data:{id_robot?:string, id_app?:string, id_instance?:string}, return_callback:any) : Robot|boolean {

        if (!data.id_robot || !ObjectId.isValid(data.id_robot)) {
            if (return_callback) {
                return_callback({
                    'err': 1,
                    'msg': 'Invalid robot id '+data.id_robot
                })
            }
            return false;
        }
        let id_robot = new ObjectId(data.id_robot);
        let robot = Robot.FindConnected(id_robot);
        if (!robot) {
            if (return_callback) {
                return_callback({
                    'err': 1,
                    'msg': 'Robot not connected'
                })
            }
            return false;
        }

        delete data['id_robot'];
        data['id_instance'] = peer_app.id.toString();
        data['id_app'] = peer_app.id_type.toString();
        
        return robot;
    }

    peer_app_socket.on('introspection', async function (data:{id_robot:string, state:boolean}, return_callback) {
        $d.log(peer_app + ' requesting robot introspection', data);

        let robot:Robot = ProcessForwardRequest(peer_app, data, return_callback) as Robot;
        if (!robot)
            return;

        robot.socket.emit('introspection', data, (answerData:any) => {
            $d.log('Got robot\'s introspection answer:', answerData);
            return return_callback(answerData);
        });
    });

    peer_app_socket.on('subscribe', async function (data:{ id_robot:string, sources:string[]}, return_callback) {
        $d.log(peer_app + ' subscribing to:', data);

        let robot:Robot = ProcessForwardRequest(peer_app, data, return_callback) as Robot;
        if (!robot)
            return;

        if (!data.sources) {
            if (return_callback) {
                return_callback({
                    'err': 1,
                    'msg': 'Invalid subscription sources'
                })
            }
            return;
        }

        peer_app.addToRobotSubscriptions(robot.id, data.sources, null)

        robot.socket.emit('subscribe', data, (resData:any) => {

            $d.log('Got robot\'s subscription answer:', resData);

            return return_callback(resData);
        });
    });

    peer_app_socket.on('subscribe:write', async function (data:{ id_robot:string, sources:any[]}, return_callback) {

        $d.log(peer_app + ' requesting write subscription to:', data);

        let robot:Robot = ProcessForwardRequest(peer_app, data, return_callback) as Robot;
        if (!robot)
            return;

        if (!data.sources) {
            if (return_callback) {
                return_callback({
                    'err': 1,
                    'msg': 'Invalid write subscription data'
                })
            }
            return;
        }

        peer_app.addToRobotSubscriptions(robot.id, null, data.sources)

        robot.socket.emit('subscribe:write', data, (resData:any) => {

            $d.log('Got robot\'s write subscription answer:', resData);

            return return_callback(resData);
        });

    });

    peer_app_socket.on('unsubscribe', async function (data:{ id_robot:string, sources:string[]}, return_callback) {
        $d.log(peer_app + ' unsubscribing from:', data);

        if (!data.id_robot || !ObjectId.isValid(data.id_robot)) {
            if (return_callback) {
                return_callback({
                    'err': 1,
                    'msg': 'Invalid robot id '+data.id_robot
                })
            }
            return false;
        }

        let id_robot = new ObjectId(data.id_robot);

        if (!data.sources) {
            if (return_callback) {
                return_callback({
                    'err': 1,
                    'msg': 'Invalid subscription sources'
                })
            }
            return;
        }

        // remove local subs even if robot is not connected
        peer_app.removeFromRobotSubscriptions(id_robot, data.sources, null);

        let robot:Robot = ProcessForwardRequest(peer_app, data, return_callback) as Robot;
        if (!robot)
            return;
        
        robot.socket.emit('unsubscribe', data, (resData:any) => {

            $d.log('Got robot\'s unsubscription answer:', resData);

            return return_callback(resData);
        });
    });

    peer_app_socket.on('unsubscribe:write', async function (data:{ id_robot:string, sources:string[]}, return_callback) {
        $d.log(peer_app + 'unsubscribing from:', data);

        let robot:Robot = ProcessForwardRequest(peer_app, data, return_callback) as Robot;
        if (!robot)
            return;

        if (!data.sources) {
            if (return_callback) {
                return_callback({
                    'err': 1,
                    'msg': 'Invalid unsubscription sources'
                })
            }
            return;
        }

        peer_app.removeFromRobotSubscriptions(robot.id, null, data.sources);

        robot.socket.emit('unsubscribe:write', data, (resData:any) => {

            $d.log('Got robot\'s unsubscription answer:', resData);

            return return_callback(resData);
        });
    });

    peer_app_socket.on('sdp:answer', async function (data:{ id_robot:string, sdp:string}, return_callback) {

        if (VERBOSE_WEBRTC)
            $d.log(peer_app + ' sending sdp answer with:', data);
        else
            $d.log(peer_app + ' sending sdp answer');

        let robot:Robot = ProcessForwardRequest(peer_app, data, return_callback) as Robot;
        if (!robot)
            return;

        if (!data.sdp) {
            if (return_callback) {
                return_callback({
                    'err': 1,
                    'msg': 'Invalid subscription data'
                })
            }
            return;
        }

        robot.socket.emit('sdp:answer', data, (resData:any) => {

            $d.log('Got robot\'s sdp:answer answer:', resData);

            return return_callback(resData);
        });
    });


    peer_app_socket.on('service', async function (data:{ id_robot:string, service:string, msg:any}, return_callback) {

        if (VERBOSE_SERVICES)
            $d.log(peer_app + ' calling robot service:', data);

        let robot:Robot = ProcessForwardRequest(peer_app, data, return_callback) as Robot;
        if (!robot)
            return;

        if (!data.service) {
            if (return_callback) {
                return_callback({
                    'err': 1,
                    'msg': 'Invalid service call data'
                })
            }
            return;
        }

        robot.socket.emit('service', data, (resData:any) => {

            if (VERBOSE_SERVICES)
                $d.log('Got robot\'s service call answer:', resData);

            if (return_callback)
                return return_callback(resData);
        });

        robot.broadcastPeerServiceCall(peer_app, data.service, data.msg);
    });

    function ProcessInputLockrequest(id_robot:string, topic:string, lock_state:boolean, return_callback?:any) {
        if (!id_robot || !ObjectId.isValid(id_robot)) {
            if (return_callback) {
                return_callback({
                    'err': 1,
                    'msg': 'Invalid robot id '+id_robot
                })
            }
            return false;
        }
        let robot = Robot.FindConnected(new ObjectId(id_robot));
        if (!robot || !robot.connected_peers[peer_app.id.toString()]) {
            if (return_callback) {
                return_callback({
                    'err': 1,
                    'msg': 'Robot not connected'
                })
            }
            return false;
        }

        if (!topic) {
             if (return_callback) {
                return_callback({
                    'err': 1,
                    'msg': 'Topic not specified'
                })
            }
            return false;
        }

        if (lock_state && robot.input_topic_locks[topic] && robot.input_topic_locks[topic] != peer_app.id.toString()) {
            if (return_callback) {
                return_callback({
                    'err': 1,
                    'msg': 'Topic locked by someone else'
                })
            }
            return false;
        }

        if (VERBOSE_INPUT_LOCKS)
            $d.log(peer_app + (lock_state ? ' locking ' : ' unlocking ') + robot + ' input topic: ' + topic);

        if (lock_state) { //lock
            robot.input_topic_locks[topic] = peer_app.id.toString();
        } else { // unlock
            if (robot.input_topic_locks[topic] && robot.input_topic_locks[topic] == peer_app.id.toString())
                delete robot.input_topic_locks[topic];
        }
        
        if (return_callback) {
            return_callback({ 'success': true });
        }

        robot.broadcastInputLocks();
    }

    peer_app_socket.on('input:lock', async function (data:{ id_robot:string, topic:string}, return_callback) {
        return ProcessInputLockrequest(data.id_robot, data.topic, true, return_callback);
    });

    peer_app_socket.on('input:unlock', async function (data:{ id_robot:string, topic:string}) {
        return ProcessInputLockrequest(data.id_robot, data.topic, false);
    });

    peer_app_socket.on('wrtc-info', async function (data:{ id_robot:string, state: string, method?:string, ip?:string}) {

        if (!data.id_robot || !ObjectId.isValid(data.id_robot))
            return false;
        
        let id_robot = new ObjectId(data.id_robot);
        
        let sub = peer_app.getRobotSubscription(id_robot);
        if (!sub)
            return false;
        
        sub.wrtc_connection_state = data.state;
        sub.wrtc_connection_method = data.method;
        sub.wrtc_connection_ip = data.ip;

        if (VERBOSE_WEBRTC)
            $d.log('Got ' + peer_app + ' robot connection info:', data);

        // pass back to the robot to handle failures
        let robot = Robot.FindConnected(id_robot);
        if (robot) {
            robot.socket.emit('peer:wrtc-info', {
                id_instance: peer_app.id.toString(),
                id_app: peer_app.id_type.toString(),
                state: sub.wrtc_connection_state,
            });
        }

        return true;
    });

    /*
     * client disconnected
     */
    peer_app_socket.on('disconnect', (msg:any) => {

        $d.l(('Socket disconnected for '+ peer_app +': ' + msg).red);

        peer_app.is_authentificated = false;
        peer_app.is_connected = false;
        peer_app.removeFromConnected();

        for (let i = 0; i < peer_app.robot_subscriptions.length; i++) {
            let id_robot = peer_app.robot_subscriptions[i].id_robot;
            let robot = Robot.FindConnected(id_robot);
            if (!robot)
                continue;

            robot.socket.emit('peer:disconnected', {
                id_app: peer_app.id_type.toString(),
                id_instance: peer_app.id.toString()
            });
            
            let was_connected = robot.connected_peers[peer_app.id.toString()] ? true : false;
            if (was_connected)  {
                $d.l('Removing ' + peer_app + ' from connected');
                delete robot.connected_peers[peer_app.id.toString()];
            }

            let waiting_pos = robot.waiting_peers.indexOf(peer_app);
            if (waiting_pos > -1) {
                $d.l('Removing ' + peer_app + ' from waiting');
                robot.waiting_peers.splice(waiting_pos, 1);
            }
            if (was_connected)
                robot.connectWaitingPeer();
            robot.updateWaitingPeers();
            robot.peersToToSubscribers();

            robot.unlockInputByPeer(peer_app);
        }
    });

    peer_app_socket.on('disconnecting', (reason:any) => {
        $d.l(('Socket disconnecting from ' + peer_app + ': '+reason).gray);
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

let shutting_down:boolean = false;
function _Clear() {
    if (shutting_down) return;
    shutting_down = true;

    $d.log("Server exiting, cleaning up...");

    sio_robots.close();
    // sioHumans.close();
    sio_peer_apps.close();
}

function ShutdownWhenClear():void {
    if (Robot.connected_robots.length) {
        $d.l('Waiting for '+Robot.connected_robots.length+' robots to clear...');
        setTimeout(() => ShutdownWhenClear(), 1000);
        return;
    }
    $d.l('Shutdown clear, exiting...')
    process.exit(0);
}
