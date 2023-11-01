const startupTime:number = Date.now();

import { Debugger } from './lib/debugger';
const $d:Debugger = Debugger.Get('[Cloud Bridge]');

import { RegisterRobot, GetDefaultRobotConfig, RegisterApp, GetCerts, UncaughtExceptionHandler } from './lib/helpers'
const bcrypt = require('bcrypt-nodejs');
const fs = require('fs');
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
const SIO_PORT:number = CONFIG['BRIDGE'].sioPort;
const UI_ADDRESS_PREFIX:string = CONFIG['BRIDGE'].uiAddressPrefix;
const PUBLIC_ADDRESS:string = CONFIG['BRIDGE'].address;
const DB_URL:string = CONFIG.dbUrl;
const SSL_CERT_PRIVATE =  CONFIG['BRIDGE'].ssl.private;
const SSL_CERT_PUBLIC =  CONFIG['BRIDGE'].ssl.public;
const DIE_ON_EXCEPTION:boolean = CONFIG.dieOnException;
const VERBOSE:boolean = CONFIG['BRIDGE'].verbose;
const certFiles:string[] = GetCerts(SSL_CERT_PRIVATE, SSL_CERT_PUBLIC);
const HTTPS_SERVER_OPTIONS = {
    key: fs.readFileSync(certFiles[0]),
    cert: fs.readFileSync(certFiles[1]),
};
const ADMIN_USERNAME:string = CONFIG['BRIDGE'].admin.username;
const ADMIN_PASSWORD:string = CONFIG['BRIDGE'].admin.password;

console.log('-----------------------------------------------------------------------'.yellow);
console.log(' PHNTM BRIDGE NODE'.yellow);
console.log('');
console.log((' '+PUBLIC_ADDRESS+':'+SIO_PORT+'/info                     System info JSON').yellow);
console.log((' '+PUBLIC_ADDRESS+':'+SIO_PORT+'/robot/socket.io/         Robot API').green);
console.log((' '+PUBLIC_ADDRESS+':'+SIO_PORT+'/robot/register?yaml      Register new robot').green);
console.log(('                                                          & download config YAML/JSON').green);
console.log((' '+PUBLIC_ADDRESS+':'+SIO_PORT+'/human/socket.io/         Human API').red);
console.log((' '+PUBLIC_ADDRESS+':'+SIO_PORT+'/app/socket.io/           App API').green);
console.log((' '+PUBLIC_ADDRESS+':'+SIO_PORT+'/app/register             Register new App').green);
console.log('');
console.log('----------------------------------------------------------------------'.yellow);

let db:Db = null;
let humansCollection:Collection = null;
let robotsCollection:Collection = null;
let appsCollection:Collection = null;

const sioExpressApp = express();
const sioHttpServer = https.createServer(HTTPS_SERVER_OPTIONS, sioExpressApp);

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
    sioHttpServer, {
        pingInterval: 10000,
        pingTimeout: 60*1000,
        path: "/robot/socket.io/"
    }
);

const sioHumans:SocketIO.Server = new SocketIO.Server(
    sioHttpServer, {
        pingInterval: 10000,
        pingTimeout: 60*1000,
        path: "/human/socket.io/"
    }
);

const sioApps:SocketIO.Server = new SocketIO.Server(
    sioHttpServer, {
        pingInterval: 10000,
        pingTimeout: 60*1000,
        path: "/app/socket.io/",
        cors: {
            origin: '*',
        }
    }
);

sioExpressApp.get('/', function(req: any, res: any) {
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify({
        phntm_cloud_bridge: Date.now(),
        robot: PUBLIC_ADDRESS+':'+SIO_PORT+'/robot/socket.io/',
        new_robot_json: PUBLIC_ADDRESS+':'+SIO_PORT+'/robot/register?json',
        new_robot_yaml: PUBLIC_ADDRESS+':'+SIO_PORT+'/robot/register?yaml',
        human: PUBLIC_ADDRESS+':'+SIO_PORT+'/human/socket.io/',
        app: PUBLIC_ADDRESS+':'+SIO_PORT+'/app/socket.io/',
        new_app_json: PUBLIC_ADDRESS+':'+SIO_PORT+'/app/register',
        info: PUBLIC_ADDRESS+':'+SIO_PORT+'/info',
    }, null, 4));
});

sioExpressApp.get('/info', function(req: any, res: any) {

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
        let id_app:string = (App.connectedApps[i].id_app as ObjectId).toString();

        let subs = [];
        if (App.connectedApps[i].robotSubscriptions) {
            for (let j = 0; j < App.connectedApps[i].robotSubscriptions.length; j++) {
                let id_robot:string = App.connectedApps[i].robotSubscriptions[j].id_robot.toString();
                subs.push(id_robot);
                if (!peers_subscribed_to_robot[id_robot])
                    peers_subscribed_to_robot[id_robot] = [];
                peers_subscribed_to_robot[id_robot].push({
                    id: id_app,
                    inst: App.connectedApps[i].id_instance.toString()
                });
            }
        }

        appsData.push({
            'id': id_app,
            'inst': App.connectedApps[i].id_instance,
            'ip': App.connectedApps[i].socket.handshake.address,
            'subscriptions': subs
	    });
    }

    let robotsData = [];
    for (let i = 0; i < Robot.connectedRobots.length; i++) {
        let id_robot:string = (Robot.connectedRobots[i].id_robot as ObjectId).toString();
        let ui_url = UI_ADDRESS_PREFIX+id_robot;
        robotsData.push({
            'id': id_robot,
            'name': Robot.connectedRobots[i].name, 
            'ui': ui_url,
            'ip': Robot.connectedRobots[i].socket.handshake.address,
            'peers': peers_subscribed_to_robot[id_robot] ? peers_subscribed_to_robot[id_robot] : []
	    });
    }

    info_data['robots'] = robotsData;
    info_data['apps'] = appsData;

    res.send(JSON.stringify(info_data, null, 4));
});

sioExpressApp.get('/robot/register', async function(req:express.Request, res:express.Response) {

    if (req.query.id !== undefined || req.query.key !== undefined) {

        return GetDefaultRobotConfig(req, res, 
            robotsCollection, PUBLIC_ADDRESS, SIO_PORT);

    }
    
    return RegisterRobot(
        req, res, new ObjectId().toString(), //new key generated here
        robotsCollection
    );
});

sioExpressApp.get('/app/register', async function(req:express.Request, res:express.Response) {
    return RegisterApp(
        req, res, new ObjectId().toString(),
        appsCollection
    );
});

const mongoClient = new MongoClient(DB_URL);
mongoClient.connect().then((client:MongoClient) => {
    $d.log(("We are connected to "+DB_URL).green);

    db = client.db('phntm');
    humansCollection = db.collection('humans');
    robotsCollection = db.collection('robots');
    appsCollection = db.collection('apps');

    sioHttpServer.listen(SIO_PORT);
    $d.l(('Socket.io listening on port '+SIO_PORT).green);
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

    let robot:Robot = new Robot()
    robot.id_robot = robotSocket.dbData._id;
    robot.name = robotSocket.handshake.auth.name ?
                    robotSocket.handshake.auth.name :
                        (robotSocket.dbData.name ? robotSocket.dbData.name : 'Unnamed Robot' );

    $d.log(('Ohi, robot '+robot.name+' aka '+robot.id_robot.toString()+' connected to Socket.io').cyan);

    robot.isAuthentificated = true;

    robot.isConnected = true;

    robot.topics = [];
    robot.services = [];
    robot.cameras = [];
    robot.docker_containers = [];
    robot.introspection = false;
    robot.socket = robotSocket;

    robot.addToConnected(); //sends update to subscribers

    robotSocket.on('peer:update', async function(update_data:any, return_callback:any) {

        if (!robot.isAuthentificated || !robot.isConnected)
            return;

        let id_app:ObjectId = update_data['id_app'] && ObjectId.isValid(update_data['id_app']) ? new ObjectId(update_data['id_app']) : null;
        let id_instance:ObjectId = update_data['id_instance'] && ObjectId.isValid(update_data['id_instance']) ? new ObjectId(update_data['id_instance']) : null;
        delete update_data['id_app']
        delete update_data['id_instance']
        update_data = robot.getStateData(update_data)

        $d.l("Got peer:update from "+robot.id_robot+" for peer "+id_app+"/"+id_instance+": ", update_data);
        let app = App.FindConnected(id_app, id_instance);
        if (app && app.isSubscribedToRobot(robot.id_robot)) {
            app.socket.emit('robot:update', update_data, (app_answer:any) => {
                return_callback(app_answer);
            });
        } else {
            return_callback({err:1, msg:'Peer not found'});
        }
    });

    robotSocket.on('nodes', async function(nodes:any) {

        if (!robot.isAuthentificated || !robot.isConnected)
            return;

        $d.l('Got '+Object.keys(nodes).length+' nodes from '+robot.id_robot, nodes);
        robot.nodes = nodes;
        robot.NodesToSubscribers();
    });

    robotSocket.on('topics', async function(topics:any[]) {

        if (!robot.isAuthentificated || !robot.isConnected)
            return;

        $d.l('Got '+topics.length+' topics from '+robot.id_robot, topics);
        robot.topics = topics;
        robot.TopicsToSubscribers();
    });

    robotSocket.on('services', async function(services:any[]) {

        if (!robot.isAuthentificated || !robot.isConnected)
            return;

        $d.l('Got '+services.length+' services from '+robot.id_robot, services);
        robot.services = services;
        robot.ServicesToSubscribers();
    });

    robotSocket.on('cameras', async function(cameras:any[]) {

        if (!robot.isAuthentificated || !robot.isConnected)
            return;

        $d.l('Got '+Object.keys(cameras).length+' cameras from '+robot.id_robot, cameras);
        robot.cameras = cameras;
        robot.CamerasToSubscribers();
    });

    robotSocket.on('docker', async function(containers:any[]) {

        if (!robot.isAuthentificated || !robot.isConnected)
            return;

        $d.l('Got '+containers.length+' Docker containers from '+robot.id_robot, containers);
        robot.docker_containers = containers;
        robot.DockerContainersToSubscribers();
    });

    robotSocket.on('introspection', async function(state:boolean) {

        if (!robot.isAuthentificated || !robot.isConnected)
            return;

        $d.l("Got introspection state from "+robot.id_robot+": "+state);

        robot.introspection = state;

        robot.IntrospectionToSubscribers();
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
        robot.socket = null;
        robot.removeFromConnected(!shuttingDown);
    });

    robotSocket.on('disconnecting', (reason:any) => {
        $d.l(('Socket disconnecting from robot: '+reason).gray);
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

    if (!appKey) {
        $d.err('Missin key from: '+idApp)
        const err = new Error("Missing auth key");
        return next(err);
    }

    let searchId = new ObjectId(idApp);
    const dbApp = (await appsCollection.findOne({_id: searchId }));

    if (dbApp) {
        bcrypt.compare(appKey, dbApp.key_hash, function(err:any, res:any) {
            if (res) { //pass match => good
                $d.l(('App '+idApp+' connected from '+appSocket.handshake.address).green);
                appSocket.dbData = dbApp;
                return next();

            } else { //invalid key
                $d.l(('App '+idApp+' auth failed for '+appSocket.handshake.address).red);
                const err = new Error("Access denied");
                return next(err);
            }
        });

    } else { //app not found
        $d.l(('App '+idApp+' not found in db for '+appSocket.handshake.address).red);
        const err = new Error("Access denied");
        return next(err);
    }
});

sioApps.on('connect', async function(appSocket : AppSocket){

    $d.log('Connected w id_instance: ', appSocket.handshake.auth.id_instance);

    let app:App = new App(appSocket.handshake.auth.id_instance); //id instance generated in constructor, if not provided
    app.id_app = new ObjectId(appSocket.handshake.auth.id_app)
    app.name = appSocket.dbData.name;
    app.socket = appSocket;
    app.isConnected = true;
    app.robotSubscriptions = [];

    $d.log(('Ohi, app '+app.name+' aka '+app.id_app.toString()+' (inst '+app.id_instance.toString()+') connected to Socket.io').cyan);

    app.addToConnected();

    appSocket.emit('instance', app.id_instance.toString());

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

        app.subscribeRobot(robot.id_robot, data.read, data.write);
        robot.init_peer(app, data.read, data.write, returnCallback);
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
        data['id_app'] = app.id_app.toString();
        data['id_instance'] = app.id_instance.toString();

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

    appSocket.on('iw:scan', async function (data:{id_robot:string, roam?:boolean}, returnCallback) {
        $d.log('App requesting robot wiri scan', data);

        let robot:Robot = ProcessForwardRequest(app, data, returnCallback) as Robot;
        if (!robot)
            return;

        robot.socket.emit('iw:scan', data, (answerData:any) => {
            $d.log('Got robot\'s iw:scan answer:', answerData);
            return returnCallback(answerData);
        });
    });

    appSocket.on('docker', async function (data:{id_robot:string, container:boolean, msg:string}, returnCallback) {
        $d.log('App calling robot docker container ', data);

        let robot:Robot = ProcessForwardRequest(app, data, returnCallback) as Robot;
        if (!robot)
            return;

        robot.socket.emit('docker', data, (answerData:any) => {
            $d.log('Got robot\'s docker call reply:', answerData);
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

        app.addToRobotSubscriptions(robot.id_robot, data.sources, null)

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

        app.addToRobotSubscriptions(robot.id_robot, null, data.sources)

        robot.socket.emit('subscribe:write', data, (resData:any) => {

            $d.log('Got robot\'s write subscription answer:', resData);

            return returnCallback(resData);
        });

    });

    appSocket.on('unsubscribe', async function (data:{ id_robot:string, sources:string[]}, returnCallback) {
        $d.log('App unsubscribing from:', data);

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

        app.removeFromRobotSubscriptions(robot.id_robot, data.sources, null);

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

        app.removeFromRobotSubscriptions(robot.id_robot, null, data.sources);

        robot.socket.emit('unsubscribe:write', data, (resData:any) => {

            $d.log('Got robot\'s unsubscription answer:', resData);

            return returnCallback(resData);
        });
    });

    // appSocket.on('cameras:read', async function (data:{ id_robot:string, cameras:[string, number][]}, returnCallback) {

    //     $d.log('App requesting robot camera access with:', data);

    //     let robot:Robot = ProcessForwardRequest(app, data, returnCallback) as Robot;
    //     if (!robot)
    //         return;

    //     if (!data.cameras) {
    //         if (returnCallback) {
    //             returnCallback({
    //                 'err': 1,
    //                 'msg': 'Invalid subscription data'
    //             })
    //         }
    //         return;
    //     }

    //     robot.socket.emit('cameras:read', data, (resData:any) => {

    //         $d.log('Got robot\'s camera subscription answer:', resData);

    //         return returnCallback(resData);
    //     });

    // });

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

    });

    /*
     * client disconnected
     */
    appSocket.on('disconnect', (data:any) => {

        $d.l(('Socket disconnect for app: '+data).red);

        app.isAuthentificated = false;
        app.isConnected = false;
        app.socket = null;
        app.removeFromConnected();

        for (let i = 0; i < app.robotSubscriptions.length; i++) {
            let id_robot = app.robotSubscriptions[i].id_robot;
            let robot = Robot.FindConnected(id_robot);
            if (robot && robot.socket) {
                robot.socket.emit('peer:disconnected', {
                    id_app: app.id_app.toString(),
                    id_instance: app.id_instance.toString()
                });
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

process.on('SIGINT', (code:any) => {
    $d.log("Worker exiting...");
    _Clear();
    ShutdownWhenClear();
});

let shuttingDown:boolean = false;
function _Clear() {
    if (shuttingDown) return;
    shuttingDown = true;

    $d.log("Cleaning up...");

    sioRobots.close();
    sioHumans.close();
    sioApps.close();
}

function ShutdownWhenClear() {
    process.exit(0);
}
