const ADMIN_USERNAME: string = CONFIG["BRIDGE"].admin.username;
const ADMIN_PASSWORD: string = CONFIG["BRIDGE"].admin.password;

function auth_admin(req: any) {
  const authorization = req.headers.authorization;
  if (!authorization) {
    return false;
  }

  const [username, password] = Buffer.from(
    authorization.replace("Basic ", ""),
    "base64",
  )
    .toString()
    .split(":");

  if (!(username === ADMIN_USERNAME && password === ADMIN_PASSWORD)) {
    return false;
  }

  return true;
}

function reject(res: any) {
  res.setHeader("www-authenticate", "Basic");
  res.sendStatus(401);
}

// return server info in json
bridgeExpressApp.get("/", function (req: any, res: any) {
  res.setHeader("Content-Type", "application/json");
  res.send(
    JSON.stringify(
      {
        phntm_bridge_server: Date.now(),
        robot:
          PUBLIC_BRIDGE_ADDRESS + ":" + BRIDGE_SIO_PORT + "/robot/socket.io/",
        new_robot_json:
          PUBLIC_REGISTER_ADDRESS + ":" + REGISTER_PORT + "/robot?json",
        new_robot_yaml:
          PUBLIC_REGISTER_ADDRESS + ":" + REGISTER_PORT + "/robot?yaml",
        // human: PUBLIC_BRIDGE_ADDRESS+':'+SIO_PORT+'/human/socket.io/',
        app: PUBLIC_BRIDGE_ADDRESS + ":" + BRIDGE_SIO_PORT + "/app/socket.io/",
        new_app_json: PUBLIC_REGISTER_ADDRESS + ":" + REGISTER_PORT + "/app",
        info: PUBLIC_BRIDGE_ADDRESS + ":" + BRIDGE_SIO_PORT + "/info",
      },
      null,
      4,
    ),
  );
});

// get server utilization info
bridgeExpressApp.get("/info", function (req: any, res: any) {
  if (!auth_admin(req)) {
    return reject(res);
  }

  res.setHeader("Content-Type", "application/json");

  let info_data: any = {
    time: new Date(),
    numConnectedRobots: Robot.connectedRobots.length,
    numConnectedApps: App.connectedApps.length,
    robots: [],
    apps: [],
  };

  let peers_subscribed_to_robot: any = {};

  let appsData = [];
  for (let i = 0; i < App.connectedApps.length; i++) {
    let subs: any = {};
    if (App.connectedApps[i].robotSubscriptions) {
      for (let j = 0; j < App.connectedApps[i].robotSubscriptions.length; j++) {
        let id_robot: string =
          App.connectedApps[i].robotSubscriptions[j].id_robot.toString();
        subs[id_robot] = {
          wrtc_connection_state:
            App.connectedApps[i].robotSubscriptions[j].wrtc_connection_state,
          wrtc_connection_method:
            App.connectedApps[i].robotSubscriptions[j].wrtc_connection_method,
          wrtc_connection_ip:
            App.connectedApps[i].robotSubscriptions[j].wrtc_connection_ip,
        };
        if (!peers_subscribed_to_robot[id_robot])
          peers_subscribed_to_robot[id_robot] = [];
        peers_subscribed_to_robot[id_robot].push({
          inst: App.connectedApps[i].idInstance.toString(),
        });
      }
    }

    appsData.push({
      inst: App.connectedApps[i].idInstance,
      ip: App.connectedApps[i].socket.handshake.address,
      subscriptions: subs,
    });
  }

  let robotsData = [];
  for (let i = 0; i < Robot.connectedRobots.length; i++) {
    let id_robot: string = (
      Robot.connectedRobots[i].idRobot as ObjectId
    ).toString();
    let ui_url = UI_ADDRESS_PREFIX + id_robot;
    robotsData.push({
      id: id_robot,
      name: Robot.connectedRobots[i].name
        ? Robot.connectedRobots[i].name
        : "Unnamed Robot",
      maintainer_email: Robot.connectedRobots[i].maintainer_email,
      ros_distro: Robot.connectedRobots[i].ros_distro,
      git_sha: Robot.connectedRobots[i].git_sha,
      git_tag: Robot.connectedRobots[i].git_tag,
      ui: ui_url,
      ip: Robot.connectedRobots[i].socket.handshake.address,
      peers: peers_subscribed_to_robot[id_robot]
        ? peers_subscribed_to_robot[id_robot]
        : [],
    });
  }

  info_data["robots"] = robotsData;
  info_data["appInstances"] = appsData;

  res.send(JSON.stringify(info_data, null, 4));
});
