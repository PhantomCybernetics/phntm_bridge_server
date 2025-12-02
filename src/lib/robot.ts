import { Debugger } from "./debugger";
const $d:Debugger = Debugger.Get();

import * as SocketIO from "socket.io";
import { MongoClient, Db, Collection, MongoError, InsertOneResult, ObjectId, FindCursor } from 'mongodb';
import { PeerApp, RobotSubscription } from './peerApp'
import { ErrOutText, GetDomainName } from './helpers'

const bcrypt = require('bcrypt-nodejs');
import * as express from "express";
const fs = require('fs');

import { parseRos2idl } from "@foxglove/rosmsg";
import { MessageDefinition } from "@foxglove/message-definition";

import axios, { AxiosResponse, AxiosError }  from 'axios';
import { resolve4 } from "dns";

export class RobotSocket extends SocketIO.Socket {
    db_data?: any;
}

export class Robot {
    id: ObjectId;
    name: string;
    maintainer_email: string;

    ip:string | null;

    ros_distro: string;
    git_sha: string;
    git_tag: string;
    peer_limit: number;
    connected_peers: { [id_instance:string]: PeerApp};
    waiting_peers: PeerApp[];
    ui_custom_includes_js: string[];
    ui_custom_includes_css: string[];
    ui_background_disconnect_sec: number;

    // type: ObjectId;
    is_connected: boolean;
    is_authentificated: boolean;
    socket: RobotSocket;
    time_connected:Date;

    idls: any = {}; // message defs in .idl fomrat extracted from the robot
    msg_defs: any = {}; // processed js msg definitions 
    nodes: any[];
    topics: any[];
    services: any[];
    docker_containers: any = {}; // docker status as host => DockerStatusMsg
    cameras: any[];

    input_topic_locks: { [topic:string]: string } = {};

    verbose_webrtc:boolean; 
    verbose_defs:boolean;
    verbose_peers:boolean;
    verbose_input_locks: boolean;

    static LOG_EVENT_CONNECT: number = 1;
    static LOG_EVENT_DISCONNECT: number = 0;
    static LOG_EVENT_ERR: number = -1;

    introspection: boolean;

    static connected_robots:Robot[] = [];

    public constructor(id_robot:ObjectId, robot_socket:RobotSocket, name:string, maintainer_email:string,
                       peer_limit:number, ros_distro:string, git_sha:string, git_tag:string,
                       custom_includes_js:string[], custom_includes_css:string[], ui_background_disconnect_sec:number,
                       verbose_webrtc:boolean, verbose_defs:boolean, verbose_peers:boolean, verbose_input_locks:boolean
                    ) {
        this.id = id_robot;
        this.socket = robot_socket;
        this.ip = robot_socket.conn.remoteAddress;
        this.name = name;
        this.maintainer_email = maintainer_email;
        this.peer_limit = peer_limit ? peer_limit : 0; 
        this.connected_peers = {};
        this.waiting_peers = [];
        this.ros_distro = ros_distro ? ros_distro : '';
        this.git_sha = git_sha ? git_sha : '';
        this.git_tag = git_tag ? git_tag : '';
        this.ui_custom_includes_js = custom_includes_js ? custom_includes_js : [];
        this.ui_custom_includes_css = custom_includes_css ? custom_includes_css : [];
        this.ui_background_disconnect_sec = ui_background_disconnect_sec ? ui_background_disconnect_sec : 0.0;
        this.is_authentificated = true;
        this.is_connected = true;
        this.topics = [];
        this.services = [];
        this.cameras = [];
        this.nodes = [];
        this.docker_containers = [];
        this.introspection = false;
        this.time_connected = new Date();
        this.verbose_webrtc = verbose_webrtc; 
        this.verbose_defs = verbose_defs;
        this.verbose_peers = verbose_peers;
        this.verbose_input_locks = verbose_input_locks;
        this.input_topic_locks = {};
    }

    toString() : string {
        return '[Robot #' + this.id.toString() + ']';
    }

    public addToConnected() : void {
        if (Robot.connected_robots.indexOf(this) !== -1)
            return;

        Robot.connected_robots.push(this);
        let robot = this;

        let subs:{ sub:RobotSubscription, peer_app:PeerApp} [] = [];
        PeerApp.connected_apps.forEach(peer_app => {
            let sub = peer_app.getRobotSubscription(this.id);
            if (!sub) return;

            if (robot.verbose_webrtc)
                $d.log('Stored sub: ', sub);
            
            subs.push( {sub: sub, peer_app:peer_app });
        });

        subs.sort((a, b) => a.sub.subscribed - b.sub.subscribed); // asc by time of subscription

        subs.forEach((sub)=>{
            if (!robot.peer_limit || Object.keys(robot.connected_peers).length < robot.peer_limit) {
                if (!robot.connected_peers[sub.peer_app.id.toString()])
                    robot.connected_peers[sub.peer_app.id.toString()] = sub.peer_app;
                $d.l('Initializing '+sub.peer_app);
                robot.initPeer(sub.peer_app, sub.sub)
            } else {
                if (robot.waiting_peers.indexOf(sub.peer_app) === -1)
                    robot.waiting_peers.push(sub.peer_app);
                $d.l('Queuing '+sub.peer_app);
            }
        });

        robot.updateWaitingPeers();
    }

    public initPeer(peer_app:PeerApp, sub:RobotSubscription, return_callback?:any) : void {

        let data = {
            id_app: peer_app.id_type.toString(),
            id_instance: peer_app.id.toString(),
            read: sub.read,
            write: sub.write,
        }
        let that = this;

        if (this.verbose_peers)
            $d.log('Calling robot:peer with data', data);

        this.socket.emit('peer', data, (answerData:any) => {

            if (that.verbose_peers)
                $d.log('Got robot\'s answer:', answerData);

            answerData = this.getStateData(answerData);
            answerData['files_fw_secret'] = peer_app.files_secret.toString();
            answerData['input_locks'] = this.input_topic_locks;

            if (return_callback) {
                return_callback(answerData);
            } else {
                peer_app.socket.emit('robot', answerData, (peer_app_answer_data:any) => {
                    if (!that.socket)
                        return;
                    if (that.verbose_webrtc)
                        $d.log('Got app\'s answer:', peer_app_answer_data);
                    else
                        $d.log('Got app\'s answer');
                    delete peer_app_answer_data['id_robot'];
                    peer_app_answer_data['id_app'] = peer_app.id_type.toString();
                    peer_app_answer_data['id_instance'] = peer_app.id.toString();
                    that.socket.emit('sdp:answer', peer_app_answer_data);
                });
            }

            if (!peer_app.socket)
                return;

            $d.log('Intilizing '+ peer_app + ' with robot data of ' + this);
            this.pushMissingMsgDefsToPeer(peer_app, that.verbose_defs);
            peer_app.socket.emit('nodes', this.labelSubsciberData(this.nodes));
            peer_app.socket.emit('topics', this.labelSubsciberData(this.topics));
            peer_app.socket.emit('services', this.labelSubsciberData(this.services));
            peer_app.socket.emit('cameras', this.labelSubsciberData(this.cameras));
            peer_app.socket.emit('docker', this.labelSubsciberData(this.docker_containers));

            this.peersToToSubscribers();
        });
    }

    public updateWaitingPeers(peer_app_to_reply_to?:PeerApp, peer_app_reply_callback?:any) : void {

        let data = this.getStateData();
        data['wait'] = {
            'num_connected': Object.keys(this.connected_peers).length,
            'num_waiting': this.waiting_peers.length,
            'pos': -1
        };
        for (let i = 0; i < this.waiting_peers.length; i++) {
            data['wait']['pos'] = i;
            let peer_app = this.waiting_peers[i];
            if (peer_app == peer_app_to_reply_to && peer_app_reply_callback) {
                peer_app_reply_callback(data);
            } else {
                peer_app.socket.emit('robot', data);
            }
        }
    }

    public connectWaitingPeer() : void {
        if (!this.waiting_peers.length)
            return;

        let peer_app = this.waiting_peers.shift() as PeerApp;
        let sub = peer_app.getRobotSubscription(this.id);
        if (sub) {
            this.connected_peers[peer_app.id.toString()] = peer_app;
            $d.l('Initializing '+peer_app);
            this.initPeer(peer_app, sub);
        }
    }

    public removeFromConnected(notify:boolean = true) : void {
        this.idls = []; // reset until fresh idls are provided
        this.msg_defs = [];
        let index = Robot.connected_robots.indexOf(this);
        if (index != -1) {
            Robot.connected_robots.splice(index, 1);
            if (notify) {
                let that = this;
                PeerApp.connected_apps.forEach(peer_app => {
                    if (!peer_app.getRobotSubscription(this.id))
                        return;

                    peer_app.socket.emit('robot', that.getStateData()) // = robot offline
                    peer_app.served_msg_defs = []; // reset
                });
            }
        }
    }

    public getStateData(data:any=null) : any {
        if (!data || typeof data !== 'object')
            data = {};

        data['id_robot'] = this.id.toString();
        data['name'] = this.name ? this.name : 'Unnamed Robot';
        data['maintainer_email'] = this.maintainer_email ? this.maintainer_email : '';
        data['ros_distro'] = this.ros_distro;
        data['git_sha'] = this.git_sha;
        data['git_tag'] = this.git_tag;

        if (this.ip)
            data['ip'] = this.ip; //no ip = robot offline
        data['introspection'] = this.introspection;

        return data;
    }

    public labelSubsciberData(in_data:any) : any {
        let data:any = {};
        data[this.id.toString()] = in_data;
        return data;
    }

    public processIdls(verbose:boolean, complete_callback?:any) : void {

        let msg_types:string[] = Object.keys(this.idls);
        // let all_msg_defs:any[] = [];
        let numProcessed = 0;
        msg_types.forEach((msg_type:string)=>{
            let idl:string = this.idls[msg_type];
            let defs:MessageDefinition[] = [];
            try {
                defs = parseRos2idl(idl); // for ROS 2 definitions
            } catch (e) {
                $d.e('Exception while processing idl for '+msg_type+'; ignoring');
                if (verbose) {
                    $d.l(this.idls[msg_type]);
                }
                return;
            }
            if (verbose)
                $d.l(msg_type+' -> '+defs.length+' defs:');
            for (let k = 0; k < defs.length; k++) {
                let def = defs[k];
                if (!def.name)
                    continue;
                if (this.msg_defs[def.name])
                    continue; // only once per robot session
                if (verbose)
                    $d.l(def);
                this.msg_defs[def.name] = def;
                numProcessed++;
            }
        });
        
        $d.l(('Processed idls into '+numProcessed+' msg_defs').yellow);

        if (complete_callback)
            complete_callback();
    }

    public pushMissingMsgDefsToPeer(peer_app:PeerApp, verbose:boolean) : void {
        let missing_app_defs:any[] = [];
        let def_types:string[] = Object.keys(this.msg_defs);
        def_types.forEach((def_type:string)=>{
            if (peer_app.served_msg_defs.indexOf(def_type) > -1)
                return; // only sending each def once per session
            peer_app.served_msg_defs.push(def_type);
            missing_app_defs.push(this.msg_defs[def_type]);
        });

        if (missing_app_defs.length) {
            let robotDefsData:any = this.labelSubsciberData(missing_app_defs);
            if (verbose)
                $d.l('Pushing '+missing_app_defs.length+' defs to '+peer_app, missing_app_defs);
            peer_app.socket.emit('defs', robotDefsData);
        }
    }

    public msgDefsToSubscribers(verbose:boolean) : void {
        PeerApp.connected_apps.forEach(peer_app => {
            if (!peer_app.getRobotSubscription(this.id))
                return;
            this.pushMissingMsgDefsToPeer(peer_app, verbose);
        });
    }

    public nodesToSubscribers() : void {
        let robot_nodes_data = this.labelSubsciberData(this.nodes);
        PeerApp.connected_apps.forEach(peer_app => {
            if (peer_app.getRobotSubscription(this.id)) {
                peer_app.socket.emit('nodes', robot_nodes_data)
            }
        });
    }

    public topicsToSubscribers() : void {
        let robot_topics_data = this.labelSubsciberData(this.topics);
        PeerApp.connected_apps.forEach(peer_app => {
            if (peer_app.getRobotSubscription(this.id)) {
                peer_app.socket.emit('topics', robot_topics_data)
            }
        });
    }

    public servicesToSubscribers() : void {
        let robot_services_data = this.labelSubsciberData(this.services);
        PeerApp.connected_apps.forEach(peer_app => {
            if (peer_app.getRobotSubscription(this.id)) {
                // $d.l('emitting services to app', robotServicesData);
                peer_app.socket.emit('services', robot_services_data)
            }
        });
    }

    public camerasToSubscribers() : void {
        let robot_cameras_data = this.labelSubsciberData(this.cameras);
        PeerApp.connected_apps.forEach(peer_app => {
            if (peer_app.getRobotSubscription(this.id)) {
                // $d.l('emitting cameras to app', robotCamerasData);
                peer_app.socket.emit('cameras', robot_cameras_data)
            }
        });
    }

    public introspectionToSubscribers() : void {
        PeerApp.connected_apps.forEach(peer_app => {
            if (peer_app.getRobotSubscription(this.id)) {
                // $d.l('emitting discovery state to app', discoveryOn);
                peer_app.socket.emit('introspection', this.introspection)
            }
        });
    }

    public dockerContainersToSubscribers() : void {
        let robot_docker_containers_data = this.labelSubsciberData(this.docker_containers);
        PeerApp.connected_apps.forEach(peer_app => {
            if (peer_app.getRobotSubscription(this.id)) {
                // $d.l('emitting docker to app', robotDockerContainersData);
                peer_app.socket.emit('docker', robot_docker_containers_data)
            }
        });
    }

    public peersToToSubscribers() : void {
        let peer_data = {
            num_connected: Object.keys(this.connected_peers).length,
            num_waiting: this.waiting_peers.length,
        }
        let robot_peer_data = this.labelSubsciberData(peer_data);
        Object.values(this.connected_peers).forEach(peer_app => {
            peer_app.socket.emit('robot_peers', robot_peer_data)
        });
    }

    // broadcasts service call initiated by senderPeer to all other connected peers
    public broadcastPeerServiceCall(sender_peer:PeerApp, service:string, msg:any) : void {
        PeerApp.connected_apps.forEach(peer_app => {
            if (peer_app == sender_peer)
                return; //skip sender
            let data = this.labelSubsciberData({
                'service': service,
                'msg': msg
            });
            if (peer_app.getRobotSubscription(this.id)) {
                peer_app.socket.emit('peer_service_call', data);
            }
        });
    }

    public broadcastInputLocks() : void {
        Object.values(this.connected_peers).forEach(peer_app => {
            let data = this.labelSubsciberData({
                'locked_topics': this.input_topic_locks
            });
            peer_app.socket.emit('input_locks', data);
        });
    }

    public unlockInputByPeer(peer_app:PeerApp) : void {
        let change = false;
        Object.keys(this.input_topic_locks).forEach((topic) => {
            if (this.input_topic_locks[topic] && this.input_topic_locks[topic] == peer_app.id.toString()) {
                delete this.input_topic_locks[topic];
                if (this.verbose_input_locks)
                    $d.log(peer_app + ' unlocked input topic ' + topic);
                change = true;
            }
        });

        if (change) {
            this.broadcastInputLocks();
        }
    }

    public updateDbLogConnect(robots_collection:Collection, robot_logs_collection:Collection, public_bridge_address:string):void {

        robots_collection.updateOne({_id: this.id},
                                    { $set: {
                                        name: this.name,
                                        maintainer_email: this.maintainer_email,
                                        bridge_server: public_bridge_address, // save current instance for /locate
                                        ros_distro: this.ros_distro,
                                        git_sha: this.git_sha,
                                        git_tag: this.git_tag,
                                        last_connected: this.time_connected,
                                        last_ip: this.socket.handshake.address,
                                        ui_custom_includes_css: this.ui_custom_includes_css,
                                        ui_custom_includes_js: this.ui_custom_includes_js,
                                        ui_background_disconnect_sec: this.ui_background_disconnect_sec
                                    }, $inc: { total_sessions: 1 } });

        robot_logs_collection.insertOne({
            id: this.id,
            stamp: this.time_connected,
            event: Robot.LOG_EVENT_CONNECT,
            ip: this.socket.handshake.address
        });

    }

    public logDisconnect(robots_collection:Collection, robot_logs_collection:Collection, ev:number = Robot.LOG_EVENT_DISCONNECT, cb?:any):void {

        let num_tasks = 2;
        let now:Date = new Date();
        let session_length_min:number = Math.abs(now.getTime() - this.time_connected.getTime())/1000.0/60.0;
        robots_collection.updateOne({_id: this.id},
                                    { $inc: { total_time_h: session_length_min/60.0 } })
                                    .finally(()=>{
                                        num_tasks--;
                                        if (!num_tasks && cb) return cb();
                                    });

        robot_logs_collection.insertOne({
            id: this.id,
            stamp: new Date(),
            event: ev,
            session_length_min: session_length_min,
            ip: this.socket.handshake.address
        }).finally(()=>{
            num_tasks--;
            if (!num_tasks && cb) return cb();
        });
    }

    static async SyncICECredentials(id_robot:string, ice_secret:string, ice_servers:string[], sync_port:number, sync_secret:string, cb?:any) {
        ice_servers.forEach(async (sync_host)=>{
            let syncUrl = 'https://'+sync_host+':'+sync_port;
            $d.log((' >> Syncing ICE credentials of '+id_robot+' with '+syncUrl).cyan);
            
            await axios.post(syncUrl, {
                auth: sync_secret,
                ice_id: id_robot,
                ice_secret: ice_secret
            }, { timeout: 5000 })
            .then((response:AxiosResponse) => {
                if (response.status == 200) {
                    $d.log('Sync OK for ' + id_robot);
                } else {
                    $d.err('Sync returned code ' + response.status+' for ' + id_robot);
                }
                if (cb)
                    cb();
                return;
            })
            .catch((error:AxiosError) => {
                if (error.code === 'ECONNABORTED') {
                    $d.err('Request timed out for ' + syncUrl + ' (syncing ' + id_robot + ')');
                } else {
                    $d.err('Error from ' + syncUrl + ' (syncing ' + id_robot + '):', error.message);
                }
                if (cb)
                    cb();
                return;
            });
        });
    }

    static async Register(req:express.Request, res:express.Response, set_password:string, robots_collection:Collection,
        public_bridge_address:string,
        ice_sync_servers:string[], iceSyncPort:number, iceSyncSecret:string,
        ui_address_prefix:string, gosquared:any
    ) {
        let remote_ip:string = (req.headers['x-forwarded-for'] || req.socket.remoteAddress) as string;
        const salt_rounds = 10;

        bcrypt.genSalt(salt_rounds, async function (err:any, salt:string) {
            if (err) { $d.err('Error while generating salt'); return ErrOutText( 'Error while registering', res ); }
    
            bcrypt.hash(set_password, salt, null, async function (err:any, hash:string) {
                if (err) { $d.err('Error while hashing password'); return ErrOutText( 'Error while registering', res ); }
    
                let date_registered = new Date();
                
                let ice_secret = new ObjectId().toString();
                let robotReg:InsertOneResult = await robots_collection.insertOne({
                    registered: date_registered,
                    bridge_server: public_bridge_address,
                    reg_ip: remote_ip,
                    key_hash: hash,
                    ice_secret: ice_secret
                });
    
                $d.l(('Registered new robot id '+robotReg.insertedId.toString()+' from '+remote_ip).yellow);
                
                Robot.SyncICECredentials(robotReg.insertedId.toString(), ice_secret, ice_sync_servers, iceSyncPort, iceSyncSecret);
                
                if (gosquared) {
                    const response = await fetch('https://api.gosquared.com/tracking/v1/event?api_key='+gosquared.api_key+'&site_token='+gosquared.site_token, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json'},
                        body: JSON.stringify({
                            'event': {
                                'name': 'Robot registered (' + GetDomainName(public_bridge_address) + ')',
                                'data': {
                                    'id_robot': robotReg.insertedId.toString()
                                }
                            },
                            'ip': remote_ip,
                            'page': {
                                'url': ui_address_prefix + '#' + robotReg.insertedId.toString()
                            }
                        })
                    });
                    const response_rata:any = await response.json();
                    if (!response_rata.success) {
                        $d.err('Got error from GSQ "register" event: ', response_rata);
                    } // else {
                    //     $d.log('GSQ "register" event reply', responseData);
                    // }
                }

                if (req.query.yaml !== undefined) {
                    return res.redirect('/robot?yaml&id='+robotReg.insertedId.toString()+'&key='+set_password);
                } else {
                    return res.redirect('/robot?id='+robotReg.insertedId.toString()+'&key='+set_password);
                }
            });
        });
    }


    static async GetDefaultConfig(req:express.Request, res:express.Response, robots_collection:Collection,
            public_address:string, sio_port:number, robot_ui_address:string, default_maintainer_email:string) {
    
        if (!req.query.id || !ObjectId.isValid(req.query.id as string) || !req.query.key) {
            $d.err('Invalid id_robot provided in GetDefaultConfig: '+req.query.id)
            return res.status(403).send('Access denied, invalid credentials');
        }
    
        let searchId = new ObjectId(req.query.id as string);
        const dbRobot = (await robots_collection.findOne({_id: searchId }));
    
        if (dbRobot) {
            bcrypt.compare(req.query.key, dbRobot.key_hash, function(err:any, passRes:any) {
                if (passRes) { //pass match => good
                    
                    if (req.query.yaml !== undefined) {
    
                        const dir:string  = __dirname + "/../../";
                        let cfg:string = fs.readFileSync(dir+'robot_config.templ.yaml').toString(); 
                    
                        cfg = cfg.replace('%HOST%', public_address);
                        cfg = cfg.replace('%REG_DATE_TIME%', dbRobot.registered.toISOString());
                        cfg = cfg.replace('%REG_IP%', dbRobot.reg_ip);
                        cfg = cfg.replace('%ROBOT_UI_ADDRESS%', robot_ui_address);
    
                        cfg = cfg.replace('%ROBOT_ID%', dbRobot._id.toString());
                        cfg = cfg.replace('%ROBOT_KEY%', req.query.key as string);
                        cfg = cfg.replace('%MAINTAINER_EMAIL%', default_maintainer_email);
    
                        cfg = cfg.replace('%CLOUD_BRIDGE_ADDRESS%', dbRobot.bridge_server);
                        cfg = cfg.replace('%SIO_PATH%', '/robot/socket.io');
                        cfg = cfg.replace('%SIO_PORT%', sio_port.toString());
    
                        res.setHeader('Content-Type', 'application/text');
                        res.setHeader('Content-Disposition', 'attachment; filename="phntm_bridge.yaml"');
    
                        return res.send(cfg);
    
                    } else { // json - this is not very useful yet
                        // $d.l(dbRobot);
                        res.setHeader('Content-Type', 'application/json');
                        return res.send(JSON.stringify({
                            id_robot: dbRobot._id.toString(),
                            key: req.query.key,
                            cloud_bridge_address: dbRobot.bridge_server,
                            sio_path: '/robot/socket.io',
                            sio_port: sio_port,
                        }, null, 4));
                    }
    
                } else { //invalid key
                    res.status(403);
                    $d.err('Robot not found in GetDefaultConfig: '+req.query.id)
                    return res.send('Access denied, invalid credentials');
                }
            });
    
        } else { //robot not found
            return res.status(403).send('Access denied, invalid credentials');
        }
    }

    static async GetRegisteredBridgeServer(req:express.Request, res:express.Response, robots_collection:Collection) {
        if (!req.params.id || !ObjectId.isValid(req.params.id as string)) {
            $d.err('Invalid id_robot provided in GetRegisteredBridgeServer: '+req.params.id)
            return res.status(403).send();
        }
    
        let search_id = new ObjectId(req.params.id as string);
        const db_robot = (await robots_collection.findOne({_id: search_id }));
    
        if (db_robot) {

            res.setHeader('Content-Type', 'application/json');
            return res.send(JSON.stringify({
                id_robot: db_robot._id.toString(),
                bridge_server: db_robot.bridge_server
            }, null, 4));

        } else {
            $d.err('Robot not found in GetRegisteredBridgeServer: ' + req.params.id)
            return res.status(403).send();
        }
    }

    public static FindConnected(id_search:ObjectId):Robot|null {
        for (let i = 0; i < Robot.connected_robots.length; i++)
        {
            if (!Robot.connected_robots[i].id)
                continue;
            if (Robot.connected_robots[i].id.equals(id_search))
                return Robot.connected_robots[i];
        }
        return null;
    }
}