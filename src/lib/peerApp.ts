import { Debugger } from "./debugger";
const $d:Debugger = Debugger.Get();
import { ErrOutText } from './helpers'

import * as SocketIO from "socket.io";
import { MongoClient, Db, Collection, MongoError, InsertOneResult, ObjectId, FindCursor } from 'mongodb';

const bcrypt = require('bcrypt-nodejs');
import * as express from "express";

export class PeerAppSocket extends SocketIO.Socket {
    db_data?: any;
}

export interface RobotSubscription {
    id_robot: ObjectId;
    read:string[];
    write:string[][];
    wrtc_connection_state?:string;
    wrtc_connection_method?:string;
    wrtc_connection_ip?:string;
    subscribed:number;
}

export class PeerApp {
    id: ObjectId;
    id_type: ObjectId;
    files_secret: ObjectId;
    name: string;
    is_connected: boolean;
    is_authentificated: boolean;
    socket: PeerAppSocket;
    served_msg_defs:string[] = [];

    robot_subscriptions: RobotSubscription[];

    static connected_apps:PeerApp[] = [];

    constructor(id_peer_app_instance:string, id_type:string, name:string, app_socket:PeerAppSocket) {
        this.id = new ObjectId(id_peer_app_instance)
        this.name = name;
        this.socket = app_socket;
        //generates new instance id if undefined
        this.id_type = new ObjectId(id_type);
        this.files_secret = new ObjectId();
        this.is_connected = true;
        this.robot_subscriptions = [];
        this.is_authentificated = false;
    }

    toString() : string {
        return '[PeerApp #' + this.id.toString() + ']';
    }

    static FindConnected(id_peer_app:ObjectId, id_type:ObjectId):PeerApp|null {

        for (let i = 0; i < PeerApp.connected_apps.length; i++) {
            if (PeerApp.connected_apps[i].id.equals(id_peer_app) &&
                PeerApp.connected_apps[i].id_type.equals(id_type))
            {
                return PeerApp.connected_apps[i];
            }
        }

        return null;
    }

    public addToConnected() {
        if (PeerApp.connected_apps.indexOf(this) == -1) {
            PeerApp.connected_apps.push(this);
        }
    }

    public removeFromConnected() {
        let index = PeerApp.connected_apps.indexOf(this);
        this.served_msg_defs = []; // reset
        if (index != -1) {
            PeerApp.connected_apps.splice(index, 1);
        }
    }

    public subscribeRobot(idRobot: ObjectId, read:string[], write:string[][]) : RobotSubscription {

        // if already subscribed, just update
        for (let i = 0; i < this.robot_subscriptions.length; i++) {
            if (this.robot_subscriptions[i].id_robot.equals(idRobot)) { 
                this.robot_subscriptions[i].read = read;
                this.robot_subscriptions[i].write = write;
                return this.robot_subscriptions[i];
            }
        }

        // new sub
        let sub = {
            id_robot: idRobot,
            read: read,
            write: write,
            subscribed: Date.now()
        };
        this.robot_subscriptions.push(sub);
        return sub;
    }

    public addToRobotSubscriptions(idRobot: ObjectId, read:string[]|null, write:string[][]|null) {
        for (let i = 0; i < this.robot_subscriptions.length; i++) {
            if (this.robot_subscriptions[i].id_robot.equals(idRobot)) {

                if (read) {
                    read.forEach((id_src)=>{
                        if (this.robot_subscriptions[i].read.indexOf(id_src) === -1)
                            this.robot_subscriptions[i].read.push(id_src);
                    });
                }
                if (write) {
                    write.forEach((id_src)=>{
                        if (this.robot_subscriptions[i].write.indexOf(id_src) === -1)
                            this.robot_subscriptions[i].write.push(id_src);
                    });
                }
                return;
            }
        }
    }

    public removeFromRobotSubscriptions(idRobot: ObjectId, read:string[]|null, write:string[]|null) {
        for (let i = 0; i < this.robot_subscriptions.length; i++) {
            if (this.robot_subscriptions[i].id_robot.equals(idRobot)) {

                if (read) {
                    read.forEach((id_src)=>{
                        let p = this.robot_subscriptions[i].read.indexOf(id_src);
                        if (p !== -1)
                            this.robot_subscriptions[i].read.splice(p, 1);
                    });
                }
                if (write) {
                    write.forEach((id_src)=>{
                        for (let i = 0; i < this.robot_subscriptions[i].write.length; i++) {
                            if (this.robot_subscriptions[i].write[i][0] == id_src) {
                                this.robot_subscriptions[i].write.splice(i, 1)
                                i--;
                            }
                        }
                    });
                }
                return;
            }
        }
    }

    public getRobotSubscription(id_robot: ObjectId):RobotSubscription|null {
        for (let i = 0; i < this.robot_subscriptions.length; i++) {
            if (this.robot_subscriptions[i].id_robot.equals(id_robot)) {
                return this.robot_subscriptions[i];
            }
        }
        return null;
    }

    static Register(req:express.Request, res:express.Response, set_password:string, apps_collection:Collection) {
        let remote_ip:string = (req.headers['x-forwarded-for'] || req.socket.remoteAddress) as string;
        const salt_rounds = 10;
        let app_name = req.query.name !== undefined ? req.query.name : undefined;
        bcrypt.genSalt(salt_rounds, async function (err:any, salt:string) {
            if (err) { $d.err('Error while generating salt'); return ErrOutText( 'Error while registering', res ); }
    
            bcrypt.hash(set_password, salt, null, async function (err:any, hash:string) {
                if (err) { $d.err('Error while hashing password'); return ErrOutText( 'Error while registering', res ); }
    
                let date_registered = new Date();
    
                let app_reg:InsertOneResult = await apps_collection.insertOne({
                    name: app_name,
                    registered: date_registered,
                    reg_ip: remote_ip,
                    key_hash: hash
                });
    
                $d.l(('Registered new app type '+app_reg.insertedId.toString()+' from '+remote_ip).yellow);

                return res.redirect('/app?id='+app_reg.insertedId.toString()+'&key='+set_password);

                // let new_config:any = {
                //     appId: appReg.insertedId.toString(),
                //     appKey: setPassword
                // };
    
                // res.setHeader('Content-Type', 'application/json');
                // res.send(JSON.stringify(new_config, null, 4));
                // return;
    
            });
        });
    }

    static async GetDefaultConfig(req:express.Request, res:express.Response, appsCollection:Collection, publicAddress:string, sioPort:number) {
    
        if (!req.query.id || !ObjectId.isValid(req.query.id as string) || !req.query.key) {
            $d.err('Invalidid id_robot provided: ' + req.query.id)
            res.status(403);
            return res.send('Access denied, invalid credentials');
        }
    
        let searchId = new ObjectId(req.query.id as string);
        const dbApp = (await appsCollection.findOne({_id: searchId }));
    
        if (dbApp) {
            bcrypt.compare(req.query.key, dbApp.key_hash, function(err:any, passRes:any) {
                if (passRes) { //pass match => good
                    
                    // $d.l(dbApp);
                    res.setHeader('Content-Type', 'application/json');
                    return res.send(JSON.stringify({
                        id_app: dbApp._id.toString(),
                        name: dbApp.name,
                        key: req.query.key,
                        sio_address: publicAddress,
                        sio_path: '/app/socket.io',
                        sio_port: sioPort,
                    }, null, 4));
    
                } else { //invalid key
                    res.status(403);
                    return res.send('Access denied, invalid credentials');
                }
            });
    
        } else { //robot not found
            res.status(403);
            return res.send('Access denied, invalid credentials');
        }
    
    }

}