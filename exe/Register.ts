import C from "colors";
import { MongoClient } from "mongodb";
C; //force import typings with string prototype extension

import { getConfig } from "../src/config";
import { Debugger } from "../lib/debugger";
import { Robot } from "../src/Robot";

const $d: Debugger = Debugger.Get("Register");

const config = await getConfig($d);
const mongoClient = new MongoClient(config.dbUrl);
const connection = await mongoClient.connect();
const robotsCollection = connection.db(config.dbName).collection("robots");
const { robotId, robotKey } = await Robot.Register({
  $d,
  robotsCollection,
  ...config,
});
console.log("\nRegister completed");
console.log(`robot id:`.green, robotId);
console.log(`robot key:`.green, robotKey);
process.exit();
