import { randomBytes, createHash } from "node:crypto";

import { Debugger } from "../lib/debugger";
const $d: Debugger = Debugger.Get();

import * as SocketIO from "socket.io";
import { Collection, InsertOneResult, ObjectId } from "mongodb";
import { App } from "./App";

import bcrypt from "bcrypt-nodejs";

import { parseRos2idl } from "@foxglove/rosmsg";
import { MessageDefinition } from "@foxglove/message-definition";

import axios, { AxiosResponse, AxiosError } from "axios";
import { BridgeServerConfig } from "./config";
import { bs62 } from "../lib/helpers";

export class RobotSocket extends SocketIO.Socket {
  dbData?: any;
}

export class Robot {
  idRobot: ObjectId;
  name: string;
  maintainer_email: string;

  ros_distro: string;
  git_sha: string;
  git_tag: string;
  type: ObjectId;
  isConnected: boolean;
  isAuthentificated: boolean;
  socket: RobotSocket;
  timeConnected: Date;

  idls: any = {}; // message defs in .idl fomrat extracted from the robot
  msg_defs: any = {}; // processed js msg definitions
  nodes: any[];
  topics: any[];
  services: any[];
  docker_containers: any = {}; // docker status as host => DockerStatusMsg
  cameras: any[];

  static LOG_EVENT_CONNECT: number = 1;
  static LOG_EVENT_DISCONNECT: number = 0;
  static LOG_EVENT_ERR: number = -1;

  introspection: boolean;

  static connectedRobots: Robot[] = [];

  public addToConnected(verbose_webrtc: boolean, verbose_defs: boolean) {
    if (Robot.connectedRobots.indexOf(this) == -1) {
      Robot.connectedRobots.push(this);
      let robot = this;
      App.connectedApps.forEach((app) => {
        let sub: any = app.getRobotSubscription(this.idRobot);
        if (sub) {
          if (verbose_webrtc) $d.log("Stored sub: ", sub);
          robot.initPeer(
            app,
            sub.read,
            sub.write,
            verbose_webrtc,
            verbose_defs,
          );
        }
      });
    }
  }

  public initPeer(
    app: App,
    read: string[],
    write: string[][],
    verbose_webrtc: boolean,
    verbose_defs: boolean,
    returnCallback?: any,
  ) {
    let data = {
      id_app: app.idApp.toString(),
      id_instance: app.idInstance.toString(),
      read: read,
      write: write,
    };
    let that = this;
    $d.log("Calling robot:peer with data", data);
    this.socket.emit("peer", data, (answerData: any) => {
      if (!app.socket) return;

      $d.log("Got robot's answer:", answerData);

      answerData = this.getStateData(answerData);
      answerData["files_fw_secret"] = app.filesSecret.toString();

      if (returnCallback) {
        returnCallback(answerData);
      } else {
        app.socket.emit("robot", answerData, (app_answer_data: any) => {
          if (!that.socket) return;
          if (verbose_webrtc) $d.log("Got app's answer:", app_answer_data);
          else $d.log("Got app's answer");
          delete app_answer_data["id_robot"];
          app_answer_data["id_app"] = app.idApp.toString();
          app_answer_data["id_instance"] = app.idInstance.toString();
          that.socket.emit("sdp:answer", app_answer_data);
        });
      }

      if (!app.socket) return;

      $d.log(
        "Intilizing peer #" +
          app.idInstance.toString() +
          " with robot data of " +
          this.idRobot.toString(),
      );
      this.pushMissingMsgDefsToPeer(app, verbose_defs);
      app.socket.emit("nodes", this.labelSubsciberData(this.nodes));
      app.socket.emit("topics", this.labelSubsciberData(this.topics));
      app.socket.emit("services", this.labelSubsciberData(this.services));
      app.socket.emit("cameras", this.labelSubsciberData(this.cameras));
      app.socket.emit(
        "docker",
        this.labelSubsciberData(this.docker_containers),
      );

      this.peersToToSubscribers();
    });
  }

  public removeFromConnected(notify: boolean = true) {
    this.idls = []; // reset until fresh idls are provided
    this.msg_defs = [];
    let index = Robot.connectedRobots.indexOf(this);
    if (index != -1) {
      Robot.connectedRobots.splice(index, 1);
      if (notify) {
        let that = this;
        App.connectedApps.forEach((app) => {
          if (!app.getRobotSubscription(this.idRobot)) return;

          app.socket.emit("robot", that.getStateData()); // = robot offline
          app.servedMsgDefs = []; // reset
        });
      }
    }
  }

  public getStateData(data: any = null): any {
    if (!data || typeof data !== "object") data = {};

    data["id_robot"] = this.idRobot.toString();
    data["name"] = this.name ? this.name : "Unnamed Robot";
    data["maintainer_email"] = this.maintainer_email
      ? this.maintainer_email
      : "";
    data["ros_distro"] = this.ros_distro;
    data["git_sha"] = this.git_sha;
    data["git_tag"] = this.git_tag;

    if (this.socket) data["ip"] = this.socket.conn.remoteAddress; //no ip = robot offline
    data["introspection"] = this.introspection;

    return data;
  }

  public labelSubsciberData(inData: any): any {
    let data: any = {};
    data[this.idRobot.toString()] = inData;
    return data;
  }

  public processIdls(verbose: boolean, onComplete?: any): void {
    let msg_types: string[] = Object.keys(this.idls);
    // let all_msg_defs:any[] = [];
    let numProcessed = 0;
    msg_types.forEach((msg_type: string) => {
      let idl: string = this.idls[msg_type];
      let defs: MessageDefinition[] = [];
      try {
        defs = parseRos2idl(idl); // for ROS 2 definitions
      } catch (e) {
        $d.e("Exception while processing idl for " + msg_type + "; ignoring");
        if (verbose) {
          $d.l(this.idls[msg_type]);
        }
        return;
      }
      if (verbose) $d.l(msg_type + " -> " + defs.length + " defs:");
      for (let k = 0; k < defs.length; k++) {
        let def = defs[k];
        if (this.msg_defs[def.name]) continue; // only once per robot session
        if (verbose) $d.l(def);
        this.msg_defs[def.name] = def;
        numProcessed++;
      }
    });

    $d.l(("Processed idls into " + numProcessed + " msg_defs").yellow);

    if (onComplete) onComplete();
  }

  public pushMissingMsgDefsToPeer(app: App, verbose: boolean): void {
    let missing_app_defs: any[] = [];
    let def_types: string[] = Object.keys(this.msg_defs);
    def_types.forEach((def_type: string) => {
      if (app.servedMsgDefs.indexOf(def_type) > -1) return; // only sending each def once per session
      app.servedMsgDefs.push(def_type);
      missing_app_defs.push(this.msg_defs[def_type]);
    });

    if (missing_app_defs.length) {
      let robotDefsData: any = this.labelSubsciberData(missing_app_defs);
      if (verbose)
        $d.l(
          "Pushing " +
            missing_app_defs.length +
            " defs to " +
            app.idInstance.toString(),
          missing_app_defs,
        );
      app.socket.emit("defs", robotDefsData);
    }
  }

  public msgDefsToSubscribers(verbose: boolean): void {
    App.connectedApps.forEach((app) => {
      if (!app.getRobotSubscription(this.idRobot)) return;
      this.pushMissingMsgDefsToPeer(app, verbose);
    });
  }

  public nodesToSubscribers(): void {
    let robotNodesData = this.labelSubsciberData(this.nodes);
    App.connectedApps.forEach((app) => {
      if (app.getRobotSubscription(this.idRobot)) {
        app.socket.emit("nodes", robotNodesData);
      }
    });
  }

  public topicsToSubscribers(): void {
    let robotTopicsData = this.labelSubsciberData(this.topics);
    App.connectedApps.forEach((app) => {
      if (app.getRobotSubscription(this.idRobot)) {
        app.socket.emit("topics", robotTopicsData);
      }
    });
  }

  public servicesToSubscribers(): void {
    let robotServicesData = this.labelSubsciberData(this.services);
    App.connectedApps.forEach((app) => {
      if (app.getRobotSubscription(this.idRobot)) {
        // $d.l('emitting services to app', robotServicesData);
        app.socket.emit("services", robotServicesData);
      }
    });
  }

  public camerasToSubscribers(): void {
    let robotCamerasData = this.labelSubsciberData(this.cameras);
    App.connectedApps.forEach((app) => {
      if (app.getRobotSubscription(this.idRobot)) {
        // $d.l('emitting cameras to app', robotCamerasData);
        app.socket.emit("cameras", robotCamerasData);
      }
    });
  }

  public introspectionToSubscribers(): void {
    App.connectedApps.forEach((app) => {
      if (app.getRobotSubscription(this.idRobot)) {
        // $d.l('emitting discovery state to app', discoveryOn);
        app.socket.emit("introspection", this.introspection);
      }
    });
  }

  public dockerContainersToSubscribers(): void {
    let robotDockerContainersData = this.labelSubsciberData(
      this.docker_containers,
    );
    App.connectedApps.forEach((app) => {
      if (app.getRobotSubscription(this.idRobot)) {
        // $d.l('emitting docker to app', robotDockerContainersData);
        app.socket.emit("docker", robotDockerContainersData);
      }
    });
  }

  public peersToToSubscribers(): void {
    let peerData = {
      num_connected: 0,
      num_waiting: 0,
    };
    App.connectedApps.forEach((app) => {
      if (app.getRobotSubscription(this.idRobot)) {
        peerData.num_connected++;
      }
    });
    let robotPeerData = this.labelSubsciberData(peerData);
    App.connectedApps.forEach((app) => {
      if (app.getRobotSubscription(this.idRobot)) {
        app.socket.emit("robot_peers", robotPeerData);
      }
    });
  }

  // broadcasts service call initiated by senderPeer to all other connected peers
  public broadcastPeerServiceCall(
    senderPeer: App,
    service: string,
    msg: any,
  ): void {
    App.connectedApps.forEach((app) => {
      if (app == senderPeer) return; //skip sender
      let data = this.labelSubsciberData({
        service: service,
        msg: msg,
      });
      if (app.getRobotSubscription(this.idRobot)) {
        app.socket.emit("peer_service_call", data);
      }
    });
  }

  public logConnect(
    robotsCollection: Collection,
    robotLogsCollection: Collection,
    publicBridgeAddress: string,
  ): void {
    this.timeConnected = new Date();
    robotsCollection.updateOne(
      { _id: this.idRobot },
      {
        $set: {
          name: this.name,
          maintainer_email: this.maintainer_email,
          bridge_server: publicBridgeAddress, // save current instance for /locate
          ros_distro: this.ros_distro,
          git_sha: this.git_sha,
          git_tag: this.git_tag,
          last_connected: this.timeConnected,
          last_ip: this.socket.handshake.address,
        },
        $inc: { total_sessions: 1 },
      },
    );

    robotLogsCollection.insertOne({
      id: this.idRobot,
      stamp: this.timeConnected,
      event: Robot.LOG_EVENT_CONNECT,
      ip: this.socket.handshake.address,
    });
  }

  public logDisconnect(
    robotsCollection: Collection,
    robotLogsCollection: Collection,
    ev: number = Robot.LOG_EVENT_DISCONNECT,
    cb?: any,
  ): void {
    let numTasks = 2;
    let now: Date = new Date();
    let session_length_min: number =
      Math.abs(now.getTime() - this.timeConnected.getTime()) / 1000.0 / 60.0;
    robotsCollection
      .updateOne(
        { _id: this.idRobot },
        { $inc: { total_time_h: session_length_min / 60.0 } },
      )
      .finally(() => {
        numTasks--;
        if (!numTasks && cb) return cb();
      });

    robotLogsCollection
      .insertOne({
        id: this.idRobot,
        stamp: new Date(),
        event: ev,
        session_length_min: session_length_min,
        ip: this.socket.handshake.address,
      })
      .finally(() => {
        numTasks--;
        if (!numTasks && cb) return cb();
      });
  }

  static async SyncICECredentials(
    idRobot: string,
    iceSecret: string,
    iceServers: string[],
    syncPort: number,
    syncSecret: string,
    cb?: any,
  ) {
    await Promise.all(
      iceServers.map(async (syncHost) => {
        let syncUrl = "https://" + syncHost + ":" + syncPort;
        $d.log(
          (" >> Syncing ICE credentials of " + idRobot + " with " + syncUrl)
            .cyan,
        );

        await axios
          .post(
            syncUrl,
            {
              auth: syncSecret,
              ice_id: idRobot,
              ice_secret: iceSecret,
            },
            { timeout: 5000 },
          )
          .then((response: AxiosResponse) => {
            if (response.status == 200) {
              $d.log("Sync OK for " + idRobot);
            } else {
              $d.err(
                "Sync returned code " + response.status + " for " + idRobot,
              );
            }
            if (cb) cb();
            return;
          })
          .catch((error: AxiosError) => {
            if (error.code === "ECONNABORTED") {
              $d.err(
                "Request timed out for " +
                  syncUrl +
                  " (syncing " +
                  idRobot +
                  ")",
              );
            } else {
              $d.err(
                "Error from " + syncUrl + " (syncing " + idRobot + "):",
                error.message,
              );
            }
            if (cb) cb();
            return;
          });
      }),
    );
  }

  static async Register({
    $d,
    robotsCollection,
    iceServers,
    iceSyncPort,
    iceSyncSecret,
  }: { robotsCollection: Collection; $d: Debugger } & Pick<
    BridgeServerConfig,
    "iceServers" | "iceSyncPort" | "iceSyncSecret"
  >) {
    const secretBuffer = randomBytes(16);
    const robotKey = bs62.encode(secretBuffer);
    const robotKeyHash = bs62.encode(
      createHash("sha256").update(secretBuffer).digest(),
    );

    let dateRegistered = new Date();
    let ice_secret = bs62.encode(randomBytes(16));
    let robotReg: InsertOneResult = await robotsCollection.insertOne({
      registered: dateRegistered,
      key_hash: robotKeyHash,
      ice_secret: ice_secret,
    });
    const robotId = robotReg.insertedId.toString();
    $d.l(`Registered new robot ${robotId}`.yellow);

    await Robot.SyncICECredentials(
      robotReg.insertedId.toString(),
      ice_secret,
      iceServersToSyncServerHosts(iceServers),
      iceSyncPort,
      iceSyncSecret,
    );

    return { robotId, robotKey };
  }

  public static FindConnected(idSearch: ObjectId): Robot | null {
    for (let i = 0; i < Robot.connectedRobots.length; i++) {
      if (!Robot.connectedRobots[i].idRobot) continue;
      if (Robot.connectedRobots[i].idRobot.equals(idSearch))
        return Robot.connectedRobots[i];
    }
    return null;
  }
}

function iceServersToSyncServerHosts(iceServers: string[]) {
  const hosts = new Set<string>();
  iceServers.forEach((one_server: string) => {
    let serverParts = one_server.split(":");
    if (serverParts.length != 3) {
      $d.err(
        "Server misconfigured in config: " + one_server + "; ignoring in sync",
      );
      return;
    }
    hosts.add(serverParts[1]);
  });

  return Array.from(hosts);
}
