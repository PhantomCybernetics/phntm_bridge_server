import fs from "node:fs";
import https from "node:https";

import { SESClient } from "@aws-sdk/client-ses";
import bcrypt from "bcrypt-nodejs";
import * as C from "colors";
import * as JSONC from "comment-json";

C; //force import typings with string prototype extension

import { MongoClient, Db, Collection, ObjectId } from "mongodb";
import * as SocketIO from "socket.io";

import { App, AppSocket } from "./App";
import { Robot, RobotSocket } from "./Robot";
import { Debugger } from "../lib/debugger";
import { UncaughtExceptionHandler, SendEmail } from "../lib/helpers";

const $d: Debugger = Debugger.Get("Bridge Server");

// load config & ssl certs //
let configFname = process.env.CONFIG_FILE ?? `${__dirname}/../config.jsonc`;
const CONFIG: any = JSONC.parse(fs.readFileSync(configFname).toString());

const BRIDGE_SIO_PORT: number = CONFIG["BRIDGE"].bridgePort;
const REGISTER_PORT: number = CONFIG["BRIDGE"].registerPort;
const FILES_CACHE_DIR: string = CONFIG["BRIDGE"].filesCacheDir;
if (FILES_CACHE_DIR && !fs.existsSync(FILES_CACHE_DIR)) {
  $d.e("Files cache dir not found: " + FILES_CACHE_DIR);
  process.exit();
}
const DEFAULT_MAINTAINER_EMAIL: string =
  CONFIG["BRIDGE"].defaultMaintainerEmail;

const PUBLIC_REGISTER_ADDRESS: string = CONFIG["BRIDGE"].registerAddress; // this is geo loabalanced
const PUBLIC_BRIDGE_ADDRESS: string = CONFIG["BRIDGE"].bridgeAddress; // this is not
const UI_ADDRESS_PREFIX: string = CONFIG["BRIDGE"].uiAddressPrefix; // this is shared by several bridge instances and geo loadbalanced

const VERBOSE_WEBRTC: boolean = CONFIG["BRIDGE"].verboseWebRTC;
const VERBOSE_DEFS: boolean = CONFIG["BRIDGE"].verboseDefs;
const VERBOSE_SERVICES: boolean = CONFIG["BRIDGE"].verboseServices;
const VERBOSE_TOPICS: boolean = CONFIG["BRIDGE"].verboseTopics;
const VERBOSE_NODES: boolean = CONFIG["BRIDGE"].verboseNodes;
const VERBOSE_DOCKER: boolean = CONFIG["BRIDGE"].verboseDocker;

const DB_URL: string = CONFIG.dbUrl;
const DIE_ON_EXCEPTION: boolean = CONFIG.dieOnException;

const ICE_SERVERS: string[] = CONFIG["BRIDGE"].iceServers;
const ICE_SYNC_SERVERS: string[] = [];
if (ICE_SERVERS) {
  ICE_SERVERS.forEach((one_server: string) => {
    let serverParts = one_server.split(":");
    if (serverParts.length != 3) {
      $d.err(
        "Server misconfigured in config: " + one_server + "; ingnoring in sync",
      );
      return;
    }
    if (ICE_SYNC_SERVERS.indexOf(serverParts[1]) == -1) {
      ICE_SYNC_SERVERS.push(serverParts[1]);
    }
  });
}

const SES_AWS_REGION: string = CONFIG["BRIDGE"].sesAWSRegion;
const sesClient = SES_AWS_REGION
  ? new SESClient({ region: SES_AWS_REGION })
  : null;
const EMAIL_SENDER: string = CONFIG["BRIDGE"].emailSender;

$d.log("Staring up...");
console.log(
  "-----------------------------------------------------------------------"
    .yellow,
);
console.log(" PHNTM Bridge Server".yellow);
console.log("");
console.log(
  (
    " " +
    PUBLIC_REGISTER_ADDRESS +
    ":" +
    REGISTER_PORT +
    "/robot?yaml      Register new robot (YAML/JSON)"
  ).green,
);
console.log(
  (
    " " +
    PUBLIC_REGISTER_ADDRESS +
    ":" +
    REGISTER_PORT +
    "/app             Register new App (JSON)"
  ).green,
);
console.log("");
console.log(
  (
    " " +
    PUBLIC_BRIDGE_ADDRESS +
    ":" +
    BRIDGE_SIO_PORT +
    "/info                     System info"
  ).yellow,
);
console.log(
  (
    " " +
    PUBLIC_BRIDGE_ADDRESS +
    ":" +
    BRIDGE_SIO_PORT +
    "/robot/socket.io/         Robot API"
  ).cyan,
);
console.log(
  (
    " " +
    PUBLIC_BRIDGE_ADDRESS +
    ":" +
    BRIDGE_SIO_PORT +
    "/app/socket.io/           App API"
  ).cyan,
);
console.log(
  "----------------------------------------------------------------------"
    .yellow,
);
console.log("Using register certs: ".green, {
  key: regCertFiles[0],
  cert: regCertFiles[1],
});
console.log("Using bridge certs: ".green, {
  key: bridgeCertFiles[0],
  cert: bridgeCertFiles[1],
});
console.log("Using ICE servers: ".green, ICE_SERVERS);
console.log(
  ("Total unique ICE servers to sync with: " + ICE_SYNC_SERVERS.length).green,
);
console.log(
  "----------------------------------------------------------------------"
    .yellow,
);

let robotsCollection: Collection = null;
let robotLogsCollection: Collection = null;

const sioRobots: SocketIO.Server = new SocketIO.Server(bridgeHttpServer, {
  pingInterval: 10000,
  pingTimeout: 60 * 1000,
  path: "/robot/socket.io/",
  maxHttpBufferSize: 1e7, //allow 10MB for big file uploads
});

const sioApps: SocketIO.Server = new SocketIO.Server(bridgeHttpServer, {
  pingInterval: 10000,
  pingTimeout: 60 * 1000,
  path: "/app/socket.io/",
  cors: {
    origin: "*",
  },
});

const mongoClient = new MongoClient(DB_URL);
mongoClient
  .connect()
  .then((client: MongoClient) => {
    $d.log(("We are connected to " + DB_URL).green);

    const db = client.db("phntm");
    robotsCollection = db.collection("robots");
    robotLogsCollection = db.collection("robot_logs");
  })
  .catch(() => {
    $d.err("Error connecting to", DB_URL);
    process.exit();
  });

// Robot Socket.io
sioRobots.use(async (robotSocket: RobotSocket, next) => {
  //err.data = { content: "Please retry later" }; // additional details
  let idRobot = robotSocket.handshake.auth.id_robot;

  if (!ObjectId.isValid(idRobot)) {
    $d.err("Invalid id_robot provided: " + idRobot);
    const err = new Error("Access denied");
    return next(err);
  }
  if (!robotSocket.handshake.auth.key) {
    $d.err("Missing key from: " + idRobot);
    const err = new Error("Missing auth key");
    return next(err);
  }

  let searchId = new ObjectId(idRobot);
  const dbRobot = await robotsCollection.findOne({ _id: searchId });

  if (dbRobot) {
    bcrypt.compare(
      robotSocket.handshake.auth.key,
      dbRobot.key_hash,
      function (err: any, res: any) {
        if (res) {
          //pass match => good
          $d.l(
            (
              "Robot " +
              idRobot +
              " connected from " +
              robotSocket.handshake.address
            ).green,
          );
          robotSocket.dbData = dbRobot;
          return next();
        } else {
          //invalid key
          $d.l(
            (
              "Robot " +
              idRobot +
              " auth failed for " +
              robotSocket.handshake.address
            ).red,
          );
          const err = new Error("Access denied");
          return next(err);
        }
      },
    );
  } else {
    //robot not found
    $d.l(
      (
        "Robot " +
        idRobot +
        " not found in db for " +
        robotSocket.handshake.address
      ).red,
    );
    const err = new Error("Access denied");
    return next(err);
  }
});

sioRobots.on("connect", async function (robotSocket: RobotSocket) {
  let robot: Robot = new Robot();
  robot.idRobot = robotSocket.dbData._id;
  robot.name = robotSocket.handshake.auth.name
    ? robotSocket.handshake.auth.name
    : robotSocket.dbData.name
      ? robotSocket.dbData.name
      : "Unnamed Robot";
  robot.maintainer_email =
    robotSocket.handshake.auth.maintainer_email == DEFAULT_MAINTAINER_EMAIL
      ? ""
      : robotSocket.handshake.auth.maintainer_email;

  robot.ros_distro = robotSocket.handshake.auth.ros_distro
    ? robotSocket.handshake.auth.ros_distro
    : "";
  robot.git_sha = robotSocket.handshake.auth.git_sha
    ? robotSocket.handshake.auth.git_sha
    : "";
  robot.git_tag = robotSocket.handshake.auth.git_tag
    ? robotSocket.handshake.auth.git_tag
    : "";

  $d.log(
    (
      "Ohi, robot " +
      robot.name +
      " aka " +
      robot.idRobot.toString() +
      " [" +
      robot.ros_distro +
      "] connected to Socket.io"
    ).cyan,
  );

  robot.isAuthentificated = true;
  let disconnectEvent: number = Robot.LOG_EVENT_DISCONNECT;
  robot.socket = robotSocket;

  if (
    robot.maintainer_email != robotSocket.dbData.maintainer_email ||
    robot.name != robotSocket.dbData.name
  ) {
    if (robot.maintainer_email) {
      $d.log(
        "Robot name or maintainer's e-mail of " +
          robot.idRobot.toString() +
          " changed, sending link...",
      );
      let subject = robot.name + " on Phantom Bridge";
      let body =
        "Hello,\n" +
        "\n" +
        "Your robot " +
        robot.name +
        " is available at:\n" +
        "\n" +
        UI_ADDRESS_PREFIX +
        robot.idRobot.toString() +
        "\n" +
        "\n" +
        "Read the docs here: https://docs.phntm.io/bridge" +
        "\n" +
        "\n" +
        "- Phantom Bridge";
      if (sesClient) {
        SendEmail(
          robot.maintainer_email,
          subject,
          body,
          EMAIL_SENDER,
          sesClient,
        );
      } else {
        console.log(
          "No email client configured, not sending email",
          robot.maintainer_email,
          subject,
          body,
        );
      }
    }
  }

  robot.isConnected = true;
  robot.logConnect(
    robotsCollection,
    robotLogsCollection,
    PUBLIC_BRIDGE_ADDRESS,
  );

  robot.topics = [];
  robot.services = [];
  robot.cameras = [];
  robot.docker_containers = [];
  robot.introspection = false;

  robotSocket.emit("ice-servers", {
    servers: ICE_SERVERS,
    secret: robotSocket.dbData.ice_secret,
  }); // push this before peer info

  robot.addToConnected(VERBOSE_WEBRTC, VERBOSE_DEFS); // sends update to subscribers and peers to the robot

  robotSocket.on(
    "peer:update",
    async function (update_data: any, return_callback: any) {
      if (!robot.isAuthentificated || !robot.isConnected) return;
      let id_instance: ObjectId | null =
        update_data["id_instance"] &&
        ObjectId.isValid(update_data["id_instance"])
          ? new ObjectId(update_data["id_instance"])
          : null;
      delete update_data["id_app"];
      delete update_data["id_instance"];
      update_data = robot.getStateData(update_data);

      $d.l(
        "Got peer:update from " +
          robot.idRobot +
          " for peer instance " +
          id_instance +
          ": ",
        update_data,
      );
      const app = id_instance ? App.FindConnected(id_instance) : null;
      if (app && app.getRobotSubscription(robot.idRobot)) {
        app.socket?.emit("robot:update", update_data, (app_answer: any) => {
          return_callback(app_answer);
        });
      } else {
        return_callback({ err: 1, msg: "Peer not found" });
      }
    },
  );

  robotSocket.on("idls", async function (idls: any[]) {
    if (!robot.isAuthentificated || !robot.isConnected) return;

    let msg_types: string[] = Object.keys(idls);
    if (VERBOSE_DEFS)
      $d.l(
        "Got " +
          msg_types.length +
          " idls from " +
          robot.idRobot +
          " for msg_types:",
        msg_types,
      );
    else
      $d.l(
        "Got " +
          msg_types.length +
          " idls from " +
          robot.idRobot +
          " for msg_types",
      );

    robot.idls = idls;

    robot.processIdls(VERBOSE_DEFS, () => {
      //on complete
      robot.msgDefsToSubscribers(VERBOSE_DEFS);
    });
  });

  robotSocket.on("nodes", async function (nodes: any) {
    if (!robot.isAuthentificated || !robot.isConnected) return;

    if (VERBOSE_NODES)
      $d.l(
        "Got " + Object.keys(nodes).length + " nodes from " + robot.idRobot,
        nodes,
      );
    else
      $d.l("Got " + Object.keys(nodes).length + " nodes from " + robot.idRobot);

    robot.nodes = nodes;
    robot.nodesToSubscribers();
  });

  robotSocket.on("topics", async function (topics: any[]) {
    if (!robot.isAuthentificated || !robot.isConnected) return;

    if (VERBOSE_TOPICS)
      $d.l("Got " + topics.length + " topics from " + robot.idRobot, topics);
    else $d.l("Got " + topics.length + " topics from " + robot.idRobot);

    robot.topics = topics;
    robot.topicsToSubscribers();
  });

  robotSocket.on("services", async function (services: any[]) {
    if (!robot.isAuthentificated || !robot.isConnected) return;

    if (VERBOSE_SERVICES)
      $d.l(
        "Got " + services.length + " services from " + robot.idRobot,
        services,
      );
    else $d.l("Got " + services.length + " services from " + robot.idRobot);

    robot.services = services;
    robot.servicesToSubscribers();
  });

  robotSocket.on("cameras", async function (cameras: any[]) {
    if (!robot.isAuthentificated || !robot.isConnected) return;

    $d.l(
      "Got " + Object.keys(cameras).length + " cameras from " + robot.idRobot,
      cameras,
    );
    robot.cameras = cameras;
    robot.camerasToSubscribers();
  });

  robotSocket.on("docker", async function (docker_updates: any[]) {
    if (!robot.isAuthentificated || !robot.isConnected) return;

    if (VERBOSE_DOCKER)
      $d.l(
        "Got Docker updates for " +
          Object.keys(docker_updates).length +
          " hosts from #" +
          robot.idRobot,
        docker_updates,
      );
    else
      $d.l(
        "Got Docker updates for " +
          Object.keys(docker_updates).length +
          " hosts from #" +
          robot.idRobot,
      );
    robot.docker_containers = docker_updates;
    robot.dockerContainersToSubscribers();
  });

  robotSocket.on("introspection", async function (state: boolean) {
    if (!robot.isAuthentificated || !robot.isConnected) return;

    $d.l("Got introspection state from " + robot.idRobot + ": " + state);

    robot.introspection = state;

    robot.introspectionToSubscribers();
  });

  /*
   * client disconnected
   */
  robotSocket.on("disconnect", (data: any) => {
    $d.l(("Socket disconnect for robot: " + data).red);
    robot.isAuthentificated = false;
    robot.isConnected = false;
    robot.topics = [];
    robot.services = [];
    robot.logDisconnect(
      robotsCollection,
      robotLogsCollection,
      disconnectEvent,
      () => {
        robot.socket = null;
        robot.removeFromConnected(!shuttingDown);
      },
    );
  });

  robotSocket.on("disconnecting", (reason: any) => {
    $d.l(("Disconnecting socket for robot: " + reason).gray);
    disconnectEvent = Robot.LOG_EVENT_ERR;
    // robot.logDisconnect(robotsCollection, robotLogsCollection, Robot.LOG_EVENT_ERR);
  });
});

// App Socket.io
sioApps.use(async (appSocket: AppSocket, next) => {
  $d.l(("Instance connected from " + appSocket.handshake.address).green);
  return next();
});

sioApps.on("connect", async function (appSocket: AppSocket) {
  $d.log("Connected w id_instance: ", appSocket.handshake.auth.id_instance);

  let app: App = new App(appSocket.handshake.auth.id_instance); //id instance generated in constructor, if not provided
  app.socket = appSocket;
  app.isConnected = true;
  app.robotSubscriptions = [];

  $d.log(
    ("Inst " + app.idInstance.toString() + ") connected to Socket.io").cyan,
  );

  app.addToConnected();

  appSocket.emit("instance", app.idInstance.toString());

  appSocket.on(
    "robot",
    async function (
      data: { id_robot: string; read?: string[]; write?: string[][] },
      returnCallback,
    ) {
      $d.log("Peer app requesting robot: ", data);

      if (!data.id_robot || !ObjectId.isValid(data.id_robot)) {
        if (returnCallback) {
          returnCallback({
            err: 1,
            msg: "Invalid robot id " + data.id_robot,
          });
        }
        return false;
      }
      let id_robot = new ObjectId(data.id_robot);
      let robot = Robot.FindConnected(id_robot);
      if (!robot || !robot.socket) {
        // robot not connected, check it exists and return basic info
        // TODO perhaps make this behavior optional?
        const dbRobot = await robotsCollection.findOne({ _id: id_robot });
        if (!dbRobot) {
          return returnCallback({
            err: 1,
            msg: "Robot not found here (did you register it first?)",
          }); //invalid id
        }

        app.subscribeRobot(id_robot, data.read, data.write);

        return returnCallback({
          id_robot: id_robot.toString(),
          name: dbRobot["name"] ? dbRobot["name"] : "Unnamed Robot",
        });
      }

      app.subscribeRobot(robot.idRobot, data.read, data.write);
      // TODO: check max peer number
      robot.initPeer(
        app,
        data.read ?? [],
        data.write ?? [],
        VERBOSE_WEBRTC,
        VERBOSE_DEFS,
        returnCallback,
      );
    },
  );

  function ProcessForwardRequest(
    app: App,
    data: { id_robot?: string; id_app?: string; id_instance?: string },
    returnCallback: any,
  ): Robot | boolean {
    if (!data.id_robot || !ObjectId.isValid(data.id_robot)) {
      if (returnCallback) {
        returnCallback({
          err: 1,
          msg: "Invalid robot id " + data.id_robot,
        });
      }
      return false;
    }
    let id_robot = new ObjectId(data.id_robot);
    let robot = Robot.FindConnected(id_robot);
    if (!robot || !robot.socket) {
      if (returnCallback) {
        returnCallback({
          err: 1,
          msg: "Robot not connected",
        });
      }
      return false;
    }

    delete data["id_robot"];
    data["id_app"] = app.idApp.toString();
    data["id_instance"] = app.idInstance.toString();

    return robot;
  }

  appSocket.on(
    "introspection",
    async function (
      data: { id_robot: string; state: boolean },
      returnCallback,
    ) {
      $d.log("App requesting robot introspection", data);

      let robot: Robot = ProcessForwardRequest(
        app,
        data,
        returnCallback,
      ) as Robot;
      if (!robot) return;

      robot.socket?.emit("introspection", data, (answerData: any) => {
        $d.log("Got robot's introspection answer:", answerData);
        return returnCallback(answerData);
      });
    },
  );

  appSocket.on(
    "subscribe",
    async function (
      data: { id_robot: string; sources: string[] },
      returnCallback,
    ) {
      $d.log("App subscribing to:", data);

      let robot: Robot = ProcessForwardRequest(
        app,
        data,
        returnCallback,
      ) as Robot;
      if (!robot) return;

      if (!data.sources) {
        if (returnCallback) {
          returnCallback({
            err: 1,
            msg: "Invalid subscription sources",
          });
        }
        return;
      }

      app.addToRobotSubscriptions(robot.idRobot, data.sources, undefined);

      robot.socket?.emit("subscribe", data, (resData: any) => {
        $d.log("Got robot's subscription answer:", resData);

        return returnCallback(resData);
      });
    },
  );

  appSocket.on(
    "subscribe:write",
    async function (
      data: { id_robot: string; sources: any[] },
      returnCallback,
    ) {
      $d.log("App requesting write subscription to:", data);

      let robot: Robot = ProcessForwardRequest(
        app,
        data,
        returnCallback,
      ) as Robot;
      if (!robot) return;

      if (!data.sources) {
        if (returnCallback) {
          returnCallback({
            err: 1,
            msg: "Invalid write subscription data",
          });
        }
        return;
      }

      app.addToRobotSubscriptions(robot.idRobot, null, data.sources);

      robot.socket?.emit("subscribe:write", data, (resData: any) => {
        $d.log("Got robot's write subscription answer:", resData);

        return returnCallback(resData);
      });
    },
  );

  appSocket.on(
    "unsubscribe",
    async function (
      data: { id_robot: string; sources: string[] },
      returnCallback,
    ) {
      $d.log("App unsubscribing from:", data);

      if (!data.id_robot || !ObjectId.isValid(data.id_robot)) {
        if (returnCallback) {
          returnCallback({
            err: 1,
            msg: "Invalid robot id " + data.id_robot,
          });
        }
        return false;
      }

      let id_robot = new ObjectId(data.id_robot);

      if (!data.sources) {
        if (returnCallback) {
          returnCallback({
            err: 1,
            msg: "Invalid subscription sources",
          });
        }
        return;
      }

      // remove local subs even if robot is not connected
      app.removeFromRobotSubscriptions(id_robot, data.sources, undefined);

      let robot: Robot = ProcessForwardRequest(
        app,
        data,
        returnCallback,
      ) as Robot;
      if (!robot) return;

      robot.socket?.emit("unsubscribe", data, (resData: any) => {
        $d.log("Got robot's unsubscription answer:", resData);

        return returnCallback(resData);
      });
    },
  );

  appSocket.on(
    "unsubscribe:write",
    async function (
      data: { id_robot: string; sources: string[] },
      returnCallback,
    ) {
      $d.log("App unsubscribing from:", data);

      let robot: Robot = ProcessForwardRequest(
        app,
        data,
        returnCallback,
      ) as Robot;
      if (!robot) return;

      if (!data.sources) {
        if (returnCallback) {
          returnCallback({
            err: 1,
            msg: "Invalid unsubscription sources",
          });
        }
        return;
      }

      app.removeFromRobotSubscriptions(robot.idRobot, undefined, data.sources);

      robot.socket?.emit("unsubscribe:write", data, (resData: any) => {
        $d.log("Got robot's unsubscription answer:", resData);

        return returnCallback(resData);
      });
    },
  );

  appSocket.on(
    "sdp:answer",
    async function (data: { id_robot: string; sdp: string }, returnCallback) {
      if (VERBOSE_WEBRTC) $d.log("App sending sdp answer with:", data);
      else $d.log("App sending sdp answer");

      let robot: Robot = ProcessForwardRequest(
        app,
        data,
        returnCallback,
      ) as Robot;
      if (!robot) return;

      if (!data.sdp) {
        if (returnCallback) {
          returnCallback({
            err: 1,
            msg: "Invalid subscription data",
          });
        }
        return;
      }

      robot.socket?.emit("sdp:answer", data, (resData: any) => {
        $d.log("Got robot's sdp:answer answer:", resData);

        return returnCallback(resData);
      });
    },
  );

  appSocket.on(
    "service",
    async function (
      data: { id_robot: string; service: string; msg: any },
      returnCallback,
    ) {
      $d.log("App calling robot service:", data);

      let robot: Robot = ProcessForwardRequest(
        app,
        data,
        returnCallback,
      ) as Robot;
      if (!robot) return;

      if (!data.service) {
        if (returnCallback) {
          returnCallback({
            err: 1,
            msg: "Invalid service call data",
          });
        }
        return;
      }

      robot.socket?.emit("service", data, (resData: any) => {
        $d.log("Got robot's service call answer:", resData);

        if (returnCallback) return returnCallback(resData);
      });

      robot.broadcastPeerServiceCall(app, data.service, data.msg);
    },
  );

  appSocket.on(
    "wrtc-info",
    async function (data: {
      id_robot: string;
      state: string;
      method?: string;
      ip?: string;
    }) {
      if (!data.id_robot || !ObjectId.isValid(data.id_robot)) return false;

      let id_robot = new ObjectId(data.id_robot);

      let sub = app.getRobotSubscription(id_robot);
      if (!sub) return false;

      sub.wrtc_connection_state = data.state;
      sub.wrtc_connection_method = data.method;
      sub.wrtc_connection_ip = data.ip;

      $d.log(
        "Got app " +
          app.idApp.toString() +
          " (inst " +
          app.idInstance.toString() +
          ") robot connection info:",
        data,
      );

      // pass back to the robot to handle failures
      let robot = Robot.FindConnected(id_robot);
      if (robot && robot.socket) {
        robot.socket.emit("peer:wrtc-info", {
          id_app: app.idApp.toString(),
          id_instance: app.idInstance.toString(),
          state: sub.wrtc_connection_state,
        });
      }

      return true;
    },
  );

  /*
   * client disconnected
   */
  appSocket.on("disconnect", (msg: any) => {
    $d.l(
      ("Socket disconnected for inst " + app.idInstance.toString() + ": " + msg)
        .red,
    );

    app.isAuthentificated = false;
    app.isConnected = false;
    app.socket = null;
    app.removeFromConnected();

    for (let i = 0; i < app.robotSubscriptions.length; i++) {
      let id_robot = app.robotSubscriptions[i].id_robot;
      let robot = Robot.FindConnected(id_robot);
      if (robot && robot.socket) {
        robot.socket.emit("peer:disconnected", {
          id_app: app.idApp.toString(),
          id_instance: app.idInstance.toString(),
        });
      }
      if (robot) {
        robot.peersToToSubscribers();
      }
    }
  });

  appSocket.on("disconnecting", (reason: any) => {
    $d.l(("Socket disconnecting from app: " + reason).gray);
  });
});

//error handling & shutdown
process.on("uncaughtException", (err: any) => {
  UncaughtExceptionHandler(err, false);
  if (DIE_ON_EXCEPTION) {
    _Clear();
    ShutdownWhenClear();
  }
});

["SIGINT", "SIGTERM", "SIGQUIT"].forEach((signal) =>
  process.on(signal, () => {
    _Clear();
    ShutdownWhenClear();
  }),
);

let shuttingDown: boolean = false;
function _Clear() {
  if (shuttingDown) return;
  shuttingDown = true;

  $d.log("Server exiting, cleaning up...");

  sioRobots.close();
  sioApps.close();
}

function ShutdownWhenClear(): void {
  if (Robot.connectedRobots.length) {
    $d.l("Waiting for " + Robot.connectedRobots.length + " robots to clear...");
    setTimeout(() => ShutdownWhenClear(), 1000);
    return;
  }
  $d.l("Shutdown clear, exiting...");
  process.exit(0);
}
