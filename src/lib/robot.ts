import { Debugger } from "./debugger";
const $d:Debugger = Debugger.Get();

import * as SocketIO from "socket.io";
import { Collection, ObjectId } from 'mongodb';
import { App } from './app'

export class RobotSocket extends SocketIO.Socket {
    dbData?: any;
}

export class Robot {
    id_robot: ObjectId;
    name: string;
    type: ObjectId;
    isConnected: boolean;
    isAuthentificated: boolean;
    socket: RobotSocket;
    timeConnected:Date;

    nodes: any[];
    topics: any[];
    services: any[];
    docker_containers: any[];
    cameras: any[];

    static LOG_EVENT_CONNECT: number = 1;
    static LOG_EVENT_DISCONNECT: number = 0;
    static LOG_EVENT_ERR: number = -1;

    introspection: boolean;

    static connectedRobots:Robot[] = [];

    public addToConnected() {
        if (Robot.connectedRobots.indexOf(this) == -1) {
            Robot.connectedRobots.push(this);
            let robot = this;
            App.connectedApps.forEach(app => {
                let sub:any = {};
                if (app.isSubscribedToRobot(this.id_robot, sub)) {
                    $d.log('Stored sub: ', sub);
                    robot.init_peer(app, sub.read, sub.write)
                }
            });
        }
    }

    public init_peer(app:App, read?:string[], write?:string[][], returnCallback?:any) {
        let data = {
            id_app: app.id_app.toString(),
            id_instance: app.id_instance.toString(),
            read: read,
            write: write,
        }
        let that = this;
        $d.log('Calling robot:peer with data', data);
        this.socket.emit('peer', data, (answerData:{state?: any, offer:string }) => {

            if (!app.socket)
                return;

            $d.log('Got robot\'s answer:', answerData);

            answerData = this.getStateData(answerData);

            if (returnCallback) {
                returnCallback(answerData);
            } else {
                app.socket.emit('robot', answerData, (app_answer_data:any) => {
                    $d.log('Got app\'s answer:', app_answer_data);
                    delete app_answer_data['id_robot'];
                    app_answer_data['id_app'] = app.id_app.toString();
                    app_answer_data['id_instance'] = app.id_instance.toString();
                    that.socket.emit('sdp:answer', app_answer_data);
                });
            }

            app.socket.emit('nodes', this.AddId(this.nodes));
            app.socket.emit('topics', this.AddId(this.topics));
            app.socket.emit('services', this.AddId(this.services));
            app.socket.emit('cameras', this.AddId(this.cameras));
            app.socket.emit('docker', this.AddId(this.docker_containers));
        });
    }

    public removeFromConnected(notify:boolean = true) {
        let index = Robot.connectedRobots.indexOf(this);
        if (index != -1) {
            Robot.connectedRobots.splice(index, 1);
            if (notify) {
                let that = this;
                App.connectedApps.forEach(app => {
                    if (app.isSubscribedToRobot(this.id_robot)) {
                        app.socket.emit('robot', that.getStateData()) //offline
                    }
                });
            }
        }
    }

    public getStateData(data:any=null):any {
        if (!data || typeof data !== 'object')
            data = {};

        data['id_robot'] = this.id_robot.toString()
        data['name'] =  this.name ? this.name : 'Unnamed Robot';
        if (this.socket)
            data['ip'] =  this.socket.conn.remoteAddress; //no ip = robot offline
        data['introspection'] = this.introspection;

        return data;
    }

    public AddId(in_data:any):any {
        let data:any = {};
        data[this.id_robot.toString()] = in_data;
        return data;
    }

    public NodesToSubscribers():void {
        let robotNodesData = this.AddId(this.nodes);
        App.connectedApps.forEach(app => {
            if (app.isSubscribedToRobot(this.id_robot)) {
                app.socket.emit('nodes', robotNodesData)
            }
        });
    }

    public TopicsToSubscribers():void {
        let robotTopicsData = this.AddId(this.topics);
        App.connectedApps.forEach(app => {
            if (app.isSubscribedToRobot(this.id_robot)) {
                app.socket.emit('topics', robotTopicsData)
            }
        });
    }

    public ServicesToSubscribers():void {
        let robotServicesData = this.AddId(this.services);
        App.connectedApps.forEach(app => {
            if (app.isSubscribedToRobot(this.id_robot)) {
                // $d.l('emitting services to app', robotServicesData);
                app.socket.emit('services', robotServicesData)
            }
        });
    }

    public CamerasToSubscribers():void {
        let robotCamerasData = this.AddId(this.cameras);
        App.connectedApps.forEach(app => {
            if (app.isSubscribedToRobot(this.id_robot)) {
                // $d.l('emitting cameras to app', robotCamerasData);
                app.socket.emit('cameras', robotCamerasData)
            }
        });
    }

    public IntrospectionToSubscribers():void {
        App.connectedApps.forEach(app => {
            if (app.isSubscribedToRobot(this.id_robot)) {
                // $d.l('emitting discovery state to app', discoveryOn);
                app.socket.emit('introspection', this.introspection)
            }
        });
    }

    public DockerContainersToSubscribers():void {
        let robotDockerContainersData = this.AddId(this.docker_containers);
        App.connectedApps.forEach(app => {
            if (app.isSubscribedToRobot(this.id_robot)) {
                // $d.l('emitting docker to app', robotDockerContainersData);
                app.socket.emit('docker', robotDockerContainersData)
            }
        });
    }

    public logConnect(robotsCollection:Collection, robotLogsCollection:Collection):void {

        this.timeConnected = new Date();
        robotsCollection.updateOne({_id: this.id_robot},
                                   { $set: {
                                        name: this.name,
                                        last_connected: this.timeConnected,
                                        last_ip: this.socket.handshake.address,
                                    }, $inc: { total_sessions: 1 } });

        robotLogsCollection.insertOne({
            id: this.id_robot,
            stamp: this.timeConnected,
            event: Robot.LOG_EVENT_CONNECT,
            ip: this.socket.handshake.address
        });

    }

    public logDisconnect(robotsCollection:Collection, robotLogsCollection:Collection, ev:number = Robot.LOG_EVENT_DISCONNECT, cb?:any):void {

        let numTasks = 2;
        let now:Date = new Date();
        let session_length_min:number = Math.abs(now.getTime() - this.timeConnected.getTime())/1000.0/60.0;
        robotsCollection.updateOne({_id: this.id_robot},
                                   { $inc: { total_time_h: session_length_min/60.0 } })
        .finally(()=>{
            numTasks--;
            if (!numTasks && cb) return cb();
        });

        robotLogsCollection.insertOne({
            id: this.id_robot,
            stamp: new Date(),
            event: ev,
            session_length_min: session_length_min,
            ip: this.socket.handshake.address
        }).finally(()=>{
            numTasks--;
            if (!numTasks && cb) return cb();
        });
    }

    // public ___WebRTCOfferToSubscribers():void {

    //     App.connectedApps.forEach(app => {
    //         if (app.isSubscribedToRobot(this.id_robot)) {
    //             this.ConnectWebRTC(app)
    //         }
    //     });

    // }

    // public ___ConnectWebRTC(app:App):void {
    //     let that = this;
    //     if (!this.socket || !this.isConnected)
    //         return;
    //     this.socket.emit('make_offer', { id_app: app.id_app.toString(), id_instance: app.id_instance.toString() }, function (offer:any) {
    //         $d.l('Got offer from the robot:', offer);
    //         let offerData:any = {};
    //         offerData[that.id_robot.toString()] = offer;
    //         app.socket.emit('offer', offerData, function (appReply:any) {
    //             $d.l('App replied:', appReply);
    //         });
    //     });
    // }

    public static FindConnected(idSearch:ObjectId):Robot|null {
        for (let i = 0; i < Robot.connectedRobots.length; i++)
        {
            if (!Robot.connectedRobots[i].id_robot)
                continue;
            if (Robot.connectedRobots[i].id_robot.equals(idSearch))
                return Robot.connectedRobots[i];
        }
        return null;
    }
}