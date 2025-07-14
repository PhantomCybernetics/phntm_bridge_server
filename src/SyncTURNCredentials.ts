import * as C from "colors";
import { MongoClient, Db, Collection, ObjectId } from "mongodb";
import * as JSONC from "comment-json";
import fs from "node:fs";

C; //force import typings with string prototype extension

import { Debugger } from "./lib/debugger";
import { Robot } from "./lib/robot";
const $d: Debugger = Debugger.Get("TURN Sync");

let configFname = process.env.CONFIG_FILE ?? `${__dirname}/../config.jsonc`;
const CONFIG: any = JSONC.parse(fs.readFileSync(configFname).toString());

const DB_URL: string = CONFIG.dbUrl;
const ICE_SERVERS: string[] = CONFIG["BRIDGE"].iceServers;
const SYNC_PORT: number = CONFIG["ICE_SYNC"].port;
const SYNC_SECRET: string = CONFIG["ICE_SYNC"].secret;

if (!ICE_SERVERS || !ICE_SERVERS.length) {
  $d.err("ICE sync servers not found in config");
  process.exit();
}
if (!SYNC_PORT) {
  $d.err("ICE sync port not found in config");
  process.exit();
}
if (!SYNC_SECRET) {
  $d.err("ICE sync secret not found in config");
  process.exit();
}

const args = process.argv.slice(2);

let ALL_SELECTED: boolean = false;
let SELECTED_ROBOT_IDS: string[] = [];
let SELECTED_SERVERS: string[] = [];

let mode: string | null = null;
// console.log(args);
for (let i = 0; i < args.length; i++) {
  if (args[i] == "--all") {
    ALL_SELECTED = true;
    break;
  }
  if (args[i] == "--robot") {
    mode = "r";
    continue;
  }
  if (args[i] == "--server") {
    mode = "s";
    continue;
  }
  if (mode == "r") {
    SELECTED_ROBOT_IDS.push(args[i]);
    continue;
  }
  if (mode == "s") {
    SELECTED_SERVERS.push(args[i]);
    continue;
  }
}

if (!ALL_SELECTED && !SELECTED_ROBOT_IDS.length && !SELECTED_SERVERS.length) {
  console.log("Usage: run.turn-sync.sh [options]");
  console.log(
    "  --all Synchronize all robot ICE/TURN credentials to all ICE servers",
  );
  console.log(
    "  --robot ID_ROBOT Select robot to synchronize (e.g. 675aa6166400663224710eaf)",
  );
  console.log(
    "  --server HOSTNAME Select target server (e.g. ca.turn.phntm.io)",
  );
  process.exit();
}

$d.log("Starting up TURN Synchronizer...");
if (ALL_SELECTED) {
  $d.log("Syncing all...");
} else {
  if (SELECTED_ROBOT_IDS.length) {
    $d.log(
      "Selected robot" +
        (SELECTED_ROBOT_IDS.length ? "s" : "") +
        ": " +
        SELECTED_ROBOT_IDS.join(", "),
    );
  }
  if (SELECTED_SERVERS.length) {
    $d.log(
      "Selected server" +
        (SELECTED_SERVERS.length ? "s" : "") +
        ": " +
        SELECTED_SERVERS.join(", "),
    );
  }
}

let filtered_servers: string[] = [];
ICE_SERVERS.forEach((one_server: string) => {
  let serverParts = one_server.split(":");
  if (serverParts.length != 3) {
    $d.err("Server misconfigured in config: " + one_server);
    return;
  }
  if (
    (ALL_SELECTED || SELECTED_SERVERS.indexOf(serverParts[1]) > -1) &&
    filtered_servers.indexOf(serverParts[1]) == -1
  ) {
    filtered_servers.push(serverParts[1]);
  }
});
if (!ALL_SELECTED) {
  SELECTED_SERVERS.forEach((one_selected) => {
    if (filtered_servers.indexOf(one_selected) == -1) {
      $d.err(
        "Server " + one_selected + " not found in config.jsonc, ignoring...",
      );
    }
  });
}
if (!filtered_servers.length) {
  $d.err("No valid target servers provided");
  process.exit();
}
$d.log("Targing servers:", filtered_servers);

let filtered_robots: ObjectId[] = [];
if (!ALL_SELECTED && SELECTED_ROBOT_IDS.length) {
  SELECTED_ROBOT_IDS.forEach((one_id) => {
    if (ObjectId.isValid(one_id)) {
      filtered_robots.push(new ObjectId(one_id));
    } else {
      $d.err("Robot id " + one_id + "invalid, ignoring...");
    }
  });
  if (!filtered_robots.length) {
    $d.err("No valid robot ids provided");
    process.exit();
  } else {
    $d.log("Selected robots:", filtered_robots);
  }
}

let db: Db = null;
let robotsCollection: Collection = null;

const mongoClient = new MongoClient(DB_URL);
mongoClient
  .connect()
  .then(async (client: MongoClient) => {
    $d.log(("We are connected to " + DB_URL).green);

    db = client.db("phntm");
    robotsCollection = db.collection("robots");

    let query = {};
    if (filtered_robots.length) {
      query = { _id: { $in: filtered_robots } };
    }
    let robots = await robotsCollection.find(query).toArray();
    let num_requests: number = robots.length * filtered_servers.length;

    function exitIfAllDone() {
      if (num_requests == 0) {
        $d.log("All done.".green);
        process.exit();
      }
    }

    robots.forEach(async (robot: any) => {
      if (!robot.ice_secret) {
        let new_ice_secret = new ObjectId().toString();
        $d.log(
          " > No ice_secret found for " +
            robot._id.toString() +
            ", setting newly generated",
        );
        const filter = { _id: robot._id };
        const update = { $set: { ice_secret: new_ice_secret } };
        const update_result = await robotsCollection.updateOne(filter, update);
        if (update_result.acknowledged) {
          robot.ice_secret = new_ice_secret;
        } else {
          $d.err(
            " > Update of " +
              robot._id.toString() +
              " not acknowledged; skipping",
          );
          num_requests--;
          return exitIfAllDone(); //skip
        }
      }

      await Robot.SyncICECredentials(
        robot._id.toString(),
        robot.ice_secret,
        filtered_servers,
        SYNC_PORT,
        SYNC_SECRET,
        () => {
          num_requests--;
          return exitIfAllDone();
        },
      );
    });
  })
  .catch(() => {
    $d.err("Error connecting to", DB_URL);
    process.exit();
  });
