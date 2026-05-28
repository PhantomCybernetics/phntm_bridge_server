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

    constructor(id_type:string, name:string, app_socket:PeerAppSocket) {
        this.id = new ObjectId()
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

    static FindConnected(id_peer_app:ObjectId, id_type:ObjectId|null):PeerApp|null {

        for (let i = 0; i < PeerApp.connected_apps.length; i++) {
            if (PeerApp.connected_apps[i].id.equals(id_peer_app))
            {
                if (id_type && PeerApp.connected_apps[i].id_type.equals(id_type)) {
                    return PeerApp.connected_apps[i];
                } else if (!id_type) {
                    return PeerApp.connected_apps[i];
                }
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

    static Register(req:express.Request, res:express.Response, maintainer_email:string, apps_collection:Collection, public_address:string, sio_port:number) {
        let remote_ip:string = (req.headers['x-forwarded-for'] || req.socket.remoteAddress) as string;
        const salt_rounds = 10;
        let app_name = req.body['name'];
        let new_key = new ObjectId().toString(); //new key generated here;

        bcrypt.genSalt(salt_rounds, async function (err:any, salt:string) {
            if (err) { $d.err('Error while generating salt'); return ErrOutText( 'Error while registering', res, 500 ); }
    
            bcrypt.hash(new_key, salt, null, async function (err:any, hash:string) {
                if (err) { $d.err('Error while hashing password'); return ErrOutText( 'Error while registering', res, 500 ); }
    
                let date_registered = new Date();
    
                let app_reg:InsertOneResult = await apps_collection.insertOne({
                    name: app_name,
                    registered: date_registered,
                    reg_ip: remote_ip,
                    key_hash: hash,
                    maintainer_email: maintainer_email
                });
    
                $d.l(('Registered new app ID '+app_reg.insertedId.toString()+' from '+remote_ip).yellow);

                return PeerApp.GetDefaultConfig(req, res, app_reg.insertedId.toString(), new_key, apps_collection, public_address, sio_port);
            });
        });
    }

    static async GetDefaultConfig(req:express.Request, res:express.Response, id_app:string, key:string,
                                  apps_collection:Collection, public_address:string, sio_port:number) {
    
        if (!id_app || !ObjectId.isValid(id_app) || !key) {
            $d.err('Invalidid id_app provided: ' + id_app)
            return ErrOutText('Access denied, invalid app credentials', res, 403);
        }
    
        let search_id = new ObjectId(id_app);
        const db_app = (await apps_collection.findOne({_id: search_id }));
    
        if (db_app) {
            bcrypt.compare(key, db_app.key_hash, function(err:any, pass_res:any) {
                if (pass_res) { //pass match => good
                    
                    res.setHeader('Content-Type', 'application/json');
                    return res.send(JSON.stringify({
                        id_app: db_app._id.toString(),
                        app_name: db_app.name,
                        key: key,
                        maintainer_email: db_app.maintainer_email,
                        sio_address: public_address,
                        sio_path: '/app/socket.io',
                        sio_port: sio_port
                    }, null, 4));
    
                } else { //invalid key
                    return ErrOutText('Access denied, invalid app credentials', res, 403);
                }
            });
        } else { //robot not found
            return ErrOutText('Access denied, invalid app credentials', res, 403);
        }
    }

}