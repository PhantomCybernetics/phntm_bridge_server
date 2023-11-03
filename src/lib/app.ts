import { Debugger } from "./debugger";
const $d:Debugger = Debugger.Get();
import { ErrOutText } from './helpers'

import * as SocketIO from "socket.io";
import { MongoClient, Db, Collection, MongoError, InsertOneResult, ObjectId, FindCursor } from 'mongodb';

const bcrypt = require('bcrypt-nodejs');
import * as express from "express";

export class AppSocket extends SocketIO.Socket {
    dbData?: any;
}

export class App {
    idApp: ObjectId;
    idInstance: ObjectId;
    name: string;
    isConnected: boolean;
    isAuthentificated: boolean;
    socket: AppSocket;
    robotSubscriptions: {
        id_robot: ObjectId,
        read?:string[],
        write?:string[][],
    }[]

    static connectedApps:App[] = [];

    constructor(idInstance?:string) {
        //generates new instance id if undefined
        this.idInstance = new ObjectId(idInstance);
    }

    static FindConnected(idApp:ObjectId, idInstance:ObjectId):App {

        for (let i = 0; i < App.connectedApps.length; i++) {
            if (App.connectedApps[i].idApp.equals(idApp) &&
                App.connectedApps[i].idInstance.equals(idInstance))
            {
                return App.connectedApps[i];
            }
        }

        return null;
    }

    public addToConnected() {
        if (App.connectedApps.indexOf(this) == -1) {
            App.connectedApps.push(this);
        }
    }

    public removeFromConnected() {
        let index = App.connectedApps.indexOf(this);
        if (index != -1) {
            App.connectedApps.splice(index, 1);
        }
    }

    public subscribeRobot(idRobot: ObjectId, read?:string[], write?:string[][]) {
        for (let i = 0; i < this.robotSubscriptions.length; i++) {
            if (this.robotSubscriptions[i].id_robot.equals(idRobot)) {
                this.robotSubscriptions[i].read = read;
                this.robotSubscriptions[i].write = write;
                return;
            }

        }
        this.robotSubscriptions.push({
            id_robot: idRobot,
            read: read,
            write: write
        });
    }

    public addToRobotSubscriptions(idRobot: ObjectId, read?:string[], write?:string[][]) {
        for (let i = 0; i < this.robotSubscriptions.length; i++) {
            if (this.robotSubscriptions[i].id_robot.equals(idRobot)) {

                if (read) {
                    read.forEach((id_src)=>{
                        if (this.robotSubscriptions[i].read.indexOf(id_src) === -1)
                            this.robotSubscriptions[i].read.push(id_src);
                    });
                }
                if (write) {
                    write.forEach((id_src)=>{
                        if (this.robotSubscriptions[i].write.indexOf(id_src) === -1)
                            this.robotSubscriptions[i].write.push(id_src);
                    });
                }
                return;
            }
        }
    }

    public removeFromRobotSubscriptions(idRobot: ObjectId, read?:string[], write?:string[]) {
        for (let i = 0; i < this.robotSubscriptions.length; i++) {
            if (this.robotSubscriptions[i].id_robot.equals(idRobot)) {

                if (read) {
                    read.forEach((id_src)=>{
                        let p = this.robotSubscriptions[i].read.indexOf(id_src);
                        if (p !== -1)
                            this.robotSubscriptions[i].read.splice(p, 1);
                    });
                }
                if (write) {
                    write.forEach((id_src)=>{
                        for (let i = 0; i < this.robotSubscriptions[i].write.length; i++) {
                            if (this.robotSubscriptions[i].write[i][0] == id_src) {
                                this.robotSubscriptions[i].write.splice(i, 1)
                                i--;
                            }
                        }
                    });
                }
                return;
            }
        }
    }

    public isSubscribedToRobot(idRobot: ObjectId, outSubscription?:any):boolean {
        for (let i = 0; i < this.robotSubscriptions.length; i++) {
            if (this.robotSubscriptions[i].id_robot.equals(idRobot)) {
                if (outSubscription !== undefined) {
                    outSubscription.read = this.robotSubscriptions[i].read;
                    outSubscription.write = this.robotSubscriptions[i].write;
                }
                return true;
            }

        }
        return false;
    }

    static Register(req:express.Request, res:express.Response, setPassword:string, appsCollection:Collection) {
        let remote_ip:string = (req.headers['x-forwarded-for'] || req.socket.remoteAddress) as string;
        const saltRounds = 10;
        bcrypt.genSalt(saltRounds, async function (err:any, salt:string) {
            if (err) { $d.err('Error while generating salt'); return ErrOutText( 'Error while registering', res ); }
    
            bcrypt.hash(setPassword, salt, null, async function (err:any, hash:string) {
                if (err) { $d.err('Error while hashing password'); return ErrOutText( 'Error while registering', res ); }
    
                let dateRegistered = new Date();
    
                let appReg:InsertOneResult = await appsCollection.insertOne({
                    registered: dateRegistered,
                    reg_ip: remote_ip,
                    key_hash: hash
                });
    
                $d.l(('Registered new app id '+appReg.insertedId.toString()+' from '+remote_ip).yellow);

                return res.redirect('/app/register?id='+appReg.insertedId.toString()+'&key='+setPassword);

                let new_config:any = {
                    appId: appReg.insertedId.toString(),
                    appKey: setPassword
                };
    
                res.setHeader('Content-Type', 'application/json');
                res.send(JSON.stringify(new_config, null, 4));
                return;
    
            });
        });
    }

    static async GetDefaultConfig(req:express.Request, res:express.Response, appsCollection:Collection, publicAddress:string, sioPort:number) {
    
        if (!req.query.id || !ObjectId.isValid(req.query.id as string) || !req.query.key) {
            $d.err('Invalidid id_robot provided: '+req.query.id)
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